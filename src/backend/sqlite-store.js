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
    migrateExportsSchema(db);
    migratePagesIsDeleted(db);
    migrateInsertedPagesTable(db);
    migrateOverlaysDropPageFk(db);
  }
  return { db, isNew };
}

/**
 * Drop the `overlays.page_no → pages(page_no)` foreign key. Inserted
 * (synthetic) pages live in `inserted_pages` and use negative page_no
 * to discriminate; the original FK rejected those at save time with
 * "FOREIGN KEY constraint failed". Cross-table integrity is now
 * guaranteed at the app layer (Workspace.getPages merges both).
 *
 * SQLite has no DROP CONSTRAINT, so we rebuild the table. Idempotent
 * — checks for the old FK before doing anything. The `overlays_spatial`
 * rtree gets reset because rowids are reassigned during the rebuild;
 * the next saveOverlays() will repopulate it (saveOverlays already
 * does a full rebuild on every Ctrl+S, so no data is lost).
 */
function migrateOverlaysDropPageFk(db) {
  const fks = db.pragma("foreign_key_list(overlays)");
  if (!fks.some((f) => f.table === "pages")) return; // already migrated
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE overlays_new (
        id          TEXT PRIMARY KEY,
        page_no     INTEGER NOT NULL,
        type        TEXT NOT NULL CHECK(type IN (
                        'text', 'stamp', 'image', 'redaction',
                        'line', 'rect', 'signature', 'page_number'
                    )),
        x           REAL NOT NULL,
        y           REAL NOT NULL,
        w           REAL NOT NULL,
        h           REAL NOT NULL,
        z_order     INTEGER NOT NULL DEFAULT 0,
        properties  TEXT NOT NULL,
        asset_id    TEXT REFERENCES assets(id),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO overlays_new
        (id, page_no, type, x, y, w, h, z_order,
         properties, asset_id, created_at, updated_at)
        SELECT id, page_no, type, x, y, w, h, z_order,
               properties, asset_id, created_at, updated_at
          FROM overlays;
      DROP TABLE overlays;
      ALTER TABLE overlays_new RENAME TO overlays;
      CREATE INDEX idx_overlays_page ON overlays(page_no, z_order);
      CREATE INDEX idx_overlays_type ON overlays(type);
      DELETE FROM overlays_spatial;
      COMMIT;
    `);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/** Add the `inserted_pages` table to old workspaces (idempotent).
 *  Also adds the `user_rotation` column on second-pass migration so
 *  workspaces created before §17.11-on-synthetic-pages still work. */
function migrateInsertedPagesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inserted_pages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      after_page_no INTEGER NOT NULL,
      order_in_slot INTEGER NOT NULL DEFAULT 0,
      text          TEXT,
      width         REAL NOT NULL DEFAULT 595,
      height        REAL NOT NULL DEFAULT 842,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inserted_pages_slot
      ON inserted_pages(after_page_no, order_in_slot);
  `);
  const cols = db.pragma("table_info(inserted_pages)");
  if (!cols.some((c) => c.name === "user_rotation")) {
    db.exec(
      "ALTER TABLE inserted_pages ADD COLUMN user_rotation INTEGER NOT NULL DEFAULT 0 CHECK(user_rotation IN (0, 90, 180, 270))",
    );
  }
}

/**
 * Add the `is_deleted` column to `pages` if missing. Backfills 0 for
 * existing rows. Idempotent — safe to run on every open.
 */
function migratePagesIsDeleted(db) {
  const cols = db.pragma("table_info(pages)");
  if (!cols.some((c) => c.name === "is_deleted")) {
    db.exec(
      "ALTER TABLE pages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1))",
    );
  }
}

/**
 * Idempotent schema migration for ADR-0008: drop the `blob` column from
 * the `exports` table if it still exists (M4-2 era). Newly-created
 * workspaces have the post-ADR-0008 schema with no `blob` column from the
 * start, so this is a no-op for fresh files.
 *
 * better-sqlite3 12.9.x ships with SQLite ≥ 3.45 which supports
 * `ALTER TABLE … DROP COLUMN` (added in 3.35).
 */
function migrateExportsSchema(db) {
  const cols = db.pragma("table_info(exports)");
  if (cols.some((c) => c.name === "blob")) {
    db.exec("ALTER TABLE exports DROP COLUMN blob");
  }
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
      user_rotation AS userRotation,
      is_deleted AS isDeleted
    FROM pages ORDER BY page_no
  `).all();
}

// ---- Inserted pages (white-with-text pages user adds between source pages) ---

export function listInsertedPages(db) {
  return db
    .prepare(
      `SELECT id, after_page_no AS afterPageNo, order_in_slot AS orderInSlot,
              text, width, height,
              user_rotation AS userRotation,
              created_at AS createdAt
       FROM inserted_pages
       ORDER BY after_page_no, order_in_slot, id`,
    )
    .all();
}

/**
 * Set the user-applied rotation on an inserted page (synthetic). Same
 * semantics as setPageUserRotation for source pages, but on the
 * `inserted_pages` table.
 */
export function setInsertedPageUserRotation(db, id, userRotation) {
  const r = ((Math.round(userRotation) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(r)) {
    throw new RangeError(`Invalid userRotation: ${userRotation}`);
  }
  db.prepare(
    "UPDATE inserted_pages SET user_rotation = ? WHERE id = ?",
  ).run(r, id);
}

/** Insert a new blank/text page after a given source page number.
 *  `afterPageNo = 0` → before page 1. Returns the new row's id. */
export function addInsertedPage(db, { afterPageNo, text = null, width = 595, height = 842 }) {
  const orderRow = db
    .prepare(
      `SELECT COALESCE(MAX(order_in_slot), -1) + 1 AS nextOrder
       FROM inserted_pages WHERE after_page_no = ?`,
    )
    .get(afterPageNo);
  const nextOrder = orderRow?.nextOrder ?? 0;
  const info = db
    .prepare(
      `INSERT INTO inserted_pages
         (after_page_no, order_in_slot, text, width, height)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(afterPageNo, nextOrder, text, width, height);
  return Number(info.lastInsertRowid);
}

export function removeInsertedPage(db, id) {
  db.prepare("DELETE FROM inserted_pages WHERE id = ?").run(id);
}

/**
 * Toggle the per-page is_deleted flag (workspace-level page hide).
 * Source PDF bytes remain untouched; only this workspace excludes the
 * page from viewer / thumbs / export / print output.
 */
export function setPageDeleted(db, pageNo, deleted) {
  db.prepare(
    "UPDATE pages SET is_deleted = ? WHERE page_no = ?",
  ).run(deleted ? 1 : 0, pageNo);
}

/**
 * Set the per-page user_rotation (0 / 90 / 180 / 270). Composed with the
 * PDF's intrinsic /Rotate (`pages.rotation`) at render / export time via
 * `coord.effectiveRotation`. Source PDF bytes are not touched.
 */
export function setPageUserRotation(db, pageNo, userRotation) {
  const r = ((Math.round(userRotation) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(r)) {
    throw new RangeError(`Invalid userRotation: ${userRotation}`);
  }
  db.prepare(
    "UPDATE pages SET user_rotation = ? WHERE page_no = ?",
  ).run(r, pageNo);
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

// ---- Exports (revision audit log, ADR-0008) -----------------------------

/**
 * Record an exported PDF in the `exports` table as audit metadata only.
 * Per ADR-0008, no blob is stored — output_hash + size + timestamp +
 * revision_id are sufficient for cross-checking against the ad-hoc
 * named PDF copies the user keeps on disk.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {object} row
 * @param {string} row.id
 * @param {string} row.revisionId
 * @param {string} row.timestamp
 * @param {string} row.outputHash
 * @param {number} row.outputSize
 * @param {string | null} [row.note]
 * @param {boolean} [row.isSecure=false]
 */
export function setExport(db, row) {
  db.prepare(`
    INSERT INTO exports (
      id, revision_id, timestamp, output_hash, output_size, note, is_secure
    ) VALUES (
      @id, @revisionId, @timestamp, @outputHash, @outputSize, @note, @isSecure
    )
  `).run({
    id: row.id,
    revisionId: row.revisionId,
    timestamp: row.timestamp,
    outputHash: row.outputHash,
    outputSize: row.outputSize,
    note: row.note ?? null,
    isSecure: row.isSecure ? 1 : 0,
  });
}

/**
 * List exports newest-first.
 * @param {import("better-sqlite3").Database} db
 */
export function listExports(db) {
  return db.prepare(`
    SELECT
      id, revision_id AS revisionId, timestamp,
      output_hash AS outputHash, output_size AS outputSize,
      note, is_secure AS isSecure
    FROM exports
    ORDER BY timestamp DESC
  `).all();
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
