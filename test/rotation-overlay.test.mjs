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
import { rotatedSourcePlacement } from "../src/main/rotate-place.js";
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

// Direct unit check of the placement table (clockwise, matching mupdf/Adobe).
test("rotatedSourcePlacement returns clockwise params + canonical dims", () => {
  assert.deepEqual(rotatedSourcePlacement(0, W, H), { tx: 0, ty: 0, rotate: degrees(0), pageW: W, pageH: H });
  assert.deepEqual(rotatedSourcePlacement(90, W, H), { tx: 0, ty: W, rotate: degrees(-90), pageW: H, pageH: W });
  assert.deepEqual(rotatedSourcePlacement(180, W, H), { tx: W, ty: H, rotate: degrees(-180), pageW: W, pageH: H });
  assert.deepEqual(rotatedSourcePlacement(270, W, H), { tx: H, ty: 0, rotate: degrees(-270), pageW: H, pageH: W });
});
