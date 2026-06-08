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
 * Detect whether a PDF is encrypted *at all* — either it needs a password to
 * open (user password set) OR it carries an /Encrypt dict (permission-only /
 * owner-password / empty-user-password). This is intentionally broader than
 * "needs a password": some encrypted PDFs let mupdf read the page tree (so
 * countPages / MediaBox succeed) yet fail to decode the content streams,
 * rendering blank. Treating any /Encrypt PDF as "decrypt at import" (via qpdf)
 * guarantees the stored source is plaintext and renders correctly.
 *
 * Non-throwing: if openDocument throws (corrupt / non-PDF) we return false so
 * the normal import path surfaces the real error instead of masking it.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} data
 * @returns {boolean}
 */
export function pdfIsEncrypted(data) {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  let doc = null;
  try {
    doc = mupdf.Document.openDocument(buf, "application/pdf");
  } catch {
    return false;
  }
  try {
    try { if (doc.needsPassword()) return true; } catch { /* ignore */ }
    const pdfDoc = typeof doc.asPDF === "function" ? doc.asPDF() : null;
    if (pdfDoc) {
      try {
        const trailer = pdfDoc.getTrailer();
        const enc = trailer && trailer.get("Encrypt");
        if (enc && !enc.isNull()) return true;
      } catch { /* ignore */ }
    }
    return false;
  } finally {
    try { doc.destroy(); } catch { /* ignore */ }
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

/**
 * @typedef {object} PdfPropertiesFont
 * @property {string} baseFont      e.g. "MS-Gothic" or "ABCDEF+TimesNewRoman"
 * @property {string} subtype       e.g. "Type1" / "TrueType" / "CIDFontType0" / "CIDFontType2" / "Type0"
 * @property {boolean} embedded     true if FontFile / FontFile2 / FontFile3 present
 * @property {boolean} subset       true if BaseFont has the XXXXXX+ prefix
 * @property {string} encoding      Encoding name (or "" if not a name object)
 */
/**
 * @typedef {object} PdfPropertiesPageSize
 * @property {number} widthPt
 * @property {number} heightPt
 * @property {number} count          number of pages with this size
 */
/**
 * @typedef {object} PdfProperties
 * @property {Record<string, string>} metadata       info: Title/Author/Subject/Keywords/Creator/Producer/CreationDate/ModDate
 * @property {number} pdfVersion                      e.g. 1.7
 * @property {number} pageCount
 * @property {PdfPropertiesPageSize[]} pageSizes      grouped by (widthPt, heightPt), descending count
 * @property {boolean} encrypted
 * @property {PdfPropertiesFont[]} fonts              unique by baseFont + subtype + embedded
 */

const META_KEYS = [
  "Title",
  "Author",
  "Subject",
  "Keywords",
  "Creator",
  "Producer",
  "CreationDate",
  "ModDate",
];

/**
 * Extract the "document properties" of a PDF (Adobe Acrobat 流の一覧用)。
 * メタデータ + PDF バージョン + ページサイズ集計 + 暗号化 + フォント一覧。
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} data
 * @returns {PdfProperties}
 */
export function extractPdfProperties(data) {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const doc = mupdf.Document.openDocument(buf, "application/pdf");
  try {
    /** @type {Record<string, string>} */
    const metadata = {};
    for (const key of META_KEYS) {
      try {
        const v = doc.getMetaData(`info:${key}`);
        if (typeof v === "string" && v.length > 0) metadata[key] = v;
      } catch { /* ignore */ }
    }

    const pdfDoc = typeof doc.asPDF === "function" ? doc.asPDF() : null;
    const pdfVersion = pdfDoc && typeof pdfDoc.getVersion === "function"
      ? pdfDoc.getVersion() / 10
      : 0;

    const pageCount = doc.countPages();

    /** @type {Map<string, PdfPropertiesPageSize>} */
    const sizeMap = new Map();
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const b = page.getBounds();
        const w = Math.round((b[2] - b[0]) * 10) / 10;
        const h = Math.round((b[3] - b[1]) * 10) / 10;
        const key = `${w}x${h}`;
        const existing = sizeMap.get(key);
        if (existing) existing.count += 1;
        else sizeMap.set(key, { widthPt: w, heightPt: h, count: 1 });
      } finally {
        page.destroy();
      }
    }
    const pageSizes = [...sizeMap.values()].sort((a, b) => b.count - a.count);

    let encrypted = false;
    try {
      encrypted = doc.needsPassword();
    } catch { /* ignore */ }
    if (!encrypted && pdfDoc) {
      // PDF にパスワードはないが /Encrypt dict はあるケース (権限制限のみ)
      try {
        const trailer = pdfDoc.getTrailer();
        const enc = trailer && trailer.get("Encrypt");
        if (enc && !enc.isNull()) encrypted = true;
      } catch { /* ignore */ }
    }

    /** @type {PdfPropertiesFont[]} */
    const fonts = pdfDoc ? collectFonts(pdfDoc, pageCount) : [];

    return { metadata, pdfVersion, pageCount, pageSizes, encrypted, fonts };
  } finally {
    doc.destroy();
  }
}

/**
 * 全ページの /Resources/Font を巡回してユニークなフォント一覧を作る。
 * Type0 (CID) の場合は /DescendantFonts[0] の埋め込み状況を見る。
 *
 * @param {any} pdfDoc                 mupdf PDFDocument
 * @param {number} pageCount
 * @returns {PdfPropertiesFont[]}
 */
function collectFonts(pdfDoc, pageCount) {
  /** @type {Map<string, PdfPropertiesFont>} */
  const fontMap = new Map();
  for (let i = 0; i < pageCount; i++) {
    let page = null;
    try {
      page = pdfDoc.loadPage(i);
      const pageDict = typeof page.getObject === "function" ? page.getObject() : null;
      if (!pageDict) continue;
      const resources = readResourcesInherited(pageDict);
      if (!resources) continue;
      const fontDict = resources.get("Font");
      if (!fontDict || fontDict.isNull() || !fontDict.isDictionary()) continue;
      fontDict.forEach((fontObj) => {
        try {
          const resolved = fontObj.resolve();
          if (!resolved || !resolved.isDictionary()) return;
          const info = describeFont(resolved);
          if (!info) return;
          const key = `${info.baseFont}|${info.subtype}|${info.encoding}|${info.embedded ? 1 : 0}`;
          if (!fontMap.has(key)) fontMap.set(key, info);
        } catch { /* ignore individual font errors */ }
      });
    } catch { /* ignore page errors */ } finally {
      if (page && typeof page.destroy === "function") {
        try { page.destroy(); } catch { /* ignore */ }
      }
    }
  }
  return [...fontMap.values()].sort((a, b) => a.baseFont.localeCompare(b.baseFont));
}

/**
 * Walk a font dict (PDF Font Resource) and surface BaseFont / Subtype /
 * embedded / subset / encoding.
 *
 * @param {any} fontDict
 * @returns {PdfPropertiesFont | null}
 */
function describeFont(fontDict) {
  const subtype = readName(fontDict.get("Subtype")) ?? "";
  let baseFont = readName(fontDict.get("BaseFont")) ?? readName(fontDict.get("Name")) ?? "";
  const encoding = readName(fontDict.get("Encoding")) ?? "";

  // Type0 composite font: data lives on /DescendantFonts[0]
  let descriptorOwner = fontDict;
  if (subtype === "Type0") {
    try {
      const desc = fontDict.get("DescendantFonts");
      if (desc && desc.isArray() && desc.length > 0) {
        const inner = desc.get(0).resolve();
        if (inner && inner.isDictionary()) {
          descriptorOwner = inner;
          if (!baseFont) baseFont = readName(inner.get("BaseFont")) ?? "";
        }
      }
    } catch { /* ignore */ }
  }

  let embedded = false;
  try {
    const fd = descriptorOwner.get("FontDescriptor");
    if (fd && !fd.isNull()) {
      const fdResolved = fd.resolve();
      for (const key of ["FontFile", "FontFile2", "FontFile3"]) {
        try {
          const ff = fdResolved.get(key);
          if (ff && !ff.isNull()) { embedded = true; break; }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  if (!baseFont) return null;
  const subset = /^[A-Z]{6}\+/.test(baseFont);
  return { baseFont, subtype, embedded, subset, encoding };
}

/**
 * /Resources is inheritable from /Parent in the page tree.
 *
 * @param {any} pageDict
 * @returns {any | null}
 */
function readResourcesInherited(pageDict) {
  let cur = pageDict;
  let safety = 16;
  while (cur && safety-- > 0) {
    try {
      const r = cur.get("Resources");
      if (r && !r.isNull() && r.isDictionary()) return r;
      const parent = cur.get("Parent");
      cur = parent && !parent.isNull() ? parent : null;
    } catch {
      cur = null;
    }
  }
  return null;
}

/**
 * @param {any} obj
 * @returns {string | null}
 */
function readName(obj) {
  if (!obj || obj.isNull()) return null;
  try {
    if (obj.isName()) return obj.asName();
  } catch { /* ignore */ }
  return null;
}
