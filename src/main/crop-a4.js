// A4 切り取り (ADR-0029) — 組み立て済み PDF の後処理。
//
// kpdf3:export-pdf-rasterized の payload に cropFrames が付いているとき、
// assembleHybridPdf の出力に対して「枠 1 つ = A4 縦 1 ページ」の差し替えを
// 行う。既存の組み立て経路 (_assembleHybridPdfOnce) には一切触らない。
//
// 座標の契約:
//   - 枠は canonical frame (intrinsic /Rotate + userRotation 適用後、
//     top-left 原点、pt) で渡される。UI (crop-a4.js renderer) と同じ空間。
//   - 組み立て出力の verbatim 高速パスは intrinsic /Rotate を持ったまま
//     ページを運ぶ (strategy source の sourceRot≠0/userRot=0、external の
//     extRot≠0 等)。そのため canonical 枠をそのまま content 座標に使うと
//     切り出し位置が回る。ここでは rotatedSourcePlacement (rotate-place.js
//     の実機検証済み規約) で /Rotate をベイクしながら A4 ページへ配置する。
//     canonical 寸法はページ自身の CropBox + /Rotate から再計算し、payload
//     とページの不整合が切り出し位置に波及しないようにする。
//   - 枠がページ外 (グレー背景) にはみ出した部分は A4 ページの境界で
//     切れて白余白になる (A4 未満ページの A4 化はこれで成立する)。

import { PDFDocument } from "pdf-lib";
import { rotatedSourcePlacement } from "./rotate-place.js";

export const A4_W = 595.28;
export const A4_H = 841.89;

/** cropFrames ({pageNo: [{x,y,w,h}]}) を Map<number, frames[]> に正規化。
 *  IPC/JSON 経由でキーが文字列化されていても受ける。不正な枠は捨てる。 */
export function normalizeCropFrames(cropFrames) {
  const map = new Map();
  if (!cropFrames || typeof cropFrames !== "object") return map;
  for (const [key, frames] of Object.entries(cropFrames)) {
    const pageNo = Number(key);
    if (!Number.isFinite(pageNo) || !Array.isArray(frames)) continue;
    const valid = frames.filter(
      (f) => f && Number.isFinite(f.x) && Number.isFinite(f.y),
    );
    if (valid.length > 0) map.set(pageNo, valid);
  }
  return map;
}

/**
 * addFlatOutlinesToPdf に渡す pageOrder をクロップ後のページ構成に展開する。
 * 枠 2 つ以上のページは先頭の枠ページにだけ pageNo を置き、残りは null で
 * 埋める — indexByPageNo は Map なので pageNo を重複して並べると「最後の
 * 枠」にしおりが乗ってしまう (先頭に乗せたい)。
 */
export function expandPageOrderForCrop(pages, cropFrames) {
  const map = normalizeCropFrames(cropFrames);
  const order = [];
  for (const p of pages) {
    const frames = map.get(p.pageNo);
    if (!frames || frames.length === 0) {
      order.push(p.pageNo);
    } else {
      order.push(p.pageNo);
      for (let k = 1; k < frames.length; k++) order.push(null);
    }
  }
  return order;
}

/**
 * 組み立て済み PDF (pages と 1:1 のページ順) の枠付きページを、枠ごとの
 * A4 縦ページに差し替える。枠の順序は renderer が送ってきた配列順
 * (UI 側で左→右・上→下に整列済み)。枠 0 件のページは素通し。
 *
 * @param {Uint8Array|Buffer} pdfBytes  assembleHybridPdf の出力
 * @param {Array<{pageNo:number}>} pages  組み立てに使った payload (順序が正)
 * @param {Object} cropFrames  {pageNo: [{x,y,w,h}]} canonical top-left pt
 * @returns {Promise<Uint8Array>}
 */
export async function applyCropFramesToPdf(pdfBytes, pages, cropFrames) {
  const map = normalizeCropFrames(cropFrames);
  if (map.size === 0) return pdfBytes;
  const doc = await PDFDocument.load(pdfBytes);
  if (doc.getPageCount() !== pages.length) {
    throw new Error(
      `applyCropFramesToPdf: page count mismatch (pdf=${doc.getPageCount()}, payload=${pages.length})`,
    );
  }
  // 後ろから処理する — 差し替えでページ数が変わっても手前の index が
  // ずれないように。
  for (let i = pages.length - 1; i >= 0; i--) {
    const frames = map.get(pages[i].pageNo);
    if (!frames || frames.length === 0) continue;
    const page = doc.getPage(i);
    const rot = ((Math.round((page.getRotation().angle ?? 0) / 90) * 90) % 360 + 360) % 360;
    const cb = page.getCropBox();
    // CropBox 原点が 0 でないページ (verbatim コピーされたスキャン等) も
    // bbox 指定の embedPage が (0,0) 起点に正規化してくれる。BBox は
    // ハードクリップにもなる (枠に映らない領域はどのみち A4 境界で切れる)。
    // pdf-lib は Contents の無いページ (完全な白紙) を embed できない —
    // しかも throw は embedPage() ではなく save() まで遅延するので、ここで
    // 事前に確認する。白紙を切っても白紙なので空の A4 ページに差し替える。
    let embedded = null;
    if (page.node.Contents()) {
      embedded = await doc.embedPage(page, {
        left: cb.x,
        bottom: cb.y,
        right: cb.x + cb.width,
        top: cb.y + cb.height,
      });
    } else {
      console.warn(`[crop-a4] page index ${i} has no Contents — 白紙 A4 として出力`);
    }
    // /Rotate をベイクして canonical 空間に置くための配置 (実機検証済みの
    // rotate-place.js 規約)。pageH = canonical 高さ (枠 y の上下反転に使う)。
    const { tx, ty, rotate, pageH } = rotatedSourcePlacement(
      rot, cb.width, cb.height,
    );
    frames.forEach((f, k) => {
      const fw = Number.isFinite(f.w) && f.w > 0 ? f.w : A4_W;
      const fh = Number.isFinite(f.h) && f.h > 0 ? f.h : A4_H;
      // canonical top-left 原点 → PDF y-up: 枠の左下点
      const fxPdf = f.x;
      const fyPdf = pageH - f.y - fh;
      const newPage = doc.insertPage(i + 1 + k, [fw, fh]);
      if (!embedded) return; // 白紙 fallback — 空の A4 ページのまま
      // 全面配置 (tx,ty) から枠の左下点ぶんを引く = canonical の枠領域が
      // 新ページの [0,fw]×[0,fh] に一致する。回転は draw 点の平行移動より
      // 先に効くので全 rot 共通でこの引き算だけでよい。
      newPage.drawPage(embedded, {
        x: tx - fxPdf,
        y: ty - fyPdf,
        width: embedded.width,
        height: embedded.height,
        rotate,
      });
    });
    doc.removePage(i);
  }
  return await doc.save();
}
