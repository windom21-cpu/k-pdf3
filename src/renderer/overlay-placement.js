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
