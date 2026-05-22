// β.130: 挿入対象を PDF 以外 (画像 / Word / Excel) に拡張するための
// 「ファイル → PDF バイト列」変換モジュール。
//
// 設計: 変換した PDF バイト列を既存の挿入経路 (_insertPdfBytesIntoWorkspace)
// にそのまま流す。挿入後の描画 / 並べ替え / 書き出し / 印刷の plumbing は
// 100% 再利用される。
//
//   - 画像: pdf-lib で A4 1 ページ PDF に内包。JPEG / PNG はそのまま埋込、
//     その他 (gif/bmp/webp/tiff) は mupdf でデコード → PNG 化して埋込。
//   - Word / Excel: PowerShell + Microsoft Office COM 自動化で PDF 化。
//     LibreOffice は同梱しない方針 (約 300MB、CLAUDE.md「パッケージ追加は
//     明示指示のみ」)。Office 未導入環境では明示エラーを返す。
//
// 拡張子リストは renderer 側 (renderer.js の INSERT_EXT_RE) と揃えること。

import { app } from "electron";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as mupdf from "mupdf";
import { PDFDocument } from "pdf-lib";

// A4 (PostScript points)
const A4_W = 595.28;
const A4_H = 841.89;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff"]);
const WORD_EXTS = new Set(["doc", "docx"]);
const EXCEL_EXTS = new Set(["xls", "xlsx"]);

const IMAGE_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", bmp: "image/bmp", webp: "image/webp",
  tif: "image/tiff", tiff: "image/tiff",
};

/** 拡張子から末尾の小文字拡張子を取り出す。 */
function extOf(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path || "");
  return m ? m[1].toLowerCase() : "";
}

/**
 * 挿入対象としてのファイル種別を返す。
 * @returns {"pdf"|"image"|"word"|"excel"|null}
 */
export function classifyInsertFile(path) {
  const e = extOf(path);
  if (e === "pdf") return "pdf";
  if (IMAGE_EXTS.has(e)) return "image";
  if (WORD_EXTS.has(e)) return "word";
  if (EXCEL_EXTS.has(e)) return "excel";
  return null;
}

/** 先頭バイトで JPEG / PNG を判定 (pdf-lib に直接埋め込める形式)。 */
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpg";
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50
      && buf[2] === 0x4e && buf[3] === 0x47) {
    return "png";
  }
  return "other";
}

/** gif/bmp/webp/tiff を mupdf でデコードして PNG バイト列にする。 */
function decodeImageToPng(raw, ext) {
  let doc;
  let page;
  let pixmap;
  try {
    doc = mupdf.Document.openDocument(
      new Uint8Array(raw),
      IMAGE_MIME[ext] || "image",
    );
    page = doc.loadPage(0);
    // alpha=false → mupdf は未描画部を白で埋める (透過が黒落ちしない)。
    pixmap = page.toPixmap(
      mupdf.Matrix.scale(1, 1),
      mupdf.ColorSpace.DeviceRGB,
      false,
      false,
    );
    return Buffer.from(pixmap.asPNG());
  } finally {
    pixmap?.destroy?.();
    page?.destroy?.();
    doc?.destroy?.();
  }
}

/**
 * 画像ファイルを A4 1 ページの PDF (バイト列) に変換する。
 * 画像はアスペクト比を保ったままページに収め、中央寄せ。巨大なスキャン
 * 画像は縮小、小さい画像は 150dpi 相当を上限に拡大しすぎない。
 */
async function imageToPdfBytes(filePath) {
  const raw = readFileSync(filePath);
  const kind = sniffImage(raw);
  const pdf = await PDFDocument.create();
  let embedded;
  if (kind === "jpg") {
    embedded = await pdf.embedJpg(raw);
  } else if (kind === "png") {
    embedded = await pdf.embedPng(raw);
  } else {
    const png = decodeImageToPng(raw, extOf(filePath));
    embedded = await pdf.embedPng(png);
  }
  const iw = embedded.width;
  const ih = embedded.height;
  if (!(iw > 0) || !(ih > 0)) {
    throw new Error("画像の寸法を取得できませんでした");
  }
  // 横長画像は A4 横ページに載せる。
  const landscape = iw > ih;
  const pageW = landscape ? A4_H : A4_W;
  const pageH = landscape ? A4_W : A4_H;
  // 150dpi 相当の原寸 (これ以上は拡大しない)。
  const naturalW = (iw * 72) / 150;
  const naturalH = (ih * 72) / 150;
  let dw;
  let dh;
  if (naturalW <= pageW && naturalH <= pageH) {
    dw = naturalW;
    dh = naturalH;
  } else {
    const scale = Math.min(pageW / iw, pageH / ih);
    dw = iw * scale;
    dh = ih * scale;
  }
  const page = pdf.addPage([pageW, pageH]);
  page.drawImage(embedded, {
    x: (pageW - dw) / 2,
    y: (pageH - dh) / 2,
    width: dw,
    height: dh,
  });
  return Buffer.from(await pdf.save());
}

// Word / Excel → PDF の PowerShell スクリプト。パスは環境変数 KPDF3_IN /
// KPDF3_OUT 経由で渡す (コマンドライン補間を避け、日本語パス / 引用符
// 混入の事故を構造的に防ぐ)。exit code: 0=成功 / 1=変換失敗 / 2=Office 未導入。
const WORD_PS = `
$ErrorActionPreference = 'Stop'
$in = $env:KPDF3_IN
$out = $env:KPDF3_OUT
$word = $null
$doc = $null
try {
  try { $word = New-Object -ComObject Word.Application }
  catch { Write-Output 'Microsoft Word がインストールされていないため変換できません'; exit 2 }
  $word.Visible = $false
  $word.DisplayAlerts = 0
  try { $word.AutomationSecurity = 3 } catch {}
  $doc = $word.Documents.Open($in, $false, $true)
  $doc.ExportAsFixedFormat($out, 17)
  exit 0
} catch {
  Write-Output ('変換エラー: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($doc -ne $null) { try { $doc.Close(0) } catch {} }
  if ($word -ne $null) { try { $word.Quit() } catch {} }
}
`;

const EXCEL_PS = `
$ErrorActionPreference = 'Stop'
$in = $env:KPDF3_IN
$out = $env:KPDF3_OUT
$excel = $null
$wb = $null
try {
  try { $excel = New-Object -ComObject Excel.Application }
  catch { Write-Output 'Microsoft Excel がインストールされていないため変換できません'; exit 2 }
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  try { $excel.AutomationSecurity = 3 } catch {}
  $wb = $excel.Workbooks.Open($in, 0, $true)
  $wb.ExportAsFixedFormat(0, $out)
  exit 0
} catch {
  Write-Output ('変換エラー: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($wb -ne $null) { try { $wb.Close($false) } catch {} }
  if ($excel -ne $null) { try { $excel.Quit() } catch {} }
}
`;

const OFFICE_TIMEOUT_MS = 90_000;

/**
 * Word / Excel ファイルを Office COM 自動化で PDF 化し、バイト列を返す。
 * @param {string} filePath
 * @param {"word"|"excel"} kind
 */
function officeToPdfBytes(filePath, kind) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("Word / Excel の挿入は Windows 環境でのみ対応しています"));
      return;
    }
    const outPath = join(app.getPath("temp"), `kpdf3-insert-${randomUUID()}.pdf`);
    const script = kind === "word" ? WORD_PS : EXCEL_PS;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const label = kind === "word" ? "Word" : "Excel";
    let sp;
    try {
      sp = spawn(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive",
          "-ExecutionPolicy", "Bypass",
          "-EncodedCommand", encoded,
        ],
        {
          windowsHide: true,
          env: { ...process.env, KPDF3_IN: filePath, KPDF3_OUT: outPath },
        },
      );
    } catch (err) {
      reject(new Error(`PowerShell の起動に失敗しました: ${err?.message ?? err}`));
      return;
    }
    let out = "";
    sp.stdout?.on("data", (d) => { out += d.toString(); });
    sp.stderr?.on("data", (d) => { out += d.toString(); });

    const cleanupTemp = () => {
      try { if (existsSync(outPath)) unlinkSync(outPath); } catch { /* ignore */ }
    };

    const timer = setTimeout(() => {
      try { sp.kill(); } catch { /* ignore */ }
      cleanupTemp();
      reject(new Error(`${label} の PDF 変換がタイムアウトしました (90 秒)`));
    }, OFFICE_TIMEOUT_MS);

    sp.on("error", (err) => {
      clearTimeout(timer);
      cleanupTemp();
      reject(new Error(`PowerShell の起動に失敗しました: ${err?.message ?? err}`));
    });
    sp.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(outPath)) {
        let bytes;
        try {
          bytes = readFileSync(outPath);
        } catch (err) {
          cleanupTemp();
          reject(err);
          return;
        }
        cleanupTemp();
        resolve(bytes);
      } else {
        cleanupTemp();
        reject(new Error(out.trim() || `${label} の PDF 変換に失敗しました (exit ${code})`));
      }
    });
  });
}

/**
 * 挿入対象ファイルを PDF バイト列に変換する。PDF はそのまま読み込む。
 * 非対応形式や変換失敗時は分かりやすい日本語メッセージで throw する。
 *
 * @param {string} filePath
 * @returns {Promise<Buffer>}
 */
export async function convertFileToPdfBytes(filePath) {
  const kind = classifyInsertFile(filePath);
  if (kind === "pdf") return readFileSync(filePath);
  if (kind === "image") return await imageToPdfBytes(filePath);
  if (kind === "word") return await officeToPdfBytes(filePath, "word");
  if (kind === "excel") return await officeToPdfBytes(filePath, "excel");
  throw new Error("対応していないファイル形式です (PDF / 画像 / Word / Excel のみ)");
}
