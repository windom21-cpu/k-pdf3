// K-PDF3 renderer entry (M2 step 4b).
// Wires the workspace UI (open / new / close) to the Viewer.

import { Viewer } from "./viewer.js";

const { kpdf3 } = window;

const $ = (id) => document.getElementById(id);
const btnNew = $("btn-new");
const btnOpen = $("btn-open");
const btnClose = $("btn-close");
const wsLabel = $("ws-label");
const statusEl = $("ws-status");
const viewerContainer = $("viewer-container");

const viewer = new Viewer(viewerContainer);

let workspaceOpen = false;

function setOpen(open) {
  workspaceOpen = open;
  btnNew.disabled = open;
  btnOpen.disabled = open;
  btnClose.disabled = !open;
}

async function refreshViewer() {
  if (!workspaceOpen) {
    statusEl.textContent = "(no workspace)";
    wsLabel.textContent = "";
    viewer.unload();
    return;
  }
  const pages = await kpdf3.getPages();
  const meta = await kpdf3.getSourceMeta();
  if (pages.length === 0) {
    statusEl.textContent = "workspace open — no PDF imported yet";
    wsLabel.textContent = "";
    viewer.unload();
    return;
  }
  wsLabel.textContent = meta?.fileName ?? "";
  statusEl.textContent = `${pages.length} pages`;
  viewer.load(pages);
}

btnNew.addEventListener("click", async () => {
  const wsPath = await kpdf3.pickWorkspaceSave();
  if (!wsPath) return;
  const pdfPath = await kpdf3.pickPdf();
  if (!pdfPath) return;
  // "新規" flow: overwrite any existing file at this path (showSaveDialog
  // already prompted for confirmation).
  await kpdf3.createWorkspace(wsPath);
  await kpdf3.importPdf(pdfPath);
  setOpen(true);
  await refreshViewer();
});

btnOpen.addEventListener("click", async () => {
  const wsPath = await kpdf3.pickWorkspaceOpen();
  if (!wsPath) return;
  await kpdf3.openWorkspace(wsPath);
  setOpen(true);
  await refreshViewer();
});

btnClose.addEventListener("click", async () => {
  await kpdf3.closeWorkspace();
  setOpen(false);
  await refreshViewer();
});

(async () => {
  const info = await kpdf3.getAppInfo();
  $("appinfo").textContent =
    `app v${info.appVersion} / Electron ${info.electronVersion} / Node ${info.nodeVersion} / ${info.platform}`;
})();
