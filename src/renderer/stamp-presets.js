// Stamp preset state, floating palette UI, placement ghost cursor, and
// placeStamp (the click → add-overlay handler dispatched from
// renderer.js's handlePagePointerDown).
//
// Owns:
//  - _activeStampPresetId (persisted in localStorage)
//  - _stampPresetCache (id → preset row, refreshed from main)
//  - stampGhostEl (the cursor-following preview div under document.body)
//  - _stampGhostUrlCache (tinted blob URLs reused across palette + ghost)
//
// External state reached via getter callbacks (init): projectStore,
// history, isOpen, placementMode, setPlacementMode, isStampTrialPlacing.
// viewer / viewerContainer / wsStatus are passed once (stable refs).

import { AddOverlayCommand } from "../domain/commands.js";
import {
  setupHiDPICanvas,
  canvasLogicalSize,
  tintCanvasInPlace,
  renderDateText,
} from "./stamp-helpers.js";

const { kpdf3 } = window;

let _projectStore = () => null;
let _history = () => null;
let _viewer = null;
let _viewerContainer = null;
let _wsStatus = null;
let _isOpen = () => false;
let _placementMode = () => "none";
let _setPlacementMode = () => {};
let _isStampTrialPlacing = () => false; // becomes the real getter once S3-a-4 extracts trial

export function initStampPresets({
  projectStore,
  history,
  viewer,
  viewerContainer,
  wsStatus,
  isOpen,
  placementMode,
  setPlacementMode,
  isStampTrialPlacing,
}) {
  _projectStore = projectStore;
  _history = history;
  _viewer = viewer;
  _viewerContainer = viewerContainer;
  _wsStatus = wsStatus;
  _isOpen = isOpen;
  _placementMode = placementMode;
  _setPlacementMode = setPlacementMode;
  if (isStampTrialPlacing) _isStampTrialPlacing = isStampTrialPlacing;
}

// ---- Active preset --------------------------------------------------

/** Active preset id — drives currentStampPreset(). null when nothing
 *  is registered yet. Persisted across sessions via localStorage. */
const STAMP_ACTIVE_PRESET_KEY = "kpdf3.activeStampPresetId";
let _activeStampPresetId = localStorage.getItem(STAMP_ACTIVE_PRESET_KEY) || null;

export function setActiveStampPreset(id) {
  _activeStampPresetId = id;
  if (id) localStorage.setItem(STAMP_ACTIVE_PRESET_KEY, id);
  else localStorage.removeItem(STAMP_ACTIVE_PRESET_KEY);
  refreshStampPaletteActive();
  updateStampGhostPreset();
}

export function hasActiveStampPreset() {
  return !!_activeStampPresetId;
}

/** Build the stamp properties for the currently-active preset
 *  (ADR-0019). Date kind computes today's date at placement time.
 *  Returns null when no preset is active (placeStamp aborts so the
 *  click is a no-op rather than a fallback 印 that surprises the user).
 */
export function currentStampPreset() {
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
    // date-numeric-spaced* are distribution-rendered variants: N
    // numbers spaced across the box, with separator chars dropped.
    // spacingMode flag is plumbed through to the overlay so the
    // viewer / exporter pick the alternate render path. The -2
    // variant carries only year+month; day is left blank for the
    // user to hand-write on the printed form.
    let spacingMode;
    if (p.text === "date-numeric-spaced") spacingMode = "distribute-3";
    else if (p.text === "date-numeric-spaced-2") spacingMode = "distribute-2";
    return {
      ...base,
      presetKind: "date",
      text: renderDateText(p.text),
      spacingMode,
    };
  }
  if (p.kind === "text") return { ...base, presetKind: "text", text: p.text ?? "" };
  if (p.kind === "image") return { ...base, presetKind: "image", kind: "image", assetId: p.assetId, text: "" };
  return null;
}

export function placeStamp(pageNo, x, y) {
  const preset = currentStampPreset();
  if (!preset) {
    // No preset selected — point the user at the manager.
    _wsStatus.textContent = "スタンプが未登録です。「スタンプ管理…」で登録してください";
    return;
  }
  const W = preset.w;
  const H = preset.h;
  const properties = {
    kind: preset.kind ?? "text-frame",
    // stampKind = preset's underlying kind ("date" | "text" | "image").
    // Persisted so the exporter / print path can tell a date stamp from
    // a text stamp and skip overstroke for dates (印影 ではないので
    // 太字 で印刷したくない、§β31 D1 で混じってしまった分の撤回)。
    stampKind: preset.presetKind,
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
  const cmd = new AddOverlayCommand(_projectStore(), {
    pageNo,
    type: "stamp",
    x: x - W / 2,
    y: y - H / 2,
    w: W,
    h: H,
    zOrder: 0,
    properties,
  });
  _history().execute(cmd);
  // Stamp mode is sticky — the palette popup stays open so the user
  // can keep dropping stamps (same one consecutively, or a different
  // preset by clicking it in the popup). To exit: toolbar スタンプ
  // button toggles, the popup's ✕, or Esc.
  // Auto-enter-edit is also skipped: presets carry the intended text,
  // and entering edit on every placement breaks the rhythm.
}

// ---- Preset cache + palette UI --------------------------------------

/** Cached list of user-registered stamp presets (ADR-0019). Refreshed
 *  whenever the workspace opens or a preset is added / removed. The
 *  toolbar's stamp template select pulls from this for "preset:<id>"
 *  options. */
const _stampPresetCache = new Map();

export function iterStampPresets() {
  return _stampPresetCache.values();
}

export function getStampPresetCount() {
  return _stampPresetCache.size;
}

export async function refreshStampPresetCacheAndSelect() {
  // Pull the canonical list and rebuild the renderer-side cache + the
  // palette UI in the mode-options bar.
  let list = [];
  try {
    if (_isOpen()) list = (await kpdf3.listStampPresets()) ?? [];
  } catch (err) {
    console.error("[stamp-presets] list failed", err);
  }
  _stampPresetCache.clear();
  for (const p of list) _stampPresetCache.set(p.id, p);
  // Drop the active id if the preset is gone (user deleted it). Don't
  // auto-fill it back to list[0] — β15 testers found the first-stamp
  // pre-selection confusing because the cursor ghost / palette
  // highlight implied "this is what will be placed" even before the
  // user explicitly picked something. Now the initial state is
  // genuinely 未選択 until the user clicks a palette tile.
  if (_activeStampPresetId && !_stampPresetCache.has(_activeStampPresetId)) {
    _activeStampPresetId = null;
    try { localStorage.removeItem(STAMP_ACTIVE_PRESET_KEY); }
    catch { /* ignore */ }
  }
  rebuildStampPalette();
}

/** Render a small thumbnail of a preset onto the given canvas. */
function paintPresetThumb(canvas, p) {
  const ctx = canvas.getContext("2d");
  const { W, H } = canvasLogicalSize(canvas);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  if (p.kind === "image" && p.assetId) {
    // Async: load asset, paint when ready (palette refreshes
    // happen rarely, so this is OK).
    getStampGhostAssetUrl(p.assetId).then((url) => {
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
  const palette = document.getElementById("stamp-preset-palette");
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
    // Larger preview + HiDPI buffer so the tiny date / 印 stamps in
    // the floating palette read clearly. devicePixelRatio scales the
    // pixel buffer; CSS keeps the visual size constant.
    setupHiDPICanvas(thumb, 84, 32);
    paintPresetThumb(thumb, p);
    btn.appendChild(thumb);
    const lbl = document.createElement("span");
    lbl.className = "stamp-preset-label";
    lbl.textContent = p.label;
    btn.appendChild(lbl);
    btn.title = `${p.kind === "date" ? "日付" : p.kind === "text" ? "文字" : "画像"}: ${p.label}`;
    btn.addEventListener("click", () => {
      setActiveStampPreset(p.id);
      if (_placementMode() !== "stamp") _setPlacementMode("stamp");
    });
    palette.appendChild(btn);
  }
}

function refreshStampPaletteActive() {
  const palette = document.getElementById("stamp-preset-palette");
  if (!palette) return;
  for (const btn of palette.querySelectorAll(".stamp-preset-btn")) {
    btn.classList.toggle("is-active", btn.dataset.presetId === _activeStampPresetId);
  }
}

/** Show / hide the floating stamp palette popup based on placement
 *  mode. The popup stays visible throughout stamp mode so the user
 *  can keep picking different stamps without leaving the mode. */
export function syncStampPalettePopup() {
  const popup = document.getElementById("stamp-palette-popup");
  if (!popup) return;
  popup.hidden = _placementMode() !== "stamp";
}

// ---- Floating ghost cursor ------------------------------------------

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
    setStampGhostVisible(false);
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
    getStampGhostAssetUrl(preset.assetId, preset.color).then((url) => {
      if (url) img.src = url;
    });
    stampGhostEl.appendChild(img);
    stampGhostEl.style.color = "transparent";
    return;
  }
  // distribute-2 / distribute-3: build space-between token spans so the
  // ghost matches the actual placed stamp (viewer.js / exporter.js use
  // the same layout). Without this the ghost is a single text node like
  // "-8 -5" inside a flex-center container — and because the box width
  // is sized to the measured stamp-font width while the ghost CSS
  // doesn't pin the stamp font, body-font metrics overflow the box and
  // CSS wraps at the space, stacking tokens vertically.
  if (preset.spacingMode === "distribute-2" || preset.spacingMode === "distribute-3") {
    stampGhostEl.style.color = preset.color;
    const tokens = String(preset.text ?? "").split(/\s+/).filter(Boolean);
    const wrap = document.createElement("span");
    wrap.style.display = "flex";
    wrap.style.justifyContent = "space-between";
    wrap.style.alignItems = "center";
    wrap.style.width = "100%";
    wrap.style.whiteSpace = "nowrap";
    for (const t of tokens) {
      const sp = document.createElement("span");
      sp.textContent = t;
      wrap.appendChild(sp);
    }
    stampGhostEl.appendChild(wrap);
    if (preset.frame === "circle") stampGhostEl.classList.add("stamp-ghost-circle");
    else if (preset.frame === "rect") stampGhostEl.classList.add("stamp-ghost-rect");
    else stampGhostEl.classList.add("stamp-ghost-none");
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

// Reuse blob-URL cache for both the palette thumbs and the ghost (so
// we don't double-fetch).
const _stampGhostUrlCache = new Map();
export async function getStampGhostAssetUrl(assetId, color) {
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
  const z = _viewer.zoom;
  stampGhostEl.style.width = `${preset.w * z}px`;
  stampGhostEl.style.height = `${preset.h * z}px`;
  stampGhostEl.style.fontSize = `${preset.fontSize * z}px`;
}

function moveStampGhost(clientX, clientY) {
  const el = ensureStampGhost();
  const preset = currentStampPreset();
  if (!preset) return;
  const z = _viewer.zoom;
  el.style.left = `${clientX - (preset.w * z) / 2}px`;
  el.style.top = `${clientY - (preset.h * z) / 2}px`;
}

/** Show/hide the placement ghost AND sync the container's
 *  `stamp-ghost-active` flag. While the ghost is the active cursor we
 *  hide the OS crosshair (CSS) so it doesn't cover small stamps — the
 *  ghost + its center dot become the placement feedback instead. */
function setStampGhostVisible(visible) {
  if (visible) ensureStampGhost();
  if (stampGhostEl) stampGhostEl.hidden = !visible;
  if (_viewerContainer) _viewerContainer.classList.toggle("stamp-ghost-active", !!visible);
}

function onViewerMouseMoveForStampGhost(e) {
  if (_placementMode() !== "stamp") return;
  // While 試し置き is hunting for a click, the trial cursor follows
  // the mouse with the NEW (to-be-registered) image. The placement
  // ghost would otherwise also follow with the previously-active
  // palette preset, giving the user two stamps under the pointer at
  // once ("違うスタンプのプレビューも付いてきている" — β28 testers).
  // Suppress the placement ghost for the duration of the trial.
  if (_isStampTrialPlacing()) {
    setStampGhostVisible(false);
    return;
  }
  // Size has to track viewer.zoom which the user can change while in
  // stamp mode; cheap enough to set on every move.
  updateStampGhostSize();
  moveStampGhost(e.clientX, e.clientY);
  setStampGhostVisible(true);
}

function onViewerMouseLeaveForStampGhost() {
  setStampGhostVisible(false);
}

export function syncStampGhostMode() {
  if (_placementMode() === "stamp") {
    ensureStampGhost();
    updateStampGhostSize();
    _viewerContainer.addEventListener("mousemove", onViewerMouseMoveForStampGhost);
    _viewerContainer.addEventListener("mouseleave", onViewerMouseLeaveForStampGhost);
  } else {
    setStampGhostVisible(false);
    _viewerContainer.removeEventListener("mousemove", onViewerMouseMoveForStampGhost);
    _viewerContainer.removeEventListener("mouseleave", onViewerMouseLeaveForStampGhost);
  }
}

/** Hide the placement ghost. Public so the trial-placement flow can
 *  suppress it while the user is hunting for a click. */
export function hideStampGhost() {
  setStampGhostVisible(false);
}
