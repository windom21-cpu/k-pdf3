// M3-1 smoke test: overlay persistence round-trip
//
//   create workspace + PDF → ProjectStore.add 3 overlays →
//   workspace.saveOverlays → close → reopen →
//   workspace.loadOverlays → ProjectStore.reset → verify identity
//
// Runs inside Electron main process via electron-runner.cjs (better-sqlite3
// needs Electron ABI).

import * as mupdf from "mupdf";
import { Workspace } from "../src/domain/workspace.js";
import { ProjectStore } from "../src/domain/project-store.js";
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
  ok(
    actual === expected,
    `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function buildTestPdf() {
  const doc = new mupdf.PDFDocument();
  const empty = new TextEncoder().encode("q Q\n");
  for (const p of [[0, 0, 595, 842], [0, 0, 595, 842]]) {
    const resources = doc.addObject(doc.newDictionary());
    const pageObj = doc.addPage(p, 0, resources, empty);
    doc.insertPage(doc.countPages(), pageObj);
  }
  const buf = doc.saveToBuffer();
  const bytes = Buffer.from(buf.asUint8Array());
  doc.destroy();
  buf.destroy?.();
  return bytes;
}

console.log("=== M3-1: overlay persistence smoke test ===\n");

const tmpDir = mkdtempSync(join(tmpdir(), "kpdf3-m3-"));
const wsPath = join(tmpDir, "test.kpdf3");
const pdfPath = join(tmpDir, "test.pdf");

let exitCode = 0;
try {
  console.log("[1] Build synthetic PDF + create workspace + import");
  const pdfBytes = buildTestPdf();
  writeFileSync(pdfPath, pdfBytes);
  const ws1 = Workspace.create(wsPath);
  await ws1.importPdfFromFile(pdfPath);
  ok(ws1.getSourceMeta()?.pageCount === 2, "workspace imported 2-page PDF");

  console.log("\n[2] Build a ProjectStore + add 3 overlays");
  const store1 = new ProjectStore();
  const ov1 = store1.add({
    pageNo: 1, type: "text",
    x: 50, y: 50, w: 100, h: 20, zOrder: 0,
    properties: { text: "署名", fontSize: 12, fontId: "kosugi", color: "#000000" },
  });
  const ov2 = store1.add({
    pageNo: 1, type: "stamp",
    x: 400, y: 700, w: 60, h: 60, zOrder: 1,
    properties: { kind: "date", text: "-8.-5.-9", color: "#cc0000", frame: "circle" },
  });
  const ov3 = store1.add({
    pageNo: 2, type: "redaction",
    x: 100, y: 200, w: 200, h: 30, zOrder: 0,
    properties: { color: "black", mode: "draft" },
  });
  ok(store1.count() === 3, "store has 3 overlays");

  console.log("\n[3] Save overlays to workspace + close");
  // Snapshot the overlays in canonical order so we can compare after reload.
  const snapshot = [
    store1.get(ov1.id),
    store1.get(ov2.id),
    store1.get(ov3.id),
  ];
  ws1.saveOverlays(snapshot);
  ok(ws1.getMetadata("overlays_saved_at") !== null, "overlays_saved_at metadata recorded");
  ws1.close();

  console.log("\n[4] Re-open workspace + load overlays");
  const ws2 = Workspace.open(wsPath);
  const reloaded = ws2.loadOverlays();
  eq(reloaded.length, 3, "loaded 3 overlays");

  console.log("\n[5] Verify field-by-field round-trip");
  const byId = new Map(reloaded.map((o) => [o.id, o]));
  for (const original of snapshot) {
    const r = byId.get(original.id);
    ok(r !== undefined, `overlay ${original.id} present after reload`);
    if (!r) continue;
    eq(r.pageNo, original.pageNo, `${original.id}: pageNo`);
    eq(r.type, original.type, `${original.id}: type`);
    eq(r.x, original.x, `${original.id}: x`);
    eq(r.y, original.y, `${original.id}: y`);
    eq(r.w, original.w, `${original.id}: w`);
    eq(r.h, original.h, `${original.id}: h`);
    eq(r.zOrder, original.zOrder, `${original.id}: zOrder`);
    eq(r.assetId, original.assetId, `${original.id}: assetId`);
    eq(r.createdAt, original.createdAt, `${original.id}: createdAt`);
    eq(r.updatedAt, original.updatedAt, `${original.id}: updatedAt`);
    eq(
      JSON.stringify(r.properties),
      JSON.stringify(original.properties),
      `${original.id}: properties (JSON)`,
    );
  }

  console.log("\n[6] ProjectStore.reset feeds reloaded overlays back in");
  const store2 = new ProjectStore();
  store2.reset(reloaded);
  eq(store2.count(), 3, "reset → count = 3");
  eq(store2.isDirty(), false, "reset → not dirty (matches save semantic)");
  eq(store2.getPageOverlays(1).length, 2, "page 1 has 2 overlays");
  eq(store2.getPageOverlays(2).length, 1, "page 2 has 1 overlay");

  console.log("\n[7] Empty save round-trip (replace with 0 overlays)");
  ws2.saveOverlays([]);
  ws2.close();
  const ws3 = Workspace.open(wsPath);
  eq(ws3.loadOverlays().length, 0, "after save([]) → 0 overlays");
  ws3.close();

  console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
  if (fail > 0) {
    console.log("M3-1 overlay persistence: FAIL");
    exitCode = 1;
  } else {
    console.log("M3-1 overlay persistence: PASS ✅");
  }
} catch (err) {
  console.error("\n[FATAL]", err);
  exitCode = 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
process.exitCode = exitCode;
