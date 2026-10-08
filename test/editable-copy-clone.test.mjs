// ADR-0030「編集可能として別名保存」— workspace 複製の e2e。
//
//   元 workspace (フォーム枠 + 記入値 + 回転 + しおり)
//     → 画面側スナップショット (記入値を書き換え) + 未確定削除 を渡して複製
//     → 複製: スナップショットどおりの overlay / 回転維持 / 削除反映 /
//             新 fingerprint / lineage なし / 書き出し履歴なし
//     → 元:   overlay・ページ・fingerprint が 1 バイトも変わっていない
//
// 「別名で保存したフォーム記入が元ファイルを開いても見える」事故の再発
// 防止がこのテストの目的 (元 workspace 不変 + fingerprint 分離)。
//
// Runs inside Electron main process via electron-runner.cjs (better-sqlite3
// needs Electron ABI).

import * as mupdf from "mupdf";
import { createHash } from "node:crypto";
import { Workspace } from "../src/domain/workspace.js";
import { cloneWorkspaceAsEditableCopy } from "../src/domain/workspace-clone.js";
import { makeDistinctPdfBytes } from "../src/backend/editable-copy-bytes.js";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");

function buildTestPdf() {
  const doc = new mupdf.PDFDocument();
  const empty = new TextEncoder().encode("q Q\n");
  for (let i = 0; i < 3; i++) {
    const resources = doc.addObject(doc.newDictionary());
    const pageObj = doc.addPage([0, 0, 595, 842], 0, resources, empty);
    doc.insertPage(doc.countPages(), pageObj);
  }
  const bytes = Buffer.from(doc.saveToBuffer().asUint8Array().slice());
  doc.destroy();
  return bytes;
}

console.log("=== ADR-0030: editable-copy workspace clone ===\n");

const tmpDir = mkdtempSync(join(tmpdir(), "kpdf3-editable-copy-"));
const srcWsPath = join(tmpDir, "src.kpdf3");
const dstWsPath = join(tmpDir, "copy.kpdf3");
const pdfPath = join(tmpDir, "template.pdf");

let exitCode = 0;
try {
  console.log("[1] 元 workspace: フォーム枠 (記入値あり) + テキスト + 回転 + しおり");
  const pdfBytes = buildTestPdf();
  writeFileSync(pdfPath, pdfBytes);
  const src = Workspace.create(srcWsPath);
  await src.importPdfFromFile(pdfPath);
  const now = new Date().toISOString();
  const stamp = { assetId: null, createdAt: now, updatedAt: now };
  const persisted = [
    {
      ...stamp,
      id: "ov-field-1", pageNo: 1, type: "form_field",
      x: 100, y: 100, w: 200, h: 24, zOrder: 0,
      properties: { fieldKind: "text", value: "", fontSize: 12, color: "#000000" },
    },
    {
      ...stamp,
      id: "ov-field-2", pageNo: 1, type: "form_field",
      x: 100, y: 140, w: 24, h: 24, zOrder: 1,
      properties: { fieldKind: "check", value: "", checkStyle: "✓", color: "#000000" },
    },
    {
      ...stamp,
      id: "ov-text-1", pageNo: 2, type: "text",
      x: 50, y: 50, w: 100, h: 20, zOrder: 0,
      properties: { text: "テンプレ注記", fontSize: 12, fontId: "kosugi", color: "#000000" },
    },
  ];
  src.saveOverlays(persisted);
  src.setPageUserRotation(2, 90);
  src.addBookmark({ id: "bm-1", title: "第1章", pageNo: 1 });
  src.setPredecessor("some-older-master"); // 複製に持ち越されない lineage
  src.recordExport(pdfBytes, { note: "earlier export" });
  const srcFpBefore = src.getSourceMeta().fingerprint;
  const srcBytesBefore = src.getSourceBytes();
  eq(src.loadOverlays().length, 3, "元 workspace に overlay 3 件");

  console.log("\n[2] 画面側のスナップショット (記入値を入れた状態) で複製");
  const snapshot = persisted.map((o) => ({
    ...o,
    properties:
      o.id === "ov-field-1" ? { ...o.properties, value: "山田 太郎" }
      : o.id === "ov-field-2" ? { ...o.properties, value: "on" }
      : o.properties,
  }));
  const distinct = makeDistinctPdfBytes(srcBytesBefore, { stamp: "clone-test" });
  const clone = await cloneWorkspaceAsEditableCopy({
    source: src,
    destPath: dstWsPath,
    bytes: distinct.bytes,
    fileName: "copy.pdf",
    overlays: snapshot,
    pendingDeletedPageNos: [3],
  });

  console.log("\n[3] 複製側の検証");
  const cloneOverlays = clone.loadOverlays();
  eq(cloneOverlays.length, 3, "複製に overlay 3 件");
  const byId = new Map(cloneOverlays.map((o) => [o.id, o]));
  eq(byId.get("ov-field-1")?.properties?.value, "山田 太郎", "複製: text 欄の記入値はスナップショットどおり");
  eq(byId.get("ov-field-2")?.properties?.value, "on", "複製: check 欄の記入値はスナップショットどおり");
  eq(byId.get("ov-text-1")?.properties?.text, "テンプレ注記", "複製: テキスト overlay も維持");
  const clonePages = clone.getPages({ includeDeleted: true });
  eq(clonePages.find((p) => p.pageNo === 2)?.userRotation, 90, "複製: ページ 2 の回転を維持");
  eq(!!clonePages.find((p) => p.pageNo === 3)?.isDeleted, true, "複製: 未確定だった削除 (ページ 3) を反映");
  eq(clone.getPages().length, 2, "複製: 表示ページは 2 枚");
  eq(clone.listBookmarks().length, 1, "複製: しおりを維持");
  const cloneMeta = clone.getSourceMeta();
  eq(cloneMeta.pageCount, 3, "複製: source のページ数は不変");
  eq(cloneMeta.fileName, "copy.pdf", "複製: source の表示名は新ファイル名");
  ok(cloneMeta.fingerprint !== srcFpBefore, "複製: fingerprint が元と異なる (workspace 共有を防ぐ)");
  eq(cloneMeta.fingerprint, sha(distinct.bytes), "複製: fingerprint = 新バイト列の SHA-256");
  eq(clone.getMetadata("source_fingerprint"), cloneMeta.fingerprint, "複製: metadata の fingerprint も更新");
  ok(clone.getSourceBytes().equals(distinct.bytes), "複製: getSourceBytes が新バイト列を返す");
  eq(clone.getPredecessor(), null, "複製: 複製元の lineage (predecessor) を引き継がない");
  eq(clone.listExports().length, 0, "複製: 書き出し履歴は空");
  eq(clone.sourceWasEncrypted(), false, "複製: 暗号化フラグなし");
  {
    const doc = mupdf.PDFDocument.openDocument(clone.getSourceBytes(), "application/pdf");
    eq(doc.countPages(), 3, "複製: 新バイト列は mupdf で 3 ページとして開ける");
    doc.destroy();
  }
  clone.close();

  console.log("\n[4] 複製を閉じて開き直しても同じ");
  const reopened = Workspace.open(dstWsPath);
  eq(reopened.loadOverlays().find((o) => o.id === "ov-field-1")?.properties?.value, "山田 太郎", "再オープン: 記入値維持");
  eq(reopened.getSourceMeta().fingerprint, sha(distinct.bytes), "再オープン: fingerprint 維持");
  reopened.close();

  console.log("\n[5] 元 workspace は不変 (= 元ファイルを開いても記入値は出ない)");
  const srcOverlaysAfter = src.loadOverlays();
  const srcById = new Map(srcOverlaysAfter.map((o) => [o.id, o]));
  eq(srcOverlaysAfter.length, 3, "元: overlay 件数不変");
  eq(srcById.get("ov-field-1")?.properties?.value, "", "元: text 欄は空のまま");
  eq(srcById.get("ov-field-2")?.properties?.value, "", "元: check 欄は空のまま");
  eq(src.getSourceMeta().fingerprint, srcFpBefore, "元: fingerprint 不変");
  ok(src.getSourceBytes().equals(srcBytesBefore), "元: source バイト列不変");
  eq(src.getPages().length, 3, "元: ページ 3 は削除されていない");
  eq(src.getPredecessor(), "some-older-master", "元: lineage 不変");
  eq(src.listExports().length, 1, "元: 書き出し履歴不変");
  src.close();

  console.log("\n[6] 複製失敗時は複製ファイルを残さない (ページ数不一致を渡す)");
  const src2 = Workspace.open(srcWsPath);
  const otherPdf = (() => {
    const doc = new mupdf.PDFDocument();
    const empty = new TextEncoder().encode("q Q\n");
    const resources = doc.addObject(doc.newDictionary());
    doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, resources, empty));
    const b = Buffer.from(doc.saveToBuffer().asUint8Array().slice());
    doc.destroy();
    return b;
  })();
  const badPath = join(tmpDir, "bad.kpdf3");
  let threw = false;
  try {
    await cloneWorkspaceAsEditableCopy({
      source: src2, destPath: badPath, bytes: otherPdf, fileName: "bad.pdf",
    });
  } catch {
    threw = true;
  }
  ok(threw, "ページ数不一致は例外");
  ok(!existsSync(badPath), "失敗した複製ファイルは残らない");
  src2.close();

  console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
  if (fail > 0) {
    console.log("ADR-0030 editable-copy clone: FAIL");
    exitCode = 1;
  } else {
    console.log("ADR-0030 editable-copy clone: PASS ✅");
  }
} catch (err) {
  console.error("\n[FATAL]", err);
  exitCode = 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
process.exitCode = exitCode;
