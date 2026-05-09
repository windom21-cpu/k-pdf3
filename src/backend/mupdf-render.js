// Backend wrapper around mupdf.js for page rendering.
//
// Raw mupdf access only. No domain knowledge — the caller passes in the
// PDF→pixmap transform matrix already computed (typically via the
// canonical coordinate helpers in domain/coord.js).
//
// Domain layer must NOT import this directly. Render layer is the gateway.

import * as mupdf from "mupdf";

/**
 * @typedef {object} RenderResult
 * @property {number} width                pixmap width in pixels
 * @property {number} height               pixmap height in pixels
 * @property {3|4} channels                3 = RGB, 4 = RGBA
 * @property {Uint8ClampedArray} pixels    tightly packed row-major bytes
 */

/**
 * Render a single PDF page to a raw pixel buffer.
 *
 * The `matrix` argument is in mupdf's standard 6-element form [a, b, c, d, e, f]
 * mapping PDF native coordinates to pixmap pixel coordinates:
 *
 *     pixmap.x = a * pdf.x + c * pdf.y + e
 *     pixmap.y = b * pdf.x + d * pdf.y + f
 *
 * Caller is responsible for computing this matrix. For canonical-oriented
 * viewer rendering at zoom Z, the construction is:
 *
 *     inverse(coord.canonicalToPdfMatrix(page)) ∘ scale(Z, Z)
 *
 * Page and Pixmap handles are destroyed before this function returns; only
 * `doc` remains caller-owned.
 *
 * @param {mupdf.Document} doc
 * @param {number} pageIndex            0-based
 * @param {number[]} matrix             6-element [a,b,c,d,e,f]
 * @param {object} [opts]
 * @param {boolean} [opts.alpha=true]   include alpha → RGBA; otherwise RGB
 * @returns {RenderResult}
 */
export function renderPagePixels(doc, pageIndex, matrix, opts = {}) {
  const { alpha = true } = opts;
  const page = doc.loadPage(pageIndex);
  let pixmap;
  try {
    pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, alpha, false);
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const stride = pixmap.getStride();
    const channels = alpha ? 4 : 3;
    const src = pixmap.getPixels();
    const rowBytes = width * channels;
    if (stride === rowBytes) {
      // Tightly packed already; copy to detach from mupdf's internal buffer.
      return { width, height, channels, pixels: new Uint8ClampedArray(src) };
    }
    // Strided — repack row-by-row.
    const out = new Uint8ClampedArray(width * height * channels);
    for (let y = 0; y < height; y++) {
      out.set(src.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
    }
    return { width, height, channels, pixels: out };
  } finally {
    pixmap?.destroy?.();
    page.destroy();
  }
}

/**
 * Open a PDF document from byte data. Caller must call `.destroy()` when done.
 *
 * Convenience over `mupdf.Document.openDocument(buf, "application/pdf")` so
 * the mime hint isn't repeated at call sites.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} data
 * @returns {mupdf.Document}
 */
export function openPdfDocument(data) {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  return mupdf.Document.openDocument(buf, "application/pdf");
}
