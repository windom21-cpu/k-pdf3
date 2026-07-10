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
 * Convert a canonical rect (userRotation 込みの見た目座標) to mupdf の
 * fitz 空間 (= userRotation を除き source /Rotate のみ適用した y-down
 * 描画空間)。mupdf の PDFAnnotation.setRect / structured text bbox と
 * 同じ空間であることは 2026-07-10 に /Rotate 0/90/180/270 の全回転で
 * 実測検証済 (真の墨消し v2 の redaction rect 変換に使用)。
 *
 * 実装は既存 2 変換の合成 (canonical → PDF native → userRotation=0 の
 * canonical)。cropX/cropY は往復で相殺されるので 0 のままでよい。
 *
 * @param {Rect} r    canonical { x, y, w, h }
 * @param {PageBox} page
 * @returns {Rect}    fitz 空間 { x, y, w, h } (top-left origin)
 */
export function canonicalRectToFitz(r, page) {
  const p = canonicalRectToPdf(r, page);
  return pdfRectToCanonical(
    [p.x, p.y, p.x + p.w, p.y + p.h],
    { ...page, userRotation: 0 },
  );
}

/**
 * Convert a PDF native rect ([x0, y0, x1, y1], bottom-left origin) to
 * canonical (top-left origin, post-rotation user view).
 *
 * Used by annotation read-only proxy: mupdf returns annotation /Rect in
 * PDF native coords; viewer needs canonical to position the marker.
 *
 * @param {[number, number, number, number]} pdfRect  [x0, y0, x1, y1]
 * @param {PageBox} page
 * @returns {Rect}  canonical { x, y, w, h }
 */
export function pdfRectToCanonical(pdfRect, page) {
  const [x0, y0, x1, y1] = pdfRect;
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x0, y: y1 },
    { x: x1, y: y1 },
  ];
  const c = corners.map((p) => pdfToCanonical(p, page));
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
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
 * Multiply two 2D affine matrices in [a, b, c, d, e, f] form.
 *
 *   result = b ∘ a   — semantically: apply `a` first, then `b`.
 *
 * Each matrix represents
 *
 *   ⎡a c e⎤
 *   ⎢b d f⎥
 *   ⎣0 0 1⎦
 *
 * applied to a column vector (x, y, 1).
 *
 * @param {number[]} b
 * @param {number[]} a
 * @returns {number[]}
 */
export function multiplyMatrix(b, a) {
  const [a0, b0, c0, d0, e0, f0] = b;
  const [a1, b1, c1, d1, e1, f1] = a;
  return [
    a0 * a1 + c0 * b1,
    b0 * a1 + d0 * b1,
    a0 * c1 + c0 * d1,
    b0 * c1 + d0 * d1,
    a0 * e1 + c0 * f1 + e0,
    b0 * e1 + d0 * f1 + f0,
  ];
}

/**
 * Invert a 2D affine matrix in [a, b, c, d, e, f] form.
 * Throws if the linear part is singular (det ≈ 0).
 *
 * @param {number[]} m
 * @returns {number[]}
 */
export function inverseMatrix(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) {
    throw new Error("inverseMatrix: matrix is singular");
  }
  const inv = 1 / det;
  return [
    d * inv,
    -b * inv,
    -c * inv,
    a * inv,
    (c * f - d * e) * inv,
    (b * e - a * f) * inv,
  ];
}

/**
 * Uniform / non-uniform scale matrix.
 * @param {number} zx
 * @param {number} [zy=zx]
 * @returns {number[]}
 */
export function scaleMatrix(zx, zy = zx) {
  return [zx, 0, 0, zy, 0, 0];
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
