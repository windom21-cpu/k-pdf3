// REVIEW-2026-07 #3: encrypted-source flag round-trip
//
//   create workspace + PDF → sourceWasEncrypted() is false by default →
//   markSourceWasEncrypted() → true → close → reopen → still true
//   (persists in workspace metadata; the password itself is never stored)
//
// Runs inside Electron main process via electron-runner.cjs (better-sqlite3
// needs Electron ABI).

import * as mupdf from "mupdf";
import { Workspace } from "../src/domain/workspace.js";
import { mkdtempSync, rmSync } from "node:fs";
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

function buildTestPdf() {
  const doc = new mupdf.PDFDocument();
  const empty = new TextEncoder().encode("q Q\n");
  const resources = doc.addObject(doc.newDictionary());
  const pageObj = doc.addPage([0, 0, 595, 842], 0, resources, empty);
  doc.insertPage(doc.countPages(), pageObj);
  const buf = doc.saveToBuffer();
  const bytes = Buffer.from(buf.asUint8Array());
  doc.destroy();
  buf.destroy?.();
  return bytes;
}

console.log("=== REVIEW-2026-07 #3: encrypted-source flag ===\n");

const tmpDir = mkdtempSync(join(tmpdir(), "kpdf3-encflag-"));
const wsPath = join(tmpDir, "test.kpdf3");

try {
  let ws = Workspace.create(wsPath);
  await ws.importPdfBytes(buildTestPdf(), "test.pdf");

  ok(ws.sourceWasEncrypted() === false, "fresh workspace: flag defaults to false");

  ws.markSourceWasEncrypted();
  ok(ws.sourceWasEncrypted() === true, "markSourceWasEncrypted → flag reads true");

  // idempotent — marking twice stays true, no throw
  ws.markSourceWasEncrypted();
  ok(ws.sourceWasEncrypted() === true, "marking twice is idempotent");

  ws.close();

  ws = Workspace.open(wsPath);
  ok(ws.sourceWasEncrypted() === true, "flag survives close → reopen");
  ok(
    ws.getMetadata("source_was_encrypted") === "1",
    "stored as metadata key source_was_encrypted = \"1\" (no password stored)",
  );
  ws.close();

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
