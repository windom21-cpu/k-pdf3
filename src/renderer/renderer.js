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
  composePageImage,
  composeRegionImage,
  byteCopyEligible,
} from "./exporter.js";
import {
  TEXT_FONT_DEFAULT_ID,
  TEXT_FONT_DEFAULT_SIZE,
} from "./fonts.js";
import { appendSystemFontsToSelect } from "./system-fonts.js";
import { showBusy, updateBusy, hideBusy } from "./busy-modal.js";
import { customConfirm, customPasswordPrompt } from "./dialogs.js";
import { showFileBrowser } from "./file-browser.js";
import {
  initOverlayEdit,
  handleTextEditCommit,
  handleOverlayDragEnd,
  handleOverlayResizeEnd,
  handleCalloutArrowEnd,
  measureCalloutSize,
  measureCalloutWrappedHeight,
  fitCalloutBox,
} from "./overlay-edit.js";
import {
  initOverlaySelection,
  handleOverlayClick,
  handleOverlayDblclick,
  selectOverlay,
  setSelectedOverlay,
  selectAllOverlays,
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
  rotateSelectedShape,
  // (form-fill imports below)
  currentRedactionColor,
  currentMarkerColor,
  currentMarkerStyle,
  currentMarkerThickness,
  currentTextFontId,
  currentTextFontSize,
  currentTextColor,
  currentTextDigitsHanko,
  currentTextBold,
  REDACTION_COLOR_STORAGE_KEY,
  MARKER_COLOR_STORAGE_KEY,
  MARKER_STYLE_STORAGE_KEY,
  MARKER_THICKNESS_STORAGE_KEY,
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
import { openWorkspaceCleanupDialog } from "./workspace-cleanup-dialog.js";
import {
  initImageExport,
  startRegionImageDrag,
  actionExportAsImage,
} from "./image-export.js";
import { initPageNumbers } from "./page-numbers.js";
import {
  initSaveFlow,
  isPdfOutOfSync,
  actionSave,
  actionExportToPath,
  actionRestoreEditableMaster,
  refreshRestoreMasterUI,
} from "./save-flow.js";
import {
  initSidebarThumbs,
  actionToggleBookmarks,
  refreshSidebarToggle,
  switchSidebarTab,
  getCurrentSidebarTab,
  setCurrentSidebarTab,
  thumbCache,
  invalidateSidebarThumb,
  rebuildThumbs,
  clearThumbs,
  highlightCurrentThumb,
  sidebarThumbSelection,
  splitThumbSelection,
  getOrderedThumbPageNos,
} from "./sidebar-thumbs.js";
import {
  initSplitView,
  splitState,
  setSplitMode,
  isSplitModeActive,
  actionSplitSave,
  refreshSplitView,
} from "./split-view.js";
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
const btnRestoreMaster = $("btn-restore-master");
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
const markerStyleSel = $("marker-style");
const markerThicknessSel = $("marker-thickness");
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
const splitFlow = $("split-flow");
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
  // β.107: 群移動 — viewer は selection 状態を持たないので、selection 中
  // 全 id を返す callback を渡し、群移動 commit 用 callback で 1 undo に
  // まとめる (CompositeCommand)。
  getSelectedOverlayIds: () => getSelectedIds(),
  onOverlayDragEndGroup: (updates) => {
    const subs = [];
    for (const u of updates) {
      const ov = projectStore.get(u.id);
      if (!ov) continue;
      if (ov.x === u.x && ov.y === u.y) continue;
      subs.push(new UpdateOverlayCommand(projectStore, u.id, { x: u.x, y: u.y }));
    }
    if (!subs.length) return;
    if (subs.length === 1) {
      history.execute(subs[0]);
    } else {
      history.execute(new CompositeCommand(subs, `Move ${subs.length} overlays`));
    }
  },
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
    populateTextToolbar();
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
// 2026-07-11: 白黒印刷は sticky トグル (β.88、localStorage 永続) を廃止し、
// ワンショットの「白黒印刷」ボタンに変更 — actionPrint({ mono: true })。
// モードが残留して次回以降の印刷を黒化する事故を避ける (毎回明示方針)。

// β.114 → β.115: 罫線抑制トグルはツールバーから撤去 (メニュー簡素化)。
// 内部の line-suppress.js / viewer.setSuppressLines は将来「ツール」経由
// での再公開に備えて残置 (= 隠し API)。

initPrintFlow({
  projectStore: () => projectStore,
  viewer,
  wsStatus,
  isOpen: () => isOpen,
  splitThumbSelection: () => splitThumbSelection,
  sidebarThumbSelection: () => sidebarThumbSelection,
  isSplitMode: () => isSplitModeActive(),
  fetchVisiblePages: () => fetchVisiblePages(),
});
initImageExport({
  isOpen: () => isOpen,
  projectStore: () => projectStore,
  viewer,
  activeSourceName: () => activeSourceName,
  fetchVisiblePages: () => fetchVisiblePages(),
  parseMultiPageRange: (text, total) => parseMultiPageRange(text, total),
  setPlacementMode: (mode) => setPlacementMode(mode),
});
initPageNumbers({
  isOpen: () => isOpen,
  projectStore: () => projectStore,
  history: () => history,
  pendingDeletedPages: () => pendingDeletedPages,
});
initSaveFlow({
  isOpen: () => isOpen,
  projectStore: () => projectStore,
  history: () => history,
  pendingDeletedPages: () => pendingDeletedPages,
  workspaceMutated: () => workspaceMutated,
  setWorkspaceMutated: (v) => { workspaceMutated = v; },
  activeSourceName: () => activeSourceName,
  thumbSelection: () => sidebarThumbSelection,
  isWorkspaceDirty: () => isWorkspaceDirty(),
  fetchVisiblePages: () => fetchVisiblePages(),
  refreshDirtyIndicator: () => refreshDirtyIndicator(),
  refreshMenuState: () => refreshMenuState(),
  refreshViewer: () => refreshViewer(),
  // menuBar は下方で生成される const — early boot 中の呼び出しは TDZ で
  // throw し、save-flow 側の従来 catch (menuBar not ready) が握る。
  setMenuEnabled: (map) => menuBar.setEnabled(map),
});
initSidebarThumbs({
  viewer,
  isOpen: () => isOpen,
  projectStore: () => projectStore,
  pendingDeletedPages: () => pendingDeletedPages,
  isSplitMode: () => isSplitModeActive(),
  refreshViewer: () => refreshViewer(),
  refreshSplitView: () => refreshSplitView(),
  markWorkspaceMutated: () => markWorkspaceMutated(),
  refreshDirtyIndicator: () => refreshDirtyIndicator(),
  refreshMenuState: () => refreshMenuState(),
  updateTabBarOffset: () => updateTabBarOffset(),
  rotatePageBy: (pageNo, delta) => rotatePageBy(pageNo, delta),
});
initSplitView({
  viewer,
  isOpen: () => isOpen,
  projectStore: () => projectStore,
  fetchVisiblePages: () => fetchVisiblePages(),
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
    tab.currentSidebarTab = getCurrentSidebarTab();
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
    setCurrentSidebarTab(tab.currentSidebarTab);
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
    setCurrentSidebarTab("thumbs");
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
  // 連続テキスト入力 (sticky text) の副作用ガード: インライン編集を確定
  // するためにページをクリックした「その同じクリック」では新規配置しない。
  // これが無いと、テキストモードのまま編集を終えるたびに新しいテキスト枠が
  // 落ちてしまう。クリックは編集の blur 確定だけに使い、次のクリックで配置。
  if (typeof viewer.isInlineEditing === "function" && viewer.isInlineEditing()) return;
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

// β.146: ツールバー右端「»」= 「その他」+「幅に入りきらない項目の退避先」。
//  (1) 静的: 下敷き印刷/ページ番号/別窓/別窓化 (常にここ。隠し本体を click 委譲)。
//  (2) 動的: 幅が足りない時、表示倍率→検索→回転→… の順に実コントロールを
//      #overflow-dynamic へ移動する (縮めない方式なので高さ一定・アイコン無ズレ)。
// menu-bar.js には密結合せず、同じ .menu-dropdown の見た目を流用。Win95 流に
// 外側クリック / Esc で閉じ、メニューバーを開いたら閉じる (逆も)。
(function wireOverflowMenu() {
  const btn = $("btn-overflow");
  const menu = $("menu-overflow");
  const toolbar = document.querySelector(".toolbar");
  const dynamic = $("overflow-dynamic");
  const sep = $("overflow-sep");
  if (!btn || !menu || !toolbar || !dynamic) return;

  const close = () => {
    menu.hidden = true;
    btn.classList.remove("active");
  };
  const open = () => {
    for (const dd of document.querySelectorAll(".menu-dropdown")) {
      if (dd !== menu) dd.hidden = true;
    }
    menu.hidden = false;
    btn.classList.add("active");
    // ボタン右辺にメニュー右辺を揃える (画面外はみ出し回避)
    const rect = btn.getBoundingClientRect();
    menu.style.left = `${Math.max(2, rect.right - menu.offsetWidth)}px`;
    menu.style.top = `${rect.bottom}px`;
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) open();
    else close();
  });
  // 静的項目: 隠し本体ボタンへ委譲 (disabled なら無反応)
  for (const mi of menu.querySelectorAll(".menu-item[data-target]")) {
    mi.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
      const target = $(mi.dataset.target);
      if (target && !target.disabled) target.click();
    });
  }
  // 退避してきた実ボタンをメニュー内でクリックしたら閉じる (select / 検索入力は
  // そのまま操作させたいので閉じない)。
  dynamic.addEventListener("click", (e) => {
    if (e.target.closest("button")) close();
  });
  // 外側クリックで閉じる。ただし「メニュー内」(退避した表示倍率 select・検索入力を
  // 含む) と「» ボタン自身」のクリックは閉じない。
  // ※ β.146 不具合修正: 無条件 close だと、退避した #zoom-select を開こうとした
  //   click が document まで伝播して menu が hidden になり、native ドロップダウンが
  //   即 dismiss されて「倍率を選べない」状態になっていた。退避ボタンのクリックは
  //   上の dynamic ハンドラが明示 close するので、ここはメニュー外だけを閉じる。
  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  // メニューバー項目クリックで » を閉じる (menu-bar.js が stopPropagation する
  // ため capture で先に拾う)。
  $("menu-bar")?.addEventListener("click", close, true);

  // ── レスポンシブ退避 ──────────────────────────────────────────────
  // 先頭ほど先に » へ入る (要望どおり 表示→検索→回転→… の順)。末尾の
  // ファイル系まで並べておき、極端に狭くても 1 行・一定高を保てるようにする。
  const ORDER = [
    "tb-zoom", "tb-search", "tb-rotate",
    "btn-mode-region-image", "btn-split",
    "btn-shape-palette", "btn-form-palette",
    "btn-mode-callout", "btn-mode-marker", "btn-mode-redaction",
    "btn-mode-stamp", "btn-mode-text",
    "btn-restore-master",
    "btn-fax-send", "btn-mono-print", "btn-print", "btn-export", "btn-save",
  ];
  // 復元用に元の並び (toolbar 直下要素) を記録。
  const original = Array.from(toolbar.children);
  const isVisible = (el) =>
    !el.hidden &&
    el.style.display !== "none" &&
    getComputedStyle(el).display !== "none";

  const restoreAll = () => {
    for (const el of original) toolbar.appendChild(el);
  };
  const fits = () => toolbar.scrollWidth <= toolbar.clientWidth + 1;

  function collapseInto(id) {
    const el = document.getElementById(id);
    if (!el) return;
    // アイコンのみボタンは title 先頭をメニュー用ラベルに (一度だけ付与)。
    if (el.tagName === "BUTTON" && !el.querySelector("span") && !el.dataset.ovlabel) {
      const t = (el.getAttribute("title") || "").split("—")[0].trim();
      if (t) el.dataset.ovlabel = t;
    }
    dynamic.appendChild(el);
  }

  // 退避で生じる区切り線の重複・先頭/末尾の宙ぶらりんを掃除。
  function normalizeSeps() {
    let prevWasSepOrStart = true;
    for (const el of toolbar.children) {
      if (el.classList.contains("toolbar-sep")) {
        el.style.display = prevWasSepOrStart ? "none" : "";
        prevWasSepOrStart = true;
      } else if (isVisible(el)) {
        prevWasSepOrStart = false;
      }
    }
    const kids = Array.from(toolbar.children);
    for (let i = kids.length - 1; i >= 0; i--) {
      const el = kids[i];
      if (el.classList.contains("toolbar-sep")) el.style.display = "none";
      else if (isVisible(el)) break;
    }
  }

  function reflow() {
    restoreAll();
    for (const s of toolbar.querySelectorAll(".toolbar-sep")) s.style.display = "";
    for (const id of ORDER) {
      if (fits()) break;
      collapseInto(id);
    }
    if (sep) sep.style.display = dynamic.children.length ? "" : "none";
    normalizeSeps();
  }

  let raf = 0;
  const schedule = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(reflow);
  };
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(schedule).observe(toolbar);
  }
  window.addEventListener("resize", schedule);
  schedule();
})();

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
function pasteOverlayFromClipboard(anchor = null) {
  if (!_overlayClipboard || _overlayClipboard.length === 0) {
    wsStatus.textContent = "貼り付けるものがありません";
    return;
  }
  // anchor.pageNo が指定されればそのページ、なければ viewer の active page
  // (= 直近にクリックしたページ、無ければ scroll 由来の current page)。
  // 「ペースト先のページをクリックしてから Ctrl+V」が直感どおり動く。
  const pageNo = anchor?.pageNo || viewer.activePage || _overlayClipboard[0]?.pageNo || 1;
  // anchor.x/y が指定されたら、primary (= clipboard[0]) を anchor 位置に
  // 配置し、他は元の相対位置を維持する (group paste の自然な挙動)。
  // anchor 無しは従来通り +12pt 平行移動。
  let dx, dy;
  if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
    const head = _overlayClipboard[0];
    dx = anchor.x - (head?.x ?? 0);
    dy = anchor.y - (head?.y ?? 0);
  } else {
    dx = 12;
    dy = 12;
  }
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
 *  the right-click「貼り付け」menu (when OS clipboard has an image).
 *  anchor: {pageNo, x, y} を渡すと貼り付け先をそのページ + 座標 (画像の
 *  中央が anchor になる) に固定。 */
async function pasteImageBlob(blob, mime, anchor = null) {
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
  // swap を反映。anchor 指定があればそのページ、無ければ viewer の
  // active page (= 直近 click、無ければ scroll 由来の current)。
  const pageNo = anchor?.pageNo || viewer.activePage || 1;
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
  // anchor.x/y は画像の中央に合わせる (右クリック位置=画像中心の直感)。
  // page 範囲外にならないよう clamp。anchor 無しはページ中央に置く従来挙動。
  const cx = Number.isFinite(anchor?.x) ? anchor.x : pageW / 2;
  const cy = Number.isFinite(anchor?.y) ? anchor.y : pageH / 2;
  const x = Math.max(0, Math.min(pageW - w, cx - w / 2));
  const y = Math.max(0, Math.min(pageH - h, cy - h / 2));
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
      // Clipboard paste 由来の画像は元画像の縦横比を維持したい (ユーザ
      // 要望: スクショ・写真をペーストして拡大縮小しても歪まないこと)。
      // viewer の resize ハンドルがこのフラグを読んで主軸方式で aspect
      // を保つ。palette 由来の画像スタンプは付かないので従来通り自由。
      aspectLocked: true,
    },
  });
  history.execute(cmd);
  if (cmd._snapshot) setSelectedOverlay(cmd._snapshot.id);
  wsStatus.textContent = `画像を貼り付けました (${Math.round(w)}×${Math.round(h)}pt, ${imgW}×${imgH}px)`;
}

/** OS クリップボードに画像があれば貼り付け、なければ内部 _overlayClipboard
 *  にフォールバック。右クリック「貼り付け」とメニューバー「貼り付け」
 *  はこちらを呼ぶ (paste event は Ctrl+V ネイティブ経路で別途発火)。
 *  anchor: {pageNo, x, y} を渡すと貼り付け先をクリックページ + 座標に固定。 */
async function tryPasteFromAnyClipboard(anchor = null) {
  // navigator.clipboard.read は permission 要 / async API。Electron では
  // 通常許可されているが念のため try で囲んでフォールバック。
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (/^image\/(png|jpe?g|webp)$/i.test(type)) {
          const blob = await item.getType(type);
          await pasteImageBlob(blob, type, anchor);
          return;
        }
      }
    }
  } catch {
    // permission denied / API unsupported — fall through to internal.
  }
  if (_overlayClipboard) {
    pasteOverlayFromClipboard(anchor);
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
/** 右クリック時に保存される「貼り付け先」。dispatchPageCtx で paste を
 *  実行する時に参照する。null なら viewer.currentPage に貼り付ける旧挙動。 */
let _pagePasteAnchor = null;
function showPageContextMenu(x, y, anchor = null) {
  if (!ctxPage) return;
  _pagePasteAnchor = anchor;
  // Mark the currently-active mode with the existing ".checked" style
  // (✓ left of the item) so the user can see what's on.
  for (const item of ctxPage.querySelectorAll(".menu-item")) {
    const mode = item.dataset.ctx;
    const isActive =
      (mode === "none" && placementMode === "none") ||
      (mode !== "none" && mode === placementMode);
    item.classList.toggle("checked", isActive);
    // paste 項目は clipboard が空のとき灰色化 (内部 overlay クリップ + OS
    // 画像のどちらかでもあれば有効。OS 画像有無の事前 sync 判定は重い
    // ので、内部クリップが空のときだけ disabled にする保守的方針)。
    if (mode === "paste") {
      const enabled = !!(_overlayClipboard && _overlayClipboard.length);
      item.classList.toggle("disabled", !enabled);
    }
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
  if (!(target instanceof HTMLElement)) return;
  const mode = target.dataset.ctx;
  if (!mode) return;
  if (target.classList.contains("disabled")) {
    hidePageContextMenu();
    return;
  }
  if (mode === "paste") {
    const anchor = _pagePasteAnchor;
    hidePageContextMenu();
    void tryPasteFromAnyClipboard(anchor);
    return;
  }
  hidePageContextMenu();
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
  if (!(e.target instanceof HTMLElement)) return;
  const pageEl = e.target.closest(".viewer-page");
  if (!(pageEl instanceof HTMLElement)) return;
  e.preventDefault();
  // 右クリックした位置を canonical 座標で記録。paste 時に「現在ページ」
  // ではなくクリックしたページに貼り付けるための anchor。
  const pageNo = Number(pageEl.dataset.pageNo) || 0;
  const rect = pageEl.getBoundingClientRect();
  const z = viewer.zoom || 1;
  const anchor = pageNo > 0
    ? { pageNo, x: (e.clientX - rect.left) / z, y: (e.clientY - rect.top) / z }
    : null;
  showPageContextMenu(e.clientX, e.clientY, anchor);
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
/** 吹き出し overlay 判定 (rect + kind=callout)。text と同じ書式バーを
 *  共有するための共通ヘルパ。 */
function _isCalloutOverlay(ov) {
  return !!ov && ov.type === "rect" && ov.properties?.kind === "callout";
}

function refreshModeOptionsBar() {
  const bar = $("mode-options-bar");
  if (!bar) return;
  let which;
  if (placementMode === "callout") {
    which = "text";
  } else if (placementMode !== "none") {
    which = placementMode;
  } else if (!formFillMode && getSelectionSize() >= 1) {
    // β.107: multi-select 時も「全部同種 form_field」なら専用パネル表示
    // (= 一括変更可能)。異種混在 or 非 form_field 単独 なら hide。
    // β.141: 配置済み text overlay 選択時も text オプションバーを出す
    // (β.140 で populateTextToolbar / change handler は配線されたが、
    // バー自体を表示する分岐が抜けていた)。multi-select は全 text のとき
    // だけ (異種混在は hide)。これで text-font / size / color / digits
    // hanko / 太字 を後付け編集できる。
    const selId = getPrimarySelectedId();
    const primary = selId ? projectStore.get(selId) : null;
    if (primary?.type === "form_field") {
      const kind = primary.properties?.fieldKind;
      let homogeneous = true;
      if (getSelectionSize() > 1) {
        for (const id of getSelectedIds()) {
          const ov = projectStore.get(id);
          if (!ov || ov.type !== "form_field" || ov.properties?.fieldKind !== kind) {
            homogeneous = false;
            break;
          }
        }
      }
      which = homogeneous ? (
        kind === "text"   ? "form-text"   :
        kind === "check"  ? "form-check"  :
        kind === "circle" ? "form-circle" :
        kind === "radio"  ? "form-radio"  : null
      ) : null;
    } else if (primary?.type === "text" || _isCalloutOverlay(primary)) {
      // β.143: 配置済みテキスト枠 / 吹き出しを選択したら text オプション
      // バーを出す。両者はフォント/サイズ/色/太字/数字 hanko の同じ
      // プロパティを共有するので、混在選択 (text + callout) も同じバーで
      // 一括編集できる。異種 (form_field / shape / stamp 等) が混ざれば hide。
      let homogeneous = true;
      if (getSelectionSize() > 1) {
        for (const id of getSelectedIds()) {
          const ov = projectStore.get(id);
          if (!ov || (ov.type !== "text" && !_isCalloutOverlay(ov))) {
            homogeneous = false;
            break;
          }
        }
      }
      which = homogeneous ? "text" : null;
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
  // ADR-0026: 「編集に戻す」は lineage 依存。ここでは一旦無効化し、直後の
  // refreshViewer → refreshRestoreMasterUI が確定版のときだけ再点灯する。
  if (btnRestoreMaster) btnRestoreMaster.disabled = true;
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
  if (markerStyleSel) markerStyleSel.disabled = !open;
  if (markerThicknessSel) markerThicknessSel.disabled = !open;
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
  // β.146: ツールバー右端「»」は常時有効。幅退避で表示倍率/検索などが
  // 中に入ってくるので、ドキュメント未オープンでも開けるようにしておく
  // (各項目自身の disabled で操作可否は表現される)。
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
  // ADR-0026: keep 「編集に戻す」in sync — critical for the close path, where
  // refreshViewer early-returns before its own refreshRestoreMasterUI call.
  void refreshRestoreMasterUI();
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
    "mono-print-toggle": isOpen,
    "fax-send": isOpen,
    "overlay-only-print": isOpen,
    properties: isOpen,
    find: isOpen,
    "rotate-left": isOpen,
    "rotate-right": isOpen,
    "page-popup": isOpen,
    "detach-tab": isOpen,
    "mode-text": isOpen,
    "mode-stamp": isOpen,
    "mode-redaction": isOpen,
    "mode-marker": isOpen,
    "mode-callout": isOpen,
    "shape-palette": isOpen,
    "form-palette": isOpen,
    "page-numbers": isOpen,
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
    "shape-palette": placementMode === "shape",
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
  // ADR-0026: keep the「編集に戻す」affordance in sync with the active tab's
  // lineage (covers open / tab switch). Fire-and-forget — must not block the
  // viewer refresh.
  void refreshRestoreMasterUI();
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

// ---- Recent files submenu populator -----------------------------------
// Populates File > 最近のファイル on hover. Max 9 entries so a future
// 1-9 access-key shortcut maps one-to-one.
const RECENT_SUBMENU_LIMIT = 9;
async function populateRecentSubmenu() {
  const recents = await kpdf3.listRecentPdfs();
  if (!recents || recents.length === 0) return [];
  return recents.slice(0, RECENT_SUBMENU_LIMIT).map((r, i) => ({
    label: `${i + 1}  ${r.sourcePdfName ?? "(unknown)"}`,
    title: r.sourcePdfPath ?? "",
    action: () => openPdfSmart(r.sourcePdfPath),
  }));
}

async function openPdfPath(pdfPath) {
  if (!pdfPath) return;
  // β.135: 巨大 PDF (200MB+ サイドカー経路) は読込 2〜数秒かかるため
  // フリーズ誤認を防ぐ busy modal。通常サイズで一瞬で開けるケースで
  // フラッシュしないよう 300ms 遅延表示。完了/失敗 finally で hide。
  let _busyTimer = setTimeout(() => {
    _busyTimer = null;
    try { showBusy("PDF を読み込み中", "大きな PDF は数秒かかることがあります...", 0); } catch { /* ignore */ }
  }, 300);
  try {
    // ADR-0015: bind the workspace handle on the main side to the
    // active tab's id. Phase 4's "+ button" creates a fresh TabState
    // first, so this same path also opens into NEW tabs.
    let result = await kpdf3.openPdfFile(pdfPath, getActiveTabId());
    // パスワード保護 PDF: main 側が { needsPassword } sentinel を返す。
    // 入力を促して qpdf で復号 → 復号版を取り込む。誤入力は再試行、
    // キャンセルなら静かに中断 (エラー扱いにしない)。
    // REVIEW-2026-07 #3: 実ユーザーパスワードで開いたかを覚えておき、
    // 開き終わった後に「保存すると保護が外れる」警告を出す。
    let enteredPassword = false;
    if (result && result.needsPassword) {
      const fileName = pdfPath.split(/[\\/]/).pop() ?? "";
      // 入力ダイアログを出す間は読み込み中 modal を隠す。
      if (_busyTimer) { clearTimeout(_busyTimer); _busyTimer = null; }
      else { try { hideBusy(); } catch { /* ignore */ } }
      let wrong = false;
      for (;;) {
        if (result.qpdfMissing) {
          await customConfirm({
            title: "パスワード付き PDF",
            message: "この PDF を開くには復号が必要ですが、復号ツール (qpdf) が見つかりませんでした。配布版のアプリには同梱されています。",
            cancelLabel: null,
          });
          return;
        }
        const pw = await customPasswordPrompt({ fileName, wrong });
        if (pw == null) return; // ユーザーがキャンセル
        try { showBusy("PDF を復号中", "パスワードを確認しています...", 0); } catch { /* ignore */ }
        result = await kpdf3.openPdfFile(pdfPath, getActiveTabId(), { password: pw });
        try { hideBusy(); } catch { /* ignore */ }
        if (!result || !result.needsPassword) {
          enteredPassword = !!result;
          break;
        }
        wrong = !!result.wrongPassword;
      }
    }
    if (!result || result.needsPassword) return;
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
    // ADR-0026: フラット版 (確定版) を開いたら「編集に戻す」で再編集できる
    // ことを一度だけ案内する。lineage が切れている (別 PC 確定 / userData 掃除)
    // 場合は黙らず明示する。
    if (result.hasEditableMaster) {
      wsStatus.textContent =
        "このファイルは確定版です — ［編集に戻す］でテキスト等をまた動かせます";
    } else if (result.masterMissing) {
      wsStatus.textContent =
        "このファイルは確定版ですが、編集可能な状態がこの PC に見つかりません";
    }
    // REVIEW-2026-07 #3: 実ユーザーパスワードを入力して復号した時だけ、
    // 保存/書き出しで保護が外れることを開いた直後に警告する。案件ごとに
    // 意識すべき情報なので「次から表示しない」は付けない (開くたびに出る)。
    // 権限制限のみ / 空パスワードの PDF はプロンプト自体が出ないので対象外。
    if (enteredPassword) {
      const fname = pdfPath.split(/[\\/]/).pop() ?? "";
      await customConfirm({
        title: "パスワード保護について",
        message: `「${fname}」はパスワードを外した状態で編集用に取り込みました。`,
        warning: "このファイルを保存・書き出しすると、パスワード保護の無い PDF が作成されます (Dropbox 等の同期先にもそのまま置かれます)。",
        cancelLabel: null,
      });
    }
  } catch (err) {
    console.error("[renderer] openPdfFile (recent) failed:", err);
    wsStatus.textContent = `エラー: ${err.message ?? err}`;
  } finally {
    // β.135: タイマー未発火なら busy 未表示なので clear のみ、
    // 発火済なら hideBusy で閉じる。
    if (_busyTimer) clearTimeout(_busyTimer);
    else { try { hideBusy(); } catch { /* ignore */ } }
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
 *  toolbar 開く button, the file menu, the recents submenu and the
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
    monoExportToggle: true,
  });
  if (!choice) return;
  const { path: savePath, secureExport, monoExport } = choice;

  const filteredPages = pages.slice(range.start - 1, range.end);
  showBusy("書き出し準備", `ページ ${range.start}-${range.end} を描画しています...`, 0);
  try {
    const composed = await composePagesForExport({
      pages: filteredPages,
      projectStore,
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
      rasterRedactionPages: true,
      monoOverlays: !!monoExport,
      vectorTextProbe: kpdf3.vectorTextProbe, // v2.0.13 ベクターテキスト層
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
    // 書き出した PDF を新タブで開いて、ユーザーが書き出し結果を直接確認
    // できるようにする (元タブは編集状態を維持)。Save As と同じ動線。
    try { await newTabAndOpen(savePath); }
    catch (openErr) { console.error("[renderer] post-export open failed:", openErr); }
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
    monoExportToggle: true,
  });
  if (!choice) return;
  await actionExportToPath(choice.path, {
    secureExport: choice.secureExport,
    monoExport: choice.monoExport,
  });
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

// 戻り値: 回転を実行した (またはエラー表示済み) なら true、対象ページが
// 見つからず黙って skip したときだけ false。2026-07-06 の「先頭に Word を
// 差し込んだ同一セッションで一括回転が無反応」報告 (再現不能) は、この
// 無言 skip が最有力仮説 — 次に遭遇した瞬間にどの pageNo が外れたかを
// 確定できるよう、skip を可視化する。既存の回転経路自体は不変。
async function rotatePageBy(pageNo, delta) {
  if (!isOpen || !pageNo) {
    console.warn("[rotate] skipped — not open or bad pageNo", { isOpen, pageNo });
    return false;
  }
  const row = viewer._pages?.find((p) => p.pageNo === pageNo);
  if (!row) {
    console.warn(`[rotate] p.${pageNo} not in viewer._pages — skipped`, {
      viewerPages: viewer._pages?.map((p) => p.pageNo),
    });
    wsStatus.textContent =
      `p.${pageNo} が見つからず回転をスキップしました — ファイルを閉じて開き直すと回転できる可能性があります`;
    return false;
  }
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
    // 回転 (userRotation) は workspace の変更だが、元 PDF バイトには
    // 焼かれていない。これを dirty として記録しないと、回転だけのページ
    // (overlay 無し) では projectStore も pendingDeletedPages も動かず、
    // 上書き保存 (actionSave) が冒頭の dirty ガードで no-op になり、回転が
    // 元 PDF に書き戻されない → 他ビューア / 紙で回転が落ちる (v2.0.7 で
    // actionExportToPath の byte-copy ゲートは直したが、上書き保存はそこへ
    // 到達する前に return していた)。markWorkspaceMutated で dirty 表示も
    // 点灯し、ユーザーに未保存の回転があることを知らせる。
    markWorkspaceMutated();
    await refreshViewer();
    // Keep the user looking at the same page after the rebuild.
    viewer.scrollToPage(pageNo);
    // If the split view is open, rebuild it too so the rotated page
    // appears in the split-save thumbnails.
    if (isSplitModeActive()) await refreshSplitView();
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
  // catch 側も true: エラーは上で表示済みなので「見つからず skip」とは
  // 区別する (rotateCurrentPage の集計メッセージで上書きさせない)。
  return true;
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
  const skipped = [];
  for (const pageNo of targets) {
    const ok = await rotatePageBy(pageNo, delta);
    if (ok === false) skipped.push(pageNo);
  }
  // 一括回転で 1 ページでも無言 skip があれば集計して見せる (単発の
  // skip メッセージは成功ページの「p.X を N° 回転」で流れるため)。
  if (skipped.length > 0) {
    wsStatus.textContent =
      `${skipped.map((n) => `p.${n}`).join(", ")} が見つからず回転をスキップしました`
      + ` (${skipped.length}/${targets.length} 件) — ファイルを閉じて開き直すと回転できる可能性があります`;
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
  // β.132: ラベルを「後で」→「閉じる」へ。「後で」は「(K-PDF3 が) 後で
  // 自動的に進めてくれる」と読まれがちで、実際には次回起動まで何も
  // 起きない (= 同じダイアログが再表示されるだけ) 挙動と乖離していた。
  // メッセージにも「次回起動時にもう一度お聞きします」を明記して、
  // 「保留 = 中間状態を作る」と誤解されない UX にする (β.31/β.32 仮説
  // 対応: ユーザが期待値ズレで何度も触り直す経路を断つ)。
  const ok = await customConfirm({
    title: "更新が利用可能",
    message:
      `${ver} が利用可能です。\n今すぐダウンロードしますか？\n\n`
      + `（ダウンロード後、再起動の確認があります。\n`
      + `「閉じる」を選ぶと次回起動時にもう一度お聞きします。）`,
    okLabel: "ダウンロード",
    cancelLabel: "閉じる",
  });
  if (!ok) {
    updaterMode = "auto";
    return;
  }
  updaterDownloadInFlight = true;
  // β.132: ダウンロード中の中止ボタンを busy modal に追加。
  // electron-updater は CancellationToken 経由でキャンセルすると
  // .partial ファイル / blockmap キャッシュを掃除してくれるので、
  // 中途半端な状態が残らない (= autoUpdater「後で」仮説の打ち手)。
  showBusy("更新をダウンロード中", "通信を開始しています...", 0, {
    cancelLabel: "中止",
    cancelBusyMessage: "ダウンロードを中止しています...",
    onCancel: () => {
      // fire-and-forget — main の cancel ハンドラがトークンを cancel し、
      // downloadUpdate の Promise が CancellationError で reject される。
      // そちらで updaterDownloadInFlight=false + hideBusy する。
      kpdf3.updaterCancelDownload?.();
    },
  });
  const res = await kpdf3.updaterDownload();
  if (res && res.ok === false) {
    updaterDownloadInFlight = false;
    hideBusy();
    // Cancellation はユーザが明示的に押した結果なので、エラー扱いせず
    // ステータスバーで簡潔に通知して終わり。
    if (res.cancelled) {
      wsStatus.textContent = "更新のダウンロードを中止しました";
      updaterMode = "auto";
      return;
    }
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
  // β.132: 「次回起動時に適用」が実際に成立するよう updater.js で
  // autoInstallOnAppQuit=true に変更済。メッセージにも「アプリ終了時
  // に自動適用」と明記して期待値を合わせる。
  const ok = await customConfirm({
    title: "更新の準備完了",
    message:
      `${ver} のダウンロードが完了しました。\n`
      + `今すぐ再起動して適用しますか？\n\n`
      + `（「次回起動時に適用」を選ぶと、アプリを閉じた際に\n`
      + `自動的に適用されます。未保存の変更は事前に保存してください。）`,
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
  //
  // 2026-07-14: **ダウンロードを始めたあとの失敗は自動チェックでも必ず出す**。
  // 従来は auto のまま黙って捨てていたため、Mac 更新で検証/差し替えに失敗
  // しても「進捗バーが消えて何も起きない」ようにしか見えなかった (実機報告)。
  // 更新サーバーに繋がらないのと、掴んだ更新の適用に失敗したのは別物。
  if (updaterMode === "manual" || updaterDownloadInFlight) {
    const wasDownloading = updaterDownloadInFlight;
    updaterDownloadInFlight = false;
    hideBusy();
    void customConfirm({
      title: wasDownloading ? "更新の適用に失敗" : "更新の確認に失敗",
      message: wasDownloading
        ? `更新を適用できませんでした。\n${err?.message || ""}`
        : `更新サーバーへの接続に失敗しました。\n${err?.message || ""}`,
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

function actionExit() {
  window.close();
}

// ---- β.122 PDF プロパティダイアログ -----------------------------------
// ファイル > プロパティ。Adobe Acrobat 流の「文書のプロパティ」と同等の
// タブ切替 UI (概要 / セキュリティ / フォント / 規格)。main 側で mupdf
// 経由で metadata + ページサイズ集計 + 暗号化 + フォント一覧を抽出する
// (kpdf3:get-pdf-properties)。
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  const KB = 1024, MB = KB * 1024, GB = MB * 1024;
  if (n >= GB) return `${(n / GB).toFixed(2)} GB (${n.toLocaleString()} バイト)`;
  if (n >= MB) return `${(n / MB).toFixed(2)} MB (${n.toLocaleString()} バイト)`;
  if (n >= KB) return `${(n / KB).toFixed(1)} KB (${n.toLocaleString()} バイト)`;
  return `${n.toLocaleString()} バイト`;
}

function formatTimestamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// PDF metadata の CreationDate / ModDate は "D:YYYYMMDDHHmmSS+09'00'" 形式。
// 1 つだけ pretty に。失敗したら生のまま返す。
function formatPdfDate(s) {
  if (typeof s !== "string" || s.length === 0) return "";
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s);
  if (!m) return s;
  const [, Y, M = "01", D = "01", h = "00", mi = "00", se = "00"] = m;
  return `${Y}/${M}/${D} ${h}:${mi}:${se}`;
}

function fillKvTable(tbody, rows) {
  tbody.innerHTML = "";
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    const tdK = document.createElement("td");
    tdK.className = "k";
    tdK.textContent = k;
    const tdV = document.createElement("td");
    tdV.className = v ? "v" : "v empty";
    tdV.textContent = v || "(なし)";
    tr.appendChild(tdK);
    tr.appendChild(tdV);
    tbody.appendChild(tr);
  }
}

function populatePropertiesDialog(props) {
  // 概要
  const meta = props.metadata || {};
  const file = props.file || {};
  fillKvTable($("properties-tbody-summary"), [
    ["ファイル名", file.path ? file.path.split(/[\\/]/).pop() : ""],
    ["保存場所", file.path || ""],
    ["ファイルサイズ", formatBytes(file.size)],
    ["タイトル", meta.Title || ""],
    ["作成者", meta.Author || ""],
    ["題名", meta.Subject || ""],
    ["キーワード", meta.Keywords || ""],
    ["アプリケーション", meta.Creator || ""],
    ["PDF 制作元", meta.Producer || ""],
    ["PDF 作成日", formatPdfDate(meta.CreationDate)],
    ["PDF 更新日", formatPdfDate(meta.ModDate)],
    ["ファイル更新日時", formatTimestamp(file.mtimeMs)],
  ]);
  // セキュリティ
  fillKvTable($("properties-tbody-security"), [
    ["暗号化", props.encrypted ? "あり (パスワード保護 or 権限制限)" : "なし"],
    ["セキュア書き出し", "「名前を付けて保存」「上書き保存」のチェックで個人情報・編集履歴・墨消し下の文字を除去できます (qpdf 経由)"],
  ]);
  // フォント
  const fontTbody = $("properties-tbody-fonts");
  fontTbody.innerHTML = "";
  const fonts = Array.isArray(props.fonts) ? props.fonts : [];
  if (fonts.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.style.padding = "8px";
    td.style.color = "#888";
    td.textContent = "フォント情報なし (画像主体の PDF か、フォント情報が読み取れません)";
    tr.appendChild(td);
    fontTbody.appendChild(tr);
  } else {
    for (const f of fonts) {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      tdName.textContent = f.baseFont || "—";
      const tdType = document.createElement("td");
      tdType.textContent = f.subtype || "—";
      const tdEmbed = document.createElement("td");
      tdEmbed.textContent = f.embedded ? "あり" : "なし";
      tdEmbed.className = f.embedded ? "col-embed-yes" : "col-embed-no";
      const tdSubset = document.createElement("td");
      tdSubset.textContent = f.subset ? "あり" : "なし";
      tr.appendChild(tdName);
      tr.appendChild(tdType);
      tr.appendChild(tdEmbed);
      tr.appendChild(tdSubset);
      fontTbody.appendChild(tr);
    }
  }
  // 規格
  const sizeStrs = (props.pageSizes || []).map((s) => {
    const mm = (pt) => Math.round((pt * 25.4) / 72);
    const tag = s.count === props.pageCount ? "" : ` (${s.count} ページ)`;
    return `${s.widthPt} × ${s.heightPt} pt = ${mm(s.widthPt)} × ${mm(s.heightPt)} mm${tag}`;
  });
  fillKvTable($("properties-tbody-spec"), [
    ["PDF バージョン", props.pdfVersion ? props.pdfVersion.toFixed(1) : "—"],
    ["ページ数", String(props.pageCount ?? "—")],
    ["ページサイズ", sizeStrs.length > 0 ? sizeStrs.join(" / ") : "—"],
  ]);
}

function setupPropertiesTabs() {
  const tabs = $("properties-tabs");
  if (!tabs || tabs._wired) return;
  tabs._wired = true;
  tabs.addEventListener("click", (e) => {
    const li = e.target instanceof HTMLElement ? e.target.closest("li[data-tab]") : null;
    if (!li) return;
    e.preventDefault();
    const key = li.dataset.tab;
    for (const t of tabs.querySelectorAll("li[data-tab]")) {
      const active = t === li;
      t.setAttribute("aria-selected", active ? "true" : "false");
    }
    for (const id of ["summary", "security", "fonts", "spec"]) {
      const pane = $(`properties-pane-${id}`);
      if (pane) pane.hidden = id !== key;
    }
  });
}

async function actionShowProperties() {
  const dlg = $("properties-dialog");
  if (!dlg) return;
  setupPropertiesTabs();
  // Reset to summary tab each open
  const tabs = $("properties-tabs");
  for (const t of tabs.querySelectorAll("li[data-tab]")) {
    t.setAttribute("aria-selected", t.dataset.tab === "summary" ? "true" : "false");
  }
  for (const id of ["summary", "security", "fonts", "spec"]) {
    const pane = $(`properties-pane-${id}`);
    if (pane) pane.hidden = id !== "summary";
  }
  // Show with loading state, then populate.
  $("properties-tbody-summary").innerHTML =
    '<tr><td class="k">読み込み中...</td><td class="v">フォント解析中 — 大きな PDF だと数秒かかります</td></tr>';
  $("properties-tbody-security").innerHTML = "";
  $("properties-tbody-fonts").innerHTML = "";
  $("properties-tbody-spec").innerHTML = "";
  dlg.hidden = false;
  try {
    const props = await kpdf3.getPdfProperties();
    populatePropertiesDialog(props);
  } catch (err) {
    console.error("[properties] failed:", err);
    fillKvTable($("properties-tbody-summary"), [
      ["エラー", String(err?.message || err)],
    ]);
  }
}

// Wire close handlers once at module load.
{
  const dlg = $("properties-dialog");
  if (dlg) {
    const closeBtn = $("properties-close");
    const closeX = $("properties-close-x");
    const close = () => { dlg.hidden = true; };
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (closeX) closeX.addEventListener("click", close);
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  }
}

// ---- Menu bar ---------------------------------------------------------
const menuBar = new MenuBar({
  menuBar: $("menu-bar"),
  dropdowns: {
    file: $("menu-file"),
    edit: $("menu-edit"),
    view: $("menu-view"),
    insert: $("menu-insert"),
    tools: $("menu-tools"),
    help: $("menu-help"),
  },
  actions: {
    open: actionOpen,
    "open-in-new-window": actionOpenInNewWindow,
    close: actionClose,
    save: actionSave,
    export: actionExport,
    "restore-editable-master": actionRestoreEditableMaster,
    "export-range": actionExportRange,
    "export-image": actionExportAsImage,
    "export-region-image": () =>
      setPlacementMode(placementMode === "region-image" ? "none" : "region-image"),
    "split-save": actionSplitSave,
    print: actionPrint,
    "mono-print-toggle": () => $("btn-mono-print")?.click(),
    "fax-send": () => $("btn-fax-send")?.click(),
    "overlay-only-print": () => $("btn-print-overlay-only")?.click(),
    properties: actionShowProperties,
    exit: actionExit,
    about: actionAbout,
    "check-update": actionCheckForUpdates,
    undo: actionUndo,
    redo: actionRedo,
    find: () => $("menu-search-btn")?.click(),
    "zoom-in": actionZoomIn,
    "zoom-out": actionZoomOut,
    "zoom-100": actionZoom100,
    "zoom-fit": actionZoomFit,
    "zoom-fit-page": actionZoomFitPage,
    "page-prev": actionPagePrev,
    "page-next": actionPageNext,
    "page-goto": actionPageGoto,
    "rotate-left": actionRotateLeft,
    "rotate-right": actionRotateRight,
    "toggle-bookmarks": actionToggleBookmarks,
    "page-popup": actionOpenPagePopup,
    "detach-tab": () => $("btn-detach-tab")?.click(),
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
    "shape-palette": () =>
      setPlacementMode(placementMode === "shape" ? "none" : "shape"),
    "form-palette": () => $("btn-form-palette")?.click(),
    "page-numbers": () => $("btn-page-numbers")?.click(),
    "stamp-manager": () => openStampManagerDialog(),
    "font-settings": () => openStampFontDialog(),
    "workspace-cleanup": () => openWorkspaceCleanupDialog(),
    "quality-standard": () => setRenderQuality("standard"),
    "quality-high": () => setRenderQuality("high"),
    "quality-max": () => setRenderQuality("max"),
  },
  submenus: {
    recent: $("menu-recent"),
  },
  populators: {
    recent: populateRecentSubmenu,
  },
});

// ---- β.80 Phase E + β.105 + β.116: 各種 font-select に system フォントを動的追加 ----
//   form-text-font (β.80) + text-font (β.105) + page-numbers-font (β.116)。
//   共通ロジックは system-fonts.js、stamp-dialogs.js も同関数を利用する
//   (循環 import 防止のため renderer 配下の独立モジュール化)。
(async () => {
  for (const id of ["form-text-font", "text-font", "page-numbers-font"]) {
    const sel = document.getElementById(id);
    if (sel) await appendSystemFontsToSelect(sel);
  }
  // text-font の永続化保存値がシステムフォント名のとき、起動時には option
  // がまだ追加されておらず sel.value = saved が失敗していた。append 完了
  // 後にもう一度復元を試みる。
  const textFontSelEl = document.getElementById("text-font");
  if (textFontSelEl) {
    const saved = localStorage.getItem("kpdf3.textFontId");
    if (saved && saved !== "default" &&
        [...textFontSelEl.options].some((o) => o.value === saved)) {
      textFontSelEl.value = saved;
    }
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

  // β.107: 矢印キーで選択中の overlay を微移動。1pt 単位、Shift で 10pt。
  // input/contentEditable フォーカス中はブラウザ default に委ねる
  // (カーソル移動を奪わない)。
  if (
    !inText && hasSelection() && !e.ctrlKey && !e.metaKey && !e.altKey &&
    (e.key === "ArrowUp" || e.key === "ArrowDown" ||
     e.key === "ArrowLeft" || e.key === "ArrowRight")
  ) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    nudgeSelectionBy(dx, dy);
    return;
  }

  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (!ctrlOrCmd) return;
  const key = e.key.toLowerCase();

  // β.107: Ctrl+A — アクティブタブ全 overlay を一括選択 (input フォーカス
  // 中は browser default の「文字列全選択」に委ねる)。
  // β.109 hotfix: projectStore.list() は存在しない。正しくは snapshot()。
  if (key === "a" && !e.shiftKey && !inText) {
    e.preventDefault();
    const all = projectStore.snapshot();
    if (all.length) selectAllOverlays(all.map((o) => o.id));
    return;
  }

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
  } else if (key === "f" && !e.shiftKey) {
    // Ctrl+F → FAX 送信 (2026-07-11 頻用機能へ昇格。検索は Ctrl+Shift+F へ移動)
    e.preventDefault();
    if (inText && target instanceof HTMLElement) target.blur();
    setTimeout(() => actionFaxSend({ via: "auto" }), 0);
    return;
  } else if (key === "f" && e.shiftKey) {
    // Ctrl+Shift+F → reveal + focus the search box (collapsed by default)
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
  "mode-marker": "マーカー配置モードに切替 (ドラッグで半透明マーカー)",
  "mode-callout": "吹き出し配置モードに切替 (クリック → ドラッグで矢印付き吹き出し)",
  "shape-palette": "図形を配置します (直線・矢印・四角・楕円)",
  "form-palette": "申請書テンプレ用フォームフィールドを配置します",
  "page-numbers": "全ページのフッターにページ番号を一括追加します",
  "mono-print-toggle": "この 1 回だけ書き込み (テキスト/スタンプ/印影/形/フォーム枠) を黒に変換して印刷します (マーカーは除外、ファイルは変わりません)",
  "fax-send": "既定の FAX プリンタへ直送 (白黒強制) (Ctrl+F)",
  "overlay-only-print": "申請書原本に重ね印刷 (背景なし、フィールドの値だけ印字)",
  properties: "この PDF の情報を表示 (メタデータ・ページサイズ・フォント一覧など)",
  "rotate-left": "現在のページを左に 90° 回転します",
  "rotate-right": "現在のページを右に 90° 回転します",
  "page-popup": "現在のページを別ウインドウで表示します (比較用)",
  "detach-tab": "現在のタブを別ウインドウに分離します",
  find: "PDF 内のテキストを検索します (Ctrl+Shift+F)",
  "quality-standard": "PDF 表示解像度: 標準 (軽量)",
  "quality-high": "PDF 表示解像度: 高 (推奨)",
  "quality-max": "PDF 表示解像度: 最高 (重め)",
  "stamp-manager": "印影テンプレート（toolbar select）— フル UI は M6 後半",
  "font-settings": "スタンプの全角・半角フォント既定を設定",
  about: "K-PDF3 のバージョン情報",
  "check-update": "新しいバージョンの有無を確認します",
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
for (const dropdownId of ["menu-file", "menu-edit", "menu-view", "menu-insert", "menu-tools", "menu-help"]) {
  const dd = document.getElementById(dropdownId);
  if (!dd) continue;
  for (const item of dd.querySelectorAll(".menu-item[data-action], .menu-item[data-submenu]")) {
    const key = item.dataset.action || item.dataset.submenu;
    const text = MENU_HINTS[key];
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
  if (!files || files.length === 0) {
    return;
  }
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
  if (!pdfPath || typeof pdfPath !== "string") return;
  void openPdfSmart(pdfPath);
});

// Restore-after-update: main reopens the PDFs that were open before an
// update installed (via the OS-open path above) and fires this once so we
// can tell the user what happened.
kpdf3.onSessionRestored?.((info) => {
  const n = info?.count ?? 0;
  if (n > 0) wsStatus.textContent = `更新前に開いていた PDF を復元しました（${n} 件）`;
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
if (btnRestoreMaster) btnRestoreMaster.addEventListener("click", actionRestoreEditableMaster);
btnPrint.addEventListener("click", actionPrint);
// 白黒印刷 sticky toggle (Phase 1)。state と sync 関数は initPrintFlow より
// ワンショット白黒印刷: 押した 1 回だけ overlay を黒化して通常の印刷
// フローへ (Ctrl+P と同じ経路、monoOverlays だけ ON)。
if (btnMonoPrint) {
  btnMonoPrint.addEventListener("click", () => actionPrint({ mono: true }));
}
// β.115: 罫線抑制ボタンはツールバーから撤去。viewer.setSuppressLines /
// line-suppress.js は将来のツール経由再公開のため残置。
if (btnPrintOverlayOnly) {
  btnPrintOverlayOnly.addEventListener("click", actionPrintOverlayOnly);
}
// Phase 2: FAX 送信ボタン。左クリック = streamlined (auto)、右クリック =
// context menu (Adobe 経由 / FAX プリンタ変更)。
// 2026-07-15 (§15.6): Mac には Adobe `/p` が無いので「Adobe 経由」項目と
// 直後の区切り線を出さない (print-flow.js の darwin 分岐と対。仮に発火
// しても actionFaxSend 側で auto に集約される)。
if (ctxFaxBtn) {
  kpdf3.getAppInfo?.().then((info) => {
    if (info?.platform !== "darwin") return;
    const adobeItem = ctxFaxBtn.querySelector('[data-ctx="fax-adobe"]');
    if (adobeItem) adobeItem.style.display = "none";
    const sep = ctxFaxBtn.querySelector(".menu-separator");
    if (sep) sep.style.display = "none";
  }).catch(() => { /* ignore — 取得失敗時は従来表示のまま */ });
}
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
const _SHAPE_DIR_GLYPHS = {
  "right": "→", "down-right": "↘", "down": "↓", "down-left": "↙",
  "left": "←", "up-left": "↖", "up": "↑", "up-right": "↗",
};
function _updateShapeDirIndicator(dir, enabled) {
  const indicator = $("shape-dir-indicator");
  const ccw = $("shape-rot-ccw");
  const cw = $("shape-rot-cw");
  if (indicator) {
    indicator.textContent = enabled ? (_SHAPE_DIR_GLYPHS[dir] ?? "→") : "—";
    indicator.style.opacity = enabled ? "1" : "0.4";
  }
  if (ccw) ccw.disabled = !enabled;
  if (cw) cw.disabled = !enabled;
}

function _populateShapePopupFromSelection() {
  if (getSelectionSize() !== 1) return;
  const id = getPrimarySelectedId();
  const ov = id ? projectStore.get(id) : null;
  if (!ov || ov.type !== "shape") return;
  const props = ov.properties ?? {};
  // kind radio
  const kindRadios = document.querySelectorAll('input[name="shape-kind"]');
  for (const r of kindRadios) r.checked = r.value === (props.kind ?? "line");
  // dir (hidden select) / color / stroke / fill
  const dirSel = $("shape-dir");
  const colorSel = $("shape-color");
  const strokeSel = $("shape-stroke-width");
  const fillSel = $("shape-fill-mode");
  const directional =
    props.kind === "line" || props.kind === "arrow" || props.kind === "double-arrow" ||
    props.kind === "block-arrow" || props.kind === "double-block-arrow";
  const dir = directional ? (props.arrowDir ?? "right") : "right";
  if (dirSel) dirSel.value = dir;
  _updateShapeDirIndicator(dir, directional);
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
// kind の radio 群にも同じ handler + indicator の有効/無効も更新
for (const r of document.querySelectorAll('input[name="shape-kind"]')) {
  r.addEventListener("change", () => {
    const kind = r.value;
    const directional =
      kind === "line" || kind === "arrow" || kind === "double-arrow" ||
      kind === "block-arrow" || kind === "double-block-arrow";
    const dirSel = $("shape-dir");
    _updateShapeDirIndicator(dirSel?.value ?? "right", directional);
    _syncShapePopupToSelected();
  });
}
// dir select の値変更で indicator を追従させる (回転ボタン経由でも発火)
$("shape-dir")?.addEventListener("change", () => {
  const dirSel = $("shape-dir");
  const kindEl = document.querySelector('input[name="shape-kind"]:checked');
  const kind = kindEl?.value || "line";
  const directional =
    kind === "line" || kind === "arrow" || kind === "double-arrow" ||
    kind === "block-arrow" || kind === "double-block-arrow";
  _updateShapeDirIndicator(dirSel?.value ?? "right", directional);
});
// β.104: 回転ボタン (↻ ↺) — 45° 単位回転。選択中 shape なら overlay
// を回転 (bbox AABB 再計算で center 固定)、未選択時は popup defaults
// の dir を 1 段ずらすだけ。
$("shape-rot-ccw")?.addEventListener("click", () => rotateSelectedShape(-1));
$("shape-rot-cw")?.addEventListener("click",  () => rotateSelectedShape(+1));

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

/** 配置済みのテキスト枠を後付けで編集できる導線。
 *  編集中 (inline-edit) → その 1 つだけ。それ以外 → 選択中の text overlay
 *  全て (form_field β.107 と同じ multi-select 一括反映)。1 件でも反映した
 *  ら true を返す → 呼び出し側はテキスト配置モードへの自動遷移を抑止する。 */
function applyTextStyleToEditingOrSelected() {
  const editId = viewer._editingId;
  // β.143: 配置済み text overlay に加えて 吹き出し (callout) も後付け書式
  // 変更の対象にする。両者はフォント/サイズ/色/太字/数字 hanko を共有する。
  const targetIds = editId
    ? [editId]
    : getSelectedIds().filter((id) => {
        const ov = projectStore.get(id);
        return ov && (ov.type === "text" || _isCalloutOverlay(ov));
      });
  if (!targetIds.length) return false;
  const fontId = currentTextFontId();
  const fontSize = currentTextFontSize();
  const color = currentTextColor();
  const digitsHanko = currentTextDigitsHanko();
  const bold = currentTextBold();
  for (const id of targetIds) {
    const ov = projectStore.get(id);
    if (!ov) continue;
    if (ov.type === "text") {
      projectStore.update(id, {
        properties: { ...ov.properties, fontId, fontSize, color, digitsHanko, bold },
      });
    } else if (_isCalloutOverlay(ov)) {
      // フォント/サイズ変更で本文の必要サイズが変わるので、枠を本文に
      // 合わせて自動拡大する (はみ出し防止、2026-06-02 ユーザー選択)。
      const next = { ...ov, properties: { ...ov.properties, fontId, fontSize, color, digitsHanko, bold } };
      const { w, h } = fitCalloutBox(next);
      projectStore.update(id, { w, h, properties: next.properties });
    }
  }
  if (editId) {
    viewer.applyEditingTextStyle({ fontId, fontSize, color, digitsHanko, bold });
  }
  return true;
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
/** β.107 → β.108: 矢印キーで選択中の overlay を delta だけ移動する。
 *  1 keystroke = 1 undo step (CompositeCommand で全 selection を 1 まとめ)。
 *
 *  β.108 hotfix: clamp を overlay 個別 (= 各自 max(0, ov.x+dx)) から
 *  selection 全体の minX/minY を見る group-aware clamp に変更。これに
 *  より「Ctrl+A して左矢印連打」したときに左端の overlay が x=0 で止
 *  まり、それ以外が動き続けて相対位置がズレる事故を防ぐ。負方向の
 *  delta は selection の最端に到達した瞬間に全体が同期して止まる。
 *
 *  inline-edit 中はそもそも上位ハンドラで矢印キーを受け取らない
 *  (browser default に委ねる) ので、ここに来る時点で selection は valid。 */
function nudgeSelectionBy(dx, dy) {
  if (!isOpen) return;
  const ids = getSelectedIds();
  if (!ids.length) return;
  // 1 周目: 実在 overlay 収集 + minX/minY 計算 (group-aware clamp 用)
  const ovs = [];
  let minX = Infinity;
  let minY = Infinity;
  for (const id of ids) {
    const ov = projectStore.get(id);
    if (!ov) continue;
    ovs.push(ov);
    if (ov.x < minX) minX = ov.x;
    if (ov.y < minY) minY = ov.y;
  }
  if (!ovs.length) return;
  // 負方向の delta は selection 全体の最端に合わせて抑制 (= 0 を割らない
  // 最大の負移動)。正方向は上限を設けない (page 境界の縛りは別途必要なら
  // のちに追加。現状は法律実務的に「画面外まで押し出されないこと」が要件)。
  if (dx < 0) dx = Math.max(dx, -minX);
  if (dy < 0) dy = Math.max(dy, -minY);
  if (dx === 0 && dy === 0) return;
  const subs = [];
  for (const ov of ovs) {
    subs.push(new UpdateOverlayCommand(projectStore, ov.id, { x: ov.x + dx, y: ov.y + dy }));
  }
  if (subs.length === 1) {
    history.execute(subs[0]);
  } else {
    history.execute(new CompositeCommand(subs, `Nudge ${subs.length} overlays`));
  }
}

/** β.107: ov ごとに UI 値から patch を組み立てる。circle の size 判定
 *  のように overlay の現在状態を見る分岐があるので ov 単位で。 */
function _buildFormFieldPatch(ov, fk) {
  if (fk === "text") {
    const fontFace = document.getElementById("form-text-font")?.value || "mincho";
    const fontSize =
      Math.max(6, parseInt(document.getElementById("form-text-size")?.value ?? "12", 10) || 12);
    const color = document.getElementById("form-text-color")?.value || "#000000";
    const alignH = document.getElementById("form-text-align-h")?.value || "left";
    const alignV = document.getElementById("form-text-align-v")?.value || "middle";
    return { properties: { ...ov.properties, fontFace, fontSize, color, alignH, alignV } };
  }
  if (fk === "check") {
    const checkStyle = document.getElementById("form-check-style")?.value || "✓";
    const sizeRaw = parseInt(document.getElementById("form-check-size")?.value ?? "", 10);
    const patch = { properties: { ...ov.properties, checkStyle } };
    if (!Number.isNaN(sizeRaw) && sizeRaw > 0) {
      patch.w = sizeRaw;
      patch.h = sizeRaw;
    }
    return patch;
  }
  if (fk === "circle") {
    const strokeWidth =
      parseFloat(document.getElementById("form-circle-stroke")?.value ?? "1.2") || 1.2;
    const color = document.getElementById("form-circle-color")?.value || "#000000";
    const sizeRaw = parseInt(document.getElementById("form-circle-size")?.value ?? "", 10);
    const patch = { properties: { ...ov.properties, strokeWidth, color } };
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
    return patch;
  }
  if (fk === "radio") {
    const groupRaw = (document.getElementById("form-radio-group")?.value ?? "").trim();
    const radioGroupId = groupRaw || "default";
    const checkStyle = document.getElementById("form-radio-style")?.value || "●";
    const sizeRaw = parseInt(document.getElementById("form-radio-size")?.value ?? "", 10);
    const patch = { properties: { ...ov.properties, radioGroupId, checkStyle } };
    if (!Number.isNaN(sizeRaw) && sizeRaw > 0) {
      patch.w = sizeRaw;
      patch.h = sizeRaw;
    }
    return patch;
  }
  return null;
}

function applyFormFieldStyleToEditingOrSelected(kind = null) {
  const editId = viewer._editingId;
  // β.107: multi-select 対応。編集中は単一 (editId)、それ以外は selection
  // 全体を target にして同種 form_field (同じ fieldKind) に同じ patch を
  // ライブ適用する。projectStore.update を直接呼ぶのは β.81 以来の方針
  // (history に毎 keystroke を積まないため) を維持。
  const targetIds = editId ? [editId] : getSelectedIds();
  if (!targetIds.length) return;
  const primaryId = editId || getPrimarySelectedId();
  const primary = primaryId ? projectStore.get(primaryId) : null;
  if (!primary || primary.type !== "form_field") return;
  const fk = primary.properties?.fieldKind;
  if (kind && fk !== kind) return;

  for (const id of targetIds) {
    const ov = projectStore.get(id);
    if (!ov || ov.type !== "form_field") continue;
    if (ov.properties?.fieldKind !== fk) continue;
    const patch = _buildFormFieldPatch(ov, fk);
    if (patch) projectStore.update(id, patch);
  }

  // text は inline-edit 要素の見た目もすぐ追従させる (text overlay
  // と同じ仕組みを流用、digitsHanko/bold は form_field では未使用)。
  if (editId && fk === "text") {
    const fontFace = document.getElementById("form-text-font")?.value || "mincho";
    const fontSize =
      Math.max(6, parseInt(document.getElementById("form-text-size")?.value ?? "12", 10) || 12);
    const color = document.getElementById("form-text-color")?.value || "#000000";
    viewer.applyEditingTextStyle?.({
      fontId: fontFace, fontSize, color, digitsHanko: false, bold: false,
    });
  }
}

// β.82 (B-5): 旧称の後方互換。form-text-* listener から呼ばれていた。
const applyFormTextStyleToEditingOrSelected = applyFormFieldStyleToEditingOrSelected;

/** テキスト枠を選択した瞬間、ツールバーの text-* select / checkbox を
 *  その overlay の現在値で populate する (form_field の populate と同じ
 *  考え方)。変更すれば applyTextStyleToEditingOrSelected で当該 overlay
 *  に直接反映される。multi-select は全て text のときだけ primary 値で
 *  populate (異種混在は触らない)。 */
function populateTextToolbar() {
  const selSize = getSelectionSize();
  if (selSize < 1) return;
  const selId = getPrimarySelectedId();
  const ov = selId ? projectStore.get(selId) : null;
  // β.143: text に加え callout も populate 対象 (同じ書式バーを共有)。
  if (!ov || (ov.type !== "text" && !_isCalloutOverlay(ov))) return;
  if (selSize > 1) {
    for (const id of getSelectedIds()) {
      const o = projectStore.get(id);
      if (!o || (o.type !== "text" && !_isCalloutOverlay(o))) return;
    }
  }
  const p = ov.properties || {};
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (!el || val == null) return;
    if (document.activeElement === el) return;
    if (el.tagName === "SELECT") {
      if ([...el.options].some((o) => o.value === String(val))) {
        el.value = String(val);
      }
    } else {
      el.value = String(val);
    }
  };
  setVal("text-font", p.fontId ?? "mincho");
  setVal("text-size", p.fontSize ?? 12);
  setVal("text-color", p.color ?? "#000000");
  const dh = document.getElementById("text-digits-hanko");
  if (dh && document.activeElement !== dh) dh.checked = !!p.digitsHanko;
  const bo = document.getElementById("text-bold");
  if (bo && document.activeElement !== bo) bo.checked = !!p.bold;
}

/** β.82 (B-5 ii): form_field を選択した瞬間に、その overlay の現在値を
 *  options bar の select に流し込む。これで「選択した枠が今どの設定か」
 *  が一目でわかり、select 変更も「最後にユーザが触った値」ベースでは
 *  なく「今の枠の値」基準で動く。programmatic な .value 代入は change
 *  event を発火しないので、入力ループにはならない。 */
function populateFormFieldOptionsBar() {
  if (formFillMode) return;
  // β.107: multi-select 対応。1 個でも複数でも、selection が全て同種
  // form_field のときは primary の値で populate する (= 変更で全選択に
  // 一括反映される)。異種混在のときは populate しない (options bar は
  // refreshModeOptionsBar 側で hidden になる)。
  const selSize = getSelectionSize();
  if (selSize < 1) return;
  const selId = getPrimarySelectedId();
  const ov = selId ? projectStore.get(selId) : null;
  if (!ov || ov.type !== "form_field") return;
  if (selSize > 1) {
    const fkPrimary = ov.properties?.fieldKind;
    for (const id of getSelectedIds()) {
      const o = projectStore.get(id);
      if (!o || o.type !== "form_field" || o.properties?.fieldKind !== fkPrimary) return;
    }
  }
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
    const applied = applyTextStyleToEditingOrSelected();
    if (!applied && isOpen && placementMode !== "text" && !viewer._editingId) {
      setPlacementMode("text");
    }
  });
}
if (textSizeSel) {
  const saved = localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
  if (saved) textSizeSel.value = saved;
  textSizeSel.addEventListener("change", () => {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, String(currentTextFontSize()));
    const applied = applyTextStyleToEditingOrSelected();
    if (!applied && isOpen && placementMode !== "text" && !viewer._editingId) {
      setPlacementMode("text");
    }
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
    const applied = applyTextStyleToEditingOrSelected();
    if (!applied && isOpen && placementMode !== "text" && !viewer._editingId) {
      setPlacementMode("text");
    }
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
    const applied = applyTextStyleToEditingOrSelected();
    if (!applied && isOpen && placementMode !== "text" && !viewer._editingId) {
      setPlacementMode("text");
    }
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
    const applied = applyTextStyleToEditingOrSelected();
    if (!applied && isOpen && placementMode !== "text" && !viewer._editingId) {
      setPlacementMode("text");
    }
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

if (markerStyleSel) {
  const saved = localStorage.getItem(MARKER_STYLE_STORAGE_KEY);
  if (saved && Array.from(markerStyleSel.options).some((o) => o.value === saved)) {
    markerStyleSel.value = saved;
  }
  markerStyleSel.addEventListener("change", () => {
    localStorage.setItem(MARKER_STYLE_STORAGE_KEY, currentMarkerStyle());
    // 種類を選んだ = マーカーを引きたい意思表示。色 select と同じ流儀で
    // マーカーモードに入れておく。
    if (isOpen && placementMode !== "marker") setPlacementMode("marker");
  });
}

if (markerThicknessSel) {
  const saved = localStorage.getItem(MARKER_THICKNESS_STORAGE_KEY);
  if (saved && Array.from(markerThicknessSel.options).some((o) => o.value === saved)) {
    markerThicknessSel.value = saved;
  }
  markerThicknessSel.addEventListener("change", () => {
    localStorage.setItem(MARKER_THICKNESS_STORAGE_KEY, String(currentMarkerThickness()));
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
