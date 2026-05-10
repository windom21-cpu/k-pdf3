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
  setInsertedPageUserRotation,
  listInsertedPages,
  addInsertedPage,
  removeInsertedPage,
  listBookmarks,
  addBookmark,
  renameBookmark,
  removeBookmark,
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
    const insertedBySlot = new Map(); // afterPageNo -> rows[]
    for (const ins of inserted) {
      const arr = insertedBySlot.get(ins.afterPageNo) ?? [];
      arr.push(ins);
      insertedBySlot.set(ins.afterPageNo, arr);
    }
    const out = [];
    const flushSlot = (afterPageNo) => {
      const rows = insertedBySlot.get(afterPageNo);
      if (!rows) return;
      for (const r of rows) {
        out.push({
          pageNo: -r.id, // synthetic — always negative
          isSynthetic: true,
          syntheticId: r.id,
          syntheticText: r.text ?? "",
          cropW: r.width,
          cropH: r.height,
          mediaW: r.width,
          mediaH: r.height,
          rotation: 0,
          userRotation: r.userRotation ?? 0,
          isDeleted: false,
        });
      }
    };
    flushSlot(0); // pages inserted at the very start
    for (const p of sourcePages) {
      if (includeDeleted || !p.isDeleted) {
        out.push({ ...p, isSynthetic: false });
      }
      flushSlot(p.pageNo);
    }
    return out;
  }

  /** Mark / unmark a SOURCE page as deleted at the workspace level. */
  setPageDeleted(pageNo, deleted) {
    setPageDeleted(this.db, pageNo, deleted);
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

  /** Add a blank / text page. Returns the synthetic pageNo (negative). */
  addInsertedPage({ afterPageNo, text = null, width = 595, height = 842 }) {
    const id = addInsertedPage(this.db, { afterPageNo, text, width, height });
    return -id;
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

  /** Add a bookmark; returns the inserted row. */
  addBookmark({ id, title, pageNo }) {
    return addBookmark(this.db, { id, title, pageNo });
  }

  renameBookmark(id, title) {
    renameBookmark(this.db, id, title);
  }

  removeBookmark(id) {
    removeBookmark(this.db, id);
  }
}
