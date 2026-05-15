// Overlay selection: multi-overlay set, primary alias, alignment.
//
// β5 §17.13/#13 expansion. `selectedOverlayIds` is the full set;
// `selectedOverlayId` is the "primary" — the most recently clicked
// member. Legacy single-selection call sites use the primary;
// multi-selection-aware sites (Delete, alignment, copy/paste) read
// the set via getSelectedIds().
//
// `lastClickedOverlayId` (separate from primary) is the anchor for
// Shift+click range select. It survives deselection so the user can
// Click → click elsewhere → Shift+click and still get a range.

import {
  CompositeCommand,
  RemoveOverlayCommand,
  UpdateOverlayCommand,
} from "../domain/commands.js";

let _isOpen = () => false;
let _projectStore = () => null;
let _history = () => null;
let _viewer = null;
let _wsStatus = null;

export function initOverlaySelection({ isOpen, projectStore, history, viewer, wsStatus }) {
  _isOpen = isOpen;
  _projectStore = projectStore;
  _history = history;
  _viewer = viewer;
  _wsStatus = wsStatus;
}

/** @type {Set<string>} */
const selectedOverlayIds = new Set();
let selectedOverlayId = null;
/** @type {string | null} anchor for Shift+click range */
let lastClickedOverlayId = null;

// ---- External API (state accessors / mutators) -----------------------

export function isSelected(id) { return selectedOverlayIds.has(id); }
export function hasSelection() { return selectedOverlayIds.size > 0; }
export function getSelectionSize() { return selectedOverlayIds.size; }
export function getSelectedIds() { return [...selectedOverlayIds]; }
export function getPrimarySelectedId() { return selectedOverlayId; }

/** Remove a single id from the selection (used by the store subscriber
 *  when an overlay is deleted out-of-band). Updates the primary alias. */
export function removeFromSelection(id) {
  selectedOverlayIds.delete(id);
  if (lastClickedOverlayId === id) lastClickedOverlayId = null;
  syncPrimaryFromSet();
}

/** Drop the entire selection state — set, anchor, and primary alias.
 *  Used by the store subscriber on reset and similar bulk clears. */
export function clearSelectionState() {
  selectedOverlayIds.clear();
  lastClickedOverlayId = null;
  selectedOverlayId = null;
}

// ---- Internal helpers --------------------------------------------------

function _ovCssEscape(s) {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(s)
    : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/** Synchronise the `selectedOverlayId` primary alias with the current
 *  set. Picks the last-clicked id when it's still in the set, otherwise
 *  any single remaining member, otherwise null. */
export function syncPrimaryFromSet() {
  if (selectedOverlayIds.size === 0) {
    selectedOverlayId = null;
    return;
  }
  if (lastClickedOverlayId && selectedOverlayIds.has(lastClickedOverlayId)) {
    selectedOverlayId = lastClickedOverlayId;
    return;
  }
  // First by iteration order — selection-stack order is not exposed.
  for (const id of selectedOverlayIds) {
    selectedOverlayId = id;
    return;
  }
}

// ---- Main API ----------------------------------------------------------

export function handleOverlayClick(id, mods = {}) {
  if (!_isOpen()) return;
  // Modifier-aware multi-select (β5 §17.13):
  //   Ctrl/Cmd+click → toggle membership
  //   Shift+click    → reading-order range from anchor to here
  //   plain click    → replace (single)
  // β74: シングルクリック = 選択のみ。テキスト等の編集モード入りは
  //   ダブルクリック (handleOverlayDblclick) に分離した。新規プレース
  //   直後の auto-edit (overlay-placement.js setTimeout enterTextEdit)
  //   は変更なし — 置いた直後はそのまま打てるべき。
  let mode = "replace";
  if (mods.ctrl || mods.meta) mode = "toggle";
  else if (mods.shift) mode = "range";
  selectOverlay(id, mode);
}

/** ダブルクリック = テキスト/吹き出し/テキスト stamp の編集モード入り。
 *  redaction / marker / image stamp は enterTextEdit 内で短絡されるので
 *  実害なし (選択は handleOverlayClick 側で済んでいる)。 */
export function handleOverlayDblclick(id, _mods = {}) {
  if (!_isOpen()) return;
  // multi-select 中は編集に入らない (まず単一選択にしてから編集が直感的)。
  if (selectedOverlayIds.size > 1) return;
  // dblclick は直前の 2 回の click ですでに id が選択されているはず
  // だが、念のため単一選択に正規化してから編集に入る。
  selectOverlay(id, "replace");
  _viewer.enterTextEdit(id);
}

/**
 * Update the selection set.
 *
 * @param {string|null} id
 * @param {"replace"|"toggle"|"range"|"add"} [mode]
 *   - "replace" (default): clear, then add id (or clear all if id is null)
 *   - "toggle": flip membership of id (Ctrl/Cmd+click)
 *   - "range": select all overlays between the anchor and id in reading
 *     order (Shift+click). Falls back to "replace" when there's no anchor.
 *   - "add": ensure id is in the set without removing anything
 */
export function selectOverlay(id, mode = "replace") {
  if (id == null) {
    if (mode === "replace") {
      selectedOverlayIds.clear();
      lastClickedOverlayId = null;
    }
    syncPrimaryFromSet();
    reapplySelectionDom();
    return;
  }
  if (mode === "replace") {
    selectedOverlayIds.clear();
    selectedOverlayIds.add(id);
    lastClickedOverlayId = id;
  } else if (mode === "toggle") {
    if (selectedOverlayIds.has(id)) {
      selectedOverlayIds.delete(id);
      if (lastClickedOverlayId === id) lastClickedOverlayId = null;
    } else {
      selectedOverlayIds.add(id);
      lastClickedOverlayId = id;
    }
  } else if (mode === "add") {
    selectedOverlayIds.add(id);
    lastClickedOverlayId = id;
  } else if (mode === "range") {
    const projectStore = _projectStore();
    const anchor = lastClickedOverlayId;
    if (!anchor || anchor === id || !projectStore.get(anchor)) {
      // No usable anchor — fall back to replace.
      selectedOverlayIds.clear();
      selectedOverlayIds.add(id);
      lastClickedOverlayId = id;
    } else {
      const ids = _overlayIdsInReadingOrderBetween(anchor, id);
      // Shift+click conventionally REPLACES rather than adding to the
      // current selection so the user gets the expected "range" result.
      selectedOverlayIds.clear();
      for (const x of ids) selectedOverlayIds.add(x);
      lastClickedOverlayId = id;
    }
  }
  syncPrimaryFromSet();
  reapplySelectionDom();
}

/** Drop the selection entirely. Convenience wrapper. */
export function clearSelection() {
  selectOverlay(null, "replace");
}

/** Compute the set of overlay ids between (inclusive) anchor and target
 *  in document reading order — page order first, then top-to-bottom +
 *  left-to-right within a page. */
function _overlayIdsInReadingOrderBetween(anchorId, targetId) {
  const projectStore = _projectStore();
  const overlays = projectStore.list();
  const ordered = overlays.slice().sort((a, b) => {
    // Page order via PageRegistry positions (sparse / inserted pages
    // make raw pageNo unreliable).
    const aPos = _viewer.registry?.posOfPageNo?.(a.pageNo) ?? a.pageNo;
    const bPos = _viewer.registry?.posOfPageNo?.(b.pageNo) ?? b.pageNo;
    if (aPos !== bPos) return aPos - bPos;
    // Same page → row-major: y first (with row tolerance), then x.
    const ROW_TOL = 6; // PDF points — anything within this is "same row"
    if (Math.abs(a.y - b.y) > ROW_TOL) return a.y - b.y;
    return a.x - b.x;
  });
  const ai = ordered.findIndex((o) => o.id === anchorId);
  const ti = ordered.findIndex((o) => o.id === targetId);
  if (ai < 0 || ti < 0) return [targetId];
  const [lo, hi] = ai < ti ? [ai, ti] : [ti, ai];
  return ordered.slice(lo, hi + 1).map((o) => o.id);
}

// Back-compat shim: old call sites pass a single id (or null) and
// expect "replace" semantics. Forwards to selectOverlay.
export function setSelectedOverlay(id) {
  selectOverlay(id, "replace");
}

/** Re-paint the .is-selected class onto every currently-selected
 *  overlay element. Called after store-update events because the
 *  viewer rebuilds the overlay layer DOM. The × close button is
 *  injected only when exactly one overlay is selected — with multiple
 *  selected, Delete via keyboard is the unambiguous path. */
export function reapplySelectionDom() {
  if (!_viewer.container) return;
  for (const el of _viewer.container.querySelectorAll(".overlay.is-selected")) {
    el.classList.remove("is-selected");
    el.querySelector(":scope > .overlay-close-btn")?.remove();
  }
  if (selectedOverlayIds.size === 0) return;
  for (const id of selectedOverlayIds) {
    const el = _viewer.container.querySelector(
      `.overlay[data-overlay-id="${_ovCssEscape(id)}"]`,
    );
    if (!el) continue;
    el.classList.add("is-selected");
  }
  // Only show the × close button when exactly one is selected, so the
  // button's action is unambiguous. Multi-select uses keyboard Delete.
  if (selectedOverlayIds.size !== 1) {
    syncAlignToolbar();
    return;
  }
  const onlyId = selectedOverlayId;
  if (!onlyId) {
    syncAlignToolbar();
    return;
  }
  const el = _viewer.container.querySelector(
    `.overlay[data-overlay-id="${_ovCssEscape(onlyId)}"]`,
  );
  if (!el) {
    syncAlignToolbar();
    return;
  }
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
      // If this overlay is being inline-edited, abort the edit BEFORE
      // firing the remove. Otherwise viewer._renderPageOverlays keeps
      // the editing DOM around (preservedEditing branch), which makes
      // the × click look like nothing happened until the contentEditable
      // blurs by some unrelated action. (β2 bug: 日付スタンプの × が
      // 効かない / 遅延)
      _viewer.exitTextEdit();
      setSelectedOverlay(null);
      _history().execute(new RemoveOverlayCommand(_projectStore(), id));
    });
    el.appendChild(btn);
  }
  syncAlignToolbar();
}

/** Toolbar align-buttons (左/上/右/下揃え) enable/disable + counter
 *  text. Called from reapplySelectionDom. */
export function syncAlignToolbar() {
  const bar = document.getElementById("align-bar");
  if (!bar) return;
  const n = selectedOverlayIds.size;
  bar.hidden = n < 2;
  const count = document.getElementById("align-count");
  if (count) count.textContent = String(n);
}

/**
 * Align all currently-selected overlays along one edge.
 *
 * Per-page grouping: overlays on different pages are aligned within
 * their own page (each page's selection gets its own min/max), since
 * aligning across pages would yield a meaningless coordinate.
 *
 * Emits one CompositeCommand so the whole alignment is a single undo
 * unit. Overlays already at the target coordinate are skipped (no-op
 * Update would still record an entry; cheaper to filter here).
 *
 * @param {"left"|"top"|"right"|"bottom"} edge
 */
export function alignSelectedOverlays(edge) {
  if (selectedOverlayIds.size < 2) return;
  const projectStore = _projectStore();
  const history = _history();
  /** @type {Map<number, import("../domain/project-store.js").Overlay[]>} */
  const byPage = new Map();
  for (const id of selectedOverlayIds) {
    const ov = projectStore.get(id);
    if (!ov) continue;
    const arr = byPage.get(ov.pageNo) ?? [];
    arr.push(ov);
    byPage.set(ov.pageNo, arr);
  }
  const subs = [];
  for (const overlays of byPage.values()) {
    if (overlays.length < 2) continue; // single-on-page → nothing to align against
    let target;
    let dim;
    if (edge === "left") {
      target = Math.min(...overlays.map((o) => o.x));
      dim = "x";
    } else if (edge === "top") {
      target = Math.min(...overlays.map((o) => o.y));
      dim = "y";
    } else if (edge === "right") {
      const maxRight = Math.max(...overlays.map((o) => o.x + o.w));
      for (const ov of overlays) {
        const newX = maxRight - ov.w;
        if (Math.abs(newX - ov.x) < 1e-6) continue;
        subs.push(new UpdateOverlayCommand(projectStore, ov.id, { x: newX }));
      }
      continue;
    } else if (edge === "bottom") {
      const maxBottom = Math.max(...overlays.map((o) => o.y + o.h));
      for (const ov of overlays) {
        const newY = maxBottom - ov.h;
        if (Math.abs(newY - ov.y) < 1e-6) continue;
        subs.push(new UpdateOverlayCommand(projectStore, ov.id, { y: newY }));
      }
      continue;
    } else {
      return;
    }
    for (const ov of overlays) {
      const cur = ov[dim];
      if (Math.abs(target - cur) < 1e-6) continue;
      subs.push(new UpdateOverlayCommand(projectStore, ov.id, { [dim]: target }));
    }
  }
  if (subs.length === 0) {
    _wsStatus.textContent = "整列: 既に揃っています";
    return;
  }
  history.execute(new CompositeCommand(subs, `Align ${edge} (${subs.length} overlays)`));
  _wsStatus.textContent = `${subs.length} 個の overlay を${
    edge === "left" ? "左" : edge === "top" ? "上" : edge === "right" ? "右" : "下"
  }揃えしました`;
}
