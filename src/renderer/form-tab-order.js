// フォーム Tab 順編集モード (β.82 B-6) — S6 リファクタ (REVIEW-2026-07 #8)
// その6で renderer.js から抽出。ロジックは移動のみで不変。
//
//   setTabOrderEditMode / isTabOrderEditMode — モード ON/OFF (記入モード・
//     placement モードとは排他。ON で番号バッジ + リスト popup を表示)
//   番号バッジ — MutationObserver で viewer の overlay 再構築に追従、
//     バッジ D&D で tabOrder を挿入並べ替え (CompositeCommand = 1 undo)
//   リスト popup — 行 D&D 並べ替え + 行クリックで本文の枠を選択/強調、
//     titlebar drag で移動 + 位置を localStorage 永続化
//   updateTabOrderListActive — 選択変更時の active 行更新
//     (renderer の onSelectionChanged から呼ばれる)
//   refreshTabOrderListPopupIfOpen — projectStore 購読からの popup 再描画
//
// State (formFillMode / placementMode / projectStore / history) は
// renderer.js が所有し、initFormTabOrder の getter/callback 注入で参照する
// (§4.4 パターン 1)。tabOrderEditMode は本モジュールが所有し (パターン 3)、
// 外部は isTabOrderEditMode() で読む。

import { UpdateOverlayCommand, CompositeCommand } from "../domain/commands.js";
import { getCurrentTabOrder } from "./form-fill.js";
import { getPrimarySelectedId, setSelectedOverlay } from "./overlay-selection.js";

const $ = (id) => document.getElementById(id);
const wsStatus = $("ws-status");
const viewerContainer = $("viewer-container");
const btnToggleTabOrder = $("btn-toggle-tab-order");

let _projectStore = () => null;
let _history = () => null;
let _formFillMode = () => false;
let _setFormFillMode = () => {};
let _placementMode = () => "none";
let _setPlacementMode = () => {};

export function initFormTabOrder({
  projectStore,
  history,
  formFillMode,
  setFormFillMode,
  placementMode,
  setPlacementMode,
}) {
  _projectStore = projectStore;
  _history = history;
  _formFillMode = formFillMode;
  _setFormFillMode = setFormFillMode;
  _placementMode = placementMode;
  _setPlacementMode = setPlacementMode;
}

// β.82 (B-6): 「Tab 順を編集」モード。true 時は全 form_field の左上に
// 番号バッジが表示され、バッジを別の form_field にドラッグすると
// その位置に挿入される (他フィールドはずれて再採番)。記入モード /
// 通常 placement モードとは排他で、true 中はそれらを強制 OFF にする。
let tabOrderEditMode = false;

export function isTabOrderEditMode() {
  return tabOrderEditMode;
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

export function setTabOrderEditMode(on) {
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
    if (_formFillMode()) _setFormFillMode(false);
    if (_placementMode() !== "none") _setPlacementMode("none");
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
    const ov = _projectStore().get(rec.id);
    if (!ov) continue;
    updates.push(new UpdateOverlayCommand(_projectStore(), rec.id, {
      properties: { ...ov.properties, tabOrder: nextAuto },
    }));
    nextAuto += 1;
  }
  if (updates.length > 0) {
    _history().execute(new CompositeCommand(updates, "Init Tab order"));
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
    const ov = _projectStore().get(order[i].id);
    if (!ov) continue;
    const newOrder = i + 1;
    const cur = ov.properties?.tabOrder;
    if (cur === newOrder) continue;
    updates.push(new UpdateOverlayCommand(_projectStore(), order[i].id, {
      properties: { ...ov.properties, tabOrder: newOrder },
    }));
  }
  if (updates.length > 0) {
    _history().execute(new CompositeCommand(updates, "Reorder Tab"));
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
    const ov = _projectStore().get(rec.id);
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
export function updateTabOrderListActive() {
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
    const ov = _projectStore().get(id);
    if (!ov) continue;
    const newOrder = i + 1;
    if (ov.properties?.tabOrder === newOrder) continue;
    updates.push(new UpdateOverlayCommand(_projectStore(), id, {
      properties: { ...ov.properties, tabOrder: newOrder },
    }));
  }
  if (updates.length > 0) {
    _history().execute(new CompositeCommand(updates, "Reorder Tab (list)"));
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

/** projectStore 購読 (renderer.js attachStoreSubscribers) から呼ばれる:
 *  β.82 (B-6) Tab 順リスト popup が開いていれば再描画。 */
export function refreshTabOrderListPopupIfOpen() {
  if (tabOrderEditMode && tabOrderListPopup && !tabOrderListPopup.hidden) {
    renderTabOrderListPopup();
  }
}

// β.82 (B-6): Tab 順編集モードの ON/OFF。setTabOrderEditMode 内で
// 排他制御 (記入モード / placement モード OFF) と badge 初期描画を行う。
if (btnToggleTabOrder) {
  btnToggleTabOrder.addEventListener("click", () =>
    setTabOrderEditMode(!tabOrderEditMode),
  );
}
