// K-PDF3 renderer entry (M2, ADR-0006).
//
// PDF-first UX: a single「開く」button (and File menu equivalent) takes
// the user through the file picker; main resolves the sidecar `.kpdf3`
// automatically.

import { Viewer } from "./viewer.js";
import { MenuBar } from "./menu-bar.js";
import { ProjectStore } from "../domain/project-store.js";
import { HistoryStack } from "../domain/history.js";
import {
  AddOverlayCommand,
  UpdateOverlayCommand,
  RemoveOverlayCommand,
} from "../domain/commands.js";

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
const btnModeText = $("btn-mode-text");
const btnModeStamp = $("btn-mode-stamp");
const wsLabel = $("ws-label");
const wsStatus = $("ws-status");
const viewerContainer = $("viewer-container");

const viewer = new Viewer(viewerContainer, {
  projectStore,
  onPagePointerDown: handlePagePointerDown,
  onOverlayClick: handleOverlayClick,
  onTextEditCommit: handleTextEditCommit,
  onOverlayDragEnd: handleOverlayDragEnd,
  onOverlayContextMenu: showOverlayContextMenu,
});

let isOpen = false;
/** @type {'none' | 'text' | 'stamp'} */
let placementMode = "none";
let activeSourceName = "";

function handlePagePointerDown(pageNo, x, y) {
  if (!isOpen) return;
  if (placementMode === "text") {
    placeText(pageNo, x, y);
  } else if (placementMode === "stamp") {
    placeStamp(pageNo, x, y);
  }
}

function placeText(pageNo, x, y) {
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
  if (cmd._snapshot) {
    setTimeout(() => viewer.enterTextEdit(cmd._snapshot.id), 0);
  }
}

function placeStamp(pageNo, x, y) {
  // Default 60×60-PDF-point round red seal centred on click.
  const W = 60;
  const H = 60;
  const cmd = new AddOverlayCommand(projectStore, {
    pageNo,
    type: "stamp",
    x: x - W / 2,
    y: y - H / 2,
    w: W,
    h: H,
    zOrder: 0,
    properties: {
      kind: "text-frame",
      text: "印",
      color: "#cc0000",
      frame: "circle",
      fontSize: 14,
    },
  });
  history.execute(cmd);
  if (cmd._snapshot) {
    setTimeout(() => viewer.enterTextEdit(cmd._snapshot.id), 0);
  }
}

function handleOverlayClick(id) {
  if (!isOpen) return;
  viewer.enterTextEdit(id);
}

function handleTextEditCommit(id, newText) {
  if (!isOpen) return;
  const ov = projectStore.get(id);
  if (!ov) return;
  history.execute(
    new UpdateOverlayCommand(projectStore, id, {
      properties: { ...ov.properties, text: newText },
    }),
  );
}

function handleOverlayDragEnd(id, newX, newY) {
  if (!isOpen) return;
  const ov = projectStore.get(id);
  if (!ov) return;
  // No-op when the gesture didn't actually move anything (rounding edge).
  if (ov.x === newX && ov.y === newY) return;
  history.execute(
    new UpdateOverlayCommand(projectStore, id, { x: newX, y: newY }),
  );
}

// ---- Overlay context menu (right-click) ------------------------------
const ctxOverlay = $("ctx-overlay");

function showOverlayContextMenu(overlayId, x, y) {
  ctxOverlay.dataset.targetId = overlayId;
  // Ensure we don't run off the right / bottom edge.
  ctxOverlay.style.left = `${x}px`;
  ctxOverlay.style.top = `${y}px`;
  ctxOverlay.hidden = false;
}

function hideOverlayContextMenu() {
  ctxOverlay.hidden = true;
  delete ctxOverlay.dataset.targetId;
}

ctxOverlay.addEventListener("click", (e) => {
  e.stopPropagation();
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.dataset.ctx;
  const id = ctxOverlay.dataset.targetId;
  hideOverlayContextMenu();
  if (!action || !id) return;
  if (action === "delete") {
    history.execute(new RemoveOverlayCommand(projectStore, id));
  }
});

document.addEventListener("click", () => hideOverlayContextMenu());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideOverlayContextMenu();
});

/**
 * @param {'none' | 'text' | 'stamp'} mode
 */
function setPlacementMode(mode) {
  placementMode = mode;
  viewer.setEditMode(mode !== "none");
  btnModeText.classList.toggle("toggled", mode === "text");
  btnModeStamp.classList.toggle("toggled", mode === "stamp");
}

function setOpen(open) {
  isOpen = open;
  btnOpen.disabled = open;
  btnClose.disabled = !open;
  btnModeText.disabled = !open;
  btnModeStamp.disabled = !open;
  if (!open) setPlacementMode("none");
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
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

function refreshMenuState() {
  const z = viewer.zoom;
  menuBar.setEnabled({
    open: !isOpen,
    close: isOpen,
    save: isOpen && projectStore.isDirty(),
    undo: isOpen && history.canUndo(),
    redo: isOpen && history.canRedo(),
    "zoom-in": isOpen && z < ZOOM_STEPS[ZOOM_STEPS.length - 1],
    "zoom-out": isOpen && z > ZOOM_STEPS[0],
    "zoom-fit": isOpen,
    "zoom-100": isOpen && Math.abs(z - 1.0) > 1e-6,
    // Still M3+ stubs
    export: false,
    cut: false,
    copy: false,
    paste: false,
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

function applyZoom(z) {
  viewer.setZoom(z);
  refreshMenuState();
  if (isOpen) wsStatus.textContent = `${Math.round(z * 100)}%`;
}

function actionZoomIn() {
  if (!isOpen) return;
  const cur = viewer.zoom;
  const next = ZOOM_STEPS.find((s) => s > cur + 1e-6);
  if (next !== undefined) applyZoom(next);
}

function actionZoomOut() {
  if (!isOpen) return;
  const cur = viewer.zoom;
  let next;
  for (const s of ZOOM_STEPS) if (s < cur - 1e-6) next = s;
  if (next !== undefined) applyZoom(next);
}

function actionZoom100() {
  if (!isOpen) return;
  applyZoom(1.0);
}

function actionZoomFit() {
  if (!isOpen || !viewer.registry || viewer.registry.count() === 0) return;
  let maxCanonW = 0;
  for (let p = 1; p <= viewer.registry.count(); p++) {
    const sz = viewer.registry.getCanonicalSize(p);
    if (sz.w > maxCanonW) maxCanonW = sz.w;
  }
  // 32 px breathing room left + right
  const targetWidth = viewerContainer.clientWidth - 32;
  if (targetWidth <= 0 || maxCanonW <= 0) return;
  applyZoom(targetWidth / maxCanonW);
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
    "zoom-in": actionZoomIn,
    "zoom-out": actionZoomOut,
    "zoom-100": actionZoom100,
    "zoom-fit": actionZoomFit,
  },
});

// ---- Keyboard shortcuts ----------------------------------------------
// M3-3 will need to skip these when an editable text overlay has focus
// (let the contentEditable / textarea handle its own undo).
window.addEventListener("keydown", (e) => {
  if (!isOpen) return;
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (!ctrlOrCmd) return;
  const target = e.target;
  const inText =
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA");
  const key = e.key.toLowerCase();

  if (key === "s") {
    // Ctrl+S works even inside text edit — commit the edit first via blur,
    // then save.
    e.preventDefault();
    if (inText && target instanceof HTMLElement) target.blur();
    setTimeout(() => actionSave(), 0);
    return;
  }

  // Other shortcuts (undo/redo) defer to the host text input's native
  // handling while editing.
  if (inText) return;

  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    actionUndo();
  } else if ((key === "z" && e.shiftKey) || key === "y") {
    e.preventDefault();
    actionRedo();
  } else if (key === "=" || key === "+") {
    // Both Ctrl+= and Ctrl+Shift+= (= +) zoom in
    e.preventDefault();
    actionZoomIn();
  } else if (key === "-") {
    e.preventDefault();
    actionZoomOut();
  } else if (key === "0") {
    e.preventDefault();
    actionZoom100();
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
btnModeText.addEventListener("click", () =>
  setPlacementMode(placementMode === "text" ? "none" : "text"),
);
btnModeStamp.addEventListener("click", () =>
  setPlacementMode(placementMode === "stamp" ? "none" : "stamp"),
);

// ---- Initial state ----------------------------------------------------
setOpen(false);

(async () => {
  const info = await kpdf3.getAppInfo();
  $("appinfo").textContent = `v${info.appVersion} / Electron ${info.electronVersion}`;
})();
