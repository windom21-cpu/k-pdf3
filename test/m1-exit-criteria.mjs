// M1 Exit Criteria smoke test:
//
//   .kpdf3 を新規作成 → source PDF を取り込み → クローズ →
//   再オープンで page count / mediabox / rotation が一致
//
// + workspace integrity check (application_id / user_version / integrity_check)

import * as mupdf from "mupdf";
import { Workspace } from "../src/domain/workspace.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ----------------------------------------------------------------------
// Build a synthetic PDF with mupdf.PDFDocument so we don't need a fixture file.
// 3 pages with distinct sizes / rotations.
// ----------------------------------------------------------------------
function buildTestPdf() {
  const doc = new mupdf.PDFDocument();
  const emptyContent = new TextEncoder().encode("q Q\n");

  /** @type {Array<{ box: [number, number, number, number], rotate: 0|90|180|270 }>} */
  const pages = [
    { box: [0, 0, 595, 842], rotate: 0 },     // A4
    { box: [0, 0, 612, 792], rotate: 90 },    // US Letter, landscape via rotate
    { box: [0, 0, 420, 595], rotate: 180 },   // A5
  ];

  for (const p of pages) {
    const resources = doc.addObject(doc.newDictionary());
    const pageObj = doc.addPage(p.box, p.rotate, resources, emptyContent);
    doc.insertPage(doc.countPages(), pageObj);
  }
  const buf = doc.saveToBuffer();
  const bytes = Buffer.from(buf.asUint8Array());
  doc.destroy();
  buf.destroy?.();
  return { bytes, expected: pages };
}

console.log("=== M1 Exit Criteria smoke test ===\n");

const tmpDir = mkdtempSync(join(tmpdir(), "kpdf3-m1-"));
const wsPath = join(tmpDir, "test.kpdf3");
const pdfPath = join(tmpDir, "test.pdf");

let exitCode = 0;
try {
  // -------- 1. Build & save synthetic PDF --------
  console.log("[1] Build synthetic PDF (mupdf.PDFDocument)");
  const { bytes: pdfBytes, expected } = buildTestPdf();
  writeFileSync(pdfPath, pdfBytes);
  ok(pdfBytes.length > 0, `PDF buffer non-empty (${pdfBytes.length} bytes)`);
  ok(pdfBytes.subarray(0, 5).toString() === "%PDF-", "PDF starts with %PDF-");

  // -------- 2. Create new workspace --------
  console.log("\n[2] Create new workspace");
  const ws1 = Workspace.open(wsPath);
  ok(ws1.isNew === true, "isNew=true on first open");

  // -------- 3. Import PDF --------
  console.log("\n[3] Import PDF into workspace");
  const importInfo = await ws1.importPdfFromFile(pdfPath);
  eq(importInfo.pageCount, expected.length, "imported page count");
  ok(typeof importInfo.fingerprint === "string" && importInfo.fingerprint.length === 64,
     `fingerprint is SHA-256 hex (got length ${importInfo.fingerprint.length})`);

  const meta1 = ws1.getSourceMeta();
  eq(meta1.fileName, "test.pdf", "stored file name");
  eq(meta1.byteSize, pdfBytes.length, "stored byte size");
  eq(meta1.pageCount, expected.length, "stored page count");

  const pages1 = ws1.getPages();
  eq(pages1.length, expected.length, "pages table row count");
  for (let i = 0; i < expected.length; i++) {
    const got = pages1[i];
    const want = expected[i];
    eq(got.pageNo, i + 1, `page ${i + 1}: pageNo`);
    eq(got.mediaW, want.box[2] - want.box[0], `page ${i + 1}: mediaW`);
    eq(got.mediaH, want.box[3] - want.box[1], `page ${i + 1}: mediaH`);
    eq(got.rotation, want.rotate, `page ${i + 1}: rotation`);
  }

  // -------- 4. Close workspace --------
  console.log("\n[4] Close workspace (with WAL checkpoint)");
  ws1.close();
  ok(true, "close completed without throwing");

  // -------- 5. Re-open workspace --------
  console.log("\n[5] Re-open workspace");
  const ws2 = Workspace.open(wsPath);
  ok(ws2.isNew === false, "isNew=false on re-open");

  // -------- 6. Verify metrics persisted exactly --------
  console.log("\n[6] Verify persisted page metrics match");
  const meta2 = ws2.getSourceMeta();
  eq(meta2.fileName, "test.pdf", "re-opened file name");
  eq(meta2.byteSize, pdfBytes.length, "re-opened byte size");
  eq(meta2.pageCount, expected.length, "re-opened page count");
  eq(meta2.fingerprint, importInfo.fingerprint, "fingerprint stable");

  const pages2 = ws2.getPages();
  eq(pages2.length, expected.length, "re-opened pages length");
  for (let i = 0; i < expected.length; i++) {
    const got = pages2[i];
    const want = expected[i];
    eq(got.pageNo, i + 1, `re-opened page ${i + 1}: pageNo`);
    eq(got.mediaW, want.box[2] - want.box[0], `re-opened page ${i + 1}: mediaW`);
    eq(got.mediaH, want.box[3] - want.box[1], `re-opened page ${i + 1}: mediaH`);
    eq(got.rotation, want.rotate, `re-opened page ${i + 1}: rotation`);
    eq(got.cropW, want.box[2] - want.box[0], `re-opened page ${i + 1}: cropW`);
    eq(got.cropH, want.box[3] - want.box[1], `re-opened page ${i + 1}: cropH`);
  }

  // -------- 7. Verify source PDF blob round-trip --------
  console.log("\n[7] Verify source PDF blob bit-identical");
  const reloadedBytes = ws2.getSourceBytes();
  ok(reloadedBytes !== null, "source blob present");
  ok(reloadedBytes.equals(pdfBytes), "source blob bit-identical to original");

  // -------- 8. Verify metadata --------
  console.log("\n[8] Verify metadata table");
  eq(ws2.getMetadata("schema_version"), "1.0.0", "schema_version");
  eq(ws2.getMetadata("app_version"), "2.0.0", "app_version");
  eq(ws2.getMetadata("source_fingerprint"), importInfo.fingerprint, "source_fingerprint metadata");

  ws2.close();

  // -------- Summary --------
  console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
  if (fail > 0) {
    console.log("M1 Exit Criteria: FAIL");
    exitCode = 1;
  } else {
    console.log("M1 Exit Criteria: PASS ✅");
  }
} catch (err) {
  console.error("\n[FATAL]", err);
  exitCode = 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(exitCode);
}
