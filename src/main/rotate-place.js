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
/**
 * overlay / external 戦略で「元ページを verbatim に copyPages して、その上に
 * overlay PNG を canonical 座標で描く」高速パスが使えるか。
 *
 * 使えるのは **intrinsic /Rotate も userRotation も 0** のときだけ:
 *   - copyPages はページの /Rotate をそのまま持って行くので、コピー後の見た目は
 *     native を sourceRot だけ回した向きになる。ユーザーが見ている向きは
 *     effRot = sourceRot + userRot なので、両者が一致するのは userRot === 0 のとき。
 *   - overlay は canonical 座標 (= effRot 適用後) で描かれるが、drawImage は
 *     ページの **content 座標** (= /Rotate 適用前) に置くので、canonical と content が
 *     一致する = sourceRot === 0 でなければ overlay が回ってしまう。
 *
 * 2026-07-14 のバグ: 条件が `effRot === 0` だけだったため、**sourceRot と userRot が
 * 打ち消し合うケース (例: intrinsic /Rotate=90 のページをユーザーが 270° 回して画面で
 * 縦にした) で verbatim copy に落ちていた**。出力ページは /Rotate=90 を持ったままなので、
 * 画面では縦なのに保存/印刷した PDF だけ横向き・幅高さが入れ替わり (A3 が A3 でなくなる)、
 * overlay も content 座標に置かれてズレる。sourceRot=180 & userRot=180 のケースは
 * 「A3 が天地さかさま」として出る。effRot === 0 でも sourceRot !== 0 なら
 * rotatedSourcePlacement(effRot=0) 経由でベイクする (embedPdf は /Rotate を無視して
 * native content を描くので、出力は /Rotate=0 の canonical ページになる)。
 *
 * @param {number} sourceRot 元ページの intrinsic /Rotate
 * @param {number} userRot   ユーザー回転
 */
export function verbatimOverlayCopyEligible(sourceRot, userRot) {
  const norm = (d) => (((Math.round((d ?? 0) / 90) * 90) % 360) + 360) % 360;
  return norm(sourceRot) === 0 && norm(userRot) === 0;
}

export function rotatedSourcePlacement(effRot, W, H) {
  const r = ((Math.round(effRot / 90) * 90) % 360 + 360) % 360;
  if (r === 90) return { tx: 0, ty: W, rotate: degrees(-90), pageW: H, pageH: W };
  if (r === 180) return { tx: W, ty: H, rotate: degrees(-180), pageW: W, pageH: H };
  if (r === 270) return { tx: H, ty: 0, rotate: degrees(-270), pageW: H, pageH: W };
  return { tx: 0, ty: 0, rotate: degrees(0), pageW: W, pageH: H };
}
