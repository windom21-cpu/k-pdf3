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
// EXPORT_ZOOM is set to 2.0 — a 144-dpi-equivalent render that gives
// readable output for legal-practice reading without ballooning file size
// the way a 300-dpi render would. M5 polish will let the user pick.

import { canonicalPageSize } from "../domain/coord.js";
import { getTextFontStack } from "./fonts.js";

export const EXPORT_ZOOM = 2.0;

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
  const out = [];
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    const row = pages[i];
    let result;
    if (row.isSynthetic || row.pageNo < 0) {
      if (typeof renderSyntheticPage !== "function") {
        throw new Error("composePagesForExport: synthetic page encountered but no renderSyntheticPage provided");
      }
      result = renderSyntheticPage(row, EXPORT_ZOOM);
    } else {
      result = await renderPage(row.pageNo, { zoom: EXPORT_ZOOM });
    }
    const canvas = compositePage(row, result, projectStore, EXPORT_ZOOM);
    const png = await canvasToPng(canvas);
    const canonical = canonicalPageSize({
      mediaX: 0, mediaY: 0, mediaW: 0, mediaH: 0,
      cropX: 0, cropY: 0,
      cropW: row.cropW, cropH: row.cropH,
      rotation: row.rotation,
      userRotation: row.userRotation ?? 0,
    });
    out.push({
      pageNo: row.pageNo,
      png,
      widthPt: canonical.w,
      heightPt: canonical.h,
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
  let result;
  if (pageRow.isSynthetic || pageRow.pageNo < 0) {
    if (typeof renderSyntheticPage !== "function") {
      throw new Error("composeSinglePageCanvas: synthetic page needs renderSyntheticPage");
    }
    result = renderSyntheticPage(pageRow, zoom);
  } else {
    result = await renderPage(pageRow.pageNo, { zoom });
  }
  return compositePage(pageRow, result, projectStore, zoom);
}

export function compositePage(row, renderResult, projectStore, zoom = EXPORT_ZOOM) {
  const canvas = document.createElement("canvas");
  canvas.width = renderResult.width;
  canvas.height = renderResult.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("compositePage: 2d context unavailable");

  // PDF page itself.
  const pixels =
    renderResult.pixels instanceof Uint8ClampedArray
      ? renderResult.pixels
      : new Uint8ClampedArray(renderResult.pixels.buffer ?? renderResult.pixels);
  if (renderResult.channels === 4) {
    const imageData = new ImageData(pixels, renderResult.width, renderResult.height);
    ctx.putImageData(imageData, 0, 0);
  } else {
    // RGB → RGBA upgrade
    const rgba = new Uint8ClampedArray(renderResult.width * renderResult.height * 4);
    for (let p = 0, q = 0; p < pixels.length; p += 3, q += 4) {
      rgba[q] = pixels[p];
      rgba[q + 1] = pixels[p + 1];
      rgba[q + 2] = pixels[p + 2];
      rgba[q + 3] = 255;
    }
    ctx.putImageData(new ImageData(rgba, renderResult.width, renderResult.height), 0, 0);
  }

  // Overlays in zOrder.
  const overlays = projectStore.getPageOverlays(row.pageNo);
  for (const ov of overlays) {
    drawOverlay(ctx, ov, zoom);
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
function drawOverlay(ctx, ov, zoom) {
  const x = ov.x * zoom;
  const y = ov.y * zoom;
  const w = ov.w * zoom;
  const h = ov.h * zoom;
  const props = ov.properties ?? {};

  if (ov.type === "text") {
    const fontSize = (props.fontSize ?? 12) * zoom;
    ctx.fillStyle = props.color ?? "#000000";
    ctx.font = `${fontSize}px ${getTextFontStack(props.fontId)}`;
    ctx.textBaseline = "top";
    // Match the viewer's white-space: pre-wrap behaviour so a long line
    // doesn't escape the overlay's bbox in the export.
    const lineHeight = fontSize * (props.lineHeight ?? 1);
    const lines = wrapCanvasText(ctx, props.text ?? "", w);
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, y + i * lineHeight);
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
    ctx.fillStyle = color;
    ctx.font = `bold ${fontSize}px "MS UI Gothic", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(props.text ?? "", x + w / 2, y + h / 2);
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

  if (ov.type === "line" && (props.kind ?? "marker") === "marker") {
    // Highlighter marker — semi-transparent fill so the underlying
    // text remains readable through the marker color.
    const color = props.color ?? "#ffeb3b";
    const opacity = typeof props.opacity === "number" ? props.opacity : 0.5;
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
