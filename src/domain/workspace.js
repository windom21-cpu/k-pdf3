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
} from "../backend/sqlite-store.js";
import { extractPdfInfo, computePdfFingerprint } from "../backend/mupdf-pdf-info.js";

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

  /** All page metrics, ordered by page number. */
  getPages() {
    return getAllPages(this.db);
  }

  /** Read a single metadata key. */
  getMetadata(key) {
    return getMetadata(this.db, key);
  }
}
