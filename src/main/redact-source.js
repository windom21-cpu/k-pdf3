// 2026-07-10: 真の墨消し v2 — mupdf applyRedactions によるベクター維持の
// 物理削除。
//
// β.85 の真の墨消しは「redaction を含むページ全体を 900dpi ラスタに焼く」
// 方式だった (当時 β フィードバック 6 件を 1 日で対応した中の即日修正で、
// mupdf の native redaction は検討されていない — 却下記録なし)。ラスタ化は
// 安全だが、墨消しの無い領域までベクター品質を失い、印刷で「そのページ
// だけ滲む」品質差が出る (2026-07-10 Mac CUPS 経路で顕在化、ユーザー報告)。
//
// 本モジュールは source PDF に Redact annotation を置いて
// pdf_redact_page 相当を実行し、領域内のコンテンツを **PDF の内容ごと
// 物理削除** する:
//   - テキスト: REDACT_TEXT_REMOVE — 領域に掛かるグリフを content stream
//     から削除 (部分的に掛かる文字も丸ごと消える = Adobe と同じ安全側)
//   - 画像 (スキャン PDF): REDACT_IMAGE_PIXELS — 覆われた画素だけ黒抜き、
//     画像自体は保持 (全面スキャン謄写でページごと消えない。実測検証済)
//   - 線画: REDACT_LINE_ART_REMOVE_IF_COVERED — 完全に覆われたパスのみ
//     削除 (ベクター化された手書き署名等)。表の罫線のように領域を横切る
//     だけのパスは保持 (REMOVE_IF_TOUCHED だと罫線が根こそぎ消える)
//
// 黒/白の視覚的な塗りは従来通り renderer の overlay PNG が担う
// (black_boxes=false)。万一 PNG 側が欠けても領域の内容は既に存在しない
// ので情報漏洩にはならない (見た目に空白が出るだけ)。
//
// 保存は full save + garbage collect。incremental save は旧オブジェクトが
// ファイル末尾追記の形で残り、削除したはずの内容がフォレンジックで復元
// できてしまうため **絶対に使わない**。

import * as mupdf from "mupdf";

/**
 * source PDF バイト列の指定ページ・指定矩形に真の墨消しを適用する。
 *
 * @param {Uint8Array | Buffer} sourceBytes
 * @param {Array<{ sourceIdx: number,
 *                 rects: Array<{x:number,y:number,w:number,h:number}> }>}
 *   pageRedactions  fitz 空間 (top-left origin, pt。canonicalRectToFitz の
 *                   出力) の矩形群。sourceIdx は 0-based ページ index。
 * @returns {Uint8Array}  墨消し適用済み PDF バイト列
 * @throws 入力不正・mupdf 失敗時。呼び出し側 (exporter) は失敗したら
 *         従来の 900dpi ラスタ方式へフォールバックする。
 */
export function redactSourceBytes(sourceBytes, pageRedactions) {
  if (!sourceBytes || sourceBytes.length === 0) {
    throw new Error("redactSourceBytes: empty source");
  }
  if (!Array.isArray(pageRedactions) || pageRedactions.length === 0) {
    throw new Error("redactSourceBytes: no redactions");
  }
  const doc = mupdf.Document.openDocument(
    Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes),
    "application/pdf",
  );
  try {
    const pageCount = doc.countPages();
    for (const pr of pageRedactions) {
      if (!Number.isInteger(pr.sourceIdx) || pr.sourceIdx < 0 || pr.sourceIdx >= pageCount) {
        throw new Error(`redactSourceBytes: bad sourceIdx ${pr.sourceIdx} (pages=${pageCount})`);
      }
      if (!Array.isArray(pr.rects) || pr.rects.length === 0) {
        throw new Error(`redactSourceBytes: no rects for page ${pr.sourceIdx}`);
      }
      const page = doc.loadPage(pr.sourceIdx);
      for (const rc of pr.rects) {
        if (!(rc.w > 0) || !(rc.h > 0) || !Number.isFinite(rc.x) || !Number.isFinite(rc.y)) {
          throw new Error(`redactSourceBytes: bad rect on page ${pr.sourceIdx}`);
        }
        const annot = page.createAnnotation("Redact");
        annot.setRect([rc.x, rc.y, rc.x + rc.w, rc.y + rc.h]);
      }
      page.applyRedactions(
        false, // black_boxes: 塗りは overlay PNG が担当
        mupdf.PDFPage.REDACT_IMAGE_PIXELS,
        mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
        mupdf.PDFPage.REDACT_TEXT_REMOVE,
      );
    }
    // "garbage" で旧オブジェクトを物理的に破棄した full save (冒頭コメント
    // 参照 — incremental は情報漏洩になるため厳禁)。
    return doc.saveToBuffer("garbage").asUint8Array();
  } finally {
    try { doc.destroy(); } catch { /* wasm 側は GC 任せでも致命ではない */ }
  }
}
