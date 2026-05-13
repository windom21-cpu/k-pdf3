// Overlay edit-commit + measurement helpers.
//
// Owns the "after you finish editing / dragging / resizing, save it"
// path: handleTextEditCommit / handleOverlayDragEnd / handleOverlayResizeEnd
// / handleCalloutArrowEnd. Also exposes measureTextOverlaySize and
// measureCalloutSize / measureCalloutWrappedHeight, which give the
// canonical box dimensions for a given text body so the saved w/h
// matches what the renderer and exporter will actually draw.
//
// State (isOpen, projectStore, history, viewer) is owned by renderer.js
// and reached via getters passed into initOverlayEdit — this way the
// active-tab alias rebind (applyTab) is picked up live without any
// re-init dance.

import { UpdateOverlayCommand } from "../domain/commands.js";
import { getTextFontStack } from "./fonts.js";

let _isOpen = () => false;
let _projectStore = () => null;
let _history = () => null;
let _viewer = null;

export function initOverlayEdit({ isOpen, projectStore, history, viewer }) {
  _isOpen = isOpen;
  _projectStore = projectStore;
  _history = history;
  _viewer = viewer;
}

// Callout layout: the box hugs the line-box — only the 1px outer
// border separates the text from the frame. Horizontal padding 4px
// remains for readability; vertical padding is zero so the frame
// "上付きかつ下付き" — the text edges touch the frame top and bottom
// (modulo CSS line-height leading inherent to the font). Exporter
// matches this with padY = 1 * zoom for the border-only inset.
const CALLOUT_PAD_X = 5;        // 4 (textNode horizontal) + 1 (border)
const CALLOUT_PAD_Y_TOP = 1;    // 1 (border) only
const CALLOUT_PAD_Y_BOTTOM = 1; // 1 (border) only
// line-height 1.0 means the line-box equals the font-size, so glyphs
// touch the frame on top and bottom (no leading slack). 1.2 left a
// visible bottom gap because CJK font metrics push glyphs toward the
// top of each line-box. Stay matched with editor-side style.lineHeight.
const CALLOUT_LINE_HEIGHT = 1.0;

export function handleTextEditCommit(id, newText, opts = {}) {
  if (!_isOpen()) return;
  const projectStore = _projectStore();
  const history = _history();
  const ov = projectStore.get(id);
  if (!ov) return;
  // Auto-fit the box to the entered text so longer / multi-line content
  // doesn't overflow the initial placement size. Both callout and
  // plain text overlays use the same recipe: the editor's reported
  // visible size (already wrapped + pixel-rounded by Chromium) is the
  // source of truth, and a measure-based fallback covers callers that
  // can't report it. JS-side measureText approximations of Chromium's
  // wrap differ by 1-2 lines on long paragraphs — invisible on
  // borderless text overlays, but a visible gap below callouts.
  let sizePatch = {};
  const isCallout = ov.type === "rect" && ov.properties?.kind === "callout";
  if (ov.type === "text" || isCallout) {
    if (opts.visibleCanonicalW != null && opts.visibleCanonicalH != null) {
      sizePatch = {
        w: Math.max(40, Math.ceil(opts.visibleCanonicalW)),
        h: Math.max(ov.properties?.fontSize ?? 12, Math.ceil(opts.visibleCanonicalH)),
      };
    } else {
      // Legacy fallback: page-edge-capped measure (β.25 C1 recipe).
      let maxCanonicalW = Infinity;
      const row = _viewer._pages?.find((p) => p.pageNo === ov.pageNo);
      if (row) {
        const cw = row.cropW ?? row.width ?? 595;
        const ch = row.cropH ?? row.height ?? 842;
        const userRot = (((row.userRotation ?? 0) % 360) + 360) % 360;
        const swap = userRot === 90 || userRot === 270;
        const pageW = swap ? ch : cw;
        maxCanonicalW = Math.max(60, pageW - (ov.x ?? 0) - 4);
      }
      const fontSize = ov.properties?.fontSize ?? 12;
      const fontStack = getTextFontStack(ov.properties?.fontId, {
        digitsHanko: !!ov.properties?.digitsHanko,
      });
      const measure = isCallout ? measureCalloutSize : measureTextOverlaySize;
      const m = measure(newText, fontSize, fontStack, ov.w, maxCanonicalW);
      sizePatch = { w: m.w, h: m.h };
    }
  }
  history.execute(
    new UpdateOverlayCommand(projectStore, id, {
      ...sizePatch,
      properties: { ...ov.properties, text: newText },
    }),
  );
}

/** Measure the natural size of a plain text overlay. Width: longest
 *  unwrapped line OR the current box width (whichever is larger), then
 *  capped at `maxW` (default Infinity — caller may pass page-edge minus
 *  overlay left so the committed box doesn't extend past the paper).
 *  Height: number of wrapped lines × line height at the chosen width.
 *
 *  The implementation mirrors measureCalloutSize / wrapCanvasText so the
 *  saved canonical w/h matches what the renderer and exporter draw.
 */
export function measureTextOverlaySize(text, fontSize, fontFamily, currentW, maxW = Infinity) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontSize}px ${fontFamily}`;
  const lines = (text ?? "").split(/\r?\n/);
  let maxLineWidth = 0;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (w > maxLineWidth) maxLineWidth = w;
  }
  const minW = Math.max(60, fontSize * 6);
  const targetW = Math.max(minW, Math.ceil(maxLineWidth) + 4);
  // Don't shrink below current — user may have manually widened the
  // box and we shouldn't undo that. Don't exceed maxW (page edge) so
  // the committed box stays inside the paper (β15 regression).
  const w = Math.min(maxW, Math.max(currentW ?? 0, targetW));
  // Wrap at the chosen width to compute height (mirrors wrapCanvasText).
  let lineCount = 0;
  for (const para of lines) {
    if (para.length === 0) { lineCount += 1; continue; }
    let line = "";
    let count = 0;
    for (const ch of para) {
      const candidate = line + ch;
      if (line.length > 0 && ctx.measureText(candidate).width > w) {
        count += 1;
        line = ch;
      } else {
        line = candidate;
      }
    }
    if (line.length > 0) count += 1;
    lineCount += Math.max(count, 1);
  }
  const lineHeight = fontSize * 1.2;
  const h = Math.max(fontSize, Math.ceil(lineCount * lineHeight));
  return { w, h };
}

/** Measure the natural size of a callout's text in canonical points.
 *  Mirrors measureTextOverlaySize's signature so commit logic can call
 *  either function uniformly: caller passes the current box width and
 *  a page-edge max-width, the function returns the wrap-preserving box
 *  size. */
export function measureCalloutSize(text, fontSize, fontFamily, currentW = 0, maxW = Infinity) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontSize}px ${fontFamily}`;
  const paras = (text ?? "").split(/\r?\n/);
  let maxLineWidth = 0;
  for (const line of paras) {
    const w = ctx.measureText(line).width;
    if (w > maxLineWidth) maxLineWidth = w;
  }
  const padX = CALLOUT_PAD_X;
  const minW = Math.max(40, fontSize * 4);
  const targetW = Math.max(minW, Math.ceil(maxLineWidth) + padX * 2);
  // Don't shrink below currentW (user may have widened); cap at maxW
  // (page edge) so the committed callout stays inside the paper.
  const w = Math.min(maxW, Math.max(currentW ?? 0, targetW));
  // Wrap at the chosen w to count lines (same algorithm as
  // measureCalloutWrappedHeight, kept inline so the function stays
  // self-contained and parallel to measureTextOverlaySize).
  const innerW = Math.max(20, w - padX * 2);
  let lineCount = 0;
  for (const para of paras) {
    if (para === "") { lineCount += 1; continue; }
    const chars = [...para];
    let line = "";
    for (const c of chars) {
      const next = line + c;
      if (ctx.measureText(next).width <= innerW) {
        line = next;
      } else {
        if (line) lineCount += 1;
        line = c;
      }
    }
    if (line) lineCount += 1;
  }
  // Chromium rounds line-box height up to whole CSS pixels per line, so
  // multiplying a float lineHeight by lineCount underestimates the real
  // rendered height — visible as "下に余白がはみ出る" once the box has
  // a border (callouts do; plain text overlays don't, which is why this
  // ceil-per-line treatment isn't needed in measureTextOverlaySize).
  const lineHeight = Math.ceil(fontSize * CALLOUT_LINE_HEIGHT);
  return {
    w: Math.ceil(w),
    h: Math.max(
      fontSize,
      lineHeight * Math.max(1, lineCount) + CALLOUT_PAD_Y_TOP + CALLOUT_PAD_Y_BOTTOM,
    ),
  };
}

export function handleOverlayDragEnd(id, newX, newY) {
  if (!_isOpen()) return;
  const projectStore = _projectStore();
  const history = _history();
  const ov = projectStore.get(id);
  if (!ov) return;
  // No-op when the gesture didn't actually move anything (rounding edge).
  if (ov.x === newX && ov.y === newY) return;
  history.execute(
    new UpdateOverlayCommand(projectStore, id, { x: newX, y: newY }),
  );
}

export function handleCalloutArrowEnd(id, arrowDx, arrowDy) {
  if (!_isOpen()) return;
  const projectStore = _projectStore();
  const history = _history();
  const ov = projectStore.get(id);
  if (!ov || ov.type !== "rect" || ov.properties?.kind !== "callout") return;
  const oldDx = ov.properties.arrowDx ?? -30;
  const oldDy = ov.properties.arrowDy ?? ov.h + 25;
  if (Math.abs(oldDx - arrowDx) < 1e-3 && Math.abs(oldDy - arrowDy) < 1e-3) return;
  history.execute(new UpdateOverlayCommand(projectStore, id, {
    properties: { ...ov.properties, arrowDx, arrowDy },
  }));
}

export function handleOverlayResizeEnd(id, bbox) {
  if (!_isOpen()) return;
  const projectStore = _projectStore();
  const history = _history();
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
  // Callouts: respect the user's new width but snap height to the
  // wrapped text. Previously we kept the user's dragged height when
  // it exceeded the text (Math.max), which left visible empty space
  // below the wrapped text inside the callout border. Now the border
  // always hugs the bottom of the last line — matches "no whitespace"
  // behaviour of regular text overlays.
  if (ov.type === "rect" && ov.properties?.kind === "callout") {
    const wrappedH = measureCalloutWrappedHeight(
      ov.properties.text ?? "",
      ov.properties.fontSize ?? 12,
      getTextFontStack(ov.properties.fontId, {
        digitsHanko: !!ov.properties.digitsHanko,
      }),
      bbox.w,
    );
    bbox = { ...bbox, h: wrappedH };
  }
  history.execute(new UpdateOverlayCommand(projectStore, id, bbox));
}

/** Measure the height (canonical pt) needed to fit `text` in a box of
 *  width `boxW` at the given font, including padding. Honours CJK
 *  word-wrap via the same character-by-character algorithm the
 *  exporter uses. */
export function measureCalloutWrappedHeight(text, fontSize, fontFamily, boxW) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontSize}px ${fontFamily}`;
  const padX = CALLOUT_PAD_X;
  const lineHeight = fontSize * CALLOUT_LINE_HEIGHT;
  const innerW = Math.max(20, boxW - padX * 2);
  // Wrap: hard breaks on \n, otherwise greedy character-by-character
  // fit within innerW.
  const paras = (text ?? "").split(/\r?\n/);
  let lineCount = 0;
  for (const para of paras) {
    if (para === "") { lineCount += 1; continue; }
    const chars = [...para]; // codepoint-safe
    let line = "";
    for (const c of chars) {
      const next = line + c;
      if (ctx.measureText(next).width <= innerW) {
        line = next;
      } else {
        if (line) lineCount += 1;
        line = c;
      }
    }
    if (line) lineCount += 1;
  }
  // Match measureCalloutSize: ceil per-line for Chromium line-box rounding.
  return Math.max(
    fontSize,
    Math.ceil(fontSize * CALLOUT_LINE_HEIGHT) * Math.max(1, lineCount)
      + CALLOUT_PAD_Y_TOP + CALLOUT_PAD_Y_BOTTOM,
  );
}
