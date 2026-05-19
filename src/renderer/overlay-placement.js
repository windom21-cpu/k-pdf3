// Overlay placement: text / marker / callout / redaction.
//
// Owns the "user picked a mode + clicked / dragged on a page → add a
// new overlay" flow. The actual mode dispatch (which place* to call
// for the current placementMode) lives in renderer.js's
// handlePagePointerDown so it can also dispatch to the stamp paths
// (placeStamp / placeStampTrial) which live in the stamp-manager.
//
// State (isOpen, projectStore, history, viewer, setPlacementMode) is
// owned by renderer.js and reached via init-time injection. Toolbar
// DOM (redaction colour select, marker colour, text font/size/color/...)
// is read directly via document.getElementById since the picker IDs
// are stable and renderer-owned.

import { AddOverlayCommand } from "../domain/commands.js";
import { TEXT_FONT_DEFAULT_ID, TEXT_FONT_DEFAULT_SIZE } from "./fonts.js";

let _projectStore = () => null;
let _history = () => null;
let _viewer = null;
let _setPlacementMode = () => {};

export function initOverlayPlacement({ projectStore, history, viewer, setPlacementMode }) {
  _projectStore = projectStore;
  _history = history;
  _viewer = viewer;
  _setPlacementMode = setPlacementMode;
}

const redactionColorSel = document.getElementById("redaction-color");
const markerColorSel = document.getElementById("marker-color");
const textFontSel = document.getElementById("text-font");
const textSizeSel = document.getElementById("text-size");
const textColorSel = document.getElementById("text-color");
const textDigitsHankoChk = document.getElementById("text-digits-hanko");
const textBoldChk = document.getElementById("text-bold");

// Last-used redaction color persisted across sessions (§17.13).
export const REDACTION_COLOR_STORAGE_KEY = "kpdf3.redactionColor";
export function currentRedactionColor() {
  const v = redactionColorSel?.value;
  return v === "white" ? "white" : "black";
}

export const MARKER_COLOR_STORAGE_KEY = "kpdf3.markerColor";
export function currentMarkerColor() {
  return markerColorSel?.value || "#ffeb3b";
}

export function currentTextFontId() {
  return textFontSel?.value || TEXT_FONT_DEFAULT_ID;
}
export function currentTextFontSize() {
  const v = parseInt(textSizeSel?.value ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : TEXT_FONT_DEFAULT_SIZE;
}
export function currentTextColor() {
  return textColorSel?.value || "#000000";
}
export function currentTextDigitsHanko() {
  return !!textDigitsHankoChk?.checked;
}
export function currentTextBold() {
  return !!textBoldChk?.checked;
}

/**
 * Drag-to-define rectangle for a redaction (M5-1). On a page pointerdown
 * in 墨消し mode we capture the pointer, paint a live preview rect, and
 * commit it as an overlay on pointerup. Movements smaller than 5 PDF
 * point in either dimension fall back to a default 200×30 rect anchored
 * at the click — handles the「クリックした、もう離した」case without
 * leaving an invisible 0×0 redaction.
 */
export function startRedactionDrag(pageNo, startX, startY, downEvt, div) {
  if (!div || !downEvt || typeof div.setPointerCapture !== "function") {
    placeRedaction(pageNo, startX - 100, startY - 15, 200, 30);
    _setPlacementMode("none");
    return;
  }
  const pointerId = downEvt.pointerId;
  const z = _viewer.zoom;
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
    _setPlacementMode("none");
  }

  function onCancel(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
    _setPlacementMode("none");
  }

  div.addEventListener("pointermove", onMove);
  div.addEventListener("pointerup", onUp);
  div.addEventListener("pointercancel", onCancel);
}

export function placeMarker(pageNo, x, y, w, h) {
  if (w < 5 || h < 5) return; // ignore accidental tiny rects
  const cmd = new AddOverlayCommand(_projectStore(), {
    pageNo,
    type: "line", // CHECK constraint covers 'line'; kind='marker' discriminates
    x, y, w, h,
    // Markers sit between text overlays and redactions.
    zOrder: 50,
    properties: {
      kind: "marker",
      color: currentMarkerColor(),
      // 0.3 (was 0.5): user feedback that 0.5 was too opaque and the
      // underlying text was hard to read through the highlight. 0.3
      // keeps the marker visible while letting the document text
      // remain legible.
      opacity: 0.3,
    },
  });
  _history().execute(cmd);
}

/**
 * Drag-to-define a rectangular marker. Both axes follow the cursor so
 * the user can paint horizontal stripes by dragging mostly sideways or
 * cover blocks by dragging diagonally. Mode is sticky — users tend to
 * highlight several spots in a row.
 */
export function startMarkerDrag(pageNo, startX, startY, downEvt, div) {
  const DEFAULT_W = 120;
  const DEFAULT_H = 14;
  if (!div || !downEvt || typeof div.setPointerCapture !== "function") {
    placeMarker(pageNo, startX - DEFAULT_W / 2, startY - DEFAULT_H / 2, DEFAULT_W, DEFAULT_H);
    return;
  }
  const pointerId = downEvt.pointerId;
  const z = _viewer.zoom;
  const previewColor = currentMarkerColor();
  const preview = document.createElement("div");
  preview.className = "marker-preview";
  preview.style.background = previewColor;
  preview.style.opacity = "0.35";
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
export function placeCallout(pageNo, x, y, w, h, arrowDx, arrowDy) {
  const fontSize = currentTextFontSize();
  const cmd = new AddOverlayCommand(_projectStore(), {
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
      digitsHanko: currentTextDigitsHanko(),
      bold: currentTextBold(),
      rotation: 0,
      arrowDx,
      arrowDy,
    },
  });
  _history().execute(cmd);
  _setPlacementMode("none");
  if (cmd._snapshot) {
    setTimeout(() => _viewer.enterTextEdit(cmd._snapshot.id), 0);
  }
}

export function startCalloutDrag(pageNo, startX, startY, downEvt, div) {
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
  const z = _viewer.zoom;

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
    _setPlacementMode("none");
  }

  div.addEventListener("pointermove", onMove);
  div.addEventListener("pointerup", onUp);
  div.addEventListener("pointercancel", onCancel);
}

export function placeRedaction(pageNo, x, y, w, h) {
  const cmd = new AddOverlayCommand(_projectStore(), {
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
  _history().execute(cmd);
}

export function placeText(pageNo, x, y) {
  const fontSize = currentTextFontSize();
  // 1-line tall box (~ standard line-height 1.2); width holds ~6 chars
  // by default so the placeholder "テキスト" fits without giving an
  // oversized empty area around it.
  const W = Math.max(60, fontSize * 6);
  const H = Math.max(fontSize, Math.round(fontSize * 1.2));
  // I-beam hot spot is the middle of the cursor — map the click point
  // to the text box's vertical center so the new text appears around
  // (rather than below) where the user clicked.
  const cmd = new AddOverlayCommand(_projectStore(), {
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
      color: currentTextColor(),
      fontId: currentTextFontId(),
      digitsHanko: currentTextDigitsHanko(),
      bold: currentTextBold(),
      rotation: 0, // page-rotation tracked here so content stays upright on rotated paper
    },
  });
  _history().execute(cmd);
  // One-shot placement: release mode now so the next click can drag /
  // edit existing overlays without accidentally placing another one.
  _setPlacementMode("none");
  if (cmd._snapshot) {
    setTimeout(() => _viewer.enterTextEdit(cmd._snapshot.id), 0);
  }
}

// Marker mode is sticky — re-arming setPlacementMode("none") is the
// caller's job (handlePagePointerDown / mode button toggle).

// ============================================================
// β.80 — Form fields (申請書テンプレ用)
// ============================================================
//
// Four sub-types (fieldKind): 'text' | 'check' | 'circle' | 'radio'.
// All four share the overlay type 'form_field' and are discriminated
// by properties.fieldKind. Placement is sticky-or-one-shot per kind:
//   - form-text: drag a rectangle (sticky exits to none on commit)
//   - form-check: click a point (固定サイズ, sticky stays on for多重配置)
//   - form-circle: drag a rectangle (the bbox of the ellipse)
//   - form-radio: click a point (固定サイズ, group=options bar input)
//
// In 記入モード (formFillMode) renderer.js bypasses these placement
// dispatches entirely — Tab nav + value entry takes over (Phase C).

function _readFormTextDefaults() {
  const fontSel = document.getElementById("form-text-font");
  const sizeSel = document.getElementById("form-text-size");
  const colorSel = document.getElementById("form-text-color");
  const frameChk = document.getElementById("form-text-frame");
  const alignHSel = document.getElementById("form-text-align-h");
  const alignVSel = document.getElementById("form-text-align-v");
  const fontSize = Math.max(6, parseInt(sizeSel?.value ?? "12", 10) || 12);
  return {
    fontFace: fontSel?.value || "mincho",
    fontSize,
    color: colorSel?.value || "#000000",
    showFrame: frameChk ? !!frameChk.checked : true,
    alignH: alignHSel?.value || "left",
    alignV: alignVSel?.value || "middle",
  };
}
function _readFormCheckDefaults() {
  const styleSel = document.getElementById("form-check-style");
  const sizeSel = document.getElementById("form-check-size");
  const size = Math.max(6, parseInt(sizeSel?.value ?? "14", 10) || 14);
  return {
    checkStyle: styleSel?.value || "✓",
    size,
  };
}
function _readFormCircleDefaults() {
  const strokeSel = document.getElementById("form-circle-stroke");
  const colorSel = document.getElementById("form-circle-color");
  const sizeSel = document.getElementById("form-circle-size");
  const size = Math.max(6, parseInt(sizeSel?.value ?? "24", 10) || 24);
  return {
    strokeWidth: parseFloat(strokeSel?.value ?? "1.2") || 1.2,
    color: colorSel?.value || "#000000",
    size,
  };
}
function _readFormRadioDefaults() {
  const groupInp = document.getElementById("form-radio-group");
  const styleSel = document.getElementById("form-radio-style");
  const sizeSel = document.getElementById("form-radio-size");
  const size = Math.max(6, parseInt(sizeSel?.value ?? "14", 10) || 14);
  return {
    groupId: (groupInp?.value || "").trim() || "default",
    radioStyle: styleSel?.value || "●",
    size,
  };
}

/** β.80: click → fixed-size form_field (check sub-type). */
export function placeFormCheck(pageNo, x, y) {
  const { checkStyle, size } = _readFormCheckDefaults();
  // Square box centered on the click point; size measured in PDF point.
  const cmd = new AddOverlayCommand(_projectStore(), {
    pageNo,
    type: "form_field",
    x: x - size / 2,
    y: y - size / 2,
    w: size,
    h: size,
    zOrder: 0,
    properties: {
      fieldKind: "check",
      value: "",                // empty = unchecked
      checkStyle,
      color: "#000000",
    },
  });
  _history().execute(cmd);
  // Sticky placement — testers can drop multiple check fields in a row
  // without re-clicking the toolbar. Esc exits to none.
}

/** β.80: click → fixed-size form_field (radio sub-type). */
export function placeFormRadio(pageNo, x, y) {
  const { groupId, radioStyle, size } = _readFormRadioDefaults();
  const cmd = new AddOverlayCommand(_projectStore(), {
    pageNo,
    type: "form_field",
    x: x - size / 2,
    y: y - size / 2,
    w: size,
    h: size,
    zOrder: 0,
    properties: {
      fieldKind: "radio",
      value: "",
      radioGroupId: groupId,
      checkStyle: radioStyle,
      color: "#000000",
    },
  });
  _history().execute(cmd);
}

// ---- β.100 オートシェイプ (直線 / 矢印 / ブロック矢印 / 楕円) ----------
//
// Shape palette popup (toolbar 「図形」ボタン → form palette と同じ流儀)
// で kind を選択 → ページ上のドラッグで配置。bbox + arrowDir を保持。
// 方向は 4 方向 (right/left/down/up) に量子化、ドラッグの主軸方向 +
// 符号で決まる。楕円は方向情報を持たない (kind 判定で skip)。

function _readShapeDefaults() {
  const kindEl = document.querySelector('input[name="shape-kind"]:checked');
  const colorEl = document.getElementById("shape-color");
  const widthEl = document.getElementById("shape-stroke-width");
  const fillEl = document.getElementById("shape-fill-mode");
  const kind = kindEl?.value || "arrow";
  const strokeColor = colorEl?.value || "#cc0000";
  const strokeWidth = Number(widthEl?.value) || 2;
  const fillMode = fillEl?.value || "hollow"; // "hollow" | "solid"
  return { kind, strokeColor, strokeWidth, fillMode };
}

function _dragDir4(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "down" : "up";
}

/**
 * Drag-to-place a shape. The drag rect's bbox is the overlay bbox;
 * the drag direction picks arrowDir (4-way). On a too-small drag we
 * drop a default 80×20 (horizontal) shape so a quick click still
 * produces something usable.
 */
export function startShapeDrag(pageNo, startX, startY, downEvt, div) {
  const defs = _readShapeDefaults();
  if (!div || !downEvt || typeof div.setPointerCapture !== "function") {
    _placeShape(pageNo, startX - 40, startY - 10, 80, 20, "right", defs);
    return;
  }
  const pointerId = downEvt.pointerId;
  const z = _viewer.zoom;
  const preview = document.createElement("div");
  preview.className = "shape-placement-preview";
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
    try { div.releasePointerCapture(pointerId); } catch { /* ignore */ }
    div.removeEventListener("pointermove", onMove);
    div.removeEventListener("pointerup", onUp);
    div.removeEventListener("pointercancel", onCancel);
    preview.remove();
  }
  function onUp(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
    const dx = curX - startX;
    const dy = curY - startY;
    const left = Math.min(startX, curX);
    const top = Math.min(startY, curY);
    const width = Math.abs(dx);
    const height = Math.abs(dy);
    if (width < 5 && height < 5) {
      _placeShape(pageNo, startX - 40, startY - 10, 80, 20, "right", defs);
      return;
    }
    // 楕円・block-arrow は最小 bbox を確保 (細い縦線等を弾く)。
    let bw = width, bh = height;
    const minDim = 20;
    if (defs.kind === "ellipse" || defs.kind === "block-arrow") {
      bw = Math.max(width, minDim);
      bh = Math.max(height, minDim);
    } else {
      bw = Math.max(width, 4);
      bh = Math.max(height, 4);
    }
    const dir = _dragDir4(dx, dy);
    _placeShape(pageNo, left, top, bw, bh, dir, defs);
  }
  function onCancel(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
  }
  div.addEventListener("pointermove", onMove);
  div.addEventListener("pointerup", onUp);
  div.addEventListener("pointercancel", onCancel);
}

function _placeShape(pageNo, x, y, w, h, arrowDir, defs) {
  const props = {
    kind: defs.kind,
    strokeColor: defs.strokeColor,
    strokeWidth: defs.strokeWidth,
  };
  if (defs.kind !== "ellipse") props.arrowDir = arrowDir;
  if (defs.kind === "block-arrow") props.thickness = 0.5;
  if (defs.fillMode === "solid") props.fillColor = defs.strokeColor;
  const cmd = new AddOverlayCommand(_projectStore(), {
    pageNo,
    type: "shape",
    x, y, w, h,
    zOrder: 40,
    properties: props,
  });
  _history().execute(cmd);
}

/** Helper: shared drag-rect handler used by form-text and form-circle.
 *  onCommit receives (pageNo, x, y, w, h) for the final bbox; a tiny
 *  drag (<5pt in either dim) falls back to a default 80×20 rect. */
function _formDragRect(pageNo, startX, startY, downEvt, div, klass, onCommit) {
  if (!div || !downEvt || typeof div.setPointerCapture !== "function") {
    onCommit(pageNo, startX - 40, startY - 10, 80, 20);
    return;
  }
  const pointerId = downEvt.pointerId;
  const z = _viewer.zoom;
  const preview = document.createElement("div");
  preview.className = klass;
  preview.style.left = `${startX * z}px`;
  preview.style.top = `${startY * z}px`;
  preview.style.width = "0px";
  preview.style.height = "0px";
  div.appendChild(preview);

  let curX = startX;
  let curY = startY;
  try { div.setPointerCapture(pointerId); } catch { /* ignore */ }

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
    try { div.releasePointerCapture(pointerId); } catch { /* ignore */ }
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
      onCommit(pageNo, startX - 40, startY - 10, 80, 20);
    } else {
      onCommit(pageNo, x, y, w, h);
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

/** β.80: drag → form_field (text sub-type) rectangle. */
export function startFormTextDrag(pageNo, startX, startY, downEvt, div) {
  const { fontFace, fontSize, color, alignH, alignV } = _readFormTextDefaults();
  _formDragRect(
    pageNo, startX, startY, downEvt, div,
    "form-text-preview",
    (pno, x, y, w, h) => {
      const cmd = new AddOverlayCommand(_projectStore(), {
        pageNo: pno,
        type: "form_field",
        x, y, w, h,
        zOrder: 0,
        properties: {
          fieldKind: "text",
          value: "",
          fontFace,
          fontSize,
          color,
          alignH,
          alignV,
        },
      });
      _history().execute(cmd);
    },
  );
}

/** β.81: click → 固定サイズの真円配置。配置後は四隅のハンドルで自由に
 *  楕円へ変形できる (W ≠ H の bbox にすると border-radius: 50% で楕円
 *  描画、印刷経路の drawOverlay も ellipse でストロークする)。β.80 の
 *  ドラッグ配置は「初手でサイズを決める必要がある」のが面倒という
 *  フィードバックを受け、check / radio と同じ click 配置に統一。 */
export function placeFormCircle(pageNo, x, y) {
  const { strokeWidth, color, size } = _readFormCircleDefaults();
  const cmd = new AddOverlayCommand(_projectStore(), {
    pageNo,
    type: "form_field",
    x: x - size / 2,
    y: y - size / 2,
    w: size,
    h: size,
    zOrder: 0,
    properties: {
      fieldKind: "circle",
      value: "on",          // 丸囲みは常に「表示する」が初期値
      strokeWidth,
      color,
    },
  });
  _history().execute(cmd);
}
