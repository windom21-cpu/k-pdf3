// K-PDF3 renderer entry (M2, ADR-0006).
//
// PDF-first UX: a single「開く」button (and File menu equivalent) takes
// the user through the file picker; main resolves the sidecar `.kpdf3`
// automatically.

import { Viewer, renderSyntheticPagePixels } from "./viewer.js";
import { MenuBar } from "./menu-bar.js";
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
  composePageImage,
  composeRegionImage,
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
  handleOverlayDblclick,
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
  placeFormCheck,
  placeFormRadio,
  placeFormCircle,
  startFormTextDrag,
  startShapeDrag,
  updateShapeOverlay,
  // (form-fill imports below)
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
import {
  initBookmarkPane,
  refreshBookmarks,
  actionImportOutlines,
  getBookmarkSnapshot,
  setBookmarkSnapshot,
  clearBookmarkState,
  clearBookmarkDom,
} from "./bookmark-pane.js";
import { initPrintFlow, actionPrint, actionPrintOverlayOnly, actionFaxSend, actionFaxChangePrinter } from "./print-flow.js";
import {
  initFormFill,
  invalidateTabOrderCache,
  focusFirst as formFillFocusFirst,
  setFocusedFieldId as setFormFocusedFieldId,
  handleFillModeClickOnField,
  handleFillModeKeydown,
  getCurrentTabOrder,
} from "./form-fill.js";
import {
  createTabState,
  initTabManager,
  getActiveTab,
  getActiveTabId,
  getAllTabs,
  saveActiveTabSnapshot,
  tabIsDirty,
  applyTab,
  newTabAndOpen,
  closeTabWithConfirm,
  renderTabBar,
  transferOutTab,
  adoptDetachedTab,
  adoptDockedTab,
  setOnDetachRequest,
  setOnDragOut,
  setOnTabDragStart,
  setOnTabDragEnd,
} from "./tab-manager.js";

const { kpdf3 } = window;

// Tabs are owned by tab-manager.js; we create the boot tab here so
// the viewer can be wired with its initial projectStore. initTabManager
// (called below, after the renderer-side scratch slots and modules are
// wired) registers this boot tab and activates it.
const _bootTab = createTabState();

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
const btnMonoPrint = $("btn-mono-print");
const btnFaxSend = $("btn-fax-send");
const btnPrintOverlayOnly = $("btn-print-overlay-only");
const ctxFaxBtn = $("ctx-fax-btn");
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
// β.80: form-field tools (申請書テンプレ) — toolbar の「フォーム」
// 1 ボタンを押すと form-palette-popup が出て、その中で 4 サブタイプ
// + 記入モードを切り替える。サブタイプボタンは popup の中にある
// が DOM 上にあるので document.getElementById で参照可能。
const btnFormPalette = $("btn-form-palette");
const btnModeFormText = $("btn-mode-form-text");
const btnModeFormCheck = $("btn-mode-form-check");
const btnModeFormCircle = $("btn-mode-form-circle");
const btnModeFormRadio = $("btn-mode-form-radio");
const btnToggleFillMode = $("btn-toggle-fill-mode");
const btnToggleTabOrder = $("btn-toggle-tab-order");
const formPalettePopup = $("form-palette-popup");
const formPaletteTitlebar = $("form-palette-titlebar");
const btnFormPaletteClose = $("form-palette-close");
// β.100 オートシェイプ palette
const btnShapePalette = $("btn-shape-palette");
const shapePalettePopup = $("shape-palette-popup");
const shapePaletteTitlebar = $("shape-palette-titlebar");
const btnShapePaletteClose = $("shape-palette-close");
const wsStatus = $("ws-status");
const viewerContainer = $("viewer-container");
const sidebar = $("sidebar");
const bookmarkTree = $("bookmark-tree");
const thumbList = $("thumb-list");
const mainArea = $("main-area");
const splitView = $("split-view");
const btnSplit = $("btn-split");
const btnModeRegionImage = $("btn-mode-region-image");
const btnRotateLeft = $("btn-rotate-left");
const btnRotateRight = $("btn-rotate-right");
const viewer = new Viewer(viewerContainer, {
  projectStore,
  onPagePointerDown: handlePagePointerDown,
  // β.80: 記入モード中はクリックを form-fill に振り、通常はそれまで通り
  // overlay-selection.handleOverlayClick に流す。ダブルクリックは作成
  // モードと同じ振る舞い (記入モードでもダブルクリックでテキスト編集
  // 入りが期待できる) を維持。
  onOverlayClick: (id, mods) => {
    if (formFillMode && handleFillModeClickOnField(id)) return;
    handleOverlayClick(id, mods);
  },
  onOverlayDblclick: handleOverlayDblclick,
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
/** @type {'none' | 'text' | 'stamp' | 'redaction' | 'marker' | 'callout' | 'form-text' | 'form-check' | 'form-circle' | 'form-radio'} */
let placementMode = "none";
// β.80: 申請書フォームの「記入モード」フラグ。true 時はフィールドを
// 配置・移動・サイズ変更できず、Tab で次のフィールドへ移動して値だけ
// 入力する。デフォルトは false (=作成/通常モード)。Phase B では state
// だけ持ち、実際の挙動は Phase C で接続する。
let formFillMode = false;
// β.82 (B-6): 「Tab 順を編集」モード。true 時は全 form_field の左上に
// 番号バッジが表示され、バッジを別の form_field にドラッグすると
// その位置に挿入される (他フィールドはずれて再採番)。記入モード /
// 通常 placement モードとは排他で、true 中はそれらを強制 OFF にする。
let tabOrderEditMode = false;
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
  // β.82 (B-5): selection が変わるたび options bar を再評価する。
  // form_field が選ばれた瞬間に専用パネルを出し、選択した overlay の
  // 現在値を select に反映 (populateFormFieldOptionsBar)。関数本体は
  // 下方に定義されているので arrow で遅延参照する。
  onSelectionChanged: () => {
    refreshModeOptionsBar();
    populateFormFieldOptionsBar();
    // β.102/β.103: shape を 1 つだけ選んだら shape palette popup の
    // 値をその overlay のものに同期する。popup が hidden でも値だけは
    // 更新しておく (次に popup を開いた時に反映)。
    if (getSelectionSize() === 1) {
      const selId = getPrimarySelectedId();
      const sel = selId ? projectStore.get(selId) : null;
      if (sel?.type === "shape") {
        _populateShapePopupFromSelection();
      }
    }
    // β.82 (B-6): Tab 順 popup が開いていれば active 行を更新
    _updateTabOrderListActive();
  },
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
initBookmarkPane({
  viewer,
  wsStatus,
  isOpen: () => isOpen,
  showRangePrompt: (opts) => showRangePrompt(opts),
});
// 白黒印刷モード state (Phase 1)。ツールバーの「白黒」トグルで切替、
// localStorage で永続化。print-flow.js が getter 経由で読みに来る。
let _monoPrintMode = false;
try {
  _monoPrintMode = localStorage.getItem("kpdf3.monoPrintMode") === "1";
} catch { /* private mode 等 — ignore */ }
function _syncMonoPrintBtn() {
  if (!btnMonoPrint) return;
  btnMonoPrint.classList.toggle("is-on", _monoPrintMode);
  btnMonoPrint.textContent = _monoPrintMode ? "白黒 ON" : "白黒";
}

initPrintFlow({
  projectStore: () => projectStore,
  viewer,
  wsStatus,
  isOpen: () => isOpen,
  splitThumbSelection: () => splitThumbSelection,
  sidebarThumbSelection: () => sidebarThumbSelection,
  isSplitMode: () => isSplitMode,
  fetchVisiblePages: () => fetchVisiblePages(),
  isMonoPrintMode: () => _monoPrintMode,
});
// β.80: 記入モード (form-fill)
initFormFill({
  projectStore: () => projectStore,
  history: () => history,
  viewer,
  isFormFillMode: () => formFillMode,
  setFormFillMode: (on) => setFormFillMode(on),
});

initTabManager({
  initialTab: _bootTab,
  viewer,
  viewerContainer,
  // Push live module-level state into a tab record (called immediately
  // before applyTab() switches). projectStore / history /
  // pendingDeletedPages / thumbCache are reference-shared with the tab
  // record, no copy needed.
  saveActiveStateInto: (tab) => {
    tab.isOpen = isOpen;
    tab.placementMode = placementMode;
    tab.activeSourceName = activeSourceName;
    tab.workspaceMutated = workspaceMutated;
    const bm = getBookmarkSnapshot();
    tab.selectedBookmarkId = bm.selectedBookmarkId;
    tab.bookmarkSource = bm.bookmarkSource;
    tab.workspaceBookmarksCache = bm.workspaceBookmarksCache;
    tab.currentSidebarTab = currentSidebarTab;
  },
  // Rebind module aliases to the given tab + rewire the viewer's
  // store + dirty/menu listeners (called by applyTab / newTabAndOpen /
  // closeTab-no-neighbour).
  applyStateFromTab: (tab) => {
    projectStore = tab.projectStore;
    history = tab.history;
    pendingDeletedPages = tab.pendingDeletedPages;
    isOpen = tab.isOpen;
    placementMode = tab.placementMode;
    activeSourceName = tab.activeSourceName;
    workspaceMutated = tab.workspaceMutated;
    // β.94: タブ切替の瞬間に bookmark DOM を即時クリア。refreshBookmarks
    // は async chain (refreshViewer 経由 fire-and-forget) で後追いで
    // 走るので、その間 DOM に前タブのしおりが残るレース条件があった。
    // clearBookmarkDom で innerHTML="" を同期実行 → 新タブの DOM は
    // 必ず空から始まる。
    clearBookmarkDom();
    setBookmarkSnapshot({
      selectedBookmarkId: tab.selectedBookmarkId,
      bookmarkSource: tab.bookmarkSource,
      workspaceBookmarksCache: tab.workspaceBookmarksCache,
    });
    currentSidebarTab = tab.currentSidebarTab;
    viewer.setProjectStore(projectStore);
    attachStoreSubscribers();
  },
  refreshViewerAfterSwitch: () => refreshViewer(),
  setOpenFalse: () => setOpen(false),
  isActiveTabDirty: () =>
    projectStore.isDirty()
    || pendingDeletedPages.size > 0
    || workspaceMutated,
  openPdfPath: (p) => openPdfPath(p),
  actionOpen: () => actionOpen(),
});

// B3-α tab tearout: build the detach payload from the live tab state
// and ship it to main, then drop the tab from this window's local
// registry. Main spawns a sibling window that adopts the tab via
// kpdf3:bootstrap-detached-tab. Called from three entry points:
// the right-click menu (setOnDetachRequest), the toolbar 「別窓化」
// button, and could be wired to a keyboard shortcut later.
async function detachTabToNewWindow(tabId, opts = {}) {
  if (!tabId) return;
  const tab = getAllTabs().get(tabId);
  if (!tab) return;
  // If detaching the active tab, snapshot live state (overlays in
  // projectStore + workspaceMutated + pendingDeletedPages live in the
  // renderer let aliases) before reading from the tab record.
  if (tabId === getActiveTabId()) saveActiveTabSnapshot();
  const payload = {
    tabId,
    sourcePdfPath: tab.activeSourcePdfPath ?? null,
    sourceName: tab.activeSourceName ?? "",
    overlays: tab.projectStore.snapshot(),
    pendingDeletedPages: [...tab.pendingDeletedPages],
    workspaceMutated: !!tab.workspaceMutated,
    selectedBookmarkId: tab.selectedBookmarkId ?? null,
    bookmarkSource: tab.bookmarkSource ?? "outline",
    scrollPosition: tab.scrollPosition || 0,
    zoom: tab.zoom ?? null,
    // B3-β: when the user drag-tearout dropped outside the bar, ship
    // the screen-relative release point so main can spawn the new
    // window near the cursor instead of next to the source window.
    atScreen: opts.atScreen ?? null,
  };
  let result;
  try {
    result = await kpdf3.detachTab(payload);
  } catch (err) {
    console.error("[detach] failed:", err);
    wsStatus.textContent = `別ウインドウへの移動に失敗: ${err.message ?? err}`;
    return;
  }
  // B3-γ race guard: if a parallel tab-bar-drop already docked the
  // tab to a sibling window, main returned alreadyMovedAway and the
  // tab-was-docked-away push has already removed it from our local
  // Map — skip transferOutTab (it'd be a no-op anyway, but the status
  // message would be misleading).
  if (result?.alreadyMovedAway) return;
  // Local cleanup: tab is now owned by the new window; remove it from
  // this window's tabs Map without disposing the main-side handle
  // (transferOutTab skips the kpdf3.closeTab IPC that closeTab uses).
  await transferOutTab(tabId);
  wsStatus.textContent = `「${tab.activeSourceName || "(新規タブ)"}」を別ウインドウへ移動しました`;
}
setOnDetachRequest((tabId) => detachTabToNewWindow(tabId));
setOnDragOut((tabId, pos) => detachTabToNewWindow(tabId, { atScreen: pos }));

// B3-γ: register active tab drag with main on dragstart so any
// sibling window's bar-drop can dock without needing the source's
// dragend (which is unreliable across BrowserWindow boundaries in
// Electron). The payload mirrors detachTabToNewWindow's so main can
// reuse it as-is when dock fires.
setOnTabDragStart((tabId) => {
  const tab = getAllTabs().get(tabId);
  if (!tab) return;
  if (tabId === getActiveTabId()) saveActiveTabSnapshot();
  const payload = {
    tabId,
    sourcePdfPath: tab.activeSourcePdfPath ?? null,
    sourceName: tab.activeSourceName ?? "",
    overlays: tab.projectStore.snapshot(),
    pendingDeletedPages: [...tab.pendingDeletedPages],
    workspaceMutated: !!tab.workspaceMutated,
    selectedBookmarkId: tab.selectedBookmarkId ?? null,
    bookmarkSource: tab.bookmarkSource ?? "outline",
    scrollPosition: tab.scrollPosition || 0,
    zoom: tab.zoom ?? null,
  };
  void kpdf3.tabDragStart(payload);
});
setOnTabDragEnd(() => {
  void kpdf3.tabDragEnd();
});

// B3-γ: main pushes this when a sibling window's tab-bar drop docked
// our tab elsewhere. Locally we just need to drop the tab from this
// window's tabs Map (workspace stays alive on main, owned by target).
kpdf3.onTabWasDockedAway?.(async (tabId) => {
  await transferOutTab(tabId);
});

// File menu「別ウインドウで開く...」 + toolbar 「別窓化」 require an
// existing PDF to detach OR a fresh PDF to open in a new window.
async function actionOpenInNewWindow() {
  const path = await showFileBrowser({ mode: "open" });
  if (!path) return;
  try {
    await kpdf3.openInNewWindow(path);
  } catch (err) {
    console.error("[new-window] open failed:", err);
    wsStatus.textContent = `別ウインドウで開けませんでした: ${err.message ?? err}`;
  }
}

// On boot in a child window spawned via spawnDetachedTabWindow, main
// pushes the detach payload over kpdf3:bootstrap-detached-tab. Adopt
// it as this window's active tab in place of the boot tab. (The hook
// is harmless on the primary window — the message is never sent there.)
// Shared callback shape for both bootstrap-detached-tab (B3-α: child
// window boots into a single tab) and adopt-docked-tab (B3-γ: an
// existing window receives a tab from another window). The differences
// are inside tab-manager (replace boot tab vs append + activate); the
// renderer-side state restore is identical.
const _adoptCallbacks = {
  onAdopt: (tab, p) => {
    projectStore = tab.projectStore;
    history = tab.history;
    pendingDeletedPages = tab.pendingDeletedPages;
    isOpen = tab.isOpen;
    placementMode = tab.placementMode;
    activeSourceName = tab.activeSourceName;
    workspaceMutated = tab.workspaceMutated;
    // Repopulate projectStore from the shipped overlays. markDirty so
    // Ctrl+S still flushes them — the source window's user hadn't saved.
    if (Array.isArray(p.overlays) && p.overlays.length > 0) {
      projectStore.reset(p.overlays);
      projectStore.markDirty();
    }
    setBookmarkSnapshot({
      selectedBookmarkId: p.selectedBookmarkId ?? null,
      bookmarkSource: p.bookmarkSource ?? "outline",
      workspaceBookmarksCache: [],
    });
    currentSidebarTab = "thumbs";
    viewer.setProjectStore(projectStore);
    attachStoreSubscribers();
  },
  refreshViewerAfterAdopt: () => refreshViewer(),
  setOpenTrue: () => setOpen(true),
};
kpdf3.onBootstrapDetachedTab(async (payload) => {
  await adoptDetachedTab(payload, _adoptCallbacks);
});
kpdf3.onAdoptDockedTab(async (payload) => {
  await adoptDockedTab(payload, _adoptCallbacks);
});

// B3-γ: report this window's tab-bar bounds to main so a sibling
// window's drag-end can resolve "did the user drop over my bar?".
// Re-report on resize, on sidebar visibility change (which moves the
// tab-bar's left edge), and after every renderTabBar call (tab count
// changes the bar's right edge). debounced via rAF.
let _tabBarRectReportRaf = 0;
function reportTabBarRect() {
  if (_tabBarRectReportRaf) return;
  _tabBarRectReportRaf = requestAnimationFrame(() => {
    _tabBarRectReportRaf = 0;
    const list = document.getElementById("tab-list");
    const bar = list?.parentElement; // .tab-bar element
    if (!bar) {
      void kpdf3.reportTabBarRect?.(null);
      return;
    }
    const r = bar.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      void kpdf3.reportTabBarRect?.(null);
      return;
    }
    void kpdf3.reportTabBarRect?.({
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
    });
  });
}
window.addEventListener("resize", reportTabBarRect);
// Sidebar toggle moves the tab-bar's left edge; viewport resize moves
// right/bottom edges. ResizeObserver on the bar catches both because
// the bar fills its parent's width.
const _tabBarEl = document.getElementById("tab-list")?.parentElement;
if (_tabBarEl && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => reportTabBarRect()).observe(_tabBarEl);
}
// Initial report after the first paint settles.
requestAnimationFrame(reportTabBarRect);


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
  } else if (placementMode === "form-text") {
    startFormTextDrag(pageNo, x, y, evt, div);
  } else if (placementMode === "form-check") {
    placeFormCheck(pageNo, x, y);
  } else if (placementMode === "form-circle") {
    placeFormCircle(pageNo, x, y);
  } else if (placementMode === "form-radio") {
    placeFormRadio(pageNo, x, y);
  } else if (placementMode === "region-image") {
    startRegionImageDrag(pageNo, x, y, evt, div);
  } else if (placementMode === "shape") {
    startShapeDrag(pageNo, x, y, evt, div);
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
$("btn-detach-tab")?.addEventListener("click", () => {
  const id = getActiveTabId();
  if (id) void detachTabToNewWindow(id);
});

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
    // β.80: 右クリック「コピー」も multi-select 対応。コンテキスト
    // メニューを開いた overlay が複数選択の一部なら全部コピー、
    // 単一なら従来通り 1 つだけ。
    const ids = getSelectedIds();
    const targetIds = ids.includes(id) && ids.length > 1 ? ids : [id];
    _overlayClipboard = targetIds
      .map((tid) => projectStore.get(tid))
      .filter(Boolean)
      .map((ov) => ({ ...ov, properties: { ...(ov.properties ?? {}) } }));
    if (_overlayClipboard.length > 0) {
      wsStatus.textContent = _overlayClipboard.length === 1
        ? `${_overlayClipboard[0].type} をコピーしました`
        : `${_overlayClipboard.length} 個のオブジェクトをコピーしました`;
    }
  } else if (action === "paste") {
    // β76: 右クリック「貼り付け」も OS 画像を優先 (paste event は
    // Ctrl+V でしか発火しないので、こちらは navigator.clipboard.read)。
    void tryPasteFromAnyClipboard();
  }
}

/** Build and add new overlay(s) from `_overlayClipboard` onto the
 *  currently-visible page, offset slightly from the original positions.
 *  β.80: multi-select 対応。クリップボード配列を一括 paste する。
 *  各 overlay は元の相対位置を維持して +12pt/+12pt 移動する。Shared by
 *  Ctrl+V and the right-click「貼り付け」menu item. */
function pasteOverlayFromClipboard() {
  if (!_overlayClipboard || _overlayClipboard.length === 0) {
    wsStatus.textContent = "貼り付けるものがありません";
    return;
  }
  const pageNo = viewer.currentPage || _overlayClipboard[0]?.pageNo || 1;
  const dx = 12;
  const dy = 12;
  const newIds = [];
  for (const src of _overlayClipboard) {
    // β.82 (B-6): form_field を paste するときは tabOrder を捨てる。
    // 重複した tabOrder は表示順を不安定にするので、新規分は auto fallback
    // (Y→X) で末尾に並ばせる方が安全。ユーザーが Tab 順編集モードで
    // 改めて並べ替える運用を前提とする。
    const props = { ...(src.properties ?? {}) };
    if (src.type === "form_field" && "tabOrder" in props) delete props.tabOrder;
    const cmd = new AddOverlayCommand(projectStore, {
      pageNo,
      type: src.type,
      x: (src.x ?? 0) + dx,
      y: (src.y ?? 0) + dy,
      w: src.w,
      h: src.h,
      zOrder: src.zOrder ?? 0,
      properties: props,
      assetId: src.assetId ?? null,
    });
    history.execute(cmd);
    if (cmd._snapshot) newIds.push(cmd._snapshot.id);
  }
  if (newIds.length === 1) {
    setSelectedOverlay(newIds[0]);
    wsStatus.textContent = `${_overlayClipboard[0].type} を貼り付けました`;
  } else if (newIds.length > 1) {
    // multi-paste 直後はまとめて選択しておくと、貼った直後の移動が
    // 一度で済む。clearSelectionState + 各 id を順次 add する。
    clearSelectionState();
    for (const id of newIds) selectOverlay(id, "add");
    wsStatus.textContent = `${newIds.length} 個のオブジェクトを貼り付けました`;
  }
}

// ---- OS clipboard image paste ----------------------------------------
//
// 「画面キャプチャ → 貼り付け」「ブラウザの画像を右クリック → コピー →
// 貼り付け」 等を K-PDF3 のページ上に画像 stamp として挿入する経路。
// addAsset は workspace SQLite に永続化、type:"stamp" + kind:"image" で
// 既存の resize handle / drag / export 経路にそのまま乗る。

const PASTE_IMAGE_MAX_BYTES = 8 * 1024 * 1024; // 8MB — 画面 cap で十分
const PASTE_IMAGE_MAX_WIDTH_PT = 200;          // 初期幅上限。ハンドルで拡縮可

/** Insert a clipboard image Blob as an image-stamp overlay centered on
 *  the visible page. Used by both the document paste event handler and
 *  the right-click「貼り付け」menu (when OS clipboard has an image). */
async function pasteImageBlob(blob, mime) {
  if (!isOpen) {
    wsStatus.textContent = "PDF を開いてから貼り付けてください";
    return;
  }
  if (blob.size > PASTE_IMAGE_MAX_BYTES) {
    wsStatus.textContent = `画像が大きすぎます (${Math.round(blob.size / 1024 / 1024)}MB > 8MB)`;
    return;
  }
  // Natural size 計測 — Image() は async load。終わったら URL を解放。
  const blobUrl = URL.createObjectURL(blob);
  let imgW = 0, imgH = 0;
  try {
    await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => { imgW = img.naturalWidth; imgH = img.naturalHeight; res(); };
      img.onerror = rej;
      img.src = blobUrl;
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  if (!imgW || !imgH) {
    wsStatus.textContent = "画像のサイズを取得できませんでした";
    return;
  }
  const ab = await blob.arrayBuffer();
  const u8 = new Uint8Array(ab);
  const asset = await kpdf3.addAsset({
    mime: mime || blob.type || "image/png",
    blob: u8,
    width: imgW,
    height: imgH,
    label: `clipboard-${Date.now()}`,
  });
  if (!asset?.id) {
    wsStatus.textContent = "画像の登録に失敗しました";
    return;
  }
  // 配置先ページの canonical 寸法 (pre-rotation) に userRotation で
  // swap を反映。viewer.currentPage は scroll で更新される値。
  const pageNo = viewer.currentPage || 1;
  const row = viewer._pages?.find((p) => p.pageNo === pageNo);
  const cw = row?.cropW ?? row?.width ?? 595;
  const ch = row?.cropH ?? row?.height ?? 842;
  const userRot = (((row?.userRotation ?? 0) % 360) + 360) % 360;
  const swap = userRot === 90 || userRot === 270;
  const pageW = swap ? ch : cw;
  const pageH = swap ? cw : ch;
  // 1px = 1pt (72dpi 換算) の素朴 mapping。スマホ写真等の巨大画像は
  // PASTE_IMAGE_MAX_WIDTH_PT で頭打ち。さらにページ高 80% 超なら高さ基準。
  const ratio = imgH / imgW;
  let w = Math.min(PASTE_IMAGE_MAX_WIDTH_PT, imgW);
  let h = w * ratio;
  if (h > pageH * 0.8) {
    h = pageH * 0.8;
    w = h / ratio;
  }
  const x = Math.max(0, (pageW - w) / 2);
  const y = Math.max(0, (pageH - h) / 2);
  const cmd = new AddOverlayCommand(projectStore, {
    pageNo,
    type: "stamp",
    x, y, w, h,
    zOrder: 0,
    properties: {
      kind: "image",
      stampKind: "image",
      assetId: asset.id,
      label: "clipboard-image",
      text: "",
      color: "",
      frame: "none",
      fontSize: 14,
      rotation: 0,
    },
  });
  history.execute(cmd);
  if (cmd._snapshot) setSelectedOverlay(cmd._snapshot.id);
  wsStatus.textContent = `画像を貼り付けました (${Math.round(w)}×${Math.round(h)}pt, ${imgW}×${imgH}px)`;
}

/** OS クリップボードに画像があれば貼り付け、なければ内部 _overlayClipboard
 *  にフォールバック。右クリック「貼り付け」とメニューバー「貼り付け」
 *  はこちらを呼ぶ (paste event は Ctrl+V ネイティブ経路で別途発火)。 */
async function tryPasteFromAnyClipboard() {
  // navigator.clipboard.read は permission 要 / async API。Electron では
  // 通常許可されているが念のため try で囲んでフォールバック。
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (/^image\/(png|jpe?g|webp)$/i.test(type)) {
          const blob = await item.getType(type);
          await pasteImageBlob(blob, type);
          return;
        }
      }
    }
  } catch {
    // permission denied / API unsupported — fall through to internal.
  }
  if (_overlayClipboard) {
    pasteOverlayFromClipboard();
  } else {
    wsStatus.textContent = "貼り付けるものがありません";
  }
}

// Document-level paste event: Ctrl+V のブラウザネイティブ経路で発火。
// clipboardData.items から画像を直接取れるので、navigator.clipboard.read
// の permission ダイアログを避けられて高速。
document.addEventListener("paste", (e) => {
  if (!isOpen) return;
  // 入力欄 / inline-edit 中は素通し (テキスト paste をブラウザに任せる)。
  if (viewer._editingId) return;
  const t = e.target;
  if (t) {
    const tag = (t.tagName ?? "").toLowerCase();
    if (tag === "input" || tag === "textarea" || t.isContentEditable) return;
  }
  const items = e.clipboardData?.items;
  if (items) {
    for (const it of items) {
      if (it.kind === "file" && /^image\/(png|jpe?g|webp)$/i.test(it.type)) {
        e.preventDefault();
        const file = it.getAsFile();
        if (file) void pasteImageBlob(file, it.type);
        return;
      }
    }
  }
  // 画像なし → 内部 overlay クリップボードへフォールバック。
  if (_overlayClipboard) {
    e.preventDefault();
    pasteOverlayFromClipboard();
  }
});

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
// β.80: 記入モード時の Tab / Space / Enter / Esc を最優先で捕捉。
// capture phase に居るので、デフォルトのブラウザ Tab フォーカス移動や
// 他の keydown listener より先に preventDefault できる。記入モードで
// 無いときは form-fill ハンドラ自身が早期 return するので干渉しない。
document.addEventListener("keydown", (e) => {
  handleFillModeKeydown(e);
}, { capture: true });
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
  const choice = await showFileBrowser({
    mode: "save",
    title:
      rows.length === 1
        ? `ページ ${rows[0].pageNo > 0 ? rows[0].pageNo : "挿入"} を PDF として保存`
        : `${rows.length} ページを PDF として保存`,
    initialName,
    defaultDir: defaults.sourceDir,
    secureExportToggle: true,
  });
  if (!choice) return;
  const { path: savePath, secureExport } = choice;
  showBusy("保存", `${rows.length} ページを書き出し中...`, 0);
  try {
    const composed = await composePagesForExport({
      pages: rows,
      projectStore,
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
      rasterRedactionPages: true,
      onProgress: ({ done, total }) => {
        updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
      },
    });
    updateBusy("PDF を組み立て中...", 90);
    const result = await kpdf3.exportPdfRasterized({
      savePath,
      pages: composed,
      secureExport,
    });
    hideBusy();
    wsStatus.textContent = `${savePath} に保存しました（${rows.length} ページ, rev ${(result?.revisionId ?? "").slice(0, 8)}）`;
    if (secureExport && result?.qpdfMissing) {
      await customConfirm({
        title: "セキュア書き出し: qpdf 未検出",
        message:
          "qpdf バイナリが見つからなかったため、個人情報の消去をスキップして\n"
          + "通常の書き出しを行いました。",
        okLabel: "閉じる",
        cancelLabel: null,
      });
    }
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
// Phase 2: FAX ボタン context menu の click/outside/Esc クローズ。
// thumb context menu と同じ document-level 動線に相乗りする。
if (ctxFaxBtn) ctxFaxBtn.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("pointerdown", (ev) => {
  if (ev.target instanceof Node) {
    if (ctxThumb.contains(ev.target)) return;
    if (ctxFaxBtn && ctxFaxBtn.contains(ev.target)) return;
  }
  hideThumbContextMenu();
  if (ctxFaxBtn) ctxFaxBtn.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideThumbContextMenu();
    if (ctxFaxBtn) ctxFaxBtn.hidden = true;
  }
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

/** @type {Array<import("../domain/project-store.js").Overlay>} */
let _overlayClipboard = [];

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
    // β.80: multi-select 全部をコピー。getSelectedIds は選択順を維持
    // しないが、paste 側はオフセット +12 で一括配置するので順序は
    // 重要ではない (相対位置はそのまま再現される)。
    const ids = getSelectedIds();
    if (ids.length === 0) return;
    _overlayClipboard = ids
      .map((id) => projectStore.get(id))
      .filter(Boolean)
      .map((ov) => ({ ...ov, properties: { ...(ov.properties ?? {}) } }));
    if (_overlayClipboard.length === 0) return;
    e.preventDefault();
    wsStatus.textContent = _overlayClipboard.length === 1
      ? `${_overlayClipboard[0].type} をコピーしました`
      : `${_overlayClipboard.length} 個のオブジェクトをコピーしました`;
  }
  // β76: Ctrl+V は preventDefault せず、ブラウザネイティブの paste event
  // に任せる (上の document.addEventListener("paste") が一括処理)。
  // OS クリップボード画像があればそれを優先、なければ _overlayClipboard。
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
  if (btnModeRegionImage) btnModeRegionImage.classList.toggle("toggled", mode === "region-image");
  if (btnShapePalette) btnShapePalette.classList.toggle("toggled", mode === "shape");
  if (shapePalettePopup) {
    // shape popup は shape mode と同期: mode ON で popup 表示、OFF で隠す。
    if (mode === "shape") shapePalettePopup.hidden = false;
    else shapePalettePopup.hidden = true;
  }
  // β.80: form-* tool toggle highlights
  if (btnModeFormText) btnModeFormText.classList.toggle("toggled", mode === "form-text");
  if (btnModeFormCheck) btnModeFormCheck.classList.toggle("toggled", mode === "form-check");
  if (btnModeFormCircle) btnModeFormCircle.classList.toggle("toggled", mode === "form-circle");
  if (btnModeFormRadio) btnModeFormRadio.classList.toggle("toggled", mode === "form-radio");
  syncStampGhostMode();
  syncStampPalettePopup();
  refreshMenuState();
  refreshModeOptionsBar();
}

/** β.80: 「記入」トグル — 作成モード ↔ 記入モードの切替。記入モードで
 *  は placementMode を強制 none にし、フォームフィールドの位置/サイズ
 *  変更を無効化する。Phase C で Tab nav と入力フォーカスを接続する。 */
function setFormFillMode(on) {
  formFillMode = !!on;
  if (formFillMode && placementMode !== "none") setPlacementMode("none");
  if (btnToggleFillMode) {
    btnToggleFillMode.classList.toggle("toggled", formFillMode);
    btnToggleFillMode.textContent = formFillMode ? "作成へ" : "記入";
    btnToggleFillMode.title = formFillMode
      ? "作成モードに戻す (フィールドを配置・移動できます)"
      : "記入モードへ (Tab で次のフィールドへ移動して値を入力)";
  }
  document.body.classList.toggle("form-fill-mode", formFillMode);
  // β.82 (B-5): 記入モード切替時も options bar の表示を再評価する。
  // 記入モード入りで「選択中 form_field → 後付け編集パネル表示」が
  // 残ってしまうのを抑止する。
  refreshModeOptionsBar();
  if (formFillMode) {
    // 記入モード ON: Tab 順編集モードと排他
    if (tabOrderEditMode) setTabOrderEditMode(false);
    // 記入モードに入ったら、現在表示中のページに合わせて最初のフィールド
    // にフォーカスする。フィールドが 1 つも無いときは黙って何もしない
    // (ユーザーが先にフィールドを配置してから記入する想定)。
    invalidateTabOrderCache();
    formFillFocusFirst();
  } else {
    setFormFocusedFieldId(null);
  }
}

// ---- β.82 (B-6) Tab 順編集モード -------------------------------------
//
// 全 form_field の左上に「現在の Tab 順」を示す赤い番号バッジを表示。
// バッジを別のフィールドへドラッグすると、その位置に挿入される
// (他フィールドの tabOrder は連番で振り直し)。
//
// _tabOrderObserver: viewer がスクロール / zoom / ストア更新で overlay
// DOM を再構築するたびに新しい .overlay-form_field が増減する。すべての
// 経路を hook せずに済むよう MutationObserver で viewer-container を
// 監視し、増えた form_field 要素にバッジを後付けする方式。
let _tabOrderObserver = null;

function setTabOrderEditMode(on) {
  const next = !!on;
  if (next === tabOrderEditMode) return;
  tabOrderEditMode = next;
  document.body.classList.toggle("form-tab-order-edit-mode", tabOrderEditMode);
  if (btnToggleTabOrder) {
    btnToggleTabOrder.classList.toggle("toggled", tabOrderEditMode);
    btnToggleTabOrder.textContent = tabOrderEditMode ? "Tab 順を終える" : "Tab 順を編集";
  }
  if (tabOrderEditMode) {
    // 排他制御 — 記入モード / 作成 placement モードを OFF にする
    if (formFillMode) setFormFillMode(false);
    if (placementMode !== "none") setPlacementMode("none");
    // 既存フィールドに tabOrder を一括で割り当て (未付与のものだけ。
    // 既に explicit がある場合は壊さない)
    _initTabOrdersIfMissing();
    _attachTabOrderObserver();
    renderTabOrderBadges();
    showTabOrderListPopup(true);
    renderTabOrderListPopup();
  } else {
    _detachTabOrderObserver();
    removeTabOrderBadges();
    showTabOrderListPopup(false);
  }
}

/** Tab 順編集モード初回エントリ: tabOrder を持たない form_field に、
 *  現在の合成順 (explicit + auto) のインデックス+1 を割り振る。すでに
 *  explicit が混在しているときは「auto 側だけに max(explicit)+1 から
 *  振っていく」形で衝突を避ける。1 commit に集約して 1 undo unit。 */
function _initTabOrdersIfMissing() {
  const order = getCurrentTabOrder();
  if (order.length === 0) return;
  // explicit 既存値の最大を出す
  let maxExisting = 0;
  for (const rec of order) {
    if (rec.tabOrder != null && rec.tabOrder > maxExisting) maxExisting = rec.tabOrder;
  }
  const updates = [];
  let nextAuto = maxExisting + 1;
  for (const rec of order) {
    if (rec.tabOrder != null) continue; // 既存 explicit はそのまま
    const ov = projectStore.get(rec.id);
    if (!ov) continue;
    updates.push(new UpdateOverlayCommand(projectStore, rec.id, {
      properties: { ...ov.properties, tabOrder: nextAuto },
    }));
    nextAuto += 1;
  }
  if (updates.length > 0) {
    history.execute(new CompositeCommand(updates, "Init Tab order"));
  }
}

/** バッジを (再)描画。viewer-container 配下のすべての .overlay-form_field
 *  要素について、対応する overlay の Tab 順インデックス+1 を表示する。 */
function renderTabOrderBadges() {
  if (!viewerContainer) return;
  const order = getCurrentTabOrder();
  const indexById = new Map();
  for (let i = 0; i < order.length; i++) indexById.set(order[i].id, i + 1);
  const els = viewerContainer.querySelectorAll(".overlay-form_field");
  for (const el of els) {
    const id = el.dataset.overlayId;
    if (!id) continue;
    let badge = el.querySelector(":scope > .form-tab-order-badge");
    const idx = indexById.get(id);
    if (idx == null) {
      if (badge) badge.remove();
      continue;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "form-tab-order-badge";
      badge.dataset.tabOrderFor = id;
      badge.addEventListener("pointerdown", _onTabOrderBadgePointerDown);
      // 通常クリック / drag を阻害しないように
      badge.addEventListener("click", (e) => e.stopPropagation());
      badge.addEventListener("dblclick", (e) => e.stopPropagation());
      el.appendChild(badge);
    }
    badge.textContent = String(idx);
  }
}

function removeTabOrderBadges() {
  if (!viewerContainer) return;
  for (const b of viewerContainer.querySelectorAll(".form-tab-order-badge")) {
    b.remove();
  }
}

function _attachTabOrderObserver() {
  if (_tabOrderObserver || !viewerContainer) return;
  _tabOrderObserver = new MutationObserver(() => {
    if (!tabOrderEditMode) return;
    // viewer が overlay layer を rebuild した可能性。バッジを貼り直す。
    // requestAnimationFrame で同フレームの DOM 確定後にまとめて反映。
    if (_badgeRenderScheduled) return;
    _badgeRenderScheduled = true;
    requestAnimationFrame(() => {
      _badgeRenderScheduled = false;
      if (tabOrderEditMode) renderTabOrderBadges();
    });
  });
  _tabOrderObserver.observe(viewerContainer, { childList: true, subtree: true });
}

function _detachTabOrderObserver() {
  if (_tabOrderObserver) {
    _tabOrderObserver.disconnect();
    _tabOrderObserver = null;
  }
}
let _badgeRenderScheduled = false;

/** badge.pointerdown ハンドラ。Tab 順編集モード時のみバッジに addEventListener。 */
function _onTabOrderBadgePointerDown(e) {
  if (!tabOrderEditMode) return;
  const badge = e.currentTarget;
  if (!(badge instanceof HTMLElement)) return;
  const fromId = badge.dataset.tabOrderFor;
  if (!fromId) return;
  e.preventDefault();
  e.stopPropagation();
  const pointerId = e.pointerId;
  try { badge.setPointerCapture(pointerId); } catch { /* ignore */ }

  /** @type {HTMLElement | null} */
  let dropTarget = null;

  const onMove = (ev) => {
    if (ev.pointerId !== pointerId) return;
    // バッジ自身が elementFromPoint を遮らないように一時無効化
    badge.style.pointerEvents = "none";
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    badge.style.pointerEvents = "";
    /** @type {HTMLElement | null} */
    const tgt = under?.closest?.(".overlay-form_field") ?? null;
    const tgtId = tgt?.dataset.overlayId;
    if (dropTarget && dropTarget !== tgt) {
      dropTarget.classList.remove("tab-order-drop-target");
      dropTarget = null;
    }
    if (tgt && tgtId && tgtId !== fromId) {
      tgt.classList.add("tab-order-drop-target");
      dropTarget = tgt;
    }
  };
  const cleanup = () => {
    try { badge.releasePointerCapture(pointerId); } catch { /* ignore */ }
    badge.removeEventListener("pointermove", onMove);
    badge.removeEventListener("pointerup", onUp);
    badge.removeEventListener("pointercancel", onCancel);
    if (dropTarget) dropTarget.classList.remove("tab-order-drop-target");
  };
  const onUp = (ev) => {
    if (ev.pointerId !== pointerId) return;
    const toId = dropTarget?.dataset.overlayId ?? null;
    cleanup();
    if (toId && toId !== fromId) {
      _commitTabOrderInsert(fromId, toId);
    }
  };
  const onCancel = (ev) => {
    if (ev.pointerId !== pointerId) return;
    cleanup();
  };
  badge.addEventListener("pointermove", onMove);
  badge.addEventListener("pointerup", onUp);
  badge.addEventListener("pointercancel", onCancel);
}

/** fromId を toId の位置に挿入する。全 form_field の tabOrder を再採番
 *  して、1 つの CompositeCommand として実行する (1 undo unit)。 */
function _commitTabOrderInsert(fromId, toId) {
  const order = getCurrentTabOrder();
  const fromIdx = order.findIndex((r) => r.id === fromId);
  const toIdx = order.findIndex((r) => r.id === toId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
  const [moved] = order.splice(fromIdx, 1);
  // toIdx が fromIdx より後ろなら splice 後に 1 つ左にシフトしている。
  const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
  order.splice(insertAt, 0, moved);
  const updates = [];
  for (let i = 0; i < order.length; i++) {
    const ov = projectStore.get(order[i].id);
    if (!ov) continue;
    const newOrder = i + 1;
    const cur = ov.properties?.tabOrder;
    if (cur === newOrder) continue;
    updates.push(new UpdateOverlayCommand(projectStore, order[i].id, {
      properties: { ...ov.properties, tabOrder: newOrder },
    }));
  }
  if (updates.length > 0) {
    history.execute(new CompositeCommand(updates, "Reorder Tab"));
    wsStatus.textContent = `Tab 順を更新しました (${updates.length} 件)`;
  }
}

// ---- β.82 (B-6) Tab 順リスト popup -----------------------------------
//
// バッジが小さい枠で見切れたり field 本体を覆ったりするので、別 UI と
// して縦並びのリスト popup を提供する:
//   - 全 form_field を Tab 順に並べ、各行に「番号 / ページ / 種類 / 値」
//   - 行を上下にドラッグして並べ替え (commit は CompositeCommand)
//   - 行クリック (drag せず) で対応 overlay を選択 + 中央スクロール
//     + 1 秒の pulse highlight。「これからこの枠の順番を変えるんだ」と
//     ユーザーに視覚的に教える
// popup の表示は setTabOrderEditMode で連動 (mode ON で出現、OFF で隠す)。

const tabOrderListPopup = $("tab-order-list-popup");
const tabOrderListBody  = $("tab-order-list-body");
const tabOrderListEmpty = $("tab-order-list-empty");
const tabOrderListTitlebar = $("tab-order-list-titlebar");
const tabOrderListClose = $("tab-order-list-close");
const TAB_ORDER_POPUP_POS_KEY = "kpdf3.tabOrderPopupPos";

function showTabOrderListPopup(visible) {
  if (!tabOrderListPopup) return;
  tabOrderListPopup.hidden = !visible;
}

/** form_field を 1 行で説明する短いラベルを返す。値プレビューは text
 *  サブタイプのみ、最大 18 文字でクリップ。 */
function _describeFormField(ov) {
  const p = ov.properties || {};
  const pageNo = ov.pageNo;
  const pageLabel = pageNo > 0 ? `p${pageNo}` : `p${-pageNo}*`;
  const kind = p.fieldKind;
  if (kind === "text") {
    const val = String(p.value ?? "").replace(/\s+/g, " ").trim();
    const preview = val ? val.slice(0, 18) + (val.length > 18 ? "…" : "") : "(空欄)";
    return `${pageLabel}  枠  ${preview}`;
  }
  if (kind === "check") {
    const sym = p.checkStyle || "✓";
    return `${pageLabel}  ${sym} チェック`;
  }
  if (kind === "circle") return `${pageLabel}  〇 丸囲み`;
  if (kind === "radio") {
    const sym = p.checkStyle || "●";
    const grp = p.radioGroupId || "default";
    return `${pageLabel}  ${sym} ラジオ (${grp})`;
  }
  return `${pageLabel}  ${kind ?? "?"}`;
}

/** Popup の中身を現在の Tab 順で再構築。Mode が OFF の間は空 (skip)。 */
function renderTabOrderListPopup() {
  if (!tabOrderListPopup || tabOrderListPopup.hidden) return;
  if (!tabOrderListBody) return;
  const order = getCurrentTabOrder();
  tabOrderListBody.innerHTML = "";
  if (tabOrderListEmpty) tabOrderListEmpty.hidden = order.length > 0;
  if (order.length === 0) return;
  // 選択中なら active 行をマークするため id を控える
  const selId = getPrimarySelectedId();
  for (let i = 0; i < order.length; i++) {
    const rec = order[i];
    const ov = projectStore.get(rec.id);
    if (!ov) continue;
    const row = document.createElement("div");
    row.className = "tab-order-list-row";
    if (rec.id === selId) row.classList.add("active");
    row.dataset.overlayId = rec.id;
    const num = document.createElement("span");
    num.className = "tab-order-list-num";
    num.textContent = String(i + 1);
    row.appendChild(num);
    const lbl = document.createElement("span");
    lbl.className = "tab-order-list-label";
    lbl.textContent = _describeFormField(ov);
    row.appendChild(lbl);
    row.addEventListener("pointerdown", _onTabOrderListPointerDown);
    tabOrderListBody.appendChild(row);
  }
}

/** 選択中の overlay と一致する行に .active を付ける (リスト全再構築は
 *  しない)。onSelectionChanged から呼ばれる軽量更新。 */
function _updateTabOrderListActive() {
  if (!tabOrderListBody) return;
  const selId = getPrimarySelectedId();
  for (const r of tabOrderListBody.querySelectorAll(".tab-order-list-row")) {
    r.classList.toggle("active", r.dataset.overlayId === selId);
  }
}

/** リスト行の pointerdown — 4px 以上動いたら drag、そうでなければ click。
 *  drag は document に listener を貼って、行を DOM 順序として動かす。
 *  pointerup で DOM 順序を読み取って CompositeCommand を発行する。 */
function _onTabOrderListPointerDown(e) {
  if (e.button !== 0) return;
  const row = e.currentTarget;
  if (!(row instanceof HTMLElement)) return;
  const id = row.dataset.overlayId;
  if (!id) return;
  e.preventDefault();
  const pointerId = e.pointerId;
  const startX = e.clientX;
  const startY = e.clientY;
  let started = false;

  const onMove = (ev) => {
    if (!started) {
      const dist = Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY);
      if (dist < 4) return;
      started = true;
      row.classList.add("dragging");
      try { row.setPointerCapture(pointerId); } catch { /* ignore */ }
    }
    // 行自身を一時無効化して下にある行を取得
    row.style.pointerEvents = "none";
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    row.style.pointerEvents = "";
    const overRow = under?.closest?.(".tab-order-list-row");
    if (overRow && overRow !== row && overRow.parentNode === row.parentNode) {
      const rect = overRow.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      if (before) overRow.parentNode.insertBefore(row, overRow);
      else overRow.parentNode.insertBefore(row, overRow.nextSibling);
    }
  };
  const cleanup = () => {
    try { row.releasePointerCapture(pointerId); } catch { /* ignore */ }
    row.classList.remove("dragging");
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
  };
  const onUp = (ev) => {
    if (ev.pointerId !== pointerId) return;
    cleanup();
    if (started) {
      _commitTabOrderListReorder();
    } else {
      // 移動していない = クリック扱い: 本文の対応 overlay を強調
      _focusFormFieldFromList(id);
    }
  };
  const onCancel = (ev) => {
    if (ev.pointerId !== pointerId) return;
    cleanup();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

/** DOM 上の行順を読み取って tabOrder を 1..N に再採番。 */
function _commitTabOrderListReorder() {
  if (!tabOrderListBody) return;
  const rows = Array.from(tabOrderListBody.querySelectorAll(".tab-order-list-row"));
  const updates = [];
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i].dataset.overlayId;
    if (!id) continue;
    const ov = projectStore.get(id);
    if (!ov) continue;
    const newOrder = i + 1;
    if (ov.properties?.tabOrder === newOrder) continue;
    updates.push(new UpdateOverlayCommand(projectStore, id, {
      properties: { ...ov.properties, tabOrder: newOrder },
    }));
  }
  if (updates.length > 0) {
    history.execute(new CompositeCommand(updates, "Reorder Tab (list)"));
    wsStatus.textContent = `Tab 順を更新しました (${updates.length} 件)`;
  }
}

/** リスト行クリック時: 本文の対応 overlay を選択 + 中央スクロール +
 *  pulse highlight。Tab 順編集中も is-selected が乗るので、ユーザーは
 *  「次に並べ替えの対象になる枠」を視覚的に把握できる。 */
function _focusFormFieldFromList(id) {
  if (!id) return;
  setSelectedOverlay(id);
  if (!viewerContainer) return;
  const escaped =
    globalThis.CSS?.escape?.(id) ??
    String(id).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  const el = viewerContainer.querySelector(`.overlay[data-overlay-id="${escaped}"]`);
  if (!el) return;
  try {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  } catch {
    el.scrollIntoView();
  }
  // pulse: クラスを 1 度外して付け直し、animation を再トリガ
  el.classList.remove("tab-order-pulse");
  // reflow を強制してから付け直す (browser がアニメーションを再生)
  // eslint-disable-next-line no-unused-expressions
  void el.offsetWidth;
  el.classList.add("tab-order-pulse");
  setTimeout(() => el.classList.remove("tab-order-pulse"), 1100);
}

// Popup を draggable にする (form palette と同じ仕組み)
if (tabOrderListPopup && tabOrderListTitlebar) {
  const restorePos = () => {
    try {
      const saved = localStorage.getItem(TAB_ORDER_POPUP_POS_KEY);
      if (!saved) return;
      const { left, top } = JSON.parse(saved);
      if (typeof left !== "number" || typeof top !== "number") return;
      const w = tabOrderListPopup.offsetWidth || 260;
      const h = tabOrderListPopup.offsetHeight || 300;
      const cl = Math.max(0, Math.min(window.innerWidth - w, left));
      const ct = Math.max(0, Math.min(window.innerHeight - h, top));
      tabOrderListPopup.style.left = `${cl}px`;
      tabOrderListPopup.style.top = `${ct}px`;
    } catch { /* ignore */ }
  };
  restorePos();
  const obs = new MutationObserver(() => {
    if (!tabOrderListPopup.hidden) restorePos();
  });
  obs.observe(tabOrderListPopup, { attributes: true, attributeFilter: ["hidden"] });

  let pdrag = null;
  tabOrderListTitlebar.addEventListener("pointerdown", (e) => {
    if (e.target instanceof HTMLElement && e.target.id === "tab-order-list-close") return;
    const rect = tabOrderListPopup.getBoundingClientRect();
    pdrag = { pointerId: e.pointerId, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
    try { tabOrderListTitlebar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  tabOrderListTitlebar.addEventListener("pointermove", (e) => {
    if (!pdrag || pdrag.pointerId !== e.pointerId) return;
    const x = e.clientX - pdrag.offsetX;
    const y = e.clientY - pdrag.offsetY;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = tabOrderListPopup.offsetWidth, h = tabOrderListPopup.offsetHeight;
    tabOrderListPopup.style.left = `${Math.max(0, Math.min(vw - w, x))}px`;
    tabOrderListPopup.style.top  = `${Math.max(0, Math.min(vh - h, y))}px`;
  });
  tabOrderListTitlebar.addEventListener("pointerup", (e) => {
    if (!pdrag || pdrag.pointerId !== e.pointerId) return;
    try { tabOrderListTitlebar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    pdrag = null;
    try {
      const left = parseFloat(tabOrderListPopup.style.left) || 0;
      const top = parseFloat(tabOrderListPopup.style.top) || 0;
      localStorage.setItem(TAB_ORDER_POPUP_POS_KEY, JSON.stringify({ left, top }));
    } catch { /* ignore */ }
  });
}
if (tabOrderListClose) {
  tabOrderListClose.addEventListener("click", () => setTabOrderEditMode(false));
}

/** Toggle the mode-options bar + the per-mode child visible to match
 *  the current placementMode. text and callout share the same options
 *  row (font + size). When mode is "none", the bar collapses entirely.
 *  β.80: form-text / form-check / form-circle / form-radio each have
 *  their own options panel keyed by `data-mode`.
 *  β.82 (B-5 i): placementMode が none でも、form_field を 1 つだけ
 *  選択中なら fieldKind に対応するパネルを表示する。これで「枠」モード
 *  に入り直さずに配置済みフィールドの体裁を後付け編集できる。記入
 *  モード中は値入力に集中させるため発動しない (formFillMode === true
 *  で抑止)。 */
function refreshModeOptionsBar() {
  const bar = $("mode-options-bar");
  if (!bar) return;
  let which;
  if (placementMode === "callout") {
    which = "text";
  } else if (placementMode !== "none") {
    which = placementMode;
  } else if (!formFillMode && getSelectionSize() === 1) {
    const selId = getPrimarySelectedId();
    const ov = selId ? projectStore.get(selId) : null;
    if (ov?.type === "form_field") {
      const kind = ov.properties?.fieldKind;
      which =
        kind === "text"   ? "form-text"   :
        kind === "check"  ? "form-check"  :
        kind === "circle" ? "form-circle" :
        kind === "radio"  ? "form-radio"  : null;
    } else {
      which = null;
    }
  } else {
    which = null;
  }
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
  if (btnModeRegionImage) btnModeRegionImage.disabled = !open;
  if (btnMonoPrint) btnMonoPrint.disabled = !open;
  if (btnFaxSend) btnFaxSend.disabled = !open;
  if (btnPrintOverlayOnly) btnPrintOverlayOnly.disabled = !open;
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
  // β.80: form-field — popup と中身のボタンは toolbar の「フォーム」
  // ボタンの開閉で扱う。中ボタンの disabled は影響しない (popup 自体
  // が hidden だとクリック不能だが、保険として open 連動で disable)
  if (btnFormPalette) btnFormPalette.disabled = !open;
  if (btnShapePalette) btnShapePalette.disabled = !open;
  if (btnModeFormText) btnModeFormText.disabled = !open;
  if (btnModeFormCheck) btnModeFormCheck.disabled = !open;
  if (btnModeFormCircle) btnModeFormCircle.disabled = !open;
  if (btnModeFormRadio) btnModeFormRadio.disabled = !open;
  if (btnToggleFillMode) btnToggleFillMode.disabled = !open;
  if (btnToggleTabOrder) btnToggleTabOrder.disabled = !open;
  const btnPageNums = $("btn-page-numbers");
  if (btnPageNums) btnPageNums.disabled = !open;
  const btnPagePopup = $("btn-page-popup");
  if (btnPagePopup) btnPagePopup.disabled = !open;
  const btnDetachTab = $("btn-detach-tab");
  if (btnDetachTab) btnDetachTab.disabled = !open;
  // (stampTemplateSel / stampColorSel removed — palette buttons are
  // managed by rebuildStampPalette + the mode-options bar visibility.)
  if (!open) {
    setPlacementMode("none");
    if (formFillMode) setFormFillMode(false);
    if (tabOrderEditMode) setTabOrderEditMode(false);
    if (formPalettePopup) formPalettePopup.hidden = true;
    if (btnFormPalette) btnFormPalette.classList.remove("toggled");
    if (shapePalettePopup) shapePalettePopup.hidden = true;
    if (btnShapePalette) btnShapePalette.classList.remove("toggled");
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
    "export-image": isOpen,
    "export-region-image": isOpen,
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
    // β.80: form_field の add/remove/update で Tab 順キャッシュを無効化。
    // page 並び替えは event.kind="reset" で reset され、その後の
    // page-registry rebuild 後に次回参照で再計算される。
    invalidateTabOrderCache();
    // β.82 (B-6): Tab 順リスト popup が開いていれば再描画
    // (drag 中の本人入れ替えは popup の DOM 操作で済んでいるが、後付け
    // 編集や別経路の add/remove も popup ラベルに反映するため)。
    if (tabOrderEditMode && tabOrderListPopup && !tabOrderListPopup.hidden) {
      renderTabOrderListPopup();
    }
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
  // Drop any prior annotations so load() doesn't briefly paint the old PDF's
  // annotations on the new PDF's pages — setAnnotations re-fires below.
  viewer.setAnnotations(null);
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
  // C3 annotation read-only proxy. Fetch in parallel with the user's first
  // interactions — markers fade in once data arrives. Main caches per tab so
  // refreshViewer re-entries during this session are cheap.
  try {
    const annots = await kpdf3.getAllAnnotations();
    viewer.setAnnotations(annots && Object.keys(annots).length > 0 ? annots : null);
  } catch (err) {
    console.warn("[annotations] fetch failed", err);
    viewer.setAnnotations(null);
  }
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
  for (const [, tab] of getAllTabs()) {
    if (tabIsDirty(tab)) dirtyTabs.push(tab);
  }
  if (dirtyTabs.length === 0) return true;
  const lines = dirtyTabs.map((t) => `  • ${t.activeSourceName || "(新規タブ)"}`).join("\n");
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
    const result = await kpdf3.openPdfFile(pdfPath, getActiveTabId());
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
 * β.97: parse a multi-segment page range like "1-3,5,7-10" into a sorted,
 * de-duplicated array of 1-based page numbers. Empty input or any segment
 * that goes out of bounds (1..total) → null. Spaces are tolerated.
 *
 * @param {string} input
 * @param {number} total
 * @returns {number[] | null}
 */
function parseMultiPageRange(input, total) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const out = new Set();
  for (const seg of s.split(",")) {
    const t = seg.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    if (a < 1 || b > total || a > b) return null;
    for (let i = a; i <= b; i++) out.add(i);
  }
  if (out.size === 0) return null;
  return [...out].sort((x, y) => x - y);
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
    // preceding source page (for legacy afterPageNo slot semantics) and
    // to the page immediately before the gap (for the β77 visual-
    // position display_order computation).
    {
      let anchor = 0;
      for (let k = part.start - 1; k >= 0; k--) {
        if (!pages[k].isSynthetic) {
          anchor = pages[k].pageNo;
          break;
        }
      }
      const afterKey =
        part.start === 0 ? 0 : pages[part.start - 1].pageNo;
      row.appendChild(makeSplitInsertGap(anchor, null, afterKey));
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
      // β77: afterKey = the page right before this gap (positive for
      // source, negative for synth). Drives the visual-position
      // display_order so the drop lands exactly between pages[i] and
      // pages[i+1] regardless of reorder state.
      cell.appendChild(
        makeSplitInsertGap(anchor, orderInSlot, pages[i].pageNo),
      );
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
  // Paper-size badge for non-A4 sources (A3/A5/B4/B5/Letter/Legal) —
  // sidebar サムネと同じ規則。分割画面でも混在 PDF を一目で見分けたい。
  const _spCw = pageRow.cropW ?? pageRow.width ?? 595;
  const _spCh = pageRow.cropH ?? pageRow.height ?? 842;
  const _spSizeName = detectPaperSize(_spCw, _spCh);
  if (_spSizeName && _spSizeName !== "A4") {
    const badge = document.createElement("span");
    badge.className = "thumb-size-badge";
    badge.textContent = _spSizeName;
    wrap.appendChild(badge);
  }
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
        rasterRedactionPages: true,
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
  const choice = await showFileBrowser({
    mode: "save",
    title: "範囲書き出し",
    initialName: defaults.defaultName ?? "export.pdf",
    defaultDir: defaults.sourceDir,
    secureExportToggle: true,
  });
  if (!choice) return;
  const { path: savePath, secureExport } = choice;

  const filteredPages = pages.slice(range.start - 1, range.end);
  showBusy("書き出し準備", `ページ ${range.start}-${range.end} を描画しています...`, 0);
  try {
    const composed = await composePagesForExport({
      pages: filteredPages,
      projectStore,
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
      rasterRedactionPages: true,
      onProgress: ({ done, total: t }) => {
        updateBusy(`${done} / ${t} ページを描画中...`, (done / t) * 80);
      },
    });
    updateBusy("PDF を組み立て中...", 90);
    const result = await kpdf3.exportPdfRasterized({
      savePath,
      pages: composed,
      secureExport,
    });
    hideBusy();
    wsStatus.textContent =
      `書き出し完了 (p.${range.start}-${range.end}, rev ${result.revisionId.slice(0, 8)} → ${savePath})`;
    if (secureExport && result?.qpdfMissing) {
      await customConfirm({
        title: "セキュア書き出し: qpdf 未検出",
        message:
          "qpdf バイナリが見つからなかったため、個人情報の消去をスキップして\n"
          + "通常の書き出しを行いました。",
        okLabel: "閉じる",
        cancelLabel: null,
      });
    }
  } catch (err) {
    hideBusy();
    console.error("[renderer] export-range failed:", err);
    wsStatus.textContent = `書き出し失敗: ${err.message ?? err}`;
  }
}


async function actionExport() {
  if (!isOpen) return;
  const defaults = await kpdf3.getExportDefaults();
  const choice = await showFileBrowser({
    mode: "save",
    title: "PDF として書き出し",
    initialName: defaults.defaultName ?? "export.pdf",
    defaultDir: defaults.sourceDir,
    secureExportToggle: true,
  });
  if (!choice) return;
  await actionExportToPath(choice.path, { secureExport: choice.secureExport });
}

// ---- β.97 機能 2: 範囲選択して画像保存 -----------------------------------
//
// ツールバー「範囲画像」ボタン or メニュー「選んだ範囲を画像で保存…」で
// placementMode を "region-image" に切替 → ページ上のドラッグで矩形を
// 描く → リリースで mode-options-bar の formato/dpi/mono を反映して
// composeRegionImage → save dialog で 1 枚画像保存。
//
// drag UI は redaction とほぼ同じ実装 (preview rect を div に当てる)。
// commit 時に setPlacementMode("none") で抜ける (繰り返し配置はしない、
// 1 ドラッグ = 1 保存)。

function startRegionImageDrag(pageNo, startX, startY, downEvt, div) {
  if (!div || !downEvt || typeof div.setPointerCapture !== "function") {
    // Pointer capture not available — abort cleanly, the user can retry.
    setPlacementMode("none");
    return;
  }
  const pointerId = downEvt.pointerId;
  const z = viewer.zoom;
  const preview = document.createElement("div");
  preview.className = "region-image-preview";
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
  async function onUp(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
    const left = Math.min(startX, curX);
    const top = Math.min(startY, curY);
    const width = Math.abs(curX - startX);
    const height = Math.abs(curY - startY);
    if (width < 5 || height < 5) {
      wsStatus.textContent = "範囲が小さすぎます — もう一度ドラッグしてください";
      return; // stay in region-image mode for a retry
    }
    setPlacementMode("none");
    await saveRegionImage(pageNo, { x: left, y: top, w: width, h: height });
  }
  function onCancel(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
  }
  div.addEventListener("pointermove", onMove);
  div.addEventListener("pointerup", onUp);
  div.addEventListener("pointercancel", onCancel);
}

async function saveRegionImage(pageNo, bbox) {
  // Pull options from the mode-options-bar (these stayed visible while the
  // user dragged) so they don't need to confirm again in a second dialog.
  const fmtSel = $("region-image-format");
  const dpiSel = $("region-image-dpi");
  const monoChk = $("region-image-mono");
  const fmt = (fmtSel?.value === "jpeg") ? "jpeg" : "png";
  const ext = fmt === "jpeg" ? "jpg" : "png";
  const dpi = Number(dpiSel?.value) || 300;
  const mono = !!monoChk?.checked;

  // Find the page row for this pageNo (synthetic / source agnostic).
  const pages = await fetchVisiblePages();
  const pageRow = pages.find((p) => p.pageNo === pageNo);
  if (!pageRow) {
    wsStatus.textContent = `ページ ${pageNo} が見つかりません`;
    return;
  }

  // File picker
  const baseStem = (activeSourceName || "region").replace(/\.[a-zA-Z0-9]+$/, "");
  const defaults = await kpdf3.getExportDefaults();
  const choice = await showFileBrowser({
    mode: "save",
    title: "範囲を画像として保存",
    initialName: `${baseStem}_p${pageNo > 0 ? pageNo : "ins"}.${ext}`,
    defaultDir: defaults.sourceDir,
    defaultExt: `.${ext}`,
    filterDefault: "image",
  });
  if (!choice) return;
  const savePath = typeof choice === "string" ? choice : choice.path;

  const zoom = dpi / 72;
  showBusy("範囲画像書き出し", "選択範囲を描画しています...", 30);
  try {
    const img = await composeRegionImage({
      pageRow,
      renderPage: kpdf3.renderPage,
      projectStore,
      renderSyntheticPage: renderSyntheticPagePixels,
      zoom,
      format: fmt,
      quality: 0.92,
      monoOverlays: mono,
      bbox,
    });
    updateBusy("ファイルに書き込み中...", 90);
    await kpdf3.saveImageFile({ savePath, bytes: img.bytes });
    hideBusy();
    wsStatus.textContent =
      `範囲画像を保存しました (${img.widthPx}×${img.heightPx}px, ${fmt.toUpperCase()}, ${dpi}dpi → ${savePath})`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] region image export failed:", err);
    wsStatus.textContent = `範囲画像書き出し失敗: ${err.message ?? err}`;
  }
}

// ---- β.97 機能 1: PDF を画像として保存 -----------------------------------
//
// PDF の各ページを PNG / JPEG として書き出す。複数ページの場合はフォルダを
// 1 つ選んで、その中に「<base>_p001.png」「<base>_p002.png」… の連番で
// 出力する。単一ページの場合は普通の save ダイアログで 1 ファイル保存。
//
// 解像度は dpi → zoom 換算 (96/150/300/600/900 dpi)。900dpi は EXPORT_ZOOM と
// 同じで PDF 書き出しの fidelity が出る。300dpi が標準推奨 (送付用・印刷代用)。
// 編集 overlay は常に flatten で焼き込み (画像なので分離保持できない)。

function showImageExportDialog() {
  const dlg = $("image-export-dialog");
  if (!dlg) return Promise.resolve(null);
  const rangeRadios = dlg.querySelectorAll('input[name="image-export-range"]');
  const formatRadios = dlg.querySelectorAll('input[name="image-export-format"]');
  const rangeInput = $("image-export-range-input");
  const dpiSel = $("image-export-dpi");
  const monoChk = $("image-export-mono");
  const baseInput = $("image-export-basename");
  const okBtn = $("image-export-confirm");
  const cancelBtn = $("image-export-cancel");

  // Restore last-used config
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem("kpdf3.imageExportPrefs") || "{}"); }
    catch { return {}; }
  })();
  if (stored.format === "jpeg") {
    const r = dlg.querySelector('input[name="image-export-format"][value="jpeg"]');
    if (r) r.checked = true;
  }
  if (Number.isFinite(stored.dpi)) {
    const opt = [...dpiSel.options].find((o) => Number(o.value) === stored.dpi);
    if (opt) dpiSel.value = opt.value;
  }
  monoChk.checked = !!stored.mono;
  // Default basename from active source (.pdf → "")
  const meta = activeSourceName || "export.pdf";
  const defaultBase = String(meta).replace(/\.[a-zA-Z0-9]+$/, "");
  baseInput.value = defaultBase;
  rangeInput.value = "";

  // Reset range to all by default each invocation (user is making a fresh choice)
  for (const r of rangeRadios) r.checked = r.value === "all";
  rangeInput.disabled = true;

  function syncRangeInput() {
    const sel = [...rangeRadios].find((r) => r.checked)?.value || "all";
    rangeInput.disabled = sel !== "custom";
    if (sel === "custom") rangeInput.focus();
  }
  for (const r of rangeRadios) r.addEventListener("change", syncRangeInput);

  dlg.hidden = false;
  baseInput.focus();
  baseInput.select();

  return new Promise((resolve) => {
    function cleanup() {
      for (const r of rangeRadios) r.removeEventListener("change", syncRangeInput);
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dlg.removeEventListener("keydown", onKey);
      dlg.hidden = true;
    }
    function onCancel() {
      cleanup();
      resolve(null);
    }
    function onOk() {
      const rangeKind = [...rangeRadios].find((r) => r.checked)?.value || "all";
      const format = [...formatRadios].find((r) => r.checked)?.value || "png";
      const dpi = Number(dpiSel.value) || 300;
      const mono = !!monoChk.checked;
      const baseName = baseInput.value.trim() || defaultBase || "page";
      const rangeText = rangeInput.value.trim();
      // Persist prefs for next time (range kind is invocation-specific so we skip it)
      try {
        localStorage.setItem("kpdf3.imageExportPrefs", JSON.stringify({
          format, dpi, mono,
        }));
      } catch { /* ignore */ }
      cleanup();
      resolve({ rangeKind, rangeText, format, dpi, mono, baseName });
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter" && e.target !== rangeInput) {
        e.preventDefault(); onOk();
      }
    }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dlg.addEventListener("keydown", onKey);
  });
}

async function actionExportAsImage() {
  if (!isOpen) return;
  const pages = await fetchVisiblePages();
  if (pages.length === 0) return;
  const total = pages.length;
  const cfg = await showImageExportDialog();
  if (!cfg) return;

  // Decide which page numbers (1-based among visible pages) to write
  let targetIdxs;
  if (cfg.rangeKind === "all") {
    targetIdxs = pages.map((_, i) => i);
  } else if (cfg.rangeKind === "current") {
    const cp = viewer.currentPage;
    // Map currentPage (pageNo) to its index in `pages` (which is the
    // visible-order list, including synthetic pages).
    const idx = pages.findIndex((p) => p.pageNo === cp);
    if (idx < 0) {
      wsStatus.textContent = "現在のページが見つかりませんでした";
      return;
    }
    targetIdxs = [idx];
  } else {
    const seq = parseMultiPageRange(cfg.rangeText, total);
    if (!seq) {
      wsStatus.textContent = `無効な範囲: ${cfg.rangeText}`;
      return;
    }
    targetIdxs = seq.map((n) => n - 1);
  }

  const zoom = cfg.dpi / 72;
  const fmt = cfg.format === "jpeg" ? "jpeg" : "png";
  const ext = fmt === "jpeg" ? "jpg" : "png";

  const defaults = await kpdf3.getExportDefaults();
  if (targetIdxs.length === 1) {
    // Single-page → save dialog with one filename.
    const initialName = `${cfg.baseName}.${ext}`;
    const choice = await showFileBrowser({
      mode: "save",
      title: "画像として保存",
      initialName,
      defaultDir: defaults.sourceDir,
      defaultExt: `.${ext}`,
      filterDefault: "image",
    });
    if (!choice) return;
    const savePath = typeof choice === "string" ? choice : choice.path;
    showBusy("画像書き出し", `ページを ${fmt.toUpperCase()} に変換しています...`, 30);
    try {
      const img = await composePageImage({
        pageRow: pages[targetIdxs[0]],
        renderPage: kpdf3.renderPage,
        projectStore,
        renderSyntheticPage: renderSyntheticPagePixels,
        zoom,
        format: fmt,
        quality: 0.92,
        monoOverlays: cfg.mono,
      });
      updateBusy("ファイルに書き込み中...", 90);
      await kpdf3.saveImageFile({ savePath, bytes: img.bytes });
      hideBusy();
      wsStatus.textContent = `画像書き出し完了 (${fmt.toUpperCase()}, ${cfg.dpi}dpi → ${savePath})`;
    } catch (err) {
      hideBusy();
      console.error("[renderer] image export (single) failed:", err);
      wsStatus.textContent = `画像書き出し失敗: ${err.message ?? err}`;
    }
    return;
  }

  // Multi-page → folder picker, then write N files inside it.
  const folder = await showFileBrowser({
    mode: "folder",
    title: "画像を保存するフォルダ",
    defaultDir: defaults.sourceDir,
    confirmLabel: "このフォルダに保存",
  });
  if (!folder) return;
  const totalN = targetIdxs.length;
  showBusy("画像書き出し", `${totalN} ページを ${fmt.toUpperCase()} に変換しています...`, 0);
  try {
    const files = [];
    for (let i = 0; i < totalN; i++) {
      const idx = targetIdxs[i];
      const img = await composePageImage({
        pageRow: pages[idx],
        renderPage: kpdf3.renderPage,
        projectStore,
        renderSyntheticPage: renderSyntheticPagePixels,
        zoom,
        format: fmt,
        quality: 0.92,
        monoOverlays: cfg.mono,
      });
      files.push({ seq: i + 1, ext, bytes: img.bytes });
      updateBusy(`${i + 1} / ${totalN} ページを変換中...`, ((i + 1) / totalN) * 90);
    }
    updateBusy("ファイルに書き込み中...", 95);
    const result = await kpdf3.saveImageFiles({
      folder,
      baseName: cfg.baseName,
      files,
    });
    hideBusy();
    wsStatus.textContent =
      `画像書き出し完了 (${result.count} ファイル, ${fmt.toUpperCase()}, ${cfg.dpi}dpi → ${folder})`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] image export (multi) failed:", err);
    wsStatus.textContent = `画像書き出し失敗: ${err.message ?? err}`;
  }
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
 * @param {{ verb?: string, secureExport?: boolean }} [opts]
 *   - verb: status-message verb (default "書き出し")
 *   - secureExport: run the assembled PDF through qpdf to strip metadata +
 *     rebuild xref. Ignored on the byte-copy path (no overlays / deletions
 *     / insertions — we're just byte-copying the source).
 */
async function actionExportToPath(
  savePath,
  { verb: verbOverride, secureExport = false } = {},
) {
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
        rasterRedactionPages: true,
        onProgress: ({ done, total }) => {
          updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
        },
      });
      updateBusy("PDF を組み立て中...", 90);
      result = await kpdf3.exportPdfRasterized({
        savePath,
        pages: composed,
        secureExport,
      });
    }
    updateBusy("新しいファイルに切り替え中...", 95);
    try {
      const opened = await kpdf3.openPdfFile(savePath, getActiveTabId());
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
    if (secureExport && result?.qpdfMissing) {
      // User asked for sanitize but the qpdf binary wasn't found. Warn
      // post-hoc so they know the file went out un-scrubbed.
      await customConfirm({
        title: "セキュア書き出し: qpdf 未検出",
        message:
          "qpdf バイナリが見つからなかったため、個人情報の消去をスキップして\n"
          + "通常の書き出しを行いました。\n\n"
          + "通常版がパッケージから外れている可能性があります。",
        okLabel: "閉じる",
        cancelLabel: null,
      });
    }
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
  recenterCurrentPageHorizontally();
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
  recenterCurrentPageHorizontally();
  return true;
}

/** β76: 横スクロール位置を「現在ページが viewport 中央に来るよう」reset。
 *  混在サイズ PDF (A3 + A4 など) で fit-width が A4 基準で計算された場合、
 *  inner 幅 = max page width = A3 のため margin auto が効かず inner が
 *  viewport 左端に張り付き、A4 ページが右にずれて見える症状の対策。
 *  fit 系操作 (Ctrl+3 / 幅をウィンドウに合わせる / 1 ページ全体) の直後に
 *  呼んで、現在ページの中央が viewport 中央に来るよう scrollLeft を調整。 */
function recenterCurrentPageHorizontally() {
  const pageNo = viewer.currentPage;
  if (!pageNo) return;
  const pageEl = viewer.pageEls?.get(pageNo);
  if (!pageEl) return;
  const target = pageEl.offsetLeft - (viewerContainer.clientWidth - pageEl.offsetWidth) / 2;
  viewerContainer.scrollLeft = Math.max(0, target);
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
      e.dataTransfer.effectAllowed = "copyMove";
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
    // β.79: notify main so a sibling window's sidebar can accept the
    // drop and ingest the selected pages as synthetic copies. Sidebar
    // visual order is the order we want at the destination.
    const ordered = getOrderedThumbPageNos(thumbList, ".thumb-item");
    const payloadKeys = selectionSet
      ? ordered.filter((k) => selectionSet.has(k))
      : [pageNo];
    void window.kpdf3?.pageDragStart?.({ pageKeys: payloadKeys });
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
    void window.kpdf3?.pageDragEnd?.();
  });
  item.addEventListener("dragover", (e) => {
    // Same-window reorder.
    if (_draggingThumbPN !== null) {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      showBoundaryIndicator(item, e, isHorizontal);
      return;
    }
    // β.79: cross-window page drag — `_draggingThumbPN` is null in the
    // target window, but Chromium exposes the MIME types list across the
    // BrowserWindow boundary. Show the same blue boundary indicator so
    // the user gets identical visual feedback to a local reorder.
    if (e.dataTransfer && hasThumbPagePayload(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      showBoundaryIndicator(item, e, isHorizontal);
    }
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
    // Same-window reorder.
    if (_draggingThumbPN !== null) {
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
      return;
    }
    // β.79: cross-window page drop on this thumb. Translate the visual
    // position (this thumb's bounding rect, before/after midpoint) into
    // the β77 (afterPageNo, afterKey) anchor pair and route through main.
    if (!e.dataTransfer || !hasThumbPagePayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    clearThumbDropIndicators();
    const r = item.getBoundingClientRect();
    const before = isHorizontal
      ? e.clientX < r.left + r.width / 2
      : e.clientY < r.top + r.height / 2;
    const anchor = await resolveCrossWindowDropAnchor(pageNo, before);
    if (!anchor) return;
    await handleCrossWindowPageDrop(anchor);
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
  // before the first source page or after each one. afterKey = 0
  // signals "before everything" to the β77 drop handler.
  const firstSrcRow = list.find((r) => !r.isSynthetic);
  if (firstSrcRow) {
    thumbList.appendChild(makeInsertGap(0, null, 0));
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
    // β77: afterKey = this row's pageNo (positive for source, negative
    // for synth) drives the visual-position display_order at drop time.
    if (row.isSynthetic) {
      thumbList.appendChild(
        makeInsertGap(
          row.syntheticAfterPageNo ?? 0,
          (row.syntheticOrderInSlot ?? 0) + 1,
          i,
        ),
      );
    } else {
      thumbList.appendChild(makeInsertGap(i, null, i));
    }
  }
  refreshThumbSelectionVisuals();
}

/** Wire drop-on-gap so dragging a PDF onto an insert gap inserts that
 *  PDF's pages here. stopPropagation prevents the global drop handler
 *  (which opens a fresh PDF) from firing too.
 *
 *  β77: `afterKey` identifies the page directly before this gap in the
 *  current visual layout (positive = source pageNo, negative = synthetic
 *  key, 0 = before-everything). Pass-through to main lets the IPC
 *  handler compute an explicit display_order between the visible
 *  neighbours — necessary because reorder operations can move synthetic
 *  rows away from their slot anchor (afterPageNo / orderInSlot), at
 *  which point `MAX(order_in_slot)+1` no longer matches the visual gap.
 */
function attachInsertGapDrop(gap, afterPageNo, afterKey = null) {
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
    } else if (types.includes(THUMB_DND_MIME)) {
      // β.79: cross-window page payload — same blue line as same-window
      // reorder + +gap drop, but with copy semantics (source unchanged).
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
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
    // β.79: cross-window page drop — gap already knows its (afterPageNo,
    // afterKey) anchor so we can route directly without re-resolving.
    if (hasThumbPagePayload(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation();
      await handleCrossWindowPageDrop({ afterPageNo, afterKey });
      return;
    }
    // External file drop = insert-from-PDF (legacy behaviour).
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    const path = kpdf3.getPathForFile?.(file) || file.path || "";
    // β75 diag: ユーザがサムネ間の "+" 帯にうっかり落として「open でなく
    // insert になった」のを区別するために、gap drop での file 受領を残す。
    kpdf3.logDiag?.("gap-drop-file", { path, afterPageNo, afterKey });
    if (!path || !/\.pdf$/i.test(path)) {
      wsStatus.textContent = "PDF ファイルをドロップしてください";
      return;
    }
    showBusy("挿入", "外部 PDF を取り込み中...", 0);
    // β78: subscribe to per-page progress so the busy modal updates
    // through the 20-30s heavy-PDF insertion instead of looking frozen.
    const unsubProgress = kpdf3.onInsertPdfProgress?.((d) => {
      const total = d?.total ?? 0;
      const i = d?.i ?? 0;
      const pct = total > 0 ? Math.round(((i + 1) / total) * 100) : 0;
      updateBusy(`外部 PDF を取り込み中... (${i + 1} / ${total})`, pct);
    });
    try {
      const r = await kpdf3.addInsertedPdfPages({
        afterPageNo,
        afterKey,
        externalPath: path,
      });
      unsubProgress?.();
      hideBusy();
      markWorkspaceMutated();
      await refreshViewer();
      // β3 testers reported "分割画面でドロップしても追加が見えない" —
      // refreshViewer() above rebuilds the sidebar thumbs but the split
      // view has its own thumb list that needs an explicit refresh.
      if (isSplitMode) await refreshSplitView();
      // β.85: refreshViewer 後は viewer が先頭ページに戻る (load 時の
      // scrollTop リセット) ので、挿入したページの先頭まで明示的に
      // スクロール。「追加した書類がどこに行ったか分からない」を解消
      // (β.84 までの UX 指摘)。syntheticPageNos は挿入順、負の値で
      // 並び替えにも追従する。
      const insertedNos = r?.syntheticPageNos ?? [];
      if (insertedNos.length > 0) {
        viewer.scrollToPage(insertedNos[0]);
      }
      const n = insertedNos.length;
      wsStatus.textContent = `${n} ページを挿入しました`;
    } catch (err) {
      unsubProgress?.();
      hideBusy();
      console.error("[insert-pdf] failed", err);
      wsStatus.textContent = `挿入失敗: ${err.message ?? err}`;
    }
  });
}

/** β.79: cross-window thumb drop — translate "before/after this thumb"
 *  into the (afterPageNo, afterKey) anchor pair the main insertion path
 *  expects. Resolved against the *current* visible page list so a
 *  reorder that happened mid-drag in the source window doesn't matter:
 *  what we see in the target sidebar is what we encode.
 *
 *  Returns null on lookup failure (thumb removed between dragover and
 *  drop) so the caller can bail quietly. */
async function resolveCrossWindowDropAnchor(thumbPageNo, before) {
  const pages = await kpdf3.getPages();
  const idx = pages.findIndex((p) => p.pageNo === thumbPageNo);
  if (idx < 0) return null;
  if (before) {
    if (idx === 0) return { afterPageNo: 0, afterKey: 0 };
    const prev = pages[idx - 1];
    return {
      afterPageNo: prev.isSynthetic ? (prev.syntheticAfterPageNo ?? 0) : prev.pageNo,
      afterKey: prev.pageNo,
    };
  }
  const here = pages[idx];
  return {
    afterPageNo: here.isSynthetic ? (here.syntheticAfterPageNo ?? 0) : here.pageNo,
    afterKey: here.pageNo,
  };
}

/** β.79: route a cross-window page drop through main. Reuses the same
 *  busy modal + progress IPC the external PDF D&D uses so the user
 *  sees identical feedback (N/M counter, navy bar). On success, refresh
 *  the local sidebar so the new synth pages appear in-place. */
async function handleCrossWindowPageDrop({ afterPageNo, afterKey }) {
  showBusy("挿入", "別ウインドウからページを取り込み中...", 0);
  const unsubProgress = kpdf3.onInsertPdfProgress?.((d) => {
    const total = d?.total ?? 0;
    const i = d?.i ?? 0;
    const pct = total > 0 ? Math.round(((i + 1) / total) * 100) : 0;
    updateBusy(
      `別ウインドウからページを取り込み中... (${i + 1} / ${total})`,
      pct,
    );
  });
  try {
    const r = await kpdf3.pageBarDrop({ afterPageNo, afterKey });
    unsubProgress?.();
    hideBusy();
    if (!r?.ok) {
      wsStatus.textContent = r?.reason
        ? `挿入失敗: ${r.reason}`
        : "挿入失敗";
      return;
    }
    markWorkspaceMutated();
    await refreshViewer();
    if (isSplitMode) await refreshSplitView();
    const n = r?.syntheticPageNos?.length ?? 0;
    wsStatus.textContent = `別ウインドウから ${n} ページを挿入しました`;
  } catch (err) {
    unsubProgress?.();
    hideBusy();
    console.error("[cross-window-page-drop] failed", err);
    wsStatus.textContent = `挿入失敗: ${err.message ?? err}`;
  }
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

function makeInsertGap(afterPageNo, orderInSlot = null, afterKey = null) {
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
  attachInsertGapDrop(gap, afterPageNo, afterKey);
  return gap;
}

function makeSplitInsertGap(afterPageNo, orderInSlot = null, afterKey = null) {
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
  attachInsertGapDrop(gap, afterPageNo, afterKey);
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
// β.98 fix: part-name の input 等で Backspace を吸い取らないよう、テキスト
// 入力中はページ削除分岐を skip する (browser default の文字削除に任せる)。
function _isTextInputTarget(t) {
  if (!t) return false;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return true;
  if (t.isContentEditable) return true;
  return false;
}
thumbList?.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") {
    if (_isTextInputTarget(e.target)) return;
    e.preventDefault();
    deleteSelectedPages(sidebarThumbSelection);
  }
});
splitFlow?.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") {
    if (_isTextInputTarget(e.target)) return;
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
    "open-in-new-window": actionOpenInNewWindow,
    recent: actionShowRecent,
    close: actionClose,
    save: actionSave,
    export: actionExport,
    "export-range": actionExportRange,
    "export-image": actionExportAsImage,
    "export-region-image": () =>
      setPlacementMode(placementMode === "region-image" ? "none" : "region-image"),
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

// ---- β.80 Phase E: form-text-font select に system フォントを動的追加 ----
//   既存 4 preset (明朝/ゴシック/Serif/Sans) は <optgroup label="プリセット">
//   に集約し、main から取得した OS インストール済フォントを
//   <optgroup label="システム"> として末尾に追加する。フォント値は
//   そのまま form_field.fontFace に保存され、viewer / 印刷経路で
//   getTextFontStack(fontFace) が解決する (preset 名以外は CSS の
//   font-family にダイレクトに引き渡す、fonts.js 参照)。
(async () => {
  const sel = document.getElementById("form-text-font");
  if (!sel || !kpdf3?.listSystemFonts) return;
  try {
    const fonts = await kpdf3.listSystemFonts();
    if (!Array.isArray(fonts) || fonts.length === 0) return;
    const oldValue = sel.value;
    const presetGroup = document.createElement("optgroup");
    presetGroup.label = "プリセット";
    const existing = [...sel.querySelectorAll("option")];
    for (const opt of existing) presetGroup.appendChild(opt);
    sel.innerHTML = "";
    sel.appendChild(presetGroup);
    const sysGroup = document.createElement("optgroup");
    sysGroup.label = "システム";
    for (const name of fonts) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      // option のスタイルにそのフォントを当てるとプレビュー風になる
      opt.style.fontFamily = `"${name.replace(/"/g, '\\"')}"`;
      sysGroup.appendChild(opt);
    }
    sel.appendChild(sysGroup);
    sel.value = oldValue || "mincho";
  } catch (err) {
    console.warn("[form-text-font] system fonts load failed:", err);
  }
})();

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
  } else if (key === "3") {
    // β76: 慣れ親しんだ Ctrl+3 で「幅をウィンドウに合わせる」 (現在ページ
    // 基準のフィット + 横スクロール中央寄せ)。混在サイズ PDF で他ページ
    // へ移動した後に元の見やすさへ戻すリセット用。
    e.preventDefault();
    actionZoomFit();
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
  "export-image": "PDF を PNG / JPEG 画像として保存します (連番ファイル)",
  "export-region-image": "ドラッグで囲んだ範囲を 1 枚の画像として保存します",
  "split-save": "PDF を複数のパートに分割保存します",
  print: "PDF を印刷します (Ctrl+P)",
  exit: "アプリを終了します",
  undo: "直前の編集を取り消します (Ctrl+Z)",
  redo: "取り消した編集をやり直します (Ctrl+Y)",
  "zoom-in": "表示を拡大します (Ctrl++)",
  "zoom-out": "表示を縮小します (Ctrl+-)",
  "zoom-fit": "ページがウィンドウに収まる倍率にします (Ctrl+3)",
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
  // β75 diag: D&D「開かない」現象の追跡。各 early-return / openPdfSmart
  // 呼出をログに残して、どこで止まったか / そもそも drop event が
  // 発火したかを crash.log で判別できるようにする。
  const _diagBase = {
    target: e.target instanceof Element ? `${e.target.tagName}.${e.target.className || ""}`.slice(0, 80) : "?",
    isOpen,
  };
  if (!files || files.length === 0) {
    kpdf3.logDiag?.("drop-no-files", _diagBase);
    return;
  }
  const file = files[0];
  // Electron 32+ removed File.path on the renderer side; resolve the
  // backing OS path via the preload helper instead.
  const fromWebUtils = kpdf3.getPathForFile?.(file) || "";
  const path = fromWebUtils || file.path || "";
  if (!path) {
    kpdf3.logDiag?.("drop-no-path", { ..._diagBase, fileName: file?.name, fileSize: file?.size });
    wsStatus.textContent = "ドロップされたファイルのパスを取得できませんでした";
    return;
  }
  if (!/\.pdf$/i.test(path)) {
    kpdf3.logDiag?.("drop-not-pdf", { ..._diagBase, path });
    wsStatus.textContent = "PDF ファイルを指定してください";
    return;
  }
  kpdf3.logDiag?.("drop-opening", { ..._diagBase, path, source: fromWebUtils ? "webUtils" : "file.path" });
  // No dirty check — drop opens in a fresh tab when the active one is
  // already busy, mirroring the toolbar 開く button.
  try {
    await openPdfSmart(path);
    kpdf3.logDiag?.("drop-opened", { path });
  } catch (err) {
    kpdf3.logDiag?.("drop-error", { path, msg: String(err?.message ?? err) });
    throw err;
  }
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
  for (const [, tab] of getAllTabs()) {
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
  // β75 diag: second-instance routing が renderer 側に届いた瞬間を残す。
  // main の "second-instance-received" と対応付けて、IPC で paths が
  // 落ちていないか・受領後に openPdfSmart が成功したかを追跡できる。
  kpdf3.logDiag?.("os-open-received", { pdfPath, isOpen });
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
    const id = getActiveTabId();
    if (id) void closeTabWithConfirm(id);
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
// 白黒印刷 sticky toggle (Phase 1)。state と sync 関数は initPrintFlow より
// 前に宣言済 (print-flow.js が getter で読みに来るため)、ここでは初期
// 表示の sync と click 配線のみ行う。
_syncMonoPrintBtn();
if (btnMonoPrint) {
  btnMonoPrint.addEventListener("click", () => {
    _monoPrintMode = !_monoPrintMode;
    try { localStorage.setItem("kpdf3.monoPrintMode", _monoPrintMode ? "1" : "0"); }
    catch { /* ignore */ }
    _syncMonoPrintBtn();
    wsStatus.textContent = _monoPrintMode
      ? "白黒印刷モード ON — overlay の色を黒に変換して印刷します (マーカーは除外)"
      : "白黒印刷モード OFF — 通常のカラーで印刷します";
  });
}
if (btnPrintOverlayOnly) {
  btnPrintOverlayOnly.addEventListener("click", actionPrintOverlayOnly);
}
// Phase 2: FAX 送信ボタン。左クリック = streamlined (auto)、右クリック =
// context menu (Adobe 経由 / FAX プリンタ変更)。
if (btnFaxSend) {
  btnFaxSend.addEventListener("click", () => actionFaxSend({ via: "auto" }));
  btnFaxSend.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (btnFaxSend.disabled) return;
    // anchored under the button's bottom-left。closeMenusOnDocClick で外側
    // クリック時に閉じる (既存の document mousedown ハンドラに後から相乗り)。
    const rect = btnFaxSend.getBoundingClientRect();
    ctxFaxBtn.style.left = `${Math.round(rect.left)}px`;
    ctxFaxBtn.style.top = `${Math.round(rect.bottom)}px`;
    ctxFaxBtn.hidden = false;
  });
}
if (ctxFaxBtn) {
  ctxFaxBtn.addEventListener("click", (e) => {
    const item = e.target.closest("[data-ctx]");
    if (!item) return;
    const action = item.dataset.ctx;
    ctxFaxBtn.hidden = true;
    if (action === "fax-adobe") actionFaxSend({ via: "adobe" });
    else if (action === "fax-set-printer") actionFaxChangePrinter();
  });
}
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
if (btnModeRegionImage) {
  btnModeRegionImage.addEventListener("click", () =>
    setPlacementMode(placementMode === "region-image" ? "none" : "region-image"),
  );
}
// β.80: form-field tool buttons
if (btnModeFormText) {
  btnModeFormText.addEventListener("click", () => {
    if (formFillMode) setFormFillMode(false);
    setPlacementMode(placementMode === "form-text" ? "none" : "form-text");
  });
}
if (btnModeFormCheck) {
  btnModeFormCheck.addEventListener("click", () => {
    if (formFillMode) setFormFillMode(false);
    setPlacementMode(placementMode === "form-check" ? "none" : "form-check");
  });
}
if (btnModeFormCircle) {
  btnModeFormCircle.addEventListener("click", () => {
    if (formFillMode) setFormFillMode(false);
    setPlacementMode(placementMode === "form-circle" ? "none" : "form-circle");
  });
}
if (btnModeFormRadio) {
  btnModeFormRadio.addEventListener("click", () => {
    if (formFillMode) setFormFillMode(false);
    setPlacementMode(placementMode === "form-radio" ? "none" : "form-radio");
  });
}
if (btnToggleFillMode) {
  btnToggleFillMode.addEventListener("click", () => setFormFillMode(!formFillMode));
}
// β.82 (B-6): Tab 順編集モードの ON/OFF。setTabOrderEditMode 内で
// 排他制御 (記入モード / placement モード OFF) と badge 初期描画を行う。
if (btnToggleTabOrder) {
  btnToggleTabOrder.addEventListener("click", () =>
    setTabOrderEditMode(!tabOrderEditMode),
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

// β.80: フォーム palette popup の開閉 + ドラッグ + 位置永続化。
// スタンプ palette と同じ流儀。toolbar 「フォーム」ボタン押下で
// toggle、close ボタン or PDF クローズで非表示。popup を閉じる時は
// 進行中の placementMode / formFillMode を解除する (混乱回避)。
const FORM_POPUP_POS_KEY = "kpdf3.formPopupPos";
if (btnFormPalette && formPalettePopup) {
  btnFormPalette.addEventListener("click", () => {
    const willShow = formPalettePopup.hidden;
    formPalettePopup.hidden = !willShow;
    btnFormPalette.classList.toggle("toggled", willShow);
    if (!willShow) {
      // popup を閉じた → 関連モードも解除
      if (placementMode?.startsWith("form-")) setPlacementMode("none");
      if (formFillMode) setFormFillMode(false);
    }
  });
}
if (btnFormPaletteClose && formPalettePopup) {
  btnFormPaletteClose.addEventListener("click", () => {
    formPalettePopup.hidden = true;
    btnFormPalette?.classList.remove("toggled");
    if (placementMode?.startsWith("form-")) setPlacementMode("none");
    if (formFillMode) setFormFillMode(false);
  });
}
if (formPalettePopup && formPaletteTitlebar) {
  const restoreFormPopupPos = () => {
    try {
      const saved = localStorage.getItem(FORM_POPUP_POS_KEY);
      if (!saved) return;
      const { left, top } = JSON.parse(saved);
      if (typeof left !== "number" || typeof top !== "number") return;
      const w = formPalettePopup.offsetWidth || 240;
      const h = formPalettePopup.offsetHeight || 200;
      const clampedLeft = Math.max(0, Math.min(window.innerWidth - w, left));
      const clampedTop = Math.max(0, Math.min(window.innerHeight - h, top));
      formPalettePopup.style.left = `${clampedLeft}px`;
      formPalettePopup.style.top = `${clampedTop}px`;
      formPalettePopup.style.right = "auto";
    } catch { /* ignore */ }
  };
  restoreFormPopupPos();
  const obs = new MutationObserver(() => {
    if (!formPalettePopup.hidden) restoreFormPopupPos();
  });
  obs.observe(formPalettePopup, { attributes: true, attributeFilter: ["hidden"] });

  let drag = null;
  formPaletteTitlebar.addEventListener("pointerdown", (e) => {
    if (e.target instanceof HTMLElement && e.target.id === "form-palette-close") return;
    const rect = formPalettePopup.getBoundingClientRect();
    drag = {
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    try { formPaletteTitlebar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  formPaletteTitlebar.addEventListener("pointermove", (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const x = e.clientX - drag.offsetX;
    const y = e.clientY - drag.offsetY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = formPalettePopup.offsetWidth;
    const h = formPalettePopup.offsetHeight;
    formPalettePopup.style.left = `${Math.max(0, Math.min(vw - w, x))}px`;
    formPalettePopup.style.top = `${Math.max(0, Math.min(vh - h, y))}px`;
    formPalettePopup.style.right = "auto";
  });
  formPaletteTitlebar.addEventListener("pointerup", (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    try { formPaletteTitlebar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    drag = null;
    try {
      const left = parseFloat(formPalettePopup.style.left) || 0;
      const top = parseFloat(formPalettePopup.style.top) || 0;
      localStorage.setItem(FORM_POPUP_POS_KEY, JSON.stringify({ left, top }));
    } catch { /* ignore */ }
  });
}

// β.100 オートシェイプ palette popup wiring. form palette と同じパターン:
//   - btn click で placementMode を toggle (= popup 開閉と連動)
//   - close ボタン or PDF close で placementMode("none")
//   - titlebar ドラッグで position 変更 + localStorage 永続化
const SHAPE_POPUP_POS_KEY = "kpdf3.shapePopupPos";
if (btnShapePalette && shapePalettePopup) {
  btnShapePalette.addEventListener("click", () => {
    setPlacementMode(placementMode === "shape" ? "none" : "shape");
  });
}
if (btnShapePaletteClose && shapePalettePopup) {
  btnShapePaletteClose.addEventListener("click", () => {
    if (placementMode === "shape") setPlacementMode("none");
    else shapePalettePopup.hidden = true;
  });
}
if (shapePalettePopup && shapePaletteTitlebar) {
  const restoreShapePopupPos = () => {
    try {
      const saved = localStorage.getItem(SHAPE_POPUP_POS_KEY);
      if (!saved) return;
      const { left, top } = JSON.parse(saved);
      if (typeof left !== "number" || typeof top !== "number") return;
      const w = shapePalettePopup.offsetWidth || 260;
      const h = shapePalettePopup.offsetHeight || 240;
      const clampedLeft = Math.max(0, Math.min(window.innerWidth - w, left));
      const clampedTop = Math.max(0, Math.min(window.innerHeight - h, top));
      shapePalettePopup.style.left = `${clampedLeft}px`;
      shapePalettePopup.style.top = `${clampedTop}px`;
      shapePalettePopup.style.right = "auto";
    } catch { /* ignore */ }
  };
  restoreShapePopupPos();
  const obs = new MutationObserver(() => {
    if (!shapePalettePopup.hidden) restoreShapePopupPos();
  });
  obs.observe(shapePalettePopup, { attributes: true, attributeFilter: ["hidden"] });

  let drag = null;
  shapePaletteTitlebar.addEventListener("pointerdown", (e) => {
    if (e.target instanceof HTMLElement && e.target.id === "shape-palette-close") return;
    const rect = shapePalettePopup.getBoundingClientRect();
    drag = {
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    try { shapePaletteTitlebar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  shapePaletteTitlebar.addEventListener("pointermove", (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const x = e.clientX - drag.offsetX;
    const y = e.clientY - drag.offsetY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = shapePalettePopup.offsetWidth;
    const h = shapePalettePopup.offsetHeight;
    shapePalettePopup.style.left = `${Math.max(0, Math.min(vw - w, x))}px`;
    shapePalettePopup.style.top = `${Math.max(0, Math.min(vh - h, y))}px`;
    shapePalettePopup.style.right = "auto";
  });
  shapePaletteTitlebar.addEventListener("pointerup", (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    try { shapePaletteTitlebar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    drag = null;
    try {
      const left = parseFloat(shapePalettePopup.style.left) || 0;
      const top = parseFloat(shapePalettePopup.style.top) || 0;
      localStorage.setItem(SHAPE_POPUP_POS_KEY, JSON.stringify({ left, top }));
    } catch { /* ignore */ }
  });
}

// β.102: shape palette popup を「配置設定 + 編集」の両用に。
//
// - 未選択 / 複数選択時 → popup の値は次の配置の defaults (現状維持)
// - 単一 shape 選択中    → popup の値を選択 shape のもので populate、
//                          popup 値変更時は選択 shape を即時 update
//
// onSelectionChanged から populate、popup の各 control の change で
// _syncShapePopupToSelected を呼ぶ。
function _populateShapePopupFromSelection() {
  if (getSelectionSize() !== 1) return;
  const id = getPrimarySelectedId();
  const ov = id ? projectStore.get(id) : null;
  if (!ov || ov.type !== "shape") return;
  const props = ov.properties ?? {};
  // kind radio
  const kindRadios = document.querySelectorAll('input[name="shape-kind"]');
  for (const r of kindRadios) r.checked = r.value === (props.kind ?? "line");
  // dir / color / stroke / fill
  const dirSel = $("shape-dir");
  const colorSel = $("shape-color");
  const strokeSel = $("shape-stroke-width");
  const fillSel = $("shape-fill-mode");
  if (dirSel) {
    const directional =
      props.kind === "line" || props.kind === "arrow" || props.kind === "double-arrow" ||
      props.kind === "block-arrow" || props.kind === "double-block-arrow";
    dirSel.disabled = !directional;
    dirSel.value = directional ? (props.arrowDir ?? "right") : "right";
  }
  if (colorSel) colorSel.value = props.strokeColor ?? "#000000";
  if (strokeSel) strokeSel.value = String(props.strokeWidth ?? 2);
  if (fillSel) fillSel.value = props.fillColor ? "solid" : "hollow";
}

function _syncShapePopupToSelected() {
  if (getSelectionSize() !== 1) return;
  const id = getPrimarySelectedId();
  if (!id) return;
  const ov = projectStore.get(id);
  if (!ov || ov.type !== "shape") return;
  const kindEl = document.querySelector('input[name="shape-kind"]:checked');
  const kind = kindEl?.value || ov.properties?.kind || "line";
  const patch = {
    kind,
    arrowDir:    $("shape-dir")?.value || ov.properties?.arrowDir || "right",
    strokeColor: $("shape-color")?.value || ov.properties?.strokeColor || "#000000",
    strokeWidth: Number($("shape-stroke-width")?.value) || ov.properties?.strokeWidth || 2,
    fillMode:    $("shape-fill-mode")?.value || (ov.properties?.fillColor ? "solid" : "hollow"),
  };
  updateShapeOverlay(id, patch);
  // kind 変更で dir の有効/無効が変わるので popup を再 populate
  const updated = projectStore.get(id);
  if (updated) _populateShapePopupFromSelection();
}

// popup の全 control に change handler。popup を開いただけ (未選択) は
// no-op、選択中なら即時 apply。
for (const id of ["shape-dir", "shape-color", "shape-stroke-width", "shape-fill-mode"]) {
  $(id)?.addEventListener("change", _syncShapePopupToSelected);
}
// kind の radio 群にも同じ handler
for (const r of document.querySelectorAll('input[name="shape-kind"]')) {
  r.addEventListener("change", _syncShapePopupToSelected);
}

// Align toolbar (β5 §17.13/§17.14) — visible only with 2+ selected.
document.getElementById("align-left")  ?.addEventListener("click", () => alignSelectedOverlays("left"));
document.getElementById("align-top")   ?.addEventListener("click", () => alignSelectedOverlays("top"));
document.getElementById("align-right") ?.addEventListener("click", () => alignSelectedOverlays("right"));
document.getElementById("align-bottom")?.addEventListener("click", () => alignSelectedOverlays("bottom"));
document.getElementById("align-width") ?.addEventListener("click", () => alignSelectedOverlays("width"));
document.getElementById("align-height")?.addEventListener("click", () => alignSelectedOverlays("height"));

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

/** β.81 → β.82: form_field の編集中 / 選択中 overlay にプロパティ
 *  変更をライブ反映する。fieldKind ごとに反映するプロパティを切り替える:
 *
 *    - text:   fontFace / fontSize / color / alignH / alignV (β.81 で実装済)
 *    - check:  checkStyle / size (size は bbox の w/h を上書き)
 *    - circle: strokeWidth / color / size
 *    - radio:  radioGroupId / checkStyle (radioStyle) / size
 *
 *  size は select で変更したときだけ反映する (NaN や同値ならスキップ)。
 *  これにより、ユーザがハンドルで自由変形した後に size select だけ
 *  触ったときも意図通りリサイズされ、フォント等を変えただけのときは
 *  bbox を勝手に書き戻さない。 */
function applyFormFieldStyleToEditingOrSelected(kind = null) {
  const editId = viewer._editingId;
  const selId = !editId ? getPrimarySelectedId() : null;
  const targetId = editId || selId;
  if (!targetId) return;
  const ov = projectStore.get(targetId);
  if (!ov || ov.type !== "form_field") return;
  const fk = ov.properties?.fieldKind;
  // kind が指定されていれば一致確認。指定なしなら overlay 側の fk を採用。
  if (kind && fk !== kind) return;
  if (fk === "text") {
    const fontFace = document.getElementById("form-text-font")?.value || "mincho";
    const fontSize =
      Math.max(6, parseInt(document.getElementById("form-text-size")?.value ?? "12", 10) || 12);
    const color = document.getElementById("form-text-color")?.value || "#000000";
    const alignH = document.getElementById("form-text-align-h")?.value || "left";
    const alignV = document.getElementById("form-text-align-v")?.value || "middle";
    projectStore.update(targetId, {
      properties: { ...ov.properties, fontFace, fontSize, color, alignH, alignV },
    });
    // 編集中なら inline-edit 要素の見た目もすぐ追従させる (text overlay
    // と同じ仕組みを流用、digitsHanko/bold は form_field では未使用)。
    if (editId) {
      viewer.applyEditingTextStyle?.({
        fontId: fontFace, fontSize, color, digitsHanko: false, bold: false,
      });
    }
    return;
  }
  if (fk === "check") {
    const checkStyle = document.getElementById("form-check-style")?.value || "✓";
    const sizeRaw = parseInt(document.getElementById("form-check-size")?.value ?? "", 10);
    const patch = {
      properties: { ...ov.properties, checkStyle },
    };
    if (!Number.isNaN(sizeRaw) && sizeRaw > 0) {
      patch.w = sizeRaw;
      patch.h = sizeRaw;
    }
    projectStore.update(targetId, patch);
    return;
  }
  if (fk === "circle") {
    const strokeWidth =
      parseFloat(document.getElementById("form-circle-stroke")?.value ?? "1.2") || 1.2;
    const color = document.getElementById("form-circle-color")?.value || "#000000";
    const sizeRaw = parseInt(document.getElementById("form-circle-size")?.value ?? "", 10);
    const patch = {
      properties: { ...ov.properties, strokeWidth, color },
    };
    // circle は配置後に楕円化される可能性が高い (四隅ハンドルで自由変形)。
    // size select は MIN(w,h) と一致するときだけ「未変更」と見なし、それ
    // 以外は「ユーザが意図的に元のサイズに戻したい」と解釈して w=h=size
    // にリセット。
    if (!Number.isNaN(sizeRaw) && sizeRaw > 0) {
      const current = Math.min(ov.w, ov.h);
      if (Math.abs(current - sizeRaw) > 0.5) {
        patch.w = sizeRaw;
        patch.h = sizeRaw;
      }
    }
    projectStore.update(targetId, patch);
    return;
  }
  if (fk === "radio") {
    const groupRaw = (document.getElementById("form-radio-group")?.value ?? "").trim();
    const radioGroupId = groupRaw || "default";
    const checkStyle = document.getElementById("form-radio-style")?.value || "●";
    const sizeRaw = parseInt(document.getElementById("form-radio-size")?.value ?? "", 10);
    const patch = {
      properties: { ...ov.properties, radioGroupId, checkStyle },
    };
    if (!Number.isNaN(sizeRaw) && sizeRaw > 0) {
      patch.w = sizeRaw;
      patch.h = sizeRaw;
    }
    projectStore.update(targetId, patch);
  }
}

// β.82 (B-5): 旧称の後方互換。form-text-* listener から呼ばれていた。
const applyFormTextStyleToEditingOrSelected = applyFormFieldStyleToEditingOrSelected;

/** β.82 (B-5 ii): form_field を選択した瞬間に、その overlay の現在値を
 *  options bar の select に流し込む。これで「選択した枠が今どの設定か」
 *  が一目でわかり、select 変更も「最後にユーザが触った値」ベースでは
 *  なく「今の枠の値」基準で動く。programmatic な .value 代入は change
 *  event を発火しないので、入力ループにはならない。 */
function populateFormFieldOptionsBar() {
  if (formFillMode) return;
  if (getSelectionSize() !== 1) return;
  const selId = getPrimarySelectedId();
  const ov = selId ? projectStore.get(selId) : null;
  if (!ov || ov.type !== "form_field") return;
  const p = ov.properties || {};
  const fk = p.fieldKind;
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (!el || val == null) return;
    // ユーザが今その要素を編集中なら触らない (radio group 入力中に
    // store-update → reapplySelectionDom → populate のループでカーソル
    // 位置が消える事故を回避)。
    if (document.activeElement === el) return;
    // select の場合は該当 option が無ければ無視 (UI 側の preset 範囲外)
    if (el.tagName === "SELECT") {
      if (Array.from(el.options).some((o) => o.value === String(val))) {
        el.value = String(val);
      }
    } else {
      el.value = String(val);
    }
  };
  if (fk === "text") {
    setVal("form-text-font",   p.fontFace ?? "mincho");
    setVal("form-text-size",   p.fontSize ?? 12);
    setVal("form-text-color",  p.color    ?? "#000000");
    setVal("form-text-align-h", p.alignH  ?? "left");
    setVal("form-text-align-v", p.alignV  ?? "middle");
  } else if (fk === "check") {
    setVal("form-check-style", p.checkStyle ?? "✓");
    // size は bbox から (w/h は同じはず、ズレてたら w 優先)
    setVal("form-check-size", Math.round(ov.w ?? 14));
  } else if (fk === "circle") {
    setVal("form-circle-stroke", p.strokeWidth ?? 1.2);
    setVal("form-circle-color",  p.color       ?? "#000000");
    // 楕円化されている可能性があるため、size select は MIN(w,h) を採用
    setVal("form-circle-size", Math.round(Math.min(ov.w ?? 24, ov.h ?? 24)));
  } else if (fk === "radio") {
    setVal("form-radio-group", p.radioGroupId ?? "default");
    setVal("form-radio-style", p.checkStyle   ?? "●");
    setVal("form-radio-size",  Math.round(ov.w ?? 14));
  }
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

// β.81/β.82: form-* select の change で、編集中 or 選択中の form_field
// にライブ反映する。配置時のデフォルトとしても効く (placement では
// _readForm*Defaults が同じ select 値を読む)。β.82 (B-5 iii) で
// check / circle / radio のサブタイプも後付け編集対応にした。
for (const id of [
  "form-text-font",
  "form-text-size",
  "form-text-color",
  "form-text-align-h",
  "form-text-align-v",
  "form-check-style",
  "form-check-size",
  "form-circle-stroke",
  "form-circle-color",
  "form-circle-size",
  "form-radio-group",
  "form-radio-style",
  "form-radio-size",
]) {
  const el = document.getElementById(id);
  if (!el) continue;
  // radio group は <input type="text"> なので change だけだと blur 待ち。
  // input イベントも拾って入力中に追従させる (但し reentrant 回避のため
  // 連続値の場合 update 自体は冪等)。
  const evt = el.tagName === "INPUT" && el.type === "text" ? "input" : "change";
  el.addEventListener(evt, () => {
    applyFormFieldStyleToEditingOrSelected();
  });
}

// ---- Initial state ----------------------------------------------------
setOpen(false);

(async () => {
  const info = await kpdf3.getAppInfo();
  $("appinfo").textContent = `v${info.appVersion} / Electron ${info.electronVersion}`;
})();
