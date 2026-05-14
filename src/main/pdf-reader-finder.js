// β64: OS にインストール済の PDF Reader (Adobe Acrobat Reader / Acrobat
// Pro / Foxit Reader / PDF-XChange Editor) を検出し、印刷用 CLI 経路と
// して優先順位を返すモジュール。
//
// 経緯: β56-β63 で K-PDF3 自身が高品質印刷を実現しようとした全試行が
// C2360 ドライバの「PDF コンテンツ → 全面 raster」挙動に阻まれた。
// 最終的に C アプローチ採用 (HANDOVER §β64 詳述)。Adobe 等の独自
// PDF 印刷エンジンを持つ Reader に印刷を委譲することで、自前で
// vector 印字を組み立てる労苦から解放される。
//
// 優先順位 (C2360 で動作確認済 or 同等エンジン期待):
//   1. Adobe Acrobat (Pro)
//   2. Adobe Acrobat Reader DC
//   3. Foxit Reader
//   4. PDF-XChange Editor
// 上記いずれも検出されない場合は null を返し、上位は Sumatra
// fallback (β53 J8 経路) へ流す。
//
// 各 Reader 共通 CLI 仕様:
//   AcroRd32.exe / Acrobat.exe / FoxitReader.exe / PDFXEdit.exe
//     /n /t "file.pdf" "printer name"  (silent print, exit on done)
//   /n : 新規プロセスとして起動
//   /t : 指定プリンタへサイレント印刷後 exit
//
// printer 名は β48 J4b の SetPrinter level 9 で per-user 既定 DEVMODE を
// 押し込んでおけば、各 Reader が読み込んで duplex/tray/color/copies/
// お気に入りプリセット が反映される。

import { existsSync } from "node:fs";
import { join } from "node:path";

/** @typedef {{ engine: "adobe-acrobat"|"adobe-reader"|"foxit"|"pdfxchange",
 *              exePath: string, displayName: string }} PdfReaderInfo */

// Adobe Acrobat / Reader の代表的 install path 候補。世代によって
// "Adobe\Acrobat DC\Acrobat\Acrobat.exe" / "Adobe\Acrobat Reader DC\Reader\
// AcroRd32.exe" の他、x86/x64 で Program Files が分かれる。発見できた
// 最初を採用する (新しいもの順に並べる)。
function adobeAcrobatCandidates() {
  const pf64 = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf32 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return [
    join(pf64, "Adobe", "Acrobat DC", "Acrobat", "Acrobat.exe"),
    join(pf32, "Adobe", "Acrobat DC", "Acrobat", "Acrobat.exe"),
    join(pf64, "Adobe", "Acrobat 2020", "Acrobat", "Acrobat.exe"),
    join(pf32, "Adobe", "Acrobat 2020", "Acrobat", "Acrobat.exe"),
    join(pf64, "Adobe", "Acrobat 2017", "Acrobat", "Acrobat.exe"),
    join(pf32, "Adobe", "Acrobat 2017", "Acrobat", "Acrobat.exe"),
  ];
}

function adobeReaderCandidates() {
  const pf64 = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf32 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return [
    join(pf64, "Adobe", "Acrobat Reader DC", "Reader", "AcroRd32.exe"),
    join(pf32, "Adobe", "Acrobat Reader DC", "Reader", "AcroRd32.exe"),
    join(pf64, "Adobe", "Reader 11.0", "Reader", "AcroRd32.exe"),
    join(pf32, "Adobe", "Reader 11.0", "Reader", "AcroRd32.exe"),
  ];
}

function foxitCandidates() {
  const pf64 = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf32 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return [
    join(pf64, "Foxit Software", "Foxit PDF Reader", "FoxitPDFReader.exe"),
    join(pf32, "Foxit Software", "Foxit PDF Reader", "FoxitPDFReader.exe"),
    join(pf64, "Foxit Software", "Foxit Reader", "FoxitReader.exe"),
    join(pf32, "Foxit Software", "Foxit Reader", "FoxitReader.exe"),
  ];
}

function pdfXchangeCandidates() {
  const pf64 = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf32 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return [
    join(pf64, "Tracker Software", "PDF Editor", "PDFXEdit.exe"),
    join(pf32, "Tracker Software", "PDF Editor", "PDFXEdit.exe"),
    join(pf64, "Tracker Software", "PDF Viewer", "PDFXCview.exe"),
    join(pf32, "Tracker Software", "PDF Viewer", "PDFXCview.exe"),
  ];
}

// 検出結果のキャッシュ (起動毎に再探索しない、簡易メモ化)。
let _cached = undefined;

/**
 * インストール済 PDF Reader を優先順位で探索し、最初に見つかったもの
 * を返す。複数候補から「Acrobat Pro > Reader > Foxit > PDF-XChange」
 * の順で選択。
 *
 * @returns {PdfReaderInfo | null}
 */
export function findPdfReader() {
  if (_cached !== undefined) return _cached;
  if (process.platform !== "win32") {
    _cached = null;
    return null;
  }
  // β65: Acrobat Reader DC を Acrobat Pro より優先。Reader DC は CLI
  // silent print (/n /s /o /h /t) が安定して動作するが、Pro は editor
  // 用途の重量級アプリで CLI silent 挙動が quirky (ウィンドウ閉じない
  // 等) なため。Pro は Reader 未インストール時の fallback として残置。
  for (const p of adobeReaderCandidates()) {
    if (existsSync(p)) {
      _cached = {
        engine: "adobe-reader",
        exePath: p,
        displayName: "Adobe Acrobat Reader DC",
      };
      return _cached;
    }
  }
  // Adobe Acrobat (Pro) — Reader 未インストール時の fallback
  for (const p of adobeAcrobatCandidates()) {
    if (existsSync(p)) {
      _cached = {
        engine: "adobe-acrobat",
        exePath: p,
        displayName: "Adobe Acrobat",
      };
      return _cached;
    }
  }
  // Foxit Reader
  for (const p of foxitCandidates()) {
    if (existsSync(p)) {
      _cached = {
        engine: "foxit",
        exePath: p,
        displayName: "Foxit PDF Reader",
      };
      return _cached;
    }
  }
  // PDF-XChange
  for (const p of pdfXchangeCandidates()) {
    if (existsSync(p)) {
      _cached = {
        engine: "pdfxchange",
        exePath: p,
        displayName: "PDF-XChange Editor",
      };
      return _cached;
    }
  }
  _cached = null;
  return null;
}

/** テスト / 切替検証用に cache をクリアする。 */
export function clearPdfReaderCache() {
  _cached = undefined;
}

/**
 * β70: 検出済の全 PDF Reader を優先順位で返す (engine 選択 UI 用)。
 * findPdfReader は最初の 1 件しか返さないが、ユーザが選択肢として
 * 見るためには全候補を列挙する必要がある。Adobe DC 時代は Pro と
 * Reader が排他なので両者が同時に検出されることはない。
 *
 * @returns {PdfReaderInfo[]}
 */
export function findAllPdfReaders() {
  if (process.platform !== "win32") return [];
  const out = [];
  // Reader DC 優先 (β65)
  for (const p of adobeReaderCandidates()) {
    if (existsSync(p)) {
      out.push({
        engine: "adobe-reader",
        exePath: p,
        displayName: "Adobe Acrobat Reader DC",
      });
      break;
    }
  }
  // Acrobat (Pro)
  for (const p of adobeAcrobatCandidates()) {
    if (existsSync(p)) {
      out.push({
        engine: "adobe-acrobat",
        exePath: p,
        displayName: "Adobe Acrobat",
      });
      break;
    }
  }
  // Foxit
  for (const p of foxitCandidates()) {
    if (existsSync(p)) {
      out.push({
        engine: "foxit",
        exePath: p,
        displayName: "Foxit PDF Reader",
      });
      break;
    }
  }
  // PDF-XChange
  for (const p of pdfXchangeCandidates()) {
    if (existsSync(p)) {
      out.push({
        engine: "pdfxchange",
        exePath: p,
        displayName: "PDF-XChange Editor",
      });
      break;
    }
  }
  return out;
}
