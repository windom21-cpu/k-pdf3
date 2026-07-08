// userData 移動 (Mac 移行 / PC 買い替え / userData 引越し) の可搬性 fallback 2 箇所:
//
//   (1) Workspace.getSourceBytes — source_pdf.external_path (β.134 巨大 PDF
//       サイドカー) は import 時の絶対パス。stale なら「.kpdf3 の隣の
//       <workspace>.source.pdf」(命名規約) を読む fallback。
//   (2) workspace-registry.findWorkspaceByFingerprint — workspace_path は
//       登録時の絶対パス。stale なら workspacePathFor(workspace_id) を試し、
//       見つかれば行を自己修復 (これが無いと移行先で「新規 workspace 作成 =
//       overlay が消えた」ように見える。main.js:1494 の existsSync ガード)。
//
// どちらも正常系 (パスがそのまま通るケース) は従来経路のまま。
// Runs inside Electron main process via electron-runner.cjs (better-sqlite3
// needs Electron ABI; registry は app.getPath("userData") も要る)。

import { app } from "electron";
import * as mupdf from "mupdf";
import { Workspace } from "../src/domain/workspace.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
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

console.log("=== workspace portability fallbacks (userData 移動耐性) ===\n");

const tmpRoot = mkdtempSync(join(tmpdir(), "kpdf3-portability-"));

try {
  // ---------------------------------------------------------------
  // (1) getSourceBytes: external_path stale → sibling .source.pdf fallback
  // ---------------------------------------------------------------
  console.log("--- (1) sidecar external_path fallback ---");

  const pdfBytes = buildTestPdf();
  const dirA = join(tmpRoot, "machine-a");
  mkdirSync(dirA, { recursive: true });
  const wsPathA = join(dirA, "big.kpdf3");

  let ws = Workspace.create(wsPathA);
  await ws.importPdfBytes(pdfBytes, "big.pdf");

  // blob 経路の回帰: external_path なし → BLOB から従来どおり読める
  ok(
    Buffer.compare(ws.getSourceBytes(), pdfBytes) === 0,
    "blob 経路 (external_path なし) は従来どおり読める",
  );

  // 巨大 PDF サイドカー状態を合成 (200MB を実際に書かずに external 経路へ):
  // blob を 0-byte 化し external_path をセット、実体はサイドカーに書く
  const sidecarA = `${wsPathA}.source.pdf`;
  writeFileSync(sidecarA, pdfBytes);
  ws.db
    .prepare("UPDATE source_pdf SET external_path = ?, blob = zeroblob(0) WHERE id = 1")
    .run(sidecarA);

  ok(
    Buffer.compare(ws.getSourceBytes(), pdfBytes) === 0,
    "external_path が生きている正常系は verbatim read (回帰なし)",
  );
  ws.close();

  // 「別マシンへ移行」を合成: .kpdf3 + サイドカーを dirB へコピー。
  // external_path は dirA (旧マシン) のまま → 旧パスを消して stale 化
  const dirB = join(tmpRoot, "machine-b");
  mkdirSync(dirB, { recursive: true });
  const wsPathB = join(dirB, "big.kpdf3");
  copyFileSync(wsPathA, wsPathB);
  copyFileSync(sidecarA, `${wsPathB}.source.pdf`);
  rmSync(dirA, { recursive: true, force: true }); // 旧マシンのパスは存在しない

  ws = Workspace.open(wsPathB);
  const got = ws.getSourceBytes();
  ok(
    got !== null && Buffer.compare(got, pdfBytes) === 0,
    "external_path stale + 隣に .source.pdf → sibling fallback で読める",
  );

  // 隣のサイドカーも無ければ従来どおり null (ソース欠落扱い)
  rmSync(`${wsPathB}.source.pdf`, { force: true });
  ok(
    ws.getSourceBytes() === null,
    "external_path stale + sibling も無し → null (従来のソース欠落挙動)",
  );
  ws.close();

  // ---------------------------------------------------------------
  // (2) registry: workspace_path stale → workspacePathFor(id) 自己修復
  // ---------------------------------------------------------------
  console.log("\n--- (2) registry workspace_path self-heal ---");

  const fakeUserData = join(tmpRoot, "user-data");
  mkdirSync(fakeUserData, { recursive: true });
  app.setPath("userData", fakeUserData);
  const registry = await import("../src/main/workspace-registry.js");

  // heal ケース: 登録パスは「旧マシン」の絶対パス、実体は現 workspacesDir
  const idHeal = registry.generateWorkspaceId();
  const liveHeal = registry.workspacePathFor(idHeal);
  writeFileSync(liveHeal, "dummy");
  const stalePath = join(tmpRoot, "old-machine", "workspaces", `${idHeal}.kpdf3`);
  registry.registerWorkspace({
    fingerprint: "fp-heal",
    workspaceId: idHeal,
    workspacePath: stalePath,
    sourcePdfPath: "C:\\old\\a.pdf",
    sourcePdfName: "a.pdf",
  });
  const healed = registry.findWorkspaceByFingerprint("fp-heal");
  ok(
    healed.workspacePath === liveHeal,
    "stale workspace_path + 現 workspacesDir に実体 → 導出パスへ自己修復",
  );
  ok(
    registry.findWorkspaceByFingerprint("fp-heal").workspacePath === liveHeal,
    "修復は DB に永続化される (再クエリでも導出パス)",
  );

  // 回帰ケース: 登録パスが生きていればそのまま (heal 分岐に入らない)
  const idOk = registry.generateWorkspaceId();
  const liveOk = registry.workspacePathFor(idOk);
  writeFileSync(liveOk, "dummy");
  registry.registerWorkspace({
    fingerprint: "fp-ok",
    workspaceId: idOk,
    workspacePath: liveOk,
  });
  ok(
    registry.findWorkspaceByFingerprint("fp-ok").workspacePath === liveOk,
    "workspace_path が生きている正常系は不変 (回帰なし)",
  );

  // 両方消失ケース: stale のまま返す (呼び出し側の新規作成挙動は従来どおり)
  const idGone = registry.generateWorkspaceId();
  const goneStale = join(tmpRoot, "old-machine", "workspaces", `${idGone}.kpdf3`);
  registry.registerWorkspace({
    fingerprint: "fp-gone",
    workspaceId: idGone,
    workspacePath: goneStale,
  });
  ok(
    registry.findWorkspaceByFingerprint("fp-gone").workspacePath === goneStale,
    "stale + 導出先にも実体なし → 行は無変更で返す (従来挙動)",
  );

  ok(registry.findWorkspaceByFingerprint("fp-none") === null, "未登録 fingerprint は null");

  registry.closeRegistry();

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
