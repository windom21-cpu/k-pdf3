// K-PDF3 renderer entry (M2, ADR-0006).
//
// PDF-first UX: a single「開く」button (and File menu equivalent) takes
// the user through the file picker; main resolves the sidecar `.kpdf3`
// automatically.

import { Viewer, renderSyntheticPagePixels } from "./viewer.js";
import { MenuBar } from "./menu-bar.js";
import { ProjectStore } from "../domain/project-store.js";
import { HistoryStack } from "../domain/history.js";
import {
  AddOverlayCommand,
  UpdateOverlayCommand,
  RemoveOverlayCommand,
} from "../domain/commands.js";
import {
  composePagesForExport,
  composeSinglePageCanvas,
  compositePage,
} from "./exporter.js";
import {
  TEXT_FONT_DEFAULT_ID,
  TEXT_FONT_DEFAULT_SIZE,
  getTextFontStack,
  STAMP_FONT_STACKS,
  STAMP_FONT_LABELS,
  getStampFontDefaults,
  setStampFontDefaults,
  getStampFontStack,
  splitStampRuns,
} from "./fonts.js";

const { kpdf3 } = window;

/**
 * Per-tab state container — ADR-0015 introduced multi-workspace tabs;
 * the renderer's "active tab" data is bundled here so a tab switch
 * is a single applyTab() call that re-points all the module-level
 * aliases (projectStore / history / isOpen / placementMode / ...).
 *
 * Phase 1 (this commit): the structure exists, but only one tab is
 * created at boot. Phase 2 introduces `tabs: Map<id, TabState>` and
 * the actual switching logic. ADR-0015 §1 documents the full plan.
 */
let _tabIdCounter = 0;
function genTabId() {
  return `tab-${Date.now().toString(36)}-${(++_tabIdCounter).toString(36)}`;
}
function createTabState() {
  return {
    id: genTabId(),
    projectStore: new ProjectStore(),
    history: new HistoryStack(),
    isOpen: false,
    activeSourcePdfPath: null,
    activeSourceName: "",
    activeOutline: null,
    pages: [],
    pendingDeletedPages: new Set(),
    workspaceMutated: false,
    placementMode: "none",
    scrollPosition: 0,
    zoom: null,
    selectedBookmarkId: null,
    bookmarkSource: "outline",
    workspaceBookmarksCache: [],
    thumbCache: new Map(),
    inFlightThumbs: new Set(),
    currentSidebarTab: "thumbs",
  };
}

/** @type {Map<string, ReturnType<typeof createTabState>>} */
const tabs = new Map();
let activeTabId = null;

const _bootTab = createTabState();
tabs.set(_bootTab.id, _bootTab);
activeTabId = _bootTab.id;

function getActiveTab() {
  return activeTabId ? tabs.get(activeTabId) : null;
}

// Module-level aliases — mutable so applyTab() can rebind them on
// tab switch. Existing call sites continue to use bare names
// (projectStore, history, ...) so the diff stays small; only the
// declarations changed from const → let. Tab-specific scalars
// (isOpen, placementMode, ...) keep their own module-level lets and
// are pushed into the active TabState by saveActiveTabSnapshot().
let projectStore = _bootTab.projectStore;
let history = _bootTab.history;

const $ = (id) => document.getElementById(id);
const btnOpen = $("btn-open");
const btnSave = $("btn-save");
const btnExport = $("btn-export");
const btnPrint = $("btn-print");
const zoomSelect = $("zoom-select");
const btnModeText = $("btn-mode-text");
const btnModeStamp = $("btn-mode-stamp");
const btnModeRedaction = $("btn-mode-redaction");
const redactionColorSel = $("redaction-color");
const textFontSel = $("text-font");
const textSizeSel = $("text-size");
const btnModeMarker = $("btn-mode-marker");
const markerColorSel = $("marker-color");
const btnModeCallout = $("btn-mode-callout");
const wsStatus = $("ws-status");
const pageIndicator = $("page-indicator");
const viewerContainer = $("viewer-container");
const sidebar = $("sidebar");
const bookmarkTree = $("bookmark-tree");
const thumbList = $("thumb-list");
const mainArea = $("main-area");
const splitView = $("split-view");
const btnSplit = $("btn-split");
const btnRotateLeft = $("btn-rotate-left");
const btnRotateRight = $("btn-rotate-right");
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
  document.body.classList.add("is-busy");
}
function updateBusy(message, percent) {
  if (typeof message === "string") busyMessage.textContent = message;
  if (typeof percent === "number") {
    busyProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
}
function hideBusy() {
  busyModal.hidden = true;
  document.body.classList.remove("is-busy");
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
  // `current` is the active pageNo (negative for inserted pages,
  // possibly non-sequential after reorder), so it can't be shown
  // verbatim — the user expects 1-indexed visual positions. Look up
  // the position via the registry; fall back to the raw value if
  // the registry isn't available yet.
  let displayPos = current;
  if (viewer.registry && typeof viewer.registry.posOfPageNo === "function") {
    const pos = viewer.registry.posOfPageNo(current);
    if (pos >= 0) displayPos = pos + 1;
  }
  pageIndicator.textContent = `${displayPos} / ${total}`;
}

let isOpen = false;
/** @type {'none' | 'text' | 'stamp' | 'redaction'} */
let placementMode = "none";
let activeSourceName = "";

// ---- Tab management (ADR-0015 Phase 2/3) ------------------------------
//
// `tabs` (Map) is the canonical owner of per-tab state; the module-
// level aliases (projectStore / history / pendingDeletedPages /
// isOpen / placementMode / activeSourceName / workspaceMutated /
// selectedBookmarkId / ...) are scratch slots that hold the *active*
// tab's values for the duration it is selected. saveActiveTabSnapshot
// pushes them back into the TabState before a switch; applyTab pulls
// the new tab's values into the slots.
//
// The viewer is a single DOM-bound instance shared across tabs —
// viewer.setProjectStore() rewires its subscription, viewer.load()
// rebuilds the page list. scrollPosition is captured/restored
// per tab so flipping back to a tab returns to where you were.

/** Push the live module-level state into the active tab so it can be
 *  restored later. Called immediately before applyTab() switches. */
function saveActiveTabSnapshot() {
  const tab = getActiveTab();
  if (!tab) return;
  tab.isOpen = isOpen;
  tab.placementMode = placementMode;
  tab.activeSourceName = activeSourceName;
  tab.workspaceMutated = workspaceMutated;
  tab.selectedBookmarkId = selectedBookmarkId;
  tab.bookmarkSource = bookmarkSource;
  tab.workspaceBookmarksCache = workspaceBookmarksCache;
  tab.currentSidebarTab = currentSidebarTab;
  tab.scrollPosition = viewerContainer.scrollTop;
  tab.zoom = viewer.zoom;
  // projectStore / history / pendingDeletedPages / thumbCache are
  // reference-shared with the tab record, no copy needed.
}

/** Make `tabId` the active tab — drops the viewer's current pages,
 *  rewires module aliases to that tab's stores, reloads the viewer.
 *  Skipping work when the tab is already active. */
async function applyTab(tabId) {
  if (!tabs.has(tabId)) return;
  if (tabId === activeTabId) {
    renderTabBar();
    return;
  }
  saveActiveTabSnapshot();
  // Tear down the viewer's overlay edit state etc. before swapping.
  viewer.unload();
  activeTabId = tabId;
  const tab = tabs.get(tabId);
  // Rebind module aliases to the new tab.
  projectStore = tab.projectStore;
  history = tab.history;
  pendingDeletedPages = tab.pendingDeletedPages;
  isOpen = tab.isOpen;
  placementMode = tab.placementMode;
  activeSourceName = tab.activeSourceName;
  workspaceMutated = tab.workspaceMutated;
  selectedBookmarkId = tab.selectedBookmarkId;
  bookmarkSource = tab.bookmarkSource;
  workspaceBookmarksCache = tab.workspaceBookmarksCache;
  currentSidebarTab = tab.currentSidebarTab;
  viewer.setProjectStore(projectStore);
  // Notify main of the switch so render-page / save-overlays / etc.
  // resolve against the right workspace handle. For empty tabs (no
  // PDF yet) we clear main's active workspace too so a stray IPC
  // doesn't hit the previously-active workspace by accident.
  if (tab.isOpen) {
    try {
      await kpdf3.switchTab(tabId);
    } catch (err) {
      console.warn("[tabs] switchTab failed (tab may not be opened on main side):", err);
    }
    await refreshViewer();
    // Restore scroll after layout settles.
    requestAnimationFrame(() => {
      viewerContainer.scrollTop = tab.scrollPosition || 0;
    });
  } else {
    try { await kpdf3.switchTab(null); } catch { /* noop */ }
    setOpen(false);
  }
  renderTabBar();
}

/** Open a new tab and (optionally) prompt the user to pick a PDF for it. */
async function newTabAndOpen(pdfPath = null) {
  saveActiveTabSnapshot();
  const tab = createTabState();
  tabs.set(tab.id, tab);
  // Switch the bare aliases to the new tab. Doing it inline (rather
  // than via applyTab) because the new tab has no main-side handle
  // yet — applyTab would call switchTab and fail.
  viewer.unload();
  activeTabId = tab.id;
  projectStore = tab.projectStore;
  history = tab.history;
  pendingDeletedPages = tab.pendingDeletedPages;
  isOpen = false;
  placementMode = "none";
  activeSourceName = "";
  workspaceMutated = false;
  selectedBookmarkId = null;
  bookmarkSource = "outline";
  workspaceBookmarksCache = [];
  currentSidebarTab = "thumbs";
  viewer.setProjectStore(projectStore);
  setOpen(false);
  renderTabBar();
  if (pdfPath) {
    await openPdfPath(pdfPath);
  } else {
    // Trigger the file picker. Reuses the existing actionOpen flow so
    // recent-files / D&D / browser dialog all work.
    await actionOpen();
  }
}

/** Close a tab. If it's the active one, switch to a neighbour first.
 *  Honours the tab's dirty flag — caller should handle confirmation
 *  upstream (closeTabWithConfirm). */
async function closeTab(tabId) {
  if (!tabs.has(tabId)) return;
  // Disposal on main side. Best-effort — if the tab never opened a
  // PDF (no main-side handle), close-tab will silently no-op.
  try {
    await kpdf3.closeTab(tabId);
  } catch (err) {
    console.warn("[tabs] main close-tab failed:", err);
  }
  if (tabId === activeTabId) {
    // Pick a neighbour to activate. Prefer the tab to the left.
    const order = [...tabs.keys()];
    const idx = order.indexOf(tabId);
    const nextId = order[idx - 1] ?? order[idx + 1] ?? null;
    tabs.delete(tabId);
    if (nextId) {
      // Treat as cold switch since module aliases still point at the
      // (now-deleted) tab's projectStore. activeTabId set to null
      // first so applyTab takes the loading path.
      activeTabId = null;
      await applyTab(nextId);
    } else {
      // No tabs left — recreate a blank boot tab so the renderer
      // never has activeTabId === null (lots of code assumes a tab).
      const blank = createTabState();
      tabs.set(blank.id, blank);
      activeTabId = blank.id;
      projectStore = blank.projectStore;
      history = blank.history;
      pendingDeletedPages = blank.pendingDeletedPages;
      isOpen = false;
      placementMode = "none";
      activeSourceName = "";
      workspaceMutated = false;
      selectedBookmarkId = null;
      bookmarkSource = "outline";
      workspaceBookmarksCache = [];
      viewer.setProjectStore(projectStore);
      viewer.unload();
      setOpen(false);
    }
  } else {
    tabs.delete(tabId);
  }
  renderTabBar();
}

/** Compute a tab's display name. PDF basename when one is open; "(新規タブ)"
 *  for an empty tab. */
function tabDisplayTitle(tab) {
  if (tab.activeSourceName) return tab.activeSourceName;
  return "(新規タブ)";
}

/** Compute whether a tab has unsaved changes. For the active tab we
 *  consult the live state (projectStore.isDirty()), for inactive ones
 *  the snapshot saved at last switch. */
function tabIsDirty(tab) {
  if (tab.id === activeTabId) {
    return (
      projectStore.isDirty() ||
      pendingDeletedPages.size > 0 ||
      workspaceMutated
    );
  }
  return (
    tab.projectStore.isDirty() ||
    tab.pendingDeletedPages.size > 0 ||
    tab.workspaceMutated
  );
}

/** Rebuild the tab-bar DOM from the current `tabs` map. */
function renderTabBar() {
  const list = document.getElementById("tab-list");
  if (!list) return;
  list.innerHTML = "";
  for (const [id, tab] of tabs) {
    const item = document.createElement("div");
    item.className = "tab-item";
    if (id === activeTabId) item.classList.add("is-active");
    item.dataset.tabId = id;
    item.title = tab.activeSourcePdfPath ?? tabDisplayTitle(tab);
    item.draggable = true;
    const dirty = document.createElement("span");
    dirty.className = "tab-dirty-mark";
    dirty.textContent = "●";
    if (!tabIsDirty(tab)) dirty.hidden = true;
    item.appendChild(dirty);
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tabDisplayTitle(tab);
    item.appendChild(title);
    const close = document.createElement("button");
    close.className = "tab-close";
    close.title = "タブを閉じる";
    close.textContent = "×";
    close.addEventListener("click", async (e) => {
      e.stopPropagation();
      await closeTabWithConfirm(id);
    });
    item.appendChild(close);
    item.addEventListener("click", () => {
      void applyTab(id);
    });
    attachTabDragHandlers(item, id);
    list.appendChild(item);
  }
}

const TAB_DND_MIME = "application/x-kpdf3-tab-id";

/** Wire HTML5 drag-and-drop on a tab item so the user can reorder the
 *  tab-list by dragging. Drop position is computed from cursor X
 *  relative to the target tab's midpoint: left half → insert before,
 *  right half → insert after. Map preserves insertion order, so a
 *  reorder is "rebuild the Map with entries in the new sequence". */
function attachTabDragHandlers(item, tabId) {
  item.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(TAB_DND_MIME, tabId);
    e.dataTransfer.setData("text/plain", tabId);
    item.classList.add("is-dragging");
  });
  item.addEventListener("dragend", () => {
    item.classList.remove("is-dragging");
    clearTabDropIndicators();
  });
  item.addEventListener("dragover", (e) => {
    if (!hasTabPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const r = item.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    setTabDropIndicator(item, before);
  });
  item.addEventListener("dragleave", (e) => {
    if (!item.contains(e.relatedTarget)) {
      item.classList.remove("drop-before", "drop-after");
    }
  });
  item.addEventListener("drop", (e) => {
    if (!hasTabPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const draggedId = e.dataTransfer.getData(TAB_DND_MIME);
    clearTabDropIndicators();
    if (!draggedId || draggedId === tabId) return;
    const r = item.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    reorderTab(draggedId, tabId, before);
  });
}

function hasTabPayload(dt) {
  if (!dt) return false;
  return Array.from(dt.types || []).includes(TAB_DND_MIME);
}

function setTabDropIndicator(el, before) {
  clearTabDropIndicators();
  el.classList.add(before ? "drop-before" : "drop-after");
}

function clearTabDropIndicators() {
  const list = document.getElementById("tab-list");
  if (!list) return;
  for (const el of list.querySelectorAll(".drop-before, .drop-after")) {
    el.classList.remove("drop-before", "drop-after");
  }
}

/** Move `draggedId` to be immediately before / after `targetId`. Map
 *  preserves insertion order so we rebuild it from a re-ordered array
 *  of entries. Active tab + state are unaffected — this is purely a
 *  visual reorder. */
function reorderTab(draggedId, targetId, before) {
  if (!tabs.has(draggedId) || !tabs.has(targetId)) return;
  const entries = [...tabs.entries()];
  const fromIdx = entries.findIndex(([id]) => id === draggedId);
  if (fromIdx < 0) return;
  const [moved] = entries.splice(fromIdx, 1);
  let toIdx = entries.findIndex(([id]) => id === targetId);
  if (toIdx < 0) return;
  if (!before) toIdx += 1;
  entries.splice(toIdx, 0, moved);
  tabs.clear();
  for (const [id, tab] of entries) tabs.set(id, tab);
  renderTabBar();
}

/** Close-with-confirmation: dirty tabs get a 「破棄しますか」 dialog. */
async function closeTabWithConfirm(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  if (tabIsDirty(tab)) {
    const ok = await customConfirm({
      title: "タブを閉じる",
      message: `「${tabDisplayTitle(tab)}」に未保存の変更があります。\n破棄して閉じますか？`,
      okLabel: "破棄して閉じる",
      cancelLabel: "キャンセル",
    });
    if (!ok) return;
  }
  await closeTab(tabId);
}

function handlePagePointerDown(pageNo, x, y, evt, div) {
  if (!isOpen) return;
  if (placementMode === "text") {
    placeText(pageNo, x, y);
  } else if (placementMode === "stamp") {
    placeStamp(pageNo, x, y);
  } else if (placementMode === "redaction") {
    startRedactionDrag(pageNo, x, y, evt, div);
  } else if (placementMode === "marker") {
    startMarkerDrag(pageNo, x, y, evt, div);
  } else if (placementMode === "callout") {
    startCalloutDrag(pageNo, x, y, evt, div);
  }
  // Clicks on empty page area no longer deselect — that fired even
  // when the user "exited" inline edit by clicking outside, leaving
  // them with no obvious way to keep an overlay selected for Delete.
  // Escape now clears selection (handled in the global keydown).
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
  const previewColor = currentRedactionColor();
  const preview = document.createElement("div");
  preview.className = "redaction-preview";
  if (previewColor === "white") preview.classList.add("redaction-preview-white");
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

// Last-used redaction color persisted across sessions (§17.13).
const REDACTION_COLOR_STORAGE_KEY = "kpdf3.redactionColor";
function currentRedactionColor() {
  const v = redactionColorSel?.value;
  return v === "white" ? "white" : "black";
}

// ---- Marker (highlighter) — drag-to-define rectangle (§17.6) -----------
const MARKER_COLOR_STORAGE_KEY = "kpdf3.markerColor";
function currentMarkerColor() {
  return markerColorSel?.value || "#ffeb3b";
}

function placeMarker(pageNo, x, y, w, h) {
  if (w < 5 || h < 5) return; // ignore accidental tiny rects
  const cmd = new AddOverlayCommand(projectStore, {
    pageNo,
    type: "line", // CHECK constraint covers 'line'; kind='marker' discriminates
    x, y, w, h,
    // Markers sit between text overlays and redactions.
    zOrder: 50,
    properties: {
      kind: "marker",
      color: currentMarkerColor(),
      opacity: 0.5,
    },
  });
  history.execute(cmd);
}

/**
 * Drag-to-define a rectangular marker. Both axes follow the cursor so
 * the user can paint horizontal stripes by dragging mostly sideways or
 * cover blocks by dragging diagonally. Mode is sticky — users tend to
 * highlight several spots in a row.
 */
function startMarkerDrag(pageNo, startX, startY, downEvt, div) {
  const DEFAULT_W = 120;
  const DEFAULT_H = 14;
  if (!div || !downEvt || typeof div.setPointerCapture !== "function") {
    placeMarker(pageNo, startX - DEFAULT_W / 2, startY - DEFAULT_H / 2, DEFAULT_W, DEFAULT_H);
    return;
  }
  const pointerId = downEvt.pointerId;
  const z = viewer.zoom;
  const previewColor = currentMarkerColor();
  const preview = document.createElement("div");
  preview.className = "marker-preview";
  preview.style.background = previewColor;
  preview.style.opacity = "0.55";
  preview.style.left = `${startX * z}px`;
  preview.style.top = `${startY * z}px`;
  preview.style.width = "0px";
  preview.style.height = "0px";
  div.appendChild(preview);

  let curX = startX, curY = startY;
  try { div.setPointerCapture(pointerId); } catch { /* ignore */ }

  function onMove(e) {
    if (e.pointerId !== pointerId) return;
    const rect = div.getBoundingClientRect();
    curX = (e.clientX - rect.left) / z;
    curY = (e.clientY - rect.top) / z;
    const left = Math.min(startX, curX);
    const top = Math.min(startY, curY);
    const width = Math.abs(curX - startX);
    const height = Math.abs(curY - startY);
    preview.style.left = `${left * z}px`;
    preview.style.top = `${top * z}px`;
    preview.style.width = `${width * z}px`;
    preview.style.height = `${height * z}px`;
  }

  function cleanup() {
    div.removeEventListener("pointermove", onMove);
    div.removeEventListener("pointerup", onUp);
    div.removeEventListener("pointercancel", onCancel);
    try { div.releasePointerCapture(pointerId); } catch { /* ignore */ }
    preview.remove();
  }

  function onUp(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
    const left = Math.min(startX, curX);
    const top = Math.min(startY, curY);
    const width = Math.abs(curX - startX);
    const height = Math.abs(curY - startY);
    if (width < 5 || height < 5) {
      // Quick click without meaningful drag — drop a default-size
      // 1-line stripe centered on the click.
      placeMarker(pageNo, startX - DEFAULT_W / 2, startY - DEFAULT_H / 2, DEFAULT_W, DEFAULT_H);
    } else {
      placeMarker(pageNo, left, top, width, height);
    }
  }

  function onCancel(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
  }

  div.addEventListener("pointermove", onMove);
  div.addEventListener("pointerup", onUp);
  div.addEventListener("pointercancel", onCancel);
}

// ---- Callout (吹き出し) — arrow line + text at the end (§17.7) ---------
//
// Placement flow: pointerdown lands the ARROW TIP, drag streams a
// preview line to the cursor, pointerup drops the TEXT anchor at the
// release point. The overlay's (x, y, w, h) is the text box; arrowDx/
// Dy are stored as the tip's offset from the box top-left (so a
// negative dx puts the tip above-left of the text).

/**
 * @param {number} pageNo
 * @param {number} x       text box top-left X (canonical pt)
 * @param {number} y       text box top-left Y
 * @param {number} w       text box width
 * @param {number} h       text box height
 * @param {number} arrowDx tip X offset from box top-left (signed)
 * @param {number} arrowDy tip Y offset from box top-left (signed)
 */
function placeCallout(pageNo, x, y, w, h, arrowDx, arrowDy) {
  const fontSize = currentTextFontSize();
  const cmd = new AddOverlayCommand(projectStore, {
    pageNo,
    type: "rect", // schema CHECK already includes 'rect'; kind='callout' discriminates
    x,
    y,
    w,
    h,
    zOrder: 30,
    properties: {
      kind: "callout",
      text: "テキスト",
      fontSize,
      color: "#000000",
      fontId: currentTextFontId(),
      rotation: 0,
      arrowDx,
      arrowDy,
    },
  });
  history.execute(cmd);
  setPlacementMode("none");
  if (cmd._snapshot) {
    setTimeout(() => viewer.enterTextEdit(cmd._snapshot.id), 0);
  }
}

function startCalloutDrag(pageNo, startX, startY, downEvt, div) {
  // Box-side default geometry (single line, fontSize × 6 wide).
  const fontSize = currentTextFontSize();
  const W = Math.max(60, fontSize * 6);
  const H = Math.max(fontSize, Math.round(fontSize * 1.2));

  if (!div || !downEvt || typeof div.setPointerCapture !== "function") {
    // Fallback: drop a default callout offset from the click point.
    placeCallout(pageNo, startX + 30, startY + 20, W, H, -30, -20);
    return;
  }
  const pointerId = downEvt.pointerId;
  const z = viewer.zoom;

  // Live SVG line from tip → cursor.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("callout-drag-preview");
  svg.style.position = "absolute";
  svg.style.left = "0";
  svg.style.top = "0";
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.pointerEvents = "none";
  svg.style.overflow = "visible";
  svg.style.zIndex = "999";
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", String(startX * z));
  line.setAttribute("y1", String(startY * z));
  line.setAttribute("x2", String(startX * z));
  line.setAttribute("y2", String(startY * z));
  line.setAttribute("stroke", "#cc0000");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-dasharray", "4 3");
  svg.appendChild(line);
  div.appendChild(svg);

  let curX = startX, curY = startY;
  try { div.setPointerCapture(pointerId); } catch { /* ignore */ }

  function onMove(e) {
    if (e.pointerId !== pointerId) return;
    const rect = div.getBoundingClientRect();
    curX = (e.clientX - rect.left) / z;
    curY = (e.clientY - rect.top) / z;
    line.setAttribute("x2", String(curX * z));
    line.setAttribute("y2", String(curY * z));
  }

  function cleanup() {
    div.removeEventListener("pointermove", onMove);
    div.removeEventListener("pointerup", onUp);
    div.removeEventListener("pointercancel", onCancel);
    try { div.releasePointerCapture(pointerId); } catch { /* ignore */ }
    svg.remove();
  }

  function onUp(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
    const dragDist = Math.hypot(curX - startX, curY - startY);
    let textX, textY;
    if (dragDist < 8) {
      // Click without meaningful drag — default text 40 pt right of tip.
      textX = startX + 40;
      textY = startY - H / 2;
    } else {
      textX = curX;
      textY = curY - H / 2; // align text vertical center with release point
    }
    const arrowDx = startX - textX;
    const arrowDy = startY - textY;
    placeCallout(pageNo, textX, textY, W, H, arrowDx, arrowDy);
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
    properties: { color: currentRedactionColor(), mode: "applied" },
  });
  history.execute(cmd);
}

function currentTextFontId() {
  return textFontSel?.value || TEXT_FONT_DEFAULT_ID;
}
function currentTextFontSize() {
  const v = parseInt(textSizeSel?.value ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : TEXT_FONT_DEFAULT_SIZE;
}

function placeText(pageNo, x, y) {
  const fontSize = currentTextFontSize();
  // 1-line tall box (~ standard line-height 1.2); width holds ~6 chars
  // by default so the placeholder "テキスト" fits without giving an
  // oversized empty area around it.
  const W = Math.max(60, fontSize * 6);
  const H = Math.max(fontSize, Math.round(fontSize * 1.2));
  // I-beam hot spot is the middle of the cursor — map the click point
  // to the text box's vertical center so the new text appears around
  // (rather than below) where the user clicked.
  const cmd = new AddOverlayCommand(projectStore, {
    pageNo,
    type: "text",
    x,
    y: y - H / 2,
    w: W,
    h: H,
    zOrder: 0,
    properties: {
      text: "テキスト",
      fontSize,
      color: "#000000",
      fontId: currentTextFontId(),
      rotation: 0, // page-rotation tracked here so content stays upright on rotated paper
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

// ---- ＋ページ番号: bulk add page-number text overlays ------------------
//
// One-shot operation that drops a small text overlay at the footer of
// every non-deleted page. Each overlay is a regular `text` overlay so
// the user can drag / resize / delete individual ones afterwards. The
// whole insertion is a single Undo step (history.execute on a batch
// of AddOverlayCommands inside one history transaction is overkill —
// for now we push them as individual commands and merge later if the
// undo experience demands it).

const pageNumDialog = () => $("page-numbers-dialog");

function openPageNumbersDialog() {
  if (!isOpen) return;
  pageNumDialog().hidden = false;
}
function closePageNumbersDialog() {
  pageNumDialog().hidden = true;
}

/** Format a single page number per the chosen template. */
function formatPageNumber(format, n, total) {
  switch (format) {
    case "-N-":  return `- ${n} -`;
    case "p.N":  return `p.${n}`;
    case "N/T":  return `${n} / ${total}`;
    case "N":
    default:     return String(n);
  }
}

async function applyPageNumbers() {
  const position = $("page-numbers-position").value;
  const format   = $("page-numbers-format").value;
  const start    = Math.max(1, Number($("page-numbers-start").value) || 1);
  const fontSize = Math.max(6, Math.min(36, Number($("page-numbers-fontsize").value) || 11));
  const allPages = await kpdf3.getPages();
  const visible  = allPages.filter((p) => !pendingDeletedPages.has(p.pageNo));
  if (visible.length === 0) {
    wsStatus.textContent = "ページがありません";
    closePageNumbersDialog();
    return;
  }
  // Footer y = paper height − margin. Margin held to ~24pt so the
  // number sits inside the bottom margin without pushing into body.
  const FOOTER_MARGIN = 24;
  const W = Math.max(60, fontSize * 8); // wider than placeText default — page-numbers tend to be longer ("23 / 312")
  const H = Math.max(fontSize, Math.round(fontSize * 1.4));

  let added = 0;
  for (let i = 0; i < visible.length; i++) {
    const row  = visible[i];
    const cw   = row.cropW ?? row.width ?? 595;
    const ch   = row.cropH ?? row.height ?? 842;
    const userRot = (((row.userRotation ?? 0) % 360) + 360) % 360;
    const swap = userRot === 90 || userRot === 270;
    // Canonical (post-rotation) page extents.
    const pageW = swap ? ch : cw;
    const pageH = swap ? cw : ch;
    // x by alignment; y from bottom.
    let x;
    if (position === "left")        x = 36;
    else if (position === "right")  x = pageW - 36 - W;
    else                            x = (pageW - W) / 2;
    const y = pageH - FOOTER_MARGIN - H;
    const text = formatPageNumber(format, start + i, visible.length);
    const cmd = new AddOverlayCommand(projectStore, {
      pageNo: row.pageNo,
      type: "text",
      x, y, w: W, h: H, zOrder: 0,
      properties: {
        text,
        fontSize,
        color: "#000000",
        fontId: currentTextFontId(),
        rotation: 0,
      },
    });
    history.execute(cmd);
    added += 1;
  }
  wsStatus.textContent = `${added} ページにページ番号を追加`;
  closePageNumbersDialog();
}

$("btn-page-numbers")?.addEventListener("click", openPageNumbersDialog);
$("page-numbers-ok")?.addEventListener("click", () => { void applyPageNumbers(); });
$("page-numbers-cancel")?.addEventListener("click", closePageNumbersDialog);
pageNumDialog()?.addEventListener("click", (e) => {
  if (e.target === pageNumDialog()) closePageNumbersDialog();
});

// ---- Page popup (別窓 / §17.4 prelim) ----------------------------------
//
// Re-renders the active page (with overlays) at 2× and ships a PNG
// to a frameless BrowserWindow for side-by-side comparison.
async function actionOpenPagePopup() {
  if (!isOpen) return;
  const pageNo = viewer.currentPage;
  if (!pageNo) return;
  const row = viewer._pages?.find((p) => p.pageNo === pageNo);
  if (!row) {
    wsStatus.textContent = "ポップアップ対象のページが見つかりません";
    return;
  }
  showBusy("別窓を開く", "ページを描画中...", 30);
  try {
    const renderSyntheticPage = async (r, z) => renderSyntheticPagePixels(r, z);
    const canvas = await composeSinglePageCanvas(
      row,
      kpdf3.renderPage,
      projectStore,
      2.0,
      renderSyntheticPage,
    );
    const pngDataUrl = canvas.toDataURL("image/png");
    const visualPos = viewer.registry?.posOfPageNo?.(pageNo) >= 0
      ? viewer.registry.posOfPageNo(pageNo) + 1
      : null;
    const totalPages = viewer.registry?.count?.() ?? null;
    await kpdf3.openPagePopup({
      pngDataUrl,
      fileName: activeSourceName || "K-PDF3",
      pageNo,
      visualPos,
      totalPages,
      width: canvas.width,
      height: canvas.height,
    });
    hideBusy();
    wsStatus.textContent = `別窓で p.${visualPos ?? pageNo} を表示`;
  } catch (err) {
    hideBusy();
    console.error("[page-popup] failed", err);
    wsStatus.textContent = `別窓を開けませんでした: ${err.message ?? err}`;
  }
}
$("btn-page-popup")?.addEventListener("click", actionOpenPagePopup);

/** Active preset id — drives currentStampPreset(). null when nothing
 *  is registered yet. Persisted across sessions via localStorage. */
const STAMP_ACTIVE_PRESET_KEY = "kpdf3.activeStampPresetId";
let _activeStampPresetId = localStorage.getItem(STAMP_ACTIVE_PRESET_KEY) || null;

function setActiveStampPreset(id) {
  _activeStampPresetId = id;
  if (id) localStorage.setItem(STAMP_ACTIVE_PRESET_KEY, id);
  else localStorage.removeItem(STAMP_ACTIVE_PRESET_KEY);
  refreshStampPaletteActive();
  updateStampGhostPreset();
}

/** Build the stamp properties for the currently-active preset
 *  (ADR-0019). Date kind computes today's date at placement time.
 *  Returns null when no preset is active (placeStamp aborts so the
 *  click is a no-op rather than a fallback 印 that surprises the user).
 */
function currentStampPreset() {
  const id = _activeStampPresetId;
  if (!id) return null;
  const p = _stampPresetCache.get(id);
  if (!p) return null;
  const base = {
    w: p.width,
    h: p.height,
    frame: p.frame,
    fontSize: p.fontSize,
    color: p.color,
    label: p.label,
  };
  if (p.kind === "date") {
    // The date-numeric-spaced format is a unique distribution-rendered
    // variant: 3 numbers spaced across the box, with separator chars
    // dropped. spacingMode flag is plumbed through to the overlay so
    // the viewer / exporter pick the alternate render path.
    const isSpaced = p.text === "date-numeric-spaced";
    return {
      ...base,
      text: renderDateText(p.text),
      spacingMode: isSpaced ? "distribute-3" : undefined,
    };
  }
  if (p.kind === "text") return { ...base, text: p.text ?? "" };
  if (p.kind === "image") return { ...base, kind: "image", assetId: p.assetId, text: "" };
  return null;
}

function placeStamp(pageNo, x, y) {
  const preset = currentStampPreset();
  if (!preset) {
    // No preset selected — point the user at the manager.
    wsStatus.textContent = "スタンプが未登録です。「スタンプ管理…」で登録してください";
    return;
  }
  const W = preset.w;
  const H = preset.h;
  const properties = {
    kind: preset.kind ?? "text-frame",
    text: preset.text,
    color: preset.color,
    frame: preset.frame,
    fontSize: preset.fontSize,
    rotation: 0,
    // Plumb the date-numeric-spaced "distribute" flag through so the
    // viewer + exporter pick the special rendering path.
    spacingMode: preset.spacingMode,
  };
  if (preset.kind === "image" && preset.assetId) {
    properties.assetId = preset.assetId;
    properties.label = preset.label ?? "image-stamp";
  }
  const cmd = new AddOverlayCommand(projectStore, {
    pageNo,
    type: "stamp",
    x: x - W / 2,
    y: y - H / 2,
    w: W,
    h: H,
    zOrder: 0,
    properties,
  });
  history.execute(cmd);
  // Stamp mode is sticky — the palette popup stays open so the user
  // can keep dropping stamps (same one consecutively, or a different
  // preset by clicking it in the popup). To exit: toolbar スタンプ
  // button toggles, the popup's ✕, or Esc.
  // Auto-enter-edit is also skipped: presets carry the intended text,
  // and entering edit on every placement breaks the rhythm.
}

function handleOverlayClick(id) {
  if (!isOpen) return;
  setSelectedOverlay(id);
  // For text/stamp/callout this enters inline edit; for redaction /
  // marker / image overlays it short-circuits inside enterTextEdit so
  // selection alone is the visible result.
  viewer.enterTextEdit(id);
}

// ---- Overlay selection — single-overlay model + Delete key ----------
let selectedOverlayId = null;

function _ovCssEscape(s) {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(s)
    : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function setSelectedOverlay(id) {
  if (selectedOverlayId === id) return;
  if (selectedOverlayId) {
    const prev = viewer.container?.querySelector(
      `.overlay[data-overlay-id="${_ovCssEscape(selectedOverlayId)}"]`,
    );
    prev?.classList.remove("is-selected");
  }
  selectedOverlayId = id;
  reapplySelectionDom();
}

/** Re-paint the .is-selected class onto the currently-tracked overlay
 *  element, ignoring any class that may have been left over on stale
 *  nodes after a re-render. Called after store-update events because
 *  the viewer rebuilds the overlay layer DOM. */
function reapplySelectionDom() {
  if (!viewer.container) return;
  for (const el of viewer.container.querySelectorAll(".overlay.is-selected")) {
    el.classList.remove("is-selected");
    el.querySelector(":scope > .overlay-close-btn")?.remove();
  }
  if (!selectedOverlayId) return;
  const el = viewer.container.querySelector(
    `.overlay[data-overlay-id="${_ovCssEscape(selectedOverlayId)}"]`,
  );
  if (!el) return;
  el.classList.add("is-selected");
  // Always inject the × button when selected — CSS hides it while
  // .editing is on the parent (so Delete in inline edit acts on text,
  // not on the overlay). When editing ends, the editing class is
  // removed and the × becomes visible again automatically.
  if (!el.querySelector(":scope > .overlay-close-btn")) {
    const btn = document.createElement("span");
    btn.className = "overlay-close-btn";
    btn.textContent = "×";
    btn.title = "選択中の overlay を削除";
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = selectedOverlayId;
      if (!id) return;
      setSelectedOverlay(null);
      history.execute(new RemoveOverlayCommand(projectStore, id));
    });
    el.appendChild(btn);
  }
}

function handleTextEditCommit(id, newText) {
  if (!isOpen) return;
  const ov = projectStore.get(id);
  if (!ov) return;
  // Callouts auto-fit to the entered text — the user wanted the box to
  // grow with the font size / character count instead of staying at the
  // initial drag-defined dimensions.
  let sizePatch = {};
  if (ov.type === "rect" && ov.properties?.kind === "callout") {
    const m = measureCalloutSize(
      newText,
      ov.properties.fontSize ?? 12,
      getTextFontStack(ov.properties.fontId),
    );
    sizePatch = { w: m.w, h: m.h };
  }
  history.execute(
    new UpdateOverlayCommand(projectStore, id, {
      ...sizePatch,
      properties: { ...ov.properties, text: newText },
    }),
  );
}

/** Measure the natural size of a callout's text in canonical points,
 *  given the font size and CSS font-family stack. Multiple lines (\n)
 *  contribute height; the widest line wins for width. Adds a small
 *  inner padding so the text doesn't touch the box outline. */
function measureCalloutSize(text, fontSize, fontFamily) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontSize}px ${fontFamily}`;
  const lines = (text ?? "").split(/\r?\n/);
  let maxWidth = 0;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (w > maxWidth) maxWidth = w;
  }
  // Padding tuned to match the renderer's textNode (padding 2px 4px)
  // + the 1px callout border, so the saved canonical w/h leaves no
  // visible bottom gap.
  const padX = CALLOUT_PAD_X;
  const padY = CALLOUT_PAD_Y;
  const lineHeight = fontSize * CALLOUT_LINE_HEIGHT;
  return {
    w: Math.max(40, Math.ceil(maxWidth + padX * 2)),
    h: Math.max(fontSize, Math.ceil(lineHeight * Math.max(1, lines.length) + padY * 2)),
  };
}

// Match renderer-side callout layout: textNode CSS padding 2px 4px,
// + 1px border on the outer box, + line-height: 1.2.
const CALLOUT_PAD_X = 5; // 4 (textNode) + 1 (border)
const CALLOUT_PAD_Y = 3; // 2 (textNode) + 1 (border)
const CALLOUT_LINE_HEIGHT = 1.2;

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
  // Callouts: respect the user's new width but recompute height from
  // the wrapped line count so all text stays inside the box even when
  // the user narrows it (text wraps → more lines → taller).
  if (ov.type === "rect" && ov.properties?.kind === "callout") {
    const wrappedH = measureCalloutWrappedHeight(
      ov.properties.text ?? "",
      ov.properties.fontSize ?? 12,
      getTextFontStack(ov.properties.fontId),
      bbox.w,
    );
    bbox = { ...bbox, h: Math.max(bbox.h, wrappedH) };
  }
  history.execute(new UpdateOverlayCommand(projectStore, id, bbox));
}

/** Measure the height (canonical pt) needed to fit `text` in a box of
 *  width `boxW` at the given font, including padding. Honours CJK
 *  word-wrap via the same character-by-character algorithm the
 *  exporter uses. */
function measureCalloutWrappedHeight(text, fontSize, fontFamily, boxW) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontSize}px ${fontFamily}`;
  const padX = CALLOUT_PAD_X;
  const padY = CALLOUT_PAD_Y;
  const lineHeight = fontSize * CALLOUT_LINE_HEIGHT;
  const innerW = Math.max(20, boxW - padX * 2);
  // Wrap: hard breaks on \n, otherwise greedy character-by-character
  // fit within innerW.
  const paras = (text ?? "").split(/\r?\n/);
  let lineCount = 0;
  for (const para of paras) {
    if (para === "") { lineCount += 1; continue; }
    const chars = [...para]; // codepoint-safe
    let line = "";
    for (const c of chars) {
      const next = line + c;
      if (ctx.measureText(next).width <= innerW) {
        line = next;
      } else {
        if (line) lineCount += 1;
        line = c;
      }
    }
    if (line) lineCount += 1;
  }
  return Math.max(fontSize, Math.ceil(lineHeight * Math.max(1, lineCount) + padY * 2));
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
  if (e.key === "Escape") {
    hideOverlayContextMenu();
    // Don't steal Esc from inline edits / dialog inputs (they have
    // their own handlers). Outside those, Esc unwinds the user's
    // most recent state in priority order: selection → placement
    // mode. So pressing Esc once cancels what they just started.
    const target = e.target;
    const inEdit =
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA");
    if (inEdit) return;
    if (selectedOverlayId) {
      setSelectedOverlay(null);
    } else if (placementMode !== "none") {
      setPlacementMode("none");
    }
  }
});

// ---- Thumb context menu (sidebar + split-save thumbs) -----------------
const ctxThumb = $("ctx-thumb");
function showThumbContextMenu(pageNo, x, y) {
  ctxThumb.dataset.targetPageNo = String(pageNo);
  ctxThumb.style.left = `${x}px`;
  ctxThumb.style.top = `${y}px`;
  ctxThumb.hidden = false;
}
function hideThumbContextMenu() {
  ctxThumb.hidden = true;
  delete ctxThumb.dataset.targetPageNo;
}
function dispatchThumbCtx(target) {
  const pageNoStr = ctxThumb.dataset.targetPageNo;
  hideThumbContextMenu();
  if (!(target instanceof HTMLElement) || !pageNoStr) return;
  const action = target.dataset.ctx;
  const pageNo = Number(pageNoStr);
  if (!action || !Number.isFinite(pageNo)) return;
  if (action === "rotate-right") rotatePageBy(pageNo, +90);
  else if (action === "rotate-left") rotatePageBy(pageNo, -90);
  else if (action === "rotate-180") rotatePageBy(pageNo, 180);
  else if (action === "save-page") actionSaveSinglePage(pageNo);
}

/** Extract a single page (with overlays + rotation) to a new PDF. */
async function actionSaveSinglePage(pageNo) {
  if (!isOpen || !pageNo) return;
  const row = viewer._pages?.find((p) => p.pageNo === pageNo);
  if (!row) return;
  const defaults = await kpdf3.getExportDefaults();
  const baseName = (defaults.defaultName || "page").replace(/\.[^.]+$/, "");
  const tag = pageNo > 0 ? `p${pageNo}` : `inserted${-pageNo}`;
  const initialName = `${baseName}_${tag}.pdf`;
  const savePath = await showFileBrowser({
    mode: "save",
    title: `ページ ${pageNo > 0 ? pageNo : "挿入"} を PDF として保存`,
    initialName,
    defaultDir: defaults.sourceDir,
  });
  if (!savePath) return;
  showBusy("保存", `ページを書き出し中...`, 50);
  try {
    const composed = await composePagesForExport({
      pages: [row],
      projectStore,
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
      onProgress: () => {},
    });
    const result = await kpdf3.exportPdfRasterized({ savePath, pages: composed });
    hideBusy();
    wsStatus.textContent = `${savePath} に保存しました（rev ${(result?.revisionId ?? "").slice(0, 8)}）`;
  } catch (err) {
    hideBusy();
    console.error("[save-page] failed", err);
    wsStatus.textContent = `保存失敗: ${err.message ?? err}`;
  }
}
ctxThumb.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  let el = e.target;
  while (el && el !== ctxThumb && !(el.dataset && el.dataset.ctx)) {
    el = el.parentElement;
  }
  if (el && el !== ctxThumb) dispatchThumbCtx(el);
});
ctxThumb.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("pointerdown", (ev) => {
  if (ev.target instanceof Node && ctxThumb.contains(ev.target)) return;
  hideThumbContextMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideThumbContextMenu();
});

/** Attach a contextmenu handler on a thumb element so right-click pops
 *  the rotate menu anchored at the click coords. Used by both the
 *  sidebar thumbs and the split-save thumbs. */
function attachThumbContextMenu(el, pageNo) {
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showThumbContextMenu(pageNo, e.clientX, e.clientY);
  });
}

/**
 * @param {'none' | 'text' | 'stamp'} mode
 */
function setPlacementMode(mode) {
  placementMode = mode;
  viewer.setEditMode(mode);
  btnModeText.classList.toggle("toggled", mode === "text");
  btnModeStamp.classList.toggle("toggled", mode === "stamp");
  btnModeRedaction.classList.toggle("toggled", mode === "redaction");
  btnModeMarker.classList.toggle("toggled", mode === "marker");
  if (btnModeCallout) btnModeCallout.classList.toggle("toggled", mode === "callout");
  syncStampGhostMode();
  syncStampPalettePopup();
  refreshMenuState();
  refreshModeOptionsBar();
}

/** Show / hide the floating stamp palette popup based on placement
 *  mode. The popup stays visible throughout stamp mode so the user
 *  can keep picking different stamps without leaving the mode. */
function syncStampPalettePopup() {
  const popup = $("stamp-palette-popup");
  if (!popup) return;
  popup.hidden = placementMode !== "stamp";
}

/** Toggle the mode-options bar + the per-mode child visible to match
 *  the current placementMode. text and callout share the same options
 *  row (font + size). When mode is "none", the bar collapses entirely. */
function refreshModeOptionsBar() {
  const bar = $("mode-options-bar");
  if (!bar) return;
  // text + callout share the "text" options panel.
  const which =
    placementMode === "callout" ? "text" :
    placementMode === "none" ? null : placementMode;
  bar.hidden = which === null;
  for (const opt of bar.querySelectorAll(".mode-options")) {
    opt.hidden = opt.dataset.mode !== which;
  }
}

// ==========================================================================
// Stamp manager + 3 register dialogs (ADR-0019 MVP) ------------------------
// ==========================================================================

/** Cached list of user-registered stamp presets (ADR-0019). Refreshed
 *  whenever the workspace opens or a preset is added / removed. The
 *  toolbar's stamp template select pulls from this for "preset:<id>"
 *  options. */
const _stampPresetCache = new Map(); // id → preset row

async function refreshStampPresetCacheAndSelect() {
  // Pull the canonical list and rebuild the renderer-side cache + the
  // palette UI in the mode-options bar.
  let list = [];
  try {
    if (isOpen) list = (await kpdf3.listStampPresets()) ?? [];
  } catch (err) {
    console.error("[stamp-presets] list failed", err);
  }
  _stampPresetCache.clear();
  for (const p of list) _stampPresetCache.set(p.id, p);
  // Auto-select the first preset if the previously-active one is gone
  // (e.g. user deleted it). Avoids an "active id but currentStampPreset
  // returns null" gap that would silently disable placement.
  if (_activeStampPresetId && !_stampPresetCache.has(_activeStampPresetId)) {
    _activeStampPresetId = null;
  }
  if (!_activeStampPresetId && list.length > 0) {
    _activeStampPresetId = list[0].id;
    localStorage.setItem(STAMP_ACTIVE_PRESET_KEY, _activeStampPresetId);
  }
  rebuildStampPalette();
}

/** Render a small thumbnail of a preset onto the given canvas. */
function paintPresetThumb(canvas, p) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  if (p.kind === "image" && p.assetId) {
    // Async: load asset, paint when ready (palette refreshes
    // happen rarely, so this is OK).
    _stampGhostAssetUrl(p.assetId).then((url) => {
      if (!url) return;
      const img = new Image();
      img.onload = () => {
        const scale = Math.min((W - 4) / img.width, (H - 4) / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        if (p.frame === "rect") {
          ctx.strokeStyle = p.color;
          ctx.strokeRect((W - w) / 2, (H - h) / 2, w, h);
        }
      };
      img.src = url;
    });
    return;
  }
  // Text-bearing thumb.
  const text = p.kind === "date" ? renderDateText(p.text) : (p.text ?? "");
  ctx.fillStyle = p.color;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = 1;
  // Auto-fit font.
  const targetH = H - 8;
  let fs = Math.min(targetH, p.fontSize ?? 14);
  ctx.font = `bold ${fs}px "MS UI Gothic", sans-serif`;
  let tw = ctx.measureText(text).width;
  if (tw > W - 6) {
    fs = Math.max(6, fs * ((W - 6) / tw));
    ctx.font = `bold ${fs}px "MS UI Gothic", sans-serif`;
    tw = ctx.measureText(text).width;
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  if (p.frame === "rect") {
    ctx.strokeRect(2, 2, W - 4, H - 4);
  } else if (p.frame === "circle") {
    ctx.beginPath();
    ctx.ellipse(W / 2, H / 2, W / 2 - 2, H / 2 - 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillText(text, W / 2, H / 2);
}

function rebuildStampPalette() {
  const palette = $("stamp-preset-palette");
  if (!palette) return;
  palette.innerHTML = "";
  if (_stampPresetCache.size === 0) {
    const empty = document.createElement("div");
    empty.className = "stamp-preset-empty";
    empty.textContent = "未登録です。「スタンプ管理…」から登録してください";
    palette.appendChild(empty);
    return;
  }
  for (const p of _stampPresetCache.values()) {
    const btn = document.createElement("button");
    btn.className = "stamp-preset-btn";
    btn.dataset.presetId = p.id;
    if (p.id === _activeStampPresetId) btn.classList.add("is-active");
    const thumb = document.createElement("canvas");
    thumb.className = "stamp-preset-thumb";
    thumb.width = 40;
    thumb.height = 22;
    paintPresetThumb(thumb, p);
    btn.appendChild(thumb);
    const lbl = document.createElement("span");
    lbl.className = "stamp-preset-label";
    lbl.textContent = p.label;
    btn.appendChild(lbl);
    btn.title = `${p.kind === "date" ? "日付" : p.kind === "text" ? "文字" : "画像"}: ${p.label}`;
    btn.addEventListener("click", () => {
      setActiveStampPreset(p.id);
      if (placementMode !== "stamp") setPlacementMode("stamp");
    });
    palette.appendChild(btn);
  }
}

function refreshStampPaletteActive() {
  const palette = $("stamp-preset-palette");
  if (!palette) return;
  for (const btn of palette.querySelectorAll(".stamp-preset-btn")) {
    btn.classList.toggle("is-active", btn.dataset.presetId === _activeStampPresetId);
  }
}

/** Format a date according to the spec key — same logic as the
 *  current built-in date templates so the registered preset
 *  produces the same text at placement time. */
function renderDateText(formatKey) {
  const d = new Date();
  const reiwa = d.getFullYear() - 2018;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  // Hyphen-as-zero-fill: only single-digit values get the leading "-".
  // Two-digit values (10..99) print as-is. So 令和8年5月10日 →
  // "-8.-5.10", not "-8.-5.-10".
  const dp = (n) => (n < 10 ? `-${n}` : String(n));
  if (formatKey === "date-numeric-fw") return `${dp(reiwa)}．${dp(m)}．${dp(day)}`;
  if (formatKey === "date-kanji-dash") return `令和${dp(reiwa)}年${dp(m)}月${dp(day)}日`;
  if (formatKey === "date-numeric-spaced") {
    // Three numbers, each zero-fill-as-hyphen. Separator dots are
    // not drawn — placement adds spacingMode='distribute-3' so the
    // renderer distributes the three tokens across the box width
    // instead of laying them out as a single text line.
    return `${dp(reiwa)} ${dp(m)} ${dp(day)}`;
  }
  return `${dp(reiwa)}.${dp(m)}.${dp(day)}`; // default = numeric-dash
}

// ---- Stamp manager dialog ---------------------------------------------

const stampMgrDialog = $("stamp-manager-dialog");
const stampMgrList = $("stamp-mgr-list");
function openStampManagerDialog() {
  if (!isOpen) return;
  populateStampMgrList();
  stampMgrDialog.hidden = false;
}
function closeStampManagerDialog() { stampMgrDialog.hidden = true; }
$("stamp-mgr-close")?.addEventListener("click", closeStampManagerDialog);
stampMgrDialog?.addEventListener("click", (e) => {
  if (e.target === stampMgrDialog) closeStampManagerDialog();
});
$("stamp-mgr-date")?.addEventListener("click", () => openStampRegisterDate());
$("stamp-mgr-text")?.addEventListener("click", () => openStampRegisterText());
$("stamp-mgr-image")?.addEventListener("click", () => openStampRegisterImage());
$("stamp-mgr-font")?.addEventListener("click", () => openStampFontDialog());

/** Mirrors `drawStampMixedTextOnCanvas` in exporter.js — kept local so
 *  the font dialog preview stays self-contained. */
function drawStampMixedText(ctx, text, cx, cy, fontSize, color, fullStack, halfStack) {
  const runs = splitStampRuns(text);
  const widths = [];
  let total = 0;
  for (const run of runs) {
    ctx.font = `bold ${fontSize}px ${run.cls === "half" ? halfStack : fullStack}`;
    const m = ctx.measureText(run.text);
    widths.push(m.width);
    total += m.width;
  }
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let pen = cx - total / 2;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    ctx.font = `bold ${fontSize}px ${run.cls === "half" ? halfStack : fullStack}`;
    ctx.fillText(run.text, pen, cy);
    pen += widths[i];
  }
}

// ---- スタンプ用フォント設定 dialog (ADR-0019 後半 MVP) ------------------
const stampFontDialog = $("stamp-font-dialog");
const stampFontFullSel = $("stamp-font-full");
const stampFontHalfSel = $("stamp-font-half");
const stampFontPreview = $("stamp-font-preview");
function populateStampFontSelects() {
  if (!stampFontFullSel || !stampFontHalfSel) return;
  for (const sel of [stampFontFullSel, stampFontHalfSel]) {
    sel.innerHTML = "";
    for (const id of Object.keys(STAMP_FONT_STACKS)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = STAMP_FONT_LABELS[id] ?? id;
      sel.appendChild(opt);
    }
  }
}
function openStampFontDialog() {
  populateStampFontSelects();
  const cur = getStampFontDefaults();
  stampFontFullSel.value = cur.full;
  stampFontHalfSel.value = cur.half;
  paintStampFontPreview();
  stampFontDialog.hidden = false;
}
function closeStampFontDialog() { stampFontDialog.hidden = true; }
function paintStampFontPreview() {
  if (!stampFontPreview) return;
  const ctx = stampFontPreview.getContext("2d");
  const W = stampFontPreview.width;
  const H = stampFontPreview.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#cccccc";
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  const fullStack = getStampFontStack(stampFontFullSel.value);
  const halfStack = getStampFontStack(stampFontHalfSel.value);
  const sample = "令和8年5月10日";
  drawStampMixedText(ctx, sample, W / 2, H / 2, 22, "#cc0000", fullStack, halfStack);
}
stampFontFullSel?.addEventListener("change", paintStampFontPreview);
stampFontHalfSel?.addEventListener("change", paintStampFontPreview);
$("stamp-font-cancel")?.addEventListener("click", closeStampFontDialog);
stampFontDialog?.addEventListener("click", (e) => {
  if (e.target === stampFontDialog) closeStampFontDialog();
});
$("stamp-font-ok")?.addEventListener("click", () => {
  setStampFontDefaults({
    full: stampFontFullSel.value,
    half: stampFontHalfSel.value,
  });
  closeStampFontDialog();
  // Re-render the viewer so existing stamp overlays pick up the new
  // font defaults immediately. exporter & ghost preview re-read on
  // next call so they don't need explicit invalidation.
  if (viewer) viewer.refreshAllOverlays?.();
});

async function populateStampMgrList() {
  stampMgrList.innerHTML = "";
  await refreshStampPresetCacheAndSelect();
  if (_stampPresetCache.size === 0) {
    const li = document.createElement("li");
    li.className = "stamp-mgr-list-empty";
    li.textContent = "(まだ登録されていません)";
    stampMgrList.appendChild(li);
    return;
  }
  for (const p of _stampPresetCache.values()) {
    const li = document.createElement("li");
    const lab = document.createElement("span");
    lab.className = "stamp-mgr-label";
    const kindLabel = p.kind === "date" ? "日付" : p.kind === "text" ? "文字" : "画像";
    lab.textContent = `${kindLabel}: ${p.label}`;
    li.appendChild(lab);
    const useBtn = document.createElement("button");
    useBtn.textContent = "使う";
    useBtn.addEventListener("click", () => {
      setActiveStampPreset(p.id);
      setPlacementMode("stamp");
      closeStampManagerDialog();
    });
    li.appendChild(useBtn);
    const editBtn = document.createElement("button");
    editBtn.textContent = "編集";
    editBtn.addEventListener("click", () => {
      closeStampManagerDialog();
      openStampRegisterForEdit(p);
    });
    li.appendChild(editBtn);
    const delBtn = document.createElement("button");
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", async () => {
      const ok = await customConfirm({
        title: "スタンプ削除",
        message: `「${p.label}」を削除しますか？`,
        okLabel: "削除",
      });
      if (!ok) return;
      await kpdf3.removeStampPreset(p.id);
      await populateStampMgrList();
    });
    li.appendChild(delBtn);
    stampMgrList.appendChild(li);
  }
}

// ---- Generic stamp preview painter (used by all 3 register dialogs) ----
function tintCanvasInPlace(ctx, hex) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? ""));
  if (!m) return;
  const v = m[1];
  const tr = parseInt(v.slice(0, 2), 16);
  const tg = parseInt(v.slice(2, 4), 16);
  const tb = parseInt(v.slice(4, 6), 16);
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    d[i + 3] = Math.round(d[i + 3] * (1 - lum));
    d[i] = tr;
    d[i + 1] = tg;
    d[i + 2] = tb;
  }
  ctx.putImageData(img, 0, 0);
}

function paintStampPreview(canvas, props) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const W = canvas.width;
  const H = canvas.height;
  // Centered; preview canvas is small so we draw at a fixed scale.
  const pad = 4;
  const innerW = W - pad * 2;
  const innerH = H - pad * 2;
  // White paper backdrop.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#cccccc";
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  // Stamp content
  ctx.save();
  if (props.kind === "image" && props.bitmap) {
    // Fit image preserving aspect ratio.
    const bw = props.bitmap.width, bh = props.bitmap.height;
    const scale = Math.min(innerW / bw, innerH / bh);
    const w = bw * scale, h = bh * scale;
    const dx = (W - w) / 2, dy = (H - h) / 2;
    if (props.color) {
      // Draw a tinted preview by composing onto an offscreen canvas
      // (luminance → alpha + RGB ← color), then copying the result.
      const off = document.createElement("canvas");
      off.width = bw;
      off.height = bh;
      const octx = off.getContext("2d");
      octx.drawImage(props.bitmap, 0, 0);
      tintCanvasInPlace(octx, props.color);
      ctx.drawImage(off, dx, dy, w, h);
    } else {
      ctx.drawImage(props.bitmap, dx, dy, w, h);
    }
    if (props.frame === "rect") {
      ctx.strokeStyle = props.color || "#000000";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(dx, dy, w, h);
    } else if (props.frame === "circle") {
      ctx.beginPath();
      ctx.ellipse(W / 2, H / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.strokeStyle = props.color || "#000000";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  // Text-bearing preview (date / text)
  ctx.fillStyle = props.color;
  ctx.strokeStyle = props.color;
  ctx.lineWidth = 1.5;
  ctx.font = `bold ${props.fontSize}px "MS UI Gothic", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const text = props.text ?? "";
  const metrics = ctx.measureText(text);
  const textW = metrics.width;
  const boxW = props.frame === "circle"
    ? Math.max(textW + 16, props.fontSize * 2.4)
    : Math.max(textW + 16, props.fontSize * 1.5);
  const boxH = props.frame === "circle"
    ? boxW
    : Math.max(props.fontSize + 12, props.fontSize * 1.6);
  const fitScale = Math.min(innerW / boxW, innerH / boxH, 1);
  const w = boxW * fitScale, h = boxH * fitScale;
  const cx = W / 2, cy = H / 2;
  if (props.frame === "circle") {
    ctx.beginPath();
    ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (props.frame === "rect") {
    ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
  }
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

// ---- 日付スタンプ register dialog --------------------------------------

const stampRegDateDialog = $("stamp-register-date");
const stampRegDateColor = $("stamp-reg-date-color");
const stampRegDateFrame = $("stamp-reg-date-frame");
const stampRegDateLabel = $("stamp-reg-date-label");
const stampRegDateFontSize = $("stamp-reg-date-fontsize");
const stampRegDatePreview = $("stamp-reg-date-preview");
// id of the preset currently being edited (vs. created); null on create.
let _editingPresetId = null;

function openStampRegisterDate(prefill = null) {
  _editingPresetId = prefill?.id ?? null;
  const fmt = prefill?.text ?? "date-numeric-dash";
  const radio = document.querySelector(`input[name="stamp-date-format"][value="${fmt}"]`);
  if (radio) radio.checked = true;
  else document.querySelector('input[name="stamp-date-format"][value="date-numeric-dash"]').checked = true;
  stampRegDateColor.value = prefill?.color ?? "#cc0000";
  stampRegDateFrame.checked = prefill ? prefill.frame !== "none" : true;
  stampRegDateLabel.value = prefill?.label ?? "";
  if (stampRegDateFontSize) {
    stampRegDateFontSize.value = String(prefill?.fontSize ?? 14);
  }
  stampRegDateDialog.hidden = false;
  paintStampRegDatePreview();
}

/** Open the matching register dialog for an existing preset, prefilled
 *  with its current values. Used by the スタンプ管理 list's 編集 btn. */
function openStampRegisterForEdit(p) {
  if (p.kind === "date") openStampRegisterDate(p);
  else if (p.kind === "text") openStampRegisterText(p);
  else if (p.kind === "image") openStampRegisterImage(p);
}
function closeStampRegisterDate() { stampRegDateDialog.hidden = true; }
function getDateRegFormatKey() {
  const r = document.querySelector('input[name="stamp-date-format"]:checked');
  return r?.value ?? "date-numeric-dash";
}
function paintStampRegDatePreview() {
  const formatKey = getDateRegFormatKey();
  const fs = Math.max(6, Math.min(72, Number(stampRegDateFontSize?.value) || 14));
  paintStampPreview(stampRegDatePreview, {
    text: renderDateText(formatKey),
    color: stampRegDateColor.value,
    frame: stampRegDateFrame.checked ? "rect" : "none",
    fontSize: fs,
  });
}
stampRegDateDialog?.addEventListener("change", paintStampRegDatePreview);
stampRegDateDialog?.addEventListener("input", paintStampRegDatePreview);
$("stamp-reg-date-cancel")?.addEventListener("click", closeStampRegisterDate);
stampRegDateDialog?.addEventListener("click", (e) => {
  if (e.target === stampRegDateDialog) closeStampRegisterDate();
});
$("stamp-reg-date-ok")?.addEventListener("click", async () => {
  const formatKey = getDateRegFormatKey();
  const formatLabels = {
    "date-numeric-dash": "-8.-5.-9",
    "date-numeric-fw": "-8．-5．-9",
    "date-kanji-dash": "令和-8年-5月-9日",
    "date-numeric-spaced": "-8 -5 -9 (字間調整)",
  };
  const label = stampRegDateLabel.value.trim() || formatLabels[formatKey] || "日付";
  const fontSize = Math.max(6, Math.min(72, Number(stampRegDateFontSize?.value) || 14));
  // Box width scales with fontSize so a 24pt date doesn't overflow a
  // 14pt-sized box. The base widths below were tuned for fontSize 14.
  const baseWidth = formatKey === "date-kanji-dash"
    ? 140
    : formatKey === "date-numeric-spaced"
      ? 90
      : 105;
  await kpdf3.addStampPreset({
    id: _editingPresetId, // null on create, existing id on edit (upsert)
    kind: "date",
    label,
    color: stampRegDateColor.value,
    frame: stampRegDateFrame.checked ? "rect" : "none",
    fontSize,
    text: formatKey, // store the format spec, render the date at placement
    // distribute-3 default = the natural "compact" width, matching
    // what the preview shows. Users WIDEN the box by dragging the
    // resize handle to fit the preprinted year/month/day positions
    // on the underlying paper.
    width: Math.round(baseWidth * (fontSize / 14)),
    height: Math.round(40 * (fontSize / 14)),
  });
  _editingPresetId = null;
  closeStampRegisterDate();
  await populateStampMgrList();
  // Reopen manager so the user sees the updated entry without a 2-step
  // (otherwise they'd have to re-open the menu).
  openStampManagerDialog();
});

// ---- テキストスタンプ register dialog ----------------------------------

const stampRegTextDialog = $("stamp-register-text");
const stampRegTextText = $("stamp-reg-text-text");
const stampRegTextFontSize = $("stamp-reg-text-fontsize");
const stampRegTextColor = $("stamp-reg-text-color");
const stampRegTextFrame = $("stamp-reg-text-frame");
const stampRegTextLabel = $("stamp-reg-text-label");
const stampRegTextPreview = $("stamp-reg-text-preview");
function openStampRegisterText(prefill = null) {
  _editingPresetId = prefill?.id ?? null;
  stampRegTextText.value = prefill?.text ?? "";
  stampRegTextFontSize.value = String(prefill?.fontSize ?? 14);
  stampRegTextColor.value = prefill?.color ?? "#cc0000";
  stampRegTextFrame.checked = prefill ? prefill.frame !== "none" : true;
  stampRegTextLabel.value = prefill?.label ?? "";
  stampRegTextDialog.hidden = false;
  paintStampRegTextPreview();
  setTimeout(() => stampRegTextText.focus(), 0);
}
function closeStampRegisterText() { stampRegTextDialog.hidden = true; }
function paintStampRegTextPreview() {
  paintStampPreview(stampRegTextPreview, {
    text: stampRegTextText.value || "テキスト",
    color: stampRegTextColor.value,
    frame: stampRegTextFrame.checked ? "rect" : "none",
    fontSize: Number(stampRegTextFontSize.value) || 14,
  });
}
stampRegTextDialog?.addEventListener("input", paintStampRegTextPreview);
stampRegTextDialog?.addEventListener("change", paintStampRegTextPreview);
$("stamp-reg-text-cancel")?.addEventListener("click", closeStampRegisterText);
stampRegTextDialog?.addEventListener("click", (e) => {
  if (e.target === stampRegTextDialog) closeStampRegisterText();
});
$("stamp-reg-text-ok")?.addEventListener("click", async () => {
  const text = stampRegTextText.value.trim();
  if (!text) {
    wsStatus.textContent = "テキストを入力してください";
    return;
  }
  const fontSize = Math.max(6, Math.min(72, Number(stampRegTextFontSize.value) || 14));
  await kpdf3.addStampPreset({
    id: _editingPresetId,
    kind: "text",
    label: stampRegTextLabel.value.trim() || text,
    color: stampRegTextColor.value,
    frame: stampRegTextFrame.checked ? "rect" : "none",
    fontSize,
    text,
    // Generous default — text overlay can be resized after placement.
    width: Math.max(60, text.length * fontSize * 0.85),
    height: Math.max(20, fontSize * 1.6),
  });
  _editingPresetId = null;
  closeStampRegisterText();
  await populateStampMgrList();
  openStampManagerDialog();
});

// ---- 画像スタンプ register dialog --------------------------------------

const stampRegImageDialog = $("stamp-register-image");
const stampRegImagePickBtn = $("stamp-reg-image-pick");
const stampRegImageName = $("stamp-reg-image-name");
const stampRegImageW = $("stamp-reg-image-w");
const stampRegImageH = $("stamp-reg-image-h");
const stampRegImageFrame = $("stamp-reg-image-frame");
const stampRegImageColor = $("stamp-reg-image-color");
const stampRegImageLabel = $("stamp-reg-image-label");
const stampRegImagePreview = $("stamp-reg-image-preview");
const stampRegImageOk = $("stamp-reg-image-ok");
let _stampRegImageState = null; // { path, mime, bitmap, naturalW, naturalH, label }
async function openStampRegisterImage(prefill = null) {
  _editingPresetId = prefill?.id ?? null;
  _stampRegImageState = null;
  stampRegImageName.textContent = "(未選択)";
  stampRegImageW.value = String(prefill?.width ?? 80);
  stampRegImageH.value = String(prefill?.height ?? 80);
  stampRegImageFrame.checked = prefill ? prefill.frame !== "none" : false;
  // Tint color: empty string means "no tint" (image as-is). Persisted
  // as "" in stamp_presets.color so existing presets keep working.
  if (stampRegImageColor) stampRegImageColor.value = prefill?.color ?? "";
  stampRegImageLabel.value = prefill?.label ?? "";
  stampRegImageOk.disabled = !prefill?.assetId;
  // If editing, fetch the existing asset bitmap for the preview.
  if (prefill?.assetId) {
    try {
      const data = await kpdf3.getAsset(prefill.assetId);
      if (data?.blob) {
        const u8 = data.blob instanceof Uint8Array
          ? data.blob
          : new Uint8Array(data.blob.buffer ?? data.blob);
        const blob = new Blob([u8], { type: data.mime || "image/png" });
        const bitmap = await createImageBitmap(blob);
        _stampRegImageState = {
          assetId: prefill.assetId,
          mime: data.mime,
          bitmap,
          naturalW: bitmap.width,
          naturalH: bitmap.height,
          label: data.label ?? "",
        };
        stampRegImageName.textContent = data.label ?? "(登録済み画像)";
      }
    } catch (err) {
      console.error("[stamp-img] prefill load failed", err);
    }
  }
  paintStampRegImagePreview();
  stampRegImageDialog.hidden = false;
}
function closeStampRegisterImage() { stampRegImageDialog.hidden = true; }
function paintStampRegImagePreview() {
  paintStampPreview(stampRegImagePreview, {
    kind: "image",
    bitmap: _stampRegImageState?.bitmap,
    color: stampRegImageColor?.value || "",
    frame: stampRegImageFrame.checked ? "rect" : "none",
  });
}
stampRegImagePickBtn?.addEventListener("click", async () => {
  const path = await showFileBrowser({
    mode: "open",
    title: "印影画像を選択",
    filterDefault: "image",
  });
  if (!path) return;
  // Read the bytes via the existing addAssetFromFile infrastructure —
  // here we just need to preview, not commit yet. Re-use the asset
  // pipeline by registering tentatively, then if user cancels we leave
  // the asset orphaned (cheap, dedup keeps a single copy of identical
  // images). Could be optimised in a follow-up.
  try {
    const r = await kpdf3.addAssetFromFile({ path });
    const data = await kpdf3.getAsset(r.id);
    if (!data?.blob) throw new Error("asset blob unavailable");
    const u8 = data.blob instanceof Uint8Array
      ? data.blob
      : new Uint8Array(data.blob.buffer ?? data.blob);
    const blob = new Blob([u8], { type: data.mime || "image/png" });
    const bitmap = await createImageBitmap(blob);
    _stampRegImageState = {
      assetId: r.id,
      mime: r.mime,
      bitmap,
      naturalW: bitmap.width,
      naturalH: bitmap.height,
      label: data.label ?? "",
    };
    stampRegImageName.textContent = path.split(/[\\/]/).pop();
    if (!stampRegImageLabel.value) stampRegImageLabel.value = _stampRegImageState.label;
    // Default width = 80 pt; height computed from aspect ratio.
    const w = Number(stampRegImageW.value) || 80;
    const h = Math.round((w * bitmap.height) / bitmap.width);
    stampRegImageH.value = String(h);
    stampRegImageOk.disabled = false;
    paintStampRegImagePreview();
  } catch (err) {
    console.error("[stamp-img] preview failed", err);
    wsStatus.textContent = `画像読み込み失敗: ${err.message ?? err}`;
  }
});
stampRegImageW?.addEventListener("input", () => {
  if (!_stampRegImageState) return;
  const w = Number(stampRegImageW.value) || 0;
  const h = Math.round((w * _stampRegImageState.naturalH) / _stampRegImageState.naturalW);
  stampRegImageH.value = String(h);
});
stampRegImageFrame?.addEventListener("change", paintStampRegImagePreview);
stampRegImageColor?.addEventListener("change", paintStampRegImagePreview);
$("stamp-reg-image-cancel")?.addEventListener("click", closeStampRegisterImage);
stampRegImageDialog?.addEventListener("click", (e) => {
  if (e.target === stampRegImageDialog) closeStampRegisterImage();
});
stampRegImageOk?.addEventListener("click", async () => {
  if (!_stampRegImageState) return;
  const w = Math.max(10, Math.min(400, Number(stampRegImageW.value) || 80));
  const h = Math.max(10, Math.min(400, Number(stampRegImageH.value) || 80));
  await kpdf3.addStampPreset({
    id: _editingPresetId,
    kind: "image",
    label: stampRegImageLabel.value.trim() || _stampRegImageState.label || "image",
    color: stampRegImageColor?.value || "",
    frame: stampRegImageFrame.checked ? "rect" : "none",
    fontSize: 14,
    assetId: _stampRegImageState.assetId,
    width: w,
    height: h,
  });
  _editingPresetId = null;
  closeStampRegisterImage();
  await populateStampMgrList();
  openStampManagerDialog();
});

// (Old "image stamp via toolbar select" pathway removed — the スタンプ
// 管理 → 画像スタンプ register dialog is now the sole entry point.)

// ---- Stamp drag ghost (preview that follows the cursor) ---------------
let stampGhostEl = null;

function ensureStampGhost() {
  if (stampGhostEl) return stampGhostEl;
  const el = document.createElement("div");
  el.className = "stamp-ghost stamp-ghost-circle";
  el.hidden = true;
  document.body.appendChild(el);
  stampGhostEl = el;
  updateStampGhostPreset();
  return el;
}

function updateStampGhostPreset() {
  if (!stampGhostEl) return;
  const preset = currentStampPreset();
  // Reset content + classes
  stampGhostEl.textContent = "";
  stampGhostEl.classList.remove(
    "stamp-ghost-circle", "stamp-ghost-rect", "stamp-ghost-none", "stamp-ghost-image",
  );
  if (!preset) {
    // No active preset — hide the ghost; placement is a no-op anyway.
    stampGhostEl.hidden = true;
    return;
  }
  if (preset.kind === "image" && preset.assetId) {
    stampGhostEl.classList.add("stamp-ghost-image");
    const img = document.createElement("img");
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.draggable = false;
    img.style.pointerEvents = "none";
    _stampGhostAssetUrl(preset.assetId, preset.color).then((url) => {
      if (url) img.src = url;
    });
    stampGhostEl.appendChild(img);
    stampGhostEl.style.color = "transparent";
    return;
  }
  stampGhostEl.textContent = preset.text;
  stampGhostEl.style.color = preset.color;
  // Frame class — explicit "none" branch so frame:none stamps don't
  // get a misleading rectangle outline in the ghost preview.
  if (preset.frame === "circle") {
    stampGhostEl.classList.add("stamp-ghost-circle");
  } else if (preset.frame === "rect") {
    stampGhostEl.classList.add("stamp-ghost-rect");
  } else {
    stampGhostEl.classList.add("stamp-ghost-none");
  }
}

// Reuse viewer's blob-URL cache for the ghost (so we don't double-fetch).
const _stampGhostUrlCache = new Map();
async function _stampGhostAssetUrl(assetId, color) {
  const key = color ? `${assetId} ${color}` : assetId;
  if (_stampGhostUrlCache.has(key)) return _stampGhostUrlCache.get(key);
  try {
    const data = await kpdf3.getAsset(assetId);
    if (!data?.blob) return null;
    const u8 = data.blob instanceof Uint8Array
      ? data.blob
      : new Uint8Array(data.blob.buffer ?? data.blob);
    const blob = new Blob([u8], { type: data.mime || "image/png" });
    if (!color) {
      const url = URL.createObjectURL(blob);
      _stampGhostUrlCache.set(key, url);
      return url;
    }
    // Tinted variant — paint into a canvas, encode to PNG.
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    tintCanvasInPlace(ctx, color);
    const url = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null), "image/png"),
    );
    if (url) _stampGhostUrlCache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

function updateStampGhostSize() {
  if (!stampGhostEl) return;
  const preset = currentStampPreset();
  if (!preset) return;
  const z = viewer.zoom;
  stampGhostEl.style.width = `${preset.w * z}px`;
  stampGhostEl.style.height = `${preset.h * z}px`;
  stampGhostEl.style.fontSize = `${preset.fontSize * z}px`;
}

function moveStampGhost(clientX, clientY) {
  const el = ensureStampGhost();
  const preset = currentStampPreset();
  if (!preset) return;
  const z = viewer.zoom;
  el.style.left = `${clientX - (preset.w * z) / 2}px`;
  el.style.top = `${clientY - (preset.h * z) / 2}px`;
}

function onViewerMouseMoveForStampGhost(e) {
  if (placementMode !== "stamp") return;
  // Size has to track viewer.zoom which the user can change while in
  // stamp mode; cheap enough to set on every move.
  updateStampGhostSize();
  moveStampGhost(e.clientX, e.clientY);
  ensureStampGhost().hidden = false;
}
function onViewerMouseLeaveForStampGhost() {
  if (stampGhostEl) stampGhostEl.hidden = true;
}

function syncStampGhostMode() {
  if (placementMode === "stamp") {
    ensureStampGhost();
    updateStampGhostSize();
    viewerContainer.addEventListener("mousemove", onViewerMouseMoveForStampGhost);
    viewerContainer.addEventListener("mouseleave", onViewerMouseLeaveForStampGhost);
  } else {
    if (stampGhostEl) stampGhostEl.hidden = true;
    viewerContainer.removeEventListener("mousemove", onViewerMouseMoveForStampGhost);
    viewerContainer.removeEventListener("mouseleave", onViewerMouseLeaveForStampGhost);
  }
}

function setOpen(open) {
  isOpen = open;
  // The toolbar 開く button stays enabled across PDFs so the user can
  // load another file immediately (replacing the active tab's PDF
  // through the existing confirmDiscardIfDirty path) without having
  // to close-then-open.
  btnOpen.disabled = false;
  btnExport.disabled = !open;
  btnPrint.disabled = !open;
  zoomSelect.disabled = !open;
  btnModeText.disabled = !open;
  btnModeStamp.disabled = !open;
  btnModeRedaction.disabled = !open;
  btnSplit.disabled = !open;
  btnRotateLeft.disabled = !open;
  btnRotateRight.disabled = !open;
  if (redactionColorSel) redactionColorSel.disabled = !open;
  if (textFontSel) textFontSel.disabled = !open;
  if (textSizeSel) textSizeSel.disabled = !open;
  if (btnModeMarker) btnModeMarker.disabled = !open;
  if (markerColorSel) markerColorSel.disabled = !open;
  if (btnModeCallout) btnModeCallout.disabled = !open;
  const btnPageNums = $("btn-page-numbers");
  if (btnPageNums) btnPageNums.disabled = !open;
  const btnPagePopup = $("btn-page-popup");
  if (btnPagePopup) btnPagePopup.disabled = !open;
  // (stampTemplateSel / stampColorSel removed — palette buttons are
  // managed by rebuildStampPalette + the mode-options bar visibility.)
  if (!open) {
    setPlacementMode("none");
    setSplitMode(false);
    // Clear sidebar artifacts that survive across close paths. Some
    // close routes (tab × button when no other tabs remain, switching
    // to a fresh blank tab) bypass refreshViewer's `!isOpen` cleanup,
    // which left stale thumbnails and bookmarks visible after the
    // workspace was actually gone.
    if (typeof clearThumbs === "function") clearThumbs();
    if (bookmarkTree) bookmarkTree.innerHTML = "";
    if (sidebar) sidebar.hidden = true;
    if (wsStatus) wsStatus.textContent = "PDF を「開く」で読み込みます";
  }
  refreshMenuState();
  refreshDirtyIndicator();
  refreshSidebarToggle();
  refreshZoomSelect();
  refreshSearchEnabled();
  // Mirror onto the active tab so the tab bar's dirty mark + close
  // confirmation reflect reality.
  const tab = getActiveTab();
  if (tab) tab.isOpen = open;
}

/** Refresh the title bar / file label / status bar to reflect the dirty flag. */
const appTitleText = $("app-title-text");
const APP_TITLE_DEFAULT = "K-PDF3 — 法律実務向け PDF Workspace";

// ---- Window controls (frame: false custom title bar) -----------------
const winMinimizeBtn = $("win-minimize");
const winMaximizeBtn = $("win-maximize");
const winCloseBtn = $("win-close");

winMinimizeBtn.addEventListener("click", () => kpdf3.windowMinimize());
winMaximizeBtn.addEventListener("click", () => kpdf3.windowMaximizeToggle());
winCloseBtn.addEventListener("click", async () => {
  // Aggregate-confirm across all tabs first. main's WM-close path
  // (e.g. Alt+F4) already triggers `beforeunload`, but the custom
  // title-bar X bypasses that — handle it here so the user always
  // gets the multi-tab summary dialog before losing work.
  if (!(await confirmDiscardAcrossAllTabs())) return;
  _reloadingRenderer = true; // disable beforeunload check
  kpdf3.windowClose();
});

// Double-click on title bar toggles maximize (Windows convention).
$("app-title-text").addEventListener("dblclick", () => {
  kpdf3.windowMaximizeToggle();
});

function setMaximizedGlyph(isMax) {
  // 98.css picks the glyph from aria-label; swap between Maximize/Restore.
  winMaximizeBtn.setAttribute("aria-label", isMax ? "Restore" : "Maximize");
}
kpdf3.onWindowState(({ maximized }) => setMaximizedGlyph(maximized));
kpdf3.windowIsMaximized().then(setMaximizedGlyph);

function refreshDirtyIndicator() {
  const dirty = isOpen && isWorkspaceDirty();
  const prefix = dirty ? "● " : "";
  if (isOpen) {
    document.title = `${prefix}${activeSourceName || "K-PDF3"} — K-PDF3`;
    appTitleText.textContent = `${prefix}${activeSourceName || "K-PDF3"}`;
  } else {
    document.title = "K-PDF3";
    appTitleText.textContent = APP_TITLE_DEFAULT;
  }
  btnSave.disabled = !dirty;
  // Re-render the tab bar so its dirty-mark dot updates as the user
  // edits. Cheap (Map iteration + DOM rebuild for 1-5 tabs).
  renderTabBar();
}

/**
 * Recompute menu enabled state from the current open / history state.
 * Called whenever isOpen changes or history fires its listener.
 */
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

function refreshMenuState() {
  const z = viewer.zoom;
  menuBar.setEnabled({
    // Always enabled — see toolbar comment in setOpen().
    open: true,
    close: isOpen,
    save: isOpen && isWorkspaceDirty(),
    undo: isOpen && history.canUndo(),
    redo: isOpen && history.canRedo(),
    "zoom-in": isOpen && z < ZOOM_STEPS[ZOOM_STEPS.length - 1],
    "zoom-out": isOpen && z > ZOOM_STEPS[0],
    "zoom-fit": isOpen,
    "zoom-fit-page": isOpen,
    "zoom-100": isOpen && Math.abs(z - 1.0) > 1e-6,
    "page-prev":
      isOpen &&
      !!viewer.registry &&
      viewer.registry.posOfPageNo(viewer.currentPage) > 0,
    "page-next":
      isOpen &&
      !!viewer.registry &&
      viewer.registry.posOfPageNo(viewer.currentPage) <
        viewer.registry.count() - 1,
    "page-goto": isOpen,
    "toggle-bookmarks": isOpen,
    export: isOpen,
    "export-range": isOpen,
    "split-save": isOpen,
    print: isOpen,
    "mode-text": isOpen,
    "mode-stamp": isOpen,
    "mode-redaction": isOpen,
    "mode-marker": isOpen,
    "mode-callout": isOpen,
    // Future tools — kept disabled until M6 (placeholder slots)
    "stamp-manager": isOpen,
    "font-settings": true, // available even with no PDF open (workspace-wide)
    // Still M5+ stubs (clipboard)
    cut: false,
    copy: false,
    paste: false,
  });
  const q = viewer.renderQuality;
  menuBar.setChecked({
    "mode-text": placementMode === "text",
    "mode-stamp": placementMode === "stamp",
    "mode-redaction": placementMode === "redaction",
    "mode-marker": placementMode === "marker",
    "mode-callout": placementMode === "callout",
    "quality-standard": q === "standard",
    "quality-high": q === "high",
    "quality-max": q === "max",
  });
}

history.subscribe(() => refreshMenuState());
projectStore.subscribe((event) => {
  refreshDirtyIndicator();
  refreshMenuState();
  // Invalidate thumb caches for pages whose overlays changed so the
  // sidebar / split-save thumbs reflect the latest content (stamps,
  // marks, text).
  if (!event) return;
  // Drop the selection if its target disappeared.
  if (event.kind === "remove" && event.overlay?.id === selectedOverlayId) {
    selectedOverlayId = null; // already gone from DOM, no class to clear
  } else if (event.kind === "reset") {
    selectedOverlayId = null;
  } else if (event.kind === "update" && event.overlay?.id === selectedOverlayId) {
    // _renderPageOverlays rebuilds the DOM on update — re-apply the
    // selection class to the freshly-built element on next tick.
    setTimeout(() => reapplySelectionDom(), 0);
  }
  if (event.kind === "reset") {
    for (const pageNo of thumbCache.keys()) invalidateSidebarThumb(pageNo);
    splitState.thumbCache.clear();
    return;
  }
  if (Array.isArray(event.pages)) {
    for (const pageNo of event.pages) {
      invalidateSidebarThumb(pageNo);
      splitState.thumbCache.delete(pageNo);
    }
  }
});

/** Drop the cached canvas + DOM for a sidebar thumb so the next
 *  visibility check re-renders. */
function invalidateSidebarThumb(pageNo) {
  if (!thumbCache.has(pageNo)) return;
  thumbCache.delete(pageNo);
  if (!thumbList) return;
  const item = thumbList.querySelector(`.thumb-item[data-page-no="${pageNo}"]`);
  if (!item) return;
  const oldCanvas = item.querySelector(".thumb-img");
  if (oldCanvas) {
    const ph = document.createElement("div");
    ph.className = "thumb-placeholder";
    oldCanvas.replaceWith(ph);
  }
  // Trigger a fresh render if visible.
  requestVisibleThumbRenders();
}

// Refresh menu state when the page indicator changes (page-prev / page-next
// availability depends on currentPage). Done by chaining the existing
// onPageChange callback.
const _origUpdatePageIndicator = updatePageIndicator;
function updatePageIndicatorAndMenu(current, total) {
  _origUpdatePageIndicator(current, total);
  refreshMenuState();
  highlightCurrentThumb(current);
}
viewer.onPageChange = updatePageIndicatorAndMenu;

async function refreshViewer() {
  if (!isOpen) {
    activeSourceName = "";
    wsStatus.textContent = "PDF を「開く」で読み込みます";
    viewer.unload();
    sidebar.hidden = true;
    bookmarkTree.innerHTML = "";
    clearThumbs();
    refreshDirtyIndicator();
    return;
  }
  const meta = await kpdf3.getSourceMeta();
  const allPages = await kpdf3.getPages();
  // In-session pending deletions filter out pages prior to persistence.
  const pages = allPages.filter((p) => !pendingDeletedPages.has(p.pageNo));
  if (!meta || pages.length === 0) {
    activeSourceName = "";
    wsStatus.textContent = "(PDF が読み込めませんでした)";
    viewer.unload();
    sidebar.hidden = true;
    bookmarkTree.innerHTML = "";
    clearThumbs();
    refreshDirtyIndicator();
    return;
  }
  activeSourceName = meta.fileName ?? "";
  wsStatus.textContent = `${pages.length} ページ`;
  viewer.load(pages);
  // Apply the active fit mode so a fresh PDF lands at the user's
  // chosen sizing instead of the viewer's intrinsic default zoom.
  if (zoomMode === "fit-width") applyFitWidthNow();
  else if (zoomMode === "fit-page") applyFitPageNow();
  refreshBookmarks();
  rebuildThumbs(pages);
  refreshStampPresetCacheAndSelect();
  refreshDirtyIndicator();
  refreshZoomSelect();
}

async function confirmDiscardIfDirty() {
  if (!isWorkspaceDirty()) return true;
  return customConfirm({
    title: "未保存の変更",
    message: "未保存の変更があります。\n変更を破棄して続行しますか？",
    okLabel: "破棄して続行",
  });
}

/** Aggregate-confirm across every tab (used on app-window close).
 *  Returns true to proceed, false to cancel. Snapshots the active
 *  tab first so its live edits are visible to tabIsDirty(). */
async function confirmDiscardAcrossAllTabs() {
  saveActiveTabSnapshot();
  const dirtyTabs = [];
  for (const [, tab] of tabs) {
    if (tabIsDirty(tab)) dirtyTabs.push(tab);
  }
  if (dirtyTabs.length === 0) return true;
  const lines = dirtyTabs.map((t) => `  • ${tabDisplayTitle(t)}`).join("\n");
  return customConfirm({
    title: "未保存のタブがあります",
    message:
      `${dirtyTabs.length} 個のタブに未保存の変更があります:\n${lines}\n\n` +
      "破棄してすべて閉じますか？",
    okLabel: "破棄して閉じる",
    cancelLabel: "キャンセル",
  });
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

// ---- Custom confirm dialog (98-style, replaces window.confirm) -------
const confirmDialog = $("confirm-dialog");
const confirmTitle = $("confirm-title");
const confirmMessageEl = $("confirm-message");
const confirmOkBtn = $("confirm-ok");
const confirmCancelBtn = $("confirm-cancel");
/** @type {((value: boolean) => void) | null} */
let confirmDialogResolve = null;

/**
 * Win95-style confirm replacement. Returns a Promise<boolean>.
 * Esc / background-click / cancel button → false.
 * Enter / OK button → true.
 */
function customConfirm({
  title = "確認",
  message,
  okLabel = "OK",
  cancelLabel = "キャンセル",
} = {}) {
  confirmTitle.textContent = title;
  confirmMessageEl.textContent = message ?? "";
  confirmOkBtn.textContent = okLabel;
  confirmCancelBtn.textContent = cancelLabel;
  confirmDialog.hidden = false;
  setTimeout(() => confirmOkBtn.focus(), 0);
  return new Promise((resolve) => {
    confirmDialogResolve = resolve;
  });
}
function settleConfirm(value) {
  confirmDialog.hidden = true;
  if (confirmDialogResolve) {
    confirmDialogResolve(value);
    confirmDialogResolve = null;
  }
}
confirmOkBtn.addEventListener("click", () => settleConfirm(true));
confirmCancelBtn.addEventListener("click", () => settleConfirm(false));
confirmDialog.addEventListener("click", (e) => {
  if (e.target === confirmDialog) settleConfirm(false);
});
confirmDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    settleConfirm(false);
  } else if (e.key === "Enter") {
    e.preventDefault();
    settleConfirm(true);
  }
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
  if (!(await confirmDiscardIfDirty())) return;
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
        openPdfSmart(r.sourcePdfPath);
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
    // ADR-0015: bind the workspace handle on the main side to the
    // active tab's id. Phase 4's "+ button" creates a fresh TabState
    // first, so this same path also opens into NEW tabs.
    const result = await kpdf3.openPdfFile(pdfPath, activeTabId);
    projectStore.reset(result.overlays ?? []);
    pendingDeletedPages.clear();
    workspaceMutated = false;
    history.clear();
    // Push the source-PDF metadata onto the active tab so the tab bar
    // labels it correctly and so a future tab switch returns here.
    const tab = getActiveTab();
    if (tab) {
      tab.activeSourcePdfPath = pdfPath;
      const fname = pdfPath.split(/[\\/]/).pop() ?? "";
      tab.activeSourceName = fname;
    }
    setOpen(true);
    await refreshViewer();
    renderTabBar();
  } catch (err) {
    console.error("[renderer] openPdfFile (recent) failed:", err);
    wsStatus.textContent = `エラー: ${err.message ?? err}`;
  }
}

// ---- Generic Win95-style file browser (open / save / folder) ---------
const openDialog = $("open-dialog");
const openTitleText = $("open-title-text");
const openQuickSel = $("open-quick");
const openUpBtn = $("open-up");
const openCurrentPathEl = $("open-current-path");
const openFileList = $("open-file-list");
const openFilenameInput = $("open-filename");
const openFilenameRow = $("open-row-filename");
const openFilterSel = $("open-filter");
const openFilterRow = $("open-row-filter");
const openConfirmBtn = $("open-confirm");
const openCancelBtn = $("open-cancel");
const openTitlebarCloseBtn = $("open-titlebar-close");

const fileBrowserState = {
  mode: "open", // "open" | "save" | "folder"
  currentPath: null,
  parentPath: null,
  entries: [],
  selectedName: null,
  defaultPaths: null,
  resolve: null, // Promise resolver for the current invocation
};

function isPdfName(name) {
  return /\.pdf$/i.test(name);
}
function isImageName(name) {
  return /\.(png|jpe?g)$/i.test(name);
}

function classifyEntry(entry) {
  if (entry.isParent) return "open-entry open-entry-parent is-folder";
  if (entry.isDir) return "open-entry is-folder";
  if (isPdfName(entry.name)) return "open-entry is-pdf";
  if (isImageName(entry.name)) return "open-entry is-image";
  return "open-entry is-other";
}

function shouldShowEntry(entry) {
  if (entry.isParent || entry.isDir) return true;
  if (fileBrowserState.mode === "folder") return false; // hide files in folder mode
  const filter = openFilterSel.value;
  if (filter === "all") return true;
  if (filter === "image") return isImageName(entry.name);
  return isPdfName(entry.name);
}

function renderFileBrowserList() {
  openFileList.innerHTML = "";
  fileBrowserState.selectedName = null;
  if (fileBrowserState.mode !== "save") openFilenameInput.value = "";
  const visible = fileBrowserState.entries.filter(shouldShowEntry);
  if (visible.length === 0) {
    const li = document.createElement("li");
    li.className = "open-entry-empty";
    li.textContent = "(このフォルダには表示できる項目がありません)";
    openFileList.appendChild(li);
    return;
  }
  for (const entry of visible) {
    const li = document.createElement("li");
    li.className = classifyEntry(entry);
    li.dataset.name = entry.name;
    li.dataset.isDir = entry.isDir ? "1" : "0";
    li.dataset.isParent = entry.isParent ? "1" : "0";
    const nameEl = document.createElement("span");
    nameEl.className = "open-entry-name";
    nameEl.textContent = entry.isParent ? ".. (上のフォルダ)" : entry.name;
    li.appendChild(nameEl);
    li.addEventListener("click", () => selectFileEntry(entry, li));
    li.addEventListener("dblclick", () => activateFileEntry(entry));
    openFileList.appendChild(li);
  }
}

function selectFileEntry(entry, liEl) {
  for (const li of openFileList.querySelectorAll(".open-entry.selected")) {
    li.classList.remove("selected");
  }
  if (liEl) liEl.classList.add("selected");
  fileBrowserState.selectedName = entry.isParent ? null : entry.name;
  if (!entry.isDir && !entry.isParent) {
    openFilenameInput.value = entry.name;
  }
}

function activateFileEntry(entry) {
  if (entry.isParent) {
    if (fileBrowserState.parentPath) loadFileBrowserDir(fileBrowserState.parentPath);
    return;
  }
  if (entry.isDir) {
    loadFileBrowserDir(joinPath(fileBrowserState.currentPath, entry.name));
    return;
  }
  if (fileBrowserState.mode === "open") {
    const filter = openFilterSel.value;
    const accept =
      filter === "all" ||
      (filter === "image" && isImageName(entry.name)) ||
      (filter === "pdf" && isPdfName(entry.name));
    if (accept) {
      fileBrowserConfirm(joinPath(fileBrowserState.currentPath, entry.name));
    }
  } else if (fileBrowserState.mode === "save") {
    handleFileBrowserConfirm();
  }
}

function joinPath(dir, name) {
  if (!dir) return name;
  if (dir.endsWith("/") || dir.endsWith("\\")) return dir + name;
  return dir + (dir.includes("\\") && !dir.includes("/") ? "\\" : "/") + name;
}

async function loadFileBrowserDir(targetPath) {
  const result = await kpdf3.listDirectory(targetPath);
  fileBrowserState.currentPath = result.path;
  fileBrowserState.parentPath = result.parent;
  const entries = result.error ? [] : [...result.entries];
  if (result.parent) {
    entries.unshift({ name: "..", isParent: true, isDir: true });
  }
  fileBrowserState.entries = entries;
  openCurrentPathEl.textContent = result.path;
  openCurrentPathEl.title = result.path;
  openUpBtn.disabled = !result.parent;
  if (result.error) {
    openFileList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "open-entry-error";
    li.textContent = `エラー: ${result.error}`;
    openFileList.appendChild(li);
  } else {
    renderFileBrowserList();
  }
  syncQuickSelector();
}

function syncQuickSelector() {
  if (!fileBrowserState.defaultPaths) return;
  const cur = fileBrowserState.currentPath;
  const match = [...openQuickSel.options].find((o) => o.value === cur);
  openQuickSel.value = match ? cur : "";
}

async function populateQuickSelector() {
  if (!fileBrowserState.defaultPaths) {
    fileBrowserState.defaultPaths = await kpdf3.getDefaultPaths();
  }
  const dp = fileBrowserState.defaultPaths;
  const opts = [
    { value: "", label: "(現在のフォルダ)" },
    { value: dp.home, label: `ホーム  ${dp.home ?? ""}` },
    { value: dp.desktop, label: `デスクトップ  ${dp.desktop ?? ""}` },
    { value: dp.documents, label: `ドキュメント  ${dp.documents ?? ""}` },
    { value: dp.downloads, label: `ダウンロード  ${dp.downloads ?? ""}` },
  ];
  openQuickSel.innerHTML = "";
  for (const o of opts) {
    if (o.value === null) continue;
    const opt = document.createElement("option");
    opt.value = o.value ?? "";
    opt.textContent = o.label;
    openQuickSel.appendChild(opt);
  }
}

function fileBrowserCancel() {
  openDialog.hidden = true;
  if (fileBrowserState.resolve) {
    const r = fileBrowserState.resolve;
    fileBrowserState.resolve = null;
    r(null);
  }
}

function fileBrowserConfirm(value) {
  if (fileBrowserState.currentPath) {
    localStorage.setItem("kpdf3.lastBrowseDir", fileBrowserState.currentPath);
  }
  openDialog.hidden = true;
  if (fileBrowserState.resolve) {
    const r = fileBrowserState.resolve;
    fileBrowserState.resolve = null;
    r(value);
  }
}

async function handleFileBrowserConfirm() {
  const mode = fileBrowserState.mode;
  if (mode === "folder") {
    if (fileBrowserState.currentPath) {
      fileBrowserConfirm(fileBrowserState.currentPath);
    }
    return;
  }

  const filename = openFilenameInput.value.trim();
  if (!filename) {
    if (mode === "open" && fileBrowserState.selectedName) {
      fileBrowserConfirm(
        joinPath(fileBrowserState.currentPath, fileBrowserState.selectedName),
      );
    }
    return;
  }
  const isAbsolute = /^([a-zA-Z]:[/\\]|[/\\])/.test(filename);
  let target = isAbsolute ? filename : joinPath(fileBrowserState.currentPath, filename);

  if (mode === "save") {
    // Auto-append .pdf if missing
    if (!/\.[a-zA-Z0-9]+$/.test(target)) target += ".pdf";
    if (await kpdf3.fileExists(target)) {
      const ok = await customConfirm({
        title: "上書きの確認",
        message: `${target}\nは既に存在します。上書きしますか？`,
        okLabel: "上書き",
      });
      if (!ok) return;
    }
    fileBrowserConfirm(target);
    return;
  }

  // open mode — accept whichever extension the active filter allows.
  const filter = openFilterSel.value;
  const ok =
    filter === "all" ||
    (filter === "image" && isImageName(target)) ||
    (filter === "pdf" && isPdfName(target));
  if (!ok) {
    wsStatus.textContent = filter === "image" ? "画像 (PNG/JPEG) を選択してください" : "PDF ファイルを選択してください";
    return;
  }
  fileBrowserConfirm(target);
}

/**
 * Show the file browser. Returns a Promise resolving to:
 *   - open mode  : selected file's full path (or null if cancelled)
 *   - save mode  : full save path (or null)
 *   - folder mode: selected folder path (or null)
 */
async function showFileBrowser({
  mode = "open",
  title,
  initialName = "",
  defaultDir = null,
  filterDefault = "pdf",
  confirmLabel,
} = {}) {
  fileBrowserState.mode = mode;
  await populateQuickSelector();

  // Resolve initial directory
  const stored = localStorage.getItem("kpdf3.lastBrowseDir");
  const initial =
    defaultDir ||
    stored ||
    fileBrowserState.defaultPaths?.home ||
    "";

  // UI configuration based on mode
  if (mode === "folder") {
    openTitleText.textContent = title || "フォルダの選択";
    openFilenameRow.hidden = true;
    openFilterRow.hidden = true;
    openConfirmBtn.textContent = confirmLabel || "このフォルダを選択";
  } else if (mode === "save") {
    openTitleText.textContent = title || "名前を付けて保存";
    openFilenameRow.hidden = false;
    openFilterRow.hidden = false;
    openFilterSel.value = filterDefault;
    openFilenameInput.value = initialName;
    openConfirmBtn.textContent = confirmLabel || "保存";
  } else {
    openTitleText.textContent = title || "PDF を開く";
    openFilenameRow.hidden = false;
    openFilterRow.hidden = false;
    openFilterSel.value = filterDefault;
    openFilenameInput.value = "";
    openConfirmBtn.textContent = confirmLabel || "開く";
  }

  await loadFileBrowserDir(initial);
  openDialog.hidden = false;
  if (mode === "save") {
    // Pre-select base name (stem) so the user can immediately type to replace
    openFilenameInput.focus();
    const stem = initialName.replace(/\.[^.]+$/, "");
    openFilenameInput.setSelectionRange(0, stem.length);
  } else {
    openFilenameInput.focus();
  }

  return new Promise((resolve) => {
    fileBrowserState.resolve = resolve;
  });
}

openConfirmBtn.addEventListener("click", handleFileBrowserConfirm);
openCancelBtn.addEventListener("click", fileBrowserCancel);
openTitlebarCloseBtn.addEventListener("click", fileBrowserCancel);
openDialog.addEventListener("click", (e) => {
  if (e.target === openDialog) fileBrowserCancel();
});
openUpBtn.addEventListener("click", () => {
  if (fileBrowserState.parentPath) loadFileBrowserDir(fileBrowserState.parentPath);
});
openQuickSel.addEventListener("change", () => {
  if (openQuickSel.value) loadFileBrowserDir(openQuickSel.value);
});
openFilterSel.addEventListener("change", renderFileBrowserList);
openFilenameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    handleFileBrowserConfirm();
  } else if (e.key === "Escape") {
    e.preventDefault();
    fileBrowserCancel();
  }
});
openDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    fileBrowserCancel();
  }
});

async function actionOpen() {
  // No dirty check: with tabs, opening a new PDF doesn't have to
  // discard the current one. If the active tab already has a PDF,
  // route the new file into a fresh tab (preserves the user's
  // editing context). Empty active tab → fill it directly.
  const path = await showFileBrowser({ mode: "open" });
  if (!path) return;
  await openPdfSmart(path);
}

/** Open `path` in the active tab when it's empty, or in a fresh tab
 *  when the active one already has a workspace loaded. Used by the
 *  toolbar 開く button, the file menu, the recents dialog and the
 *  global PDF drop handler so they all behave consistently. */
async function openPdfSmart(path) {
  if (isOpen) {
    await newTabAndOpen(path);
  } else {
    await openPdfPath(path);
  }
}

async function actionClose() {
  if (!(await confirmDiscardIfDirty())) return;
  await kpdf3.closeWorkspace();
  projectStore.reset([]);
  pendingDeletedPages.clear();
  workspaceMutated = false;
  history.clear();
  setOpen(false);
  await refreshViewer();
}

// ---- Print preview dialog (Adobe simplified) -------------------------
const printDialog = $("print-dialog");
const printPrinterSelect = $("print-printer");
const printPropertiesBtn = $("print-properties");
const printCopiesInput = $("print-copies");
const printRangeAll = $("print-range-all");
const printRangeCurrent = $("print-range-current");
const printRangeCustom = $("print-range-custom");
const printRangeInput = $("print-range-input");
const printSizeActual = $("print-size-actual");
const printSizeFit = $("print-size-fit");
const printOrientPortrait = $("print-orient-portrait");
const printOrientLandscape = $("print-orient-landscape");
const printPreviewCanvas = $("print-preview-canvas");
const printPreviewCounter = $("print-preview-counter");
const printPreviewPrev = $("print-preview-prev");
const printPreviewNext = $("print-preview-next");
const printConfirmBtn = $("print-confirm");
const printCancelBtn = $("print-cancel");
const printTitlebarCloseBtn = $("print-titlebar-close");

const PREVIEW_ZOOM = 0.6; // matches a comfortable preview tile size
const printState = {
  pages: [],          // pages array from kpdf3.getPages()
  printers: [],
  resolve: null,      // Promise resolver
  previewIndex: 0,    // 0-based index into the *visible* page list
  visiblePageNos: [], // page numbers selected by current range
  renderToken: 0,     // monotonic — bail outdated renders
};

function showPrintDialog(printers, pages, currentPageNo) {
  printState.pages = pages;
  printState.printers = printers;

  // Populate printer select
  printPrinterSelect.innerHTML = "";
  if (printers.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(プリンタが見つかりません)";
    printPrinterSelect.appendChild(opt);
    printConfirmBtn.disabled = true;
    printPropertiesBtn.disabled = true;
  } else {
    printConfirmBtn.disabled = false;
    printPropertiesBtn.disabled = false;
    for (const p of printers) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.displayName ?? p.name;
      if (p.isDefault) opt.selected = true;
      printPrinterSelect.appendChild(opt);
    }
  }

  printCopiesInput.value = "1";
  printRangeAll.checked = true;
  printRangeInput.value = `1-${pages.length}`;
  printSizeActual.checked = true;
  printOrientPortrait.checked = true;

  // Initial preview = current page (or 1)
  recomputeVisiblePages();
  const idx = printState.visiblePageNos.indexOf(currentPageNo);
  printState.previewIndex = idx >= 0 ? idx : 0;
  refreshPreview();

  printDialog.hidden = false;
  return new Promise((resolve) => {
    printState.resolve = resolve;
  });
}

function recomputeVisiblePages() {
  const total = printState.pages.length;
  if (printRangeCurrent.checked) {
    const cur = viewer.currentPage || 1;
    printState.visiblePageNos = [cur];
  } else if (printRangeCustom.checked) {
    const parsed = parsePageList(printRangeInput.value, total);
    printState.visiblePageNos = parsed.length > 0 ? parsed : [];
  } else {
    printState.visiblePageNos = printState.pages.map((p) => p.pageNo);
  }
  if (printState.previewIndex >= printState.visiblePageNos.length) {
    printState.previewIndex = Math.max(0, printState.visiblePageNos.length - 1);
  }
}

/**
 * Parse "1-3, 5, 7-10" into a sorted unique array of page numbers.
 */
function parsePageList(input, total) {
  const out = new Set();
  for (const part of String(input).split(",")) {
    const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) continue;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 1 || end > total || start > end) continue;
    for (let i = start; i <= end; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

async function refreshPreview() {
  const visible = printState.visiblePageNos;
  if (visible.length === 0) {
    printPreviewCounter.textContent = "— / —";
    const ctx = printPreviewCanvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, printPreviewCanvas.width, printPreviewCanvas.height);
    printPreviewPrev.disabled = true;
    printPreviewNext.disabled = true;
    return;
  }
  const pageNo = visible[printState.previewIndex];
  printPreviewCounter.textContent = `${printState.previewIndex + 1} / ${visible.length}（p.${pageNo}）`;
  printPreviewPrev.disabled = printState.previewIndex <= 0;
  printPreviewNext.disabled = printState.previewIndex >= visible.length - 1;

  const pageRow = printState.pages.find((p) => p.pageNo === pageNo);
  if (!pageRow) return;

  const myToken = ++printState.renderToken;
  try {
    const sourceCanvas = await composeSinglePageCanvas(
      pageRow,
      kpdf3.renderPage,
      projectStore,
      PREVIEW_ZOOM,
      renderSyntheticPagePixels,
    );
    if (myToken !== printState.renderToken) return; // stale
    // Apply orientation: rotate canvas if landscape selected
    const landscape = printOrientLandscape.checked;
    const dest = printPreviewCanvas;
    if (landscape) {
      dest.width = sourceCanvas.height;
      dest.height = sourceCanvas.width;
      const ctx = dest.getContext("2d");
      ctx.save();
      ctx.translate(dest.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(sourceCanvas, 0, 0);
      ctx.restore();
    } else {
      dest.width = sourceCanvas.width;
      dest.height = sourceCanvas.height;
      const ctx = dest.getContext("2d");
      ctx.drawImage(sourceCanvas, 0, 0);
    }
  } catch (err) {
    console.error("[print-preview] render failed", err);
  }
}

function settlePrintDialog(value) {
  printDialog.hidden = true;
  if (printState.resolve) {
    const r = printState.resolve;
    printState.resolve = null;
    r(value);
  }
}

printConfirmBtn.addEventListener("click", () => {
  const range = currentPrintRange();
  if (!range || range.length === 0) {
    wsStatus.textContent = "印刷範囲が無効です";
    return;
  }
  settlePrintDialog({
    deviceName: printPrinterSelect.value,
    copies: Math.max(1, Number(printCopiesInput.value) || 1),
    pageNos: range,
    sizing: printSizeFit.checked ? "fit" : "actual",
    landscape: printOrientLandscape.checked,
  });
});
printCancelBtn.addEventListener("click", () => settlePrintDialog(null));
printTitlebarCloseBtn.addEventListener("click", () => settlePrintDialog(null));
printDialog.addEventListener("click", (e) => {
  if (e.target === printDialog) settlePrintDialog(null);
});

function currentPrintRange() {
  recomputeVisiblePages();
  return printState.visiblePageNos;
}

// Wire range / size / orientation changes to refresh the preview
for (const el of [printRangeAll, printRangeCurrent, printRangeCustom]) {
  el.addEventListener("change", () => {
    recomputeVisiblePages();
    refreshPreview();
  });
}
printRangeInput.addEventListener("input", () => {
  printRangeCustom.checked = true;
  recomputeVisiblePages();
  refreshPreview();
});
for (const el of [printOrientPortrait, printOrientLandscape, printSizeFit, printSizeActual]) {
  el.addEventListener("change", refreshPreview);
}

printPreviewPrev.addEventListener("click", () => {
  if (printState.previewIndex > 0) {
    printState.previewIndex--;
    refreshPreview();
  }
});
printPreviewNext.addEventListener("click", () => {
  if (printState.previewIndex < printState.visiblePageNos.length - 1) {
    printState.previewIndex++;
    refreshPreview();
  }
});

printPropertiesBtn.addEventListener("click", async () => {
  const name = printPrinterSelect.value;
  if (!name) return;
  const r = await kpdf3.printerProperties(name);
  if (r && r.ok === false) {
    wsStatus.textContent = `プロパティ表示失敗: ${r.error ?? "unknown"}`;
  }
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
// ---- Split-save panel (M5-6 V2 — inline panel, not a modal) --------
const splitFlow = $("split-flow");
const splitConfirmBtn = $("split-confirm");
const splitCancelBtn = $("split-cancel");
const thumbSizeSlider = $("thumb-size");
const thumbSizeDisplay = $("thumb-size-display");
const datePrefixToggle = $("date-prefix-toggle");
const datePrefixPreview = $("date-prefix-preview");

/** YYMMDD format for filename prefixes (e.g., 2026-05-09 → "260509"). */
function getDateYYMMDD(d = new Date()) {
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// Refresh the preview number in the toggle label every time we enter
// split mode, so a user who left the dialog open across midnight sees
// the new date.
function refreshDatePrefixPreview() {
  if (datePrefixPreview) datePrefixPreview.textContent = getDateYYMMDD();
}

thumbSizeSlider.addEventListener("input", () => {
  const w = thumbSizeSlider.value;
  document.documentElement.style.setProperty("--split-thumb-width", `${w}px`);
  thumbSizeDisplay.textContent = `${w}px`;
});

datePrefixToggle.addEventListener("change", () => {
  const date = getDateYYMMDD();
  const on = datePrefixToggle.checked;
  // Update both the live <input> values and the splitState backing map
  // so a subsequent rebuild keeps the prefix.
  const inputs = splitFlow.querySelectorAll(".split-section-name");
  inputs.forEach((input, idx) => {
    if (on) {
      if (!input.value.startsWith(date)) {
        input.value = date + input.value;
      }
    } else {
      // Strip a leading 6-digit run if it matches today's date, OR if
      // it's any 6-digit prefix the toggle previously added.
      input.value = input.value.replace(/^\d{6}/, "");
    }
    splitState.partNames.set(idx, input.value);
  });
});

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

/**
 * Default value for a part-name input. Empty by user request — the
 * placeholder hints at "name your part". When the date-prefix toggle is
 * on, new sections inherit today's date as their starting value so the
 * UX matches "everything gets the prefix when toggle is on".
 */
function defaultPartName() {
  return datePrefixToggle?.checked ? getDateYYMMDD() : "";
}

async function generateAllThumbnails(pages, onProgress) {
  // Render each page at zoom 0.25 to a tiny canvas, cache by pageNo.
  for (let i = 0; i < pages.length; i++) {
    const row = pages[i];
    const pageNo = row.pageNo;
    if (splitState.thumbCache.has(pageNo)) continue;
    try {
      let result;
      if (row.isSynthetic || pageNo < 0) {
        result = await renderSyntheticPagePixels(row, 0.25);
      } else {
        result = await kpdf3.renderPage(pageNo, { zoom: 0.25 });
      }
      // compositePage handles userRotation + overlays so the split-save
      // thumb matches what the page actually looks like (stamps / marks
      // visible, rotated pages displayed in their rotated orientation).
      const canvas = await compositePage(row, result, projectStore, 0.25);
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
    nameInput.placeholder = `(パート ${partIdx + 1} の名前)`;
    nameInput.value =
      splitState.partNames.get(partIdx) ?? defaultPartName();
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
    // Leading insert gap (always present). Anchored to the nearest
    // preceding source page, or 0 when this part starts at the very
    // beginning of the document.
    {
      let anchor = 0;
      for (let k = part.start - 1; k >= 0; k--) {
        if (!pages[k].isSynthetic) {
          anchor = pages[k].pageNo;
          break;
        }
      }
      row.appendChild(makeSplitInsertGap(anchor));
    }
    for (let i = part.start; i <= part.end; i++) {
      // Visual position passed in 1-indexed across the WHOLE document
      // so split-save labels match the sidebar / page-indicator
      // numbering even when the part doesn't start at page 1.
      const thumb = createThumbElement(pages[i], i + 1);
      row.appendChild(thumb);
      // Trailing insert gap — anchored to this source page, or to the
      // synthetic's slot anchor + (orderInSlot+1) when this thumb is
      // a synthetic. Without orderInSlot a click on the gap right
      // after a mid-slot synthetic clobbered the slot ordering, which
      // is the "末尾の挿入で挙動がおかしくなる" bug — last-tail clicks
      // re-anchored to the wrong slot position. Mirrors the sidebar
      // rebuildThumbs logic.
      let anchor;
      let orderInSlot = null;
      if (pages[i].isSynthetic) {
        anchor = pages[i].syntheticAfterPageNo ?? 0;
        orderInSlot = (pages[i].syntheticOrderInSlot ?? 0) + 1;
      } else {
        anchor = pages[i].pageNo;
      }
      row.appendChild(makeSplitInsertGap(anchor, orderInSlot));
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

function createThumbElement(pageRow, visualPos) {
  const wrap = document.createElement("div");
  wrap.className = "split-thumb";
  wrap.dataset.pageNo = String(pageRow.pageNo);
  wrap.tabIndex = 0;
  const cached = splitState.thumbCache.get(pageRow.pageNo);
  if (cached) {
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
    placeholder.textContent = typeof visualPos === "number" && visualPos > 0
      ? String(visualPos)
      : String(pageRow.pageNo);
    wrap.appendChild(placeholder);
  }
  const lbl = document.createElement("span");
  lbl.className = "split-thumb-label";
  // Visual page number (1-indexed across the whole document) so it
  // matches the sidebar thumbs + bottom indicator. Synthetic rows
  // get a leading ✎ marker so they're still distinguishable.
  const labelNum = typeof visualPos === "number" && visualPos > 0
    ? String(visualPos)
    : String(pageRow.pageNo);
  lbl.textContent = pageRow.isSynthetic ? `✎ ${labelNum}` : labelNum;
  wrap.appendChild(lbl);
  wrap.addEventListener("click", (e) => {
    const ordered = getOrderedThumbPageNos(splitFlow, ".split-thumb[data-page-no]");
    handleThumbSelectionClick(splitThumbSelection, ordered, pageRow.pageNo, e);
    wrap.focus();
  });
  attachThumbContextMenu(wrap, pageRow.pageNo);
  // Same D&D handler as the sidebar thumbs — a single mechanism for
  // page reordering means split-save view picks up the same display_
  // order machinery, including synthetic-page support.
  attachThumbDragHandlers(wrap, pageRow.pageNo);
  return wrap;
}

let isSplitMode = false;

function setSplitMode(on) {
  isSplitMode = !!on;
  mainArea.classList.toggle("split-mode", isSplitMode);
  splitView.hidden = !isSplitMode;
  btnSplit.classList.toggle("toggled", isSplitMode);
}

async function actionSplitSave() {
  if (!isOpen) return;
  if (isSplitMode) {
    // Toggle off — back to viewer
    setSplitMode(false);
    return;
  }
  const pages = await fetchVisiblePages();
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
  setSplitMode(true);
  refreshDatePrefixPreview();

  await generateAllThumbnails(pages, ({ done, total }) => {
    progressNode.textContent = `サムネイルを準備中... ${done} / ${total}`;
  });
  // User may have left split mode while we were rendering
  if (!isSplitMode) return;
  rebuildSplitUI(pages);
}

splitCancelBtn.addEventListener("click", () => setSplitMode(false));

splitConfirmBtn.addEventListener("click", async () => {
  const pages = await fetchVisiblePages();
  const parts = computeParts(pages.length, splitState.splitAfter);
  const defaults = await kpdf3.getExportDefaults();
  const folder = await showFileBrowser({
    mode: "folder",
    title: "分割した PDF を保存するフォルダ",
    defaultDir: defaults.sourceDir,
  });
  if (!folder) return;

  setSplitMode(false);
  showBusy("分割保存", `0 / ${parts.length} パート`, 0);
  try {
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      const rawName = (splitState.partNames.get(p) ?? "").trim();
      const safeName =
        rawName.replace(/[/\\:*?"<>|]/g, "_") || `part${p + 1}`;
      const savePath = `${folder}/${safeName}.pdf`;

      updateBusy(
        `${p + 1} / ${parts.length} パート — ページを描画中...`,
        (p / parts.length) * 100,
      );
      const filteredPages = pages.slice(part.start, part.end + 1);
      const composed = await composePagesForExport({
        pages: filteredPages,
        projectStore,
        renderPage: kpdf3.renderPage,
        renderSyntheticPage: renderSyntheticPagePixels,
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

btnSplit.addEventListener("click", actionSplitSave);

async function actionExportRange() {
  if (!isOpen) return;
  const pages = await fetchVisiblePages();
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
  const defaults = await kpdf3.getExportDefaults();
  const savePath = await showFileBrowser({
    mode: "save",
    title: "範囲書き出し",
    initialName: defaults.defaultName ?? "export.pdf",
    defaultDir: defaults.sourceDir,
  });
  if (!savePath) return;

  const filteredPages = pages.slice(range.start - 1, range.end);
  showBusy("書き出し準備", `ページ ${range.start}-${range.end} を描画しています...`, 0);
  try {
    const composed = await composePagesForExport({
      pages: filteredPages,
      projectStore,
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
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
  const pages = await fetchVisiblePages();
  if (pages.length === 0) return;

  showBusy("プリンタ情報を取得中...", "プリンタ一覧を読み込んでいます...", 50);
  let printers;
  try {
    printers = await kpdf3.listPrinters();
  } finally {
    hideBusy();
  }

  const currentPageNo = viewer.currentPage || 1;
  const choice = await showPrintDialog(printers, pages, currentPageNo);
  if (!choice) {
    wsStatus.textContent = "印刷をキャンセルしました";
    return;
  }

  // Decide pipeline: byte-copy only when no overlays AND printing all pages.
  const overlayCount = projectStore.count();
  const allPagesSelected =
    choice.pageNos.length === pages.length &&
    choice.pageNos.every((n, i) => n === i + 1);
  const isCopy = overlayCount === 0 && allPagesSelected;

  showBusy("印刷準備", "ページを描画中...", 0);
  let composed = null;
  try {
    if (!isCopy) {
      const filteredPages = pages.filter((p) =>
        choice.pageNos.includes(p.pageNo),
      );
      composed = await composePagesForExport({
        pages: filteredPages,
        projectStore,
        renderPage: kpdf3.renderPage,
        onProgress: ({ done, total }) => {
          updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
        },
      });
    }
    updateBusy(`${choice.deviceName} に送信中...`, 90);
    await kpdf3.printPdfSilent({
      source: isCopy ? "byte-copy" : "rasterized",
      pages: composed,
      deviceName: choice.deviceName,
      copies: choice.copies,
      landscape: choice.landscape,
    });
    hideBusy();
    wsStatus.textContent = `印刷を ${choice.deviceName} に送信しました（${choice.copies} 部 / ${choice.pageNos.length} ページ）`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] print failed:", err);
    wsStatus.textContent = `印刷失敗: ${err.message ?? err}`;
  }
}

async function actionExport() {
  if (!isOpen) return;
  const pages = await fetchVisiblePages();
  if (pages.length === 0) return;
  const defaults = await kpdf3.getExportDefaults();
  const savePath = await showFileBrowser({
    mode: "save",
    title: "PDF として書き出し",
    initialName: defaults.defaultName ?? "export.pdf",
    defaultDir: defaults.sourceDir,
  });
  if (!savePath) return;
  // ADR-0008: with no overlays, byte-copy the source PDF instead of
  // rasterising — preserves the original PDF's text layer and size.
  // BUT byte-copy outputs the source PDF as-is, so if any pages are
  // hidden (pending or persisted deletions) OR user-inserted blank
  // pages are present, we must rasterize instead.
  const overlayCount = projectStore.count();
  const meta = await kpdf3.getSourceMeta();
  const hasInsertions = pages.some((p) => p.isSynthetic || p.pageNo < 0);
  const sourcePagesCount = pages.filter((p) => !p.isSynthetic && p.pageNo > 0).length;
  const hasDeletions =
    pendingDeletedPages.size > 0 ||
    (meta && sourcePagesCount < (meta.pageCount ?? sourcePagesCount));
  const isCopy = overlayCount === 0 && !hasDeletions && !hasInsertions;
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
        renderSyntheticPage: renderSyntheticPagePixels,
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
    // ---- Save As convention: switch active workspace to the new file --
    // After saving as 008.pdf the user expects to be editing 008 (not 001
    // with risk of accidentally Ctrl+S overwriting 001). Mirrors Word /
    // Excel "Save As" semantics. byte-copy with no edits → fingerprint
    // matches source → main process opens the existing workspace, which
    // is fine (same content). For rasterized output a fresh workspace is
    // created.
    updateBusy("新しいファイルに切り替え中...", 95);
    try {
      // ADR-0015: Save As replaces the active tab's workspace handle —
      // we reuse activeTabId so other tabs (when they exist in
      // Phase 4+) aren't disturbed.
      const opened = await kpdf3.openPdfFile(savePath, activeTabId);
      projectStore.reset(opened.overlays ?? []);
      pendingDeletedPages.clear();
      workspaceMutated = false;
      thumbSelection.pageNos.clear();
      thumbSelection.anchor = null;
      history.clear();
      await refreshViewer();
    } catch (switchErr) {
      console.error("[renderer] post-export workspace switch failed:", switchErr);
    }
    hideBusy();
    wsStatus.textContent = `${savePath} に切り替えました（${verb}, rev ${result.revisionId.slice(0, 8)}）`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] export failed:", err);
    wsStatus.textContent = `${verb}失敗: ${err.message ?? err}`;
  }
}

async function actionSave() {
  if (!isOpen) return;
  // No-op when nothing has changed since the last save.
  if (!isWorkspaceDirty()) return;
  try {
    const overlaySnapshot = projectStore.snapshot();
    if (projectStore.isDirty()) {
      await kpdf3.saveOverlays(overlaySnapshot);
      projectStore.markClean();
    }
    let deletedCount = 0;
    if (pendingDeletedPages.size > 0) {
      for (const n of pendingDeletedPages) {
        await kpdf3.setPageDeleted(n, true);
      }
      deletedCount = pendingDeletedPages.size;
      pendingDeletedPages.clear();
    }
    workspaceMutated = false;
    refreshDirtyIndicator();
    refreshMenuState();
    const parts = [];
    if (overlaySnapshot.length > 0) parts.push(`${overlaySnapshot.length} overlays`);
    if (deletedCount > 0) parts.push(`${deletedCount} pages 削除`);
    wsStatus.textContent =
      parts.length > 0 ? `保存しました (${parts.join(", ")})` : "保存しました";
  } catch (err) {
    console.error("[renderer] save failed:", err);
    wsStatus.textContent = `保存失敗: ${err.message ?? err}`;
  }
}

function actionUndo() {
  history.undo();
}

function actionRedo() {
  history.redo();
}

/**
 * Rotate the current page by ±90°. Source page (positive pageNo) only —
 * synthetic inserted pages are skipped (they are always portrait blanks).
 * The new userRotation is persisted to DB; main reopens activePages so
 * subsequent renders see the new dimensions; the viewer reloads to pick
 * up the post-rotation slot size.
 */
/**
 * Map an overlay rect (x, y, w, h) in the OLD canonical frame to the
 * NEW canonical frame after rotating the page by `delta` degrees
 * (multiple of 90). Mirrors how a piece of paper with writing on it
 * "carries the writing along" when you rotate the paper.
 *
 * Old canonical frame is W_old × H_old. New frame is W_new × H_new
 * (= H_old × W_old for ±90°, same for 180°).
 *
 * @param {{x:number, y:number, w:number, h:number}} ov
 * @param {number} delta  rotation delta, signed degrees (multiple of 90)
 * @param {number} W_old  old canonical width
 * @param {number} H_old  old canonical height
 */
function transformRectForRotation(ov, delta, W_old, H_old) {
  const d = (((delta % 360) + 360) % 360);
  if (d === 90) {
    // CW: old TL → new TR, old BL → new TL.
    return { x: H_old - ov.y - ov.h, y: ov.x, w: ov.h, h: ov.w };
  }
  if (d === 180) {
    return { x: W_old - ov.x - ov.w, y: H_old - ov.y - ov.h, w: ov.w, h: ov.h };
  }
  if (d === 270) {
    // CCW: old TL → new BL, old BR → new TL.
    return { x: ov.y, y: W_old - ov.x - ov.w, w: ov.h, h: ov.w };
  }
  return { x: ov.x, y: ov.y, w: ov.w, h: ov.h };
}

/** Transform a callout arrow tip offset (relative to box top-left) by
 *  the page rotation delta. Derived from the rect rotation formula:
 *  the tip is at (x + arrowDx, y + arrowDy) in the OLD canonical frame;
 *  rotate that point and the new box origin to find the new offset.
 *  w_old / h_old are the overlay's pre-rotation rect dims.
 */
function transformArrowForRotation(arrowDx, arrowDy, delta, w_old, h_old) {
  const d = (((delta % 360) + 360) % 360);
  if (d === 90)  return { arrowDx: h_old - arrowDy, arrowDy: arrowDx };
  if (d === 180) return { arrowDx: w_old - arrowDx, arrowDy: h_old - arrowDy };
  if (d === 270) return { arrowDx: arrowDy, arrowDy: w_old - arrowDx };
  return { arrowDx, arrowDy };
}

async function rotatePageBy(pageNo, delta) {
  if (!isOpen || !pageNo) return;
  const row = viewer._pages?.find((p) => p.pageNo === pageNo);
  if (!row) return;
  // Drop split-state thumb cache for this page so the next split-save
  // view re-renders with the new rotation. Sidebar thumbs are wiped by
  // rebuildThumbs further below, so they don't need explicit clearing.
  splitState?.thumbCache?.delete(pageNo);

  // Old canonical W/H BEFORE the rotation, accounting for both the
  // intrinsic /Rotate and the previous userRotation.
  const intrinsic = row.rotation || 0;
  const oldUser = ((row.userRotation ?? 0) % 360 + 360) % 360;
  const oldEff = ((intrinsic + oldUser) % 360 + 360) % 360;
  const swapped = oldEff === 90 || oldEff === 270;
  const W_old = swapped ? row.cropH : row.cropW;
  const H_old = swapped ? row.cropW : row.cropH;

  // Carry every overlay on this page along with the rotation. Done
  // before the userRotation flip so the canonical frame interpretation
  // hasn't changed yet. Bypasses history (rotation itself isn't in
  // history — the inverse rotation undoes overlay positions too).
  // Content rotation (props.rotation) tracks how much the OVERLAY's
  // visual content has spun relative to upright; viewer / exporter
  // apply it when drawing text / stamps. Geometry-only overlays
  // (redaction / marker) ignore it.
  const dContent = (((delta % 360) + 360) % 360);
  for (const ov of projectStore.getPageOverlays(pageNo)) {
    const t = transformRectForRotation(ov, delta, W_old, H_old);
    const props = ov.properties ?? {};
    const newRot = (((props.rotation ?? 0) + dContent) % 360 + 360) % 360;
    // Callout arrow tip: needs to rotate with the box. arrowDx / Dy
    // are stored relative to the box top-left, so rotating the page
    // changes that vector too — use the overlay's PRE-rotation w/h.
    let arrowPatch = {};
    if (ov.type === "rect" && props.kind === "callout") {
      const a = transformArrowForRotation(
        props.arrowDx ?? 0,
        props.arrowDy ?? 0,
        delta,
        ov.w,
        ov.h,
      );
      arrowPatch = { arrowDx: a.arrowDx, arrowDy: a.arrowDy };
    }
    projectStore.update(ov.id, {
      ...t,
      properties: { ...props, ...arrowPatch, rotation: newRot },
    });
  }

  const next = ((oldUser + delta) % 360 + 360) % 360;
  try {
    await kpdf3.setPageRotation(pageNo, next);
    await refreshViewer();
    // Keep the user looking at the same page after the rebuild.
    viewer.scrollToPage(pageNo);
    // If the split view is open, rebuild it too so the rotated page
    // appears in the split-save thumbnails.
    if (isSplitMode) await refreshSplitView();
    // Page canonical W/H may have swapped — re-apply fit if active.
    // The ResizeObserver only fires on container resize, not page
    // size, so this is needed to keep fit-mode tracking after rotate.
    if (zoomMode === "fit-width") applyFitWidthNow();
    else if (zoomMode === "fit-page") applyFitPageNow();
    wsStatus.textContent = `p.${pageNo} を ${next}° 回転`;
  } catch (err) {
    console.error("[rotate] failed", err);
    wsStatus.textContent = `回転失敗: ${err.message ?? err}`;
  }
}
function rotateCurrentPage(delta) {
  return rotatePageBy(viewer.currentPage, delta);
}
function actionRotateLeft() { return rotateCurrentPage(-90); }
function actionRotateRight() { return rotateCurrentPage(+90); }

function applyZoom(z) {
  viewer.setZoom(z);
  refreshMenuState();
  refreshZoomSelect();
  if (isOpen) wsStatus.textContent = `${Math.round(z * 100)}%`;
}

function refreshZoomSelect() {
  if (!zoomSelect) return;
  // Strip any prior dynamic "current %" entry so we don't accumulate them.
  for (const opt of [...zoomSelect.querySelectorAll("option[data-dynamic]")]) {
    opt.remove();
  }
  // When in a fit mode, show the named fit option (the user picked a
  // *mode*, not a literal zoom %, so reflecting the underlying numeric
  // zoom would be misleading). Otherwise pick the matching preset, or
  // inject a dynamic "<NN>%" entry.
  if (zoomMode === "fit-width" || zoomMode === "fit-page") {
    const target = zoomMode;
    const match = [...zoomSelect.options].find((opt) => opt.value === target);
    if (match) {
      zoomSelect.value = target;
      return;
    }
  }
  const z = viewer.zoom;
  const match = [...zoomSelect.options].find((opt) => {
    const v = parseFloat(opt.value);
    return Number.isFinite(v) && Math.abs(v - z) < 1e-3;
  });
  if (match) {
    zoomSelect.value = match.value;
    return;
  }
  const opt = document.createElement("option");
  opt.value = String(z);
  opt.dataset.dynamic = "1";
  opt.textContent = `${Math.round(z * 100)}%`;
  zoomSelect.insertBefore(opt, zoomSelect.firstChild);
  zoomSelect.value = String(z);
}

zoomSelect.addEventListener("change", () => {
  const v = zoomSelect.value;
  if (v === "fit") {
    actionZoomFit();
  } else if (v === "fit-page") {
    actionZoomFitPage();
  } else {
    const num = parseFloat(v);
    if (Number.isFinite(num)) {
      zoomMode = "fixed";
      applyZoom(num);
    }
  }
  refreshZoomSelect();
});

function actionZoomIn() {
  if (!isOpen) return;
  const cur = viewer.zoom;
  const next = ZOOM_STEPS.find((s) => s > cur + 1e-6);
  if (next !== undefined) {
    zoomMode = "fixed";
    applyZoom(next);
  }
}

function actionZoomOut() {
  if (!isOpen) return;
  const cur = viewer.zoom;
  let next;
  for (const s of ZOOM_STEPS) if (s < cur - 1e-6) next = s;
  if (next !== undefined) {
    zoomMode = "fixed";
    applyZoom(next);
  }
}

function actionZoom100() {
  if (!isOpen) return;
  zoomMode = "fixed";
  applyZoom(1.0);
}

// Zoom "mode" — when "fit-width" or "fit-page", the renderer
// re-applies the fit on every window / sidebar resize so the page
// keeps tracking the viewport. Picking a fixed percentage (or
// Ctrl+wheel) drops back to "fixed".
//
// Default is fit-width so a fresh-opened PDF reads as wide as the
// viewer permits — matches Adobe / Preview default and what the
// user explicitly asked for.
let zoomMode = "fit-width";

function applyFitWidthNow() {
  if (!isOpen || !viewer.registry || viewer.registry.count() === 0) return false;
  const pageNo = viewer.currentPage || viewer.registry.pageNoAtPos(0);
  let sz;
  try {
    sz = viewer.registry.getCanonicalSize(pageNo);
  } catch {
    return false;
  }
  const targetWidth = viewerContainer.clientWidth - 32;
  if (targetWidth <= 0 || sz.w <= 0) return false;
  applyZoom(targetWidth / sz.w);
  return true;
}

function applyFitPageNow() {
  if (!isOpen || !viewer.registry || viewer.registry.count() === 0) return false;
  const pageNo = viewer.currentPage || viewer.registry.pageNoAtPos(0);
  let sz;
  try {
    sz = viewer.registry.getCanonicalSize(pageNo);
  } catch {
    return false;
  }
  const targetW = viewerContainer.clientWidth - 32;
  const targetH = viewerContainer.clientHeight - 32;
  if (targetW <= 0 || targetH <= 0 || sz.w <= 0 || sz.h <= 0) return false;
  applyZoom(Math.min(targetW / sz.w, targetH / sz.h));
  return true;
}

function actionZoomFit() {
  if (applyFitWidthNow()) zoomMode = "fit-width";
}

/** Fit the CURRENT page entirely (both width and height) into the viewport. */
function actionZoomFitPage() {
  if (applyFitPageNow()) zoomMode = "fit-page";
}

// Re-apply the current fit mode whenever the viewport area changes
// (window resize, sidebar splitter drag, panel toggle). ResizeObserver
// gives us a single signal that covers all of these.
const _zoomFitResizeObserver = new ResizeObserver(() => {
  if (zoomMode === "fit-width") applyFitWidthNow();
  else if (zoomMode === "fit-page") applyFitPageNow();
});
_zoomFitResizeObserver.observe(viewerContainer);

function actionPagePrev() {
  if (!isOpen || !viewer.registry) return;
  const pos = viewer.registry.posOfPageNo(viewer.currentPage);
  if (pos > 0) {
    viewer.scrollToPage(viewer.registry.pageNoAtPos(pos - 1));
  }
}

function actionPageNext() {
  if (!isOpen || !viewer.registry) return;
  const pos = viewer.registry.posOfPageNo(viewer.currentPage);
  if (pos < 0) return;
  if (pos < viewer.registry.count() - 1) {
    viewer.scrollToPage(viewer.registry.pageNoAtPos(pos + 1));
  }
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
  if (!Number.isInteger(n) || n < 1) {
    wsStatus.textContent = `無効なページ番号: ${input}`;
    return;
  }
  if (viewer.registry.posOfPageNo(n) < 0) {
    wsStatus.textContent = `p.${n} は削除されています`;
    return;
  }
  viewer.scrollToPage(n);
}

// ---- Bookmarks sidebar (M5-5) ----------------------------------------

// Selected bookmark id (workspace-side bookmarks only). null when the
// list is showing read-only /Outlines from the source PDF.
let selectedBookmarkId = null;
let bookmarkSource = "outline"; // "outline" | "workspace"
// Flat list cached so indent / outdent can compute the new parent /
// sibling without an extra round-trip to the DB.
let workspaceBookmarksCache = [];

async function refreshBookmarks() {
  bookmarkTree.innerHTML = "";
  refreshBookmarkToolbarState();
  if (!isOpen) {
    selectedBookmarkId = null;
    workspaceBookmarksCache = [];
    return;
  }
  // Workspace bookmarks override the source PDF /Outlines once any
  // exist. Empty workspace list → show /Outlines (read-only).
  const ws = await kpdf3.listBookmarks();
  const sourceLabel = $("bookmark-source-label");
  if (Array.isArray(ws) && ws.length > 0) {
    bookmarkSource = "workspace";
    workspaceBookmarksCache = ws;
    if (sourceLabel) sourceLabel.textContent = "";
    const tree = buildBookmarkTree(ws);
    for (const node of tree) {
      bookmarkTree.appendChild(createWorkspaceBookmarkNode(node));
    }
    // Selection may now refer to a still-existing id; if not, drop it.
    if (selectedBookmarkId && !ws.some((b) => b.id === selectedBookmarkId)) {
      selectedBookmarkId = null;
    }
    if (selectedBookmarkId) selectBookmark(selectedBookmarkId);
    refreshBookmarkToolbarState();
    return;
  }
  bookmarkSource = "outline";
  workspaceBookmarksCache = [];
  selectedBookmarkId = null;
  if (sourceLabel) sourceLabel.textContent = "(元 PDF / 編集不可)";
  const outline = await kpdf3.getOutline();
  if (!outline || outline.length === 0) {
    const li = document.createElement("li");
    li.className = "bookmark-empty";
    li.textContent = "(しおりがありません)";
    bookmarkTree.appendChild(li);
    refreshBookmarkToolbarState();
    return;
  }
  for (const item of outline) {
    bookmarkTree.appendChild(createBookmarkNode(item));
  }
  refreshBookmarkToolbarState();
}

/** Group flat workspace bookmarks (already sorted by sortOrder) into a
 *  tree by parentId. Orphans (parentId pointing nowhere) are promoted
 *  to top level so they remain visible / editable. */
function buildBookmarkTree(flat) {
  const byId = new Map();
  for (const b of flat) byId.set(b.id, { ...b, children: [] });
  const top = [];
  for (const b of flat) {
    const node = byId.get(b.id);
    const parent = b.parentId && byId.get(b.parentId);
    if (parent) parent.children.push(node);
    else top.push(node);
  }
  return top;
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

/** Workspace-side bookmarks: clickable + selectable + double-click rename
 *  + draggable for reorder/reparent. Walks `node.children` recursively. */
function createWorkspaceBookmarkNode(node) {
  const li = document.createElement("li");
  li.className = "bookmark-item is-workspace";
  li.dataset.bookmarkId = node.id;
  li.dataset.pageNo = String(node.pageNo);
  li.title = `${node.title} (p.${node.pageNo})`;
  li.tabIndex = 0;
  li.draggable = true;
  const label = document.createElement("span");
  label.className = "bookmark-label";
  label.textContent = node.title || "(無題)";
  li.appendChild(label);
  const pageTag = document.createElement("span");
  pageTag.className = "bookmark-page-tag";
  pageTag.textContent = node.pageNo > 0 ? `p.${node.pageNo}` : "挿入";
  li.appendChild(pageTag);
  li.addEventListener("click", (e) => {
    e.stopPropagation();
    selectBookmark(node.id);
    if (typeof node.pageNo === "number") viewer.scrollToPage(node.pageNo);
  });
  li.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startInlineRenameBookmark(li, node);
  });
  attachBookmarkDnd(li, node);

  if (Array.isArray(node.children) && node.children.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "bookmark-children";
    for (const child of node.children) {
      ul.appendChild(createWorkspaceBookmarkNode(child));
    }
    li.appendChild(ul);
  }
  return li;
}

/** HTML5 drag handlers on a bookmark <li>. Computes the drop intent
 *  (drop-before / drop-into / drop-after) from cursor Y within the row,
 *  then asks main to move the dragged bookmark. */
function attachBookmarkDnd(li, node) {
  const MIME = "application/x-kpdf3-bookmark-id";
  li.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(MIME, node.id);
    // text/plain fallback so the OS doesn't treat it as a no-op.
    e.dataTransfer.setData("text/plain", node.title || node.id);
    li.classList.add("is-dragging");
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("is-dragging");
    clearBookmarkDropIndicators();
  });
  li.addEventListener("dragover", (e) => {
    if (!hasBookmarkPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const draggedId = e.dataTransfer?.getData(MIME) || dragInFlightId;
    if (draggedId === node.id || isAncestorOf(draggedId, node.id)) {
      // Disallow dropping a node onto itself or a descendant.
      clearBookmarkDropIndicators();
      return;
    }
    const zone = bookmarkDropZone(li, e.clientY);
    setBookmarkDropIndicator(li, zone);
  });
  li.addEventListener("dragleave", (e) => {
    // Only clear if we left this row entirely (relatedTarget outside it).
    if (!li.contains(e.relatedTarget)) {
      li.classList.remove("drop-before", "drop-into", "drop-after");
    }
  });
  li.addEventListener("drop", async (e) => {
    if (!hasBookmarkPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const draggedId = e.dataTransfer.getData(MIME);
    clearBookmarkDropIndicators();
    if (!draggedId || draggedId === node.id) return;
    if (isAncestorOf(draggedId, node.id)) return;
    const zone = bookmarkDropZone(li, e.clientY);
    const target = workspaceBookmarksCache.find((b) => b.id === node.id);
    if (!target) return;
    let parentId, beforeId;
    if (zone === "into") {
      parentId = node.id;
      beforeId = null;
    } else if (zone === "before") {
      parentId = target.parentId ?? null;
      beforeId = node.id;
    } else { // after
      parentId = target.parentId ?? null;
      beforeId = nextSiblingId(target);
    }
    try {
      await kpdf3.moveBookmark({ id: draggedId, parentId, beforeId });
      selectedBookmarkId = draggedId;
      await refreshBookmarks();
    } catch (err) {
      console.error("[bookmark] move failed", err);
      wsStatus.textContent = `しおり移動失敗: ${err.message ?? err}`;
    }
  });
}

let dragInFlightId = null; // fallback when dataTransfer is read-only mid-drag

function hasBookmarkPayload(dt) {
  if (!dt) return false;
  return Array.from(dt.types || []).includes("application/x-kpdf3-bookmark-id");
}

function bookmarkDropZone(li, clientY) {
  const r = li.getBoundingClientRect();
  // Use the row band only (children sub-list is excluded).
  const rowBottom = r.top + Math.min(r.height, 24);
  const y = clientY;
  const band = (rowBottom - r.top) / 3;
  if (y < r.top + band) return "before";
  if (y < r.top + band * 2) return "into";
  return "after";
}

function setBookmarkDropIndicator(li, zone) {
  clearBookmarkDropIndicators();
  if (zone === "before") li.classList.add("drop-before");
  else if (zone === "into") li.classList.add("drop-into");
  else if (zone === "after") li.classList.add("drop-after");
}

function clearBookmarkDropIndicators() {
  for (const el of bookmarkTree.querySelectorAll(".drop-before, .drop-into, .drop-after")) {
    el.classList.remove("drop-before", "drop-into", "drop-after");
  }
}

/** True if `ancestorId` is an ancestor of `descendantId` in the cached
 *  flat list. Cheap O(depth) walk via parentId. */
function isAncestorOf(ancestorId, descendantId) {
  if (!ancestorId || !descendantId) return false;
  let cur = workspaceBookmarksCache.find((b) => b.id === descendantId);
  while (cur && cur.parentId) {
    if (cur.parentId === ancestorId) return true;
    cur = workspaceBookmarksCache.find((b) => b.id === cur.parentId);
  }
  return false;
}

/** Find the next sibling id (same parent) of `b` in the cached list,
 *  or null if `b` is the last sibling. */
function nextSiblingId(b) {
  const siblings = workspaceBookmarksCache
    .filter((x) => (x.parentId ?? null) === (b.parentId ?? null))
    .sort((a, c) => a.sortOrder - c.sortOrder);
  const idx = siblings.findIndex((x) => x.id === b.id);
  if (idx < 0 || idx === siblings.length - 1) return null;
  return siblings[idx + 1].id;
}

function selectBookmark(id) {
  selectedBookmarkId = id;
  for (const el of bookmarkTree.querySelectorAll(".bookmark-item.is-workspace")) {
    el.classList.toggle("is-selected", el.dataset.bookmarkId === id);
  }
  refreshBookmarkToolbarState();
}

function refreshBookmarkToolbarState() {
  const addBtn = $("bookmark-add");
  const rmBtn = $("bookmark-remove");
  const impBtn = $("bookmark-import");
  const indentBtn = $("bookmark-indent");
  const outdentBtn = $("bookmark-outdent");
  if (addBtn) addBtn.disabled = !isOpen;
  if (rmBtn) rmBtn.disabled = !isOpen || !selectedBookmarkId || bookmarkSource !== "workspace";
  // Import only useful when source-PDF /Outlines exist AND workspace
  // is empty (otherwise there'd be duplicate entries; user can − the
  // existing workspace ones first if they really want to re-import).
  if (impBtn) impBtn.disabled = !isOpen || bookmarkSource !== "outline";
  const sel = selectedBookmarkId
    ? workspaceBookmarksCache.find((b) => b.id === selectedBookmarkId)
    : null;
  if (indentBtn) {
    indentBtn.disabled = !sel || !canIndentBookmark(sel);
  }
  if (outdentBtn) {
    outdentBtn.disabled = !sel || !canOutdentBookmark(sel);
  }
}

function canIndentBookmark(b) {
  // Indent = move under the previous sibling (which must exist).
  return !!previousSiblingId(b);
}

function canOutdentBookmark(b) {
  // Outdent = promote to grandparent. Only valid when current parent
  // exists (otherwise we're already at top level).
  return !!b.parentId;
}

function previousSiblingId(b) {
  const siblings = workspaceBookmarksCache
    .filter((x) => (x.parentId ?? null) === (b.parentId ?? null))
    .sort((a, c) => a.sortOrder - c.sortOrder);
  const idx = siblings.findIndex((x) => x.id === b.id);
  if (idx <= 0) return null;
  return siblings[idx - 1].id;
}

async function actionIndentBookmark() {
  const sel = selectedBookmarkId
    ? workspaceBookmarksCache.find((b) => b.id === selectedBookmarkId)
    : null;
  if (!sel) return;
  const prevId = previousSiblingId(sel);
  if (!prevId) return;
  try {
    await kpdf3.moveBookmark({ id: sel.id, parentId: prevId, beforeId: null });
    await refreshBookmarks();
  } catch (err) {
    console.error("[bookmark] indent failed", err);
  }
}

async function actionOutdentBookmark() {
  const sel = selectedBookmarkId
    ? workspaceBookmarksCache.find((b) => b.id === selectedBookmarkId)
    : null;
  if (!sel || !sel.parentId) return;
  const parent = workspaceBookmarksCache.find((b) => b.id === sel.parentId);
  if (!parent) return;
  // Place after parent (= before parent's next sibling).
  const beforeId = nextSiblingId(parent);
  try {
    await kpdf3.moveBookmark({
      id: sel.id,
      parentId: parent.parentId ?? null,
      beforeId,
    });
    await refreshBookmarks();
  } catch (err) {
    console.error("[bookmark] outdent failed", err);
  }
}

function startInlineRenameBookmark(li, b) {
  const label = li.querySelector(".bookmark-label");
  if (!label) return;
  const input = document.createElement("input");
  input.type = "text";
  input.value = b.title;
  input.className = "bookmark-rename-input";
  label.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim() || b.title;
    if (commit && next !== b.title) {
      try {
        await kpdf3.renameBookmark({ id: b.id, title: next });
      } catch (err) {
        console.error("[bookmark] rename failed", err);
      }
    }
    await refreshBookmarks();
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
}

async function actionAddBookmark() {
  if (!isOpen) return;
  const pageNo = viewer.currentPage;
  if (!pageNo) return;
  const fallback = `ページ ${pageNo > 0 ? pageNo : "挿入"}`;
  const entered = await showRangePrompt({
    title: "しおりを追加",
    message: `ページ ${pageNo > 0 ? pageNo : "挿入"} のしおり名を入力（空欄で「${fallback}」）`,
    value: "",
  });
  if (entered === null) return; // user cancelled
  const id = (crypto?.randomUUID?.() ?? `bm-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const title = entered.trim() || fallback;
  try {
    await kpdf3.addBookmark({ id, title, pageNo });
    await refreshBookmarks();
    selectBookmark(id);
  } catch (err) {
    console.error("[bookmark] add failed", err);
    wsStatus.textContent = `しおり追加失敗: ${err.message ?? err}`;
  }
}

async function actionRemoveBookmark() {
  if (!selectedBookmarkId) return;
  try {
    await kpdf3.removeBookmark({ id: selectedBookmarkId });
    selectedBookmarkId = null;
    await refreshBookmarks();
  } catch (err) {
    console.error("[bookmark] remove failed", err);
  }
}

$("bookmark-add")?.addEventListener("click", actionAddBookmark);
$("bookmark-remove")?.addEventListener("click", actionRemoveBookmark);
$("bookmark-indent")?.addEventListener("click", actionIndentBookmark);
$("bookmark-outdent")?.addEventListener("click", actionOutdentBookmark);

// Tab / Shift+Tab when focus is inside the bookmark sidebar.
bookmarkTree.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  if (bookmarkSource !== "workspace" || !selectedBookmarkId) return;
  e.preventDefault();
  if (e.shiftKey) actionOutdentBookmark();
  else actionIndentBookmark();
});

/** Flatten the source-PDF /Outlines tree into workspace bookmarks so the
 *  user can edit / extend them. The tree is walked depth-first; titles
 *  for nodes without a target page get suffixed "(章)" so they stay
 *  visible but skip navigation. Subsequent calls are guarded by the
 *  toolbar disabled state when workspace bookmarks already exist. */
async function actionImportOutlines() {
  if (!isOpen) return;
  const ok = await customConfirm({
    title: "しおりの取り込み",
    message: "元 PDF のしおりを workspace に取り込みます。\n以後は編集できるようになります。",
    okLabel: "取り込む",
  });
  if (!ok) return;
  const outline = await kpdf3.getOutline();
  if (!Array.isArray(outline) || outline.length === 0) {
    wsStatus.textContent = "取り込めるしおりがありません";
    return;
  }
  // Depth-first walk that preserves the source PDF's hierarchy. Nodes
  // without a pageNo of their own inherit the parent's (or 1 if absent)
  // so they're still navigable.
  let added = 0;
  const walk = async (nodes, fallbackPage, parentId) => {
    for (const n of nodes) {
      const pageNo = typeof n.pageNo === "number" && n.pageNo > 0 ? n.pageNo : fallbackPage;
      const id =
        crypto?.randomUUID?.() ?? `bm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await kpdf3.addBookmark({
        id,
        title: n.title || "(無題)",
        pageNo,
        parentId,
      });
      added += 1;
      if (Array.isArray(n.children) && n.children.length > 0) {
        await walk(n.children, pageNo, id);
      }
    }
  };
  try {
    await walk(outline, 1, null);
    await refreshBookmarks();
    wsStatus.textContent = `${added} 件のしおりを取り込みました`;
  } catch (err) {
    console.error("[bookmark] import failed", err);
    wsStatus.textContent = `取り込み失敗: ${err.message ?? err}`;
  }
}
$("bookmark-import")?.addEventListener("click", actionImportOutlines);

function actionToggleBookmarks() {
  if (!isOpen) return;
  sidebar.hidden = !sidebar.hidden;
  refreshSidebarToggle();
  refreshMenuState();
  // Trigger thumb rendering for items now visible.
  if (!sidebar.hidden && currentSidebarTab === "thumbs") {
    requestVisibleThumbRenders();
  }
}

function refreshSidebarToggle() {
  const toggle = $("sidebar-toggle");
  if (!toggle) return;
  const open = isOpen && !sidebar.hidden;
  toggle.classList.toggle("is-open", open);
  toggle.disabled = !isOpen;
}

const sidebarToggleBtn = $("sidebar-toggle");
sidebarToggleBtn.addEventListener("click", actionToggleBookmarks);

// ---- Sidebar tabs (しおり / サムネ) -----------------------------------
const THUMB_ZOOM = 0.3;
let currentSidebarTab = "thumbs";
const thumbCache = new Map(); // pageNo -> HTMLCanvasElement
const inFlightThumbs = new Set();
let thumbObserver = null;
let lastHighlightedThumb = null;

const sidebarTabEls = document.querySelectorAll(".sidebar-tablist [role='tab']");
const sidebarPanes = document.querySelectorAll(".sidebar-pane");

for (const tabEl of sidebarTabEls) {
  tabEl.addEventListener("click", (e) => {
    e.preventDefault();
    switchSidebarTab(tabEl.dataset.tab);
  });
}

function switchSidebarTab(tab) {
  currentSidebarTab = tab;
  for (const t of sidebarTabEls) {
    t.setAttribute("aria-selected", t.dataset.tab === tab ? "true" : "false");
  }
  for (const p of sidebarPanes) {
    p.hidden = p.dataset.pane !== tab;
  }
  if (tab === "thumbs") requestVisibleThumbRenders();
}

function ensureThumbObserver() {
  if (thumbObserver) return thumbObserver;
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const item = e.target;
          const pageNo = Number(item.dataset.pageNo);
          if (pageNo && !thumbCache.has(pageNo) && !inFlightThumbs.has(pageNo)) {
            renderThumb(pageNo, item);
          }
        }
      }
    },
    { root: thumbList.parentElement, rootMargin: "200px", threshold: 0.01 },
  );
  return thumbObserver;
}

/** Build thumb items for the given pages array (already filtered to
 *  non-deleted by main). Pass the visible pageNos so click→scroll uses
 *  the actual page index in the viewer. */
// ---- Thumbnail drag-and-drop reorder (#23 / #32) ----------------------
//
// HTML5 D&D on each sidebar thumb. Both source AND synthetic pages
// can be reordered freely (positional `display_order` shared between
// pages + inserted_pages — see ADR-0015 / sqlite-store.reorderAllPages).

const THUMB_DND_MIME = "application/x-kpdf3-page-no";
// Closure-captured page number for the thumb being dragged. We use
// this instead of relying on `dataTransfer.types` during dragover,
// because some Chromium drag scenarios (notably the very first drag
// in a fresh session) didn't surface the custom MIME on dragover,
// which made our preventDefault/dropEffect path skip and the OS
// rejected the drop.
let _draggingThumbPN = null;

function attachThumbDragHandlers(item, pageNo) {
  // Both source (positive pageNo) and synthetic (negative) thumbs are
  // draggable — they share a positional display_order so reordering
  // either one is symmetric. Layout direction is detected from the
  // element's class so the split-save horizontal grid uses left/right
  // drop indicators while the vertical sidebar uses top/bottom.
  const isHorizontal = item.classList.contains("split-thumb");
  item.draggable = true;
  item.addEventListener("dragstart", (e) => {
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(THUMB_DND_MIME, String(pageNo));
      e.dataTransfer.setData("text/plain", String(pageNo));
    }
    _draggingThumbPN = pageNo;
    item.classList.add("is-dragging");
    // Multi-select drag: mark every selected sibling thumb as also
    // being dragged so the user sees them dim together.
    const selectionSet = movingKeysForDrag(pageNo);
    if (selectionSet) {
      for (const sib of document.querySelectorAll(".thumb-item, .split-thumb")) {
        const sibPN = Number(sib.dataset.pageNo);
        if (selectionSet.has(sibPN)) sib.classList.add("is-dragging");
      }
    }
    // Body-level marker — CSS hides the +gaps' default hover styling
    // while a thumb drag is in flight so only the active drop target
    // shows an indicator (avoids the "3 stacked blue lines" look).
    document.body.classList.add("thumb-dragging");
  });
  item.addEventListener("dragend", () => {
    _draggingThumbPN = null;
    document.body.classList.remove("thumb-dragging");
    // Sweep all `is-dragging` marks regardless of which thumb started
    // the drag — covers the multi-select fan-out above.
    for (const el of document.querySelectorAll(".is-dragging")) {
      el.classList.remove("is-dragging");
    }
    clearThumbDropIndicators();
  });
  item.addEventListener("dragover", (e) => {
    if (_draggingThumbPN === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    showBoundaryIndicator(item, e, isHorizontal);
  });
  item.addEventListener("dragleave", (e) => {
    if (!item.contains(e.relatedTarget)) {
      item.classList.remove(
        "drop-before-v", "drop-after-v",
        "drop-before-h", "drop-after-h",
      );
    }
  });
  item.addEventListener("drop", async (e) => {
    if (_draggingThumbPN === null) return;
    e.preventDefault();
    e.stopPropagation();
    const draggedPN = _draggingThumbPN;
    clearThumbDropIndicators();
    if (!Number.isFinite(draggedPN) || draggedPN === pageNo) return;
    const r = item.getBoundingClientRect();
    const before = isHorizontal
      ? e.clientX < r.left + r.width / 2
      : e.clientY < r.top + r.height / 2;
    await applyThumbReorder(draggedPN, pageNo, before);
  });
}

/** Boundary-aware indicator: only ever shows ONE blue line at the
 *  drop boundary, even when the cursor is right on the seam between
 *  two adjacent thumbs. "Cursor on right half of N" and "cursor on
 *  left half of N+1" both resolve to the same boundary, which we
 *  display as a single drop-before-* on N+1. The trailing-edge case
 *  (cursor past the very last thumb) keeps drop-after-* on N. */
function showBoundaryIndicator(item, evt, isHorizontal) {
  const r = item.getBoundingClientRect();
  const before = isHorizontal
    ? evt.clientX < r.left + r.width / 2
    : evt.clientY < r.top + r.height / 2;
  if (before) {
    setThumbDropIndicator(item, true, isHorizontal);
    return;
  }
  // "after" — collapse to next thumb's "before" so the indicator
  // sits in the gap once, not as two adjacent half-edges.
  const next = nextThumbSibling(item);
  if (next) {
    setThumbDropIndicator(next, true, isHorizontal);
  } else {
    setThumbDropIndicator(item, false, isHorizontal);
  }
}

/** Walk forward through DOM siblings until we hit another thumb-like
 *  element (sidebar `.thumb-item` or split `.split-thumb`). Skips
 *  intervening gaps / separators / labels. */
function nextThumbSibling(el) {
  let cur = el.nextElementSibling;
  while (cur) {
    if (
      cur.classList.contains("thumb-item") ||
      cur.classList.contains("split-thumb")
    ) {
      return cur;
    }
    cur = cur.nextElementSibling;
  }
  return null;
}

function hasThumbPagePayload(dt) {
  if (!dt) return false;
  return Array.from(dt.types || []).includes(THUMB_DND_MIME);
}

function setThumbDropIndicator(el, before, horizontal = false) {
  clearThumbDropIndicators();
  if (horizontal) {
    el.classList.add(before ? "drop-before-h" : "drop-after-h");
  } else {
    el.classList.add(before ? "drop-before-v" : "drop-after-v");
  }
}

function clearThumbDropIndicators() {
  // Sweep both sidebar and split-view thumb lists since either may
  // host the drag/drop interaction.
  const els = document.querySelectorAll(
    ".drop-before-v, .drop-after-v, .drop-before-h, .drop-after-h",
  );
  for (const el of els) {
    el.classList.remove(
      "drop-before-v", "drop-after-v",
      "drop-before-h", "drop-after-h",
    );
  }
}

/** Pick the selection set that owns `draggedKey` so a multi-select
 *  drag picks up the right sidebar/split context. Returns the page-
 *  Nos Set or null when the drag is a single-thumb drag (no
 *  selection or selection doesn't include the dragged page). */
function movingKeysForDrag(draggedKey) {
  for (const sel of [sidebarThumbSelection, splitThumbSelection]) {
    if (sel.pageNos.size > 1 && sel.pageNos.has(draggedKey)) {
      return sel.pageNos;
    }
  }
  return null;
}

/** Reorder via positional display_order across both source +
 *  synthetic pages. Pulls the current visible page list, moves the
 *  dragged key (or, when multi-selected, every selected key) to
 *  before/after the target, and pushes the new order to main. After
 *  the reorder we scroll to the *dragged* page so the user can
 *  immediately verify its new position. */
async function applyThumbReorder(draggedKey, targetKey, before) {
  const pages = await kpdf3.getPages();
  const allKeys = pages.map((p) => p.pageNo);

  // Multi-select-aware moving set. Preserves the relative order of
  // selected pages so they land as a contiguous block at the drop
  // site. A single-page drag falls back to the original behaviour.
  const selectionSet = movingKeysForDrag(draggedKey);
  let movingKeys;
  if (selectionSet) {
    movingKeys = allKeys.filter((k) => selectionSet.has(k));
  } else {
    movingKeys = [draggedKey];
  }
  // No-op if the user dropped onto one of the selected pages.
  if (movingKeys.includes(targetKey)) return;

  const remaining = allKeys.filter((k) => !movingKeys.includes(k));
  let toIdx = remaining.indexOf(targetKey);
  if (toIdx < 0) return;
  if (!before) toIdx += 1;
  remaining.splice(toIdx, 0, ...movingKeys);

  try {
    await kpdf3.reorderAllPages(remaining);
    markWorkspaceMutated();
    await refreshViewer();
    // The split view has its own DOM tree; refreshViewer doesn't
    // rebuild it. Without this call the split-save area would keep
    // showing the pre-reorder thumbs even after the DB updated.
    if (isSplitMode) await refreshSplitView();
    // Jump to the page that was just moved so the user can verify
    // where it landed. Keeps the operation visually "self-confirming".
    viewer.scrollToPage(draggedKey);
    wsStatus.textContent =
      movingKeys.length > 1
        ? `${movingKeys.length} ページを移動`
        : `ページ順を更新`;
  } catch (err) {
    console.error("[thumb-reorder] failed", err);
    wsStatus.textContent = `並び替え失敗: ${err.message ?? err}`;
  }
}

/** Identify a standard paper size from canonical (pre-rotation) point
 *  dimensions. Returns the JIS / ISO / US Letter family name when the
 *  dims are within ~1.5pt of the spec; null otherwise. The returned
 *  name is shown as a small badge on the thumbnail when ≠ A4 so the
 *  user can spot mixed-paper PDFs at a glance. */
function detectPaperSize(w, h) {
  // Compare both portrait and landscape orientations to one canonical.
  const W = Math.min(w, h), H = Math.max(w, h);
  // Each row: [name, portraitW, portraitH] in PDF points (1pt = 1/72in).
  const SIZES = [
    ["A3",     841.89, 1190.55],
    ["A4",     595.28,  841.89],
    ["A5",     419.53,  595.28],
    ["B4",     728.50, 1031.81],
    ["B5",     515.91,  728.50],
    ["Letter", 612.00,  792.00],
    ["Legal",  612.00, 1008.00],
  ];
  const TOL = 2.0; // 2pt fudge ≈ 0.7mm — covers rounding in source PDFs
  for (const [name, pw, ph] of SIZES) {
    if (Math.abs(W - pw) < TOL && Math.abs(H - ph) < TOL) return name;
  }
  return null;
}

function rebuildThumbs(pages) {
  clearThumbs();
  const list = Array.isArray(pages)
    ? pages
    : Array.from({ length: pages || 0 }, (_, i) => ({ pageNo: i + 1 }));
  if (list.length === 0) return;
  const obs = ensureThumbObserver();

  // Insert "+" gap before page 1 (afterPageNo = 0). Only for source-PDF
  // pages — gaps are anchored to the prior source page, so they sit
  // before the first source page or after each one.
  const firstSrcRow = list.find((r) => !r.isSynthetic);
  if (firstSrcRow) {
    thumbList.appendChild(makeInsertGap(0));
  }

  for (let visualIdx = 0; visualIdx < list.length; visualIdx++) {
    const row = list[visualIdx];
    const i = row.pageNo;
    const item = document.createElement("div");
    item.className = "thumb-item";
    item.dataset.pageNo = String(i);
    item.tabIndex = 0;
    if (row.isSynthetic) item.classList.add("is-synthetic");
    const ph = document.createElement("div");
    ph.className = "thumb-placeholder";
    // Per-page aspect ratio — without this the slot is locked to A4
    // portrait, so a 90° rotated page renders into a tall slot and
    // ends up squashed to ~half the available width. cropW/H land in
    // the canonical (pre-rotation) frame; userRotation is what
    // actually determines whether the displayed paper is landscape.
    const cw = row.cropW ?? row.width ?? 595;
    const ch = row.cropH ?? row.height ?? 842;
    const userRot = (((row.userRotation ?? 0) % 360) + 360) % 360;
    const swap = userRot === 90 || userRot === 270;
    ph.style.aspectRatio = swap ? `${ch} / ${cw}` : `${cw} / ${ch}`;
    item.appendChild(ph);
    const label = document.createElement("div");
    label.className = "thumb-label";
    // Show the *visual* position (1-indexed, matches the page count
    // indicator at the bottom). Synthetic pages get a tiny ✎ marker
    // before the number so the user can still tell which were
    // user-inserted, but they share the same numbering scheme.
    const visualPos = visualIdx + 1;
    label.textContent = row.isSynthetic ? `✎ ${visualPos}` : String(visualPos);
    // Paper-size badge for non-A4 sources (A3/A5/B4/B5/Letter/Legal).
    const sizeName = detectPaperSize(cw, ch);
    if (sizeName && sizeName !== "A4") {
      const badge = document.createElement("span");
      badge.className = "thumb-size-badge";
      badge.textContent = sizeName;
      item.appendChild(badge);
    }
    item.appendChild(label);
    item.addEventListener("click", (e) => {
      const ordered = getOrderedThumbPageNos(thumbList, ".thumb-item");
      handleThumbSelectionClick(sidebarThumbSelection, ordered, i, e);
      item.focus();
      // Synthetic pages have negative pageNo but still live in the
      // viewer's layout / scrollToPage map, so they can be scrolled to
      // exactly like source pages.
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
        viewer.scrollToPage(i);
      }
    });
    item.addEventListener("dblclick", () => {
      viewer.scrollToPage(i);
    });
    attachThumbContextMenu(item, i);
    attachThumbDragHandlers(item, i);
    thumbList.appendChild(item);
    obs.observe(item);

    // Gap after this row.
    // - Source page: anchor afterPageNo = source page number, no
    //   orderInSlot → append to slot (after any existing synthetics
    //   already in this slot).
    // - Synthetic page: anchor afterPageNo = its slot's source page
    //   (syntheticAfterPageNo), orderInSlot = its order + 1, so the
    //   new blank lands right after this synthetic and bumps any
    //   following synthetics in the same slot down by one.
    if (row.isSynthetic) {
      thumbList.appendChild(
        makeInsertGap(row.syntheticAfterPageNo ?? 0, (row.syntheticOrderInSlot ?? 0) + 1),
      );
    } else {
      thumbList.appendChild(makeInsertGap(i));
    }
  }
  refreshThumbSelectionVisuals();
}

/** Wire drop-on-gap so dragging a PDF onto an insert gap inserts that
 *  PDF's pages here. stopPropagation prevents the global drop handler
 *  (which opens a fresh PDF) from firing too.
 *  TODO: pass orderInSlot through to addInsertedPdfPages once main supports it.
 */
function attachInsertGapDrop(gap, afterPageNo) {
  gap.addEventListener("dragover", (e) => {
    if (!e.dataTransfer) return;
    const types = [...e.dataTransfer.types];
    // Sidebar page reorder takes precedence over file drop so we don't
    // mis-display "copy" cursor while a thumb is in flight. Use the
    // JS closure var because dragover types may be empty/unreliable.
    if (_draggingThumbPN !== null) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      gap.classList.add("drop-target");
    } else if (types.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      gap.classList.add("drop-target");
    }
  });
  gap.addEventListener("dragleave", () => gap.classList.remove("drop-target"));
  gap.addEventListener("drop", async (e) => {
    gap.classList.remove("drop-target");
    if (!e.dataTransfer) return;
    // Sidebar-page reorder via gap drop.
    if (_draggingThumbPN !== null) {
      e.preventDefault();
      e.stopPropagation();
      const draggedPN = _draggingThumbPN;
      if (!Number.isFinite(draggedPN) || draggedPN <= 0) return;
      await applyThumbReorderToGap(draggedPN, afterPageNo);
      return;
    }
    // External file drop = insert-from-PDF (legacy behaviour).
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    const path = kpdf3.getPathForFile?.(file) || file.path || "";
    if (!path || !/\.pdf$/i.test(path)) {
      wsStatus.textContent = "PDF ファイルをドロップしてください";
      return;
    }
    showBusy("挿入", "外部 PDF を取り込み中...", 0);
    try {
      const r = await kpdf3.addInsertedPdfPages({ afterPageNo, externalPath: path });
      hideBusy();
      markWorkspaceMutated();
      await refreshViewer();
      const n = r?.syntheticPageNos?.length ?? 0;
      wsStatus.textContent = `${n} ページを挿入しました`;
    } catch (err) {
      hideBusy();
      console.error("[insert-pdf] failed", err);
      wsStatus.textContent = `挿入失敗: ${err.message ?? err}`;
    }
  });
}

/** Reorder helper invoked when a thumb is dropped onto an insert
 *  gap. afterPageNo = the source page directly before the gap (or 0
 *  when dropping at the very top of the list). The dragged page ends
 *  up immediately after afterPageNo in display order, sharing the
 *  positional ordering with synthetic pages. */
async function applyThumbReorderToGap(draggedKey, afterPageNo) {
  const pages = await kpdf3.getPages();
  const allKeys = pages.map((p) => p.pageNo);

  // Same multi-select handling as applyThumbReorder so a Shift-
  // selected block dragged onto a +gap moves as one unit.
  const selectionSet = movingKeysForDrag(draggedKey);
  let movingKeys;
  if (selectionSet) {
    movingKeys = allKeys.filter((k) => selectionSet.has(k));
  } else {
    movingKeys = [draggedKey];
  }

  const remaining = allKeys.filter((k) => !movingKeys.includes(k));
  let toIdx;
  if (afterPageNo === 0 || afterPageNo == null) {
    toIdx = 0;
  } else {
    const anchor = remaining.indexOf(afterPageNo);
    toIdx = anchor < 0 ? remaining.length : anchor + 1;
  }
  remaining.splice(toIdx, 0, ...movingKeys);
  try {
    await kpdf3.reorderAllPages(remaining);
    markWorkspaceMutated();
    await refreshViewer();
    if (isSplitMode) await refreshSplitView();
    viewer.scrollToPage(draggedKey);
    wsStatus.textContent =
      movingKeys.length > 1
        ? `${movingKeys.length} ページを移動`
        : `ページ順を更新`;
  } catch (err) {
    console.error("[thumb-reorder] gap drop failed", err);
    wsStatus.textContent = `並び替え失敗: ${err.message ?? err}`;
  }
}

function makeInsertGap(afterPageNo, orderInSlot = null) {
  const gap = document.createElement("div");
  gap.className = "thumb-insert-gap";
  gap.tabIndex = 0;
  gap.title = `クリック=白紙挿入 / PDF をドロップ=外部 PDF 挿入 (afterPageNo=${afterPageNo}${orderInSlot != null ? `, order=${orderInSlot}` : ""})`;
  gap.textContent = "＋ 白紙 / PDF をドロップ";
  gap.addEventListener("click", () => promptAndInsertBlank(afterPageNo, orderInSlot));
  gap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      promptAndInsertBlank(afterPageNo, orderInSlot);
    }
  });
  attachInsertGapDrop(gap, afterPageNo);
  return gap;
}

function makeSplitInsertGap(afterPageNo, orderInSlot = null) {
  const gap = document.createElement("div");
  gap.className = "thumb-insert-gap thumb-insert-gap-vertical";
  gap.tabIndex = 0;
  gap.title = `クリック=白紙挿入 / PDF をドロップ=外部 PDF 挿入 (afterPageNo=${afterPageNo})`;
  gap.textContent = "＋";
  gap.addEventListener("click", () => promptAndInsertBlank(afterPageNo, orderInSlot));
  gap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      promptAndInsertBlank(afterPageNo, orderInSlot);
    }
  });
  attachInsertGapDrop(gap, afterPageNo);
  return gap;
}

// ---- Multi-select: separate state for sidebar vs split-save thumbs ----
function makeSelection() {
  return { pageNos: new Set(), anchor: null };
}
const sidebarThumbSelection = makeSelection();
const splitThumbSelection = makeSelection();

// Back-compat alias used by the delete flow (acts on whichever context the
// user is interacting with — see deleteSelectedPages below).
const thumbSelection = sidebarThumbSelection;

function getOrderedThumbPageNos(rootEl, selector) {
  if (!rootEl) return [];
  // Include synthetic (negative pageNo) pages too so Shift+click can
  // span across inserted blank pages — the selection set + downstream
  // delete handler already split source vs synthetic correctly.
  return [...rootEl.querySelectorAll(selector)]
    .map((el) => Number(el.dataset.pageNo))
    .filter((n) => Number.isFinite(n) && n !== 0);
}

function handleThumbSelectionClick(state, orderedPageNos, pageNo, evt) {
  if (evt.shiftKey && state.anchor !== null) {
    const a = orderedPageNos.indexOf(state.anchor);
    const b = orderedPageNos.indexOf(pageNo);
    if (a >= 0 && b >= 0) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (!evt.ctrlKey && !evt.metaKey) state.pageNos.clear();
      for (let k = lo; k <= hi; k++) {
        state.pageNos.add(orderedPageNos[k]);
      }
    }
  } else if (evt.ctrlKey || evt.metaKey) {
    if (state.pageNos.has(pageNo)) state.pageNos.delete(pageNo);
    else state.pageNos.add(pageNo);
    state.anchor = pageNo;
  } else {
    state.pageNos.clear();
    state.pageNos.add(pageNo);
    state.anchor = pageNo;
  }
  refreshThumbSelectionVisuals();
}

function refreshThumbSelectionVisuals() {
  for (const el of thumbList?.querySelectorAll(".thumb-item") ?? []) {
    const n = Number(el.dataset.pageNo);
    el.classList.toggle("is-selected", sidebarThumbSelection.pageNos.has(n));
  }
  for (const el of splitFlow?.querySelectorAll(".split-thumb[data-page-no]") ?? []) {
    const n = Number(el.dataset.pageNo);
    el.classList.toggle("is-selected", splitThumbSelection.pageNos.has(n));
  }
}

function clearThumbSelection() {
  sidebarThumbSelection.pageNos.clear();
  sidebarThumbSelection.anchor = null;
  splitThumbSelection.pageNos.clear();
  splitThumbSelection.anchor = null;
  refreshThumbSelectionVisuals();
}

/** Pages the user has marked for deletion in this session, not yet
 *  persisted. Flushed to SQLite on Ctrl+S. Until then, viewer / thumbs /
 *  export / print all filter via this set so the deletion is purely
 *  in-memory. Reset on close / new PDF open.
 *  Initialised from the boot tab; rebound by applyTab() on switch. */
let pendingDeletedPages = _bootTab.pendingDeletedPages;

/** Workspace got changed via a path that already persisted to DB
 *  (page insertions/removals). Flagging this lets Ctrl+S behave
 *  consistently — the save action will simply clear the flag. */
let workspaceMutated = false;
function markWorkspaceMutated() {
  workspaceMutated = true;
  refreshDirtyIndicator();
  refreshMenuState();
}

// ---- Insert blank/text page dialog ----------------------------------
const insertDialog = $("insert-dialog");
const insertTitleText = $("insert-title-text");
const insertPositionLabel = $("insert-position-label");
const insertTextEl = $("insert-text");
const insertConfirmBtn = $("insert-confirm");
const insertCancelBtn = $("insert-cancel");
const insertTitlebarCloseBtn = $("insert-titlebar-close");

let insertResolve = null;

function showInsertDialog({ afterPageNo }) {
  insertPositionLabel.textContent =
    afterPageNo === 0 ? "全ページの先頭" : `p.${afterPageNo} の直後`;
  insertTextEl.value = "";
  insertDialog.hidden = false;
  setTimeout(() => insertTextEl.focus(), 0);
  return new Promise((resolve) => {
    insertResolve = resolve;
  });
}

function settleInsertDialog(value) {
  insertDialog.hidden = true;
  if (insertResolve) {
    const r = insertResolve;
    insertResolve = null;
    r(value);
  }
}

insertConfirmBtn.addEventListener("click", () =>
  settleInsertDialog({ text: insertTextEl.value }),
);
insertCancelBtn.addEventListener("click", () => settleInsertDialog(null));
insertTitlebarCloseBtn.addEventListener("click", () => settleInsertDialog(null));
insertDialog.addEventListener("click", (e) => {
  if (e.target === insertDialog) settleInsertDialog(null);
});
insertTextEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    settleInsertDialog({ text: insertTextEl.value });
  } else if (e.key === "Escape") {
    e.preventDefault();
    settleInsertDialog(null);
  }
});

async function promptAndInsertBlank(afterPageNo, orderInSlot = null) {
  const r = await showInsertDialog({ afterPageNo });
  if (!r) return;
  try {
    await kpdf3.addInsertedPage({
      afterPageNo,
      text: r.text || null,
      orderInSlot,
    });
    wsStatus.textContent =
      afterPageNo === 0
        ? `先頭に白紙を挿入しました${r.text ? "（テキスト付き）" : ""}`
        : `p.${afterPageNo} の後に白紙を挿入しました${r.text ? "（テキスト付き）" : ""}`;
    markWorkspaceMutated();
    await refreshViewer();
    // If split-save is active, refresh its UI with the new page list.
    if (isSplitMode) await refreshSplitView();
  } catch (err) {
    console.error("[insert] failed", err);
    wsStatus.textContent = `挿入失敗: ${err.message ?? err}`;
  }
}

/** Refresh the split-save panel after a workspace-level page change
 *  (insert/delete). Regenerates thumbnails for any new pages and rebuilds
 *  the row layout. Called only while split mode is active. */
async function refreshSplitView() {
  const pages = await fetchVisiblePages();
  if (pages.length === 0) return;
  // Drop cache entries for pages that no longer exist (e.g. deleted)
  const livePageNos = new Set(pages.map((p) => p.pageNo));
  for (const cachedPageNo of [...splitState.thumbCache.keys()]) {
    if (!livePageNos.has(cachedPageNo)) {
      splitState.thumbCache.delete(cachedPageNo);
    }
  }
  await generateAllThumbnails(pages);
  rebuildSplitUI(pages);
}

function isWorkspaceDirty() {
  return (
    projectStore.isDirty() ||
    pendingDeletedPages.size > 0 ||
    workspaceMutated
  );
}

/** Pages currently visible to the user (DB pages minus pending deletions). */
async function fetchVisiblePages() {
  const all = await kpdf3.getPages();
  return all.filter((p) => !pendingDeletedPages.has(p.pageNo));
}

async function deleteSelectedPages(state = sidebarThumbSelection) {
  const all = [...state.pageNos].sort((a, b) => a - b);
  if (all.length === 0) return;
  const sourceDeletes = all.filter((n) => n > 0);
  const syntheticDeletes = all.filter((n) => n < 0);
  const labels = all
    .map((n) => (n > 0 ? `p.${n}` : "挿入ページ"))
    .join(", ");
  const ok = await customConfirm({
    title: "ページ削除の確認",
    message:
      all.length === 1
        ? `${labels} を削除しますか？\n\n※ 元 PDF は変更されません。\n挿入ページは即時削除、元ページは Ctrl+S で確定。`
        : `${all.length} ページを削除しますか？\n(${labels})\n\n※ 元 PDF は変更されません。\n挿入ページは即時削除、元ページは Ctrl+S で確定。`,
    okLabel: "削除",
  });
  if (!ok) return;
  // Synthetic pages: remove immediately from DB (no pending state).
  for (const n of syntheticDeletes) {
    try {
      await kpdf3.removeInsertedPage(n);
    } catch (err) {
      console.error("[remove-inserted] failed", err);
    }
  }
  if (syntheticDeletes.length > 0) markWorkspaceMutated();
  // Source pages: queue as pending until Ctrl+S.
  for (const n of sourceDeletes) pendingDeletedPages.add(n);
  state.pageNos.clear();
  state.anchor = null;
  refreshThumbSelectionVisuals();
  const parts = [];
  if (syntheticDeletes.length > 0) parts.push(`${syntheticDeletes.length} 挿入ページを削除`);
  if (sourceDeletes.length > 0) parts.push(`${sourceDeletes.length} 元ページを削除予定 (Ctrl+S で確定)`);
  wsStatus.textContent = parts.join(" / ");
  refreshDirtyIndicator();
  await refreshViewer();
  if (isSplitMode) await refreshSplitView();
}

// Delete key from either thumb context — each operates on its own selection.
thumbList?.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelectedPages(sidebarThumbSelection);
  }
});
splitFlow?.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelectedPages(splitThumbSelection);
  }
});

function clearThumbs() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = null;
  thumbCache.clear();
  inFlightThumbs.clear();
  thumbList.innerHTML = "";
  lastHighlightedThumb = null;
}

async function renderThumb(pageNo, itemEl) {
  inFlightThumbs.add(pageNo);
  try {
    const row = viewer._pages?.find((p) => p.pageNo === pageNo);
    if (!row) return;
    let result;
    if (pageNo < 0) {
      result = await renderSyntheticPagePixels(row, THUMB_ZOOM);
    } else {
      result = await kpdf3.renderPage(pageNo, { zoom: THUMB_ZOOM });
    }
    // compositePage handles userRotation + overlays — sidebar thumbs
    // now visually match the page (with stamps/marks/text on top).
    // compositePage is async because image-stamp drawImage needs an
    // awaited bitmap; without await the thumb gets a Promise instead
    // of a canvas and the sidebar goes blank.
    const canvas = await compositePage(row, result, projectStore, THUMB_ZOOM);
    canvas.className = "thumb-img";
    const ph = itemEl.querySelector(".thumb-placeholder");
    if (ph) ph.replaceWith(canvas);
    thumbCache.set(pageNo, canvas);
  } catch (err) {
    console.error("[thumb] render failed", pageNo, err);
  } finally {
    inFlightThumbs.delete(pageNo);
  }
}

function requestVisibleThumbRenders() {
  // IntersectionObserver fires automatically as items become visible, but
  // when we toggle the pane from hidden→visible the observer may not refire
  // for already-intersecting elements. Force-evaluate the visible viewport.
  if (!thumbList) return;
  const rootRect = thumbList.parentElement.getBoundingClientRect();
  for (const item of thumbList.children) {
    const r = item.getBoundingClientRect();
    const visible = r.bottom >= rootRect.top - 200 && r.top <= rootRect.bottom + 200;
    const pageNo = Number(item.dataset.pageNo);
    if (visible && pageNo && !thumbCache.has(pageNo) && !inFlightThumbs.has(pageNo)) {
      renderThumb(pageNo, item);
    }
  }
}

function highlightCurrentThumb(pageNo) {
  if (!thumbList) return;
  if (lastHighlightedThumb && lastHighlightedThumb.dataset.pageNo === String(pageNo)) return;
  if (lastHighlightedThumb) lastHighlightedThumb.classList.remove("is-current");
  const next = thumbList.querySelector(`.thumb-item[data-page-no="${pageNo}"]`);
  if (next) {
    next.classList.add("is-current");
    if (currentSidebarTab === "thumbs" && !sidebar.hidden) {
      next.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }
  lastHighlightedThumb = next ?? null;
}

const aboutDialog = $("about-dialog");
const aboutVersionEl = $("about-version");
const aboutMetaEl = $("about-meta");
const aboutCloseBtn = $("about-close");

function hideAboutDialog() {
  aboutDialog.hidden = true;
}

async function actionAbout() {
  const info = await kpdf3.getAppInfo();
  aboutVersionEl.textContent = `v${info.appVersion}`;
  aboutMetaEl.innerHTML = "";
  const rows = [
    ["Electron", info.electronVersion],
    ["Node.js", info.nodeVersion],
    ["Platform", info.platform],
  ];
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "about-meta-row";
    const left = document.createElement("span");
    left.textContent = k;
    const right = document.createElement("span");
    right.textContent = v;
    row.appendChild(left);
    row.appendChild(right);
    aboutMetaEl.appendChild(row);
  }
  aboutDialog.hidden = false;
  aboutCloseBtn.focus();
}

aboutCloseBtn.addEventListener("click", hideAboutDialog);
$("about-reload")?.addEventListener("click", () => {
  hideAboutDialog();
  reloadRenderer();
});
$("about-devtools")?.addEventListener("click", () => {
  hideAboutDialog();
  kpdf3.toggleDevTools?.();
});
aboutDialog.addEventListener("click", (e) => {
  if (e.target === aboutDialog) hideAboutDialog();
});

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
    tools: $("menu-tools"),
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
    "zoom-fit-page": actionZoomFitPage,
    "page-prev": actionPagePrev,
    "page-next": actionPageNext,
    "page-goto": actionPageGoto,
    "toggle-bookmarks": actionToggleBookmarks,
    "mode-text": () =>
      setPlacementMode(placementMode === "text" ? "none" : "text"),
    "mode-stamp": () =>
      setPlacementMode(placementMode === "stamp" ? "none" : "stamp"),
    "mode-redaction": () =>
      setPlacementMode(placementMode === "redaction" ? "none" : "redaction"),
    "mode-marker": () =>
      setPlacementMode(placementMode === "marker" ? "none" : "marker"),
    "mode-callout": () =>
      setPlacementMode(placementMode === "callout" ? "none" : "callout"),
    "stamp-manager": () => openStampManagerDialog(),
    "font-settings": () => openStampFontDialog(),
    "quality-standard": () => setRenderQuality("standard"),
    "quality-high": () => setRenderQuality("high"),
    "quality-max": () => setRenderQuality("max"),
  },
});

// ---- Render quality (oversample level) -------------------------------
const RENDER_QUALITY_KEY = "kpdf3.renderQuality";

function setRenderQuality(level) {
  viewer.setRenderQuality(level);
  localStorage.setItem(RENDER_QUALITY_KEY, level);
  refreshMenuState();
  wsStatus.textContent = `表示解像度: ${
    { standard: "標準", high: "高", max: "最高" }[level] ?? level
  }`;
}

// Apply persisted level on startup.
{
  const stored = localStorage.getItem(RENDER_QUALITY_KEY);
  if (stored && stored !== "high") {
    viewer.setRenderQuality(stored);
  }
}

// ---- Keyboard shortcuts ----------------------------------------------
// M3-3 will need to skip these when an editable text overlay has focus
// (let the contentEditable / textarea handle its own undo).
// Dev / browser-level shortcuts. These fire BEFORE the main app-level
// keydown handler so they work even when no PDF is open. With
// frame:false + a custom menu, Electron loses its default Reload /
// DevTools accelerators, so we wire them here.
//
// `capture: true` registers the listener in the capture phase so it
// fires before any descendant keydown handler that might stopPropagation
// (e.g. dialog inputs swallowing keys).
window.addEventListener(
  "keydown",
  (e) => {
    const target = e.target;
    const inText =
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA");
    // Diagnostic — show the key in the status bar briefly so the user
    // can verify keydown events are even arriving in the renderer.
    if (e.key === "F5" || e.key === "F12" ||
        ((e.ctrlKey || e.metaKey) && /^[a-zA-Z]$/.test(e.key))) {
      console.log("[shortcut] keydown:", {
        key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey,
        target: target?.tagName,
      });
    }
    // F5 / Ctrl+R / Ctrl+Shift+R → reload the renderer.
    if (
      e.key === "F5" ||
      ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")
    ) {
      if (inText) return; // don't hijack reload if user is typing
      e.preventDefault();
      e.stopPropagation();
      reloadRenderer();
      return;
    }
    // F12 → toggle DevTools (main process gets the request via IPC).
    if (e.key === "F12") {
      e.preventDefault();
      e.stopPropagation();
      kpdf3.toggleDevTools?.();
      return;
    }
  },
  true,
);

window.addEventListener("keydown", (e) => {
  if (!isOpen) return;
  const target = e.target;
  const inText =
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA");

  // Delete key on a selected overlay (text / stamp / redaction /
  // marker / callout) → remove it. Skipped while typing in any
  // input — Delete there should fall through to native behaviour.
  if ((e.key === "Delete" || e.key === "Backspace") && selectedOverlayId && !inText) {
    e.preventDefault();
    const id = selectedOverlayId;
    setSelectedOverlay(null);
    history.execute(new RemoveOverlayCommand(projectStore, id));
    return;
  }

  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (!ctrlOrCmd) return;
  const key = e.key.toLowerCase();

  if (key === "s" && !e.shiftKey) {
    // Ctrl+S works even inside text edit — commit the edit first via blur,
    // then save.
    e.preventDefault();
    if (inText && target instanceof HTMLElement) target.blur();
    setTimeout(() => actionSave(), 0);
    return;
  } else if (key === "s" && e.shiftKey) {
    // Ctrl+Shift+S = 名前を付けて保存 (formerly export, Ctrl+E)
    e.preventDefault();
    if (inText && target instanceof HTMLElement) target.blur();
    setTimeout(() => actionExport(), 0);
    return;
  } else if (key === "f") {
    // Ctrl+F → reveal + focus the search box (collapsed by default)
    e.preventDefault();
    if (!menuSearchInput.disabled) openSearchBox();
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

// ---- Search box (menu bar) -------------------------------------------
const menuSearchInput = $("menu-search-input");
const menuSearchBtn = $("menu-search-btn");

const searchState = {
  lastQuery: "",
  pages: [],          // [{ pageNo, count }]
  cursorIdx: -1,      // -1 = no result yet, else index into pages[]
};

async function runSearch() {
  const q = menuSearchInput.value.trim();
  if (!q) {
    searchState.lastQuery = "";
    searchState.pages = [];
    searchState.cursorIdx = -1;
    wsStatus.textContent = "検索語を入力してください";
    return;
  }
  if (!isOpen) {
    wsStatus.textContent = "PDF を開いてから検索してください";
    return;
  }
  // Same query as last time → advance to next match
  if (q === searchState.lastQuery && searchState.pages.length > 0) {
    const pageCount = searchState.pages.length;
    if (pageCount === 0) return;
    searchState.cursorIdx = (searchState.cursorIdx + 1) % pageCount;
    const target = searchState.pages[searchState.cursorIdx];
    viewer.scrollToPage(target.pageNo);
    wsStatus.textContent = `${searchState.cursorIdx + 1} / ${pageCount} 件 (p.${target.pageNo}, ${target.count} 一致)`;
    return;
  }
  // New query
  wsStatus.textContent = "検索中...";
  try {
    const result = await kpdf3.searchPdf(q);
    searchState.lastQuery = q;
    searchState.pages = result.pages ?? [];
    searchState.cursorIdx = -1;
    if (searchState.pages.length === 0) {
      wsStatus.textContent = `「${q}」: 一致なし`;
      return;
    }
    searchState.cursorIdx = 0;
    const first = searchState.pages[0];
    viewer.scrollToPage(first.pageNo);
    wsStatus.textContent = `「${q}」: ${result.totalMatches} 件、${searchState.pages.length} ページにヒット (1 件目: p.${first.pageNo})`;
  } catch (err) {
    console.error("[search] failed", err);
    wsStatus.textContent = `検索失敗: ${err.message ?? err}`;
  }
}

/** Reveal the search input next to the magnifier button and focus it.
 *  Idempotent — calling twice while already open just re-focuses. */
function openSearchBox() {
  const wrap = menuSearchBtn.closest(".toolbar-search");
  if (wrap) wrap.classList.add("is-open");
  menuSearchInput.focus();
  menuSearchInput.select();
}
function closeSearchBox() {
  const wrap = menuSearchBtn.closest(".toolbar-search");
  if (wrap) wrap.classList.remove("is-open");
}

menuSearchBtn.addEventListener("click", () => {
  // Closed → open + focus. Open with text → run search. Open with
  // empty box → close again (toggle behaviour).
  const wrap = menuSearchBtn.closest(".toolbar-search");
  if (!wrap?.classList.contains("is-open")) {
    openSearchBox();
    return;
  }
  if (menuSearchInput.value.trim() === "") {
    closeSearchBox();
    return;
  }
  runSearch();
});
menuSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runSearch();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearchBox();
  }
});

// Enable / disable with PDF open state
function refreshSearchEnabled() {
  menuSearchInput.disabled = !isOpen;
  menuSearchBtn.disabled = !isOpen;
  if (!isOpen) closeSearchBox();
}

// ---- Sidebar splitter (drag to resize) -------------------------------
const sidebarSplitter = $("sidebar-splitter");
const SIDEBAR_WIDTH_KEY = "kpdf3.sidebarWidth";
const SIDEBAR_MIN = 140;
const SIDEBAR_MAX = 600;

(function initSidebarWidth() {
  const stored = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? "", 10);
  if (Number.isFinite(stored) && stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX) {
    sidebar.style.flexBasis = `${stored}px`;
  }
})();

let splitterDragStartX = 0;
let splitterDragStartW = 0;
sidebarSplitter.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  sidebarSplitter.setPointerCapture(e.pointerId);
  sidebarSplitter.classList.add("is-dragging");
  splitterDragStartX = e.clientX;
  splitterDragStartW = sidebar.getBoundingClientRect().width;
});
sidebarSplitter.addEventListener("pointermove", (e) => {
  if (!sidebarSplitter.hasPointerCapture(e.pointerId)) return;
  const dx = e.clientX - splitterDragStartX;
  const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, splitterDragStartW + dx));
  sidebar.style.flexBasis = `${w}px`;
});
sidebarSplitter.addEventListener("pointerup", (e) => {
  if (sidebarSplitter.hasPointerCapture(e.pointerId)) {
    sidebarSplitter.releasePointerCapture(e.pointerId);
  }
  sidebarSplitter.classList.remove("is-dragging");
  const w = sidebar.getBoundingClientRect().width;
  if (Number.isFinite(w) && w > 0) {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(w)));
  }
});

// ---- Status bar hover hints (Win9x convention) -----------------------
// While the cursor is over a labelled UI element, the bottom-left status
// field shows a one-liner about that element. Restored on mouseleave.
const STATUS_HINTS = {
  "btn-open": "PDF ファイルを開きます (Ctrl+O 同等)",
  "btn-save": "現在の状態を上書き保存します (Ctrl+S)",
  "btn-export": "名前を付けて保存します (Ctrl+Shift+S)",
  "btn-print": "印刷します (Ctrl+P)",
  "btn-mode-text": "テキストを配置するモードに切り替えます",
  "btn-mode-stamp": "印影を配置するモードに切り替えます",
  "btn-mode-redaction": "墨消し範囲を配置するモードに切り替えます",
  "btn-mode-marker": "ドラッグで横方向の半透明マーカーを引きます",
  "btn-mode-callout": "ドラッグで吹き出し（矢印付きテキストボックス）を配置します",
  "btn-split": "PDF をパートごとに分割保存します",
  "btn-rotate-left": "現在のページを左に 90° 回転します",
  "btn-rotate-right": "現在のページを右に 90° 回転します",
  "zoom-select": "表示倍率を選びます",
  "win-minimize": "ウィンドウを最小化します",
  "win-maximize": "ウィンドウを最大化／復元します",
  "win-close": "ウィンドウを閉じます",
  "sidebar-toggle": "しおり／サムネイルパネルを開閉します (F4)",
};
const MENU_HINTS = {
  open: "PDF ファイルを開きます",
  recent: "最近開いた PDF の一覧から選びます",
  close: "現在の PDF を閉じます (アプリは開いたまま)",
  save: "現在の状態を上書き保存します (Ctrl+S)",
  export: "PDF を選んだ場所に保存します (Ctrl+Shift+S)",
  "export-range": "ページ範囲を指定して PDF を書き出します",
  "split-save": "PDF を複数のパートに分割保存します",
  print: "PDF を印刷します (Ctrl+P)",
  exit: "アプリを終了します",
  undo: "直前の編集を取り消します (Ctrl+Z)",
  redo: "取り消した編集をやり直します (Ctrl+Y)",
  "zoom-in": "表示を拡大します (Ctrl++)",
  "zoom-out": "表示を縮小します (Ctrl+-)",
  "zoom-fit": "ページがウィンドウに収まる倍率にします",
  "zoom-fit-page": "1 ページ全体がウィンドウに収まる倍率にします",
  "zoom-100": "表示を 100% に戻します (Ctrl+0)",
  "page-prev": "前のページへ移動します (PageUp)",
  "page-next": "次のページへ移動します (PageDown)",
  "page-goto": "ページ番号を指定して移動します (Ctrl+G)",
  "toggle-bookmarks": "しおり／サムネイルパネルを開閉します (F4)",
  "mode-text": "テキスト配置モードに切替",
  "mode-stamp": "印影配置モードに切替",
  "mode-redaction": "墨消し配置モードに切替",
  "mode-marker": "マーカー配置モード — 将来対応",
  "quality-standard": "PDF 表示解像度: 標準 (軽量)",
  "quality-high": "PDF 表示解像度: 高 (推奨)",
  "quality-max": "PDF 表示解像度: 最高 (重め)",
  "stamp-manager": "印影テンプレート（toolbar select）— フル UI は M6 後半",
  "font-settings": "スタンプの全角・半角フォント既定を設定",
  about: "K-PDF3 のバージョン情報",
};
const DEFAULT_STATUS = "PDF を「開く」で読み込みます";
let statusHintActive = false;
let statusBeforeHint = "";

function showStatusHint(text) {
  if (!statusHintActive) statusBeforeHint = wsStatus.textContent;
  statusHintActive = true;
  wsStatus.textContent = text;
}
function clearStatusHint() {
  if (!statusHintActive) return;
  statusHintActive = false;
  wsStatus.textContent = statusBeforeHint;
}

for (const [id, text] of Object.entries(STATUS_HINTS)) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener("mouseenter", () => showStatusHint(text));
  el.addEventListener("mouseleave", clearStatusHint);
}
for (const dropdownId of ["menu-file", "menu-edit", "menu-view", "menu-tools", "menu-help"]) {
  const dd = document.getElementById(dropdownId);
  if (!dd) continue;
  for (const item of dd.querySelectorAll(".menu-item[data-action]")) {
    const action = item.dataset.action;
    const text = MENU_HINTS[action];
    if (!text) continue;
    item.addEventListener("mouseenter", () => showStatusHint(text));
    item.addEventListener("mouseleave", clearStatusHint);
  }
}

// Drag-and-drop to open: dropping a `.pdf` anywhere on the window opens it.
// preventDefault on dragover is needed for the drop event to fire.
document.addEventListener("dragover", (e) => {
  e.preventDefault();
});
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  const file = files[0];
  // Electron 32+ removed File.path on the renderer side; resolve the
  // backing OS path via the preload helper instead.
  const path = kpdf3.getPathForFile?.(file) || file.path || "";
  if (!path) {
    wsStatus.textContent = "ドロップされたファイルのパスを取得できませんでした";
    return;
  }
  if (!/\.pdf$/i.test(path)) {
    wsStatus.textContent = "PDF ファイルを指定してください";
    return;
  }
  // No dirty check — drop opens in a fresh tab when the active one is
  // already busy, mirroring the toolbar 開く button.
  await openPdfSmart(path);
});

// Ctrl + mouse wheel zooms the viewer (Adobe / browser convention).
// passive:false so we can preventDefault and stop the page from scrolling
// while the user holds Ctrl.
viewerContainer.addEventListener(
  "wheel",
  (e) => {
    if (!isOpen) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (e.deltaY < 0) actionZoomIn();
    else if (e.deltaY > 0) actionZoomOut();
  },
  { passive: false },
);

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
// Skipped during an explicit `reloadRenderer()` so the dirty-check doesn't
// silently swallow F5 / Ctrl+R / About → リロード button — the dialog is
// shown there manually instead.
let _reloadingRenderer = false;
// Cached at boot via getAppInfo() — distinguishes packaged builds
// from dev (electronmon) so the beforeunload dirty-check doesn't
// block hot-reload during development.
let _isDevMode = false;
kpdf3.getAppInfo?.().then((info) => { _isDevMode = !info?.isPackaged; }).catch(() => {});

window.addEventListener("beforeunload", (e) => {
  if (_reloadingRenderer) return;
  // In dev (electronmon), let renderer file-change reloads sail
  // through. Otherwise the unsaved-tab guard below would silently
  // block every hot-reload after the user starts editing.
  if (_isDevMode) return;
  // Block window close if any tab has unsaved changes — including
  // inactive ones whose dirty state lives only in their TabState.
  saveActiveTabSnapshot();
  for (const [, tab] of tabs) {
    if (tabIsDirty(tab)) {
      e.preventDefault();
      e.returnValue = "";
      return;
    }
  }
});

/**
 * Reload the renderer with a dirty-check first. The default
 * beforeunload prevention silently kills location.reload() in
 * Electron (no native dialog with frame:false), so an explicit
 * customConfirm replaces it. After confirmation, _reloadingRenderer
 * is flipped so the beforeunload listener no-ops on the way out.
 */
async function reloadRenderer() {
  if (projectStore.isDirty()) {
    const ok = await customConfirm({
      title: "未保存の変更",
      message: "未保存の変更があります。\n破棄してリロードしますか？",
      okLabel: "破棄してリロード",
    });
    if (!ok) return;
  }
  _reloadingRenderer = true;
  location.reload();
}

// main process kicks reloads via this IPC (globalShortcut handler) so
// they go through the same dirty-check + beforeunload-bypass path.
kpdf3.onReloadRequest?.(() => reloadRenderer());

// ---- Tab bar (ADR-0015 Phase 3) --------------------------------------
$("tab-add")?.addEventListener("click", () => {
  void newTabAndOpen(null);
});
// Ctrl+T = new tab + open. Ctrl+W = close the active tab.
window.addEventListener("keydown", (e) => {
  // Skip when typing into an input/textarea/contenteditable.
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === "t") {
    e.preventDefault();
    void newTabAndOpen(null);
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === "w") {
    e.preventDefault();
    if (activeTabId) void closeTabWithConfirm(activeTabId);
  }
});
// Render the initial bar so the boot tab shows up before the user
// opens anything.
renderTabBar();

// ---- Toolbar buttons --------------------------------------------------
btnOpen.addEventListener("click", actionOpen);
btnSave.addEventListener("click", actionSave);
btnExport.addEventListener("click", actionExport);
btnPrint.addEventListener("click", actionPrint);
btnModeText.addEventListener("click", () =>
  setPlacementMode(placementMode === "text" ? "none" : "text"),
);
btnModeStamp.addEventListener("click", () =>
  setPlacementMode(placementMode === "stamp" ? "none" : "stamp"),
);
btnModeRedaction.addEventListener("click", () =>
  setPlacementMode(placementMode === "redaction" ? "none" : "redaction"),
);
if (btnModeMarker) {
  btnModeMarker.addEventListener("click", () =>
    setPlacementMode(placementMode === "marker" ? "none" : "marker"),
  );
}
if (btnModeCallout) {
  btnModeCallout.addEventListener("click", () =>
    setPlacementMode(placementMode === "callout" ? "none" : "callout"),
  );
}

// Stamp template / color: picking either auto-switches into stamp mode
// so the user lands directly in "place this stamp" (mirrors the
// redaction-color UX). Persisted to localStorage.
// Mode-options bar's "スタンプ管理…" button → opens the manager dialog.
$("stamp-mgr-open")?.addEventListener("click", () => openStampManagerDialog());
$("stamp-palette-mgr")?.addEventListener("click", () => openStampManagerDialog());
$("stamp-palette-close")?.addEventListener("click", () => {
  // Exit stamp mode entirely — popup hides via syncStampPalettePopup.
  if (placementMode === "stamp") setPlacementMode("none");
});

// Drag the stamp palette popup by its titlebar.
{
  const popup = $("stamp-palette-popup");
  const titleBar = $("stamp-palette-titlebar");
  if (popup && titleBar) {
    let drag = null;
    titleBar.addEventListener("pointerdown", (e) => {
      // Don't drag from the close button.
      if (e.target instanceof HTMLElement && e.target.id === "stamp-palette-close") return;
      const rect = popup.getBoundingClientRect();
      drag = {
        pointerId: e.pointerId,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
      };
      try { titleBar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    titleBar.addEventListener("pointermove", (e) => {
      if (!drag || drag.pointerId !== e.pointerId) return;
      const x = e.clientX - drag.offsetX;
      const y = e.clientY - drag.offsetY;
      // Clamp to viewport.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = popup.offsetWidth;
      const h = popup.offsetHeight;
      popup.style.left = `${Math.max(0, Math.min(vw - w, x))}px`;
      popup.style.top = `${Math.max(0, Math.min(vh - h, y))}px`;
      popup.style.right = "auto";
    });
    titleBar.addEventListener("pointerup", (e) => {
      if (!drag || drag.pointerId !== e.pointerId) return;
      try { titleBar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      drag = null;
    });
  }
}

btnRotateLeft.addEventListener("click", actionRotateLeft);
btnRotateRight.addEventListener("click", actionRotateRight);

// Restore last-used redaction color (§17.13). The select also auto-
// switches the redaction mode on so a single click on the color drops
// the user into "place a white redaction" without a second toolbar trip.
if (redactionColorSel) {
  const saved = localStorage.getItem(REDACTION_COLOR_STORAGE_KEY);
  if (saved === "white" || saved === "black") redactionColorSel.value = saved;
  redactionColorSel.addEventListener("change", () => {
    localStorage.setItem(REDACTION_COLOR_STORAGE_KEY, currentRedactionColor());
    if (isOpen && placementMode !== "redaction") setPlacementMode("redaction");
  });
}

// ---- Text font / size selects (§17.9, §17.12) -----------------------
// Drives placement defaults; if a text overlay is currently being
// inline-edited we also push the change onto that overlay so the user
// can adjust live.
const TEXT_FONT_STORAGE_KEY = "kpdf3.textFontId";
const TEXT_SIZE_STORAGE_KEY = "kpdf3.textFontSize";

function applyFontSizeToEditingOverlay() {
  const id = viewer._editingId;
  if (!id) return;
  const ov = projectStore.get(id);
  if (!ov || ov.type !== "text") return;
  const fontId = currentTextFontId();
  const fontSize = currentTextFontSize();
  projectStore.update(id, {
    properties: { ...ov.properties, fontId, fontSize },
  });
  // Keep the inline-edit element visually in sync (the store update
  // alone doesn't repaint the editing element — see viewer's preserve-
  // editing logic).
  viewer.applyEditingTextStyle({ fontId, fontSize });
}

if (textFontSel) {
  const saved = localStorage.getItem(TEXT_FONT_STORAGE_KEY);
  if (saved && saved !== "default") textFontSel.value = saved;
  textFontSel.addEventListener("change", () => {
    localStorage.setItem(TEXT_FONT_STORAGE_KEY, currentTextFontId());
    if (isOpen && placementMode !== "text" && !viewer._editingId) {
      setPlacementMode("text");
    }
    applyFontSizeToEditingOverlay();
  });
}
if (textSizeSel) {
  const saved = localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
  if (saved) textSizeSel.value = saved;
  textSizeSel.addEventListener("change", () => {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, String(currentTextFontSize()));
    if (isOpen && placementMode !== "text" && !viewer._editingId) {
      setPlacementMode("text");
    }
    applyFontSizeToEditingOverlay();
  });
}

if (markerColorSel) {
  const saved = localStorage.getItem(MARKER_COLOR_STORAGE_KEY);
  if (saved) {
    // Only restore if the saved color is still one of the offered options.
    const found = Array.from(markerColorSel.options).some((o) => o.value === saved);
    if (found) markerColorSel.value = saved;
  }
  markerColorSel.addEventListener("change", () => {
    localStorage.setItem(MARKER_COLOR_STORAGE_KEY, currentMarkerColor());
    if (isOpen && placementMode !== "marker") setPlacementMode("marker");
  });
}

// ---- Initial state ----------------------------------------------------
setOpen(false);

(async () => {
  const info = await kpdf3.getAppInfo();
  $("appinfo").textContent = `v${info.appVersion} / Electron ${info.electronVersion}`;
})();
