// Backend wrapper around mupdf structured text extraction.
//
// Raw mupdf access only (same gateway rule as mupdf-render.js). ページの
// 埋め込みテキスト — OCR 済みスキャン PDF の「透明テキスト層」を含む —
// を行単位の box に平坦化して返す。
//
// 座標は fitz 空間 (intrinsic /Rotate 適用後、page bounds 左上原点・y 下向き)。
// これは viewer が renderPagePixels で得る pixmap と同一の空間なので、
// 呼び出し側は ×zoom するだけで描画済み canvas に重ねられる (userRotation
// は viewer 側の責務 — canvas と同じ回転を適用する)。

/**
 * @typedef {object} PageTextLine
 * @property {number} x        行 bbox 左上 x (pt、page bounds 原点)
 * @property {number} y        行 bbox 左上 y (pt)
 * @property {number} w        行 bbox 幅 (pt)
 * @property {number} h        行 bbox 高さ (pt)
 * @property {string} text     行テキスト
 * @property {number} size     代表フォントサイズ (pt)
 * @property {0|1} wmode       0 = 横書き, 1 = 縦書き
 */

/**
 * Extract per-line text boxes from one page.
 *
 * テキストを持たないページ (未 OCR のスキャン等) は lines が空で返る —
 * エラーにはしない。呼び出し側はそのまま「選択できるものがない」表示に使う。
 *
 * @param {import("mupdf").Document} doc
 * @param {number} pageIndex 0-based
 * @returns {{ w: number, h: number, lines: PageTextLine[] }}
 */
export function extractPageTextLines(doc, pageIndex) {
  const page = doc.loadPage(pageIndex);
  try {
    const [x0, y0, x1, y1] = page.getBounds();
    const st = page.toStructuredText("preserve-whitespace");
    let json;
    try {
      json = JSON.parse(st.asJSON());
    } finally {
      st.destroy();
    }
    const lines = [];
    for (const block of json.blocks ?? []) {
      if (block.type !== "text") continue;
      for (const line of block.lines ?? []) {
        const text = line.text ?? "";
        if (!text.trim()) continue;
        const bbox = line.bbox ?? {};
        const w = bbox.w ?? 0;
        const h = bbox.h ?? 0;
        if (w <= 0 || h <= 0) continue;
        lines.push({
          x: (bbox.x ?? 0) - x0,
          y: (bbox.y ?? 0) - y0,
          w,
          h,
          text,
          size: line.font?.size ?? h,
          wmode: line.wmode === 1 ? 1 : 0,
        });
      }
    }
    return { w: x1 - x0, h: y1 - y0, lines };
  } finally {
    page.destroy();
  }
}
