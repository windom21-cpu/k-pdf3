// Regression: a page REORDER must be baked into the exported/printed PDF.
//
// Bug (pre-v2.0.11): the verbatim byte-copy fast path (isCopy) checked for
// overlays / deletions / insertions / userRotation but NOT page reorder.
// Reorder only rewrites the workspace `display_order` (DB) — it is never
// baked into the source PDF bytes. So a reorder-only 上書き保存 / Adobe 印刷
// fell through to byte-copy and wrote the source in its ORIGINAL order: the
// page order looked right inside K-PDF3 (it reads the DB) but other viewers
// (k-evi 等) that read the raw PDF saw the original order. Same shape as the
// v2.0.7 userRotation byte-copy bug.
//
// Fix: pagesInNaturalSourceOrder() gates the byte-copy path; a reorder makes
// it false, routing the export through composePagesForExport →
// assembleHybridPdf (strategy="source": vector copyPages in display order).
//
// Part 1 unit-tests the pure gate. Part 2 reproduces the re-assembly path
// (copyPages in display order) and renders with mupdf to prove the output
// page order matches the reorder. mupdf is WASM, so this runs under node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, rgb } from "pdf-lib";
import { pagesInNaturalSourceOrder } from "../src/renderer/exporter.js";
import { renderPagePixels, openPdfDocument } from "../src/backend/mupdf-render.js";

// ---- Part 1: the byte-copy gate ------------------------------------------

test("pagesInNaturalSourceOrder: true for 1..N source pages in order", () => {
  const pages = [{ pageNo: 1 }, { pageNo: 2 }, { pageNo: 3 }];
  assert.equal(pagesInNaturalSourceOrder(pages), true);
});

test("pagesInNaturalSourceOrder: FALSE when reordered (the bug)", () => {
  const pages = [{ pageNo: 3 }, { pageNo: 1 }, { pageNo: 2 }]; // moved p3 to front
  assert.equal(pagesInNaturalSourceOrder(pages), false);
});

test("pagesInNaturalSourceOrder: FALSE with a synthetic/inserted page", () => {
  const pages = [{ pageNo: 1 }, { pageNo: -5, isSynthetic: true }, { pageNo: 2 }];
  assert.equal(pagesInNaturalSourceOrder(pages), false);
});

test("pagesInNaturalSourceOrder: FALSE with a gap (deletion)", () => {
  const pages = [{ pageNo: 1 }, { pageNo: 3 }]; // page 2 deleted
  assert.equal(pagesInNaturalSourceOrder(pages), false);
});

test("pagesInNaturalSourceOrder: FALSE for empty / non-array", () => {
  assert.equal(pagesInNaturalSourceOrder([]), false);
  assert.equal(pagesInNaturalSourceOrder(null), false);
});

// ---- Part 2: re-assembly preserves the reordered page order --------------

const COLORS = [
  { name: "RED", rgb: rgb(1, 0, 0) },
  { name: "GREEN", rgb: rgb(0, 1, 0) },
  { name: "BLUE", rgb: rgb(0, 0, 1) },
];

// 3-page source: page 0 = full RED, page 1 = full GREEN, page 2 = full BLUE.
async function buildColoredSource() {
  const doc = await PDFDocument.create();
  for (const c of COLORS) {
    const p = doc.addPage([200, 280]);
    p.drawRectangle({ x: 0, y: 0, width: 200, height: 280, color: c.rgb });
  }
  return await doc.save();
}

// Mirror assembleHybridPdf's strategy="source" path: copyPages the source
// page for each display-order entry. `order` lists source page indices.
async function assembleInOrder(sourceBytes, order) {
  const newPdf = await PDFDocument.create();
  const src = await PDFDocument.load(sourceBytes);
  for (const sourceIdx of order) {
    const [copied] = await newPdf.copyPages(src, [sourceIdx]);
    newPdf.addPage(copied);
  }
  return await newPdf.save();
}

function dominantColorName(bytes, pageIdx) {
  const doc = openPdfDocument(Buffer.from(bytes));
  try {
    const r = renderPagePixels(doc, pageIdx, [0.25, 0, 0, 0.25, 0, 0]);
    const { width, height, channels, pixels } = r;
    let R = 0, G = 0, B = 0, n = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        R += pixels[i]; G += pixels[i + 1]; B += pixels[i + 2]; n++;
      }
    }
    R /= n; G /= n; B /= n;
    if (R >= G && R >= B) return "RED";
    if (G >= R && G >= B) return "GREEN";
    return "BLUE";
  } finally {
    doc.destroy();
  }
}

test("reordered export bakes the new page order into the PDF bytes", async () => {
  const src = await buildColoredSource();
  // Sanity: natural order renders RED, GREEN, BLUE.
  const natural = await assembleInOrder(src, [0, 1, 2]);
  assert.deepEqual(
    [0, 1, 2].map((i) => dominantColorName(natural, i)),
    ["RED", "GREEN", "BLUE"],
  );

  // User drags page 3 (BLUE) to the front → display order = [2, 0, 1].
  const reordered = await assembleInOrder(src, [2, 0, 1]);
  assert.deepEqual(
    [0, 1, 2].map((i) => dominantColorName(reordered, i)),
    ["BLUE", "RED", "GREEN"],
    "exported page order must follow the reorder, not the source order",
  );
});
