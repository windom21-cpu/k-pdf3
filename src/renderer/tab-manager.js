// Tab management (ADR-0015 Phase 2/3).
//
// Owns the tabs Map, activeTabId, and the per-tab state machine
// (createTabState / saveActiveTabSnapshot / applyTab / newTabAndOpen /
// closeTab / closeTabWithConfirm), plus the tab-bar DOM (renderTabBar)
// and HTML5 drag-and-drop reordering.
//
// The renderer holds the live module-level aliases (projectStore /
// history / pendingDeletedPages / isOpen / placementMode / ...) that
// the rest of renderer.js reads directly, so this module can't mutate
// them. Instead init wires two callbacks:
//   saveActiveStateInto(tab) — capture current renderer aliases into
//                              the given tab record (called before a switch)
//   applyStateFromTab(tab)   — write the tab record back into the
//                              renderer aliases + viewer.setProjectStore +
//                              attachStoreSubscribers
// plus refreshViewerAfterSwitch / setOpenFalse / openPdfPath /
// actionOpen / isActiveTabDirty for the post-switch side effects.
//
// Public API:
//   createTabState()            — pure factory; renderer creates the
//                                 boot tab before init so it can wire
//                                 viewer with the boot projectStore
//   initTabManager({...})       — register callbacks + boot tab
//   getActiveTab() / getActiveTabId() / getAllTabs()
//   saveActiveTabSnapshot()
//   tabIsDirty(tab)
//   applyTab(tabId)
//   newTabAndOpen(pdfPath?)
//   closeTab(tabId)
//   closeTabWithConfirm(tabId)
//   renderTabBar()

import { ProjectStore } from "../domain/project-store.js";
import { HistoryStack } from "../domain/history.js";
import { customConfirm } from "./dialogs.js";

const { kpdf3 } = window;

let _tabIdCounter = 0;
function genTabId() {
  return `tab-${Date.now().toString(36)}-${(++_tabIdCounter).toString(36)}`;
}

export function createTabState() {
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

let _viewer = null;
let _viewerContainer = null;
let _saveActiveStateInto = (_tab) => {};
let _applyStateFromTab = (_tab) => {};
let _refreshViewerAfterSwitch = async () => {};
let _setOpenFalse = () => {};
let _isActiveTabDirty = () => false;
let _openPdfPath = async (_p) => {};
let _actionOpen = async () => {};

export function initTabManager({
  initialTab,
  viewer,
  viewerContainer,
  saveActiveStateInto,
  applyStateFromTab,
  refreshViewerAfterSwitch,
  setOpenFalse,
  isActiveTabDirty,
  openPdfPath,
  actionOpen,
}) {
  _viewer = viewer;
  _viewerContainer = viewerContainer;
  _saveActiveStateInto = saveActiveStateInto;
  _applyStateFromTab = applyStateFromTab;
  _refreshViewerAfterSwitch = refreshViewerAfterSwitch;
  _setOpenFalse = setOpenFalse;
  _isActiveTabDirty = isActiveTabDirty;
  _openPdfPath = openPdfPath;
  _actionOpen = actionOpen;
  tabs.set(initialTab.id, initialTab);
  activeTabId = initialTab.id;
}

export function getActiveTab() {
  return activeTabId ? tabs.get(activeTabId) : null;
}

export function getActiveTabId() {
  return activeTabId;
}

export function getAllTabs() {
  return tabs;
}

// `tabs` (Map) is the canonical owner of per-tab state; the module-
// level aliases (projectStore / history / pendingDeletedPages /
// isOpen / placementMode / activeSourceName / workspaceMutated /
// selectedBookmarkId / ...) in renderer.js are scratch slots that
// hold the *active* tab's values for the duration it is selected.
// saveActiveTabSnapshot pushes them back into the TabState before a
// switch via the saveActiveStateInto callback; applyTab pulls the
// new tab's values into the slots via the applyStateFromTab callback.
//
// The viewer is a single DOM-bound instance shared across tabs —
// viewer.setProjectStore() rewires its subscription, viewer.load()
// rebuilds the page list. scrollPosition is captured/restored
// per tab so flipping back to a tab returns to where you were.

/** Push the live module-level state into the active tab so it can be
 *  restored later. Called immediately before applyTab() switches. */
export function saveActiveTabSnapshot() {
  const tab = getActiveTab();
  if (!tab) return;
  _saveActiveStateInto(tab);
  tab.scrollPosition = _viewerContainer.scrollTop;
  tab.zoom = _viewer.zoom;
  // projectStore / history / pendingDeletedPages / thumbCache are
  // reference-shared with the tab record, no copy needed.
}

/** Compute whether a tab has unsaved changes. For the active tab we
 *  consult the live state (renderer reports via isActiveTabDirty),
 *  for inactive ones the snapshot saved at last switch. */
export function tabIsDirty(tab) {
  if (tab.id === activeTabId) {
    return _isActiveTabDirty();
  }
  return (
    tab.projectStore.isDirty() ||
    tab.pendingDeletedPages.size > 0 ||
    tab.workspaceMutated
  );
}

/** Make `tabId` the active tab — drops the viewer's current pages,
 *  rewires module aliases to that tab's stores, reloads the viewer.
 *  Skipping work when the tab is already active. */
export async function applyTab(tabId) {
  if (!tabs.has(tabId)) return;
  if (tabId === activeTabId) {
    renderTabBar();
    return;
  }
  saveActiveTabSnapshot();
  // Tear down the viewer's overlay edit state etc. before swapping.
  _viewer.unload();
  activeTabId = tabId;
  const tab = tabs.get(tabId);
  _applyStateFromTab(tab);
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
    await _refreshViewerAfterSwitch();
    // Restore scroll after layout settles. scrollLeft is reset to 0 —
    // fit-width / fit-page centre the inner via `margin: 0 auto`, so a
    // non-zero scrollLeft from the previous tab (e.g. transient overflow
    // during page rebuild) would offset the content to the right and
    // leave gray padding on the left after re-fit.
    requestAnimationFrame(() => {
      _viewerContainer.scrollTop = tab.scrollPosition || 0;
      _viewerContainer.scrollLeft = 0;
    });
  } else {
    try { await kpdf3.switchTab(null); } catch { /* noop */ }
    _setOpenFalse();
  }
  renderTabBar();
}

/** Open a new tab and (optionally) prompt the user to pick a PDF for it. */
export async function newTabAndOpen(pdfPath = null) {
  saveActiveTabSnapshot();
  const tab = createTabState();
  tabs.set(tab.id, tab);
  // Switch the bare aliases to the new tab. Doing it inline (rather
  // than via applyTab) because the new tab has no main-side handle
  // yet — applyTab would call switchTab and fail.
  _viewer.unload();
  activeTabId = tab.id;
  _applyStateFromTab(tab);
  _setOpenFalse();
  renderTabBar();
  if (pdfPath) {
    await _openPdfPath(pdfPath);
  } else {
    // Trigger the file picker. Reuses the existing actionOpen flow so
    // recent-files / D&D / browser dialog all work.
    await _actionOpen();
  }
}

/** Close a tab. If it's the active one, switch to a neighbour first.
 *  Honours the tab's dirty flag — caller should handle confirmation
 *  upstream (closeTabWithConfirm). */
export async function closeTab(tabId) {
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
      _applyStateFromTab(blank);
      _viewer.unload();
      _setOpenFalse();
    }
  } else {
    tabs.delete(tabId);
  }
  renderTabBar();
}

/** Close-with-confirmation: dirty tabs get a 「破棄しますか」 dialog. */
export async function closeTabWithConfirm(tabId) {
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

// ---- Tab bar rendering + drag-and-drop --------------------------------

/** Compute a tab's display name. PDF basename when one is open;
 *  "(新規タブ)" for an empty tab. */
function tabDisplayTitle(tab) {
  if (tab.activeSourceName) return tab.activeSourceName;
  return "(新規タブ)";
}

/** Rebuild the tab-bar DOM from the current `tabs` map. */
export function renderTabBar() {
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
