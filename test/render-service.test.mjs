// render-service unit test
//
//   - Build a synthetic 3-page PDF with mixed rotations.
//   - For each page, call renderPageCanonical at zoom 1.0 / 2.0.
//   - Verify the resulting pixmap dimensions equal zoom × canonical page size.
//
// mupdf is WASM, so this runs under plain `node`; better-sqlite3 is not
// touched.

import * as mupdf from "mupdf";
import { renderPageCanonical } from "../src/main/render-service.js";
import { openPdfDocument } from "../src/backend/mupdf-render.js";
import { canonicalPageSize } from "../src/domain/coord.js";

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
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg}: expected ${expected}, got ${actual}`);
}

console.log("=== render-service smoke test ===\n");

function buildTestPdf(specs) {
  const doc = new mupdf.PDFDocument();
  const emptyContent = new TextEncoder().encode("q Q\n");
  for (const s of specs) {
    const resources = doc.addObject(doc.newDictionary());
    const pageObj = doc.addPage(s.box, s.rotate, resources, emptyContent);
    doc.insertPage(doc.countPages(), pageObj);
  }
  const buf = doc.saveToBuffer();
  const bytes = Buffer.from(buf.asUint8Array());
  doc.destroy();
  buf.destroy?.();
  return bytes;
}

// Three pages: A4 portrait / Letter landscape via rotate 90 / A5 portrait rot 180
const pageSpecs = [
  { box: [0, 0, 595, 842], rotate: 0,   label: "A4 rot 0" },
  { box: [0, 0, 612, 792], rotate: 90,  label: "Letter rot 90" },
  { box: [0, 0, 420, 595], rotate: 180, label: "A5 rot 180" },
];

const pdfBytes = buildTestPdf(pageSpecs);
ok(pdfBytes.length > 0, `built ${pdfBytes.length} bytes`);

const doc = openPdfDocument(pdfBytes);
try {
  eq(doc.countPages(), 3, "page count");

  // Build PageRow objects compatible with render-service signature.
  /** @type {import("../src/main/render-service.js").PageRow[]} */
  const rows = pageSpecs.map((s, i) => {
    const [mx, my, mxe, mye] = s.box;
    return {
      pageNo: i + 1,
      mediaX: mx, mediaY: my, mediaW: mxe - mx, mediaH: mye - my,
      cropX:  mx, cropY:  my, cropW:  mxe - mx, cropH:  mye - my,
      rotation: s.rotate,
      userRotation: 0,
    };
  });

  for (const row of rows) {
    console.log(`\n[page ${row.pageNo}] ${pageSpecs[row.pageNo - 1].label}`);
    const canonical = canonicalPageSize({
      ...row,
      userRotation: row.userRotation ?? 0,
    });

    for (const zoom of [1.0, 2.0]) {
      const result = renderPageCanonical(doc, row, { zoom });
      const expW = Math.round(canonical.w * zoom);
      const expH = Math.round(canonical.h * zoom);
      ok(
        Math.abs(result.width - expW) <= 1,
        `zoom=${zoom} width = ${expW} (got ${result.width})`,
      );
      ok(
        Math.abs(result.height - expH) <= 1,
        `zoom=${zoom} height = ${expH} (got ${result.height})`,
      );
      eq(result.channels, 4, `zoom=${zoom} channels=4 (RGBA default)`);
      eq(
        result.pixels.length,
        result.width * result.height * 4,
        `zoom=${zoom} buffer length matches`,
      );
    }
  }

  console.log("\n[opts.alpha=false] RGB output");
  const r3 = renderPageCanonical(doc, rows[0], { zoom: 1, alpha: false });
  eq(r3.channels, 3, "channels=3 with alpha=false");
} finally {
  doc.destroy();
}

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
process.exitCode = fail > 0 ? 1 : 0;
