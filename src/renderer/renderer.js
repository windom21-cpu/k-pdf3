// K-PDF3 renderer entry (M2, ADR-0006).
//
// PDF-first UX: a single「開く」button (and File menu equivalent) takes
// the user through the file picker; main resolves the sidecar `.kpdf3`
// automatically.

import { Viewer, renderSyntheticPagePixels } from "./viewer.js";
import { MenuBar } from "./menu-bar.js";
import { ProjectStore } from "../domain/project-store.js";
import { HistoryStack } from "../domain/history.js";
import {
  AddOverlayCommand,
  UpdateOverlayCommand,
  RemoveOverlayCommand,
} from "../domain/commands.js";
import {
  composePagesForExport,
  composeSinglePageCanvas,
  compositePage,
} from "./exporter.js";
import {
  TEXT_FONT_DEFAULT_ID,
  TEXT_FONT_DEFAULT_SIZE,
} from "./fonts.js";

const { kpdf3 } = window;

/**
 * Renderer-side overlay store (M3 architecture: ProjectStore lives in the
 * renderer; main process only handles SQLite I/O on save / load). Reset
 * to the saved snapshot whenever a PDF is opened.
 */
const projectStore = new ProjectStore();
const history = new HistoryStack();

const $ = (id) => document.getElementById(id);
const btnOpen = $("btn-open");
const btnSave = $("btn-save");
const btnExport = $("btn-export");
const btnPrint = $("btn-print");
const zoomSelect = $("zoom-select");
const btnModeText = $("btn-mode-text");
const btnModeStamp = $("btn-mode-stamp");
const btnModeRedaction = $("btn-mode-redaction");
const redactionColorSel = $("redaction-color");
const textFontSel = $("text-font");
const textSizeSel = $("text-size");
const btnModeMarker = $("btn-mode-marker");
const markerColorSel = $("marker-color");
const btnModeCallout = $("btn-mode-callout");
const stampTemplateSel = $("stamp-template");
const stampColorSel = $("stamp-color");
const wsStatus = $("ws-status");
const pageIndicator = $("page-indicator");
const viewerContainer = $("viewer-container");
const sidebar = $("sidebar");
const bookmarkTree = $("bookmark-tree");
const thumbList = $("thumb-list");
const mainArea = $("main-area");
const splitView = $("split-view");
const btnSplit = $("btn-split");
const btnRotateLeft = $("btn-rotate-left");
const btnRotateRight = $("btn-rotate-right");
const busyModal = $("busy-modal");
const busyTitle = $("busy-title");
const busyMessage = $("busy-message");
const busyProgressBar = $("busy-progress-bar");

/**
 * Show / update / hide a 98-styled modal busy indicator with a progress
 * bar. Used for long operations (export / print) where the user might
 * otherwise think the app froze.
 */
function showBusy(title, message, percent = 0) {
  busyTitle.textContent = title;
  busyMessage.textContent = message;
  busyProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  busyModal.hidden = false;
  document.body.classList.add("is-busy");
}
function updateBusy(message, percent) {
  if (typeof message === "string") busyMessage.textContent = message;
  if (typeof percent === "number") {
    busyProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
}
function hideBusy() {
  busyModal.hidden = true;
  document.body.classList.remove("is-busy");
}

const viewer = new Viewer(viewerContainer, {
  projectStore,
  onPagePointerDown: handlePagePointerDown,
  onOverlayClick: handleOverlayClick,
  onTextEditCommit: handleTextEditCommit,
  onOverlayDragEnd: handleOverlayDragEnd,
  onOverlayResizeEnd: handleOverlayResizeEnd,
  onOverlayContextMenu: showOverlayContextMenu,
  onPageChange: updatePageIndicator,
});

function updatePageIndicator(current, total) {
  if (!total || total === 0) {
    pageIndicator.textContent = "";
    return;
  }
  pageIndicator.textContent = `${current} / ${total}`;
}

let isOpen = false;
/** @type {'none' | 'text' | 'stamp' | 'redaction'} */
let placementMode = "none";
let activeSourceName = "";

function handlePagePointerDown(pageNo, x, y, evt, div) {
  if (!isOpen) return;
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
  }
  // Clicks on empty page area no longer deselect — that fired even
  // when the user "exited" inline edit by clicking outside, leaving
  // them with no obvious way to keep an overlay selected for Delete.
  // Escape now clears selection (handled in the global keydown).
}

/**
 * Drag-to-define rectangle for a redaction (M5-1). On a page pointerdown
 * in 墨消し mode we capture the pointer, paint a live preview rect, and
 * commit it as an overlay on pointerup. Movements smaller than 5 PDF
 * point in either dimension fall back to a default 200×30 rect anchored
 * at the click — handles the「クリックした、もう離した」case without
 * leaving an invisible 0×0 redaction.
 */
function startRedactionDrag(pageNo, startX, startY, downEvt, div) {
  if (!div || !downEvt || typeof div.setPointerCapture !== "function") {
    placeRedaction(pageNo, startX - 100, startY - 15, 200, 30);
    setPlacementMode("none");
    return;
  }
  const pointerId = downEvt.pointerId;
  const z = viewer.zoom;
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
    setPlacementMode("none");
  }

  function onCancel(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
    setPlacementMode("none");
  }

  div.addEventListener("pointermove", onMove);
  div.addEventListener("pointerup", onUp);
  div.addEventListener("pointercancel", onCancel);
}

// Last-used redaction color persisted across sessions (§17.13).
const REDACTION_COLOR_STORAGE_KEY = "kpdf3.redactionColor";
function currentRedactionColor() {
  const v = redactionColorSel?.value;
  return v === "white" ? "white" : "black";
}

// ---- Marker (highlighter) — drag-to-define rectangle (§17.6) -----------
const MARKER_COLOR_STORAGE_KEY = "kpdf3.markerColor";
function currentMarkerColor() {
  return markerColorSel?.value || "#ffeb3b";
}

function placeMarker(pageNo, x, y, w, h) {
  if (w < 5 || h < 5) return; // ignore accidental tiny rects
  const cmd = new AddOverlayCommand(projectStore, {
    pageNo,
    type: "line", // CHECK constraint covers 'line'; kind='marker' discriminates
    x, y, w, h,
    // Markers sit between text overlays and redactions.
    zOrder: 50,
    properties: {
      kind: "marker",
      color: currentMarkerColor(),
      opacity: 0.5,
    },
  });
  history.execute(cmd);
}

/**
 * Drag-to-define a rectangular marker. Both axes follow the cursor so
 * the user can paint horizontal stripes by dragging mostly sideways or
 * cover blocks by dragging diagonally. Mode is sticky — users tend to
 * highlight several spots in a row.
 */
function startMarkerDrag(pageNo, startX, startY, downEvt, div) {
  const DEFAULT_W = 120;
  const DEFAULT_H = 14;
  if (!div || !downEvt || typeof div.setPointerCapture !== "function") {
    placeMarker(pageNo, startX - DEFAULT_W / 2, startY - DEFAULT_H / 2, DEFAULT_W, DEFAULT_H);
    return;
  }
  const pointerId = downEvt.pointerId;
  const z = viewer.zoom;
  const previewColor = currentMarkerColor();
  const preview = document.createElement("div");
  preview.className = "marker-preview";
  preview.style.background = previewColor;
  preview.style.opacity = "0.55";
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
function placeCallout(pageNo, x, y, w, h, arrowDx, arrowDy) {
  const fontSize = currentTextFontSize();
  const cmd = new AddOverlayCommand(projectStore, {
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
      rotation: 0,
      arrowDx,
      arrowDy,
    },
  });
  history.execute(cmd);
  setPlacementMode("none");
  if (cmd._snapshot) {
    setTimeout(() => viewer.enterTextEdit(cmd._snapshot.id), 0);
  }
}

function startCalloutDrag(pageNo, startX, startY, downEvt, div) {
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
  const z = viewer.zoom;

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
    setPlacementMode("none");
  }

  div.addEventListener("pointermove", onMove);
  div.addEventListener("pointerup", onUp);
  div.addEventListener("pointercancel", onCancel);
}

function placeRedaction(pageNo, x, y, w, h) {
  const cmd = new AddOverlayCommand(projectStore, {
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
  history.execute(cmd);
}

function currentTextFontId() {
  return textFontSel?.value || TEXT_FONT_DEFAULT_ID;
}
function currentTextFontSize() {
  const v = parseInt(textSizeSel?.value ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : TEXT_FONT_DEFAULT_SIZE;
}

function placeText(pageNo, x, y) {
  const fontSize = currentTextFontSize();
  // 1-line tall box (~ standard line-height 1.2); width holds ~6 chars
  // by default so the placeholder "テキスト" fits without giving an
  // oversized empty area around it.
  const W = Math.max(60, fontSize * 6);
  const H = Math.max(fontSize, Math.round(fontSize * 1.2));
  // I-beam hot spot is the middle of the cursor — map the click point
  // to the text box's vertical center so the new text appears around
  // (rather than below) where the user clicked.
  const cmd = new AddOverlayCommand(projectStore, {
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
      color: "#000000",
      fontId: currentTextFontId(),
      rotation: 0, // page-rotation tracked here so content stays upright on rotated paper
    },
  });
  history.execute(cmd);
  // One-shot placement: release mode now so the next click can drag /
  // edit existing overlays without accidentally placing another one.
  setPlacementMode("none");
  if (cmd._snapshot) {
    setTimeout(() => viewer.enterTextEdit(cmd._snapshot.id), 0);
  }
}

/** Build the stamp properties for the currently-selected template.
 *  Date templates use the legal-practice "leading dash = 令和" form
 *  per HANDOVER §17.5 / §18.3 (e.g. -8.-5.-9 = 令和8年5月9日 stamp).
 *  Image templates have option value "img:<assetId>".
 */
function currentStampPreset() {
  const tmpl = stampTemplateSel?.value || "default";
  const color = stampColorSel?.value || "#cc0000";
  if (tmpl.startsWith("img:")) {
    const assetId = tmpl.slice(4);
    const meta = _imageAssetCache.get(assetId);
    return {
      text: "",
      w: 80,
      h: 80,
      frame: "none",
      fontSize: 14,
      color,
      kind: "image",
      assetId,
      label: meta?.label ?? "",
    };
  }
  if (tmpl === "date-numeric-dash") {
    const d = new Date();
    const reiwa = d.getFullYear() - 2018; // 令和元年 = 2019
    const text = `-${reiwa}.-${d.getMonth() + 1}.-${d.getDate()}`;
    return { text, w: 100, h: 40, frame: "rect", fontSize: 13, color };
  }
  if (tmpl === "date-numeric-fw") {
    // ASCII digits with a FULL-WIDTH 「．」separator (digits stay
    // half-width per the user's spec — only the period is wider).
    const d = new Date();
    const reiwa = d.getFullYear() - 2018;
    const text = `-${reiwa}．-${d.getMonth() + 1}．-${d.getDate()}`;
    return { text, w: 105, h: 40, frame: "rect", fontSize: 13, color };
  }
  if (tmpl === "date-kanji-dash") {
    const d = new Date();
    const reiwa = d.getFullYear() - 2018;
    const text = `令和-${reiwa}年-${d.getMonth() + 1}月-${d.getDate()}日`;
    return { text, w: 140, h: 40, frame: "rect", fontSize: 13, color };
  }
  // default 印 — the original round seal.
  return { text: "印", w: 60, h: 60, frame: "circle", fontSize: 14, color };
}

function placeStamp(pageNo, x, y) {
  const preset = currentStampPreset();
  const W = preset.w;
  const H = preset.h;
  const properties = {
    kind: preset.kind ?? "text-frame",
    text: preset.text,
    color: preset.color,
    frame: preset.frame,
    fontSize: preset.fontSize,
    rotation: 0,
  };
  if (preset.kind === "image" && preset.assetId) {
    properties.assetId = preset.assetId;
    properties.label = preset.label ?? "image-stamp";
  }
  const cmd = new AddOverlayCommand(projectStore, {
    pageNo,
    type: "stamp",
    x: x - W / 2,
    y: y - H / 2,
    w: W,
    h: H,
    zOrder: 0,
    properties,
  });
  history.execute(cmd);
  setPlacementMode("none");
  if (cmd._snapshot) {
    setTimeout(() => viewer.enterTextEdit(cmd._snapshot.id), 0);
  }
}

function handleOverlayClick(id) {
  if (!isOpen) return;
  setSelectedOverlay(id);
  // For text/stamp/callout this enters inline edit; for redaction /
  // marker / image overlays it short-circuits inside enterTextEdit so
  // selection alone is the visible result.
  viewer.enterTextEdit(id);
}

// ---- Overlay selection — single-overlay model + Delete key ----------
let selectedOverlayId = null;

function _ovCssEscape(s) {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(s)
    : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function setSelectedOverlay(id) {
  if (selectedOverlayId === id) return;
  if (selectedOverlayId) {
    const prev = viewer.container?.querySelector(
      `.overlay[data-overlay-id="${_ovCssEscape(selectedOverlayId)}"]`,
    );
    prev?.classList.remove("is-selected");
  }
  selectedOverlayId = id;
  reapplySelectionDom();
}

/** Re-paint the .is-selected class onto the currently-tracked overlay
 *  element, ignoring any class that may have been left over on stale
 *  nodes after a re-render. Called after store-update events because
 *  the viewer rebuilds the overlay layer DOM. */
function reapplySelectionDom() {
  if (!viewer.container) return;
  for (const el of viewer.container.querySelectorAll(".overlay.is-selected")) {
    el.classList.remove("is-selected");
    el.querySelector(":scope > .overlay-close-btn")?.remove();
  }
  if (!selectedOverlayId) return;
  const el = viewer.container.querySelector(
    `.overlay[data-overlay-id="${_ovCssEscape(selectedOverlayId)}"]`,
  );
  if (!el) return;
  el.classList.add("is-selected");
  // Always inject the × button when selected — CSS hides it while
  // .editing is on the parent (so Delete in inline edit acts on text,
  // not on the overlay). When editing ends, the editing class is
  // removed and the × becomes visible again automatically.
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
      setSelectedOverlay(null);
      history.execute(new RemoveOverlayCommand(projectStore, id));
    });
    el.appendChild(btn);
  }
}

function handleTextEditCommit(id, newText) {
  if (!isOpen) return;
  const ov = projectStore.get(id);
  if (!ov) return;
  history.execute(
    new UpdateOverlayCommand(projectStore, id, {
      properties: { ...ov.properties, text: newText },
    }),
  );
}

function handleOverlayDragEnd(id, newX, newY) {
  if (!isOpen) return;
  const ov = projectStore.get(id);
  if (!ov) return;
  // No-op when the gesture didn't actually move anything (rounding edge).
  if (ov.x === newX && ov.y === newY) return;
  history.execute(
    new UpdateOverlayCommand(projectStore, id, { x: newX, y: newY }),
  );
}

function handleOverlayResizeEnd(id, bbox) {
  if (!isOpen) return;
  const ov = projectStore.get(id);
  if (!ov) return;
  if (
    ov.x === bbox.x &&
    ov.y === bbox.y &&
    ov.w === bbox.w &&
    ov.h === bbox.h
  ) {
    return;
  }
  history.execute(new UpdateOverlayCommand(projectStore, id, bbox));
}

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
  }
}

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
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideOverlayContextMenu();
    // Also drop overlay selection — but only if no inline-edit /
    // dialog is active (those have their own Escape handlers).
    const target = e.target;
    const inEdit =
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA");
    if (!inEdit && selectedOverlayId) setSelectedOverlay(null);
  }
});

// ---- Thumb context menu (sidebar + split-save thumbs) -----------------
const ctxThumb = $("ctx-thumb");
function showThumbContextMenu(pageNo, x, y) {
  ctxThumb.dataset.targetPageNo = String(pageNo);
  ctxThumb.style.left = `${x}px`;
  ctxThumb.style.top = `${y}px`;
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
  else if (action === "save-page") actionSaveSinglePage(pageNo);
}

/** Extract a single page (with overlays + rotation) to a new PDF. */
async function actionSaveSinglePage(pageNo) {
  if (!isOpen || !pageNo) return;
  const row = viewer._pages?.find((p) => p.pageNo === pageNo);
  if (!row) return;
  const defaults = await kpdf3.getExportDefaults();
  const baseName = (defaults.defaultName || "page").replace(/\.[^.]+$/, "");
  const tag = pageNo > 0 ? `p${pageNo}` : `inserted${-pageNo}`;
  const initialName = `${baseName}_${tag}.pdf`;
  const savePath = await showFileBrowser({
    mode: "save",
    title: `ページ ${pageNo > 0 ? pageNo : "挿入"} を PDF として保存`,
    initialName,
    defaultDir: defaults.sourceDir,
  });
  if (!savePath) return;
  showBusy("保存", `ページを書き出し中...`, 50);
  try {
    const composed = await composePagesForExport({
      pages: [row],
      projectStore,
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
      onProgress: () => {},
    });
    const result = await kpdf3.exportPdfRasterized({ savePath, pages: composed });
    hideBusy();
    wsStatus.textContent = `${savePath} に保存しました（rev ${(result?.revisionId ?? "").slice(0, 8)}）`;
  } catch (err) {
    hideBusy();
    console.error("[save-page] failed", err);
    wsStatus.textContent = `保存失敗: ${err.message ?? err}`;
  }
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
document.addEventListener("pointerdown", (ev) => {
  if (ev.target instanceof Node && ctxThumb.contains(ev.target)) return;
  hideThumbContextMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideThumbContextMenu();
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
  placementMode = mode;
  viewer.setEditMode(mode);
  btnModeText.classList.toggle("toggled", mode === "text");
  btnModeStamp.classList.toggle("toggled", mode === "stamp");
  btnModeRedaction.classList.toggle("toggled", mode === "redaction");
  btnModeMarker.classList.toggle("toggled", mode === "marker");
  if (btnModeCallout) btnModeCallout.classList.toggle("toggled", mode === "callout");
  syncStampGhostMode();
  refreshMenuState();
  refreshModeOptionsBar();
}

/** Toggle the mode-options bar + the per-mode child visible to match
 *  the current placementMode. text and callout share the same options
 *  row (font + size). When mode is "none", the bar collapses entirely. */
function refreshModeOptionsBar() {
  const bar = $("mode-options-bar");
  if (!bar) return;
  // text + callout share the "text" options panel.
  const which =
    placementMode === "callout" ? "text" :
    placementMode === "none" ? null : placementMode;
  bar.hidden = which === null;
  for (const opt of bar.querySelectorAll(".mode-options")) {
    opt.hidden = opt.dataset.mode !== which;
  }
}

// ---- Image stamp assets (ADR-0017) -------------------------------------
// Cached metadata of registered image assets so the stamp-template
// select can list them without an IPC round-trip on every render.
const _imageAssetCache = new Map(); // id → { id, mime, label }

async function refreshAssetCacheAndTemplateSel() {
  if (!stampTemplateSel) return;
  let assets = [];
  try {
    if (isOpen) assets = (await kpdf3.listAssets()) ?? [];
  } catch (err) {
    console.error("[stamp-image] list assets failed", err);
  }
  _imageAssetCache.clear();
  for (const a of assets) _imageAssetCache.set(a.id, a);
  // Strip any prior image options.
  for (const opt of [...stampTemplateSel.querySelectorAll('option[data-image="1"]')]) {
    opt.remove();
  }
  // Append one option per asset, label fallback = first 8 chars of id.
  for (const a of assets) {
    const opt = document.createElement("option");
    opt.value = `img:${a.id}`;
    opt.dataset.image = "1";
    opt.textContent = `画像: ${a.label || a.id.slice(0, 8)}`;
    stampTemplateSel.appendChild(opt);
  }
}

async function actionAddImageStamp() {
  if (!isOpen) return;
  const path = await showFileBrowser({
    mode: "open",
    title: "印影画像を選択",
    filterDefault: "image",
  });
  if (!path) return;
  try {
    const r = await kpdf3.addAssetFromFile({ path });
    await refreshAssetCacheAndTemplateSel();
    stampTemplateSel.value = `img:${r.id}`;
    if (placementMode !== "stamp") setPlacementMode("stamp");
    updateStampGhostPreset();
    wsStatus.textContent = `画像スタンプを登録: ${path}`;
  } catch (err) {
    console.error("[stamp-image] register failed", err);
    wsStatus.textContent = `画像登録失敗: ${err.message ?? err}`;
  }
}

// ---- Stamp drag ghost (preview that follows the cursor) ---------------
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
  stampGhostEl.classList.remove("stamp-ghost-circle", "stamp-ghost-rect", "stamp-ghost-image");
  if (preset.kind === "image" && preset.assetId) {
    stampGhostEl.classList.add("stamp-ghost-image");
    const img = document.createElement("img");
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.draggable = false;
    img.style.pointerEvents = "none";
    _stampGhostAssetUrl(preset.assetId).then((url) => {
      if (url) img.src = url;
    });
    stampGhostEl.appendChild(img);
    stampGhostEl.style.color = "transparent";
    return;
  }
  stampGhostEl.textContent = preset.text;
  stampGhostEl.style.color = preset.color;
  stampGhostEl.classList.add(
    preset.frame === "circle" ? "stamp-ghost-circle" : "stamp-ghost-rect",
  );
}

// Reuse viewer's blob-URL cache for the ghost (so we don't double-fetch).
const _stampGhostUrlCache = new Map();
async function _stampGhostAssetUrl(assetId) {
  if (_stampGhostUrlCache.has(assetId)) return _stampGhostUrlCache.get(assetId);
  try {
    const data = await kpdf3.getAsset(assetId);
    if (!data?.blob) return null;
    const u8 = data.blob instanceof Uint8Array
      ? data.blob
      : new Uint8Array(data.blob.buffer ?? data.blob);
    const url = URL.createObjectURL(new Blob([u8], { type: data.mime || "image/png" }));
    _stampGhostUrlCache.set(assetId, url);
    return url;
  } catch {
    return null;
  }
}

function updateStampGhostSize() {
  if (!stampGhostEl) return;
  const preset = currentStampPreset();
  const z = viewer.zoom;
  stampGhostEl.style.width = `${preset.w * z}px`;
  stampGhostEl.style.height = `${preset.h * z}px`;
  stampGhostEl.style.fontSize = `${preset.fontSize * z}px`;
}

function moveStampGhost(clientX, clientY) {
  const el = ensureStampGhost();
  const preset = currentStampPreset();
  const z = viewer.zoom;
  el.style.left = `${clientX - (preset.w * z) / 2}px`;
  el.style.top = `${clientY - (preset.h * z) / 2}px`;
}

function onViewerMouseMoveForStampGhost(e) {
  if (placementMode !== "stamp") return;
  // Size has to track viewer.zoom which the user can change while in
  // stamp mode; cheap enough to set on every move.
  updateStampGhostSize();
  moveStampGhost(e.clientX, e.clientY);
  ensureStampGhost().hidden = false;
}
function onViewerMouseLeaveForStampGhost() {
  if (stampGhostEl) stampGhostEl.hidden = true;
}

function syncStampGhostMode() {
  if (placementMode === "stamp") {
    ensureStampGhost();
    updateStampGhostSize();
    viewerContainer.addEventListener("mousemove", onViewerMouseMoveForStampGhost);
    viewerContainer.addEventListener("mouseleave", onViewerMouseLeaveForStampGhost);
  } else {
    if (stampGhostEl) stampGhostEl.hidden = true;
    viewerContainer.removeEventListener("mousemove", onViewerMouseMoveForStampGhost);
    viewerContainer.removeEventListener("mouseleave", onViewerMouseLeaveForStampGhost);
  }
}

function setOpen(open) {
  isOpen = open;
  btnOpen.disabled = open;
  btnExport.disabled = !open;
  btnPrint.disabled = !open;
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
  if (stampTemplateSel) stampTemplateSel.disabled = !open;
  if (stampColorSel) stampColorSel.disabled = !open;
  if (!open) {
    setPlacementMode("none");
    setSplitMode(false);
  }
  refreshMenuState();
  refreshDirtyIndicator();
  refreshSidebarToggle();
  refreshZoomSelect();
  refreshSearchEnabled();
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
winCloseBtn.addEventListener("click", () => kpdf3.windowClose());

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
  btnSave.disabled = !dirty;
}

/**
 * Recompute menu enabled state from the current open / history state.
 * Called whenever isOpen changes or history fires its listener.
 */
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

function refreshMenuState() {
  const z = viewer.zoom;
  menuBar.setEnabled({
    open: !isOpen,
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
    "split-save": isOpen,
    print: isOpen,
    "mode-text": isOpen,
    "mode-stamp": isOpen,
    "mode-redaction": isOpen,
    "mode-marker": isOpen,
    "mode-callout": isOpen,
    // Future tools — kept disabled until M6 (placeholder slots)
    "stamp-manager": isOpen,
    "font-settings": false,
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

history.subscribe(() => refreshMenuState());
projectStore.subscribe((event) => {
  refreshDirtyIndicator();
  refreshMenuState();
  // Invalidate thumb caches for pages whose overlays changed so the
  // sidebar / split-save thumbs reflect the latest content (stamps,
  // marks, text).
  if (!event) return;
  // Drop the selection if its target disappeared.
  if (event.kind === "remove" && event.overlay?.id === selectedOverlayId) {
    selectedOverlayId = null; // already gone from DOM, no class to clear
  } else if (event.kind === "reset") {
    selectedOverlayId = null;
  } else if (event.kind === "update" && event.overlay?.id === selectedOverlayId) {
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
  viewer.load(pages);
  refreshBookmarks();
  rebuildThumbs(pages);
  refreshAssetCacheAndTemplateSel();
  refreshDirtyIndicator();
}

async function confirmDiscardIfDirty() {
  if (!isWorkspaceDirty()) return true;
  return customConfirm({
    title: "未保存の変更",
    message: "未保存の変更があります。\n変更を破棄して続行しますか？",
    okLabel: "破棄して続行",
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

// ---- Custom confirm dialog (98-style, replaces window.confirm) -------
const confirmDialog = $("confirm-dialog");
const confirmTitle = $("confirm-title");
const confirmMessageEl = $("confirm-message");
const confirmOkBtn = $("confirm-ok");
const confirmCancelBtn = $("confirm-cancel");
/** @type {((value: boolean) => void) | null} */
let confirmDialogResolve = null;

/**
 * Win95-style confirm replacement. Returns a Promise<boolean>.
 * Esc / background-click / cancel button → false.
 * Enter / OK button → true.
 */
function customConfirm({
  title = "確認",
  message,
  okLabel = "OK",
  cancelLabel = "キャンセル",
} = {}) {
  confirmTitle.textContent = title;
  confirmMessageEl.textContent = message ?? "";
  confirmOkBtn.textContent = okLabel;
  confirmCancelBtn.textContent = cancelLabel;
  confirmDialog.hidden = false;
  setTimeout(() => confirmOkBtn.focus(), 0);
  return new Promise((resolve) => {
    confirmDialogResolve = resolve;
  });
}
function settleConfirm(value) {
  confirmDialog.hidden = true;
  if (confirmDialogResolve) {
    confirmDialogResolve(value);
    confirmDialogResolve = null;
  }
}
confirmOkBtn.addEventListener("click", () => settleConfirm(true));
confirmCancelBtn.addEventListener("click", () => settleConfirm(false));
confirmDialog.addEventListener("click", (e) => {
  if (e.target === confirmDialog) settleConfirm(false);
});
confirmDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    settleConfirm(false);
  } else if (e.key === "Enter") {
    e.preventDefault();
    settleConfirm(true);
  }
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
        openPdfPath(r.sourcePdfPath);
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
    const result = await kpdf3.openPdfFile(pdfPath);
    projectStore.reset(result.overlays ?? []);
    pendingDeletedPages.clear();
    workspaceMutated = false;
    history.clear();
    setOpen(true);
    await refreshViewer();
  } catch (err) {
    console.error("[renderer] openPdfFile (recent) failed:", err);
    wsStatus.textContent = `エラー: ${err.message ?? err}`;
  }
}

// ---- Generic Win95-style file browser (open / save / folder) ---------
const openDialog = $("open-dialog");
const openTitleText = $("open-title-text");
const openQuickSel = $("open-quick");
const openUpBtn = $("open-up");
const openCurrentPathEl = $("open-current-path");
const openFileList = $("open-file-list");
const openFilenameInput = $("open-filename");
const openFilenameRow = $("open-row-filename");
const openFilterSel = $("open-filter");
const openFilterRow = $("open-row-filter");
const openConfirmBtn = $("open-confirm");
const openCancelBtn = $("open-cancel");
const openTitlebarCloseBtn = $("open-titlebar-close");

const fileBrowserState = {
  mode: "open", // "open" | "save" | "folder"
  currentPath: null,
  parentPath: null,
  entries: [],
  selectedName: null,
  defaultPaths: null,
  resolve: null, // Promise resolver for the current invocation
};

function isPdfName(name) {
  return /\.pdf$/i.test(name);
}
function isImageName(name) {
  return /\.(png|jpe?g)$/i.test(name);
}

function classifyEntry(entry) {
  if (entry.isParent) return "open-entry open-entry-parent is-folder";
  if (entry.isDir) return "open-entry is-folder";
  if (isPdfName(entry.name)) return "open-entry is-pdf";
  if (isImageName(entry.name)) return "open-entry is-image";
  return "open-entry is-other";
}

function shouldShowEntry(entry) {
  if (entry.isParent || entry.isDir) return true;
  if (fileBrowserState.mode === "folder") return false; // hide files in folder mode
  const filter = openFilterSel.value;
  if (filter === "all") return true;
  if (filter === "image") return isImageName(entry.name);
  return isPdfName(entry.name);
}

function renderFileBrowserList() {
  openFileList.innerHTML = "";
  fileBrowserState.selectedName = null;
  if (fileBrowserState.mode !== "save") openFilenameInput.value = "";
  const visible = fileBrowserState.entries.filter(shouldShowEntry);
  if (visible.length === 0) {
    const li = document.createElement("li");
    li.className = "open-entry-empty";
    li.textContent = "(このフォルダには表示できる項目がありません)";
    openFileList.appendChild(li);
    return;
  }
  for (const entry of visible) {
    const li = document.createElement("li");
    li.className = classifyEntry(entry);
    li.dataset.name = entry.name;
    li.dataset.isDir = entry.isDir ? "1" : "0";
    li.dataset.isParent = entry.isParent ? "1" : "0";
    const nameEl = document.createElement("span");
    nameEl.className = "open-entry-name";
    nameEl.textContent = entry.isParent ? ".. (上のフォルダ)" : entry.name;
    li.appendChild(nameEl);
    li.addEventListener("click", () => selectFileEntry(entry, li));
    li.addEventListener("dblclick", () => activateFileEntry(entry));
    openFileList.appendChild(li);
  }
}

function selectFileEntry(entry, liEl) {
  for (const li of openFileList.querySelectorAll(".open-entry.selected")) {
    li.classList.remove("selected");
  }
  if (liEl) liEl.classList.add("selected");
  fileBrowserState.selectedName = entry.isParent ? null : entry.name;
  if (!entry.isDir && !entry.isParent) {
    openFilenameInput.value = entry.name;
  }
}

function activateFileEntry(entry) {
  if (entry.isParent) {
    if (fileBrowserState.parentPath) loadFileBrowserDir(fileBrowserState.parentPath);
    return;
  }
  if (entry.isDir) {
    loadFileBrowserDir(joinPath(fileBrowserState.currentPath, entry.name));
    return;
  }
  if (fileBrowserState.mode === "open") {
    const filter = openFilterSel.value;
    const accept =
      filter === "all" ||
      (filter === "image" && isImageName(entry.name)) ||
      (filter === "pdf" && isPdfName(entry.name));
    if (accept) {
      fileBrowserConfirm(joinPath(fileBrowserState.currentPath, entry.name));
    }
  } else if (fileBrowserState.mode === "save") {
    handleFileBrowserConfirm();
  }
}

function joinPath(dir, name) {
  if (!dir) return name;
  if (dir.endsWith("/") || dir.endsWith("\\")) return dir + name;
  return dir + (dir.includes("\\") && !dir.includes("/") ? "\\" : "/") + name;
}

async function loadFileBrowserDir(targetPath) {
  const result = await kpdf3.listDirectory(targetPath);
  fileBrowserState.currentPath = result.path;
  fileBrowserState.parentPath = result.parent;
  const entries = result.error ? [] : [...result.entries];
  if (result.parent) {
    entries.unshift({ name: "..", isParent: true, isDir: true });
  }
  fileBrowserState.entries = entries;
  openCurrentPathEl.textContent = result.path;
  openCurrentPathEl.title = result.path;
  openUpBtn.disabled = !result.parent;
  if (result.error) {
    openFileList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "open-entry-error";
    li.textContent = `エラー: ${result.error}`;
    openFileList.appendChild(li);
  } else {
    renderFileBrowserList();
  }
  syncQuickSelector();
}

function syncQuickSelector() {
  if (!fileBrowserState.defaultPaths) return;
  const cur = fileBrowserState.currentPath;
  const match = [...openQuickSel.options].find((o) => o.value === cur);
  openQuickSel.value = match ? cur : "";
}

async function populateQuickSelector() {
  if (!fileBrowserState.defaultPaths) {
    fileBrowserState.defaultPaths = await kpdf3.getDefaultPaths();
  }
  const dp = fileBrowserState.defaultPaths;
  const opts = [
    { value: "", label: "(現在のフォルダ)" },
    { value: dp.home, label: `ホーム  ${dp.home ?? ""}` },
    { value: dp.desktop, label: `デスクトップ  ${dp.desktop ?? ""}` },
    { value: dp.documents, label: `ドキュメント  ${dp.documents ?? ""}` },
    { value: dp.downloads, label: `ダウンロード  ${dp.downloads ?? ""}` },
  ];
  openQuickSel.innerHTML = "";
  for (const o of opts) {
    if (o.value === null) continue;
    const opt = document.createElement("option");
    opt.value = o.value ?? "";
    opt.textContent = o.label;
    openQuickSel.appendChild(opt);
  }
}

function fileBrowserCancel() {
  openDialog.hidden = true;
  if (fileBrowserState.resolve) {
    const r = fileBrowserState.resolve;
    fileBrowserState.resolve = null;
    r(null);
  }
}

function fileBrowserConfirm(value) {
  if (fileBrowserState.currentPath) {
    localStorage.setItem("kpdf3.lastBrowseDir", fileBrowserState.currentPath);
  }
  openDialog.hidden = true;
  if (fileBrowserState.resolve) {
    const r = fileBrowserState.resolve;
    fileBrowserState.resolve = null;
    r(value);
  }
}

async function handleFileBrowserConfirm() {
  const mode = fileBrowserState.mode;
  if (mode === "folder") {
    if (fileBrowserState.currentPath) {
      fileBrowserConfirm(fileBrowserState.currentPath);
    }
    return;
  }

  const filename = openFilenameInput.value.trim();
  if (!filename) {
    if (mode === "open" && fileBrowserState.selectedName) {
      fileBrowserConfirm(
        joinPath(fileBrowserState.currentPath, fileBrowserState.selectedName),
      );
    }
    return;
  }
  const isAbsolute = /^([a-zA-Z]:[/\\]|[/\\])/.test(filename);
  let target = isAbsolute ? filename : joinPath(fileBrowserState.currentPath, filename);

  if (mode === "save") {
    // Auto-append .pdf if missing
    if (!/\.[a-zA-Z0-9]+$/.test(target)) target += ".pdf";
    if (await kpdf3.fileExists(target)) {
      const ok = await customConfirm({
        title: "上書きの確認",
        message: `${target}\nは既に存在します。上書きしますか？`,
        okLabel: "上書き",
      });
      if (!ok) return;
    }
    fileBrowserConfirm(target);
    return;
  }

  // open mode — accept whichever extension the active filter allows.
  const filter = openFilterSel.value;
  const ok =
    filter === "all" ||
    (filter === "image" && isImageName(target)) ||
    (filter === "pdf" && isPdfName(target));
  if (!ok) {
    wsStatus.textContent = filter === "image" ? "画像 (PNG/JPEG) を選択してください" : "PDF ファイルを選択してください";
    return;
  }
  fileBrowserConfirm(target);
}

/**
 * Show the file browser. Returns a Promise resolving to:
 *   - open mode  : selected file's full path (or null if cancelled)
 *   - save mode  : full save path (or null)
 *   - folder mode: selected folder path (or null)
 */
async function showFileBrowser({
  mode = "open",
  title,
  initialName = "",
  defaultDir = null,
  filterDefault = "pdf",
  confirmLabel,
} = {}) {
  fileBrowserState.mode = mode;
  await populateQuickSelector();

  // Resolve initial directory
  const stored = localStorage.getItem("kpdf3.lastBrowseDir");
  const initial =
    defaultDir ||
    stored ||
    fileBrowserState.defaultPaths?.home ||
    "";

  // UI configuration based on mode
  if (mode === "folder") {
    openTitleText.textContent = title || "フォルダの選択";
    openFilenameRow.hidden = true;
    openFilterRow.hidden = true;
    openConfirmBtn.textContent = confirmLabel || "このフォルダを選択";
  } else if (mode === "save") {
    openTitleText.textContent = title || "名前を付けて保存";
    openFilenameRow.hidden = false;
    openFilterRow.hidden = false;
    openFilterSel.value = filterDefault;
    openFilenameInput.value = initialName;
    openConfirmBtn.textContent = confirmLabel || "保存";
  } else {
    openTitleText.textContent = title || "PDF を開く";
    openFilenameRow.hidden = false;
    openFilterRow.hidden = false;
    openFilterSel.value = filterDefault;
    openFilenameInput.value = "";
    openConfirmBtn.textContent = confirmLabel || "開く";
  }

  await loadFileBrowserDir(initial);
  openDialog.hidden = false;
  if (mode === "save") {
    // Pre-select base name (stem) so the user can immediately type to replace
    openFilenameInput.focus();
    const stem = initialName.replace(/\.[^.]+$/, "");
    openFilenameInput.setSelectionRange(0, stem.length);
  } else {
    openFilenameInput.focus();
  }

  return new Promise((resolve) => {
    fileBrowserState.resolve = resolve;
  });
}

openConfirmBtn.addEventListener("click", handleFileBrowserConfirm);
openCancelBtn.addEventListener("click", fileBrowserCancel);
openTitlebarCloseBtn.addEventListener("click", fileBrowserCancel);
openDialog.addEventListener("click", (e) => {
  if (e.target === openDialog) fileBrowserCancel();
});
openUpBtn.addEventListener("click", () => {
  if (fileBrowserState.parentPath) loadFileBrowserDir(fileBrowserState.parentPath);
});
openQuickSel.addEventListener("change", () => {
  if (openQuickSel.value) loadFileBrowserDir(openQuickSel.value);
});
openFilterSel.addEventListener("change", renderFileBrowserList);
openFilenameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    handleFileBrowserConfirm();
  } else if (e.key === "Escape") {
    e.preventDefault();
    fileBrowserCancel();
  }
});
openDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    fileBrowserCancel();
  }
});

async function actionOpen() {
  if (!(await confirmDiscardIfDirty())) return;
  const path = await showFileBrowser({ mode: "open" });
  if (!path) return;
  await openPdfPath(path);
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

// ---- Print preview dialog (Adobe simplified) -------------------------
const printDialog = $("print-dialog");
const printPrinterSelect = $("print-printer");
const printPropertiesBtn = $("print-properties");
const printCopiesInput = $("print-copies");
const printRangeAll = $("print-range-all");
const printRangeCurrent = $("print-range-current");
const printRangeCustom = $("print-range-custom");
const printRangeInput = $("print-range-input");
const printSizeActual = $("print-size-actual");
const printSizeFit = $("print-size-fit");
const printOrientPortrait = $("print-orient-portrait");
const printOrientLandscape = $("print-orient-landscape");
const printPreviewCanvas = $("print-preview-canvas");
const printPreviewCounter = $("print-preview-counter");
const printPreviewPrev = $("print-preview-prev");
const printPreviewNext = $("print-preview-next");
const printConfirmBtn = $("print-confirm");
const printCancelBtn = $("print-cancel");
const printTitlebarCloseBtn = $("print-titlebar-close");

const PREVIEW_ZOOM = 0.6; // matches a comfortable preview tile size
const printState = {
  pages: [],          // pages array from kpdf3.getPages()
  printers: [],
  resolve: null,      // Promise resolver
  previewIndex: 0,    // 0-based index into the *visible* page list
  visiblePageNos: [], // page numbers selected by current range
  renderToken: 0,     // monotonic — bail outdated renders
};

function showPrintDialog(printers, pages, currentPageNo) {
  printState.pages = pages;
  printState.printers = printers;

  // Populate printer select
  printPrinterSelect.innerHTML = "";
  if (printers.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(プリンタが見つかりません)";
    printPrinterSelect.appendChild(opt);
    printConfirmBtn.disabled = true;
    printPropertiesBtn.disabled = true;
  } else {
    printConfirmBtn.disabled = false;
    printPropertiesBtn.disabled = false;
    for (const p of printers) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.displayName ?? p.name;
      if (p.isDefault) opt.selected = true;
      printPrinterSelect.appendChild(opt);
    }
  }

  printCopiesInput.value = "1";
  printRangeAll.checked = true;
  printRangeInput.value = `1-${pages.length}`;
  printSizeActual.checked = true;
  printOrientPortrait.checked = true;

  // Initial preview = current page (or 1)
  recomputeVisiblePages();
  const idx = printState.visiblePageNos.indexOf(currentPageNo);
  printState.previewIndex = idx >= 0 ? idx : 0;
  refreshPreview();

  printDialog.hidden = false;
  return new Promise((resolve) => {
    printState.resolve = resolve;
  });
}

function recomputeVisiblePages() {
  const total = printState.pages.length;
  if (printRangeCurrent.checked) {
    const cur = viewer.currentPage || 1;
    printState.visiblePageNos = [cur];
  } else if (printRangeCustom.checked) {
    const parsed = parsePageList(printRangeInput.value, total);
    printState.visiblePageNos = parsed.length > 0 ? parsed : [];
  } else {
    printState.visiblePageNos = printState.pages.map((p) => p.pageNo);
  }
  if (printState.previewIndex >= printState.visiblePageNos.length) {
    printState.previewIndex = Math.max(0, printState.visiblePageNos.length - 1);
  }
}

/**
 * Parse "1-3, 5, 7-10" into a sorted unique array of page numbers.
 */
function parsePageList(input, total) {
  const out = new Set();
  for (const part of String(input).split(",")) {
    const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) continue;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 1 || end > total || start > end) continue;
    for (let i = start; i <= end; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

async function refreshPreview() {
  const visible = printState.visiblePageNos;
  if (visible.length === 0) {
    printPreviewCounter.textContent = "— / —";
    const ctx = printPreviewCanvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, printPreviewCanvas.width, printPreviewCanvas.height);
    printPreviewPrev.disabled = true;
    printPreviewNext.disabled = true;
    return;
  }
  const pageNo = visible[printState.previewIndex];
  printPreviewCounter.textContent = `${printState.previewIndex + 1} / ${visible.length}（p.${pageNo}）`;
  printPreviewPrev.disabled = printState.previewIndex <= 0;
  printPreviewNext.disabled = printState.previewIndex >= visible.length - 1;

  const pageRow = printState.pages.find((p) => p.pageNo === pageNo);
  if (!pageRow) return;

  const myToken = ++printState.renderToken;
  try {
    const sourceCanvas = await composeSinglePageCanvas(
      pageRow,
      kpdf3.renderPage,
      projectStore,
      PREVIEW_ZOOM,
      renderSyntheticPagePixels,
    );
    if (myToken !== printState.renderToken) return; // stale
    // Apply orientation: rotate canvas if landscape selected
    const landscape = printOrientLandscape.checked;
    const dest = printPreviewCanvas;
    if (landscape) {
      dest.width = sourceCanvas.height;
      dest.height = sourceCanvas.width;
      const ctx = dest.getContext("2d");
      ctx.save();
      ctx.translate(dest.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(sourceCanvas, 0, 0);
      ctx.restore();
    } else {
      dest.width = sourceCanvas.width;
      dest.height = sourceCanvas.height;
      const ctx = dest.getContext("2d");
      ctx.drawImage(sourceCanvas, 0, 0);
    }
  } catch (err) {
    console.error("[print-preview] render failed", err);
  }
}

function settlePrintDialog(value) {
  printDialog.hidden = true;
  if (printState.resolve) {
    const r = printState.resolve;
    printState.resolve = null;
    r(value);
  }
}

printConfirmBtn.addEventListener("click", () => {
  const range = currentPrintRange();
  if (!range || range.length === 0) {
    wsStatus.textContent = "印刷範囲が無効です";
    return;
  }
  settlePrintDialog({
    deviceName: printPrinterSelect.value,
    copies: Math.max(1, Number(printCopiesInput.value) || 1),
    pageNos: range,
    sizing: printSizeFit.checked ? "fit" : "actual",
    landscape: printOrientLandscape.checked,
  });
});
printCancelBtn.addEventListener("click", () => settlePrintDialog(null));
printTitlebarCloseBtn.addEventListener("click", () => settlePrintDialog(null));
printDialog.addEventListener("click", (e) => {
  if (e.target === printDialog) settlePrintDialog(null);
});

function currentPrintRange() {
  recomputeVisiblePages();
  return printState.visiblePageNos;
}

// Wire range / size / orientation changes to refresh the preview
for (const el of [printRangeAll, printRangeCurrent, printRangeCustom]) {
  el.addEventListener("change", () => {
    recomputeVisiblePages();
    refreshPreview();
  });
}
printRangeInput.addEventListener("input", () => {
  printRangeCustom.checked = true;
  recomputeVisiblePages();
  refreshPreview();
});
for (const el of [printOrientPortrait, printOrientLandscape, printSizeFit, printSizeActual]) {
  el.addEventListener("change", refreshPreview);
}

printPreviewPrev.addEventListener("click", () => {
  if (printState.previewIndex > 0) {
    printState.previewIndex--;
    refreshPreview();
  }
});
printPreviewNext.addEventListener("click", () => {
  if (printState.previewIndex < printState.visiblePageNos.length - 1) {
    printState.previewIndex++;
    refreshPreview();
  }
});

printPropertiesBtn.addEventListener("click", async () => {
  const name = printPrinterSelect.value;
  if (!name) return;
  const r = await kpdf3.printerProperties(name);
  if (r && r.ok === false) {
    wsStatus.textContent = `プロパティ表示失敗: ${r.error ?? "unknown"}`;
  }
});

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
    // preceding source page, or 0 when this part starts at the very
    // beginning of the document.
    {
      let anchor = 0;
      for (let k = part.start - 1; k >= 0; k--) {
        if (!pages[k].isSynthetic) {
          anchor = pages[k].pageNo;
          break;
        }
      }
      row.appendChild(makeSplitInsertGap(anchor));
    }
    for (let i = part.start; i <= part.end; i++) {
      const thumb = createThumbElement(pages[i]);
      row.appendChild(thumb);
      // Trailing insert gap — anchored to this source page (or its
      // preceding source page when this thumb is synthetic).
      let anchor = pages[i].pageNo;
      if (pages[i].isSynthetic) {
        for (let k = i - 1; k >= 0; k--) {
          if (!pages[k].isSynthetic) {
            anchor = pages[k].pageNo;
            break;
          }
        }
        if (anchor < 0) anchor = 0;
      }
      row.appendChild(makeSplitInsertGap(anchor));
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

function createThumbElement(pageRow) {
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
    placeholder.textContent = String(pageRow.pageNo);
    wrap.appendChild(placeholder);
  }
  const lbl = document.createElement("span");
  lbl.className = "split-thumb-label";
  lbl.textContent = `p.${pageRow.pageNo}`;
  wrap.appendChild(lbl);
  wrap.addEventListener("click", (e) => {
    const ordered = getOrderedThumbPageNos(splitFlow, ".split-thumb[data-page-no]");
    handleThumbSelectionClick(splitThumbSelection, ordered, pageRow.pageNo, e);
    wrap.focus();
  });
  attachThumbContextMenu(wrap, pageRow.pageNo);
  return wrap;
}

let isSplitMode = false;

function setSplitMode(on) {
  isSplitMode = !!on;
  mainArea.classList.toggle("split-mode", isSplitMode);
  splitView.hidden = !isSplitMode;
  btnSplit.classList.toggle("toggled", isSplitMode);
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
  const savePath = await showFileBrowser({
    mode: "save",
    title: "範囲書き出し",
    initialName: defaults.defaultName ?? "export.pdf",
    defaultDir: defaults.sourceDir,
  });
  if (!savePath) return;

  const filteredPages = pages.slice(range.start - 1, range.end);
  showBusy("書き出し準備", `ページ ${range.start}-${range.end} を描画しています...`, 0);
  try {
    const composed = await composePagesForExport({
      pages: filteredPages,
      projectStore,
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
      onProgress: ({ done, total: t }) => {
        updateBusy(`${done} / ${t} ページを描画中...`, (done / t) * 80);
      },
    });
    updateBusy("PDF を組み立て中...", 90);
    const result = await kpdf3.exportPdfRasterized({
      savePath,
      pages: composed,
    });
    hideBusy();
    wsStatus.textContent =
      `書き出し完了 (p.${range.start}-${range.end}, rev ${result.revisionId.slice(0, 8)} → ${savePath})`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] export-range failed:", err);
    wsStatus.textContent = `書き出し失敗: ${err.message ?? err}`;
  }
}

async function actionPrint() {
  if (!isOpen) return;
  const pages = await fetchVisiblePages();
  if (pages.length === 0) return;

  showBusy("プリンタ情報を取得中...", "プリンタ一覧を読み込んでいます...", 50);
  let printers;
  try {
    printers = await kpdf3.listPrinters();
  } finally {
    hideBusy();
  }

  const currentPageNo = viewer.currentPage || 1;
  const choice = await showPrintDialog(printers, pages, currentPageNo);
  if (!choice) {
    wsStatus.textContent = "印刷をキャンセルしました";
    return;
  }

  // Decide pipeline: byte-copy only when no overlays AND printing all pages.
  const overlayCount = projectStore.count();
  const allPagesSelected =
    choice.pageNos.length === pages.length &&
    choice.pageNos.every((n, i) => n === i + 1);
  const isCopy = overlayCount === 0 && allPagesSelected;

  showBusy("印刷準備", "ページを描画中...", 0);
  let composed = null;
  try {
    if (!isCopy) {
      const filteredPages = pages.filter((p) =>
        choice.pageNos.includes(p.pageNo),
      );
      composed = await composePagesForExport({
        pages: filteredPages,
        projectStore,
        renderPage: kpdf3.renderPage,
        onProgress: ({ done, total }) => {
          updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
        },
      });
    }
    updateBusy(`${choice.deviceName} に送信中...`, 90);
    await kpdf3.printPdfSilent({
      source: isCopy ? "byte-copy" : "rasterized",
      pages: composed,
      deviceName: choice.deviceName,
      copies: choice.copies,
      landscape: choice.landscape,
    });
    hideBusy();
    wsStatus.textContent = `印刷を ${choice.deviceName} に送信しました（${choice.copies} 部 / ${choice.pageNos.length} ページ）`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] print failed:", err);
    wsStatus.textContent = `印刷失敗: ${err.message ?? err}`;
  }
}

async function actionExport() {
  if (!isOpen) return;
  const pages = await fetchVisiblePages();
  if (pages.length === 0) return;
  const defaults = await kpdf3.getExportDefaults();
  const savePath = await showFileBrowser({
    mode: "save",
    title: "PDF として書き出し",
    initialName: defaults.defaultName ?? "export.pdf",
    defaultDir: defaults.sourceDir,
  });
  if (!savePath) return;
  // ADR-0008: with no overlays, byte-copy the source PDF instead of
  // rasterising — preserves the original PDF's text layer and size.
  // BUT byte-copy outputs the source PDF as-is, so if any pages are
  // hidden (pending or persisted deletions) OR user-inserted blank
  // pages are present, we must rasterize instead.
  const overlayCount = projectStore.count();
  const meta = await kpdf3.getSourceMeta();
  const hasInsertions = pages.some((p) => p.isSynthetic || p.pageNo < 0);
  const sourcePagesCount = pages.filter((p) => !p.isSynthetic && p.pageNo > 0).length;
  const hasDeletions =
    pendingDeletedPages.size > 0 ||
    (meta && sourcePagesCount < (meta.pageCount ?? sourcePagesCount));
  const isCopy = overlayCount === 0 && !hasDeletions && !hasInsertions;
  const verb = isCopy ? "コピー" : "書き出し";
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
        onProgress: ({ done, total }) => {
          updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
        },
      });
      updateBusy("PDF を組み立て中...", 90);
      result = await kpdf3.exportPdfRasterized({
        savePath,
        pages: composed,
      });
    }
    // ---- Save As convention: switch active workspace to the new file --
    // After saving as 008.pdf the user expects to be editing 008 (not 001
    // with risk of accidentally Ctrl+S overwriting 001). Mirrors Word /
    // Excel "Save As" semantics. byte-copy with no edits → fingerprint
    // matches source → main process opens the existing workspace, which
    // is fine (same content). For rasterized output a fresh workspace is
    // created.
    updateBusy("新しいファイルに切り替え中...", 95);
    try {
      await kpdf3.closeWorkspace();
      const opened = await kpdf3.openPdfFile(savePath);
      projectStore.reset(opened.overlays ?? []);
      pendingDeletedPages.clear();
      workspaceMutated = false;
      thumbSelection.pageNos.clear();
      thumbSelection.anchor = null;
      history.clear();
      await refreshViewer();
    } catch (switchErr) {
      console.error("[renderer] post-export workspace switch failed:", switchErr);
    }
    hideBusy();
    wsStatus.textContent = `${savePath} に切り替えました（${verb}, rev ${result.revisionId.slice(0, 8)}）`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] export failed:", err);
    wsStatus.textContent = `${verb}失敗: ${err.message ?? err}`;
  }
}

async function actionSave() {
  if (!isOpen) return;
  // No-op when nothing has changed since the last save.
  if (!isWorkspaceDirty()) return;
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

async function rotatePageBy(pageNo, delta) {
  if (!isOpen || !pageNo) return;
  const row = viewer._pages?.find((p) => p.pageNo === pageNo);
  if (!row) return;
  // Drop split-state thumb cache for this page so the next split-save
  // view re-renders with the new rotation. Sidebar thumbs are wiped by
  // rebuildThumbs further below, so they don't need explicit clearing.
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
    projectStore.update(ov.id, {
      ...t,
      properties: { ...props, rotation: newRot },
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
function rotateCurrentPage(delta) {
  return rotatePageBy(viewer.currentPage, delta);
}
function actionRotateLeft() { return rotateCurrentPage(-90); }
function actionRotateRight() { return rotateCurrentPage(+90); }

function applyZoom(z) {
  viewer.setZoom(z);
  refreshMenuState();
  refreshZoomSelect();
  if (isOpen) wsStatus.textContent = `${Math.round(z * 100)}%`;
}

function refreshZoomSelect() {
  if (!zoomSelect) return;
  const z = viewer.zoom;
  // Strip any prior dynamic "current %" entry so we don't accumulate them.
  for (const opt of [...zoomSelect.querySelectorAll("option[data-dynamic]")]) {
    opt.remove();
  }
  const match = [...zoomSelect.options].find((opt) => {
    const v = parseFloat(opt.value);
    return Number.isFinite(v) && Math.abs(v - z) < 1e-3;
  });
  if (match) {
    zoomSelect.value = match.value;
    return;
  }
  // No preset matches — inject a dynamic option showing the actual
  // percentage so the dropdown isn't blank after fit / Ctrl+wheel zoom.
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
let zoomMode = "fixed";

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
  return true;
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

// ---- Bookmarks sidebar (M5-5) ----------------------------------------

// Selected bookmark id (workspace-side bookmarks only). null when the
// list is showing read-only /Outlines from the source PDF.
let selectedBookmarkId = null;
let bookmarkSource = "outline"; // "outline" | "workspace"

async function refreshBookmarks() {
  bookmarkTree.innerHTML = "";
  selectedBookmarkId = null;
  refreshBookmarkToolbarState();
  if (!isOpen) return;
  // Workspace bookmarks override the source PDF /Outlines once any
  // exist. Empty workspace list → show /Outlines (read-only).
  const ws = await kpdf3.listBookmarks();
  const sourceLabel = $("bookmark-source-label");
  if (Array.isArray(ws) && ws.length > 0) {
    bookmarkSource = "workspace";
    if (sourceLabel) sourceLabel.textContent = "(編集可能)";
    for (const b of ws) {
      bookmarkTree.appendChild(createWorkspaceBookmarkNode(b));
    }
    refreshBookmarkToolbarState();
    return;
  }
  bookmarkSource = "outline";
  if (sourceLabel) sourceLabel.textContent = "(元 PDF / 編集不可)";
  const outline = await kpdf3.getOutline();
  if (!outline || outline.length === 0) {
    const li = document.createElement("li");
    li.className = "bookmark-empty";
    li.textContent = "(しおりがありません)";
    bookmarkTree.appendChild(li);
    refreshBookmarkToolbarState();
    return;
  }
  for (const item of outline) {
    bookmarkTree.appendChild(createBookmarkNode(item));
  }
  refreshBookmarkToolbarState();
}

function createBookmarkNode(item) {
  const li = document.createElement("li");
  li.className = "bookmark-item";
  li.textContent = item.title || "(無題)";
  if (typeof item.pageNo === "number" && item.pageNo > 0) {
    li.dataset.pageNo = String(item.pageNo);
    li.title = `${item.title} (p.${item.pageNo})`;
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      viewer.scrollToPage(item.pageNo);
    });
  } else {
    li.style.color = "#666";
  }
  if (Array.isArray(item.children) && item.children.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "bookmark-children";
    for (const child of item.children) {
      ul.appendChild(createBookmarkNode(child));
    }
    li.appendChild(ul);
  }
  return li;
}

/** Workspace-side bookmarks: clickable + selectable + double-click rename. */
function createWorkspaceBookmarkNode(b) {
  const li = document.createElement("li");
  li.className = "bookmark-item is-workspace";
  li.dataset.bookmarkId = b.id;
  li.dataset.pageNo = String(b.pageNo);
  li.title = `${b.title} (p.${b.pageNo})`;
  li.tabIndex = 0;
  const label = document.createElement("span");
  label.className = "bookmark-label";
  label.textContent = b.title || "(無題)";
  li.appendChild(label);
  const pageTag = document.createElement("span");
  pageTag.className = "bookmark-page-tag";
  pageTag.textContent = b.pageNo > 0 ? `p.${b.pageNo}` : "挿入";
  li.appendChild(pageTag);
  li.addEventListener("click", (e) => {
    e.stopPropagation();
    selectBookmark(b.id);
    if (typeof b.pageNo === "number") viewer.scrollToPage(b.pageNo);
  });
  li.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startInlineRenameBookmark(li, b);
  });
  return li;
}

function selectBookmark(id) {
  selectedBookmarkId = id;
  for (const el of bookmarkTree.querySelectorAll(".bookmark-item.is-workspace")) {
    el.classList.toggle("is-selected", el.dataset.bookmarkId === id);
  }
  refreshBookmarkToolbarState();
}

function refreshBookmarkToolbarState() {
  const addBtn = $("bookmark-add");
  const rmBtn = $("bookmark-remove");
  const impBtn = $("bookmark-import");
  if (addBtn) addBtn.disabled = !isOpen;
  if (rmBtn) rmBtn.disabled = !isOpen || !selectedBookmarkId || bookmarkSource !== "workspace";
  // Import only useful when source-PDF /Outlines exist AND workspace
  // is empty (otherwise there'd be duplicate entries; user can − the
  // existing workspace ones first if they really want to re-import).
  if (impBtn) impBtn.disabled = !isOpen || bookmarkSource !== "outline";
}

function startInlineRenameBookmark(li, b) {
  const label = li.querySelector(".bookmark-label");
  if (!label) return;
  const input = document.createElement("input");
  input.type = "text";
  input.value = b.title;
  input.className = "bookmark-rename-input";
  label.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim() || b.title;
    if (commit && next !== b.title) {
      try {
        await kpdf3.renameBookmark({ id: b.id, title: next });
      } catch (err) {
        console.error("[bookmark] rename failed", err);
      }
    }
    await refreshBookmarks();
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
}

async function actionAddBookmark() {
  if (!isOpen) return;
  const pageNo = viewer.currentPage;
  if (!pageNo) return;
  const fallback = `ページ ${pageNo > 0 ? pageNo : "挿入"}`;
  const entered = await showRangePrompt({
    title: "しおりを追加",
    message: `ページ ${pageNo > 0 ? pageNo : "挿入"} のしおり名を入力（空欄で「${fallback}」）`,
    value: "",
  });
  if (entered === null) return; // user cancelled
  const id = (crypto?.randomUUID?.() ?? `bm-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const title = entered.trim() || fallback;
  try {
    await kpdf3.addBookmark({ id, title, pageNo });
    await refreshBookmarks();
    selectBookmark(id);
  } catch (err) {
    console.error("[bookmark] add failed", err);
    wsStatus.textContent = `しおり追加失敗: ${err.message ?? err}`;
  }
}

async function actionRemoveBookmark() {
  if (!selectedBookmarkId) return;
  try {
    await kpdf3.removeBookmark({ id: selectedBookmarkId });
    selectedBookmarkId = null;
    await refreshBookmarks();
  } catch (err) {
    console.error("[bookmark] remove failed", err);
  }
}

$("bookmark-add")?.addEventListener("click", actionAddBookmark);
$("bookmark-remove")?.addEventListener("click", actionRemoveBookmark);

/** Flatten the source-PDF /Outlines tree into workspace bookmarks so the
 *  user can edit / extend them. The tree is walked depth-first; titles
 *  for nodes without a target page get suffixed "(章)" so they stay
 *  visible but skip navigation. Subsequent calls are guarded by the
 *  toolbar disabled state when workspace bookmarks already exist. */
async function actionImportOutlines() {
  if (!isOpen) return;
  const ok = await customConfirm({
    title: "しおりの取り込み",
    message: "元 PDF のしおりを workspace に取り込みます。\n以後は編集できるようになります。",
    okLabel: "取り込む",
  });
  if (!ok) return;
  const outline = await kpdf3.getOutline();
  if (!Array.isArray(outline) || outline.length === 0) {
    wsStatus.textContent = "取り込めるしおりがありません";
    return;
  }
  // Depth-first flatten; nodes without a pageNo get the parent's pageNo
  // (or 1 if absent) so they're still navigable.
  const flat = [];
  const walk = (nodes, fallbackPage) => {
    for (const n of nodes) {
      const pageNo = typeof n.pageNo === "number" && n.pageNo > 0 ? n.pageNo : fallbackPage;
      flat.push({ title: n.title || "(無題)", pageNo });
      if (Array.isArray(n.children) && n.children.length > 0) {
        walk(n.children, pageNo);
      }
    }
  };
  walk(outline, 1);
  let added = 0;
  try {
    for (const b of flat) {
      const id =
        crypto?.randomUUID?.() ?? `bm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await kpdf3.addBookmark({ id, title: b.title, pageNo: b.pageNo });
      added += 1;
    }
    await refreshBookmarks();
    wsStatus.textContent = `${added} 件のしおりを取り込みました`;
  } catch (err) {
    console.error("[bookmark] import failed", err);
    wsStatus.textContent = `取り込み失敗: ${err.message ?? err}`;
  }
}
$("bookmark-import")?.addEventListener("click", actionImportOutlines);

function actionToggleBookmarks() {
  if (!isOpen) return;
  sidebar.hidden = !sidebar.hidden;
  refreshSidebarToggle();
  refreshMenuState();
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
function rebuildThumbs(pages) {
  clearThumbs();
  const list = Array.isArray(pages)
    ? pages
    : Array.from({ length: pages || 0 }, (_, i) => ({ pageNo: i + 1 }));
  if (list.length === 0) return;
  const obs = ensureThumbObserver();

  // Insert "+" gap before page 1 (afterPageNo = 0). Only for source-PDF
  // pages — gaps are anchored to the prior source page, so they sit
  // before the first source page or after each one.
  const firstSrcRow = list.find((r) => !r.isSynthetic);
  if (firstSrcRow) {
    thumbList.appendChild(makeInsertGap(0));
  }

  for (const row of list) {
    const i = row.pageNo;
    const item = document.createElement("div");
    item.className = "thumb-item";
    item.dataset.pageNo = String(i);
    item.tabIndex = 0;
    if (row.isSynthetic) item.classList.add("is-synthetic");
    const ph = document.createElement("div");
    ph.className = "thumb-placeholder";
    item.appendChild(ph);
    const label = document.createElement("div");
    label.className = "thumb-label";
    label.textContent = row.isSynthetic ? "✎ 挿入" : String(i);
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
    if (row.isSynthetic) {
      thumbList.appendChild(
        makeInsertGap(row.syntheticAfterPageNo ?? 0, (row.syntheticOrderInSlot ?? 0) + 1),
      );
    } else {
      thumbList.appendChild(makeInsertGap(i));
    }
  }
  refreshThumbSelectionVisuals();
}

/** Wire drop-on-gap so dragging a PDF onto an insert gap inserts that
 *  PDF's pages here. stopPropagation prevents the global drop handler
 *  (which opens a fresh PDF) from firing too.
 *  TODO: pass orderInSlot through to addInsertedPdfPages once main supports it.
 */
function attachInsertGapDrop(gap, afterPageNo) {
  gap.addEventListener("dragover", (e) => {
    if (!e.dataTransfer) return;
    if ([...e.dataTransfer.types].includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      gap.classList.add("drop-target");
    }
  });
  gap.addEventListener("dragleave", () => gap.classList.remove("drop-target"));
  gap.addEventListener("drop", async (e) => {
    gap.classList.remove("drop-target");
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    const path = kpdf3.getPathForFile?.(file) || file.path || "";
    if (!path || !/\.pdf$/i.test(path)) {
      wsStatus.textContent = "PDF ファイルをドロップしてください";
      return;
    }
    showBusy("挿入", "外部 PDF を取り込み中...", 0);
    try {
      const r = await kpdf3.addInsertedPdfPages({ afterPageNo, externalPath: path });
      hideBusy();
      markWorkspaceMutated();
      await refreshViewer();
      const n = r?.syntheticPageNos?.length ?? 0;
      wsStatus.textContent = `${n} ページを挿入しました`;
    } catch (err) {
      hideBusy();
      console.error("[insert-pdf] failed", err);
      wsStatus.textContent = `挿入失敗: ${err.message ?? err}`;
    }
  });
}

function makeInsertGap(afterPageNo, orderInSlot = null) {
  const gap = document.createElement("div");
  gap.className = "thumb-insert-gap";
  gap.tabIndex = 0;
  gap.title = `クリック=白紙挿入 / PDF をドロップ=外部 PDF 挿入 (afterPageNo=${afterPageNo}${orderInSlot != null ? `, order=${orderInSlot}` : ""})`;
  gap.textContent = "＋ 白紙 / PDF をドロップ";
  gap.addEventListener("click", () => promptAndInsertBlank(afterPageNo, orderInSlot));
  gap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      promptAndInsertBlank(afterPageNo, orderInSlot);
    }
  });
  attachInsertGapDrop(gap, afterPageNo);
  return gap;
}

function makeSplitInsertGap(afterPageNo, orderInSlot = null) {
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
  attachInsertGapDrop(gap, afterPageNo);
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
  return [...rootEl.querySelectorAll(selector)]
    .map((el) => Number(el.dataset.pageNo))
    .filter((n) => Number.isFinite(n) && n > 0);
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
 *  in-memory. Reset on close / new PDF open. */
const pendingDeletedPages = new Set();

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
  const labels = all
    .map((n) => (n > 0 ? `p.${n}` : "挿入ページ"))
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
thumbList?.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelectedPages(sidebarThumbSelection);
  }
});
splitFlow?.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") {
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
    recent: actionShowRecent,
    close: actionClose,
    save: actionSave,
    export: actionExport,
    "export-range": actionExportRange,
    "split-save": actionSplitSave,
    print: actionPrint,
    exit: actionExit,
    about: actionAbout,
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
    "stamp-manager": () => {
      // Full preset-management dialog is ADR-0019 territory; for the
      // MVP we just point the user at the existing toolbar select.
      customConfirm({
        title: "スタンプ管理",
        message:
          "現在使えるテンプレート（toolbar の「印影」横の select）:\n" +
          "  • 印  — 60×60 の朱印（円枠）\n" +
          "  • 日付 (8.5.9)  — 矩形枠、令和年.月.日\n" +
          "  • 日付 (令和8年5月9日)  — 矩形枠、漢字\n" +
          "色: 朱 / 黒 / 青\n" +
          "配置後はクリックで文字編集、ドラッグで移動。\n\n" +
          "ユーザー定義のテンプレ保存・編集 / 印影画像の取り込み /\n" +
          "和文・英文フォント別指定は M6 後半で対応予定（ADR-0019, 0017）。",
        okLabel: "スタンプモードへ",
        cancelLabel: "閉じる",
      }).then((ok) => {
        if (ok && isOpen) setPlacementMode("stamp");
      });
    },
    "quality-standard": () => setRenderQuality("standard"),
    "quality-high": () => setRenderQuality("high"),
    "quality-max": () => setRenderQuality("max"),
  },
});

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
  if ((e.key === "Delete" || e.key === "Backspace") && selectedOverlayId && !inText) {
    e.preventDefault();
    const id = selectedOverlayId;
    setSelectedOverlay(null);
    history.execute(new RemoveOverlayCommand(projectStore, id));
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
    // Ctrl+F → focus the menu-bar search box
    e.preventDefault();
    if (!menuSearchInput.disabled) {
      menuSearchInput.focus();
      menuSearchInput.select();
    }
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

menuSearchBtn.addEventListener("click", runSearch);
menuSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runSearch();
  } else if (e.key === "Escape") {
    e.preventDefault();
    menuSearchInput.blur();
  }
});

// Enable / disable with PDF open state
function refreshSearchEnabled() {
  menuSearchInput.disabled = !isOpen;
  menuSearchBtn.disabled = !isOpen;
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
  "split-save": "PDF を複数のパートに分割保存します",
  print: "PDF を印刷します (Ctrl+P)",
  exit: "アプリを終了します",
  undo: "直前の編集を取り消します (Ctrl+Z)",
  redo: "取り消した編集をやり直します (Ctrl+Y)",
  "zoom-in": "表示を拡大します (Ctrl++)",
  "zoom-out": "表示を縮小します (Ctrl+-)",
  "zoom-fit": "ページがウィンドウに収まる倍率にします",
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
  "font-settings": "フォント設定 — 将来対応",
  about: "K-PDF3 のバージョン情報",
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
document.addEventListener("dragover", (e) => {
  e.preventDefault();
});
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
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
  if (!(await confirmDiscardIfDirty())) return;
  await openPdfPath(path);
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
window.addEventListener("beforeunload", (e) => {
  if (_reloadingRenderer) return;
  if (projectStore.isDirty()) {
    e.preventDefault();
    e.returnValue = "";
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

// ---- Toolbar buttons --------------------------------------------------
btnOpen.addEventListener("click", actionOpen);
btnSave.addEventListener("click", actionSave);
btnExport.addEventListener("click", actionExport);
btnPrint.addEventListener("click", actionPrint);
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

// Stamp template / color: picking either auto-switches into stamp mode
// so the user lands directly in "place this stamp" (mirrors the
// redaction-color UX). Persisted to localStorage.
const STAMP_TEMPLATE_KEY = "kpdf3.stampTemplate";
const STAMP_COLOR_KEY = "kpdf3.stampColor";
if (stampTemplateSel) {
  const saved = localStorage.getItem(STAMP_TEMPLATE_KEY);
  if (saved && [...stampTemplateSel.options].some((o) => o.value === saved)) {
    stampTemplateSel.value = saved;
  }
  stampTemplateSel.addEventListener("change", () => {
    localStorage.setItem(STAMP_TEMPLATE_KEY, stampTemplateSel.value);
    if (isOpen && placementMode !== "stamp") setPlacementMode("stamp");
    updateStampGhostPreset();
  });
}
$("stamp-add-image")?.addEventListener("click", actionAddImageStamp);
if (stampColorSel) {
  const saved = localStorage.getItem(STAMP_COLOR_KEY);
  if (saved && [...stampColorSel.options].some((o) => o.value === saved)) {
    stampColorSel.value = saved;
  }
  stampColorSel.addEventListener("change", () => {
    localStorage.setItem(STAMP_COLOR_KEY, stampColorSel.value);
    if (isOpen && placementMode !== "stamp") setPlacementMode("stamp");
    updateStampGhostPreset();
  });
}
btnRotateLeft.addEventListener("click", actionRotateLeft);
btnRotateRight.addEventListener("click", actionRotateRight);

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
  projectStore.update(id, {
    properties: { ...ov.properties, fontId, fontSize },
  });
  // Keep the inline-edit element visually in sync (the store update
  // alone doesn't repaint the editing element — see viewer's preserve-
  // editing logic).
  viewer.applyEditingTextStyle({ fontId, fontSize });
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

// ---- Initial state ----------------------------------------------------
setOpen(false);

(async () => {
  const info = await kpdf3.getAppInfo();
  $("appinfo").textContent = `v${info.appVersion} / Electron ${info.electronVersion}`;
})();
