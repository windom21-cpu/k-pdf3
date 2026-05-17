// β.80: 記入モード本体 (Phase C)
//
// 申請書テンプレ用の form_field overlay を、Tab で順に巡って値を入力
// していく仕組み。フィールド種別ごとに動作が分かれる:
//
//   - text:   focus → contentEditable に切り替えて入力、Tab/Enter で
//             commit して次のフィールドへ
//   - check:  Space or click でトグル (value: "" ↔ "on")
//   - circle: Space or click でトグル (value: "" ↔ "on")
//   - radio:  Space or click で同 group の他を OFF にして自分を ON
//
// Tab 順は基本自動: ページ順 (display order) → Y 昇順 → X 昇順。
// β.82 (B-6) 以降は properties.tabOrder (整数) を持つフィールドが優先
// される。explicit/auto が混在しているときは「explicit を tabOrder 昇順
// で先頭、auto を従来順で末尾に追加」の合成順を採用する。
//
// 依存は init() で注入。直接 import は project-store の Command と
// fonts.getTextFontStack のみ (循環避け)。

import { UpdateOverlayCommand } from "../domain/commands.js";

let _projectStore = () => null;
let _history = () => null;
let _viewer = null;
let _setFormFillMode = () => {};
let _isFormFillMode = () => false;
/** @type {string | null} */
let _focusedId = null;
/** Ordered cache of {id, pageNo, x, y} built lazily by _computeTabOrder. */
let _tabOrderCache = null;

export function initFormFill({
  projectStore,
  history,
  viewer,
  isFormFillMode,
  setFormFillMode,
}) {
  _projectStore = projectStore;
  _history = history;
  _viewer = viewer;
  _isFormFillMode = isFormFillMode;
  _setFormFillMode = setFormFillMode;
}

/** Invalidate the cache after add/remove/page-reorder/value-change. The
 *  renderer wires this to ProjectStore subscribe + tab switches. */
export function invalidateTabOrderCache() {
  _tabOrderCache = null;
}

/** Build the global Tab order from the current store snapshot.
 *
 *  Sort key (β.82 mixed semantics):
 *    1. explicit tabOrder ascending (properties.tabOrder, integer) — フィー
 *       ルドのうち tabOrder を持つものを「明示順」として先頭に並べる
 *    2. 残りは自動順 (auto):
 *       a. pageNo display position (ascending — page 1 fields first)
 *       b. Y (canonical, ascending — top of page first)
 *       c. X (canonical, ascending — left first)
 *
 *  Y ε bucketing: fields whose Y differs by less than ROW_EPSILON are
 *  treated as the same row (left-to-right). ROW_EPSILON defaults to
 *  6pt (= half a 12pt line height) to absorb minor misalignment when
 *  the user drags rectangles slightly off the same baseline. */
const ROW_EPSILON = 6;
function _computeTabOrder() {
  if (_tabOrderCache) return _tabOrderCache;
  const store = _projectStore();
  if (!store) {
    _tabOrderCache = [];
    return _tabOrderCache;
  }
  // Collect every form_field overlay across all pages.
  const explicit = [];
  const auto = [];
  for (const ov of store.snapshot()) {
    if (ov.type !== "form_field") continue;
    const t = ov.properties?.tabOrder;
    const rec = {
      id: ov.id,
      pageNo: ov.pageNo,
      x: ov.x,
      y: ov.y,
      tabOrder: typeof t === "number" && Number.isFinite(t) ? t : null,
    };
    if (rec.tabOrder != null) explicit.push(rec);
    else auto.push(rec);
  }
  // Map pageNo → display position via the registry so reordered pages
  // sort correctly. Inserted pages (negative pageNo) and source pages
  // share one ordered space. Fallback when the registry isn't ready:
  // raw pageNo (negatives sort first, which is wrong but only matters
  // before the first render — and the cache will be rebuilt then).
  const reg = _viewer?.registry;
  const posOf = (pn) => {
    if (reg && typeof reg.posOfPageNo === "function") {
      const p = reg.posOfPageNo(pn);
      return p >= 0 ? p : Number.MAX_SAFE_INTEGER;
    }
    return pn;
  };
  explicit.sort((a, b) => a.tabOrder - b.tabOrder);
  auto.sort((a, b) => {
    const pa = posOf(a.pageNo);
    const pb = posOf(b.pageNo);
    if (pa !== pb) return pa - pb;
    if (Math.abs(a.y - b.y) >= ROW_EPSILON) return a.y - b.y;
    return a.x - b.x;
  });
  _tabOrderCache = explicit.concat(auto);
  return _tabOrderCache;
}

/** β.82 (B-6): renderer 側 (バッジ表示 / ドラッグ並べ替え) から現在の
 *  Tab 順を読むための公開関数。配列はコピーを返すので呼出側で並べ替え
 *  ても _tabOrderCache を破壊しない。 */
export function getCurrentTabOrder() {
  return _computeTabOrder().slice();
}

export function getFocusedFieldId() {
  return _focusedId;
}

/** Visually highlight the focused field. Removes the previous mark,
 *  applies `.form-focused` to the new one, and scrolls it into view so
 *  Tab walking across pages auto-scrolls. */
function _applyFocusVisual(id) {
  if (!_viewer) return;
  const container = _viewer.container;
  if (!container) return;
  for (const el of container.querySelectorAll(".overlay.form-focused")) {
    el.classList.remove("form-focused");
  }
  if (!id) return;
  const escaped = id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  const el = container.querySelector(`.overlay[data-overlay-id="${escaped}"]`);
  if (!el) return;
  el.classList.add("form-focused");
  // smooth scroll if far away, instant if already visible
  try {
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  } catch {
    el.scrollIntoView();
  }
}

export function setFocusedFieldId(id) {
  // Always exit any in-progress text edit on the previous field so the
  // user's typing in field A doesn't get committed to field B if they
  // Tab away mid-edit (the viewer's onTextEditCommit fires on blur).
  if (_focusedId && _focusedId !== id) {
    _viewer?._exitEdit?.(true);
  }
  _focusedId = id || null;
  _applyFocusVisual(_focusedId);
  // For text fields, enter contentEditable immediately so the user can
  // just start typing after Tab. Check / radio / circle stay in their
  // toggle-on-Space state.
  if (_focusedId) {
    const ov = _projectStore()?.get(_focusedId);
    if (ov?.type === "form_field" && ov.properties?.fieldKind === "text") {
      // Defer one frame so the DOM has the freshly-rendered overlay
      // element (some focus calls follow a re-render).
      requestAnimationFrame(() => {
        if (_focusedId === ov.id) _viewer?.enterTextEdit?.(ov.id);
      });
    }
  }
}

export function focusFirst() {
  const order = _computeTabOrder();
  if (order.length === 0) return false;
  setFocusedFieldId(order[0].id);
  return true;
}

export function focusNext() {
  const order = _computeTabOrder();
  if (order.length === 0) return false;
  if (!_focusedId) {
    setFocusedFieldId(order[0].id);
    return true;
  }
  const idx = order.findIndex((r) => r.id === _focusedId);
  const next = idx < 0 || idx === order.length - 1 ? order[0] : order[idx + 1];
  setFocusedFieldId(next.id);
  return true;
}

export function focusPrev() {
  const order = _computeTabOrder();
  if (order.length === 0) return false;
  if (!_focusedId) {
    setFocusedFieldId(order[order.length - 1].id);
    return true;
  }
  const idx = order.findIndex((r) => r.id === _focusedId);
  const prev = idx <= 0 ? order[order.length - 1] : order[idx - 1];
  setFocusedFieldId(prev.id);
  return true;
}

/** Toggle a check / circle field's boolean value. Returns true if the
 *  field accepted the toggle (= type matched), false otherwise. */
export function toggleBoolField(id) {
  const store = _projectStore();
  const ov = store?.get(id);
  if (!ov || ov.type !== "form_field") return false;
  const kind = ov.properties?.fieldKind;
  if (kind !== "check" && kind !== "circle") return false;
  const filled = ov.properties?.value === "on";
  _history().execute(
    new UpdateOverlayCommand(store, id, {
      properties: { ...ov.properties, value: filled ? "" : "on" },
    }),
  );
  return true;
}

/** Radio: turn ON the target, turn OFF every other field in the same
 *  radioGroupId. */
export function selectRadioField(id) {
  const store = _projectStore();
  const ov = store?.get(id);
  if (!ov || ov.type !== "form_field" || ov.properties?.fieldKind !== "radio") {
    return false;
  }
  const group = ov.properties?.radioGroupId || "default";
  const history = _history();
  // Build the patch list — radios in the same group that are currently
  // ON get turned OFF; the target gets turned ON.
  const peers = store.snapshot().filter(
    (o) =>
      o.type === "form_field" &&
      o.properties?.fieldKind === "radio" &&
      (o.properties?.radioGroupId || "default") === group,
  );
  for (const peer of peers) {
    const want = peer.id === id ? "on" : "";
    if ((peer.properties?.value ?? "") === want) continue;
    history.execute(
      new UpdateOverlayCommand(store, peer.id, {
        properties: { ...peer.properties, value: want },
      }),
    );
  }
  return true;
}

/** Dispatch a click on an overlay element while in fill mode. Returns
 *  true if the click was handled and the caller should stop the event
 *  (so the default selection / drag handlers don't also fire). */
export function handleFillModeClickOnField(id) {
  if (!_isFormFillMode()) return false;
  const ov = _projectStore()?.get(id);
  if (!ov || ov.type !== "form_field") return false;
  const kind = ov.properties?.fieldKind;
  setFocusedFieldId(id);
  if (kind === "check" || kind === "circle") {
    toggleBoolField(id);
    return true;
  }
  if (kind === "radio") {
    selectRadioField(id);
    return true;
  }
  // text: focus + enterTextEdit (handled by setFocusedFieldId)
  return true;
}

/** Keydown dispatcher for fill mode. Returns true if the event was
 *  consumed. Tab / Shift+Tab / Space / Esc are the active keys. */
export function handleFillModeKeydown(e) {
  if (!_isFormFillMode()) return false;
  // Let the in-overlay contentEditable handle Enter / Esc / its own
  // typing — but intercept Tab so we can move between fields even
  // while editing a text field.
  const target = e.target;
  const inEditable =
    target instanceof HTMLElement && target.isContentEditable;

  if (e.key === "Tab") {
    e.preventDefault();
    e.stopPropagation();
    // Commit any in-progress text edit before moving on so the value
    // we just typed lands in the store.
    if (inEditable) _viewer?._exitEdit?.(true);
    if (e.shiftKey) focusPrev();
    else focusNext();
    return true;
  }
  if (e.key === "Escape") {
    if (inEditable) return false; // let viewer handle Esc-cancel
    // Esc out of fill mode entirely (renderer wires up an Esc handler
    // that calls setFormFillMode(false)).
    _setFormFillMode(false);
    return true;
  }
  if (e.key === " " || e.code === "Space") {
    if (inEditable) return false; // typing a space in a text field
    const id = _focusedId;
    if (!id) return false;
    const ov = _projectStore()?.get(id);
    if (!ov || ov.type !== "form_field") return false;
    const kind = ov.properties?.fieldKind;
    if (kind === "check" || kind === "circle") {
      e.preventDefault();
      toggleBoolField(id);
      return true;
    }
    if (kind === "radio") {
      e.preventDefault();
      selectRadioField(id);
      return true;
    }
  }
  if (e.key === "Enter") {
    // β.81: Shift+Enter は改行 (browser default の <br> 挿入に任せる)。
    // 申請書テンプレで「住所欄に都道府県 + 改行 + 市町村」のような
    // 多行記入があるため。Enter 単独は従来通り commit + 次のフィールド。
    if (inEditable) {
      if (e.shiftKey) {
        // 改行は contentEditable の default 動作 (Shift+Enter で <br>)
        // に任せる。preventDefault しない = 何もしない。
        return false;
      }
      e.preventDefault();
      _viewer?._exitEdit?.(true);
      focusNext();
      return true;
    }
  }
  return false;
}
