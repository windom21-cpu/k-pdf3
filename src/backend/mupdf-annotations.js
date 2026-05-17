// Extract PDF annotations from a PDF (read-only).
//
// Used by main process to surface external annotations (Adobe sticky notes,
// highlights, stamps, …) as a read-only visual proxy in the viewer.
//
// Annotations are NOT converted to editable overlay objects (§2.4 禁止事項).
// They're surfaced with rect (PDF native coords) + type + contents only.
// Renderer translates PDF native → canonical via domain/coord.js.

import * as mupdf from "mupdf";

/**
 * @typedef {object} AnnotationRecord
 * @property {string} id              stable per-page (page idx + annot idx)
 * @property {number} pageNo          1-based
 * @property {string} type            mupdf PDFAnnotationType (Text/Highlight/...)
 * @property {[number, number, number, number]} rect   PDF native [x0, y0, x1, y1]
 * @property {string} contents        annotation /Contents (may be empty)
 * @property {string} author          annotation /T (may be empty)
 * @property {[number, number, number, number][]} [quads]   For Highlight/Underline/Squiggly/StrikeOut
 * @property {[number, number, number][]} [inkLines]        For Ink: bbox of each stroke (rect-summarised)
 * @property {[number, number, number, number]|null} color  RGB 0..1, null if none
 */

// Types we surface as a read-only proxy. Excludes form widgets, navigation
// links, multimedia and infrastructure annotations.
const PROXIED_TYPES = new Set([
  "Text",
  "FreeText",
  "Stamp",
  "Highlight",
  "Underline",
  "Squiggly",
  "StrikeOut",
  "Ink",
  "Line",
  "Square",
  "Circle",
  "Polygon",
  "PolyLine",
  "Caret",
  "FileAttachment",
  "Redact",
]);

/**
 * Extract annotations from every page in a PDF.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} data
 * @returns {Map<number, AnnotationRecord[]>}  pageNo (1-based) → annotations
 */
export function extractAllAnnotations(data) {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const doc = mupdf.Document.openDocument(buf, "application/pdf");
  const result = new Map();
  try {
    const pageCount = doc.countPages();
    for (let i = 0; i < pageCount; i++) {
      const pageNo = i + 1;
      const annots = extractPageAnnotationsFromDoc(doc, i);
      if (annots.length > 0) result.set(pageNo, annots);
    }
  } finally {
    doc.destroy();
  }
  return result;
}

/**
 * Extract annotations from a single page using an already-open document.
 * Caller owns the doc.
 *
 * @param {mupdf.PDFDocument | mupdf.Document} doc
 * @param {number} pageIdx 0-based
 * @returns {AnnotationRecord[]}
 */
export function extractPageAnnotationsFromDoc(doc, pageIdx) {
  const pageNo = pageIdx + 1;
  const out = [];
  const page = doc.loadPage(pageIdx);
  try {
    const annots = typeof page.getAnnotations === "function" ? page.getAnnotations() : null;
    if (!annots) return out;
    for (let j = 0; j < annots.length; j++) {
      const a = annots[j];
      try {
        const type = safeString(() => a.getType());
        if (!type || !PROXIED_TYPES.has(type)) continue;
        const rect = safeArray4(() => a.getRect());
        if (!rect) continue;
        const contents = safeString(() => a.getContents()) ?? "";
        const author = safeString(() => a.getAuthor()) ?? "";
        const color = safeColor(() => a.getColor());
        const rec = {
          id: `p${pageNo}.a${j}`,
          pageNo,
          type,
          rect,
          contents,
          author,
          color,
        };
        // Quad-based types: surface quads (PDF native) so renderer can draw
        // per-quad highlights instead of one big bounding rect.
        if (
          (type === "Highlight" ||
            type === "Underline" ||
            type === "Squiggly" ||
            type === "StrikeOut") &&
          safeBool(() => a.hasQuadPoints?.() ?? false)
        ) {
          rec.quads = safeQuads(() => a.getQuadPoints?.() ?? []);
        }
        // Ink: surface per-stroke bboxes for rough proxy drawing.
        if (type === "Ink" && safeBool(() => a.hasInkList?.() ?? false)) {
          rec.inkLines = safeInkStrokes(() => a.getInkList?.() ?? []);
        }
        out.push(rec);
      } catch (err) {
        // Skip malformed annotations rather than failing the whole page.
        // Adobe-produced PDFs occasionally have annotations with stale appearance
        // streams; we still want to surface the rest.
        // eslint-disable-next-line no-console
        console.warn(`[mupdf-annotations] skip annot p${pageNo} #${j}:`, err?.message ?? err);
      }
    }
  } finally {
    page.destroy?.();
  }
  return out;
}

function safeString(fn) {
  try {
    const v = fn();
    return typeof v === "string" ? v : v == null ? "" : String(v);
  } catch {
    return "";
  }
}

function safeBool(fn) {
  try {
    return !!fn();
  } catch {
    return false;
  }
}

function safeArray4(fn) {
  try {
    const r = fn();
    if (!r) return null;
    // Rect is { x0, y0, x1, y1 } in mupdf.js (object form).
    if (typeof r === "object" && "x0" in r) {
      const { x0, y0, x1, y1 } = r;
      if ([x0, y0, x1, y1].every((n) => typeof n === "number" && Number.isFinite(n))) {
        return [x0, y0, x1, y1];
      }
    }
    if (Array.isArray(r) && r.length === 4 && r.every((n) => Number.isFinite(n))) {
      return [r[0], r[1], r[2], r[3]];
    }
    return null;
  } catch {
    return null;
  }
}

function safeColor(fn) {
  try {
    const c = fn();
    if (!Array.isArray(c) || c.length < 3) return null;
    const [r, g, b, a = 1] = c;
    if (![r, g, b].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return [r, g, b, a];
  } catch {
    return null;
  }
}

function safeQuads(fn) {
  try {
    const quads = fn();
    if (!Array.isArray(quads)) return undefined;
    const out = [];
    for (const q of quads) {
      // Quad in mupdf.js: { ul:{x,y}, ur:{x,y}, ll:{x,y}, lr:{x,y} }
      // or possibly 8-number array. Summarise to bbox [x0,y0,x1,y1] (PDF native).
      let xs = [], ys = [];
      if (q && typeof q === "object" && "ul" in q) {
        for (const k of ["ul", "ur", "ll", "lr"]) {
          const p = q[k];
          if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
            xs.push(p.x);
            ys.push(p.y);
          }
        }
      } else if (Array.isArray(q) && q.length === 8) {
        for (let k = 0; k < 8; k += 2) {
          xs.push(q[k]);
          ys.push(q[k + 1]);
        }
      }
      if (xs.length >= 2 && ys.length >= 2) {
        out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

function safeInkStrokes(fn) {
  try {
    const strokes = fn();
    if (!Array.isArray(strokes)) return undefined;
    const out = [];
    for (const stroke of strokes) {
      if (!Array.isArray(stroke) || stroke.length === 0) continue;
      const xs = [], ys = [];
      for (const p of stroke) {
        // mupdf.Point = [x, y] (array). Object {x, y} form also accepted defensively.
        let px, py;
        if (Array.isArray(p) && p.length >= 2) {
          px = p[0]; py = p[1];
        } else if (p && typeof p === "object") {
          px = p.x; py = p.y;
        }
        if (Number.isFinite(px) && Number.isFinite(py)) {
          xs.push(px);
          ys.push(py);
        }
      }
      if (xs.length >= 1 && ys.length >= 1) {
        out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}
