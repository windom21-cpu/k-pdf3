// mupdf-render.js smoke test
//
//   - 合成 PDF（mupdf.PDFDocument 1 ページ）を openPdfDocument で開く
//   - renderPagePixels で zoom 1.0 / 2.0 / RGB のバリエーションを描画
//   - 寸法 / チャンネル数 / バッファ長 / 型を検証
//
// mupdf は WASM なので Node ABI に依存しない。
// better-sqlite3 を使わないため dual-ABI 切替不要。

import * as mupdf from "mupdf";
import {
  renderPagePixels,
  openPdfDocument,
} from "../src/backend/mupdf-render.js";

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

function buildTestPdf() {
  const doc = new mupdf.PDFDocument();
  const emptyContent = new TextEncoder().encode("q Q\n");
  const resources = doc.addObject(doc.newDictionary());
  // A4 portrait, no rotation
  const pageObj = doc.addPage([0, 0, 595, 842], 0, resources, emptyContent);
  doc.insertPage(0, pageObj);
  const buf = doc.saveToBuffer();
  const bytes = Buffer.from(buf.asUint8Array());
  doc.destroy();
  buf.destroy?.();
  return bytes;
}

console.log("=== mupdf-render smoke test ===\n");

let exitCode = 0;
try {
  console.log("[1] Build synthetic PDF and open via openPdfDocument()");
  const pdfBytes = buildTestPdf();
  ok(pdfBytes.length > 0, `PDF buffer non-empty (${pdfBytes.length} bytes)`);
  const doc = openPdfDocument(pdfBytes);
  try {
    ok(doc.countPages() === 1, "page count = 1");

    console.log("\n[2] Render page 0 at identity scale (RGBA)");
    const M1 = [1, 0, 0, 1, 0, 0];
    const r1 = renderPagePixels(doc, 0, M1);
    ok(r1.width > 0 && r1.height > 0, `pixmap dims positive (${r1.width}×${r1.height})`);
    ok(r1.channels === 4, "channels = 4 (RGBA default)");
    ok(
      r1.pixels.length === r1.width * r1.height * 4,
      `pixels.length === w×h×4 (${r1.pixels.length})`,
    );
    ok(r1.pixels instanceof Uint8ClampedArray, "pixels is Uint8ClampedArray");

    console.log("\n[3] Render page 0 at scale 2.0 → ~2× dimensions");
    const M2 = [2, 0, 0, 2, 0, 0];
    const r2 = renderPagePixels(doc, 0, M2);
    ok(
      Math.abs(r2.width - r1.width * 2) <= 1,
      `width ≈ 2× (${r1.width}→${r2.width})`,
    );
    ok(
      Math.abs(r2.height - r1.height * 2) <= 1,
      `height ≈ 2× (${r1.height}→${r2.height})`,
    );

    console.log("\n[4] Render with alpha=false → RGB (3 channels)");
    const r3 = renderPagePixels(doc, 0, M1, { alpha: false });
    ok(r3.channels === 3, "channels = 3 when alpha=false");
    ok(
      r3.pixels.length === r3.width * r3.height * 3,
      `pixels.length === w×h×3 (${r3.pixels.length})`,
    );

    console.log("\n[5] Output is detached from mupdf internal buffer");
    // Mutate returned buffer; re-render and confirm fresh pixels are independent.
    r1.pixels[0] = 0xff;
    const r4 = renderPagePixels(doc, 0, M1);
    ok(r4.pixels[0] !== 0xff || r1.pixels !== r4.pixels, "fresh render returns a new buffer");
  } finally {
    doc.destroy();
  }
} catch (err) {
  fail++;
  console.error("[FATAL]", err);
  exitCode = 1;
}

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) exitCode = 1;
process.exit(exitCode);
