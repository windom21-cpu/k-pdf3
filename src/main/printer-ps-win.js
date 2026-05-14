// β57: PostScript raw print path (案 N 改 / 案 N')。
//
// 経緯: 案 M (Win32 GDI 直接ラスタ) はβ56 で実装したが、mupdf がプリンタ
// DPI で焼いたビットマップを GDI 経由で送る構造上、Adobe Reader の
// ベクトル印字 (XPS / PS print path) に質感で追い付かないことが β56
// ユーザ検証で確定。XPS は mupdf-js の WASM ビルドに writer 未収録だが、
// PostScript writer (fz_new_ps_writer_with_output) は使えることが
// 判明したのでこちらに切替。
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
 * PDF bytes を PostScript bytes に変換する。mupdf の DocumentWriter
 * (format="ps") を使う。テキストは可能な限りベクトル保持されるので、
 * プリンタの PostScript インタプリタが native DPI で描画する。
 *
 * 注: mupdf-js の WASM ビルドには XPS writer が無いため、PS writer を
 *     使う。SVG / PCL も使えるが PS が複合機の標準サポート言語。
 *
 * @param {Buffer|Uint8Array} pdfBytes
 * @returns {Uint8Array}  PostScript 文書 bytes
 */
function pdfBytesToPostScript(pdfBytes) {
  const doc = openPdfDocument(pdfBytes);
  try {
    const out = new mupdf.Buffer();
    // DocumentWriter のオプションは format ごとに異なる。"ps" の場合
    // 空文字でデフォルト動作。今後 "language=2" 等で PostScript level を
    // 指定するなどの拡張余地あり。
    const writer = new mupdf.DocumentWriter(out, "ps", "");
    try {
      const pageCount = doc.countPages();
      for (let i = 0; i < pageCount; i++) {
        const page = doc.loadPage(i);
        try {
          const bounds = page.getBounds();
          const device = writer.beginPage(bounds);
          // Matrix.identity = [1,0,0,1,0,0]: PDF native スケールのまま
          // 出力。プリンタ側で印字時にスケーリング (用紙サイズ合わせ
          // 等) は spooler / driver 経由で適用される。
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

/**
 * β46-β48 で取得した DEVMODE 由来の設定 (copies/duplex/tray/color) を
 * PostScript の `setpagedevice` 命令文に変換し、PS 出力の頭に prepend
 * できる形で返す。
 *
 * mupdf の PS writer は出力冒頭に `%!PS-Adobe-3.0` などの DSC ヘッダを
 * 入れるため、その「直後」に prelude を挟むのが正攻法だが、多くの PS
 * インタプリタは「先頭に追加 setpagedevice → DSC ヘッダ」の順でも
 * 受け付ける (DSC は構文より「コメント情報」扱い)。今回はシンプル化
 * のため文字通り先頭に prepend する。
 *
 * 各設定の PS マッピング (PostScript Level 2 standard):
 *   /Duplex true /Tumble false  : 長辺綴じ両面
 *   /Duplex true /Tumble true   : 短辺綴じ両面
 *   /Duplex false               : 片面
 *   /ProcessColorModel /DeviceGray : 白黒
 *   /ProcessColorModel /DeviceRGB  : カラー
 *   /MediaPosition <int>        : トレイ (driver-specific 数値)
 *   /NumCopies <int>            : 部数
 *
 * @returns {string}  setpagedevice prelude (改行付き)、なければ空文字
 */
function buildPostScriptPrelude(opts) {
  const dictParts = [];
  if (opts.duplex === "long-edge") dictParts.push("/Duplex true /Tumble false");
  else if (opts.duplex === "short-edge") dictParts.push("/Duplex true /Tumble true");
  else if (opts.duplex === "simplex") dictParts.push("/Duplex false");
  if (opts.color === "mono") dictParts.push("/ProcessColorModel /DeviceGray");
  else if (opts.color === "color") dictParts.push("/ProcessColorModel /DeviceRGB");
  if (Number.isInteger(opts.bin) && opts.bin > 0) {
    dictParts.push(`/MediaPosition ${opts.bin}`);
  }
  if (Number.isInteger(opts.copies) && opts.copies > 1) {
    dictParts.push(`/NumCopies ${opts.copies}`);
  }
  if (opts.landscape) {
    // PostScript には /Orientation キーがあるが、driver の解釈差が大きい。
    // 多くの場合 PDF 側で既に landscape 配置になっているので setpagedevice
    // では指定せず PDF の rotation 情報に任せる。
  }
  if (dictParts.length === 0) return "";
  return `<<\n  ${dictParts.join("\n  ")}\n>> setpagedevice\n`;
}

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
 * PDF bytes を PostScript 経由でプリンタへ送信する。
 *
 * @param {Buffer|Uint8Array} pdfBytes
 * @param {object} opts
 * @param {string} opts.deviceName
 * @param {string} [opts.jobName="K-PDF3"]
 * @param {number} [opts.copies=1]
 * @param {boolean} [opts.landscape=false]
 * @param {"simplex"|"long-edge"|"short-edge"|null} [opts.duplex=null]
 * @param {number|null} [opts.bin=null]           dmDefaultSource (tray)
 * @param {"color"|"mono"|null} [opts.color=null]
 * @returns {Promise<{success: true, byteCount: number}>}
 */
export async function printPdfViaPostScript(pdfBytes, opts) {
  const native = await tryLoadNative();
  if (!native) throw new Error("printPdfViaPostScript: koffi/native unavailable");
  const {
    deviceName,
    jobName = "K-PDF3",
    copies = 1,
    landscape = false,
    duplex = null,
    bin = null,
    color = null,
  } = opts ?? {};
  if (!deviceName) throw new Error("printPdfViaPostScript: deviceName missing");

  // 1. PDF → PS 変換 (mupdf)
  const psCore = pdfBytesToPostScript(pdfBytes);

  // 2. β46-β48 設定を setpagedevice prelude に変換し prepend
  const preludeStr = buildPostScriptPrelude({ copies, landscape, duplex, bin, color });
  const preludeBytes = preludeStr.length > 0
    ? Buffer.from(preludeStr, "ascii")
    : Buffer.alloc(0);

  // 3. 結合 (prelude + mupdf PS 出力)
  const finalBytes = preludeBytes.length > 0
    ? Buffer.concat([preludeBytes, Buffer.from(psCore)])
    : psCore;

  // 4. Win32 raw print でプリンタへ送信
  await sendRawToPrinter(native, deviceName, jobName, finalBytes);

  return { success: true, byteCount: finalBytes.length };
}

/** デバッグ用: koffi がロードできるかだけ確認する。 */
export async function probePsNativeAvailable() {
  const n = await tryLoadNative();
  return !!n;
}
