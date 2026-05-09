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

async function actionPrint() {
  if (!isOpen) return;
  const pages = await kpdf3.getPages();
  if (pages.length === 0) return;
  const overlayCount = projectStore.count();
  const isCopy = overlayCount === 0;
  try {
    let result;
    if (isCopy) {
      wsStatus.textContent = "印刷準備中...";
      result = await kpdf3.printSourcePdf();
    } else {
      wsStatus.textContent = "印刷準備中...";
      const composed = await composePagesForExport({
        pages,
        projectStore,
        renderPage: kpdf3.renderPage,
        onProgress: ({ done, total }) => {
          wsStatus.textContent = `印刷準備中 ${done} / ${total}`;
        },
      });
      wsStatus.textContent = "PDF を組み立て中...";
      result = await kpdf3.printPdfRasterized({ pages: composed });
    }
    if (result.method === "os-dialog") {
      wsStatus.textContent = result.cancelled
        ? "印刷をキャンセルしました"
        : "印刷ダイアログを表示しました";
    } else {
      wsStatus.textContent =
        "OS の印刷ダイアログを開けなかったため、別ビューアを起動しました。そちらで Ctrl+P を押してください。";
    }
  } catch (err) {
    console.error("[renderer] print failed:", err);
    wsStatus.textContent = `印刷準備失敗: ${err.message ?? err}`;
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
  try {
    let result;
    if (isCopy) {
      wsStatus.textContent = "原本をコピー中...";
      result = await kpdf3.copySourcePdf(savePath);
    } else {
      wsStatus.textContent = "書き出し準備中...";
      const composed = await composePagesForExport({
        pages,
        projectStore,
        renderPage: kpdf3.renderPage,
        onProgress: ({ done, total }) => {
          wsStatus.textContent = `書き出し中 ${done} / ${total}`;
        },
      });
      wsStatus.textContent = "PDF を組み立て中...";
      result = await kpdf3.exportPdfRasterized({
        savePath,
        pages: composed,
      });
    }
    const verb = isCopy ? "コピー" : "書き出し";
    wsStatus.textContent =
      `${verb}完了 (${result.pageCount} ページ, rev ${result.revisionId.slice(0, 8)} → ${savePath})`;
  } catch (err) {
    console.error("[renderer] export failed:", err);
    const verb = isCopy ? "コピー" : "書き出し";
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

function actionPageGoto() {
  if (!isOpen || !viewer.registry) return;
  const total = viewer.registry.count();
  const input = window.prompt(
    `ページ番号 (1-${total}):`,
    String(viewer.currentPage || 1),
  );
  if (input === null) return;
  const n = Number(input.trim());
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
    close: actionClose,
    save: actionSave,
    export: actionExport,
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
