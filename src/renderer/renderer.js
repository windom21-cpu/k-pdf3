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
  CompositeCommand,
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
} from "./fonts.js";
import { showBusy, updateBusy, hideBusy } from "./busy-modal.js";
import { customConfirm } from "./dialogs.js";
import { showFileBrowser } from "./file-browser.js";
import {
  initOverlayEdit,
  handleTextEditCommit,
  handleOverlayDragEnd,
  handleOverlayResizeEnd,
  handleCalloutArrowEnd,
  measureTextOverlaySize,
  measureCalloutSize,
  measureCalloutWrappedHeight,
} from "./overlay-edit.js";
import {
  initOverlaySelection,
  handleOverlayClick,
  selectOverlay,
  setSelectedOverlay,
  clearSelection,
  reapplySelectionDom,
  syncPrimaryFromSet,
  syncAlignToolbar,
  alignSelectedOverlays,
  isSelected,
  hasSelection,
  getSelectionSize,
  getSelectedIds,
  getPrimarySelectedId,
  removeFromSelection,
  clearSelectionState,
} from "./overlay-selection.js";
import {
  initOverlayPlacement,
  startRedactionDrag,
  startMarkerDrag,
  startCalloutDrag,
  placeRedaction,
  placeMarker,
  placeCallout,
  placeText,
  currentRedactionColor,
  currentMarkerColor,
  currentTextFontId,
  currentTextFontSize,
  currentTextColor,
  currentTextDigitsHanko,
  currentTextBold,
  REDACTION_COLOR_STORAGE_KEY,
  MARKER_COLOR_STORAGE_KEY,
} from "./overlay-placement.js";
import {
  initStampPresets,
  setActiveStampPreset,
  hasActiveStampPreset,
  placeStamp,
  refreshStampPresetCacheAndSelect,
  syncStampPalettePopup,
  syncStampGhostMode,
} from "./stamp-presets.js";
import {
  initStampDialogs,
  openStampManagerDialog,
  openStampFontDialog,
  placeStampTrial,
  clearStampTrial,
  reattachStampTrial,
  isStampTrialPlacing,
} from "./stamp-dialogs.js";

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
const textColorSel = $("text-color");
const textDigitsHankoChk = $("text-digits-hanko");
const textBoldChk = $("text-bold");
const btnModeMarker = $("btn-mode-marker");
const markerColorSel = $("marker-color");
const btnModeCallout = $("btn-mode-callout");
const wsStatus = $("ws-status");
const viewerContainer = $("viewer-container");
const sidebar = $("sidebar");
const bookmarkTree = $("bookmark-tree");
const thumbList = $("thumb-list");
const mainArea = $("main-area");
const splitView = $("split-view");
const btnSplit = $("btn-split");
const btnRotateLeft = $("btn-rotate-left");
const btnRotateRight = $("btn-rotate-right");
const viewer = new Viewer(viewerContainer, {
  projectStore,
  onPagePointerDown: handlePagePointerDown,
  onOverlayClick: handleOverlayClick,
  onTextEditCommit: handleTextEditCommit,
  onOverlayDragEnd: handleOverlayDragEnd,
  onOverlayResizeEnd: handleOverlayResizeEnd,
  onCalloutArrowEnd: handleCalloutArrowEnd,
  onOverlayContextMenu: showOverlayContextMenu,
  onPageChange: updatePageIndicator,
});

const pagePrevBtn = $("page-prev-btn");
const pageNextBtn = $("page-next-btn");
const pageNumInput = $("page-num-input");
const pageNumTotal = $("page-num-total");

function updatePageIndicator(current, total) {
  if (!total || total === 0) {
    if (pageNumInput) {
      pageNumInput.value = "";
      pageNumInput.disabled = true;
    }
    if (pageNumTotal) pageNumTotal.textContent = "0";
    if (pagePrevBtn) pagePrevBtn.disabled = true;
    if (pageNextBtn) pageNextBtn.disabled = true;
    return;
  }
  // `current` is the active pageNo (negative for inserted pages,
  // possibly non-sequential after reorder), so it can't be shown
  // verbatim — the user expects 1-indexed visual positions. Look up
  // the position via the registry; fall back to the raw value if
  // the registry isn't available yet.
  let displayPos = current;
  let pos = -1;
  if (viewer.registry && typeof viewer.registry.posOfPageNo === "function") {
    pos = viewer.registry.posOfPageNo(current);
    if (pos >= 0) displayPos = pos + 1;
  }
  if (pageNumInput) {
    // Don't clobber the user mid-edit — only refresh the field's
    // value when it isn't focused. Their entered value lives until
    // they press Enter / blur (handled in the input listeners).
    if (document.activeElement !== pageNumInput) {
      pageNumInput.value = String(displayPos);
    }
    pageNumInput.max = String(total);
    pageNumInput.disabled = false;
  }
  if (pageNumTotal) pageNumTotal.textContent = String(total);
  if (pagePrevBtn) pagePrevBtn.disabled = pos <= 0;
  if (pageNextBtn) pageNextBtn.disabled = pos < 0 || pos >= total - 1;
}

let isOpen = false;
/** @type {'none' | 'text' | 'stamp' | 'redaction'} */
let placementMode = "none";
let activeSourceName = "";

// Wire the overlay-edit / overlay-selection modules up to renderer.js
// state once all the scratch-slot lets above are declared. Getters keep
// the bindings live across applyTab() (projectStore / history get
// rebound per tab).
initOverlayEdit({
  isOpen: () => isOpen,
  projectStore: () => projectStore,
  history: () => history,
  viewer,
});
initOverlaySelection({
  isOpen: () => isOpen,
  projectStore: () => projectStore,
  history: () => history,
  viewer,
  wsStatus,
});
initOverlayPlacement({
  projectStore: () => projectStore,
  history: () => history,
  viewer,
  setPlacementMode: (mode) => setPlacementMode(mode),
});
initStampPresets({
  projectStore: () => projectStore,
  history: () => history,
  viewer,
  viewerContainer,
  wsStatus,
  isOpen: () => isOpen,
  placementMode: () => placementMode,
  setPlacementMode: (mode) => setPlacementMode(mode),
  isStampTrialPlacing: () => isStampTrialPlacing(),
});
initStampDialogs({
  viewer,
  viewerContainer,
  wsStatus,
  isOpen: () => isOpen,
  setPlacementMode: (mode) => setPlacementMode(mode),
});

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
  // Re-subscribe dirty/menu listeners onto the new tab's store + history.
  attachStoreSubscribers();
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
    // Restore scroll after layout settles. scrollLeft is reset to 0 —
    // fit-width / fit-page centre the inner via `margin: 0 auto`, so a
    // non-zero scrollLeft from the previous tab (e.g. transient overflow
    // during page rebuild) would offset the content to the right and
    // leave gray padding on the left after re-fit.
    requestAnimationFrame(() => {
      viewerContainer.scrollTop = tab.scrollPosition || 0;
      viewerContainer.scrollLeft = 0;
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
  attachStoreSubscribers();
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
      attachStoreSubscribers();
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
  // Right-click / middle-click should never drop a placement. Without
  // this guard the contextmenu handler that pops the mode-toggle menu
  // would also fire placeText / placeStamp / etc. on the same point.
  if (evt && typeof evt.button === "number" && evt.button !== 0) return;
  // Trial-stamp placement (§17.5) is its own dispatch — it runs while
  // the register dialog is hidden, with placementMode possibly === "none",
  // so it must be checked BEFORE the placementMode branches.
  if (isStampTrialPlacing()) {
    placeStampTrial(pageNo, x, y, div);
    return;
  }
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
        digitsHanko: currentTextDigitsHanko(),
        bold: currentTextBold(),
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
  } else if (action === "copy") {
    const ov = projectStore.get(id);
    if (ov) {
      _overlayClipboard = { ...ov, properties: { ...(ov.properties ?? {}) } };
      wsStatus.textContent = `${ov.type} をコピーしました`;
    }
  } else if (action === "paste") {
    pasteOverlayFromClipboard();
  }
}

/** Build and add a new overlay from `_overlayClipboard` onto the
 *  currently-visible page, offset slightly from the original position.
 *  Shared by Ctrl+V and the right-click「貼り付け」menu item. */
function pasteOverlayFromClipboard() {
  if (!_overlayClipboard) {
    wsStatus.textContent = "貼り付けるものがありません";
    return;
  }
  const src = _overlayClipboard;
  const pageNo = viewer.currentPage || src.pageNo || 1;
  const dx = 12;
  const dy = 12;
  const cmd = new AddOverlayCommand(projectStore, {
    pageNo,
    type: src.type,
    x: (src.x ?? 0) + dx,
    y: (src.y ?? 0) + dy,
    w: src.w,
    h: src.h,
    zOrder: src.zOrder ?? 0,
    properties: { ...(src.properties ?? {}) },
    assetId: src.assetId ?? null,
  });
  history.execute(cmd);
  if (cmd._snapshot) setSelectedOverlay(cmd._snapshot.id);
  wsStatus.textContent = `${src.type} を貼り付けました`;
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

// Click on empty page / viewer background → drop overlay selection so the
// dotted is-selected outline disappears. β3 testers asked for this after
// noticing that the paste outline lingered until the user did Esc or
// clicked another overlay. Only left clicks count, and we skip when the
// pointer landed inside an overlay (so the click that selects an overlay
// isn't followed by an immediate deselect via this listener).
viewerContainer.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0) return;
  if (viewer._editingId) return;
  if (!getPrimarySelectedId()) return;
  if (ev.target instanceof HTMLElement && ev.target.closest(".overlay")) return;
  setSelectedOverlay(null);
});

// ---- Page context menu (placement mode toggle) ------------------------
// β15 testers asked for a way to chain text/stamp/marker insertions
// without going back to the toolbar each time. Right-click on the page
// background (not on an existing overlay) opens a menu that toggles
// placement mode. Clicking the active mode again exits to "none".
const ctxPage = $("ctx-page");
function showPageContextMenu(x, y) {
  if (!ctxPage) return;
  // Mark the currently-active mode with the existing ".checked" style
  // (✓ left of the item) so the user can see what's on.
  for (const item of ctxPage.querySelectorAll(".menu-item")) {
    const mode = item.dataset.ctx;
    const isActive =
      (mode === "none" && placementMode === "none") ||
      (mode !== "none" && mode === placementMode);
    item.classList.toggle("checked", isActive);
  }
  ctxPage.style.left = `${x}px`;
  ctxPage.style.top = `${y}px`;
  ctxPage.hidden = false;
}
function hidePageContextMenu() {
  if (!ctxPage) return;
  ctxPage.hidden = true;
}
function dispatchPageCtx(target) {
  hidePageContextMenu();
  if (!(target instanceof HTMLElement)) return;
  const mode = target.dataset.ctx;
  if (!mode) return;
  if (mode === "none") {
    setPlacementMode("none");
  } else if (placementMode === mode) {
    setPlacementMode("none");
  } else {
    setPlacementMode(mode);
  }
}
viewerContainer.addEventListener("contextmenu", (e) => {
  if (!isOpen) return;
  // Let overlay's own contextmenu (which stops propagation) handle
  // right-clicks landing inside an overlay. Only act on the page
  // background itself.
  if (e.target instanceof HTMLElement && e.target.closest(".overlay")) return;
  if (e.target instanceof HTMLElement && !e.target.closest(".viewer-page")) return;
  e.preventDefault();
  showPageContextMenu(e.clientX, e.clientY);
});
ctxPage?.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  let el = e.target;
  while (el && el !== ctxPage && !(el.dataset && el.dataset.ctx)) {
    el = el.parentElement;
  }
  if (el && el !== ctxPage) dispatchPageCtx(el);
});
ctxPage?.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("pointerdown", (ev) => {
  if (!ctxPage || ctxPage.hidden) return;
  if (ev.target instanceof Node && ctxPage.contains(ev.target)) return;
  hidePageContextMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hidePageContextMenu();
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
    if (getPrimarySelectedId()) {
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
  // Reflect multi-selection in the「保存」/「削除」menu items so the
  // user can tell (before clicking) whether the action will hit just
  // the clicked page or the whole sidebar multi-selection. Mirrors the
  // dispatch logic in dispatchThumbCtx.
  const sel = sidebarThumbSelection.pageNos;
  const useMulti = sel.size > 1 && sel.has(pageNo);
  const saveItem = ctxThumb.querySelector('[data-ctx="save-page"]');
  if (saveItem) {
    saveItem.textContent = useMulti
      ? `選択した ${sel.size} ページを PDF として保存…`
      : "このページを PDF として保存…";
  }
  const deleteItem = ctxThumb.querySelector('[data-ctx="delete-page"]');
  if (deleteItem) {
    deleteItem.textContent = useMulti
      ? `選択した ${sel.size} ページを削除`
      : "このページを削除";
  }
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
  else if (action === "save-page") {
    // β3 testers reported that multi-selecting in the sidebar and then
    // right-clicking → 保存 saved only the right-clicked page, dropping
    // the rest of their selection on the floor. If the clicked page is
    // part of the active multi-selection, save the whole set as one PDF;
    // otherwise fall back to the single-page path.
    const sel = sidebarThumbSelection.pageNos;
    if (sel.size > 1 && sel.has(pageNo)) {
      actionSavePagesAsPdf([...sel]);
    } else {
      actionSavePagesAsPdf([pageNo]);
    }
  } else if (action === "delete-page") {
    // Same multi-select semantics as save-page: if the right-clicked
    // page is part of the active multi-selection, delete the whole
    // set; otherwise delete just the clicked page. Mirrors the Del
    // shortcut path (deleteSelectedPages) so confirmation dialog +
    // pending/synthetic split logic stays unified.
    const sel = sidebarThumbSelection.pageNos;
    const useMulti = sel.size > 1 && sel.has(pageNo);
    if (useMulti) {
      deleteSelectedPages();
    } else {
      const oneShot = { pageNos: new Set([pageNo]), anchor: null };
      deleteSelectedPages(oneShot);
    }
  }
}

/** Extract one or more pages (with overlays + rotation) to a new PDF.
 *  Ordered by visible page position, not by the selection insertion
 *  order, so the saved PDF reads in the same sequence as the sidebar.
 */
async function actionSavePagesAsPdf(pageNos) {
  if (!isOpen || !Array.isArray(pageNos) || pageNos.length === 0) return;
  const all = viewer._pages ?? [];
  const orderIndex = new Map(all.map((p, i) => [p.pageNo, i]));
  const set = new Set(pageNos);
  const rows = all.filter((p) => set.has(p.pageNo));
  if (rows.length === 0) return;
  rows.sort((a, b) => (orderIndex.get(a.pageNo) ?? 0) - (orderIndex.get(b.pageNo) ?? 0));
  const defaults = await kpdf3.getExportDefaults();
  const baseName = (defaults.defaultName || "page").replace(/\.[^.]+$/, "");
  let tag;
  if (rows.length === 1) {
    const n = rows[0].pageNo;
    tag = n > 0 ? `p${n}` : `inserted${-n}`;
  } else {
    // Look for a contiguous range to spell out (p3-5) and fall back to
    // a count-tagged name (3pages) when the user picked a non-contiguous
    // set across the document.
    const sourceNos = rows.map((r) => r.pageNo).filter((n) => n > 0);
    const contiguous =
      sourceNos.length === rows.length
      && sourceNos.every((n, i, arr) => i === 0 || n === arr[i - 1] + 1);
    tag = contiguous
      ? `p${sourceNos[0]}-${sourceNos[sourceNos.length - 1]}`
      : `${rows.length}pages`;
  }
  const initialName = `${baseName}_${tag}.pdf`;
  const savePath = await showFileBrowser({
    mode: "save",
    title:
      rows.length === 1
        ? `ページ ${rows[0].pageNo > 0 ? rows[0].pageNo : "挿入"} を PDF として保存`
        : `${rows.length} ページを PDF として保存`,
    initialName,
    defaultDir: defaults.sourceDir,
  });
  if (!savePath) return;
  showBusy("保存", `${rows.length} ページを書き出し中...`, 0);
  try {
    const composed = await composePagesForExport({
      pages: rows,
      projectStore,
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
      onProgress: ({ done, total }) => {
        updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
      },
    });
    updateBusy("PDF を組み立て中...", 90);
    const result = await kpdf3.exportPdfRasterized({ savePath, pages: composed });
    hideBusy();
    wsStatus.textContent = `${savePath} に保存しました（${rows.length} ページ, rev ${(result?.revisionId ?? "").slice(0, 8)}）`;
  } catch (err) {
    hideBusy();
    console.error("[save-pages] failed", err);
    wsStatus.textContent = `保存失敗: ${err.message ?? err}`;
  }
}

/** Back-compat shim. Old call sites use single-page; thunk to the new
 *  multi-page path. */
function actionSaveSinglePage(pageNo) {
  return actionSavePagesAsPdf([pageNo]);
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

// ---- Overlay copy / paste (Ctrl+C, Ctrl+V) -------------------------------
//
// Implements the β3 testers' "テキスト入力したテキスト枠のコピペ" request.
// Uses an in-renderer clipboard rather than the OS clipboard so the
// copy carries the full overlay payload (font, size, color, dimensions,
// assetId for image stamps, etc.). Pasting drops a new overlay onto
// the currently-visible page at a small offset from the source position.
//
// Skipped automatically when the user is inline-editing text, typing
// into a real <input>/<textarea>, or has focus on any other content-
// editable element — so OS-level copy/paste of plain text continues to
// work normally during those flows.

/** @type {import("../domain/project-store.js").Overlay | null} */
let _overlayClipboard = null;

document.addEventListener("keydown", (e) => {
  if (!isOpen) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key !== "c" && key !== "v") return;
  // Ignore when user is typing into a real text input or inline-editing.
  if (viewer._editingId) return;
  const t = e.target;
  if (t) {
    const tag = (t.tagName ?? "").toLowerCase();
    if (tag === "input" || tag === "textarea" || t.isContentEditable) return;
  }
  if (key === "c") {
    const selId = getPrimarySelectedId();
    if (!selId) return;
    const ov = projectStore.get(selId);
    if (!ov) return;
    _overlayClipboard = {
      ...ov,
      properties: { ...(ov.properties ?? {}) },
    };
    e.preventDefault();
    wsStatus.textContent = `${ov.type} をコピーしました`;
  } else if (key === "v") {
    if (!_overlayClipboard) return;
    e.preventDefault();
    pasteOverlayFromClipboard();
  }
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
  // Whenever we LEAVE stamp placement mode, clear the active preset
  // selection so the next entry into stamp mode lands in the
  // 「未選択」 state. β28 testers found that the previously-active
  // palette tile stayed highlighted across sessions / mode toggles
  // because the id is persisted in localStorage; clearing on exit
  // (rather than at app start) keeps a deliberate selection alive
  // within a single stamp-mode visit but resets between visits.
  if (placementMode === "stamp" && mode !== "stamp" && hasActiveStampPreset()) {
    setActiveStampPreset(null);
  }
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
  updateTabBarOffset();
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
  // 上書き enabled both when there are unflushed in-memory edits AND when
  // the source PDF on disk doesn't yet reflect the workspace's overlay /
  // page state. Otherwise users see the button greyed out after a workspace
  // save even though "save back to the PDF file" is exactly what they want.
  btnSave.disabled = !isOpen || (!dirty && !isPdfOutOfSync());
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

/** Active subscriber unsubs — needed because `projectStore` / `history`
 *  get reassigned on tab switch (applyTab) and on new-tab open
 *  (newTabAndOpen). Without re-subscribing, the toolbar dirty button +
 *  menu items get wired to the *initial* boot-tab store and stop
 *  reacting once the user opens any second tab. */
let _projectStoreUnsub = null;
let _historyUnsub = null;

function attachStoreSubscribers() {
  if (_projectStoreUnsub) { try { _projectStoreUnsub(); } catch { /* noop */ } _projectStoreUnsub = null; }
  if (_historyUnsub)      { try { _historyUnsub(); }      catch { /* noop */ } _historyUnsub = null; }
  _historyUnsub = history.subscribe(() => refreshMenuState());
  _projectStoreUnsub = projectStore.subscribe((event) => {
    refreshDirtyIndicator();
    refreshMenuState();
    // Invalidate thumb caches for pages whose overlays changed so the
    // sidebar / split-save thumbs reflect the latest content (stamps,
    // marks, text).
    if (!event) return;
    // Drop the selection if its target disappeared. Multi-select aware
    // (β5 §17.13): only the removed id leaves the set, others stay.
    if (event.kind === "remove" && event.overlay?.id) {
      const goneId = event.overlay.id;
      if (isSelected(goneId)) {
        removeFromSelection(goneId);
        setTimeout(() => reapplySelectionDom(), 0);
      }
    } else if (event.kind === "reset") {
      clearSelectionState();
    } else if (event.kind === "update" && event.overlay?.id && isSelected(event.overlay.id)) {
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
}
// Initial wiring against the boot tab's store + history.
attachStoreSubscribers();

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
  // Trial-stamp preview pins a canvas onto a specific page DOM at
  // canonical coords; rotation / page delete / insert / reorder all
  // invalidate that frame, so drop it before the rebuild rather than
  // leaving an orphaned reference pointing at a detached canvas.
  clearStampTrial();
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
    // Force the sidebar open on the サムネイル tab when a PDF loads.
    // Without this, opening a fresh file inherits the prior tab state
    // (often しおり, or sidebar.hidden=true from setOpen(false)), which
    // hides the thumbs the user expects to see immediately.
    if (sidebar) sidebar.hidden = false;
    switchSidebarTab("thumbs");
    refreshSidebarToggle();
    updateTabBarOffset();
    // Auto-import the source PDF's /Outlines into the workspace's
    // editable bookmarks the first time we see this PDF. Once any
    // workspace bookmark exists (from this auto-import or a manual
    // edit) we never re-import — that would duplicate or trample the
    // user's edits. β tester explicitly asked for the manual 取込
    // button to be removed in favour of "当然に取り込んで".
    try {
      const existing = await kpdf3.listBookmarks();
      if (!Array.isArray(existing) || existing.length === 0) {
        const outline = await kpdf3.getOutline();
        if (Array.isArray(outline) && outline.length > 0) {
          await actionImportOutlines();
        }
      }
    } catch (err) {
      console.warn("[bookmark] auto-import failed:", err);
    }
    await refreshViewer();
    renderTabBar();
  } catch (err) {
    console.error("[renderer] openPdfFile (recent) failed:", err);
    wsStatus.textContent = `エラー: ${err.message ?? err}`;
  }
}


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
const printEngineSelect = $("print-engine");

// β70: 印刷エンジン候補を IPC で取得し select を populate する。
// localStorage で前回選択値を覚える。ダイアログ初回表示時に 1 回だけ
// 走らせ、以降は cache を再利用 (起動毎に再フェッチでも構わない軽量
// 処理だが、毎ダイアログ表示で IPC を打つ必要は無い)。
let _printEngineCache = null;
async function ensurePrintEnginesPopulated() {
  if (_printEngineCache) return;
  try {
    const engines = await kpdf3.listPrintEngines();
    _printEngineCache = Array.isArray(engines) ? engines : [];
  } catch (err) {
    console.warn("[print] listPrintEngines failed:", err);
    _printEngineCache = [];
  }
  printEngineSelect.innerHTML = "";
  for (const e of _printEngineCache) {
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = e.displayName + (e.recommended ? " (推奨)" : "");
    printEngineSelect.appendChild(opt);
  }
  // 永続化された選択を復元、なければ recommended
  let saved = null;
  try { saved = localStorage.getItem("kpdf3.printEngine"); }
  catch { /* private mode etc — ignore */ }
  const validSaved = saved && _printEngineCache.some((e) => e.id === saved);
  if (validSaved) {
    printEngineSelect.value = saved;
  } else if (_printEngineCache.length > 0) {
    printEngineSelect.value = _printEngineCache[0].id;
  }
}
printEngineSelect?.addEventListener("change", () => {
  try { localStorage.setItem("kpdf3.printEngine", printEngineSelect.value); }
  catch { /* ignore */ }
});
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
  // β46 J3: latest DEVMODE extras captured from the driver properties
  // dialog (DocumentPropertiesW). Plumbed through to Sumatra so tray /
  // duplex / color the user picked actually take effect. Reset when
  // the user opens the print dialog so a previous session's choices
  // don't leak; the user reopens プロパティ to set them again.
  driverDuplex: null,  // "simplex" | "long-edge" | "short-edge" | null
  driverBin: null,     // numeric tray id (dmDefaultSource) | null
  driverColor: null,   // "mono" | "color" | null
};

/**
 * Compress a list of positive integers (1-indexed visual positions) into
 * the shortest "1-3, 5, 8-10" style range string accepted by the print
 * dialog's custom-range input. Returns "" for empty/invalid input.
 */
function compressPageList(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return "";
  const sorted = [...new Set(positions)]
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const ranges = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(", ");
}

function showPrintDialog(printers, pages, currentPageNo, preselected = null) {
  printState.pages = pages;
  printState.printers = printers;
  // β46 J3: clear stale driver DEVMODE picks so they don't leak from
  // a previous print session. The user re-opens プロパティ to set them.
  printState.driverDuplex = null;
  printState.driverBin = null;
  printState.driverColor = null;

  // β70: 印刷エンジン select を populate (初回 IPC で取得)。
  ensurePrintEnginesPopulated();

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
    // Remember the printer the user picked last time (localStorage).
    // Falls back to the OS default when no remembered choice exists
    // or the remembered printer is no longer connected. β15 testers
    // asked for "最後に選んだプリンタを覚えておいてほしい".
    let remembered = null;
    try { remembered = localStorage.getItem("kpdf3.lastPrinter"); }
    catch { /* private mode etc. — ignore */ }
    const rememberedExists = remembered
      && printers.some((p) => p.name === remembered);
    for (const p of printers) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.displayName ?? p.name;
      const matchRemembered = rememberedExists && p.name === remembered;
      const matchDefault = !rememberedExists && p.isDefault;
      if (matchRemembered || matchDefault) opt.selected = true;
      printPrinterSelect.appendChild(opt);
    }
  }

  printCopiesInput.value = "1";
  printSizeActual.checked = true;
  printOrientPortrait.checked = true;

  // When the caller hands in a pre-selected page set (e.g. split-view
  // multi-selection at 印刷 time), seed the custom-range input with
  // those pages and switch to "カスタム" so the user doesn't have to
  // retype the selection. Otherwise default to "すべて".
  //
  // preselected is in pageNo space (positive for source pages, negative
  // for inserted/synthetic pages). The range input shows 1-indexed
  // visual positions, so translate each pageNo to its position in the
  // current visible `pages` array. Pages whose pageNo isn't found are
  // silently dropped (workspace edits since selection time could have
  // removed them).
  const pageNoToPos = new Map(pages.map((p, i) => [p.pageNo, i + 1]));
  const positions = Array.isArray(preselected)
    ? preselected.map((pn) => pageNoToPos.get(pn)).filter((p) => p != null)
    : [];
  const compressed = compressPageList(positions);
  if (compressed) {
    printRangeCustom.checked = true;
    printRangeInput.value = compressed;
  } else {
    printRangeAll.checked = true;
    printRangeInput.value = `1-${pages.length}`;
  }

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
    // parsePageList returns 1-indexed visual positions; translate to the
    // underlying pageNo values so downstream code (preview lookup,
    // filteredPages filter in actionPrint) can match against p.pageNo
    // uniformly. Without this translation, workspaces with inserted
    // (synthetic, negative pageNo) pages or reordered pages would
    // silently lose pages from the print job because p.pageNo wouldn't
    // equal its visual position.
    const parsed = parsePageList(printRangeInput.value, total);
    printState.visiblePageNos = parsed
      .map((pos) => printState.pages[pos - 1]?.pageNo)
      .filter((n) => n !== undefined && n !== null);
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
  const deviceName = printPrinterSelect.value;
  // Persist the picked printer so the next print dialog opens with
  // it pre-selected. localStorage is renderer-local; if it throws
  // (private mode / quota), the print still proceeds.
  if (deviceName) {
    try { localStorage.setItem("kpdf3.lastPrinter", deviceName); }
    catch { /* ignore */ }
  }
  settlePrintDialog({
    deviceName,
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
    return;
  }
  // The DocumentPropertiesW DEVMODE that the user modified in the
  // driver dialog is read back in main and returned here. Propagate
  // copies / orientation to the print dialog inputs so the next
  // 「印刷」 actually uses those values — β15 testers reported that
  // changing "枚数=5" in the driver dialog had no effect because the
  // renderer dialog still held copies=1 (the default).
  if (r && !r.cancelled) {
    if (typeof r.copies === "number" && r.copies > 0) {
      printCopiesInput.value = String(r.copies);
    }
    if (typeof r.landscape === "boolean") {
      if (r.landscape) printOrientLandscape.checked = true;
      else printOrientPortrait.checked = true;
      refreshPreview();
    }
    // β46 J3: capture duplex / tray / color from the driver DEVMODE
    // and stash on printState. Forwarded to main in actionPrint so
    // Sumatra's -print-settings reflects what the user picked.
    printState.driverDuplex = typeof r.duplex === "string" ? r.duplex : null;
    printState.driverBin = Number.isInteger(r.bin) && r.bin > 0 ? r.bin : null;
    printState.driverColor = typeof r.color === "string" ? r.color : null;
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
      // Glue each thumbnail and its trailing +gap into one indivisible
      // cell. flex-wrap can break BETWEEN cells but never inside, so
      // a thumb never gets stranded with its + gap on the next row.
      // (Without this the user reported "２行目以降の左側に＋が来る".)
      const cell = document.createElement("div");
      cell.className = "split-thumb-cell";
      const thumb = createThumbElement(pages[i], i + 1);
      cell.appendChild(thumb);
      let anchor;
      let orderInSlot = null;
      if (pages[i].isSynthetic) {
        anchor = pages[i].syntheticAfterPageNo ?? 0;
        orderInSlot = (pages[i].syntheticOrderInSlot ?? 0) + 1;
      } else {
        anchor = pages[i].pageNo;
      }
      cell.appendChild(makeSplitInsertGap(anchor, orderInSlot));
      row.appendChild(cell);
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
  // β15 testers wanted a fast way back to the main viewer from a
  // page they had been examining in the split flow. Double-click
  // closes the split view and scrolls the main viewer to the
  // double-clicked page (mirrors how a sidebar thumb click already
  // scrolls there).
  wrap.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setSplitMode(false);
    if (typeof pageRow.pageNo === "number") {
      viewer.scrollToPage(pageRow.pageNo);
    }
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
  // 分割画面を閉じたら、そこで選択していたページの集合も破棄する。
  // 残しておくと、次に印刷ボタンを押した時に actionPrint の split>0
  // 経路が走って範囲欄に偽の preselect が入る (β53 ユーザ報告)。
  if (!isSplitMode && splitThumbSelection.pageNos.size > 0) {
    splitThumbSelection.pageNos.clear();
    splitThumbSelection.anchor = null;
    refreshThumbSelectionVisuals();
  }
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
  // Split-view or sidebar selection seeds the print range so the user
  // doesn't have to retype it. Mirrors the same pattern used by rotate
  // (see resolveRotationTargets) and the sidebar's right-click
  // 「選択した N ページを PDF として保存」 path.
  //
  // Selection precedence:
  //   1. split-view selection (any size, explicit batch intent)
  //   2. sidebar selection of 2+ pages — single-page sidebar selection
  //      is often a navigation side-effect (clicking a thumb both
  //      selects AND scrolls), so we ignore size===1 to avoid surprising
  //      the user with "今見ているページだけを印刷" when they wanted all.
  let preselected = null;
  let preselectedSource = null;
  if (splitThumbSelection.pageNos.size > 0) {
    preselected = [...splitThumbSelection.pageNos];
    preselectedSource = "split";
  } else if (sidebarThumbSelection.pageNos.size >= 2) {
    preselected = [...sidebarThumbSelection.pageNos];
    preselectedSource = "sidebar";
  }
  console.log(
    "[print] preselect:",
    preselectedSource ?? "none",
    "splitSize=", splitThumbSelection.pageNos.size,
    "sidebarSize=", sidebarThumbSelection.pageNos.size,
    "isSplitMode=", isSplitMode,
    "preselected=", preselected,
  );
  if (preselected && preselected.length > 0) {
    wsStatus.textContent = preselectedSource === "split"
      ? `分割画面で選択した ${preselected.length} ページを印刷範囲に設定しました`
      : `選択した ${preselected.length} ページを印刷範囲に設定しました`;
  }
  const choice = await showPrintDialog(printers, pages, currentPageNo, preselected);
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

  // 中止ボタンを有効化。spawn 中の SumatraPDF や silent print の途中で
  // 「もう待たない」をユーザに渡せる。fire-and-forget: handler 内で
  // hideBusy + cancelPrint IPC を呼ぶ。
  let printCancelled = false;
  showBusy("印刷準備", "ページを描画中...", 0, {
    onCancel: () => {
      printCancelled = true;
      kpdf3.cancelPrint?.();
      hideBusy();
      wsStatus.textContent = "印刷を中止しました";
    },
  });
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
        renderSyntheticPage: renderSyntheticPagePixels,
        onProgress: ({ done, total }) => {
          updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
        },
      });
    }
    if (printCancelled) return;
    // Heuristic: name に fax 系文字列が混じっていればドライバ UI が
    // 出る可能性が高いので、待ち画面でその旨を予告する (main 側は同じ
    // 検出ロジックで silent を外す)。
    const looksLikeFax = /fax/i.test(choice.deviceName)
      || /ファックス|ファクス|ﾌｧｯｸｽ|ﾌｧｸｽ/.test(choice.deviceName);
    if (looksLikeFax) {
      updateBusy(`${choice.deviceName} に送信中... ドライバの送信先入力ダイアログをご確認ください`, 90);
    } else {
      updateBusy(`${choice.deviceName} に送信中...`, 90);
    }
    await kpdf3.printPdfSilent({
      source: isCopy ? "byte-copy" : "rasterized",
      pages: composed,
      deviceName: choice.deviceName,
      copies: choice.copies,
      landscape: choice.landscape,
      // β46 J3: driver-side picks (duplex / tray / color) captured from
      // DocumentPropertiesW. Main forwards to Sumatra's -print-settings
      // so the user's プロパティ choices actually take effect.
      duplex: printState.driverDuplex,
      bin: printState.driverBin,
      color: printState.driverColor,
      // β70: ユーザ選択 or 永続化された印刷エンジン (空文字なら main の
      // 自動検出に任せる)
      engineOverride: printEngineSelect?.value || null,
    });
    if (printCancelled) return;
    hideBusy();
    wsStatus.textContent = `印刷を ${choice.deviceName} に送信しました（${choice.copies} 部 / ${choice.pageNos.length} ページ）`;
  } catch (err) {
    hideBusy();
    if (printCancelled) return;
    console.error("[renderer] print failed:", err);
    wsStatus.textContent = `印刷失敗: ${err.message ?? err}`;
  }
}

async function actionExport() {
  if (!isOpen) return;
  const defaults = await kpdf3.getExportDefaults();
  const savePath = await showFileBrowser({
    mode: "save",
    title: "PDF として書き出し",
    initialName: defaults.defaultName ?? "export.pdf",
    defaultDir: defaults.sourceDir,
  });
  if (!savePath) return;
  await actionExportToPath(savePath);
}

/**
 * Out-of-sync detection: the current workspace shows content the source
 * PDF on disk doesn't reflect (overlays, pending or persisted insertions,
 * pending deletions, or any other workspace mutation since the last
 * write-back). When true, the 上書き button is enabled even after the
 * workspace itself is "clean" (no in-memory pending edits) so the user
 * can flatten back into the source PDF.
 */
function isPdfOutOfSync() {
  if (!isOpen) return false;
  if (projectStore.count() > 0) return true;
  if (pendingDeletedPages.size > 0) return true;
  if (workspaceMutated) return true;
  return false;
}

async function actionSave() {
  if (!isOpen) return;
  // No-op when nothing has changed AND source PDF already matches workspace.
  if (!isWorkspaceDirty() && !isPdfOutOfSync()) return;
  // Snapshot the "had pre-save mutations" signal — useful below to decide
  // whether the source PDF still needs flattening even after we cleared
  // workspaceMutated.
  const hadMutations = workspaceMutated;
  // Step 1: flush workspace state (overlays + deletions) so the kpdf3
  // captures everything before we touch the on-disk PDF. Cheap (~50ms).
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
    // Step 2: if the source PDF doesn't yet reflect the workspace's
    // overlay / page state, confirm + write back. Word Ctrl+S semantics
    // — commit edits to the file the user opened. (Source-PDF path
    // lives on the TabState, NOT as a module-level alias, so resolve
    // it via getActiveTab().)
    const tab = getActiveTab();
    const sourcePath = tab?.activeSourcePdfPath ?? null;
    const hasEditsToCommit =
      sourcePath
      && (overlaySnapshot.length > 0
        || deletedCount > 0
        || hadMutations
        || projectStore.count() > 0);
    if (hasEditsToCommit) {
      // Ask the user how to save. "確定" = flatten + overwrite source PDF
      // (destructive, overlays bake into the image); "下書き" = keep the
      // edits live (workspace-only save, source PDF untouched). Wording
      // avoids the internal "workspace" term and uses the 下書き／確定
      // distinction that legal practitioners already use day-to-day.
      const ok = await customConfirm({
        title: "保存方法を選んでください",
        message:
          `「${activeSourceName || "(無名)"}」を保存します。\n`
          + `「確定」を選ぶと、いま入れたテキスト・印影などは\n`
          + `あとから動かせなくなります。`,
        okLabel: "確定として PDF を上書き",
        cancelLabel: "下書きとして保存（あとで編集できる）",
      });
      if (ok) {
        await actionExportToPath(sourcePath, { verb: "上書き保存" });
        return;
      }
      // User picked 下書き — reinforce the choice in the status bar so
      // they know the source PDF was left alone.
      wsStatus.textContent =
        "下書きとして保存しました（元 PDF は変更されていません）";
      return;
    }
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

/**
 * Shared "export rasterized (or byte-copy) PDF to the given path, then
 * re-anchor the active tab onto that file" pipeline. Used by both
 * actionExport (Save As — user-chosen path) and actionSave (上書き保存
 * — path === activeSourcePdfPath). Mirrors Word's Save / Save As
 * semantics: after the operation, the user is editing the file they
 * just wrote to.
 *
 * @param {string} savePath - absolute target PDF path
 * @param {{ verb?: string }} [opts] - status-message verb (default "書き出し")
 */
async function actionExportToPath(savePath, { verb: verbOverride } = {}) {
  if (!isOpen) return;
  const pages = await fetchVisiblePages();
  if (pages.length === 0) return;
  const overlayCount = projectStore.count();
  const meta = await kpdf3.getSourceMeta();
  const hasInsertions = pages.some((p) => p.isSynthetic || p.pageNo < 0);
  const sourcePagesCount = pages.filter((p) => !p.isSynthetic && p.pageNo > 0).length;
  const hasDeletions =
    pendingDeletedPages.size > 0
    || (meta && sourcePagesCount < (meta.pageCount ?? sourcePagesCount));
  const isCopy = overlayCount === 0 && !hasDeletions && !hasInsertions;
  const verb = verbOverride ?? (isCopy ? "コピー" : "書き出し");
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
      result = await kpdf3.exportPdfRasterized({ savePath, pages: composed });
    }
    updateBusy("新しいファイルに切り替え中...", 95);
    try {
      const opened = await kpdf3.openPdfFile(savePath, activeTabId);
      projectStore.reset(opened.overlays ?? []);
      pendingDeletedPages.clear();
      workspaceMutated = false;
      thumbSelection.pageNos.clear();
      thumbSelection.anchor = null;
      history.clear();
      await refreshViewer();
    } catch (switchErr) {
      console.error("[renderer] post-save workspace switch failed:", switchErr);
    }
    hideBusy();
    wsStatus.textContent = `${verb}しました（rev ${result.revisionId.slice(0, 8)}）`;
  } catch (err) {
    hideBusy();
    console.error(`[renderer] ${verb} failed:`, err);
    wsStatus.textContent = `${verb}失敗: ${err.message ?? err}`;
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
  // Drop the split-view's thumb cache for this page so the next split
  // refresh renders the new orientation. The sidebar's thumbCache is
  // wiped wholesale by clearThumbs() inside refreshViewer → rebuildThumbs
  // below, so we intentionally do NOT invalidate it here: an eager
  // invalidate kicks an in-flight renderThumb capturing the OLD
  // viewer._pages snapshot, which can finish AFTER clearThumbs() and
  // poison thumbCache with a stale canvas before the new observer
  // checks it — leaving the freshly-rebuilt thumb-item stuck as a
  // placeholder ("blank thumb" reported by β11 testers).
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
/**
 * Resolve the rotation target(s) for toolbar / menu rotate buttons.
 *
 * Selection precedence:
 *   1. split-view selection (any size) — always explicit batch intent
 *   2. sidebar selection of **2 or more** pages — user actively built a
 *      multi-select via Ctrl/Shift+click
 *   3. main viewer's currentPage — the page the user is looking at
 *
 * A *single-page* sidebar selection is intentionally ignored: clicking
 * a sidebar thumb both selects AND scrolls the viewer there, so the
 * selection is often just a leftover from navigation. After the user
 * scrolls to a different page, they expect "rotate" to act on what
 * they're SEEING, not on the long-stale clicked thumb (β8/β9 testers
 * reported "サイドバーで選択 → 回転で関係ないページが回転").
 *
 * Multi-page sidebar selections are clearly deliberate, so we honor
 * those without ambiguity.
 */
function resolveRotationTargets() {
  if (splitThumbSelection.pageNos.size > 0) {
    const ordered = getOrderedThumbPageNos(splitFlow, ".split-thumb[data-page-no]");
    return ordered.filter((n) => splitThumbSelection.pageNos.has(n));
  }
  if (sidebarThumbSelection.pageNos.size >= 2) {
    const ordered = getOrderedThumbPageNos(thumbList, ".thumb-item");
    return ordered.filter((n) => sidebarThumbSelection.pageNos.has(n));
  }
  // visiblePageNow() reads scrollTop synchronously rather than the
  // cached _currentPage — protects against a race where the user has
  // scrolled but the rAF-driven scroll listener has not yet updated
  // the cache (β10 testers saw rotate target the previously-clicked
  // sidebar page after subsequently scrolling the main viewer).
  const visible = viewer.visiblePageNow?.();
  return [Number.isFinite(visible) ? visible : viewer.currentPage];
}

async function rotateCurrentPage(delta) {
  const targets = resolveRotationTargets();
  for (const pageNo of targets) {
    await rotatePageBy(pageNo, delta);
  }
}
function actionRotateLeft() { return rotateCurrentPage(-90); }
function actionRotateRight() { return rotateCurrentPage(+90); }

function applyZoom(z) {
  viewer.setZoom(z);
  // setZoom rebuilds the page DOMs via viewer.load — any trial-stamp
  // canvas we pinned to a page element has been detached. Recreate it
  // at the new zoom inside the freshly-built page DOM so the user's
  // size comparison survives zooming in/out.
  reattachStampTrial();
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

// ---- Status-bar page navigation: ◀  [n]  / total  ▶ -------------------
// β15 testers wanted an always-visible way to step pages and jump by
// number without opening the goto dialog. The existing actionPagePrev/
// actionPageNext/PageUp/PageDown machinery is reused; this just adds
// the visible UI in the status bar.
//
// commitPageInput parses what the user typed (1-indexed visual position)
// and resolves it to a real pageNo via the registry. Same validation
// rules as actionPageGoto.
function commitPageInput() {
  if (!isOpen || !viewer.registry || !pageNumInput) return;
  const total = viewer.registry.count();
  const raw = pageNumInput.value.trim();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > total) {
    // Revert to the live position.
    updatePageIndicator(viewer.currentPage, total);
    if (raw !== "") wsStatus.textContent = `無効なページ番号: ${raw}`;
    return;
  }
  // The status-bar input is 1-indexed visual position. Translate via
  // the registry to the underlying pageNo (which can be negative for
  // inserted pages).
  const pageNo = viewer.registry.pageNoAtPos(n - 1);
  if (typeof pageNo !== "number") {
    updatePageIndicator(viewer.currentPage, total);
    return;
  }
  viewer.scrollToPage(pageNo);
}
pagePrevBtn?.addEventListener("click", () => {
  actionPagePrev();
  pagePrevBtn.blur();
});
pageNextBtn?.addEventListener("click", () => {
  actionPageNext();
  pageNextBtn.blur();
});
pageNumInput?.addEventListener("focus", () => {
  pageNumInput.select();
});
pageNumInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitPageInput();
    pageNumInput.blur();
  } else if (e.key === "Escape") {
    e.preventDefault();
    // Discard pending edit, restore live value.
    const total = viewer.registry?.count() ?? 0;
    updatePageIndicator(viewer.currentPage, total);
    pageNumInput.blur();
  }
});
pageNumInput?.addEventListener("blur", () => {
  // Resync the field to the live position (commitPageInput already
  // scrolled if the value was valid; this just snaps the input back
  // for cases where the user left the field with stale text).
  const total = viewer.registry?.count() ?? 0;
  updatePageIndicator(viewer.currentPage, total);
});

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
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectBookmark(node.id);
    showBookmarkContextMenu(li, node, e.clientX, e.clientY);
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
  const indentBtn = $("bookmark-indent");
  const outdentBtn = $("bookmark-outdent");
  if (addBtn) addBtn.disabled = !isOpen;
  if (rmBtn) rmBtn.disabled = !isOpen || !selectedBookmarkId || bookmarkSource !== "workspace";
  // Import is now triggered automatically on first open (openPdfPath).
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

// ---- Bookmark right-click context menu --------------------------------
const ctxBookmark = $("ctx-bookmark");
// Cache the <li> + node so 名前を変更 can run startInlineRenameBookmark
// without re-traversing the DOM (the right-clicked <li> may be the one
// inside a nested children <ul>).
let _bookmarkCtxTarget = null;
function showBookmarkContextMenu(li, node, x, y) {
  if (!ctxBookmark) return;
  _bookmarkCtxTarget = { li, node };
  ctxBookmark.style.left = `${x}px`;
  ctxBookmark.style.top = `${y}px`;
  ctxBookmark.hidden = false;
}
function hideBookmarkContextMenu() {
  if (!ctxBookmark) return;
  ctxBookmark.hidden = true;
  _bookmarkCtxTarget = null;
}
function dispatchBookmarkCtx(target) {
  const ctx = _bookmarkCtxTarget;
  hideBookmarkContextMenu();
  if (!(target instanceof HTMLElement) || !ctx) return;
  const action = target.dataset.ctx;
  if (action === "rename") {
    // Defer to next frame so the pointerdown/up/click sequence on the
    // menu item fully settles before we create the rename <input>.
    // Otherwise a trailing focus shift (or other listener triggered by
    // the same click) can race against input.focus() and the blur path
    // fires finish() before the user types anything.
    requestAnimationFrame(() => startInlineRenameBookmark(ctx.li, ctx.node));
  } else if (action === "delete") {
    actionRemoveBookmark();
  }
}
ctxBookmark?.addEventListener("pointerdown", (e) => {
  // preventDefault stops the browser's native mousedown→focus shift that
  // would otherwise steal focus from the rename <input> that
  // startInlineRenameBookmark creates synchronously inside dispatchBookmarkCtx.
  // Without this the input loses focus immediately, its blur listener
  // fires finish(commit=true) with an unchanged value, and the rename
  // silently no-ops — looking like "右クリック→名前を変更が効かない".
  e.preventDefault();
  e.stopPropagation();
  let el = e.target;
  while (el && el !== ctxBookmark && !(el.dataset && el.dataset.ctx)) {
    el = el.parentElement;
  }
  if (el && el !== ctxBookmark) dispatchBookmarkCtx(el);
});
ctxBookmark?.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("pointerdown", (ev) => {
  if (!ctxBookmark || ctxBookmark.hidden) return;
  if (ev.target instanceof Node && ctxBookmark.contains(ev.target)) return;
  hideBookmarkContextMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideBookmarkContextMenu();
});

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
// (bookmark-import button removed — outline is auto-imported on first
// open in openPdfPath. actionImportOutlines is still invoked from there.)

function actionToggleBookmarks() {
  if (!isOpen) return;
  sidebar.hidden = !sidebar.hidden;
  refreshSidebarToggle();
  refreshMenuState();
  updateTabBarOffset();
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
      // β3 testers reported "分割画面でドロップしても追加が見えない" —
      // refreshViewer() above rebuilds the sidebar thumbs but the split
      // view has its own thumb list that needs an explicit refresh.
      if (isSplitMode) await refreshSplitView();
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
  // Label by *visual position* (1-indexed) — the user complained that
  // raw pageNo skipped over inserted pages and didn't match what they
  // saw in the sidebar / split view. Falls back to a kind-only label
  // if the page isn't currently in the viewer registry (shouldn't
  // happen in practice but keeps the dialog robust).
  const posOf = (n) => {
    const pos = viewer.registry?.posOfPageNo?.(n);
    return Number.isInteger(pos) && pos >= 0 ? pos + 1 : null;
  };
  const labels = all
    .map((n) => {
      const pos = posOf(n);
      const kind = n > 0 ? "元" : "挿入";
      return pos != null ? `${pos} ページ目 (${kind})` : (n > 0 ? `p.${n}` : "挿入ページ");
    })
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
    // The thumb-item may have been recreated by rebuildThumbs() while
    // our renderPage IPC was in flight (e.g. a rotation triggered
    // refreshViewer mid-call). The original itemEl is detached: its
    // ph.replaceWith is harmless, but writing to thumbCache would
    // block the NEW observer-triggered render from kicking off,
    // leaving the rebuilt thumb-item stuck as a placeholder.
    if (!itemEl.isConnected) return;
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

// ---- Auto-update UX (§17.15) ------------------------------------------
//
// The main process drives electron-updater and forwards events here.
// We surface the lifecycle through:
//   - update-available  → 98-styled confirm「ダウンロードしますか？」
//   - download-progress → busy modal with percent
//   - update-downloaded → 98-styled confirm「再起動して適用しますか？」
//   - error             → silent during the auto-check, surfaced for manual
//
// `updaterMode` differentiates the automatic startup check (silent on
// the "no update available" case) from a user-initiated check via
// ヘルプ＞更新を確認 (which should say "最新版です").
let updaterMode = "auto";
let updaterDownloadInFlight = false;

function fmtMB(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

kpdf3.onUpdaterChecking?.(() => {
  // Only surface "checking..." during a manual check — the auto-check
  // happens silently in the background.
  if (updaterMode === "manual") {
    showBusy("更新の確認中", "GitHub から最新版の情報を取得しています...", 0);
  }
});

kpdf3.onUpdaterNotAvailable?.(() => {
  if (updaterMode === "manual") {
    hideBusy();
    void customConfirm({
      title: "更新の確認",
      message: "お使いのバージョンは最新です。",
      okLabel: "OK",
      cancelLabel: "閉じる",
    });
  }
  updaterMode = "auto";
});

kpdf3.onUpdaterUpdateAvailable?.(async (info) => {
  // Hide the manual "確認中..." modal before showing the confirm.
  hideBusy();
  const ver = info?.version ? `v${info.version}` : "新しいバージョン";
  const ok = await customConfirm({
    title: "更新が利用可能",
    message: `${ver} が利用可能です。\n今すぐダウンロードしますか？\n\n（ダウンロード後に再起動の確認があります）`,
    okLabel: "ダウンロード",
    cancelLabel: "後で",
  });
  if (!ok) {
    updaterMode = "auto";
    return;
  }
  updaterDownloadInFlight = true;
  showBusy("更新をダウンロード中", "通信を開始しています...", 0);
  const res = await kpdf3.updaterDownload();
  if (res && res.ok === false) {
    updaterDownloadInFlight = false;
    hideBusy();
    void customConfirm({
      title: "ダウンロード失敗",
      message: `更新のダウンロードに失敗しました。\n${res.error || ""}`,
      okLabel: "OK",
      cancelLabel: "閉じる",
    });
  }
});

kpdf3.onUpdaterDownloadProgress?.((p) => {
  if (!updaterDownloadInFlight) return;
  const pct = Math.max(0, Math.min(100, Math.round(p?.percent ?? 0)));
  const transferred = fmtMB(p?.transferred);
  const total = fmtMB(p?.total);
  const sizes = transferred && total ? ` (${transferred} / ${total})` : "";
  updateBusy(`ダウンロード中: ${pct}%${sizes}`, pct);
});

kpdf3.onUpdaterUpdateDownloaded?.(async (info) => {
  updaterDownloadInFlight = false;
  hideBusy();
  const ver = info?.version ? `v${info.version}` : "更新";
  const ok = await customConfirm({
    title: "更新の準備完了",
    message: `${ver} のダウンロードが完了しました。\n今すぐ再起動して適用しますか？\n\n（未保存の変更がある場合は事前に保存してください）`,
    okLabel: "再起動して適用",
    cancelLabel: "次回起動時に適用",
  });
  if (ok) {
    await kpdf3.updaterInstall();
  }
  updaterMode = "auto";
});

kpdf3.onUpdaterError?.((err) => {
  // Auto-check failures stay silent — testers on closed networks would
  // otherwise see an error on every launch. Manual checks surface the
  // problem so the user knows their explicit request failed.
  if (updaterMode === "manual") {
    updaterDownloadInFlight = false;
    hideBusy();
    void customConfirm({
      title: "更新の確認に失敗",
      message: `更新サーバーへの接続に失敗しました。\n${err?.message || ""}`,
      okLabel: "OK",
      cancelLabel: "閉じる",
    });
    updaterMode = "auto";
  } else {
    console.warn("[updater] auto-check error (silent):", err?.message || err);
  }
});

async function actionCheckForUpdates() {
  updaterMode = "manual";
  const res = await kpdf3.updaterCheck();
  if (res?.skipped) {
    hideBusy();
    void customConfirm({
      title: "更新の確認",
      message: res.reason === "dev mode"
        ? "開発モードでは自動更新は無効です。"
        : "自動更新は --no-update で無効化されています。",
      okLabel: "OK",
      cancelLabel: "閉じる",
    });
    updaterMode = "auto";
  }
  // Otherwise the response is handled via the updater events.
}

async function actionOpenCrashLog() {
  // β51 J7: open the crash log in the OS default editor (メモ帳 on
  // Windows). If the file doesn't exist yet, main returns ok:false
  // and we surface a friendly status — no log means no crash, that's
  // the happy path.
  const r = await kpdf3.openCrashLog?.();
  if (!r?.ok) {
    wsStatus.textContent = r?.reason === "missing"
      ? "クラッシュログはまだありません (前回起動以降の例外なし)"
      : `クラッシュログを開けませんでした: ${r?.reason ?? "unknown"}`;
  }
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
    "check-update": actionCheckForUpdates,
    "open-crash-log": actionOpenCrashLog,
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
  // β5 §17.13: multi-select aware — all currently-selected overlays
  // are removed in one undo unit via CompositeCommand.
  if ((e.key === "Delete" || e.key === "Backspace") && hasSelection() && !inText) {
    e.preventDefault();
    const ids = getSelectedIds();
    clearSelection();
    if (ids.length === 1) {
      history.execute(new RemoveOverlayCommand(projectStore, ids[0]));
    } else {
      const subs = ids.map((id) => new RemoveOverlayCommand(projectStore, id));
      history.execute(new CompositeCommand(subs, `Delete ${ids.length} overlays`));
    }
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

/** No-op kept for callers; the tab-bar now lives inside main-content
 *  (right of the sidebar) so its offset is handled purely by flex
 *  layout. Removing this helper would mean editing every call-site;
 *  it's cheaper to leave a stub here. */
function updateTabBarOffset() { /* no-op */ }

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
  updateTabBarOffset();
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
  "check-update": "新しいバージョンの有無を確認します",
  "open-crash-log": "クラッシュログをメモ帳で開きます (β51〜)",
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
//
// We also light up a `body.file-dragging` flag while a file is in flight
// so the (otherwise 8 px) thumb-insert gaps swell into actually-hittable
// drop targets — β3 testers couldn't reliably land a PDF on the sidebar
// gaps and got nothing on split-view drops.
let _fileDragDepth = 0;
document.addEventListener("dragenter", (e) => {
  const types = e.dataTransfer?.types;
  if (!types || ![...types].includes("Files")) return;
  _fileDragDepth += 1;
  document.body.classList.add("file-dragging");
});
document.addEventListener("dragleave", (e) => {
  const types = e.dataTransfer?.types;
  if (!types || ![...types].includes("Files")) return;
  _fileDragDepth = Math.max(0, _fileDragDepth - 1);
  if (_fileDragDepth === 0) document.body.classList.remove("file-dragging");
});
const _clearFileDragging = () => {
  _fileDragDepth = 0;
  document.body.classList.remove("file-dragging");
};
document.addEventListener("dragover", (e) => {
  e.preventDefault();
});
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  _clearFileDragging();
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
// Belt-and-braces: ensure the file-dragging class clears even when the
// dragenter/dragleave pair gets out of sync (which is easy to do on
// Windows + Electron when dragging across nested elements).
window.addEventListener("dragend", _clearFileDragging);
window.addEventListener("mouseup", () => {
  if (document.body.classList.contains("file-dragging")) _clearFileDragging();
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

// OS-driven PDF open: main forwards paths from argv / macOS open-file /
// second-instance into here. Route through openPdfSmart so the new
// path opens in a fresh tab when the active one is already in use
// (preserves the user's editing context).
kpdf3.onOpenPdfByOS?.((pdfPath) => {
  if (!pdfPath || typeof pdfPath !== "string") return;
  void openPdfSmart(pdfPath);
});

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
const STAMP_POPUP_POS_KEY = "kpdf3.stampPopupPos";
{
  const popup = $("stamp-palette-popup");
  const titleBar = $("stamp-palette-titlebar");
  if (popup && titleBar) {
    // Restore the popup's last-used position so it doesn't snap back to
    // the CSS default (top: 120px / right: 24px) every time the user
    // exits + re-enters stamp mode or relaunches K-PDF3.
    const restorePopupPosition = () => {
      try {
        const saved = localStorage.getItem(STAMP_POPUP_POS_KEY);
        if (!saved) return;
        const { left, top } = JSON.parse(saved);
        if (typeof left !== "number" || typeof top !== "number") return;
        // Clamp into the current viewport in case the window shrank
        // since the position was saved.
        const w = popup.offsetWidth || 260;
        const h = popup.offsetHeight || 200;
        const clampedLeft = Math.max(0, Math.min(window.innerWidth - w, left));
        const clampedTop = Math.max(0, Math.min(window.innerHeight - h, top));
        popup.style.left = `${clampedLeft}px`;
        popup.style.top = `${clampedTop}px`;
        popup.style.right = "auto";
      } catch { /* ignore parse errors */ }
    };
    // Run once at module load and again every time the popup is shown
    // (offsetWidth is 0 while [hidden]).
    restorePopupPosition();
    const obs = new MutationObserver(() => {
      if (!popup.hidden) restorePopupPosition();
    });
    obs.observe(popup, { attributes: true, attributeFilter: ["hidden"] });

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
      // Persist the drop position so the next stamp-mode entry remembers it.
      try {
        const left = parseFloat(popup.style.left) || 0;
        const top = parseFloat(popup.style.top) || 0;
        localStorage.setItem(STAMP_POPUP_POS_KEY, JSON.stringify({ left, top }));
      } catch { /* ignore quota */ }
    });
  }
}

btnRotateLeft.addEventListener("click", actionRotateLeft);
btnRotateRight.addEventListener("click", actionRotateRight);

// Align toolbar (β5 §17.13/§17.14) — visible only with 2+ selected.
document.getElementById("align-left")  ?.addEventListener("click", () => alignSelectedOverlays("left"));
document.getElementById("align-top")   ?.addEventListener("click", () => alignSelectedOverlays("top"));
document.getElementById("align-right") ?.addEventListener("click", () => alignSelectedOverlays("right"));
document.getElementById("align-bottom")?.addEventListener("click", () => alignSelectedOverlays("bottom"));

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
  const color = currentTextColor();
  const digitsHanko = currentTextDigitsHanko();
  const bold = currentTextBold();
  projectStore.update(id, {
    properties: { ...ov.properties, fontId, fontSize, color, digitsHanko, bold },
  });
  // Keep the inline-edit element visually in sync (the store update
  // alone doesn't repaint the editing element — see viewer's preserve-
  // editing logic).
  viewer.applyEditingTextStyle({ fontId, fontSize, color, digitsHanko, bold });
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
const TEXT_COLOR_STORAGE_KEY = "kpdf3.textColor";
if (textColorSel) {
  const saved = localStorage.getItem(TEXT_COLOR_STORAGE_KEY);
  if (saved && Array.from(textColorSel.options).some((o) => o.value === saved)) {
    textColorSel.value = saved;
  }
  textColorSel.addEventListener("change", () => {
    localStorage.setItem(TEXT_COLOR_STORAGE_KEY, currentTextColor());
    if (isOpen && placementMode !== "text" && !viewer._editingId) {
      setPlacementMode("text");
    }
    applyFontSizeToEditingOverlay();
  });
}
const TEXT_DIGITS_HANKO_STORAGE_KEY = "kpdf3.textDigitsHanko";
if (textDigitsHankoChk) {
  if (localStorage.getItem(TEXT_DIGITS_HANKO_STORAGE_KEY) === "1") {
    textDigitsHankoChk.checked = true;
  }
  textDigitsHankoChk.addEventListener("change", () => {
    localStorage.setItem(
      TEXT_DIGITS_HANKO_STORAGE_KEY,
      textDigitsHankoChk.checked ? "1" : "0",
    );
    if (isOpen && placementMode !== "text" && !viewer._editingId) {
      setPlacementMode("text");
    }
    applyFontSizeToEditingOverlay();
  });
}
const TEXT_BOLD_STORAGE_KEY = "kpdf3.textBold";
if (textBoldChk) {
  if (localStorage.getItem(TEXT_BOLD_STORAGE_KEY) === "1") {
    textBoldChk.checked = true;
  }
  textBoldChk.addEventListener("change", () => {
    localStorage.setItem(
      TEXT_BOLD_STORAGE_KEY,
      textBoldChk.checked ? "1" : "0",
    );
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
