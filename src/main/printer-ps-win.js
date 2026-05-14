// β57-β58: PDL raw print path (案 N')。mupdf の DocumentWriter で PDF を
// PostScript / PCL のページ記述言語に変換し、Win32 raw print API で
// プリンタに生データを送る経路。プリンタ側 PDL インタプリタが native
// DPI でレンダリングするので、ラスタ送信 (案 M) で達成できなかった
// Adobe Reader 同等の質感が出るはず。
//
// 経緯:
//   β56 案 M (Win32 GDI 直接ラスタ) は Sumatra と同等品質止まりで撤回
//   β57 PostScript 経路を初投入: C2360 で エラーコード 106-726 (PDL
//     データ不正系) が出てプリンタ側で異常終了。spooler は受領、
//     プリンタの PS インタプリタが受け付けなかった
//   β58 で 2 つの仮説検証:
//     P. PS の setpagedevice prelude を撤去して純 mupdf PS を送る
//        → C2360 が PS 自体は受けるかの切り分け
//     Q. PCL writer (mupdf の fz_new_pcl_writer_with_output) を追加
//        → C2360 が PS 非対応で PCL 対応なら救われる可能性
//   両方を main.js のカスケードで PS → PCL → Sumatra の順に試す
//
// 経路:
//   mupdf.DocumentWriter(buf, "ps", "")
//     → PDF を PostScript bytes に変換 (テキストはベクトル保持)
//   Win32 raw print API:
//     OpenPrinterW → StartDocPrinterW(datatype="RAW")
//     → WritePrinter (PostScript bytes をチャンク分割で送信)
//     → EndDocPrinter → ClosePrinter
//   プリンタの PostScript インタプリタが native DPI で描画
//     → Adobe Reader 同等の質感
//
// 既存 β14-β56 修正との関係:
// - β42-β43 / β54 FAX: 本ファイルは FAX を扱わない。FAX 経路は
//   silentPrintPdf (Chromium silent:false) のまま。
// - β46-β48 DEVMODE 設定 (copies/duplex/tray/color): PostScript の
//   `<<...>> setpagedevice` で印字前 prelude に注入し PS インタプリタ
//   に解釈させる。SetPrinter level 9 経由の per-user 既定書換 dance
//   (β48 J4b) は Sumatra fallback でのみ意味を持つ。
// - β50/β51/β54: in-flight tracking / crash log / 規定プリンタ切替は
//   呼び出し側 (main.js print-pdf-silent IPC) で処理、本ファイル内で
//   完結する処理ではない。
//
// 既知のリスク:
// - プリンタが PostScript インタプリタを持っていない (PCL only ドライバ)
//   場合、生 PS を送信すると文字化け or プリンタエラー → 上位で
//   Sumatra fallback に逃げる
// - mupdf の PS writer が日本語フォント (CIDType0/Type1C) をベクトル
//   でうまく出力できるかは PDF とフォント依存

import * as mupdf from "mupdf";
import { openPdfDocument } from "../backend/mupdf-render.js";

// JOB_INFO_1 / DOC_INFO_1 構造体は使わない (DOC_INFO_1 のみ。x64 8byte
// アライメントで合計 24 バイト = 3 ポインタ)
const DOC_INFO_1_SIZE = 24;

let _native = null;
let _nativeAttempted = false;

async function tryLoadNative() {
  if (_nativeAttempted) return _native;
  _nativeAttempted = true;
  if (process.platform !== "win32") return null;
  try {
    const koffiMod = await import("koffi");
    const koffi = koffiMod.default ?? koffiMod;
    const winspool = koffi.load("winspool.drv");
    _native = {
      koffi,
      OpenPrinterW: winspool.func(
        "__stdcall",
        "OpenPrinterW",
        "bool",
        ["str16", koffi.out(koffi.pointer("int64")), "void *"],
      ),
      ClosePrinter: winspool.func("__stdcall", "ClosePrinter", "bool", ["int64"]),
      // StartDocPrinterW(hPrinter, level, pDocInfo) → ジョブ ID (>0 で成功)
      // level=1 は DOC_INFO_1 形式。pDatatype を "RAW" にすると spooler は
      // データを加工せずプリンタへ送る (PostScript インタプリタが解釈する
      // 前提)。
      StartDocPrinterW: winspool.func(
        "__stdcall",
        "StartDocPrinterW",
        "uint32",
        ["int64", "uint32", "void *"],
      ),
      // WritePrinter(hPrinter, pBuf, cbBuf, &cbWritten) → BOOL
      // 一度に渡せる byte 数に上限があるので呼び出し側で 64KB 程度に
      // チャンク分割する。
      WritePrinter: winspool.func(
        "__stdcall",
        "WritePrinter",
        "bool",
        ["int64", "void *", "uint32", koffi.out(koffi.pointer("uint32"))],
      ),
      EndDocPrinter: winspool.func("__stdcall", "EndDocPrinter", "bool", ["int64"]),
      AbortPrinter: winspool.func("__stdcall", "AbortPrinter", "bool", ["int64"]),
    };
  } catch (err) {
    console.warn(
      "[print-ps] koffi unavailable, will fall back:",
      err?.message ?? err,
    );
    _native = null;
  }
  return _native;
}

/**
 * PDF bytes を指定 PDL (page description language) の bytes に変換する。
 * mupdf の DocumentWriter を使う。テキストは可能な限りベクトル保持される
 * ので、プリンタの PDL インタプリタが native DPI で描画する。
 *
 * @param {Buffer|Uint8Array} pdfBytes
 * @param {"ps"|"pcl"} format  mupdf writer 形式
 * @returns {Uint8Array}  PDL 文書 bytes
 */
function pdfBytesToPdl(pdfBytes, format) {
  const doc = openPdfDocument(pdfBytes);
  try {
    const out = new mupdf.Buffer();
    // mupdf DocumentWriter のオプションは format ごとに異なる。"ps" /
    // "pcl" とも空文字でデフォルト動作。
    const writer = new mupdf.DocumentWriter(out, format, "");
    try {
      const pageCount = doc.countPages();
      for (let i = 0; i < pageCount; i++) {
        const page = doc.loadPage(i);
        try {
          const bounds = page.getBounds();
          const device = writer.beginPage(bounds);
          // Matrix.identity: PDF native スケールのまま出力。プリンタ側
          // で印字時のスケーリング (用紙サイズ合わせ等) は driver /
          // spooler が補正する想定。
          page.run(device, mupdf.Matrix.identity);
          writer.endPage();
        } finally {
          page.destroy();
        }
      }
    } finally {
      writer.close();
    }
    return out.asUint8Array();
  } finally {
    doc.destroy();
  }
}

// β58: β57 で実装した setpagedevice prelude は C2360 で 106-726 の
// 一因の疑いがあるため撤去。純 mupdf 出力のみ送信して切り分け中。
// β46-β48 の DEVMODE 設定 (duplex/tray/color/copies) は per-user 既定
// (β48 J4b の SetPrinter level 9 経路) で spooler 側に伝わるため、
// 一部設定は raw print でも反映される (driver による)。完全反映が
// 必要なら β59+ で setpagedevice を再導入し DSC 順序を整える。

/**
 * Win32 raw print: 生 PostScript bytes をプリンタへ送信。spooler は
 * RAW datatype のため一切加工せずプリンタへ流す。プリンタ側 PS
 * インタプリタが解釈・描画。
 *
 * @param {object} native        tryLoadNative の戻り値
 * @param {string} deviceName    プリンタ名
 * @param {string} jobName       スプール表示名
 * @param {Uint8Array} bytes     PS 文書 bytes
 */
async function sendRawToPrinter(native, deviceName, jobName, bytes) {
  let hPrinter = 0n;
  let docStarted = false;
  try {
    const out = [0n];
    if (!native.OpenPrinterW(deviceName, out, null)) {
      throw new Error(`OpenPrinterW("${deviceName}") returned false`);
    }
    hPrinter = out[0];
    if (!hPrinter) throw new Error("OpenPrinter returned NULL handle");

    // DOC_INFO_1: { pDocName, pOutputFile, pDatatype } (3 ポインタ = 24
    // bytes on x64)。pDatatype = "RAW" で生データ転送。pOutputFile = NULL
    // で通常スプール経由。
    const docInfo = Buffer.alloc(DOC_INFO_1_SIZE);
    const nameBuf = Buffer.from(jobName + "\0", "utf16le");
    const datatypeBuf = Buffer.from("RAW\0", "utf16le");
    docInfo.writeBigInt64LE(BigInt(native.koffi.address(nameBuf)), 0);
    docInfo.writeBigInt64LE(0n, 8);  // pOutputFile = NULL
    docInfo.writeBigInt64LE(BigInt(native.koffi.address(datatypeBuf)), 16);

    const jobId = native.StartDocPrinterW(hPrinter, 1, docInfo);
    if (jobId === 0) throw new Error("StartDocPrinterW returned 0");
    docStarted = true;

    // WritePrinter は呼び出し毎に Buffer 全体を書き込む。Windows は
    // 一度に数 MB 程度なら問題なく扱えるが、64KB 程度に分割すると
    // 進捗のキャンセル余地や安定性が増す。bytes は呼び出し側で
    // Buffer に統一済 (subarray は同一メモリ View)。
    const CHUNK = 65536;
    const written = [0];
    let offset = 0;
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    while (offset < buf.length) {
      const remaining = buf.length - offset;
      const len = Math.min(CHUNK, remaining);
      const chunk = buf.subarray(offset, offset + len);
      written[0] = 0;
      const ok = native.WritePrinter(hPrinter, chunk, len, written);
      if (!ok) throw new Error(`WritePrinter failed at offset ${offset}`);
      const w = written[0];
      if (w === 0) throw new Error(`WritePrinter wrote 0 bytes at offset ${offset}`);
      offset += w;
    }

    if (!native.EndDocPrinter(hPrinter)) {
      throw new Error("EndDocPrinter returned false");
    }
    docStarted = false;
  } catch (err) {
    if (docStarted) {
      try { native.AbortPrinter(hPrinter); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    if (hPrinter) {
      try { native.ClosePrinter(hPrinter); } catch { /* ignore */ }
    }
  }
}

/**
 * PDF bytes を PostScript 経由でプリンタへ送信する (β58: 純 mupdf 出力、
 * setpagedevice prelude は撤去)。
 *
 * @param {Buffer|Uint8Array} pdfBytes
 * @param {object} opts
 * @param {string} opts.deviceName
 * @param {string} [opts.jobName="K-PDF3"]
 * @returns {Promise<{success: true, byteCount: number}>}
 */
export async function printPdfViaPostScript(pdfBytes, opts) {
  const native = await tryLoadNative();
  if (!native) throw new Error("printPdfViaPostScript: koffi/native unavailable");
  const { deviceName, jobName = "K-PDF3 (PS)" } = opts ?? {};
  if (!deviceName) throw new Error("printPdfViaPostScript: deviceName missing");

  const psBytes = pdfBytesToPdl(pdfBytes, "ps");
  await sendRawToPrinter(native, deviceName, jobName, psBytes);
  return { success: true, byteCount: psBytes.length };
}

/**
 * PDF bytes を PCL 経由でプリンタへ送信する (β58 で追加)。多くの複合機が
 * PCL を標準対応しているので、PostScript が解釈失敗するプリンタの fallback
 * として位置付け。mupdf の fz_new_pcl_writer_with_output を使用。
 *
 * @param {Buffer|Uint8Array} pdfBytes
 * @param {object} opts
 * @param {string} opts.deviceName
 * @param {string} [opts.jobName="K-PDF3"]
 * @returns {Promise<{success: true, byteCount: number}>}
 */
export async function printPdfViaPcl(pdfBytes, opts) {
  const native = await tryLoadNative();
  if (!native) throw new Error("printPdfViaPcl: koffi/native unavailable");
  const { deviceName, jobName = "K-PDF3 (PCL)" } = opts ?? {};
  if (!deviceName) throw new Error("printPdfViaPcl: deviceName missing");

  const pclBytes = pdfBytesToPdl(pdfBytes, "pcl");
  await sendRawToPrinter(native, deviceName, jobName, pclBytes);
  return { success: true, byteCount: pclBytes.length };
}

/** デバッグ用: koffi がロードできるかだけ確認する。 */
export async function probePsNativeAvailable() {
  const n = await tryLoadNative();
  return !!n;
}
