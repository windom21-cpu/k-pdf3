// Workspace high-level API.
//
// Coordinates between SQLite store (persistence) and mupdf (PDF parsing)
// without exposing backend types to higher layers.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  openWorkspace,
  closeWorkspace,
  setSourcePdf,
  setPages,
  getAllPages,
  getSourcePdfMeta,
  getSourcePdfBlob,
  setMetadata,
  getMetadata,
  setOverlays,
  getAllOverlays,
  setExport,
  listExports,
  setPageDeleted,
  setPageUserRotation,
  reorderPages,
  reorderAllPages,
  setInsertedPageUserRotation,
  listInsertedPages,
  addInsertedPage,
  addInsertedImagePage,
  removeInsertedPage,
  getInsertedPageImage,
  listBookmarks,
  addBookmark,
  renameBookmark,
  removeBookmark,
  moveBookmark,
  listAssets,
  addAsset,
  getAsset,
  removeAsset,
  listStampPresets,
  addStampPreset,
  removeStampPreset,
} from "../backend/sqlite-store.js";
import { createHash, randomUUID } from "node:crypto";
import {
  extractPdfInfo,
  computePdfFingerprint,
  extractOutline,
} from "../backend/mupdf-pdf-info.js";

/**
 * Workspace handle. Wraps an open SQLite db and exposes domain-friendly methods.
 */
/** Map an inserted_pages row into a synthetic page entry shaped like
 *  the source-page rows that the renderer expects. Negative pageNo
 *  marks it as synthetic; the renderer paints the page itself. */
function syntheticRow(r) {
  return {
    pageNo: -r.id,
    isSynthetic: true,
    syntheticId: r.id,
    syntheticText: r.text ?? "",
    syntheticHasImage: r.hasImage === 1,
    syntheticImageW: r.imageW ?? null,
    syntheticImageH: r.imageH ?? null,
    syntheticAfterPageNo: r.afterPageNo,
    syntheticOrderInSlot: r.orderInSlot,
    cropW: r.width,
    cropH: r.height,
    mediaW: r.width,
    mediaH: r.height,
    rotation: 0,
    userRotation: r.userRotation ?? 0,
    isDeleted: false,
  };
}

export class Workspace {
  /**
   * @param {string} filePath
   * @param {import("better-sqlite3").Database} db
   * @param {boolean} isNew
   */
  constructor(filePath, db, isNew) {
    this.filePath = filePath;
    this.db = db;
    this.isNew = isNew;
  }

  /**
   * Open or create a workspace at the given path.
   * If the path already holds a recognised .kpdf3 file, it is opened.
   * If the path is empty / non-existent, a fresh workspace is created.
   *
   * @param {string} filePath
   */
  static open(filePath) {
    const { db, isNew } = openWorkspace(filePath);
    return new Workspace(filePath, db, isNew);
  }

  /**
   * Force-create a fresh workspace at the given path. Any existing file at
   * `filePath` (and its WAL sidecars) are removed first. Use this for the
   * "new" flow where `showSaveDialog` returned a path the user has chosen
   * to overwrite.
   *
   * @param {string} filePath
   */
  static create(filePath) {
    const { db } = openWorkspace(filePath, { force: true });
    return new Workspace(filePath, db, true);
  }

  close() {
    closeWorkspace(this.db);
  }

  // ---- Source PDF import / read ----

  /**
   * Import a PDF from disk into this workspace.
   * Stores the bytes verbatim in source_pdf BLOB and records page metrics.
   *
   * @param {string} pdfPath  absolute path to the source PDF
   */
  async importPdfFromFile(pdfPath) {
    const bytes = readFileSync(pdfPath);
    return this.importPdfBytes(bytes, basename(pdfPath));
  }

  /**
   * @param {Buffer} bytes
   * @param {string} fileName
   */
  async importPdfBytes(bytes, fileName) {
    const info = extractPdfInfo(bytes);
    const fingerprint = await computePdfFingerprint(bytes);

    const tx = this.db.transaction(() => {
      setSourcePdf(this.db, {
        fileName,
        blob: bytes,
        byteSize: bytes.length,
        pageCount: info.pageCount,
        fingerprint,
      });
      setPages(this.db, info.pages);
      setMetadata(this.db, "source_fingerprint", fingerprint);
      setMetadata(this.db, "source_imported_at", new Date().toISOString());
    });
    tx();

    return { pageCount: info.pageCount, fingerprint };
  }

  /** Get source PDF metadata (without blob). */
  getSourceMeta() {
    return getSourcePdfMeta(this.db);
  }

  /** Get source PDF bytes (BLOB). */
  getSourceBytes() {
    return getSourcePdfBlob(this.db);
  }

  /**
   * Document-order page list = source PDF pages merged with user-inserted
   * blank/text pages, in the slot order specified by `after_page_no` /
   * `order_in_slot`. Inserted pages have a synthetic `pageNo = -id`
   * (always negative). By default deleted source pages are excluded.
   * Pass `{ includeDeleted: true }` to get every source row too.
   */
  getPages({ includeDeleted = false } = {}) {
    const sourcePages = getAllPages(this.db);
    const inserted = listInsertedPages(this.db);

    // Unified positional merge. Each row contributes a sort key:
    //   - source: display_order ?? page_no
    //   - synth with display_order: that value
    //   - synth without display_order: derived from its slot anchor's
    //     source-page display_order + a tiny fractional offset so it
    //     lands right after the anchor (and a bit later in the slot
    //     for higher orderInSlot values).
    // This keeps freshly-inserted blanks sensibly positioned WITHOUT
    // requiring an immediate display_order assignment, so previous
    // user reorderings don't get clobbered when a new blank is
    // introduced after the multi-select drag.
    const sourceOrderByPN = new Map();
    for (const p of sourcePages) {
      sourceOrderByPN.set(
        p.pageNo,
        typeof p.displayOrder === "number" ? p.displayOrder : p.pageNo,
      );
    }
    const synthOrder = (r) => {
      if (typeof r.displayOrder === "number") return r.displayOrder;
      // Slot-derived: anchor's order + small offset, with order_in_slot
      // sub-positioning. afterPageNo === 0 = before-everything → offset
      // from a "virtual 0" anchor.
      const anchor = r.afterPageNo > 0
        ? (sourceOrderByPN.get(r.afterPageNo) ?? r.afterPageNo)
        : 0;
      // 0.5 nudge places the synth strictly between anchor (integer)
      // and anchor+1; orderInSlot * 0.001 spreads multiple synths in
      // the same slot deterministically.
      return anchor + 0.5 + (r.orderInSlot ?? 0) * 0.001;
    };
    const mergedRaw = [];
    for (const p of sourcePages) {
      if (!includeDeleted && p.isDeleted) continue;
      mergedRaw.push({
        kind: "src",
        orderKey:
          typeof p.displayOrder === "number" ? p.displayOrder : p.pageNo,
        row: p,
      });
    }
    for (const r of inserted) {
      mergedRaw.push({ kind: "syn", orderKey: synthOrder(r), row: r });
    }
    mergedRaw.sort((a, b) => {
      if (a.orderKey === b.orderKey) {
        // Stable secondary: source before synth, then by id/pageNo.
        if (a.kind !== b.kind) return a.kind === "src" ? -1 : 1;
        if (a.kind === "src") return a.row.pageNo - b.row.pageNo;
        return a.row.id - b.row.id;
      }
      return a.orderKey - b.orderKey;
    });
    const out = [];
    for (const m of mergedRaw) {
      if (m.kind === "src") out.push({ ...m.row, isSynthetic: false });
      else out.push(syntheticRow(m.row));
    }
    return out;
  }

  /** Mark / unmark a SOURCE page as deleted at the workspace level. */
  setPageDeleted(pageNo, deleted) {
    setPageDeleted(this.db, pageNo, deleted);
  }

  /** Apply a new visual order to source pages. Synthetic pages follow
   *  their slot anchor, so they reorder automatically. */
  reorderPages(orderedPageNos) {
    reorderPages(this.db, orderedPageNos);
  }

  /** Apply a positional order to ALL pages (mixed source + synthetic).
   *  Each entry of `orderedKeys` is a positive source pageNo or a
   *  negative synthetic key (= -inserted_pages.id). */
  reorderAllPages(orderedKeys) {
    reorderAllPages(this.db, orderedKeys);
  }

  /**
   * Set the user-applied rotation (0/90/180/270) for any page —
   * routes by sign of `pageNo`. Negative pageNo = synthetic
   * (inserted_pages.id = -pageNo).
   */
  setPageUserRotation(pageNo, userRotation) {
    if (pageNo < 0) {
      setInsertedPageUserRotation(this.db, -pageNo, userRotation);
    } else {
      setPageUserRotation(this.db, pageNo, userRotation);
    }
  }

  /** Add a blank / text page. Pass `orderInSlot` to insert between
   *  existing synthetics in the same slot (subsequent rows shift
   *  down). Returns the synthetic pageNo (negative). */
  addInsertedPage({ afterPageNo, text = null, width = 595, height = 842, orderInSlot = null }) {
    const id = addInsertedPage(this.db, { afterPageNo, text, width, height, orderInSlot });
    return -id;
  }

  /** Add an image-backed inserted page (e.g. external PDF page rasterised
   *  to PNG). Returns the synthetic pageNo (negative). */
  addInsertedImagePage({ afterPageNo, imageBlob, imageW, imageH, width, height }) {
    const id = addInsertedImagePage(this.db, {
      afterPageNo, imageBlob, imageW, imageH, width, height,
    });
    return -id;
  }

  /** Read the raw image bytes for an inserted-image page (lookup by
   *  positive id; the renderer translates synthetic pageNo → id by
   *  negating). */
  getInsertedPageImage(id) {
    return getInsertedPageImage(this.db, id);
  }

  /** Remove an inserted page by its synthetic pageNo (negative). */
  removeInsertedPage(syntheticPageNo) {
    if (syntheticPageNo >= 0) return;
    removeInsertedPage(this.db, -syntheticPageNo);
  }

  /** Read a single metadata key. */
  getMetadata(key) {
    return getMetadata(this.db, key);
  }

  // ---- Overlay persistence (M3-1) ------------------------------------

  /**
   * Replace the workspace's entire overlay set with the given snapshot.
   * Atomic: a transaction wraps the DELETE + bulk INSERT so a crash mid-save
   * leaves the previous state intact.
   *
   * @param {import("./project-store.js").Overlay[]} overlays
   */
  saveOverlays(overlays) {
    setOverlays(this.db, overlays);
    setMetadata(this.db, "overlays_saved_at", new Date().toISOString());
  }

  /**
   * Load all overlays as a flat array. ProjectStore.reset(...) consumes this
   * directly.
   *
   * @returns {import("./project-store.js").Overlay[]}
   */
  loadOverlays() {
    return getAllOverlays(this.db);
  }

  // ---- Export history (M4-2) -----------------------------------------

  /**
   * Record an exported PDF in the `exports` table as audit metadata
   * (ADR-0008). The bytes are passed in only to compute the SHA-256 +
   * size; no blob is persisted.
   *
   * Returns the freshly-generated ids so the caller can show 「rev …」
   * feedback in the status bar.
   *
   * @param {Buffer} blob
   * @param {{ note?: string | null, isSecure?: boolean }} [opts]
   * @returns {{ id: string, revisionId: string, timestamp: string, outputHash: string, outputSize: number }}
   */
  recordExport(blob, opts = {}) {
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    const id = randomUUID();
    const revisionId = randomUUID();
    const timestamp = new Date().toISOString();
    const outputHash = createHash("sha256").update(buf).digest("hex");
    const outputSize = buf.length;
    setExport(this.db, {
      id,
      revisionId,
      timestamp,
      outputHash,
      outputSize,
      note: opts.note ?? null,
      isSecure: !!opts.isSecure,
    });
    setMetadata(this.db, "last_export_at", timestamp);
    setMetadata(this.db, "last_export_revision_id", revisionId);
    return { id, revisionId, timestamp, outputHash, outputSize };
  }

  /** Return the exports audit log (newest first), metadata only. */
  listExports() {
    return listExports(this.db);
  }

  // ---- Outline / bookmarks (M5-5) -----------------------------------

  /**
   * Read the source PDF's /Outlines (bookmarks) as a flat hierarchy.
   * Pure read-through to mupdf — bookmarks aren't yet persisted into the
   * workspace itself (M6 will add an editable copy).
   *
   * @returns {import("../backend/mupdf-pdf-info.js").OutlineNode[]}
   */
  getOutline() {
    const bytes = this.getSourceBytes();
    if (!bytes) return [];
    return extractOutline(bytes);
  }

  // ---- Editable bookmarks (M6, §17.14) ------------------------------

  /** Workspace-side bookmarks (flat list). When non-empty these
   *  override the source PDF's /Outlines in the renderer UI. */
  listBookmarks() {
    return listBookmarks(this.db);
  }

  /** Add a bookmark; returns the inserted row. parentId may be null. */
  addBookmark({ id, title, pageNo, parentId = null }) {
    return addBookmark(this.db, { id, title, pageNo, parentId });
  }

  renameBookmark(id, title) {
    renameBookmark(this.db, id, title);
  }

  removeBookmark(id) {
    removeBookmark(this.db, id);
  }

  /** Reparent / reorder a bookmark. Used by the sidebar drag-and-drop UI. */
  moveBookmark(id, opts) {
    moveBookmark(this.db, id, opts);
  }

  // ---- Assets (image stamps, ADR-0017) -------------------------------

  listAssets() {
    return listAssets(this.db);
  }
  addAsset(opts) {
    return addAsset(this.db, opts);
  }
  getAsset(id) {
    return getAsset(this.db, id);
  }
  removeAsset(id) {
    removeAsset(this.db, id);
  }

  // ---- Stamp presets (ADR-0019 MVP) ---------------------------------

  listStampPresets() {
    return listStampPresets(this.db);
  }
  addStampPreset(p) {
    return addStampPreset(this.db, p);
  }
  removeStampPreset(id) {
    removeStampPreset(this.db, id);
  }
}
