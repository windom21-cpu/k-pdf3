// Renderer-side export composer (M4-1).
//
// For each page in the workspace:
//   1. ask main to render the source page at EXPORT_ZOOM via the existing
//      kpdf3.renderPage IPC,
//   2. paint the returned RGBA bytes onto a Canvas,
//   3. paint the page's overlays on top using Canvas 2D APIs,
//   4. extract the composed canvas as a PNG byte array.
//
// The collected PNGs (with their canonical PDF-point dimensions) are then
// shipped to main where mupdf assembles them into a flat PDF.
//
// EXPORT_ZOOM is 600 / 72 — exactly 600 dpi, matching the user's
// preceding-tool baseline. β3 testers reported 144 dpi as outright
// unusable and 288 dpi (4.0) as still short of the prior quality bar.
// Trade-off: per-page PNG buffers are ~4× heavier than at 288 dpi
// (~150MB raw RGBA for A4) and the assembled PDF balloons proportionally.
// The proper long-term fix is hybrid PDF assembly — keep unedited source
// pages as vectors and only rasterize pages with overlays — deferred to
// β5+ since it needs a mupdf graftObject pipeline.

import { canonicalPageSize } from "../domain/coord.js";
import {
  getTextFontStack,
  getStampFontDefaults,
  getStampFontStack,
  splitStampRuns,
} from "./fonts.js";

/**
 * In-memory cache: assetId → ImageBitmap. The bitmap survives the
 * Blob it was created from, so it's safe to reuse across multiple
 * compositePage / drawOverlay calls.
 */
const _assetBitmapCache = new Map();
async function getAssetBitmap(assetId) {
  if (_assetBitmapCache.has(assetId)) return _assetBitmapCache.get(assetId);
  const data = await globalThis.kpdf3?.getAsset?.(assetId);
  if (!data?.blob) return null;
  const u8 = data.blob instanceof Uint8Array
    ? data.blob
    : new Uint8Array(data.blob.buffer ?? data.blob);
  const blob = new Blob([u8], { type: data.mime || "image/png" });
  const bitmap = await createImageBitmap(blob);
  _assetBitmapCache.set(assetId, bitmap);
  return bitmap;
}

/** Drop a single asset from the bitmap cache (e.g. when the user
 *  removes / replaces an asset and we want a fresh fetch next time). */
export function invalidateAssetBitmap(assetId) {
  const bm = _assetBitmapCache.get(assetId);
  if (bm) bm.close?.();
  _assetBitmapCache.delete(assetId);
  for (const k of [..._tintedAssetCache.keys()]) {
    if (k.startsWith(`${assetId} `)) _tintedAssetCache.delete(k);
  }
}

/**
 * Cache for color-tinted variants used at export time. The tinted
 * canvas matches the source bitmap's natural size; drawImage scales it
 * to the overlay box exactly like the untinted path. Mirrors the
 * viewer's `_tintedStampUrl` logic but keeps a HTMLCanvasElement
 * (drawImage source) instead of an object URL.
 */
const _tintedAssetCache = new Map();
async function getTintedAssetCanvas(assetId, color) {
  if (!color) return null;
  const key = `${assetId} ${color}`;
  if (_tintedAssetCache.has(key)) return _tintedAssetCache.get(key);
  const bitmap = await getAssetBitmap(assetId);
  if (!bitmap) return null;
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  if (color === "bg-transparent") {
    // luminance → alpha only; keep original RGB so the scanned 印影's
    // ink colour shines through.
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      d[i + 3] = Math.round(d[i + 3] * (1 - lum));
    }
  } else {
    const [tr, tg, tb] = parseHexColor(color);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      d[i + 3] = Math.round(d[i + 3] * (1 - lum));
      d[i] = tr;
      d[i + 1] = tg;
      d[i + 2] = tb;
    }
  }
  ctx.putImageData(img, 0, 0);
  _tintedAssetCache.set(key, canvas);
  return canvas;
}

/**
 * Draw stamp text centred on (cx, cy) with per-run fonts. Mirrors
 * `splitStampRuns` so 全角/半角 alternation lines up exactly between
 * the on-screen viewer and the exported canvas (no drift between
 * preview and rasterized output).
 */
/** 不動文字フィット rendering: distribute n tokens across a width-w
 *  band centred at (cx, cy). First token left-anchored, last right-
 *  anchored, middle ones at evenly-spaced midpoints. Tokens are the
 *  digits already split out of the rendered date string — separators
 *  are not drawn (matches preprinted「  年    月    日」forms). */
function drawSpacedTokensOnCanvas(ctx, tokens, cx, cy, width, fontSize, color, halfStack) {
  if (!tokens || tokens.length === 0) return;
  ctx.fillStyle = color;
  ctx.font = `bold ${fontSize}px ${halfStack}`;
  ctx.textBaseline = "middle";
  const left = cx - width / 2;
  const right = cx + width / 2;
  if (tokens.length === 1) {
    ctx.textAlign = "center";
    ctx.fillText(tokens[0], cx, cy);
    return;
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (i === 0) {
      ctx.textAlign = "left";
      ctx.fillText(tok, left, cy);
    } else if (i === tokens.length - 1) {
      ctx.textAlign = "right";
      ctx.fillText(tok, right, cy);
    } else {
      ctx.textAlign = "center";
      const tcx = left + (width * i) / (tokens.length - 1);
      ctx.fillText(tok, tcx, cy);
    }
  }
}

function drawStampMixedTextOnCanvas(ctx, text, cx, cy, fontSize, color, fullStack, halfStack) {
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

/** Wait until custom @font-face declarations (currently
 *  CrashNumberingSerif) are available to Canvas. document.fonts.ready
 *  resolves after every face declared on the page has either loaded
 *  or failed; for an early-export (e.g. first action after launch) we
 *  also explicitly request the family so the @font-face is triggered
 *  even if no DOM element used it yet. */
let _fontsReadyPromise = null;
async function ensureCustomFontsReady() {
  if (typeof document === "undefined") return; // node-side tests
  if (_fontsReadyPromise) return _fontsReadyPromise;
  _fontsReadyPromise = (async () => {
    try {
      // Force a load attempt — `document.fonts.ready` only awaits
      // already-pending loads, not fonts that haven't been requested yet.
      await document.fonts?.load?.('12px "CrashNumberingSerif"').catch(() => {});
      await document.fonts?.ready;
    } catch {
      // Best effort; fall back to the next font in the stack on failure.
    }
  })();
  return _fontsReadyPromise;
}

function parseHexColor(s) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(s ?? ""));
  if (!m) return [0, 0, 0];
  const v = m[1];
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

export const EXPORT_ZOOM = 600 / 72;

/**
 * @param {object} args
 * @param {Array<any>} args.pages              page rows from workspace.getPages()
 * @param {import("../domain/project-store.js").ProjectStore} args.projectStore
 * @param {(pageNo: number, opts: { zoom: number }) =>
 *           Promise<{ width:number, height:number, channels:3|4, pixels:Uint8ClampedArray | Uint8Array }>} args.renderPage
 *           normally `window.kpdf3.renderPage`
 * @param {(progress: { done: number, total: number }) => void} [args.onProgress]
 * @returns {Promise<Array<{ pageNo:number, png:Uint8Array, widthPt:number, heightPt:number }>>}
 */
export async function composePagesForExport({
  pages,
  projectStore,
  renderPage,
  renderSyntheticPage, // optional: (row, zoom) => {width,height,channels,pixels}
  onProgress,
}) {
  // Ensure custom @font-face faces (CrashNumberingSerif etc.) are loaded
  // before Canvas tries to use them — Canvas falls back to the next
  // font in the stack if the requested face isn't ready, which would
  // silently swap the date stamp's 半角 face on the very first export
  // after launch.
  await ensureCustomFontsReady();
  const out = [];
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    const row = pages[i];
    const canonical = canonicalPageSize({
      mediaX: 0, mediaY: 0, mediaW: 0, mediaH: 0,
      cropX: 0, cropY: 0,
      cropW: row.cropW, cropH: row.cropH,
      rotation: row.rotation,
      userRotation: row.userRotation ?? 0,
    });

    const overlayCount = projectStore.getPageOverlays(row.pageNo).length;
    const userRot = (((row.userRotation ?? 0) % 360) + 360) % 360;
    const sourceRot = (((row.rotation ?? 0) % 360) + 360) % 360;
    const effectiveRotation = ((sourceRot + userRot) % 360 + 360) % 360;
    const isSynthetic = row.isSynthetic || row.pageNo < 0;
    // Hybrid strategy:
    //   - synthetic page (no source) → "full" (rasterize the renderer-
    //     drawn synthetic content)
    //   - source PDF page with overlays → "overlay" (copy vector source +
    //     draw transparent overlay PNG on top)
    //   - source PDF page with no overlays → "source" (copy verbatim)
    //
    // β5+: rotated pages (userRotation or source /Rotate != 0) also take
    // the hybrid path. main-side assembler uses embedPage + drawPage to
    // place rotated vector content, so we keep crisp text on rotated pages
    // too (β4 fell back to full-rasterize which exploded file size).
    let strategy;
    if (isSynthetic) {
      strategy = "full"; // no source page to keep — rasterize everything
    } else if (overlayCount > 0) {
      strategy = "overlay"; // copy source vector + draw overlay PNG on top
    } else {
      strategy = "source"; // copy source page as-is, no render needed
    }

    /** @type {Uint8Array | undefined} */
    let imageBytes;
    if (strategy === "full") {
      let result;
      if (isSynthetic) {
        if (typeof renderSyntheticPage !== "function") {
          throw new Error("composePagesForExport: synthetic page encountered but no renderSyntheticPage provided");
        }
        result = await renderSyntheticPage(row, EXPORT_ZOOM);
      } else {
        result = await renderPage(row.pageNo, { zoom: EXPORT_ZOOM });
      }
      const canvas = await compositePage(row, result, projectStore, EXPORT_ZOOM);
      // Full-page images embed onto a fresh PDF page with no background —
      // we own every pixel, so JPEG (q=0.95) is the right encoding for
      // size. Vector text is preserved in the "source"/"overlay" paths.
      imageBytes = await canvasToJpeg(canvas, 0.95);
    } else if (strategy === "overlay") {
      const canvas = await composeOverlayOnlyPage(row, projectStore, EXPORT_ZOOM);
      // Overlay layer must be PNG to keep transparency — drawing on top of
      // the copied vector source page would otherwise paint white over it.
      imageBytes = await canvasToPng(canvas);
    }
    // strategy === "source": no image bytes; main copies source page as-is.

    out.push({
      pageNo: row.pageNo,
      widthPt: canonical.w,   // post-rotation canonical w/h (what user sees)
      heightPt: canonical.h,
      strategy,
      sourceIdx: isSynthetic ? null : (row.pageNo - 1),
      // userRotation lets the main side place the source page rotated.
      // pdf-lib's embedPage already bakes in the source's intrinsic
      // /Rotate, so only the *additional* user-applied rotation needs
      // to flow through drawPage. 0 = no extra rotation.
      userRotation: userRot,
      imageBytes,
    });
    if (onProgress) onProgress({ done: i + 1, total });
  }
  return out;
}

/**
 * Build an offscreen Canvas with the rendered page + overlays.
 *
 * @param {any} row
 * @param {{ width:number, height:number, channels:3|4, pixels:Uint8ClampedArray | Uint8Array }} renderResult
 * @param {import("../domain/project-store.js").ProjectStore} projectStore
 * @returns {HTMLCanvasElement}
 */
/**
 * Public single-page composer used by the print-preview UI.
 * Renders one page (PDF + overlays) and returns the canvas at `zoom`.
 *
 * @param {{pageNo:number, cropW:number, cropH:number, rotation:number, userRotation?:number}} pageRow
 * @param {(p:number,o:object)=>Promise<{width:number,height:number,channels:3|4,pixels:Uint8ClampedArray|Uint8Array}>} renderPage
 * @param {import("../domain/project-store.js").ProjectStore} projectStore
 * @param {number} zoom
 */
export async function composeSinglePageCanvas(pageRow, renderPage, projectStore, zoom, renderSyntheticPage) {
  await ensureCustomFontsReady();
  let result;
  if (pageRow.isSynthetic || pageRow.pageNo < 0) {
    if (typeof renderSyntheticPage !== "function") {
      throw new Error("composeSinglePageCanvas: synthetic page needs renderSyntheticPage");
    }
    result = await renderSyntheticPage(pageRow, zoom);
  } else {
    result = await renderPage(pageRow.pageNo, { zoom });
  }
  return await compositePage(pageRow, result, projectStore, zoom);
}

/**
 * Render JUST the overlays for a page onto a transparent canvas at the
 * canonical (post-userRotation) page dimensions. Used by the hybrid
 * export path so main can copy the source PDF page verbatim (preserving
 * vector text/lines) and then drop this transparent-bg image on top.
 *
 * Mirrors compositePage's overlay loop without painting the source PDF
 * bitmap underneath.
 *
 * @param {{cropW:number, cropH:number, rotation:number, userRotation?:number, pageNo:number}} row
 * @param {import("../domain/project-store.js").ProjectStore} projectStore
 * @param {number} zoom
 * @returns {HTMLCanvasElement}
 */
export async function composeOverlayOnlyPage(row, projectStore, zoom = EXPORT_ZOOM) {
  const userRot = (((row.userRotation ?? 0) % 360) + 360) % 360;
  const swap = userRot === 90 || userRot === 270;
  const w = swap ? row.cropH : row.cropW;
  const h = swap ? row.cropW : row.cropH;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * zoom);
  canvas.height = Math.round(h * zoom);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("composeOverlayOnlyPage: 2d context unavailable");
  // ctx is transparent by default — exactly what we want.
  const overlays = projectStore.getPageOverlays(row.pageNo);
  for (const ov of overlays) {
    await drawOverlay(ctx, ov, zoom);
  }
  return canvas;
}

export async function compositePage(row, renderResult, projectStore, zoom = EXPORT_ZOOM) {
  // mupdf returns the PDF at intrinsic /Rotate dims only — userRotation
  // is applied here so thumbs / export both match the rotated viewer.
  const userRot = (((row.userRotation ?? 0) % 360) + 360) % 360;
  const swap = userRot === 90 || userRot === 270;

  const canvas = document.createElement("canvas");
  canvas.width = swap ? renderResult.height : renderResult.width;
  canvas.height = swap ? renderResult.width : renderResult.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("compositePage: 2d context unavailable");

  // PDF page itself — bounce through an offscreen canvas when rotation
  // is non-zero (putImageData ignores ctx transforms).
  const pixels =
    renderResult.pixels instanceof Uint8ClampedArray
      ? renderResult.pixels
      : new Uint8ClampedArray(renderResult.pixels.buffer ?? renderResult.pixels);
  let imageData;
  if (renderResult.channels === 4) {
    imageData = new ImageData(pixels, renderResult.width, renderResult.height);
  } else {
    const rgba = new Uint8ClampedArray(renderResult.width * renderResult.height * 4);
    for (let p = 0, q = 0; p < pixels.length; p += 3, q += 4) {
      rgba[q] = pixels[p];
      rgba[q + 1] = pixels[p + 1];
      rgba[q + 2] = pixels[p + 2];
      rgba[q + 3] = 255;
    }
    imageData = new ImageData(rgba, renderResult.width, renderResult.height);
  }
  if (userRot === 0) {
    ctx.putImageData(imageData, 0, 0);
  } else {
    const tmp = document.createElement("canvas");
    tmp.width = renderResult.width;
    tmp.height = renderResult.height;
    tmp.getContext("2d").putImageData(imageData, 0, 0);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((userRot * Math.PI) / 180);
    ctx.drawImage(tmp, -renderResult.width / 2, -renderResult.height / 2);
    ctx.restore();
  }

  // Overlays in zOrder. ov.x / ov.y are already in the post-userRotation
  // canonical frame, so drawing on the rotated canvas at (x*zoom, y*zoom)
  // lands them where the user expects.
  const overlays = projectStore.getPageOverlays(row.pageNo);
  for (const ov of overlays) {
    await drawOverlay(ctx, ov, zoom);
  }

  return canvas;
}

/**
 * Paint a single overlay onto the export canvas.
 *
 * For text we use Canvas 2D fillText with a generic CJK-friendly fallback
 * stack. For text-frame stamps we also stroke the configured frame.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {import("../domain/project-store.js").Overlay} ov
 * @param {number} zoom    canonical → pixel scale
 */
async function drawOverlay(ctx, ov, zoom) {
  const x = ov.x * zoom;
  const y = ov.y * zoom;
  const w = ov.w * zoom;
  const h = ov.h * zoom;
  const props = ov.properties ?? {};

  if (ov.type === "text") {
    const fontSize = (props.fontSize ?? 12) * zoom;
    const color = props.color ?? "#000000";
    ctx.fillStyle = color;
    ctx.font = `${fontSize}px ${getTextFontStack(props.fontId)}`;
    ctx.textBaseline = "top";
    // β15 testers reported the rasterised text overlay prints lighter /
    // thinner than expected. Canvas 2D fillText anti-aliases glyph
    // edges to subpixel alpha, which a printer reproduces as light
    // gray; the dark glyph core is surrounded by gray fringes, giving
    // the overall "黒が薄い" impression. Overstroking the same glyph
    // with a thin line at the same colour blackens those fringes
    // without changing the font weight — gives the printed output
    // the saturation of a real "black" ink fill while preserving the
    // glyph's original shape. Stroke width is 3% of the rendered
    // glyph height; at 600 dpi for a 12pt font that's ≈3 px, just
    // enough to plug the AA fringe.
    ctx.strokeStyle = color;
    ctx.lineWidth = fontSize * 0.03;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const text = props.text ?? "";
    const lineHeight = fontSize * (props.lineHeight ?? 1);
    const rot = (((props.rotation ?? 0) % 360) + 360) % 360;
    const paintLine = (line, px, py) => {
      ctx.strokeText(line, px, py);
      ctx.fillText(line, px, py);
    };
    if (rot === 0) {
      const lines = wrapCanvasText(ctx, text, w);
      for (let i = 0; i < lines.length; i++) {
        paintLine(lines[i], x, y + i * lineHeight);
      }
    } else {
      // Match the viewer's "rotate the content within the new rect"
      // behaviour: wrap to the PRE-rotation width and paint inside a
      // rotated transform anchored at the new-rect center.
      const isVert = rot === 90 || rot === 270;
      const naturalW = isVert ? h : w;
      const naturalH = isVert ? w : h;
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((rot * Math.PI) / 180);
      const lines = wrapCanvasText(ctx, text, naturalW);
      for (let i = 0; i < lines.length; i++) {
        paintLine(lines[i], -naturalW / 2, -naturalH / 2 + i * lineHeight);
      }
      ctx.restore();
    }
    return;
  }

  if (ov.type === "stamp" && props.kind === "image" && props.assetId) {
    // Image stamp — fetch the asset blob and drawImage. Cached so
    // multiple stamps using the same asset don't re-fetch. Apply
    // userRotation around the box center (paper metaphor). When
    // props.color is set we draw the tinted variant (luminance →
    // alpha + RGB ← color); empty color = image as-is.
    try {
      const tinted = props.color
        ? await getTintedAssetCanvas(props.assetId, props.color)
        : null;
      const src = tinted || (await getAssetBitmap(props.assetId));
      if (src) {
        const rot = (((props.rotation ?? 0) % 360) + 360) % 360;
        if (rot === 0) {
          ctx.drawImage(src, x, y, w, h);
        } else {
          ctx.save();
          ctx.translate(x + w / 2, y + h / 2);
          ctx.rotate((rot * Math.PI) / 180);
          ctx.drawImage(src, -w / 2, -h / 2, w, h);
          ctx.restore();
        }
      }
    } catch (err) {
      console.error("[export] image stamp draw failed", err);
    }
    return;
  }

  if (ov.type === "stamp") {
    const color = props.color ?? "#cc0000";
    const fontSize = (props.fontSize ?? 14) * zoom;
    const frame = props.frame ?? "circle";
    ctx.lineWidth = Math.max(2 * zoom * 0.5, 1.5);
    ctx.strokeStyle = color;
    if (frame === "circle") {
      ctx.beginPath();
      ctx.ellipse(
        x + w / 2,
        y + h / 2,
        Math.max(w / 2 - 1, 1),
        Math.max(h / 2 - 1, 1),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    } else if (frame === "rect") {
      ctx.strokeRect(x + 1, y + 1, Math.max(w - 2, 1), Math.max(h - 2, 1));
    }
    // Per-run fonts (ADR-0019 後半): full-width chars in the user's
    // 全角 stack, half-width in the 半角 stack. Measure runs first so
    // we can place the whole string centred, then draw left-to-right.
    const { full, half } = getStampFontDefaults();
    const fullStack = getStampFontStack(full);
    const halfStack = getStampFontStack(half);
    const rot = (((props.rotation ?? 0) % 360) + 360) % 360;
    // 不動文字フィット: 3 numbers distributed across the box width;
    // separator characters from the source format are dropped.
    if (props.spacingMode === "distribute-3") {
      const tokens = String(props.text ?? "").split(/\s+/).filter(Boolean);
      const drawSpaced = (cx, cy) => {
        drawSpacedTokensOnCanvas(ctx, tokens, cx, cy, w, fontSize, color, halfStack);
      };
      if (rot === 0) drawSpaced(x + w / 2, y + h / 2);
      else {
        ctx.save();
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate((rot * Math.PI) / 180);
        drawSpaced(0, 0);
        ctx.restore();
      }
      ctx.textAlign = "start";
      return;
    }
    const drawAt = (cx, cy) => {
      drawStampMixedTextOnCanvas(
        ctx, props.text ?? "", cx, cy, fontSize, color, fullStack, halfStack,
      );
    };
    if (rot === 0) {
      drawAt(x + w / 2, y + h / 2);
    } else {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((rot * Math.PI) / 180);
      drawAt(0, 0);
      ctx.restore();
    }
    ctx.textAlign = "start";
    return;
  }

  if (ov.type === "redaction") {
    // True redaction: paint a fully opaque rectangle (default black).
    // The page is already rasterised at this point, so the underlying
    // text layer is gone; this rectangle then covers the matching pixels.
    const fill = props.color === "white" ? "#ffffff" : "#000000";
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    return;
  }

  if (ov.type === "rect" && props.kind === "callout") {
    // Callout: white-fill box + outline + arrow line + text inside.
    const color = props.color ?? "#000000";
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = Math.max(1.5 * zoom * 0.5, 1);
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);
    // Arrow: arrowDx/Dy are relative to BOX TOP-LEFT (matches viewer).
    const arrowDx = (props.arrowDx ?? -30) * zoom;
    const arrowDy = (props.arrowDy ?? ov.h + 25) * zoom;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const tipX = x + arrowDx;
    const tipY = y + arrowDy;
    let edgeX = cx, edgeY = cy;
    const dx = tipX - cx, dy = tipY - cy;
    if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
      const tx = dx === 0 ? Infinity : (dx > 0 ? (w / 2) / dx : (-w / 2) / dx);
      const ty = dy === 0 ? Infinity : (dy > 0 ? (h / 2) / dy : (-h / 2) / dy);
      const t = Math.min(tx, ty);
      edgeX = cx + dx * t;
      edgeY = cy + dy * t;
    }
    ctx.beginPath();
    ctx.moveTo(edgeX, edgeY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    // Filled triangular arrowhead at the tip, oriented along the line.
    const ah = 6 * zoom;
    const angle = Math.atan2(tipY - edgeY, tipX - edgeX);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - ah * Math.cos(angle - Math.PI / 6),
      tipY - ah * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      tipX - ah * Math.cos(angle + Math.PI / 6),
      tipY - ah * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    // Text inside the box.
    const fontSize = (props.fontSize ?? 12) * zoom;
    ctx.fillStyle = color;
    ctx.font = `${fontSize}px ${getTextFontStack(props.fontId)}`;
    ctx.textBaseline = "top";
    const text = props.text ?? "";
    const padding = 3 * zoom;
    const lineHeight = fontSize * (props.lineHeight ?? 1);
    const lines = wrapCanvasText(ctx, text, w - padding * 2);
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x + padding, y + padding + i * lineHeight);
    }
    return;
  }

  if (ov.type === "line" && (props.kind ?? "marker") === "marker") {
    // Highlighter marker — semi-transparent fill so the underlying
    // text remains readable through the marker color.
    const color = props.color ?? "#ffeb3b";
    const opacity = typeof props.opacity === "number" ? props.opacity : 0.3;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    return;
  }

  // Other types render as a stroked rect placeholder.
  ctx.strokeStyle = "#888";
  ctx.strokeRect(x, y, w, h);
}

/**
 * Character-by-character word wrap that matches the viewer's
 * `white-space: pre-wrap` behaviour for CJK text. Hard-breaks at \n,
 * otherwise greedily fits as many code points as possible per line up
 * to maxWidth (in CSS px). Caller is responsible for setting ctx.font
 * before invoking.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth   px
 * @returns {string[]}
 */
function wrapCanvasText(ctx, text, maxWidth) {
  const out = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const ch of para) {
      const candidate = line + ch;
      const width = ctx.measureText(candidate).width;
      if (line.length > 0 && width > maxWidth) {
        out.push(line);
        line = ch;
      } else {
        line = candidate;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

/**
 * Encode the composed page canvas as PNG. Used for the overlay-only
 * layer (transparent background) in the hybrid pipeline — JPEG can't
 * carry alpha, and we need the source PDF page to show through where
 * the overlay layer is empty.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Uint8Array>}
 */
function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error("canvasToPng: toBlob returned null"));
          return;
        }
        const buf = await blob.arrayBuffer();
        resolve(new Uint8Array(buf));
      },
      "image/png",
    );
  });
}

/**
 * Encode the composed page canvas as JPEG at the given quality. Used for
 * full-page rasterized fallbacks (synthetic / rotated pages where the
 * hybrid path can't preserve vectors). JPEG keeps these single-image
 * pages small while remaining visually acceptable; the truly-quality-
 * critical pages go through the overlay-only path which preserves
 * source-PDF vectors.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} quality 0..1
 * @returns {Promise<Uint8Array>}
 */
function canvasToJpeg(canvas, quality = 0.95) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error("canvasToJpeg: toBlob returned null"));
          return;
        }
        const buf = await blob.arrayBuffer();
        resolve(new Uint8Array(buf));
      },
      "image/jpeg",
      quality,
    );
  });
}
