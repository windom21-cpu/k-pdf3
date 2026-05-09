// K-PDF3 renderer entry (M2, ADR-0006).
//
// PDF-first UX: a single「開く」button (and File menu equivalent) takes
// the user through the file picker; main resolves the sidecar `.kpdf3`
// automatically.

import { Viewer } from "./viewer.js";
import { MenuBar } from "./menu-bar.js";
import { ProjectStore } from "../domain/project-store.js";

const { kpdf3 } = window;

/**
 * Renderer-side overlay store (M3 architecture: ProjectStore lives in the
 * renderer; main process only handles SQLite I/O on save / load). Reset
 * to the saved snapshot whenever a PDF is opened. Editing UI lands M3-3.
 */
const projectStore = new ProjectStore();

const $ = (id) => document.getElementById(id);
const btnOpen = $("btn-open");
const btnClose = $("btn-close");
const wsLabel = $("ws-label");
const wsStatus = $("ws-status");
const viewerContainer = $("viewer-container");

const viewer = new Viewer(viewerContainer);

let isOpen = false;

function setOpen(open) {
  isOpen = open;
  btnOpen.disabled = open;
  btnClose.disabled = !open;
  menuBar.setEnabled({
    open: !open,
    close: open,
    // save / export / undo / redo / zoom-* are still M3+ stubs
    save: false,
    export: false,
    undo: false,
    redo: false,
    cut: false,
    copy: false,
    paste: false,
    "zoom-in": false,
    "zoom-out": false,
    "zoom-fit": false,
    "zoom-100": false,
  });
}

async function refreshViewer() {
  if (!isOpen) {
    wsLabel.textContent = "";
    wsStatus.textContent = "PDF を「開く」で読み込みます";
    viewer.unload();
    return;
  }
  const meta = await kpdf3.getSourceMeta();
  const pages = await kpdf3.getPages();
  if (!meta || pages.length === 0) {
    wsLabel.textContent = "";
    wsStatus.textContent = "(PDF が読み込めませんでした)";
    viewer.unload();
    return;
  }
  wsLabel.textContent = meta.fileName ?? "";
  wsStatus.textContent = `${pages.length} ページ`;
  viewer.load(pages);
}

async function actionOpen() {
  const pdfPath = await kpdf3.pickPdf();
  if (!pdfPath) return;
  try {
    const result = await kpdf3.openPdfFile(pdfPath);
    projectStore.reset(result.overlays ?? []);
    setOpen(true);
    await refreshViewer();
  } catch (err) {
    console.error("[renderer] openPdfFile failed:", err);
    wsStatus.textContent = `エラー: ${err.message ?? err}`;
  }
}

async function actionClose() {
  await kpdf3.closeWorkspace();
  projectStore.reset([]);
  setOpen(false);
  await refreshViewer();
}

async function actionAbout() {
  const info = await kpdf3.getAppInfo();
  const lines = [
    `K-PDF3 v${info.appVersion}`,
    "法律実務向け PDF Workspace",
    "",
    `Electron ${info.electronVersion} / Node ${info.nodeVersion}`,
    `Platform: ${info.platform}`,
  ];
  alert(lines.join("\n"));
}

function actionExit() {
  window.close();
}

// ---- Menu bar ---------------------------------------------------------
const menuBar = new MenuBar({
  menuBar: $("menu-bar"),
  dropdowns: {
    file: $("menu-file"),
    edit: $("menu-edit"),
    view: $("menu-view"),
    help: $("menu-help"),
  },
  actions: {
    open: actionOpen,
    close: actionClose,
    exit: actionExit,
    about: actionAbout,
  },
});

// ---- Toolbar buttons --------------------------------------------------
btnOpen.addEventListener("click", actionOpen);
btnClose.addEventListener("click", actionClose);

// ---- Initial state ----------------------------------------------------
setOpen(false);

(async () => {
  const info = await kpdf3.getAppInfo();
  $("appinfo").textContent = `v${info.appVersion} / Electron ${info.electronVersion}`;
})();
