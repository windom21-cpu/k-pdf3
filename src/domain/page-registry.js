// In-memory page index for the viewer.
//
//   - Pre-computes canonical (post-rotation) dimensions for each page.
//   - Computes a vertical-stack document layout at a given zoom factor.
//   - O(log N) "which pages overlap the viewport [scrollY, scrollY + viewportH]"
//     via binary search on cumulative offsets.
//
// Pure domain layer: knows nothing about DOM, Canvas, mupdf, or SQLite.
// Built from a plain array of page rows (e.g. workspace.getPages()).

import { canonicalPageSize } from "./coord.js";

/** @typedef {import("./coord.js").PageBox} PageBox */

/**
 * @typedef {object} PageEntry
 * @property {number} pageNo                  1-based
 * @property {number} canonicalW              post-rotation width  in PDF points
 * @property {number} canonicalH              post-rotation height in PDF points
 */

/**
 * @typedef {object} DocumentLayout
 * @property {number} zoom
 * @property {number} gap                     vertical spacing between pages, px
 * @property {number} totalHeight             scrollable height, px
 * @property {number} maxWidth                widest page, px (renderer can center on this)
 * @property {Float64Array} pageTops          length = N. pageTops[i] = top y-coord of page (i+1) in px
 * @property {Float64Array} pageHeights       length = N
 * @property {Float64Array} pageWidths        length = N
 */

/**
 * @typedef {object} PageRow
 * Subset of a workspace page row needed by the registry.
 * (Comes from `workspace.getPages()` / the SQLite `pages` table.)
 * @property {number} pageNo
 * @property {number} cropW
 * @property {number} cropH
 * @property {0|90|180|270} rotation
 * @property {0|90|180|270} [userRotation]
 */

export class PageRegistry {
  /**
   * @param {PageRow[]} pages
   */
  constructor(pages) {
    /** @type {PageEntry[]} */
    this.entries = [];
    /** @type {Map<number, number>} pageNo → position index */
    this.pageNoToPos = new Map();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const { w, h } = canonicalPageSize({
        mediaX: 0,
        mediaY: 0,
        mediaW: 0,
        mediaH: 0,
        cropX: 0,
        cropY: 0,
        cropW: p.cropW,
        cropH: p.cropH,
        rotation: p.rotation,
        userRotation: p.userRotation ?? 0,
      });
      this.entries.push({
        pageNo: p.pageNo,
        canonicalW: w,
        canonicalH: h,
      });
      this.pageNoToPos.set(p.pageNo, i);
    }
  }

  /** Number of pages. */
  count() {
    return this.entries.length;
  }

  /** Position (0-based) → pageNo (1-based, possibly sparse). */
  pageNoAtPos(pos) {
    const e = this.entries[pos];
    return e ? e.pageNo : 0;
  }

  /** pageNo → position (0-based) in the visible list, or -1 if hidden. */
  posOfPageNo(pageNo) {
    return this.pageNoToPos.get(pageNo) ?? -1;
  }

  /**
   * Canonical (post-rotation) page size in PDF points. Looks up by
   * pageNo (sparse-safe — pageNo is the source PDF's number, not the
   * position in the visible list).
   * @param {number} pageNo  1-based
   * @returns {{ w: number, h: number }}
   */
  getCanonicalSize(pageNo) {
    const pos = this.pageNoToPos.get(pageNo);
    if (pos === undefined) throw new RangeError(`pageNo out of range: ${pageNo}`);
    const entry = this.entries[pos];
    return { w: entry.canonicalW, h: entry.canonicalH };
  }

  /**
   * Compute the document layout for vertical scrolling at the given zoom.
   *
   * zoom = 1.0 means 1 PDF point = 1 px (a 72-dpi-equivalent Canvas).
   * gap  = vertical spacing between consecutive pages, in CSS px.
   *
   * @param {{ zoom: number, gap?: number }} opts
   * @returns {DocumentLayout}
   */
  layout(opts) {
    const zoom = opts.zoom;
    const gap = opts.gap ?? 8;
    const N = this.entries.length;
    const pageTops = new Float64Array(N);
    const pageHeights = new Float64Array(N);
    const pageWidths = new Float64Array(N);
    let y = 0;
    let maxWidth = 0;
    for (let i = 0; i < N; i++) {
      const e = this.entries[i];
      const w = e.canonicalW * zoom;
      const h = e.canonicalH * zoom;
      pageTops[i] = y;
      pageWidths[i] = w;
      pageHeights[i] = h;
      if (w > maxWidth) maxWidth = w;
      y += h;
      if (i < N - 1) y += gap;
    }
    return {
      zoom,
      gap,
      totalHeight: y,
      maxWidth,
      pageTops,
      pageHeights,
      pageWidths,
    };
  }
}

/**
 * Pages whose vertical extent intersects [scrollY, scrollY + viewportH].
 *
 * Returns 1-based inclusive [first, last]. When nothing is visible
 * (empty document, zero-height viewport, or scroll past the end),
 * returns `{ first: 0, last: -1 }`.
 *
 * Binary-search based — O(log N) per call.
 *
 * @param {DocumentLayout} layout
 * @param {number} scrollY
 * @param {number} viewportH
 * @returns {{ first: number, last: number }}
 */
export function visiblePageRange(layout, scrollY, viewportH) {
  const N = layout.pageTops.length;
  if (N === 0 || viewportH <= 0) return { first: 0, last: -1 };

  const top = scrollY;
  const bot = scrollY + viewportH;

  // First page whose bottom edge > top of viewport
  let lo = 0;
  let hi = N - 1;
  let first = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const pageBot = layout.pageTops[mid] + layout.pageHeights[mid];
    if (pageBot > top) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (first === -1) return { first: 0, last: -1 };
  // The candidate's bottom is past the viewport top, but it may still start
  // entirely below the viewport (e.g. viewport sits within a gap). Verify.
  if (layout.pageTops[first] >= bot) return { first: 0, last: -1 };

  // Last page whose top edge < bottom of viewport
  lo = first;
  hi = N - 1;
  let last = first;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (layout.pageTops[mid] < bot) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { first: first + 1, last: last + 1 };
}

/**
 * 「現在ページ」判定 (v2.0.27-beta.1)。
 *
 * viewport 上端から `viewportH × probeRatio` だけ下の点 (probe) を含む
 * ページの 0-based position を返す。旧規則「viewport 最上端に掛かっている
 * ページ」(= `visiblePageRange().first`) は probeRatio = 0 と等価。
 * 1/3 等にすると「前ページの尻尾が画面上 1/3 より上に消えた時点で次ページ」
 * になり、次ページの本文を読み始めている状態で前ページが current のまま
 * (しおり・回転が 1 つ前に乗る) という体感ずれを減らせる。
 *
 * 両端は probe に関係なく明示規則 (v2.0.27-beta.2):
 * - 文書先頭が見えている (scrollY ≤ 0) → 1 ページ目。先頭ページが
 *   viewport × probeRatio より低い縮小表示で、先頭なのに 2 ページ目が
 *   current になるのを防ぐ
 * - 文書末尾が viewport 内 (scrollY + viewportH ≥ totalHeight) → 最終ページ
 *   (viewport に掛かっている限り)。最下部 clamp では最終ページ下端が
 *   viewport 下端に張り付くため、最終ページの高さが viewport × (1 −
 *   probeRatio) 未満だと probe が前ページに落ち、「末尾まで表示しても
 *   最終ページにならない」(β1 実機報告) — これ以上スクロールできない
 *   以上、末尾が見えていれば最終ページを見ているとみなす
 * それ以外:
 * - probe がページ間の隙間にあれば次のページ (旧規則と同じ)
 * - 空文書 / viewport が文書の外は -1 — 呼び手は current を据え置く
 *
 * probeRatio = 0 は両端規則を除き旧規則と等価 (両端では旧規則の答えと
 * 一致するか、より直感に合う側に倒れる)。
 *
 * @param {DocumentLayout} layout
 * @param {number} scrollY
 * @param {number} viewportH
 * @param {number} [probeRatio=0] 0..1
 * @returns {number} 0-based position or -1
 */
export function currentPagePos(layout, scrollY, viewportH, probeRatio = 0) {
  const N = layout.pageTops.length;
  if (N === 0) return -1;
  const vh = Math.max(0, viewportH);
  const last = N - 1;
  // 文書先頭が見えている → 1 ページ目 (両端規則、上記)。
  if (scrollY <= 0) return 0;
  // 文書末尾が viewport 内 → 最終ページ (viewport に掛かっている限り)。
  const lastTop = layout.pageTops[last];
  const lastBot = lastTop + layout.pageHeights[last];
  if (scrollY + vh >= layout.totalHeight && lastTop < scrollY + vh && lastBot > scrollY) {
    return last;
  }
  const probe = scrollY + vh * probeRatio;
  // First page whose bottom edge > probe (binary search, same shape as
  // visiblePageRange so the cost stays O(log N) for 400-page documents).
  let lo = 0;
  let hi = N - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const pageBot = layout.pageTops[mid] + layout.pageHeights[mid];
    if (pageBot > probe) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (found >= 0) return found;
  // probe is below every page (末尾規則に掛からなかった = 最終ページが
  // viewport に掛かっていない): adopt the last page only if it intersects
  // the viewport, else -1.
  if (lastTop < scrollY + vh && lastBot > scrollY) return last;
  return -1;
}
