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
import { composePagesForExport } from "./exporter.js";

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
const btnModeRedaction = $("btn-mode-redaction");
const wsLabel = $("ws-label");
const wsStatus = $("ws-status");
const pageIndicator = $("page-indicator");
const viewerContainer = $("viewer-container");
const sidebar = $("sidebar");
const bookmarkTree = $("bookmark-tree");
const busyModal = $("busy-modal");
const busyTitle = $("busy-title");
const busyMessage = $("busy-message");
const busyProgressBar = $("busy-progress-bar");

/**
 * Show / update / hide a 98-styled modal busy indicator with a progress
 * bar. Used for long operations (export / print) where the user might
 * otherwise think the app froze.
 */
function showBusy(title, message, percent = 0) {
  busyTitle.textContent = title;
  busyMessage.textContent = message;
  busyProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  busyModal.hidden = false;
}
function updateBusy(message, percent) {
  if (typeof message === "string") busyMessage.textContent = message;
  if (typeof percent === "number") {
    busyProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
}
function hideBusy() {
  busyModal.hidden = true;
}

const viewer = new Viewer(viewerContainer, {
  projectStore,
  onPagePointerDown: handlePagePointerDown,
  onOverlayClick: handleOverlayClick,
  onTextEditCommit: handleTextEditCommit,
  onOverlayDragEnd: handleOverlayDragEnd,
  onOverlayResizeEnd: handleOverlayResizeEnd,
  onOverlayContextMenu: showOverlayContextMenu,
  onPageChange: updatePageIndicator,
});

function updatePageIndicator(current, total) {
  if (!total || total === 0) {
    pageIndicator.textContent = "";
    return;
  }
  pageIndicator.textContent = `${current} / ${total}`;
}

let isOpen = false;
/** @type {'none' | 'text' | 'stamp' | 'redaction'} */
let placementMode = "none";
let activeSourceName = "";

function handlePagePointerDown(pageNo, x, y, evt, div) {
  if (!isOpen) return;
  if (placementMode === "text") {
    placeText(pageNo, x, y);
  } else if (placementMode === "stamp") {
    placeStamp(pageNo, x, y);
  } else if (placementMode === "redaction") {
    startRedactionDrag(pageNo, x, y, evt, div);
  }
}

/**
 * Drag-to-define rectangle for a redaction (M5-1). On a page pointerdown
 * in 墨消し mode we capture the pointer, paint a live preview rect, and
 * commit it as an overlay on pointerup. Movements smaller than 5 PDF
 * point in either dimension fall back to a default 200×30 rect anchored
 * at the click — handles the「クリックした、もう離した」case without
 * leaving an invisible 0×0 redaction.
 */
function startRedactionDrag(pageNo, startX, startY, downEvt, div) {
  if (!div || !downEvt || typeof div.setPointerCapture !== "function") {
    placeRedaction(pageNo, startX - 100, startY - 15, 200, 30);
    setPlacementMode("none");
    return;
  }
  const pointerId = downEvt.pointerId;
  const z = viewer.zoom;
  const preview = document.createElement("div");
  preview.className = "redaction-preview";
  preview.style.left = `${startX * z}px`;
  preview.style.top = `${startY * z}px`;
  preview.style.width = "0px";
  preview.style.height = "0px";
  div.appendChild(preview);

  let curX = startX;
  let curY = startY;
  try {
    div.setPointerCapture(pointerId);
  } catch {
    /* ignore */
  }

  function onMove(e) {
    if (e.pointerId !== pointerId) return;
    const rect = div.getBoundingClientRect();
    curX = (e.clientX - rect.left) / z;
    curY = (e.clientY - rect.top) / z;
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);
    preview.style.left = `${x * z}px`;
    preview.style.top = `${y * z}px`;
    preview.style.width = `${w * z}px`;
    preview.style.height = `${h * z}px`;
  }

  function cleanup() {
    try {
      div.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    div.removeEventListener("pointermove", onMove);
    div.removeEventListener("pointerup", onUp);
    div.removeEventListener("pointercancel", onCancel);
    preview.remove();
  }

  function onUp(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);
    if (w < 5 || h < 5) {
      placeRedaction(pageNo, startX - 100, startY - 15, 200, 30);
    } else {
      placeRedaction(pageNo, x, y, w, h);
    }
    setPlacementMode("none");
  }

  function onCancel(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
    setPlacementMode("none");
  }

  div.addEventListener("pointermove", onMove);
  div.addEventListener("pointerup", onUp);
  div.addEventListener("pointercancel", onCancel);
}

function placeRedaction(pageNo, x, y, w, h) {
  const cmd = new AddOverlayCommand(projectStore, {
    pageNo,
    type: "redaction",
    x,
    y,
    w,
    h,
    // Redactions sit above text/stamps so they actually cover content.
    zOrder: 100,
    properties: { color: "black", mode: "applied" },
  });
  history.execute(cmd);
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
  // One-shot placement: release mode now so the next click can drag /
  // edit existing overlays without accidentally placing another one.
  setPlacementMode("none");
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
  setPlacementMode("none");
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

function handleOverlayResizeEnd(id, bbox) {
  if (!isOpen) return;
  const ov = projectStore.get(id);
  if (!ov) return;
  if (
    ov.x === bbox.x &&
    ov.y === bbox.y &&
    ov.w === bbox.w &&
    ov.h === bbox.h
  ) {
    return;
  }
  history.execute(new UpdateOverlayCommand(projectStore, id, bbox));
}

// ---- Overlay context menu (right-click) ------------------------------
const ctxOverlay = $("ctx-overlay");

function showOverlayContextMenu(overlayId, x, y) {
  ctxOverlay.dataset.targetId = overlayId;
  ctxOverlay.style.left = `${x}px`;
  ctxOverlay.style.top = `${y}px`;
  ctxOverlay.hidden = false;
}

function hideOverlayContextMenu() {
  ctxOverlay.hidden = true;
  delete ctxOverlay.dataset.targetId;
}

/**
 * Run the context-menu action for the menu item the pointer is over.
 * Wired to BOTH pointerdown and click — pointerdown gives instant
 * feedback (the perceived「very delayed」reported during M3-9 testing),
 * click acts as a backup for keyboard / accessibility flows.
 */
function dispatchOverlayCtx(target) {
  const id = ctxOverlay.dataset.targetId;
  hideOverlayContextMenu();
  if (!(target instanceof HTMLElement) || !id) return;
  const action = target.dataset.ctx;
  if (!action) return;
  if (action === "delete") {
    history.execute(new RemoveOverlayCommand(projectStore, id));
  }
}

ctxOverlay.addEventListener("pointerdown", (e) => {
  // Stop the pointerdown so the document-level listener below doesn't
  // immediately re-hide the menu before the click bubbles in.
  e.stopPropagation();
  let el = e.target;
  while (el && el !== ctxOverlay && !(el.dataset && el.dataset.ctx)) {
    el = el.parentElement;
  }
  if (el && el !== ctxOverlay) {
    dispatchOverlayCtx(el);
  }
});

// Keep the click as a no-op fallback (after pointerdown already fired)
// — prevents bubbling to document if the user mouses up on the menu.
ctxOverlay.addEventListener("click", (e) => {
  e.stopPropagation();
});

document.addEventListener("pointerdown", (ev) => {
  // Anywhere outside ctxOverlay or its children → close.
  if (ev.target instanceof Node && ctxOverlay.contains(ev.target)) return;
  hideOverlayContextMenu();
});
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
  btnModeRedaction.classList.toggle("toggled", mode === "redaction");
}

function setOpen(open) {
  isOpen = open;
  btnOpen.disabled = open;
  btnClose.disabled = !open;
  btnModeText.disabled = !open;
  btnModeStamp.disabled = !open;
  btnModeRedaction.disabled = !open;
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
    "page-prev": isOpen && viewer.currentPage > 1,
    "page-next":
      isOpen &&
      !!viewer.registry &&
      viewer.currentPage < viewer.registry.count(),
    "page-goto": isOpen,
    "toggle-bookmarks": isOpen,
    export: isOpen,
    "export-range": isOpen,
    "split-save": isOpen,
    print: isOpen,
    // Still M5+ stubs (clipboard)
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

// Refresh menu state when the page indicator changes (page-prev / page-next
// availability depends on currentPage). Done by chaining the existing
// onPageChange callback.
const _origUpdatePageIndicator = updatePageIndicator;
function updatePageIndicatorAndMenu(current, total) {
  _origUpdatePageIndicator(current, total);
  refreshMenuState();
}
viewer.onPageChange = updatePageIndicatorAndMenu;

async function refreshViewer() {
  if (!isOpen) {
    activeSourceName = "";
    wsStatus.textContent = "PDF を「開く」で読み込みます";
    viewer.unload();
    sidebar.hidden = true;
    bookmarkTree.innerHTML = "";
    refreshDirtyIndicator();
    return;
  }
  const meta = await kpdf3.getSourceMeta();
  const pages = await kpdf3.getPages();
  if (!meta || pages.length === 0) {
    activeSourceName = "";
    wsStatus.textContent = "(PDF が読み込めませんでした)";
    viewer.unload();
    sidebar.hidden = true;
    bookmarkTree.innerHTML = "";
    refreshDirtyIndicator();
    return;
  }
  activeSourceName = meta.fileName ?? "";
  wsStatus.textContent = `${pages.length} ページ`;
  viewer.load(pages);
  refreshBookmarks();
  refreshDirtyIndicator();
}

function confirmDiscardIfDirty() {
  if (!projectStore.isDirty()) return true;
  return window.confirm(
    "未保存の変更があります。\n変更を破棄して続行しますか？",
  );
}

// ---- Custom prompt dialog (Electron disables window.prompt) ---------
const rangeDialog = $("range-dialog");
const rangeTitle = $("range-title");
const rangeMessage = $("range-message");
const rangeInput = $("range-input");
const rangeConfirmBtn = $("range-confirm");
const rangeCancelBtn = $("range-cancel");
/** @type {((value: string | null) => void) | null} */
let rangeDialogResolve = null;

function showRangePrompt({ title, message, value = "" }) {
  rangeTitle.textContent = title;
  rangeMessage.textContent = message;
  rangeInput.value = value;
  rangeDialog.hidden = false;
  setTimeout(() => {
    rangeInput.focus();
    rangeInput.select();
  }, 0);
  return new Promise((resolve) => {
    rangeDialogResolve = resolve;
  });
}
function settleRange(value) {
  rangeDialog.hidden = true;
  if (rangeDialogResolve) {
    rangeDialogResolve(value);
    rangeDialogResolve = null;
  }
}
rangeConfirmBtn.addEventListener("click", () => settleRange(rangeInput.value));
rangeCancelBtn.addEventListener("click", () => settleRange(null));
rangeDialog.addEventListener("click", (e) => {
  if (e.target === rangeDialog) settleRange(null);
});
rangeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    settleRange(rangeInput.value);
  } else if (e.key === "Escape") {
    e.preventDefault();
    settleRange(null);
  }
});

// Page-goto numeric prompt
const gotoDialog = $("goto-dialog");
const gotoMessage = $("goto-message");
const gotoInput = $("goto-input");
const gotoConfirmBtn = $("goto-confirm");
const gotoCancelBtn = $("goto-cancel");
let gotoDialogResolve = null;

function showGotoPrompt({ message, value, max }) {
  gotoMessage.textContent = message;
  gotoInput.value = String(value ?? "");
  if (typeof max === "number") gotoInput.max = String(max);
  gotoDialog.hidden = false;
  setTimeout(() => {
    gotoInput.focus();
    gotoInput.select();
  }, 0);
  return new Promise((resolve) => {
    gotoDialogResolve = resolve;
  });
}
function settleGoto(value) {
  gotoDialog.hidden = true;
  if (gotoDialogResolve) {
    gotoDialogResolve(value);
    gotoDialogResolve = null;
  }
}
gotoConfirmBtn.addEventListener("click", () => settleGoto(gotoInput.value));
gotoCancelBtn.addEventListener("click", () => settleGoto(null));
gotoDialog.addEventListener("click", (e) => {
  if (e.target === gotoDialog) settleGoto(null);
});
gotoInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    settleGoto(gotoInput.value);
  } else if (e.key === "Escape") {
    e.preventDefault();
    settleGoto(null);
  }
});

// ---- Recent files dialog (M5-7) -------------------------------------
const recentDialog = $("recent-dialog");
const recentList = $("recent-list");
const recentCancelBtn = $("recent-cancel");

function hideRecentDialog() {
  recentDialog.hidden = true;
}

async function actionShowRecent() {
  if (!confirmDiscardIfDirty()) return;
  const recents = await kpdf3.listRecentPdfs();
  recentList.innerHTML = "";
  if (!recents || recents.length === 0) {
    const li = document.createElement("li");
    li.className = "recent-empty";
    li.textContent = "(履歴がまだありません)";
    recentList.appendChild(li);
  } else {
    for (const r of recents) {
      const li = document.createElement("li");
      li.className = "recent-item";
      li.title = r.sourcePdfPath ?? "";
      const name = document.createElement("div");
      name.className = "recent-item-name";
      name.textContent = r.sourcePdfName ?? "(unknown)";
      const path = document.createElement("div");
      path.className = "recent-item-path";
      path.textContent = r.sourcePdfPath ?? "";
      const meta = document.createElement("div");
      meta.className = "recent-item-meta";
      meta.textContent = `最終: ${r.updatedAt ?? ""}`;
      li.appendChild(name);
      li.appendChild(path);
      li.appendChild(meta);
      li.addEventListener("click", () => {
        hideRecentDialog();
        openPdfPath(r.sourcePdfPath);
      });
      recentList.appendChild(li);
    }
  }
  recentDialog.hidden = false;
}

recentCancelBtn.addEventListener("click", hideRecentDialog);
recentDialog.addEventListener("click", (e) => {
  if (e.target === recentDialog) hideRecentDialog();
});

async function openPdfPath(pdfPath) {
  if (!pdfPath) return;
  try {
    const result = await kpdf3.openPdfFile(pdfPath);
    projectStore.reset(result.overlays ?? []);
    history.clear();
    setOpen(true);
    await refreshViewer();
  } catch (err) {
    console.error("[renderer] openPdfFile (recent) failed:", err);
    wsStatus.textContent = `エラー: ${err.message ?? err}`;
  }
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

// ---- Print dialog (M5-4 rework) -------------------------------------
const printDialog = $("print-dialog");
const printPrinterSelect = $("print-printer");
const printCopiesInput = $("print-copies");
const printConfirmBtn = $("print-confirm");
const printCancelBtn = $("print-cancel");
/** @type {((value: { deviceName: string, copies: number } | null) => void) | null} */
let printDialogResolve = null;

function showPrintDialog(printers) {
  printPrinterSelect.innerHTML = "";
  if (printers.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(プリンタが見つかりません)";
    printPrinterSelect.appendChild(opt);
    printConfirmBtn.disabled = true;
  } else {
    printConfirmBtn.disabled = false;
    for (const p of printers) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.displayName ?? p.name;
      if (p.isDefault) opt.selected = true;
      printPrinterSelect.appendChild(opt);
    }
  }
  printCopiesInput.value = "1";
  printDialog.hidden = false;
  return new Promise((resolve) => {
    printDialogResolve = resolve;
  });
}

function hidePrintDialog() {
  printDialog.hidden = true;
}

function settlePrintDialog(value) {
  hidePrintDialog();
  if (printDialogResolve) {
    printDialogResolve(value);
    printDialogResolve = null;
  }
}

printConfirmBtn.addEventListener("click", () => {
  settlePrintDialog({
    deviceName: printPrinterSelect.value,
    copies: Math.max(1, Number(printCopiesInput.value) || 1),
  });
});
printCancelBtn.addEventListener("click", () => settlePrintDialog(null));
printDialog.addEventListener("click", (e) => {
  if (e.target === printDialog) settlePrintDialog(null);
});

/**
 * Parse a page-range string into { start, end } (1-based, inclusive).
 * Accepts "5-10", "5", "  5  -  10  ". Returns null on invalid input
 * or out-of-range values.
 */
function parsePageRange(input, total) {
  const m = String(input).match(/^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 1 || end > total || start > end) return null;
  return { start, end };
}

/**
 * Export a page range as a flatten PDF (always rasterized — byte-copy
 * doesn't apply to a sub-set of the source). Run multiple times for a
 * "split" workflow (出口 1 = pages 1-5, 出口 2 = pages 6-12, etc.).
 */
// ---- Split-save dialog (M5-6 V2) ------------------------------------
const splitDialog = $("split-dialog");
const splitFlow = $("split-flow");
const splitConfirmBtn = $("split-confirm");
const splitCancelBtn = $("split-cancel");

/** @type {Set<number>} 0-based page indices: split AFTER index i */
const splitState = {
  splitAfter: new Set(),
  /** @type {Map<number, string>} part index → user-supplied name */
  partNames: new Map(),
  /** @type {Map<number, HTMLCanvasElement>} pageNo → cached thumbnail canvas */
  thumbCache: new Map(),
};

function computeParts(totalPages, splitAfter) {
  const sortedPoints = [...splitAfter].sort((a, b) => a - b);
  const parts = [];
  let start = 0;
  for (const sp of sortedPoints) {
    parts.push({ start, end: sp });
    start = sp + 1;
  }
  parts.push({ start, end: totalPages - 1 });
  return parts;
}

function defaultPartName(idx) {
  return `part${idx + 1}`;
}

async function generateAllThumbnails(pages, onProgress) {
  // Render each page at zoom 0.25 to a tiny canvas, cache by pageNo.
  for (let i = 0; i < pages.length; i++) {
    const pageNo = pages[i].pageNo;
    if (splitState.thumbCache.has(pageNo)) continue;
    try {
      const result = await kpdf3.renderPage(pageNo, { zoom: 0.25 });
      const canvas = document.createElement("canvas");
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext("2d");
      const pixels =
        result.pixels instanceof Uint8ClampedArray
          ? result.pixels
          : new Uint8ClampedArray(result.pixels.buffer ?? result.pixels);
      ctx.putImageData(new ImageData(pixels, result.width, result.height), 0, 0);
      splitState.thumbCache.set(pageNo, canvas);
    } catch (err) {
      console.error(`[split] thumb ${pageNo} failed:`, err);
    }
    if (onProgress) onProgress({ done: i + 1, total: pages.length });
  }
}

function rebuildSplitUI(pages) {
  splitFlow.innerHTML = "";
  const parts = computeParts(pages.length, splitState.splitAfter);

  parts.forEach((part, partIdx) => {
    const section = document.createElement("div");
    section.className = "split-section";

    const header = document.createElement("div");
    header.className = "split-section-header";
    const label = document.createElement("label");
    label.textContent = `パート ${partIdx + 1}:`;
    header.appendChild(label);
    const nameInput = document.createElement("input");
    nameInput.className = "split-section-name";
    nameInput.value =
      splitState.partNames.get(partIdx) ?? defaultPartName(partIdx);
    nameInput.addEventListener("input", () => {
      splitState.partNames.set(partIdx, nameInput.value);
    });
    header.appendChild(nameInput);
    const meta = document.createElement("span");
    meta.className = "split-section-meta";
    meta.textContent = `(p.${part.start + 1}–${part.end + 1}, ${
      part.end - part.start + 1
    } ページ)`;
    header.appendChild(meta);
    section.appendChild(header);

    const row = document.createElement("div");
    row.className = "split-thumbs-row";
    for (let i = part.start; i <= part.end; i++) {
      const thumb = createThumbElement(pages[i]);
      row.appendChild(thumb);
      if (i < part.end) {
        // Inner separator — click to split here.
        const sep = document.createElement("div");
        sep.className = "split-inner-sep";
        sep.title = `ここで分割（${i + 1} と ${i + 2} の間）`;
        sep.addEventListener("click", () => {
          splitState.splitAfter.add(i);
          // Reset partNames to defaults when topology changes (simpler than
          // shifting indices).
          splitState.partNames.clear();
          rebuildSplitUI(pages);
        });
        row.appendChild(sep);
      }
    }
    section.appendChild(row);

    if (partIdx < parts.length - 1) {
      // Active split mark between this part and the next — click to merge.
      const mark = document.createElement("div");
      mark.className = "split-active-mark";
      mark.textContent = `— ▼ 分割中（クリックで結合） ▼ —`;
      mark.addEventListener("click", () => {
        splitState.splitAfter.delete(part.end);
        splitState.partNames.clear();
        rebuildSplitUI(pages);
      });
      section.appendChild(mark);
    }

    splitFlow.appendChild(section);
  });
}

function createThumbElement(pageRow) {
  const wrap = document.createElement("div");
  wrap.className = "split-thumb";
  const cached = splitState.thumbCache.get(pageRow.pageNo);
  if (cached) {
    // Clone: cached canvas may be reused elsewhere (rebuild) — DOM only
    // allows one parent, so we draw into a fresh canvas.
    const c = document.createElement("canvas");
    c.width = cached.width;
    c.height = cached.height;
    c.getContext("2d").drawImage(cached, 0, 0);
    wrap.appendChild(c);
  } else {
    const placeholder = document.createElement("div");
    placeholder.style.width = "80px";
    placeholder.style.height = "100px";
    placeholder.style.background = "#eee";
    placeholder.style.display = "flex";
    placeholder.style.alignItems = "center";
    placeholder.style.justifyContent = "center";
    placeholder.textContent = String(pageRow.pageNo);
    wrap.appendChild(placeholder);
  }
  const lbl = document.createElement("span");
  lbl.className = "split-thumb-label";
  lbl.textContent = `p.${pageRow.pageNo}`;
  wrap.appendChild(lbl);
  return wrap;
}

async function actionSplitSave() {
  if (!isOpen) return;
  const pages = await kpdf3.getPages();
  if (pages.length === 0) return;

  // Reset state for a fresh split session
  splitState.splitAfter = new Set();
  splitState.partNames = new Map();
  // thumbCache is preserved across sessions (per workspace open)

  splitFlow.innerHTML = "";
  const progressNode = document.createElement("div");
  progressNode.className = "split-progress";
  progressNode.textContent = "サムネイルを準備中... 0 / " + pages.length;
  splitFlow.appendChild(progressNode);
  splitDialog.hidden = false;

  await generateAllThumbnails(pages, ({ done, total }) => {
    progressNode.textContent = `サムネイルを準備中... ${done} / ${total}`;
  });

  rebuildSplitUI(pages);
}

splitCancelBtn.addEventListener("click", () => {
  splitDialog.hidden = true;
});
splitDialog.addEventListener("click", (e) => {
  if (e.target === splitDialog) splitDialog.hidden = true;
});

splitConfirmBtn.addEventListener("click", async () => {
  const pages = await kpdf3.getPages();
  const parts = computeParts(pages.length, splitState.splitAfter);
  const folder = await kpdf3.pickExportFolder();
  if (!folder) return;

  // Determine source basename for default filenames.
  const meta = await kpdf3.getSourceMeta();
  const sourceBase =
    (meta?.fileName ?? "split").replace(/\.[^.]+$/, "");

  splitDialog.hidden = true;
  showBusy("分割保存", `0 / ${parts.length} パート`, 0);
  try {
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      const partName =
        splitState.partNames.get(p) ?? defaultPartName(p);
      const safeName = partName.replace(/[/\\:*?"<>|]/g, "_") || `part${p + 1}`;
      const savePath = `${folder}/${sourceBase}_${safeName}.pdf`;

      updateBusy(
        `${p + 1} / ${parts.length} パート — ページを描画中...`,
        (p / parts.length) * 100,
      );
      const filteredPages = pages.slice(part.start, part.end + 1);
      const composed = await composePagesForExport({
        pages: filteredPages,
        projectStore,
        renderPage: kpdf3.renderPage,
        onProgress: ({ done, total }) => {
          const partProgress = done / total;
          updateBusy(
            `${p + 1} / ${parts.length} パート — ${done} / ${total} ページ`,
            ((p + partProgress) / parts.length) * 100,
          );
        },
      });
      await kpdf3.exportPdfRasterized({ savePath, pages: composed });
    }
    hideBusy();
    wsStatus.textContent = `分割保存完了: ${parts.length} パート → ${folder}`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] split-save failed:", err);
    wsStatus.textContent = `分割保存失敗: ${err.message ?? err}`;
  }
});

async function actionExportRange() {
  if (!isOpen) return;
  const pages = await kpdf3.getPages();
  if (pages.length === 0) return;
  const total = pages.length;
  const input = await showRangePrompt({
    title: "範囲指定で書き出し",
    message: `書き出すページ範囲 (例: 1-${total} / 5-10 / 7):`,
    value: `1-${total}`,
  });
  if (input === null) return;
  const range = parsePageRange(input, total);
  if (!range) {
    wsStatus.textContent = `無効な範囲: ${input}`;
    return;
  }
  const savePath = await kpdf3.pickExportPdf();
  if (!savePath) return;

  const filteredPages = pages.slice(range.start - 1, range.end);
  showBusy("書き出し準備", `ページ ${range.start}-${range.end} を描画しています...`, 0);
  try {
    const composed = await composePagesForExport({
      pages: filteredPages,
      projectStore,
      renderPage: kpdf3.renderPage,
      onProgress: ({ done, total: t }) => {
        updateBusy(`${done} / ${t} ページを描画中...`, (done / t) * 80);
      },
    });
    updateBusy("PDF を組み立て中...", 90);
    const result = await kpdf3.exportPdfRasterized({
      savePath,
      pages: composed,
    });
    hideBusy();
    wsStatus.textContent =
      `書き出し完了 (p.${range.start}-${range.end}, rev ${result.revisionId.slice(0, 8)} → ${savePath})`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] export-range failed:", err);
    wsStatus.textContent = `書き出し失敗: ${err.message ?? err}`;
  }
}

async function actionPrint() {
  if (!isOpen) return;
  const pages = await kpdf3.getPages();
  if (pages.length === 0) return;
  const overlayCount = projectStore.count();
  const isCopy = overlayCount === 0;

  showBusy("印刷準備", "ページを描画しています...", 0);
  /** @type {Array<any> | null} */
  let composed = null;
  try {
    if (!isCopy) {
      composed = await composePagesForExport({
        pages,
        projectStore,
        renderPage: kpdf3.renderPage,
        onProgress: ({ done, total }) => {
          updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
        },
      });
    }
    updateBusy("プリンタ情報を取得中...", 90);
    const printers = await kpdf3.listPrinters();
    hideBusy();

    const choice = await showPrintDialog(printers);
    if (!choice) {
      wsStatus.textContent = "印刷をキャンセルしました";
      return;
    }

    showBusy("印刷中", `${choice.deviceName} に送信中...`, 50);
    await kpdf3.printPdfSilent({
      source: isCopy ? "byte-copy" : "rasterized",
      pages: composed,
      deviceName: choice.deviceName,
      copies: choice.copies,
    });
    hideBusy();
    wsStatus.textContent = `印刷を ${choice.deviceName} に送信しました（${choice.copies} 部）`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] print failed:", err);
    wsStatus.textContent = `印刷失敗: ${err.message ?? err}`;
  }
}

async function actionExport() {
  if (!isOpen) return;
  const pages = await kpdf3.getPages();
  if (pages.length === 0) return;
  const savePath = await kpdf3.pickExportPdf();
  if (!savePath) return;
  // ADR-0008: with no overlays, byte-copy the source PDF instead of
  // rasterising — preserves the original PDF's text layer and size.
  const overlayCount = projectStore.count();
  const isCopy = overlayCount === 0;
  const verb = isCopy ? "コピー" : "書き出し";
  showBusy(`${verb}準備`, "ページを描画しています...", 0);
  try {
    let result;
    if (isCopy) {
      updateBusy("元 PDF をコピー中...", 50);
      result = await kpdf3.copySourcePdf(savePath);
    } else {
      const composed = await composePagesForExport({
        pages,
        projectStore,
        renderPage: kpdf3.renderPage,
        onProgress: ({ done, total }) => {
          updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
        },
      });
      updateBusy("PDF を組み立て中...", 90);
      result = await kpdf3.exportPdfRasterized({
        savePath,
        pages: composed,
      });
    }
    hideBusy();
    wsStatus.textContent =
      `${verb}完了 (${result.pageCount} ページ, rev ${result.revisionId.slice(0, 8)} → ${savePath})`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] export failed:", err);
    wsStatus.textContent = `${verb}失敗: ${err.message ?? err}`;
  }
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

function actionPagePrev() {
  if (!isOpen || !viewer.registry) return;
  const cur = viewer.currentPage;
  if (cur > 1) viewer.scrollToPage(cur - 1);
}

function actionPageNext() {
  if (!isOpen || !viewer.registry) return;
  const cur = viewer.currentPage;
  const total = viewer.registry.count();
  if (cur < total) viewer.scrollToPage(cur + 1);
}

async function actionPageGoto() {
  if (!isOpen || !viewer.registry) return;
  const total = viewer.registry.count();
  const input = await showGotoPrompt({
    message: `ページ番号 (1-${total}):`,
    value: viewer.currentPage || 1,
    max: total,
  });
  if (input === null) return;
  const n = Number(String(input).trim());
  if (!Number.isInteger(n) || n < 1 || n > total) {
    wsStatus.textContent = `無効なページ番号: ${input}`;
    return;
  }
  viewer.scrollToPage(n);
}

// ---- Bookmarks sidebar (M5-5) ----------------------------------------

async function refreshBookmarks() {
  bookmarkTree.innerHTML = "";
  if (!isOpen) return;
  const outline = await kpdf3.getOutline();
  if (!outline || outline.length === 0) {
    const li = document.createElement("li");
    li.className = "bookmark-empty";
    li.textContent = "(しおりがありません)";
    bookmarkTree.appendChild(li);
    return;
  }
  for (const item of outline) {
    bookmarkTree.appendChild(createBookmarkNode(item));
  }
}

function createBookmarkNode(item) {
  const li = document.createElement("li");
  li.className = "bookmark-item";
  li.textContent = item.title || "(無題)";
  if (typeof item.pageNo === "number" && item.pageNo > 0) {
    li.dataset.pageNo = String(item.pageNo);
    li.title = `${item.title} (p.${item.pageNo})`;
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      viewer.scrollToPage(item.pageNo);
    });
  } else {
    li.style.color = "#666";
  }
  if (Array.isArray(item.children) && item.children.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "bookmark-children";
    for (const child of item.children) {
      ul.appendChild(createBookmarkNode(child));
    }
    li.appendChild(ul);
  }
  return li;
}

function actionToggleBookmarks() {
  if (!isOpen) return;
  sidebar.hidden = !sidebar.hidden;
  refreshMenuState();
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
    recent: actionShowRecent,
    close: actionClose,
    save: actionSave,
    export: actionExport,
    "export-range": actionExportRange,
    "split-save": actionSplitSave,
    print: actionPrint,
    exit: actionExit,
    about: actionAbout,
    undo: actionUndo,
    redo: actionRedo,
    "zoom-in": actionZoomIn,
    "zoom-out": actionZoomOut,
    "zoom-100": actionZoom100,
    "zoom-fit": actionZoomFit,
    "page-prev": actionPagePrev,
    "page-next": actionPageNext,
    "page-goto": actionPageGoto,
    "toggle-bookmarks": actionToggleBookmarks,
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
  } else if (key === "e") {
    e.preventDefault();
    if (inText && target instanceof HTMLElement) target.blur();
    setTimeout(() => actionExport(), 0);
    return;
  } else if (key === "p") {
    e.preventDefault();
    if (inText && target instanceof HTMLElement) target.blur();
    setTimeout(() => actionPrint(), 0);
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
  } else if (key === "g") {
    e.preventDefault();
    actionPageGoto();
  }
});

// PageUp / PageDown for page navigation (no Ctrl required, like a PDF viewer).
// F4 toggles the bookmarks sidebar.
window.addEventListener("keydown", (e) => {
  if (!isOpen) return;
  const target = e.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA")
  )
    return;
  if (e.key === "PageUp") {
    e.preventDefault();
    actionPagePrev();
  } else if (e.key === "PageDown") {
    e.preventDefault();
    actionPageNext();
  } else if (e.key === "F4") {
    e.preventDefault();
    actionToggleBookmarks();
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
btnModeRedaction.addEventListener("click", () =>
  setPlacementMode(placementMode === "redaction" ? "none" : "redaction"),
);

// ---- Initial state ----------------------------------------------------
setOpen(false);

(async () => {
  const info = await kpdf3.getAppInfo();
  $("appinfo").textContent = `v${info.appVersion} / Electron ${info.electronVersion}`;
})();
