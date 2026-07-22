// サイドバーサムネイル — S6 リファクタ (REVIEW-2026-07 #8) その3で
// renderer.js から抽出。ロジックは移動のみで不変。
//
//   rebuildThumbs / renderThumb / clearThumbs — サムネ描画 (IntersectionObserver 遅延)
//   attachThumbDragHandlers / attachInsertGapDrop — 並び替え D&D + 外部ファイル/
//     別ウインドウからの挿入 (β.79 cross-window)
//   makeInsertGap / makeSplitInsertGap / promptAndInsertBlank — ＋gap と白紙挿入
//   sidebarThumbSelection / splitThumbSelection — 複数選択 (split-save パネルと共有)
//   deleteSelectedPages — Del キー / コンテキストメニュー共通の削除経路
//   showThumbContextMenu / dispatchThumbCtx / actionSavePagesAsPdf — 右クリックメニュー
//   actionToggleBookmarks / switchSidebarTab — サイドバー開閉とタブ切替
//
// State (isOpen, projectStore, pendingDeletedPages, ...) は renderer.js が
// 所有し、initSidebarThumbs の getter 注入で参照する (§4.4 パターン 1)。
// currentSidebarTab はタブ切替 snapshot と連携するため get/set を export
// (§4.4 パターン 4)。split-save パネル側 (S6 その4予定) は本モジュールの
// selection / D&D / gap ヘルパーを import して共有する。

import { composePagesForExport, compositePage } from "./exporter.js";
import { renderSyntheticPagePixels } from "./viewer.js";
import { showBusy, updateBusy, hideBusy } from "./busy-modal.js";
import { customConfirm } from "./dialogs.js";
import { showFileBrowser } from "./file-browser.js";
import { newTabAndOpen } from "./tab-manager.js";

const { kpdf3 } = window;
const $ = (id) => document.getElementById(id);
const wsStatus = $("ws-status");
const sidebar = $("sidebar");
const thumbList = $("thumb-list");
const splitFlow = $("split-flow");
const ctxFaxBtn = $("ctx-fax-btn");

let viewer = null;
let _isOpen = () => false;
let _projectStore = () => null;
let _pendingDeletedPages = () => new Set();
let _isSplitMode = () => false;
let _refreshViewer = async () => {};
let _refreshSplitView = async () => {};
let _markWorkspaceMutated = () => {};
let _refreshDirtyIndicator = () => {};
let _refreshMenuState = () => {};
let _updateTabBarOffset = () => {};
let _rotatePageBy = async () => {};

export function initSidebarThumbs({
  viewer: viewerRef,
  isOpen,
  projectStore,
  pendingDeletedPages,
  isSplitMode,
  refreshViewer,
  refreshSplitView,
  markWorkspaceMutated,
  refreshDirtyIndicator,
  refreshMenuState,
  updateTabBarOffset,
  rotatePageBy,
}) {
  viewer = viewerRef;
  _isOpen = isOpen;
  _projectStore = projectStore;
  _pendingDeletedPages = pendingDeletedPages;
  _isSplitMode = isSplitMode;
  _refreshViewer = refreshViewer;
  _refreshSplitView = refreshSplitView;
  _markWorkspaceMutated = markWorkspaceMutated;
  _refreshDirtyIndicator = refreshDirtyIndicator;
  _refreshMenuState = refreshMenuState;
  _updateTabBarOffset = updateTabBarOffset;
  _rotatePageBy = rotatePageBy;
}

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
  if (action === "rotate-right") _rotatePageBy(pageNo, +90);
  else if (action === "rotate-left") _rotatePageBy(pageNo, -90);
  else if (action === "rotate-180") _rotatePageBy(pageNo, 180);
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
  if (!_isOpen() || !Array.isArray(pageNos) || pageNos.length === 0) return;
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
    monoExportToggle: true,
  });
  if (!choice) return;
  const { path: savePath, secureExport, monoExport } = choice;
  showBusy("保存", `${rows.length} ページを書き出し中...`, 0);
  try {
    const composed = await composePagesForExport({
      pages: rows,
      projectStore: _projectStore(),
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
      rasterRedactionPages: true,
      monoOverlays: !!monoExport,
      vectorTextProbe: kpdf3.vectorTextProbe, // v2.0.13 ベクターテキスト層
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
    // 書き出した PDF を新タブで開いて、ユーザーが書き出し結果を直接確認
    // できるようにする (元タブは編集状態を維持)。
    try { await newTabAndOpen(savePath); }
    catch (openErr) { console.error("[save-pages] post-save open failed:", openErr); }
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

/** Attach a contextmenu handler on a thumb element so right-click pops
 *  the rotate menu anchored at the click coords. Used by both the
 *  sidebar thumbs and the split-save thumbs. */
export function attachThumbContextMenu(el, pageNo) {
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showThumbContextMenu(pageNo, e.clientX, e.clientY);
  });
}

/** Drop the cached canvas + DOM for a sidebar thumb so the next
 *  visibility check re-renders. */
export function invalidateSidebarThumb(pageNo) {
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

export function actionToggleBookmarks() {
  if (!_isOpen()) return;
  sidebar.hidden = !sidebar.hidden;
  refreshSidebarToggle();
  _refreshMenuState();
  _updateTabBarOffset();
  // Trigger thumb rendering for items now visible.
  if (!sidebar.hidden && currentSidebarTab === "thumbs") {
    // 閉じている間は highlightCurrentThumb の scrollIntoView がスキップ
    // され、hidden の間にスクロール位置も先頭へ戻る。開き直した時に
    // 現在ページへ追従し直す (switchSidebarTab の thumbs 復帰と同じ)。
    thumbList
      ?.querySelector(".thumb-item.is-current")
      ?.scrollIntoView({ block: "center", behavior: "auto" });
    requestVisibleThumbRenders();
  }
}

export function refreshSidebarToggle() {
  const toggle = $("sidebar-toggle");
  if (!toggle) return;
  const open = _isOpen() && !sidebar.hidden;
  toggle.classList.toggle("is-open", open);
  toggle.disabled = !_isOpen();
}

const sidebarToggleBtn = $("sidebar-toggle");
sidebarToggleBtn.addEventListener("click", actionToggleBookmarks);

// ---- Sidebar tabs (しおり / サムネ) -----------------------------------
const THUMB_ZOOM = 0.3;
let currentSidebarTab = "thumbs";
export const thumbCache = new Map(); // pageNo -> HTMLCanvasElement
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

export function switchSidebarTab(tab) {
  currentSidebarTab = tab;
  for (const t of sidebarTabEls) {
    t.setAttribute("aria-selected", t.dataset.tab === tab ? "true" : "false");
  }
  for (const p of sidebarPanes) {
    p.hidden = p.dataset.pane !== tab;
  }
  if (tab === "thumbs") {
    // しおりタブ等の間は highlightCurrentThumb の scrollIntoView が
    // スキップされる (pane が hidden で layout が無い) うえ、hidden の
    // 間にリストのスクロール位置は先頭へ戻る。戻ってきた時に現在ページの
    // サムネへ追従し直す (block:center = タブ復帰は位置の把握が目的なので
    // 端に張り付く nearest より文脈が見える中央寄せ)。
    thumbList
      ?.querySelector(".thumb-item.is-current")
      ?.scrollIntoView({ block: "center", behavior: "auto" });
    requestVisibleThumbRenders();
  }
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

export function attachThumbDragHandlers(item, pageNo) {
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
    _markWorkspaceMutated();
    await _refreshViewer();
    // The split view has its own DOM tree; refreshViewer doesn't
    // rebuild it. Without this call the split-save area would keep
    // showing the pre-reorder thumbs even after the DB updated.
    if (_isSplitMode()) await _refreshSplitView();
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
export function detectPaperSize(w, h) {
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

export function rebuildThumbs(pages) {
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
    // β.130: PDF に加えて画像 / Word / Excel も挿入対象。拡張子リストは
    // main 側 file-to-pdf.js の classifyInsertFile と揃えること。
    const insertKind =
      /\.pdf$/i.test(path) ? "pdf"
      : /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(path) ? "image"
      : /\.docx?$/i.test(path) ? "word"
      : /\.xlsx?$/i.test(path) ? "excel"
      : null;
    if (!path || !insertKind) {
      wsStatus.textContent = "PDF・画像・Word・Excel のファイルをドロップしてください";
      return;
    }
    showBusy("挿入",
      insertKind === "pdf" ? "外部 PDF を取り込み中..."
      : insertKind === "image" ? "画像を PDF に変換しています..."
      : insertKind === "word" ? "Word を PDF に変換しています..."
      : "Excel を PDF に変換しています...",
      0);
    // β78: subscribe to per-page progress so the busy modal updates
    // through the 20-30s heavy-PDF insertion instead of looking frozen.
    const unsubProgress = kpdf3.onInsertPdfProgress?.((d) => {
      const total = d?.total ?? 0;
      const i = d?.i ?? 0;
      const pct = total > 0 ? Math.round(((i + 1) / total) * 100) : 0;
      updateBusy(`ページを取り込み中... (${i + 1} / ${total})`, pct);
    });
    try {
      const r = await kpdf3.addInsertedPdfPages({
        afterPageNo,
        afterKey,
        externalPath: path,
      });
      unsubProgress?.();
      hideBusy();
      _markWorkspaceMutated();
      await _refreshViewer();
      // β3 testers reported "分割画面でドロップしても追加が見えない" —
      // refreshViewer() above rebuilds the sidebar thumbs but the split
      // view has its own thumb list that needs an explicit refresh.
      if (_isSplitMode()) await _refreshSplitView();
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
      // IPC 越しの Error は "Error invoking remote method ...:" が前置
      // されるので、ユーザー向けには末尾の実メッセージだけ見せる。
      const msg = String(err?.message ?? err)
        .replace(/^Error invoking remote method '[^']*':\s*/, "")
        .replace(/^Error:\s*/, "");
      wsStatus.textContent = `挿入失敗: ${msg}`;
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
    _markWorkspaceMutated();
    await _refreshViewer();
    if (_isSplitMode()) await _refreshSplitView();
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
    _markWorkspaceMutated();
    await _refreshViewer();
    if (_isSplitMode()) await _refreshSplitView();
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

export function makeSplitInsertGap(afterPageNo, orderInSlot = null, afterKey = null) {
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
  // explicit: true = Ctrl/Shift の修飾キーで作られた選択 (印刷/FAX の
  // 範囲絞り込みは 1 ページでも尊重する)。プレーンクリックはページ移動を
  // 兼ねるため false (print-flow 側は 2 ページ以上のときだけ絞る)。
  return { pageNos: new Set(), anchor: null, explicit: false };
}
export const sidebarThumbSelection = makeSelection();
export const splitThumbSelection = makeSelection();

// Back-compat alias used by the delete flow (acts on whichever context the
// user is interacting with — see deleteSelectedPages below).
const thumbSelection = sidebarThumbSelection;

export function getOrderedThumbPageNos(rootEl, selector) {
  if (!rootEl) return [];
  // Include synthetic (negative pageNo) pages too so Shift+click can
  // span across inserted blank pages — the selection set + downstream
  // delete handler already split source vs synthetic correctly.
  return [...rootEl.querySelectorAll(selector)]
    .map((el) => Number(el.dataset.pageNo))
    .filter((n) => Number.isFinite(n) && n !== 0);
}

export function handleThumbSelectionClick(state, orderedPageNos, pageNo, evt) {
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
  state.explicit = !!(evt.shiftKey || evt.ctrlKey || evt.metaKey);
  refreshThumbSelectionVisuals();
}

export function refreshThumbSelectionVisuals() {
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
  sidebarThumbSelection.explicit = false;
  splitThumbSelection.pageNos.clear();
  splitThumbSelection.anchor = null;
  splitThumbSelection.explicit = false;
  refreshThumbSelectionVisuals();
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
    _markWorkspaceMutated();
    await _refreshViewer();
    // If split-save is active, refresh its UI with the new page list.
    if (_isSplitMode()) await _refreshSplitView();
  } catch (err) {
    console.error("[insert] failed", err);
    wsStatus.textContent = `挿入失敗: ${err.message ?? err}`;
  }
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
  // Remember where the deletion happens (0-based visual position of the
  // earliest deleted page) so focus can land on the page that slides into
  // the gap. Captured *before* the delete is applied, while the registry
  // still holds the doomed pages. Without this the viewer reloads to the
  // top and the selection snaps back to page 1 after every delete.
  const deletedPositions = all
    .map((n) => viewer.registry?.posOfPageNo?.(n))
    .filter((p) => Number.isInteger(p) && p >= 0);
  const focusPos = deletedPositions.length ? Math.min(...deletedPositions) : null;
  // Synthetic pages: remove immediately from DB (no pending state).
  for (const n of syntheticDeletes) {
    try {
      await kpdf3.removeInsertedPage(n);
    } catch (err) {
      console.error("[remove-inserted] failed", err);
    }
  }
  if (syntheticDeletes.length > 0) _markWorkspaceMutated();
  // Source pages: queue as pending until Ctrl+S.
  for (const n of sourceDeletes) _pendingDeletedPages().add(n);
  state.pageNos.clear();
  state.anchor = null;
  refreshThumbSelectionVisuals();
  const parts = [];
  if (syntheticDeletes.length > 0) parts.push(`${syntheticDeletes.length} 挿入ページを削除`);
  if (sourceDeletes.length > 0) parts.push(`${sourceDeletes.length} 元ページを削除予定 (Ctrl+S で確定)`);
  wsStatus.textContent = parts.join(" / ");
  _refreshDirtyIndicator();
  await _refreshViewer();
  if (_isSplitMode()) await _refreshSplitView();
  // Re-focus the page now occupying the deleted slot (or the new last page
  // if the tail was deleted) so the selection stays put instead of jumping
  // back to page 1 when the viewer reloads.
  if (focusPos != null) {
    const count = viewer.registry?.count?.() ?? 0;
    if (count > 0) {
      const focusPageNo = viewer.registry.pageNoAtPos(Math.min(focusPos, count - 1));
      if (focusPageNo) {
        state.pageNos.clear();
        state.pageNos.add(focusPageNo);
        state.anchor = focusPageNo;
        // 削除後のフォーカス復元はナビゲーション扱い (明示選択ではない) —
        // ここで explicit を残すと直後の印刷がこの 1 ページに絞られてしまう。
        state.explicit = false;
        refreshThumbSelectionVisuals();
        // Only the sidebar context drives the main viewer; the split panel
        // has no current-page highlight to chase, so leave it scrolled.
        if (state === sidebarThumbSelection) viewer.scrollToPage(focusPageNo);
      }
    }
  }
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

export function clearThumbs() {
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
    const canvas = await compositePage(row, result, _projectStore(), THUMB_ZOOM);
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

export function highlightCurrentThumb(pageNo) {
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

// タブ切替 snapshot (tab-manager の saveActiveStateInto / applyStateFromTab)
// との連携用 — currentSidebarTab は本モジュール私有のため get/set を公開
// (§4.4 パターン 4)。set は元コード同様、変数の付け替えのみで pane の
// 表示切替は行わない (表示は次の switchSidebarTab / refreshViewer が担う)。
export function getCurrentSidebarTab() {
  return currentSidebarTab;
}
export function setCurrentSidebarTab(tab) {
  currentSidebarTab = tab;
}
