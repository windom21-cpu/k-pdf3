// β56: Win32 GDI 直接印刷経路（K-PDF3 内製のラスタ印刷）。
//
// 経緯: Sumatra (バンドル中 3.6.1) の GDI vector path で日本語明朝が
// ドライバ側 raster fallback を踏んで荒れる (ユーザ報告 β55 検証時)。
// Sumatra 3.6 系列には PrintAsImage 相当の品質トークン無し (β55 で確認
// 済)。Adobe Reader だと綺麗に出る = 通常 Win32 印刷 API を silent 指示
// なしで呼ぶだけで OK、という構造判明。
//
// 本ファイルでは Win32 印刷 API + GDI を直接コールし、ページを mupdf で
// プリンタ DPI にラスタライズして StretchDIBits で送る経路を提供。
// Adobe Reader と同じ低レベル経路に乗るので、明朝の品質は Adobe 同等
// になる見込み。
//
// 既存の β14-β54 修正との関係:
// - β46 J3 / β47 J4: DEVMODE 抽出 → CreateDC に渡す pDevMode で活きる
// - β48 J4b: SetPrinter level 9 経由ではなく CreateDC に DEVMODE buffer
//   を直接渡せるので、driver-private bytes (FUJIFILM お気に入りプリセッ
//   ト等) もそのまま反映される。SetPrinter level 9 経路は Sumatra
//   fallback 用に残す。
// - β42-β43 / β54 FAX 経路: FAX は本ファイルを通さず silentPrintPdf
//   (Chromium silent:false) のままにする。本ファイルは silent 指示なし
//   とはいえ「StartDoc 直前にユーザ対話を挟む」用途には向かないため。
//
// FAX 統合の検討は β59-β60 のオプション項目 (HANDOVER §β56 移行メモ)。

import { openPdfDocument, renderPagePixels } from "../backend/mupdf-render.js";

// GetDeviceCaps indices
const LOGPIXELSX     = 88;  // 論理 DPI X (ドライバが返すプリンタ DPI)
const LOGPIXELSY     = 90;  // 論理 DPI Y
const HORZRES        = 8;   // 印刷可能領域の幅 (pixel)
const VERTRES        = 10;  // 印刷可能領域の高さ (pixel)
const PHYSICALWIDTH  = 110; // 用紙物理幅 (pixel) — 印刷可能外も含む
const PHYSICALHEIGHT = 111; // 用紙物理高さ (pixel)
const PHYSICALOFFSETX = 112; // 印刷可能領域の左端オフセット
const PHYSICALOFFSETY = 113;

// StretchDIBits constants
const DIB_RGB_COLORS = 0;
const BI_RGB         = 0;
const SRCCOPY        = 0x00CC0020;

// DOCINFOW.cbSize (64bit, 8byte-align): int(4) + pad(4) + 3 * ptr(8) + dword(4) = 36, padded to 40
const DOCINFOW_SIZE = 40;
// BITMAPINFOHEADER.biSize = 40
const BITMAPINFOHEADER_SIZE = 40;

let _native = null;
let _nativeAttempted = false;

/** koffi バインドを遅延ロード。printer-properties-win.js と同じ
 *  パターンで、Win 以外 / koffi 未利用環境では null を返す。
 *  失敗時は warn のみで、上位は Sumatra fallback に流す。*/
async function tryLoadNative() {
  if (_nativeAttempted) return _native;
  _nativeAttempted = true;
  if (process.platform !== "win32") return null;
  try {
    const koffiMod = await import("koffi");
    const koffi = koffiMod.default ?? koffiMod;
    const gdi32 = koffi.load("gdi32.dll");
    const winspool = koffi.load("winspool.drv");
    _native = {
      koffi,
      // gdi32.dll
      // CreateDCW(driver, deviceName, output, pdevmode) → HDC
      // driver は NULL (deviceName から駆動を引く)、output も NULL。
      // pdevmode は β46-β48 経路で取得した DEVMODE buffer (driver-private
      // bytes 込み)。NULL を渡すと per-user 既定 (β48 J4b 経路) が使われる。
      CreateDCW: gdi32.func(
        "__stdcall",
        "CreateDCW",
        "int64", // HDC
        ["str16", "str16", "str16", "void *"],
      ),
      DeleteDC: gdi32.func("__stdcall", "DeleteDC", "bool", ["int64"]),
      // StartDocW: 第 2 引数は DOCINFOW *、戻りはジョブ ID (>0 で成功)。
      // 必要な時はここで FAX 系ドライバが UI を出すので silent 指示は
      // 一切渡さない。
      StartDocW: gdi32.func("__stdcall", "StartDocW", "int", ["int64", "void *"]),
      EndDoc:   gdi32.func("__stdcall", "EndDoc",   "int", ["int64"]),
      StartPage: gdi32.func("__stdcall", "StartPage", "int", ["int64"]),
      EndPage:   gdi32.func("__stdcall", "EndPage",   "int", ["int64"]),
      AbortDoc:  gdi32.func("__stdcall", "AbortDoc",  "int", ["int64"]),
      GetDeviceCaps: gdi32.func(
        "__stdcall",
        "GetDeviceCaps",
        "int",
        ["int64", "int"],
      ),
      // StretchDIBits(hdc, xD, yD, dW, dH, xS, yS, sW, sH, pBits, pBmi, usage, rop)
      // 返り値はスキャンライン数 or GDI_ERROR。
      StretchDIBits: gdi32.func(
        "__stdcall",
        "StretchDIBits",
        "int",
        [
          "int64", // HDC
          "int", "int", "int", "int", // dest x,y,w,h
          "int", "int", "int", "int", // src  x,y,w,h
          "void *",  // bits
          "void *",  // BITMAPINFO
          "uint32",  // usage (DIB_RGB_COLORS)
          "uint32",  // rop  (SRCCOPY)
        ],
      ),
      // winspool.drv: OpenPrinter / ClosePrinter は CreateDC が内部的に
      // 駆動側を握るので必須ではないが、可搬性のためジョブ進行と並走
      // する間 OpenPrinter で握っておく方が安全 (DEVMODE buffer の寿命
      // とプリンタハンドルの寿命を揃える)。printer-properties-win.js
      // にも同じバインドがあるが、koffi は同じ DLL の二重ロードを安全
      // に扱うので import 重複は問題なし。
      OpenPrinterW: winspool.func(
        "__stdcall",
        "OpenPrinterW",
        "bool",
        ["str16", koffi.out(koffi.pointer("int64")), "void *"],
      ),
      ClosePrinter: winspool.func(
        "__stdcall",
        "ClosePrinter",
        "bool",
        ["int64"],
      ),
    };
  } catch (err) {
    console.warn(
      "[print-gdi] koffi unavailable, will fall back to Sumatra:",
      err?.message ?? err,
    );
    _native = null;
  }
  return _native;
}

/** mupdf の RGB pixel buffer (top-down, 3 byte/pixel) を GDI が期待する
 *  BGR (top-down, 4-byte 行揃え) にその場変換する。
 *
 *  - mupdf: 行 stride = width * 3、各画素 R G B 順
 *  - GDI BI_RGB 24bpp: 各行 4-byte 境界に揃える、各画素 B G R 順
 *
 *  戻り Buffer は GDI に渡す形式。返却サイズは row stride * height。 */
function rgbTopDownToBgrDibRows(rgb, width, height) {
  const srcStride = width * 3;
  const dstStride = (width * 3 + 3) & ~3; // 4 byte align
  const out = Buffer.alloc(dstStride * height);
  for (let y = 0; y < height; y++) {
    const srcOff = y * srcStride;
    const dstOff = y * dstStride;
    for (let x = 0; x < width; x++) {
      const s = srcOff + x * 3;
      const d = dstOff + x * 3;
      out[d]     = rgb[s + 2]; // B
      out[d + 1] = rgb[s + 1]; // G
      out[d + 2] = rgb[s];     // R
    }
    // 行末パディング (dstStride - srcStride) は Buffer.alloc により 0 埋め
  }
  return { bits: out, stride: dstStride };
}

/** DOCINFOW を Buffer で構築。
 *  cbSize は 40 (x64)。lpszDocName は UTF-16 NUL 終端の Buffer を別途
 *  確保し、その address をフィールドに書き込む。output / datatype は NULL。 */
function buildDocInfoW(koffi, jobName) {
  // jobName の UTF-16LE バッファ (NUL 終端含む)
  const name16 = Buffer.from(jobName + "\0", "utf16le");
  const docinfo = Buffer.alloc(DOCINFOW_SIZE);
  docinfo.writeInt32LE(DOCINFOW_SIZE, 0);
  // offset 4-7 は alignment padding (0 のまま)
  docinfo.writeBigInt64LE(BigInt(koffi.address(name16)), 8);  // lpszDocName
  docinfo.writeBigInt64LE(0n, 16);  // lpszOutput = NULL → スプール
  docinfo.writeBigInt64LE(0n, 24);  // lpszDatatype = NULL → driver 既定
  docinfo.writeUInt32LE(0, 32);     // fwType
  // 末尾 4 byte は alignment padding
  return { buffer: docinfo, nameBuf: name16 }; // nameBuf は GC 防止のため返す
}

/** BITMAPINFOHEADER を Buffer で構築。biHeight を負値にして top-down 指示。 */
function buildBitmapInfoHeader(width, height) {
  const bmi = Buffer.alloc(BITMAPINFOHEADER_SIZE);
  bmi.writeUInt32LE(BITMAPINFOHEADER_SIZE, 0);  // biSize
  bmi.writeInt32LE(width, 4);                    // biWidth
  bmi.writeInt32LE(-height, 8);                  // biHeight: 負値 = top-down DIB
  bmi.writeUInt16LE(1, 12);                      // biPlanes
  bmi.writeUInt16LE(24, 14);                     // biBitCount (24bpp BGR)
  bmi.writeUInt32LE(BI_RGB, 16);                 // biCompression
  bmi.writeUInt32LE(0, 20);                      // biSizeImage (BI_RGB は 0 で可)
  bmi.writeInt32LE(0, 24);                       // biXPelsPerMeter
  bmi.writeInt32LE(0, 28);                       // biYPelsPerMeter
  bmi.writeUInt32LE(0, 32);                      // biClrUsed
  bmi.writeUInt32LE(0, 36);                      // biClrImportant
  return bmi;
}

/**
 * PDF bytes を Win32 GDI + mupdf 経由で印刷する。
 *
 * @param {Buffer|Uint8Array} pdfBytes  対象 PDF
 * @param {object} opts
 * @param {string} opts.deviceName       出力プリンタの device 名
 * @param {Buffer} [opts.devmodeBuffer]  β46-β48 で取得した DEVMODE buffer
 *                                       (driver-private bytes 込み)。null
 *                                       の場合は per-user 既定が使われる
 *                                       (β48 J4b 経路と同じ挙動)。
 * @param {string} [opts.jobName]        スプールに表示されるジョブ名
 * @param {() => boolean} [opts.isCancelled]  キャンセル要求検出 callback
 * @returns {Promise<{success: true, pageCount: number}>}
 * @throws koffi 未ロード / Win32 API 失敗 → 上位は Sumatra fallback へ
 */
export async function printPdfViaWinGdi(pdfBytes, opts) {
  const native = await tryLoadNative();
  if (!native) throw new Error("printPdfViaWinGdi: koffi/native unavailable");
  const { deviceName, devmodeBuffer = null, jobName = "K-PDF3", isCancelled = null } = opts;
  if (!deviceName) throw new Error("printPdfViaWinGdi: deviceName missing");

  let doc = null;
  let hPrinter = 0n;
  let hDC = 0n;
  let docStarted = false;
  let pageStarted = false;
  try {
    doc = openPdfDocument(pdfBytes);
    const pageCount = doc.countPages();
    if (pageCount === 0) throw new Error("printPdfViaWinGdi: PDF has zero pages");

    // OpenPrinter で printer handle を握り続ける。DEVMODE buffer の寿命と
    // ジョブ進行を同じスコープにまとめる狙い (途中でドライバが内部 DEVMODE
    // を更新しても外部ハンドラへの影響を最小化)。
    const out = [0n];
    if (!native.OpenPrinterW(deviceName, out, null)) {
      throw new Error(`OpenPrinterW("${deviceName}") returned false`);
    }
    hPrinter = out[0];

    // CreateDC は driver name = null で deviceName から自動引き、output =
    // null でスプール送り。DEVMODE buffer を渡すと driver-private bytes
    // (FUJIFILM お気に入りプリセット等) も伝わる。
    hDC = native.CreateDCW(null, deviceName, null, devmodeBuffer ?? null);
    if (!hDC || hDC === 0n) {
      throw new Error(`CreateDCW("${deviceName}") returned NULL`);
    }

    // プリンタ DPI と印刷可能領域を取得。LOGPIXELSX/Y は通常 300/600/1200
    // 等。HORZRES/VERTRES は印刷可能領域内の pixel 数。
    const dpiX = native.GetDeviceCaps(hDC, LOGPIXELSX);
    const dpiY = native.GetDeviceCaps(hDC, LOGPIXELSY);
    const printableW = native.GetDeviceCaps(hDC, HORZRES);
    const printableH = native.GetDeviceCaps(hDC, VERTRES);
    const physOffX  = native.GetDeviceCaps(hDC, PHYSICALOFFSETX);
    const physOffY  = native.GetDeviceCaps(hDC, PHYSICALOFFSETY);
    if (!Number.isFinite(dpiX) || dpiX <= 0 || !Number.isFinite(dpiY) || dpiY <= 0) {
      throw new Error(`GetDeviceCaps DPI invalid: x=${dpiX} y=${dpiY}`);
    }

    // StartDoc — ここで FAX 系ドライバが driver UI を出す可能性 (β56
    // 時点では FAX は別経路に分けているため通常プリンタ前提)。silent
    // 指示は渡していないので driver UI は出る設計。
    const docInfo = buildDocInfoW(native.koffi, jobName);
    const jobId = native.StartDocW(hDC, docInfo.buffer);
    if (jobId <= 0) throw new Error(`StartDocW returned ${jobId}`);
    docStarted = true;

    for (let i = 0; i < pageCount; i++) {
      if (isCancelled && isCancelled()) {
        // Abort で spool から取り除く。EndDoc は呼ばない。
        try { native.AbortDoc(hDC); } catch { /* ignore */ }
        docStarted = false;
        throw new Error("printPdfViaWinGdi: cancelled");
      }

      // ページサイズ (PDF point) を取得。72dpi 換算なので
      // pixel = pt * dpi / 72 でラスタライズすればプリンタ DPI 相当。
      const page = doc.loadPage(i);
      let bounds;
      try {
        bounds = page.getBounds();
      } finally {
        page.destroy();
      }
      const pageWpt = bounds[2] - bounds[0];
      const pageHpt = bounds[3] - bounds[1];

      // ラスタ pixel 寸法 (= プリンタ DPI でのドット数)
      const pixW = Math.max(1, Math.round(pageWpt * dpiX / 72));
      const pixH = Math.max(1, Math.round(pageHpt * dpiY / 72));

      // mupdf matrix: scale(dpi/72, dpi/72)。renderPagePixels は alpha=false
      // で RGB を返す。
      const sx = dpiX / 72;
      const sy = dpiY / 72;
      const matrix = [sx, 0, 0, sy, 0, 0];
      const res = renderPagePixels(doc, i, matrix, { alpha: false });
      // res.width / res.height は mupdf 側丸めで pixW/pixH と多少ずれる
      // ことがある。dest スケールは「印刷可能領域に合わせて等比縮小」が
      // 望ましいが、PDF が用紙より大きいケースや回転 PDF を考慮するため
      // 単純化として「実 pixel 寸法 = res.width/height をそのまま使い、
      // dest は印刷可能領域いっぱい (左上から)」とする。後段で fit
      // モードを実装する余地はある (今は noscale 相当)。
      const { bits, stride } = rgbTopDownToBgrDibRows(
        res.pixels, res.width, res.height,
      );
      const bmi = buildBitmapInfoHeader(res.width, res.height);

      const startedPage = native.StartPage(hDC);
      if (startedPage <= 0) throw new Error(`StartPage returned ${startedPage}`);
      pageStarted = true;

      // 印刷可能領域いっぱいに drawing。物理オフセットを考慮し dest を
      // (-physOffX, -physOffY) からにすると「用紙の左上端」起点になる。
      // ラスタ pixel 寸法とプリンタ pixel 寸法は dpi が同じなら一致するので
      // src = dest を等比で。
      const destX = -physOffX;
      const destY = -physOffY;
      // dest 幅は ラスタ pixel と等しくする (printerDpi/72 で焼いたので)
      const destW = res.width;
      const destH = res.height;
      const ret = native.StretchDIBits(
        hDC,
        destX, destY, destW, destH,
        0, 0, res.width, res.height,
        bits, bmi,
        DIB_RGB_COLORS, SRCCOPY,
      );
      if (ret <= 0) {
        // ret == 0 はエラー、または「クリッピング後に何も描画されなかった」
        // 場合に発生する。後者は実害なし (空白ページ) なので警告のみ。
        console.warn(`[print-gdi] StretchDIBits returned ${ret} on page ${i + 1}`);
      }

      const endedPage = native.EndPage(hDC);
      pageStarted = false;
      if (endedPage <= 0) throw new Error(`EndPage returned ${endedPage}`);
      // stride は未使用だが「行揃え計算が走った」ことを引用しておきたい
      // 場合のために変数に出してある (linter 黙らせ目的では無く、診断
      // ログを将来挟む余地)。
      void stride;
    }

    const endedDoc = native.EndDoc(hDC);
    docStarted = false;
    if (endedDoc <= 0) throw new Error(`EndDoc returned ${endedDoc}`);

    return { success: true, pageCount };
  } catch (err) {
    // クリーンアップ: ページ中ならページ捨て、ジョブ中なら AbortDoc。
    if (pageStarted) {
      try { native.AbortDoc(hDC); } catch { /* ignore */ }
      docStarted = false;
    } else if (docStarted) {
      try { native.AbortDoc(hDC); } catch { /* ignore */ }
      docStarted = false;
    }
    throw err;
  } finally {
    if (hDC && hDC !== 0n) {
      try { native.DeleteDC(hDC); } catch { /* ignore */ }
    }
    if (hPrinter && hPrinter !== 0n) {
      try { native.ClosePrinter(hPrinter); } catch { /* ignore */ }
    }
    try { doc?.destroy?.(); } catch { /* ignore */ }
  }
}

/** デバッグ用 export — koffi がロードできるかだけ確認する軽量プローブ。
 *  ロード可能環境では true、それ以外は false。Win 非対応 / koffi バンド
 *  ル欠落 / DLL 解決失敗をログで切り分けるため。*/
export async function probeGdiNativeAvailable() {
  const n = await tryLoadNative();
  return !!n;
}

