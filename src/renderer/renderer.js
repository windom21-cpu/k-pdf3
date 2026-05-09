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
let activeSourceName = "";

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
  refreshDirtyIndicator();
}

/** Refresh the title bar / file label / status bar to reflect the dirty flag. */
function refreshDirtyIndicator() {
  const dirty = isOpen && projectStore.isDirty();
  const prefix = dirty ? "● " : "";
  if (isOpen) {
    wsLabel.textContent = `${prefix}${activeSourceName}`;
    document.title = `${prefix}${activeSourceName || "K-PDF3"} — K-PDF3`;
  } else {
    wsLabel.textContent = "";
    document.title = "K-PDF3";
  }
}

/**
 * Recompute menu enabled state from the current open / history state.
 * Called whenever isOpen changes or history fires its listener.
 */
function refreshMenuState() {
  menuBar.setEnabled({
    open: !isOpen,
    close: isOpen,
    save: isOpen && projectStore.isDirty(),
    undo: isOpen && history.canUndo(),
    redo: isOpen && history.canRedo(),
    // Still M3+ stubs
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
projectStore.subscribe(() => {
  refreshDirtyIndicator();
  refreshMenuState();
});

async function refreshViewer() {
  if (!isOpen) {
    activeSourceName = "";
    wsStatus.textContent = "PDF を「開く」で読み込みます";
    viewer.unload();
    refreshDirtyIndicator();
    return;
  }
  const meta = await kpdf3.getSourceMeta();
  const pages = await kpdf3.getPages();
  if (!meta || pages.length === 0) {
    activeSourceName = "";
    wsStatus.textContent = "(PDF が読み込めませんでした)";
    viewer.unload();
    refreshDirtyIndicator();
    return;
  }
  activeSourceName = meta.fileName ?? "";
  wsStatus.textContent = `${pages.length} ページ`;
  viewer.load(pages);
  refreshDirtyIndicator();
}

function confirmDiscardIfDirty() {
  if (!projectStore.isDirty()) return true;
  return window.confirm(
    "未保存の変更があります。\n変更を破棄して続行しますか？",
  );
}

async function actionOpen() {
  if (!confirmDiscardIfDirty()) return;
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
  if (!confirmDiscardIfDirty()) return;
  await kpdf3.closeWorkspace();
  projectStore.reset([]);
  history.clear();
  setOpen(false);
  await refreshViewer();
}

async function actionSave() {
  if (!isOpen) return;
  // No-op when nothing has changed since the last save.
  if (!projectStore.isDirty()) return;
  try {
    const snapshot = projectStore.snapshot();
    await kpdf3.saveOverlays(snapshot);
    projectStore.markClean();
    refreshDirtyIndicator();
    refreshMenuState();
    wsStatus.textContent = `保存しました (${snapshot.length} overlays)`;
  } catch (err) {
    console.error("[renderer] saveOverlays failed:", err);
    wsStatus.textContent = `保存失敗: ${err.message ?? err}`;
  }
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
    save: actionSave,
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
  } else if (key === "s") {
    e.preventDefault();
    actionSave();
  }
});

// Warn before reloading / closing the window if there are unsaved changes.
window.addEventListener("beforeunload", (e) => {
  if (projectStore.isDirty()) {
    e.preventDefault();
    e.returnValue = "";
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
