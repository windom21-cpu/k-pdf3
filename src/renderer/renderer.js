// K-PDF3 renderer entry (M2, ADR-0006).
//
// PDF-first UX: a single「開く」button (and File menu equivalent) takes
// the user through the file picker; main resolves the sidecar `.kpdf3`
// automatically.

import { Viewer } from "./viewer.js";
import { MenuBar } from "./menu-bar.js";
import { ProjectStore } from "../domain/project-store.js";
import { HistoryStack } from "../domain/history.js";
import { AddOverlayCommand } from "../domain/commands.js";

const { kpdf3 } = window;

/**
 * Renderer-side overlay store (M3 architecture: ProjectStore lives in the
 * renderer; main process only handles SQLite I/O on save / load). Reset
 * to the saved snapshot whenever a PDF is opened.
 */
const projectStore = new ProjectStore();
const history = new HistoryStack();

const $ = (id) => document.getElementById(id);
const btnOpen = $("btn-open");
const btnClose = $("btn-close");
const btnEditMode = $("btn-edit-mode");
const wsLabel = $("ws-label");
const wsStatus = $("ws-status");
const viewerContainer = $("viewer-container");

const viewer = new Viewer(viewerContainer, {
  projectStore,
  onPagePointerDown: handlePagePointerDown,
});

let isOpen = false;
let isEditMode = false;

function handlePagePointerDown(pageNo, x, y) {
  if (!isOpen || !isEditMode) return;
  // Default: drop a 100×20 (PDF point) text overlay anchored at the click.
  const cmd = new AddOverlayCommand(projectStore, {
    pageNo,
    type: "text",
    x,
    y,
    w: 100,
    h: 20,
    zOrder: 0,
    properties: {
      text: "テキスト",
      fontSize: 12,
      color: "#000000",
      fontId: "default",
    },
  });
  history.execute(cmd);
}

function setEditMode(on) {
  isEditMode = !!on;
  viewer.setEditMode(isEditMode);
  btnEditMode.classList.toggle("toggled", isEditMode);
  btnEditMode.textContent = isEditMode ? "編集モード ON" : "編集モード";
}

function setOpen(open) {
  isOpen = open;
  btnOpen.disabled = open;
  btnClose.disabled = !open;
  btnEditMode.disabled = !open;
  if (!open) setEditMode(false);
  refreshMenuState();
}

/**
 * Recompute menu enabled state from the current open / history state.
 * Called whenever isOpen changes or history fires its listener.
 */
function refreshMenuState() {
  menuBar.setEnabled({
    open: !isOpen,
    close: isOpen,
    // M3-2: undo/redo wired
    undo: isOpen && history.canUndo(),
    redo: isOpen && history.canRedo(),
    // Still M3+ stubs
    save: false,
    export: false,
    cut: false,
    copy: false,
    paste: false,
    "zoom-in": false,
    "zoom-out": false,
    "zoom-fit": false,
    "zoom-100": false,
  });
}

history.subscribe(() => refreshMenuState());

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
    history.clear();
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
  history.clear();
  setOpen(false);
  await refreshViewer();
}

function actionUndo() {
  history.undo();
}

function actionRedo() {
  history.redo();
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
    undo: actionUndo,
    redo: actionRedo,
  },
});

// ---- Keyboard shortcuts ----------------------------------------------
// M3-3 will need to skip these when an editable text overlay has focus
// (let the contentEditable / textarea handle its own undo).
window.addEventListener("keydown", (e) => {
  if (!isOpen) return;
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (!ctrlOrCmd) return;
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    actionUndo();
  } else if ((key === "z" && e.shiftKey) || key === "y") {
    e.preventDefault();
    actionRedo();
  }
});

// ---- Toolbar buttons --------------------------------------------------
btnOpen.addEventListener("click", actionOpen);
btnClose.addEventListener("click", actionClose);
btnEditMode.addEventListener("click", () => setEditMode(!isEditMode));

// ---- Initial state ----------------------------------------------------
setOpen(false);

(async () => {
  const info = await kpdf3.getAppInfo();
  $("appinfo").textContent = `v${info.appVersion} / Electron ${info.electronVersion}`;
})();
