// Rotated-source placement geometry for assembleHybridPdf / _extractPages.
//
// Overlays are authored in canonical coordinates (top-left origin, *after*
// the effective rotation the user sees). The viewer applies the page's
// rotation CLOCKWISE in two stages that simply add up:
//   - source /Rotate : mupdf renders the page raster already rotated (PDF
//                      /Rotate is clockwise by spec)
//   - userRotation   : the viewer canvas applies ctx.rotate(userRot), which
//                      is clockwise in the y-down canvas space
// so the orientation the user sees == native content rotated CLOCKWISE by
//   effRot = (source /Rotate + userRotation) mod 360.
//
// pdf-lib (and the export/print assembler) draw in PDF user space (y-up),
// where rotate() is COUNTER-clockwise. To reproduce the clockwise view we
// must rotate by degrees(-effRot) and translate so the rotated native box
// lands back in [0, canonicalW] × [0, canonicalH].
//
// History: the previous assembler rotated by degrees(+userRot) and ignored
// the source /Rotate entirely. That double-bug printed overlays on rotated
// source pages 天地さかさま (180° for /Rotate=180; 90°-wrong for 90/270) and
// also placed user-rotated 90/270 pages 180° off from the viewer. Verified
// against mupdf rendering for all four rotations.

import { degrees } from "pdf-lib";

/**
 * Placement params to draw a NATIVE-oriented source page (W×H, before any
 * /Rotate) into a canonical /Rotate=0 page rotated clockwise by `effRot`.
 *
 * @param {number} effRot  (source /Rotate + userRotation) — any multiple of 90
 * @param {number} W  native page width  (cropW)
 * @param {number} H  native page height (cropH)
 * @returns {{ tx:number, ty:number, rotate:import("pdf-lib").Rotation,
 *             pageW:number, pageH:number }}
 *   tx/ty: lower-left placement point for page.drawPage
 *   rotate: pass straight to page.drawPage({ rotate })
 *   pageW/pageH: canonical (post-rotation) page dimensions
 */
export function rotatedSourcePlacement(effRot, W, H) {
  const r = ((Math.round(effRot / 90) * 90) % 360 + 360) % 360;
  if (r === 90) return { tx: 0, ty: W, rotate: degrees(-90), pageW: H, pageH: W };
  if (r === 180) return { tx: W, ty: H, rotate: degrees(-180), pageW: W, pageH: H };
  if (r === 270) return { tx: H, ty: 0, rotate: degrees(-270), pageW: H, pageH: W };
  return { tx: 0, ty: 0, rotate: degrees(0), pageW: W, pageH: H };
}
