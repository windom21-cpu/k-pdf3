// better-sqlite3 wrapper for K-PDF3 workspace files.
//
// ADR-0001: workspace = single SQLite file (.kpdf3) in WAL mode.
// This module owns:
//   - schema bootstrap (apply schema.sql on new files)
//   - WAL / pragma setup
//   - integrity check
//   - low-level CRUD helpers (callers stay schema-aware)

import Database from "better-sqlite3";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to schema.sql relative to this file: src/backend → ../../schema/schema.sql
const SCHEMA_PATH = join(__dirname, "..", "..", "schema", "schema.sql");

/** Magic application_id for `.kpdf3` files. ASCII "KPDF". */
export const APPLICATION_ID = 0x4b504446;
/** Schema version we recognise (matches PRAGMA user_version in schema.sql). */
export const SCHEMA_VERSION = 1;

/**
 * Open or create a workspace SQLite file.
 * If the file does not exist, it is created and the schema is applied.
 * If it exists, basic integrity & version checks are performed.
 *
 * Pass `{ force: true }` to wipe an existing file before opening — used by
 * the "new workspace" flow where `showSaveDialog` may have selected an
 * existing path that the user has agreed to overwrite. WAL sidecars (-wal,
 * -shm) are also removed.
 *
 * @param {string} filePath  absolute path to the .kpdf3 file
 * @param {{ force?: boolean }} [opts]
 * @returns {{ db: import("better-sqlite3").Database, isNew: boolean }}
 */
export function openWorkspace(filePath, opts = {}) {
  if (opts.force) {
    if (existsSync(filePath)) rmSync(filePath, { force: true });
    rmSync(filePath + "-wal", { force: true });
    rmSync(filePath + "-shm", { force: true });
  }
  const isNew = !existsSync(filePath);
  const db = new Database(filePath);

  // Pragmas first
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");

  if (isNew) {
    const schema = readFileSync(SCHEMA_PATH, "utf-8");
    db.exec(schema);
  } else {
    verifyWorkspace(db, filePath);
  }
  return { db, isNew };
}

/**
 * Verify that an existing file is a recognized K-PDF3 workspace.
 * Throws on mismatch.
 */
function verifyWorkspace(db, filePath) {
  const appId = db.pragma("application_id", { simple: true });
  if (appId !== APPLICATION_ID) {
    throw new Error(
      `${filePath} is not a K-PDF3 workspace (application_id=${appId.toString(16)}, expected ${APPLICATION_ID.toString(16)})`
    );
  }
  const userVer = db.pragma("user_version", { simple: true });
  if (userVer !== SCHEMA_VERSION) {
    throw new Error(
      `${filePath} schema_version=${userVer}, this build expects ${SCHEMA_VERSION}`
    );
  }
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    throw new Error(`${filePath} integrity_check failed: ${integrity}`);
  }
}

/**
 * Close and checkpoint WAL so the file is ready for transport / sync.
 *
 * @param {import("better-sqlite3").Database} db
 */
export function closeWorkspace(db) {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // ignore — checkpoint failure should not block close
  }
  db.close();
}

// ---- Source PDF -----------------------------------------------------------

/**
 * Insert (or replace) the single source_pdf row.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ fileName: string, blob: Buffer, byteSize: number, pageCount: number, fingerprint: string }} row
 */
export function setSourcePdf(db, row) {
  db.prepare("DELETE FROM source_pdf").run();
  db.prepare(`
    INSERT INTO source_pdf (id, file_name, blob, byte_size, page_count, fingerprint)
    VALUES (1, @fileName, @blob, @byteSize, @pageCount, @fingerprint)
  `).run(row);
}

/**
 * Read the source_pdf row (without blob) for fast metadata access.
 *
 * @param {import("better-sqlite3").Database} db
 */
export function getSourcePdfMeta(db) {
  return db.prepare(
    "SELECT id, file_name AS fileName, byte_size AS byteSize, page_count AS pageCount, fingerprint, imported_at AS importedAt FROM source_pdf WHERE id = 1"
  ).get();
}

/**
 * Read the source_pdf BLOB.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {Buffer | null}
 */
export function getSourcePdfBlob(db) {
  const row = db.prepare("SELECT blob FROM source_pdf WHERE id = 1").get();
  return row ? row.blob : null;
}

// ---- Pages ---------------------------------------------------------------

/**
 * Replace the entire `pages` table contents (used during import).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {Array<{ pageNo: number, mediaX: number, mediaY: number, mediaW: number, mediaH: number, cropX: number, cropY: number, cropW: number, cropH: number, rotation: number, userRotation?: number }>} pages
 */
export function setPages(db, pages) {
  const insert = db.prepare(`
    INSERT INTO pages (
      page_no,
      media_x, media_y, media_w, media_h,
      crop_x,  crop_y,  crop_w,  crop_h,
      rotation, user_rotation
    ) VALUES (
      @pageNo,
      @mediaX, @mediaY, @mediaW, @mediaH,
      @cropX,  @cropY,  @cropW,  @cropH,
      @rotation, @userRotation
    )
  `);
  const tx = db.transaction((rows) => {
    db.prepare("DELETE FROM pages").run();
    for (const r of rows) {
      insert.run({
        pageNo: r.pageNo,
        mediaX: r.mediaX, mediaY: r.mediaY, mediaW: r.mediaW, mediaH: r.mediaH,
        cropX: r.cropX, cropY: r.cropY, cropW: r.cropW, cropH: r.cropH,
        rotation: r.rotation,
        userRotation: r.userRotation ?? 0,
      });
    }
  });
  tx(pages);
}

/**
 * Read all pages, ordered by page_no.
 *
 * @param {import("better-sqlite3").Database} db
 */
export function getAllPages(db) {
  return db.prepare(`
    SELECT
      page_no AS pageNo,
      media_x AS mediaX, media_y AS mediaY, media_w AS mediaW, media_h AS mediaH,
      crop_x  AS cropX,  crop_y  AS cropY,  crop_w  AS cropW,  crop_h  AS cropH,
      rotation,
      user_rotation AS userRotation
    FROM pages ORDER BY page_no
  `).all();
}

// ---- Overlays ------------------------------------------------------------

/**
 * Replace the entire `overlays` (and the parallel R*Tree `overlays_spatial`)
 * contents atomically. Used by Workspace.saveOverlays — the M3 "Ctrl+S" path
 * dumps the whole ProjectStore in one go (overlay counts are small enough
 * that incremental writes aren't yet worth the complexity).
 *
 * The R*Tree's `rowid` is paired with the overlays row by reading
 * `lastInsertRowid` after each insert and reusing it for the spatial entry.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {import("../domain/project-store.js").Overlay[]} overlays
 */
export function setOverlays(db, overlays) {
  const insertOverlay = db.prepare(`
    INSERT INTO overlays (
      id, page_no, type,
      x, y, w, h, z_order,
      properties, asset_id,
      created_at, updated_at
    ) VALUES (
      @id, @pageNo, @type,
      @x, @y, @w, @h, @zOrder,
      @properties, @assetId,
      @createdAt, @updatedAt
    )
  `);
  const insertSpatial = db.prepare(`
    INSERT INTO overlays_spatial (rowid, min_x, max_x, min_y, max_y)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    db.prepare("DELETE FROM overlays_spatial").run();
    db.prepare("DELETE FROM overlays").run();
    for (const ov of rows) {
      const result = insertOverlay.run({
        id: ov.id,
        pageNo: ov.pageNo,
        type: ov.type,
        x: ov.x, y: ov.y, w: ov.w, h: ov.h,
        zOrder: ov.zOrder,
        properties: JSON.stringify(ov.properties ?? {}),
        assetId: ov.assetId ?? null,
        createdAt: ov.createdAt,
        updatedAt: ov.updatedAt,
      });
      insertSpatial.run(
        result.lastInsertRowid,
        ov.x,
        ov.x + ov.w,
        ov.y,
        ov.y + ov.h,
      );
    }
  });
  tx(overlays);
}

/**
 * Read all overlays, ordered by page_no then z_order. JSON `properties` is
 * parsed back into an object before returning.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {import("../domain/project-store.js").Overlay[]}
 */
export function getAllOverlays(db) {
  const rows = db.prepare(`
    SELECT
      id, page_no AS pageNo, type,
      x, y, w, h, z_order AS zOrder,
      properties, asset_id AS assetId,
      created_at AS createdAt, updated_at AS updatedAt
    FROM overlays
    ORDER BY page_no, z_order, id
  `).all();
  return rows.map((r) => ({
    ...r,
    properties: r.properties ? JSON.parse(r.properties) : {},
    assetId: r.assetId ?? null,
  }));
}

// ---- Metadata ------------------------------------------------------------

export function getMetadata(db, key) {
  const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setMetadata(db, key, value) {
  db.prepare(`
    INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
