// Stamp rendering helpers.
//
// Pure canvas / text helpers used across the stamp pipeline (palette
// thumbs, register-dialog previews, trial-placement canvases, ghost).
// No state of their own — splitStampRuns is the only outside dep.

import { splitStampRuns } from "./fonts.js";

/** Set up `canvas` for HiDPI drawing at the given CSS pixel size. The
 *  pixel buffer becomes (cssW * dpr, cssH * dpr), CSS keeps it sized
 *  at (cssW, cssH), the context is pre-scaled so subsequent draw calls
 *  work in CSS units, and we cache the logical (CSS) dims on dataset
 *  so the paint helpers below can read them via canvasLogicalSize().
 *  Call this BEFORE paintPresetThumb / paintStampPreview. */
export function setupHiDPICanvas(canvas, cssW, cssH) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.dataset.cssW = String(cssW);
  canvas.dataset.cssH = String(cssH);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Read the logical (CSS pixel) drawing size from a canvas, falling
 *  back to its raw attribute size for canvases that haven't been
 *  through setupHiDPICanvas. */
export function canvasLogicalSize(canvas) {
  const w = parseFloat(canvas.dataset.cssW);
  const h = parseFloat(canvas.dataset.cssH);
  if (Number.isFinite(w) && Number.isFinite(h)) return { W: w, H: h };
  return { W: canvas.width, H: canvas.height };
}

// `color` controls how the source image bytes are post-processed:
//   - ""               → as-is (white background visible)
//   - "bg-transparent" → luminance → alpha, keep original RGB
//                        (so scanned 印影 lose their white paper without
//                        being recolored)
//   - "#rrggbb"        → luminance → alpha, RGB replaced with the colour
//                        (the existing tint path)
export function tintCanvasInPlace(ctx, color) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  if (color === "bg-transparent") {
    for (let i = 0; i < d.length; i += 4) {
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      d[i + 3] = Math.round(d[i + 3] * (1 - lum));
    }
    ctx.putImageData(img, 0, 0);
    return;
  }
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(color ?? ""));
  if (!m) return;
  const v = m[1];
  const tr = parseInt(v.slice(0, 2), 16);
  const tg = parseInt(v.slice(2, 4), 16);
  const tb = parseInt(v.slice(4, 6), 16);
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    d[i + 3] = Math.round(d[i + 3] * (1 - lum));
    d[i] = tr;
    d[i + 1] = tg;
    d[i + 2] = tb;
  }
  ctx.putImageData(img, 0, 0);
}

/** Mirrors `drawStampMixedTextOnCanvas` in exporter.js — kept local so
 *  the font dialog preview stays self-contained. */
export function drawStampMixedText(ctx, text, cx, cy, fontSize, color, fullStack, halfStack) {
  const runs = splitStampRuns(text);
  const widths = [];
  let total = 0;
  for (const run of runs) {
    ctx.font = `bold ${fontSize}px ${run.cls === "half" ? halfStack : fullStack}`;
    const m = ctx.measureText(run.text);
    widths.push(m.width);
    total += m.width;
  }
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let pen = cx - total / 2;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    ctx.font = `bold ${fontSize}px ${run.cls === "half" ? halfStack : fullStack}`;
    ctx.fillText(run.text, pen, cy);
    pen += widths[i];
  }
}

/** Format a date according to the spec key — same logic as the
 *  current built-in date templates so the registered preset
 *  produces the same text at placement time. */
export function renderDateText(formatKey) {
  const d = new Date();
  const reiwa = d.getFullYear() - 2018;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  // Hyphen-as-zero-fill: only single-digit values get the leading "-".
  // Two-digit values (10..99) print as-is. So 令和8年5月10日 →
  // "-8.-5.10", not "-8.-5.-10".
  const dp = (n) => (n < 10 ? `-${n}` : String(n));
  if (formatKey === "date-numeric-fw") return `${dp(reiwa)}．${dp(m)}．${dp(day)}`;
  if (formatKey === "date-kanji-dash") return `令和${dp(reiwa)}年${dp(m)}月${dp(day)}日`;
  if (formatKey === "date-numeric-spaced") {
    // Three numbers, each zero-fill-as-hyphen. Separator dots are
    // not drawn — placement adds spacingMode='distribute-3' so the
    // renderer distributes the three tokens across the box width
    // instead of laying them out as a single text line.
    return `${dp(reiwa)} ${dp(m)} ${dp(day)}`;
  }
  if (formatKey === "date-numeric-spaced-2") {
    // Year + month only; day is left blank so the user can hand-
    // write it on the printed form. Placement adds spacingMode=
    // 'distribute-2' so the two tokens sit at the box edges.
    return `${dp(reiwa)} ${dp(m)}`;
  }
  return `${dp(reiwa)}.${dp(m)}.${dp(day)}`; // default = numeric-dash
}
