// Extract page metrics from a PDF using mupdf.js.
//
// Used during workspace import:
//   1. Load source PDF bytes via mupdf
//   2. Iterate pages → collect mediabox / cropbox / rotation
//   3. Return as a list to be persisted into SQLite `pages` table.

import * as mupdf from "mupdf";

/**
 * @typedef {object} PageMetrics
 * @property {number} pageNo            1-based
 * @property {number} mediaX
 * @property {number} mediaY
 * @property {number} mediaW
 * @property {number} mediaH
 * @property {number} cropX
 * @property {number} cropY
 * @property {number} cropW
 * @property {number} cropH
 * @property {0|90|180|270} rotation    PDF native rotation
 */

/**
 * @typedef {object} PdfInfo
 * @property {number} pageCount
 * @property {PageMetrics[]} pages
 */

/**
 * Open a PDF (from bytes) with mupdf and extract per-page metrics.
 * Caller must keep `data` alive for the duration of this call.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} data
 * @returns {PdfInfo}
 */
export function extractPdfInfo(data) {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const doc = mupdf.Document.openDocument(buf, "application/pdf");
  try {
    const pageCount = doc.countPages();
    const pages = [];
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const pageDict = typeof page.getObject === "function" ? page.getObject() : null;

        // Read /MediaBox from the page dictionary itself (or inherited from parent).
        // This is the PDF native, rotation-agnostic rectangle.
        const mediaBox = readPageRectInherited(pageDict, "MediaBox") ?? [0, 0, 612, 792];
        // /CropBox falls back to /MediaBox per PDF spec.
        const cropBox = readPageRectInherited(pageDict, "CropBox") ?? mediaBox;
        const [mx0, my0, mx1, my1] = mediaBox;
        const [cx0, cy0, cx1, cy1] = cropBox;

        // /Rotate may be inherited from parent /Pages too.
        let rotation = readPageNumberInherited(pageDict, "Rotate") ?? 0;
        rotation = ((rotation % 360) + 360) % 360;
        if (![0, 90, 180, 270].includes(rotation)) rotation = 0;

        pages.push({
          pageNo: i + 1,
          mediaX: mx0,
          mediaY: my0,
          mediaW: mx1 - mx0,
          mediaH: my1 - my0,
          cropX: cx0,
          cropY: cy0,
          cropW: cx1 - cx0,
          cropH: cy1 - cy0,
          rotation,
        });
      } finally {
        page.destroy();
      }
    }
    return { pageCount, pages };
  } finally {
    doc.destroy();
  }
}

/**
 * Read a numeric value from a PDF page dictionary, walking up /Parent
 * if the value is inheritable (PDF spec: /MediaBox, /CropBox, /Rotate, /Resources).
 *
 * @param {any} dict     PDFObject for /Type /Page (or /Pages while walking up)
 * @param {string} key
 * @returns {number | null}
 */
function readPageNumberInherited(dict, key) {
  let cur = dict;
  let safety = 16;
  while (cur && safety-- > 0) {
    try {
      const v = cur.get(key);
      if (v && !v.isNull()) {
        return v.asNumber();
      }
      const parent = cur.get("Parent");
      cur = parent && !parent.isNull() ? parent : null;
    } catch {
      cur = null;
    }
  }
  return null;
}

/**
 * Read a PDF rectangle ([x0, y0, x1, y1]) from a page dictionary,
 * walking up /Parent for inheritable boxes.
 *
 * @param {any} dict
 * @param {string} key
 * @returns {[number, number, number, number] | null}
 */
function readPageRectInherited(dict, key) {
  let cur = dict;
  let safety = 16;
  while (cur && safety-- > 0) {
    try {
      const arr = cur.get(key);
      if (arr && !arr.isNull() && arr.isArray() && arr.length === 4) {
        return [
          arr.get(0).asNumber(),
          arr.get(1).asNumber(),
          arr.get(2).asNumber(),
          arr.get(3).asNumber(),
        ];
      }
      const parent = cur.get("Parent");
      cur = parent && !parent.isNull() ? parent : null;
    } catch {
      cur = null;
    }
  }
  return null;
}

/**
 * Compute a content fingerprint of a PDF byte buffer using SHA-256.
 *
 * @param {Buffer | Uint8Array} data
 * @returns {Promise<string>}  hex string
 */
export async function computePdfFingerprint(data) {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  hash.update(data);
  return hash.digest("hex");
}

/**
 * @typedef {object} OutlineNode
 * @property {string} title
 * @property {number | null} pageNo   1-based, null if the entry doesn't link to a page
 * @property {OutlineNode[]} children
 */

/**
 * Extract the PDF /Outlines hierarchy as a clean tree (1-based pageNo,
 * recursive children, no mupdf-specific shape).
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} data
 * @returns {OutlineNode[]}
 */
export function extractOutline(data) {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const doc = mupdf.Document.openDocument(buf, "application/pdf");
  try {
    const items = doc.loadOutline();
    return convertOutline(items);
  } finally {
    doc.destroy();
  }
}

function convertOutline(items) {
  if (!items || !Array.isArray(items)) return [];
  return items.map((item) => ({
    title: item.title ?? "",
    // mupdf uses 0-based page indices; we surface 1-based to the renderer.
    pageNo: typeof item.page === "number" ? item.page + 1 : null,
    children: convertOutline(item.down),
  }));
}
