// Render service: orchestrates canonical-oriented page rendering by
// composing the canonical-coord transform from `domain/coord.js` with the
// mupdf wrapper from `backend/mupdf-render.js`.
//
// Lives in main/ because it's the bridge between domain math and the
// mupdf-held Document handle. Renderer process talks to it via IPC.

import { scaleMatrix } from "../domain/coord.js";
import { renderPagePixels } from "../backend/mupdf-render.js";

/**
 * @typedef {object} PageRow
 * Subset of a workspace page row needed for rendering.
 *
 * @property {number} pageNo                  1-based
 * @property {number} mediaX
 * @property {number} mediaY
 * @property {number} mediaW
 * @property {number} mediaH
 * @property {number} cropX
 * @property {number} cropY
 * @property {number} cropW
 * @property {number} cropH
 * @property {0|90|180|270} rotation
 * @property {0|90|180|270} [userRotation]
 */

/**
 * Render `pageRow` from `doc` into a canonical-oriented RGBA pixel buffer.
 *
 * mupdf already applies the PDF's /Rotate value when rendering — `Page.toPixmap`
 * receives "post-rotation" page bounds. So the right matrix to feed mupdf for a
 * canonical-oriented render is just a uniform scale:
 *
 *   pixmap_dim ≈ zoom × canonicalPageSize(page).{w,h}
 *
 * The userRotation field in `pageRow` is *not* applied here yet — mupdf renders
 * the PDF's intrinsic rotation only. M3 will introduce a renderer-side rotation
 * post-pass for user-applied rotation deltas.
 *
 * Cropbox-shifted PDFs (cropbox ≠ mediabox) currently render the full mediabox;
 * cropbox-aware clipping is a known limitation (see HANDOVER §15) and lands
 * with the export pipeline in M4.
 *
 * @param {import("mupdf").Document} doc
 * @param {PageRow} pageRow
 * @param {{ zoom: number, alpha?: boolean }} opts
 * @returns {{ width: number, height: number, channels: 3|4, pixels: Uint8ClampedArray }}
 */
export function renderPageCanonical(doc, pageRow, opts) {
  const matrix = scaleMatrix(opts.zoom);
  return renderPagePixels(doc, pageRow.pageNo - 1, matrix, {
    alpha: opts.alpha ?? true,
  });
}
