// ADR-0027: ワークスペースの整理 (手動お掃除) dialog.
//
// Flow: retention-months select → scan (IPC, read-only) → preview list
// (count / total size / per-file rows, protected counts) → customConfirm →
// execute (IPC: trash + index.db rows) → result. All destructive work is in
// the main process; this module only presents the scan result it was given.

import { customConfirm } from "./dialogs.js";
import { showBusy, hideBusy } from "./busy-modal.js";

const dialog = document.getElementById("ws-cleanup-dialog");
const monthsSel = document.getElementById("ws-cleanup-months");
const scanBtn = document.getElementById("ws-cleanup-scan");
const summaryEl = document.getElementById("ws-cleanup-summary");
const listEl = document.getElementById("ws-cleanup-list");
const runBtn = document.getElementById("ws-cleanup-run");
const closeBtn = document.getElementById("ws-cleanup-close");

/** @type {null | Awaited<ReturnType<typeof window.kpdf3.workspaceCleanupScan>>} */
let lastScan = null;

function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function fmtDate(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function resetResults() {
  lastScan = null;
  summaryEl.hidden = true;
  summaryEl.textContent = "";
  listEl.hidden = true;
  listEl.textContent = "";
  runBtn.disabled = true;
}

export function openWorkspaceCleanupDialog() {
  resetResults();
  dialog.hidden = false;
  setTimeout(() => scanBtn.focus(), 0);
}

function closeDialog() {
  dialog.hidden = true;
  resetResults();
}

function renderScan(res) {
  lastScan = res;
  const kept = [];
  if (res.keptPredecessors) kept.push(`編集可能マスター ${res.keptPredecessors} 件`);
  if (res.keptOpen) kept.push(`開いているタブ ${res.keptOpen} 件`);
  if (res.unreadable) kept.push(`読み取り不能 ${res.unreadable} 件`);
  const keptNote = kept.length ? `（保護: ${kept.join("・")}）` : "";
  summaryEl.textContent =
    res.candidates.length === 0
      ? `整理できるワークスペースはありません。スキャン ${res.scanned} 件${keptNote}`
      : `候補 ${res.candidates.length} 件 / 合計 ${fmtBytes(res.totalCandidateBytes)}` +
        `（スキャン ${res.scanned} 件、期間内 ${res.keptRecent} 件${keptNote ? "、" + keptNote.slice(1, -1) : ""}）`;
  summaryEl.hidden = false;

  listEl.textContent = "";
  if (res.candidates.length > 0) {
    const table = document.createElement("table");
    table.className = "ws-cleanup-table";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const h of ["ファイル名", "最終アクセス", "編集", "サイズ"]) {
      const th = document.createElement("th");
      th.textContent = h;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const c of res.candidates) {
      const tr = document.createElement("tr");
      const cells = [
        c.sourceName ?? c.id,
        fmtDate(c.lastAccessMs),
        c.hasEdits ? "あり" : "なし",
        fmtBytes(c.sizeBytes),
      ];
      cells.forEach((v, i) => {
        const td = document.createElement("td");
        td.textContent = v;
        if (i > 0) td.className = "ws-cleanup-cell-num";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    listEl.appendChild(table);
    listEl.hidden = false;
  }
  runBtn.disabled = res.candidates.length === 0;
}

async function doScan() {
  scanBtn.disabled = true;
  runBtn.disabled = true;
  showBusy("ワークスペースの整理", "ワークスペースをスキャンしています...", 100);
  try {
    const res = await window.kpdf3.workspaceCleanupScan(Number(monthsSel.value));
    renderScan(res);
  } catch (err) {
    console.error("[ws-cleanup] scan failed", err);
    summaryEl.textContent = "スキャンに失敗しました。";
    summaryEl.hidden = false;
  } finally {
    hideBusy();
    scanBtn.disabled = false;
  }
}

async function doRun() {
  if (!lastScan || lastScan.candidates.length === 0) return;
  const n = lastScan.candidates.length;
  const size = fmtBytes(lastScan.totalCandidateBytes);
  const ok = await customConfirm({
    title: "ワークスペースの整理",
    message: `${n} 件のワークスペース (${size}) をごみ箱へ移動します。`,
    warning:
      "移動したワークスペースの「編集可能な状態」は失われます。元の PDF ファイルはそのまま残ります。",
    okLabel: "ごみ箱へ移動",
  });
  if (!ok) return;
  runBtn.disabled = true;
  scanBtn.disabled = true;
  showBusy("ワークスペースの整理", "ごみ箱へ移動しています...", 100);
  let result = null;
  try {
    result = await window.kpdf3.workspaceCleanupExecute(lastScan.candidates.map((c) => c.id));
  } catch (err) {
    console.error("[ws-cleanup] execute failed", err);
  } finally {
    hideBusy();
    scanBtn.disabled = false;
  }
  if (!result) {
    await customConfirm({
      title: "ワークスペースの整理",
      message: "整理の実行に失敗しました。",
      cancelLabel: null,
    });
    return;
  }
  const lines = [
    `${result.removed} 件 / ${fmtBytes(result.freedBytes)} をごみ箱へ移動しました。`,
    "ごみ箱を空にするとディスク領域が解放されます。",
  ];
  if (result.skipped) lines.push(`${result.skipped} 件はスキップしました (使用中など)。`);
  if (result.failed) lines.push(`${result.failed} 件は移動できませんでした。`);
  await customConfirm({
    title: "ワークスペースの整理",
    message: lines.join("\n"),
    cancelLabel: null,
  });
  // 結果を反映した状態に更新 (残があるか一目で分かる)
  await doScan();
}

scanBtn?.addEventListener("click", doScan);
runBtn?.addEventListener("click", doRun);
closeBtn?.addEventListener("click", closeDialog);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && dialog && !dialog.hidden) closeDialog();
});
