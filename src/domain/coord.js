// K-PDF3 canonical coordinate system
//
// ADR-0003: PDF point (72dpi) / top-left origin / rotation 適用後 / 紙アナロジー
//
// This module is the ONLY place where canonical ↔ PDF native conversion happens.
// Domain layer (overlays, store, history) stores ONLY canonical coordinates.

/**
 * @typedef {object} PageBox
 * @property {number} mediaX
 * @property {number} mediaY
 * @property {number} mediaW
 * @property {number} mediaH
 * @property {number} cropX
 * @property {number} cropY
 * @property {number} cropW
 * @property {number} cropH
 * @property {0|90|180|270} rotation       PDF native rotation
 * @property {0|90|180|270} userRotation   User-applied additional rotation
 */

/**
 * @typedef {object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * Total effective rotation = (PDF rotation + user rotation) mod 360
 * @param {PageBox} page
 * @returns {0|90|180|270}
 */
export function effectiveRotation(page) {
  return /** @type {0|90|180|270} */ (((page.rotation + page.userRotation) % 360 + 360) % 360);
}

/**
 * Logical (canonical) page size after rotation is applied.
 * "What the user sees" — width and height swap when rotated 90/270.
 *
 * @param {PageBox} page
 * @returns {{ w: number, h: number }}
 */
export function canonicalPageSize(page) {
  const rot = effectiveRotation(page);
  if (rot === 90 || rot === 270) {
    return { w: page.cropH, h: page.cropW };
  }
  return { w: page.cropW, h: page.cropH };
}

/**
 * Convert a point from canonical (top-left, post-rotation) to PDF native (bottom-left, pre-rotation).
 *
 * @param {Point} p   point in canonical coordinates
 * @param {PageBox} page
 * @returns {Point}   point in PDF native coordinates (bottom-left origin)
 */
export function canonicalToPdf(p, page) {
  const rot = effectiveRotation(page);
  const W = page.cropW; // PDF native cropbox width
  const H = page.cropH; // PDF native cropbox height

  // Step 1: rotate canonical → "PDF native local" (top-left origin within cropbox).
  // canonical = user view post-rotation; to undo, rotate by -rot.
  // PDF native top-left local: nx in [0, W], ny in [0, H], top-left origin.
  let nx, ny;
  switch (rot) {
    case 0:
      nx = p.x;
      ny = p.y;
      break;
    case 90:
      // canonical (0, 0) corresponds to native top-right: (W, 0)
      // canonical x-axis runs along native -y; canonical y-axis runs along native +x
      nx = W - p.y;
      ny = p.x;
      break;
    case 180:
      // canonical (0, 0) → native bottom-right (W, H)
      nx = W - p.x;
      ny = H - p.y;
      break;
    case 270:
      // canonical (0, 0) → native bottom-left (0, H)
      nx = p.y;
      ny = H - p.x;
      break;
    default:
      throw new Error(`Invalid rotation: ${rot}`);
  }

  // Step 2: top-left local → PDF native (bottom-left origin, mediabox absolute)
  return {
    x: page.cropX + nx,
    y: page.cropY + (H - ny),
  };
}

/**
 * Convert a point from PDF native to canonical.
 * Inverse of canonicalToPdf.
 *
 * @param {Point} p   point in PDF native coordinates
 * @param {PageBox} page
 * @returns {Point}   canonical point
 */
export function pdfToCanonical(p, page) {
  const rot = effectiveRotation(page);
  const W = page.cropW;
  const H = page.cropH;

  // Step 1: PDF native (bottom-left, absolute) → top-left local within cropbox
  const nx = p.x - page.cropX;
  const ny = H - (p.y - page.cropY);

  // Step 2: native top-left local → canonical (rotate by +rot)
  switch (rot) {
    case 0:
      return { x: nx, y: ny };
    case 90:
      // forward: nx = W - cy, ny = cx → cx = ny, cy = W - nx
      return { x: ny, y: W - nx };
    case 180:
      // forward: nx = W - cx, ny = H - cy → cx = W - nx, cy = H - ny
      return { x: W - nx, y: H - ny };
    case 270:
      // forward: nx = cy, ny = H - cx → cx = H - ny, cy = nx
      return { x: H - ny, y: nx };
    default:
      throw new Error(`Invalid rotation: ${rot}`);
  }
}

/**
 * Convert a rect from canonical to PDF native.
 * Note: rotation may swap width/height visually, but the rect's "logical w/h"
 * in canonical refers to the post-rotation user view.
 *
 * @param {Rect} r
 * @param {PageBox} page
 * @returns {Rect}  in PDF native; x/y is bottom-left
 */
export function canonicalRectToPdf(r, page) {
  const rot = effectiveRotation(page);
  // Compute the four corners in canonical, transform each, then take bbox.
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x, y: r.y + r.h },
    { x: r.x + r.w, y: r.y + r.h },
  ];
  const pdfCorners = corners.map((c) => canonicalToPdf(c, page));
  const xs = pdfCorners.map((c) => c.x);
  const ys = pdfCorners.map((c) => c.y);
  void rot;
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * Page dimension after effective rotation, with rotation transform that maps
 * canonical (top-left) to PDF native (bottom-left).
 *
 * Useful when a renderer (e.g. mupdf) wants a 6-element matrix.
 *
 * @param {PageBox} page
 * @returns {[number, number, number, number, number, number]} affine matrix (a, b, c, d, e, f)
 */
export function canonicalToPdfMatrix(page) {
  const rot = effectiveRotation(page);
  const W = page.cropW;
  const H = page.cropH;
  const cx = page.cropX;
  const cy = page.cropY;
  // Derive each rotation symbolically from canonicalToPdf.
  switch (rot) {
    case 0:
      // pdfX = cx + p.x;  pdfY = cy + (H - p.y) = cy + H - p.y
      // a=1, b=0, c=0, d=-1, e=cx, f=cy+H
      return [1, 0, 0, -1, cx, cy + H];
    case 90:
      // nx = W - p.y, ny = p.x
      // pdfX = cx + (W - p.y);  pdfY = cy + (H - p.x)
      // pdfX = -p.y + (cx + W); pdfY = -p.x + (cy + H)
      // a=0, b=-1, c=-1, d=0, e=cx+W, f=cy+H
      return [0, -1, -1, 0, cx + W, cy + H];
    case 180:
      // nx = W - p.x, ny = H - p.y
      // pdfX = cx + W - p.x;  pdfY = cy + (H - (H - p.y)) = cy + p.y
      // a=-1, b=0, c=0, d=1, e=cx+W, f=cy
      return [-1, 0, 0, 1, cx + W, cy];
    case 270:
      // nx = p.y, ny = H - p.x
      // pdfX = cx + p.y;  pdfY = cy + (H - (H - p.x)) = cy + p.x
      // a=0, b=1, c=1, d=0, e=cx, f=cy
      return [0, 1, 1, 0, cx, cy];
    default:
      throw new Error(`Invalid rotation: ${rot}`);
  }
}

/**
 * Build a default PageBox where mediabox == cropbox starting at (0, 0).
 * Convenience helper for tests / simple PDFs.
 */
export function simplePage(w, h, rotation = 0, userRotation = 0) {
  return {
    mediaX: 0,
    mediaY: 0,
    mediaW: w,
    mediaH: h,
    cropX: 0,
    cropY: 0,
    cropW: w,
    cropH: h,
    rotation,
    userRotation,
  };
}
