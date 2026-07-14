// Regression: overlays on a rotated source page must NOT print 天地さかさま.
//
// Bug (pre-fix): assembleHybridPdf only compensated userRotation and ignored
// the source /Rotate, drawing the overlay in the page's native (pre-/Rotate)
// space. A /Rotate=180 source then flipped the overlay 180° at print time —
// a safety-critical fault for filled legal forms. The CCW translation table
// also placed user-rotated 90/270 pages 180° off from the viewer.
//
// This test reproduces the FIXED placement (src/main/rotate-place.js) and
// renders the result with mupdf (which applies /Rotate clockwise, exactly as
// Adobe does at print time). For every source rotation it asserts:
//   - the overlay marker lands where the user authored it (canonical TOP-LEFT)
//   - the baked source content matches the source-rendered-alone reference
//
// mupdf is WASM (no native ABI), so this runs under plain `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { canonicalPageSize } from "../src/domain/coord.js";
import {
  rotatedSourcePlacement,
  verbatimOverlayCopyEligible,
} from "../src/main/rotate-place.js";
import { renderPagePixels, openPdfDocument } from "../src/backend/mupdf-render.js";

const W = 595, H = 842; // native A4 portrait

function quadrantOf(p, width, height) {
  if (!p) return "(none)";
  return `${p.y < height / 2 ? "TOP" : "BOTTOM"}-${p.x < width / 2 ? "LEFT" : "RIGHT"}`;
}

// Render `bytes` and return the centroid quadrant of the RED (overlay) and
// BLUE (source marker) regions.
function markers(bytes) {
  const doc = openPdfDocument(Buffer.from(bytes));
  try {
    const r = renderPagePixels(doc, 0, [1, 0, 0, 1, 0, 0]);
    const { width, height, channels, pixels } = r;
    let rx = 0, ry = 0, rn = 0, bx = 0, by = 0, bn = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        const R = pixels[i], G = pixels[i + 1], B = pixels[i + 2];
        if (R > 180 && G < 80 && B < 80) { rx += x; ry += y; rn++; }
        if (B > 180 && R < 80 && G < 80) { bx += x; by += y; bn++; }
      }
    }
    return {
      red: quadrantOf(rn ? { x: rx / rn, y: ry / rn } : null, width, height),
      blue: quadrantOf(bn ? { x: bx / bn, y: by / bn } : null, width, height),
    };
  } finally {
    doc.destroy();
  }
}

// Source page carrying /Rotate=rot and a BLUE marker in the native bottom-left.
async function buildSource(rot) {
  const doc = await PDFDocument.create();
  const p = doc.addPage([W, H]);
  p.setRotation(degrees(rot));
  p.drawRectangle({ x: 40, y: 30, width: 110, height: 40, color: rgb(0, 0, 1) });
  return await doc.save();
}

// Overlay authored at canonical TOP-LEFT (top-left origin), as the renderer
// would emit it. Modelled here as a RED rectangle drawn after the source.
const overlay = { x: 40, y: 40, w: 110, h: 40 };

// Mirror assembleHybridPdf's rotated overlay/external path using the shared
// production helper, so the test guards the real geometry.
async function assembleRotated(sourceBytes, effRot) {
  const newPdf = await PDFDocument.create();
  const [embedded] = await newPdf.embedPdf(await PDFDocument.load(sourceBytes), [0]);
  const { tx, ty, rotate, pageW, pageH } = rotatedSourcePlacement(
    effRot, embedded.width, embedded.height,
  );
  const page = newPdf.addPage([pageW, pageH]);
  page.drawPage(embedded, { x: tx, y: ty, width: embedded.width, height: embedded.height, rotate });
  // overlay drawn in canonical coords with the top-left→bottom-left Y flip
  page.drawRectangle({
    x: overlay.x, y: pageH - overlay.y - overlay.h,
    width: overlay.w, height: overlay.h, color: rgb(1, 0, 0),
  });
  return await newPdf.save();
}

for (const rot of [0, 90, 180, 270]) {
  test(`overlay stays upright on /Rotate=${rot} source (no 天地さかさま)`, async () => {
    const src = await buildSource(rot);
    const reference = markers(src);             // source alone == canonical reference
    const assembled = markers(await assembleRotated(src, rot)); // userRot=0 ⇒ effRot=rot

    // The overlay must land where the user placed it: canonical TOP-LEFT.
    assert.equal(
      assembled.red, "TOP-LEFT",
      `overlay flipped on /Rotate=${rot}: got ${assembled.red}`,
    );
    // The baked source content must match how the source renders on its own.
    assert.equal(
      assembled.blue, reference.blue,
      `source content rotated wrong on /Rotate=${rot}: got ${assembled.blue}, expected ${reference.blue}`,
    );
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 2026-07-14: 経路選択そのものの総当たり回帰。
//
// 上のテストはベイク経路の幾何しか守っておらず、assembleHybridPdf が
// 「verbatim copyPages」と「ベイク」のどちらを選ぶかは無防備だった。条件が
// `effRot === 0` だったため、sourceRot と userRot が**打ち消し合う**
// (例: intrinsic /Rotate=90 のページをユーザーが 270° 回して画面で縦にした)
// と verbatim copy に落ち、出力ページが /Rotate=90 を持ったまま = 画面は縦
// なのに保存 PDF だけ横向き・幅高さが入れ替わって A3 が見切れる、という
// ユーザー報告 (Mac で確認) になった。sourceRot=180 & userRot=180 は
// 「A3 が天地さかさま」として出る。
//
// ここでは 4×4 の (sourceRot, userRot) 全組合せで overlay 戦略の実経路を
// 再現し、**出力 PDF が実際に表示される寸法と向き**を mupdf で検証する。
// ───────────────────────────────────────────────────────────────────────────

/** mupdf が実際に表示するページ寸法 (= /Rotate 適用後)。 */
function displayedSize(bytes) {
  const doc = openPdfDocument(Buffer.from(bytes));
  try {
    const b = doc.loadPage(0).getBounds();
    return { w: Math.round(b[2] - b[0]), h: Math.round(b[3] - b[1]) };
  } finally {
    doc.destroy();
  }
}

/** assembleHybridPdf の overlay 戦略を、経路選択ごと再現する。 */
async function assembleOverlayPage(sourceBytes, sourceRot, userRot) {
  const effRot = ((sourceRot + userRot) % 360 + 360) % 360;
  const canonW = effRot === 90 || effRot === 270 ? H : W; // 画面が見せている寸法
  const canonH = effRot === 90 || effRot === 270 ? W : H;
  const src = await PDFDocument.load(sourceBytes);
  const out = await PDFDocument.create();
  if (verbatimOverlayCopyEligible(sourceRot, userRot)) {
    const [copied] = await out.copyPages(src, [0]);
    out.addPage(copied);
    copied.drawRectangle({
      x: overlay.x, y: canonH - overlay.y - overlay.h,
      width: overlay.w, height: overlay.h, color: rgb(1, 0, 0),
    });
  } else {
    const [embedded] = await out.embedPdf(src, [0]);
    const { tx, ty, rotate } = rotatedSourcePlacement(effRot, embedded.width, embedded.height);
    const page = out.addPage([canonW, canonH]);
    page.drawPage(embedded, {
      x: tx, y: ty, width: embedded.width, height: embedded.height, rotate,
    });
    page.drawRectangle({
      x: overlay.x, y: canonH - overlay.y - overlay.h,
      width: overlay.w, height: overlay.h, color: rgb(1, 0, 0),
    });
  }
  return { bytes: await out.save(), canonW, canonH, effRot };
}

for (const sourceRot of [0, 90, 180, 270]) {
  for (const userRot of [0, 90, 180, 270]) {
    const effRot = (sourceRot + userRot) % 360;
    test(`overlay 出力の向き・寸法: source /Rotate=${sourceRot} × userRotation=${userRot} (effRot=${effRot})`, async () => {
      const src = await buildSource(sourceRot);
      const { bytes, canonW, canonH } = await assembleOverlayPage(src, sourceRot, userRot);

      // (1) 出力 PDF が実際に表示される寸法 = 画面の canonical 寸法。
      //     打ち消し合いケースで verbatim copy に落ちると、ここが入れ替わる
      //     (A3 縦のはずが横になって見切れる、の正体)。
      assert.deepEqual(
        displayedSize(bytes), { w: canonW, h: canonH },
        `出力ページの表示寸法が画面と食い違う (source=${sourceRot}, user=${userRot})`,
      );

      // (2) 吹き出しはユーザーが置いた canonical TOP-LEFT にある。
      // (3) 元ページの内容は「画面が見せている向き」= /Rotate=effRot 相当と一致。
      const m = markers(bytes);
      assert.equal(m.red, "TOP-LEFT", `吹き出しが回った (source=${sourceRot}, user=${userRot})`);
      assert.equal(
        m.blue, markers(await buildSource(effRot)).blue,
        `元ページの向きが画面と食い違う (source=${sourceRot}, user=${userRot})`,
      );
    });
  }
}

test("verbatimOverlayCopyEligible: 打ち消し合い (sourceRot+userRot=360) を高速パスに入れない", () => {
  assert.equal(verbatimOverlayCopyEligible(0, 0), true);
  assert.equal(verbatimOverlayCopyEligible(90, 270), false, "effRot=0 でも /Rotate を持ち込むので不可");
  assert.equal(verbatimOverlayCopyEligible(180, 180), false, "A3 天地さかさまの形");
  assert.equal(verbatimOverlayCopyEligible(270, 90), false);
  assert.equal(verbatimOverlayCopyEligible(90, 0), false);
  assert.equal(verbatimOverlayCopyEligible(0, 90), false);
});

// ───────────────────────────────────────────────────────────────────────────
// 2026-07-14 その 2: 挿入ページ (external 戦略) の intrinsic /Rotate。
//
// 挿入ページの synthetic 行は **/Rotate を持たない** — 挿入時に記録するのは
// mupdf の getBounds() = 回転適用後の「表示寸法」だけ (main.js
// _insertPdfBytesIntoWorkspace)。よって renderer が送る sourceRotation は常に 0 で、
// effRot = userRotation。ところが書き出しの embedPdf は /Rotate を無視して native
// content を描くので、ベイク経路では **外部ページ自身の /Rotate が抜け落ちる**:
// 紙は canonical 寸法のままなのに中身だけ 90° 回って半分見切れる (A3 挿入ページの
// 実機報告)。verbatim copyPages 経路は /Rotate ごと運ぶので無事だった = userRot を
// 掛けた瞬間だけ壊れる、という見え方になる。
// ───────────────────────────────────────────────────────────────────────────

/** 挿入ページの実経路 (main.js の external 戦略) を再現する。 */
async function assembleExternalPage(extBytes, extRot, userRot, withOverlay) {
  const ext = await PDFDocument.load(extBytes);
  // 画面が見せている寸法 = 外部ページの表示寸法 (= getBounds、DB に入る値) を
  // userRotation で swap したもの。DB の rotation 列は無い (=0) ので、
  // canonicalPageSize には cropW/cropH = 表示寸法、rotation=0 を渡す形になる。
  const dispW = extRot === 90 || extRot === 270 ? H : W;
  const dispH = extRot === 90 || extRot === 270 ? W : H;
  const canon = canonicalPageSize({
    cropW: dispW, cropH: dispH, rotation: 0, userRotation: userRot,
  });
  const extEffRot = ((extRot + userRot) % 360 + 360) % 360;
  const out = await PDFDocument.create();
  const drawOverlay = (page) => {
    if (!withOverlay) return;
    page.drawRectangle({
      x: overlay.x, y: canon.h - overlay.y - overlay.h,
      width: overlay.w, height: overlay.h, color: rgb(1, 0, 0),
    });
  };
  const verbatim = withOverlay
    ? verbatimOverlayCopyEligible(extRot, userRot)
    : userRot === 0;
  if (verbatim) {
    const [copied] = await out.copyPages(ext, [0]);
    out.addPage(copied);
    drawOverlay(copied);
  } else {
    const [embedded] = await out.embedPdf(ext, [0]);
    const { tx, ty, rotate } = rotatedSourcePlacement(
      extEffRot, embedded.width, embedded.height,
    );
    const page = out.addPage([canon.w, canon.h]);
    page.drawPage(embedded, {
      x: tx, y: ty, width: embedded.width, height: embedded.height, rotate,
    });
    drawOverlay(page);
  }
  return { bytes: await out.save(), canon, extEffRot };
}

for (const extRot of [0, 90, 180, 270]) {
  for (const userRot of [0, 90, 180, 270]) {
    for (const withOverlay of [false, true]) {
      const label = withOverlay ? "吹き出しあり" : "素のページ";
      test(`挿入ページ: 外部 /Rotate=${extRot} × userRotation=${userRot} (${label})`, async () => {
        const ext = await buildSource(extRot);
        const { bytes, canon, extEffRot } = await assembleExternalPage(
          ext, extRot, userRot, withOverlay,
        );

        // 出力の表示寸法 = 画面の canonical 寸法 (ここがズレると「見切れ」)。
        assert.deepEqual(
          displayedSize(bytes), { w: canon.w, h: canon.h },
          `出力ページの表示寸法が画面と食い違う (ext=${extRot}, user=${userRot})`,
        );
        const m = markers(bytes);
        // 元ページの内容が「画面が見せている向き」= /Rotate=extEffRot 相当と一致。
        assert.equal(
          m.blue, markers(await buildSource(extEffRot)).blue,
          `挿入ページの内容の向きが画面と食い違う (ext=${extRot}, user=${userRot})`,
        );
        if (withOverlay) {
          assert.equal(
            m.red, "TOP-LEFT",
            `吹き出しが回った (ext=${extRot}, user=${userRot})`,
          );
        }
      });
    }
  }
}

// Direct unit check of the placement table (clockwise, matching mupdf/Adobe).
test("rotatedSourcePlacement returns clockwise params + canonical dims", () => {
  assert.deepEqual(rotatedSourcePlacement(0, W, H), { tx: 0, ty: 0, rotate: degrees(0), pageW: W, pageH: H });
  assert.deepEqual(rotatedSourcePlacement(90, W, H), { tx: 0, ty: W, rotate: degrees(-90), pageW: H, pageH: W });
  assert.deepEqual(rotatedSourcePlacement(180, W, H), { tx: W, ty: H, rotate: degrees(-180), pageW: W, pageH: H });
  assert.deepEqual(rotatedSourcePlacement(270, W, H), { tx: H, ty: 0, rotate: degrees(-270), pageW: H, pageH: W });
});
