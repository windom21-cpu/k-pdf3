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
import { randomUUID, createHash as createHashAsset } from "node:crypto";

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
    // β.134 サイドカー (.source.pdf) も道連れに消す。上書き保存で既存
    // workspace を潰すと、巨大 PDF の external source ファイルだけが
    // 取り残されて orphan 化していた (stable 残務 #7 の発生源)。無ければ
    // no-op。
    rmSync(filePath + ".source.pdf", { force: true });
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
    migrateInsertedSourcePdfsTable(db);
    migrateInsertedPagesTable(db);
    migrateOverlaysDropPageFk(db);
    migrateOverlaysAddFormField(db);
    migrateOverlaysAddShape(db);
    migrateBookmarksDropPageFk(db);
    migrateStampPresetsTable(db);
    migrateSourcePdfAddExternalPath(db);
  }
  return { db, isNew };
}

/**
 * β.134: source_pdf に external_path カラム追加。閾値超の巨大 PDF を
 * SQLite BLOB ではなく workspace 隣のサイドカーファイルに退避するため。
 * blob の NOT NULL 制約はそのまま残し、externalPath 経路では blob に
 * 0-byte Buffer を入れる (table 再作成を避けて低リスク移行)。Idempotent。
 */
function migrateSourcePdfAddExternalPath(db) {
  const cols = db.prepare("PRAGMA table_info(source_pdf)").all();
  if (cols.some((c) => c.name === "external_path")) return;
  db.exec("ALTER TABLE source_pdf ADD COLUMN external_path TEXT");
}

/** Add the `stamp_presets` table (ADR-0019 MVP). Idempotent. */
function migrateStampPresetsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stamp_presets (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('date', 'text', 'image')),
      label       TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#cc0000',
      frame       TEXT NOT NULL DEFAULT 'rect' CHECK (frame IN ('circle', 'rect', 'none')),
      font_size   INTEGER NOT NULL DEFAULT 13,
      text        TEXT,
      asset_id    TEXT REFERENCES assets(id) ON DELETE SET NULL,
      width       INTEGER NOT NULL DEFAULT 80,
      height      INTEGER NOT NULL DEFAULT 80,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stamp_presets_kind
      ON stamp_presets(kind, sort_order);
  `);
}

/**
 * Mirror of migrateOverlaysDropPageFk for the `bookmarks` table — the
 * old schema had `page_no INTEGER NOT NULL REFERENCES pages(page_no)`,
 * which rejects bookmarks pointing at synthetic (inserted) pages
 * (negative pageNo). Cross-table integrity stays at the app layer.
 */
function migrateBookmarksDropPageFk(db) {
  const fks = db.pragma("foreign_key_list(bookmarks)");
  if (!fks.some((f) => f.table === "pages")) return; // already migrated
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE bookmarks_new (
        id          TEXT PRIMARY KEY,
        parent_id   TEXT REFERENCES bookmarks_new(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        page_no     INTEGER NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO bookmarks_new SELECT id, parent_id, title, page_no, sort_order FROM bookmarks;
      DROP TABLE bookmarks;
      ALTER TABLE bookmarks_new RENAME TO bookmarks;
      CREATE INDEX idx_bookmarks_parent ON bookmarks(parent_id, sort_order);
      COMMIT;
    `);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.pragma("foreign_keys = ON");
  }
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

/**
 * β.80: extend overlays.type CHECK constraint to include 'form_field'
 * (申請書テンプレート用フィールド種別). SQLite has no ALTER CONSTRAINT,
 * so we rebuild the table when the existing CHECK does not contain
 * 'form_field'. Idempotent — no-op once the new constraint is in place.
 *
 * Detection uses sqlite_master.sql since pragma() does not expose the
 * CHECK expression directly. The rebuild preserves all rows and
 * indices; the overlays_spatial rtree is reset because rowids are
 * reassigned, and the next saveOverlays() repopulates it (same pattern
 * as migrateOverlaysDropPageFk).
 */
function migrateOverlaysAddFormField(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='overlays'")
    .get();
  if (!row || !row.sql) return;
  if (row.sql.includes("'form_field'")) return; // already migrated
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE overlays_new (
        id          TEXT PRIMARY KEY,
        page_no     INTEGER NOT NULL,
        type        TEXT NOT NULL CHECK(type IN (
                        'text', 'stamp', 'image', 'redaction',
                        'line', 'rect', 'signature', 'page_number',
                        'form_field'
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

/**
 * β.100: extend overlays.type CHECK constraint to include 'shape'
 * (オートシェイプ — 直線・矢印・ブロック矢印・楕円のラッパー型).
 * Idempotent and mirrors migrateOverlaysAddFormField in structure.
 */
function migrateOverlaysAddShape(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='overlays'")
    .get();
  if (!row || !row.sql) return;
  if (row.sql.includes("'shape'")) return; // already migrated
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE overlays_new (
        id          TEXT PRIMARY KEY,
        page_no     INTEGER NOT NULL,
        type        TEXT NOT NULL CHECK(type IN (
                        'text', 'stamp', 'image', 'redaction',
                        'line', 'rect', 'signature', 'page_number',
                        'form_field', 'shape'
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
  if (!cols.some((c) => c.name === "image_blob")) {
    db.exec("ALTER TABLE inserted_pages ADD COLUMN image_blob BLOB");
    db.exec("ALTER TABLE inserted_pages ADD COLUMN image_w INTEGER");
    db.exec("ALTER TABLE inserted_pages ADD COLUMN image_h INTEGER");
  }
  // display_order: shared positional ordering with `pages.display_order`
  // so a synth's position can be controlled independently of its slot
  // anchor (after_page_no). NULL means "use slot ordering" — getPages
  // backfills a sensible default when merging.
  if (!cols.some((c) => c.name === "display_order")) {
    db.exec("ALTER TABLE inserted_pages ADD COLUMN display_order REAL");
  }
  // β31: vector-preserving external PDF insertion. source_pdf_id points
  // into inserted_source_pdfs (dedup by SHA-256); source_page_index is
  // the 0-based page within that PDF. NULL on both = legacy image-only
  // synthetic page (export falls back to the rasterised image_blob).
  if (!cols.some((c) => c.name === "source_pdf_id")) {
    db.exec("ALTER TABLE inserted_pages ADD COLUMN source_pdf_id INTEGER");
    db.exec("ALTER TABLE inserted_pages ADD COLUMN source_page_index INTEGER");
  }
}

/** β31: vector-preserving external PDF storage (dedup by SHA-256).
 *  Idempotent — safe to call on every open. */
function migrateInsertedSourcePdfsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inserted_source_pdfs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256      TEXT NOT NULL UNIQUE,
      pdf_blob    BLOB NOT NULL,
      byte_size   INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
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
  // display_order: the user-controlled visual order for source pages
  // (sidebar thumb D&D reorders this without renaming page_no, so
  // existing overlay/inserted-page references stay intact). REAL so
  // we can fractional-insert between two values without renumbering.
  if (!cols.some((c) => c.name === "display_order")) {
    db.exec("ALTER TABLE pages ADD COLUMN display_order REAL");
    // Seed each row's display_order = page_no so first-load looks the
    // same as before the migration.
    db.exec("UPDATE pages SET display_order = page_no WHERE display_order IS NULL");
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
 * β.134: externalPath が non-null のときは blob には 0-byte Buffer を入れる
 * (NOT NULL 制約は移行ずみ DB のため残置)。読出は getSourcePdfMeta() →
 * externalPath → ファイル read という流れで Workspace.getSourceBytes()
 * が透明に扱う。
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ fileName: string, blob: Buffer, externalPath?: string | null, byteSize: number, pageCount: number, fingerprint: string }} row
 */
export function setSourcePdf(db, row) {
  db.prepare("DELETE FROM source_pdf").run();
  db.prepare(`
    INSERT INTO source_pdf (id, file_name, blob, external_path, byte_size, page_count, fingerprint)
    VALUES (1, @fileName, @blob, @externalPath, @byteSize, @pageCount, @fingerprint)
  `).run({
    fileName: row.fileName,
    blob: row.blob,
    externalPath: row.externalPath ?? null,
    byteSize: row.byteSize,
    pageCount: row.pageCount,
    fingerprint: row.fingerprint,
  });
}

/**
 * Read the source_pdf row (without blob) for fast metadata access.
 *
 * @param {import("better-sqlite3").Database} db
 */
export function getSourcePdfMeta(db) {
  return db.prepare(
    "SELECT id, file_name AS fileName, byte_size AS byteSize, page_count AS pageCount, fingerprint, imported_at AS importedAt, external_path AS externalPath FROM source_pdf WHERE id = 1"
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
      is_deleted AS isDeleted,
      display_order AS displayOrder
    FROM pages ORDER BY COALESCE(display_order, page_no), page_no
  `).all();
}

/** Apply a new visual ordering to source pages. `orderedPageNos` is the
 *  array of page_no values in the desired display order; we assign
 *  display_order = 1, 2, 3, ... so subsequent inserts can fractional-
 *  index between integers without immediate renumbering.
 *
 *  Synthetic (inserted) pages stay slot-anchored to their source page,
 *  so they automatically follow their anchor's new position — no
 *  inserted_pages writes needed. */
export function reorderPages(db, orderedPageNos) {
  const upd = db.prepare("UPDATE pages SET display_order = ? WHERE page_no = ?");
  const tx = db.transaction((ids) => {
    ids.forEach((pageNo, i) => upd.run(i + 1, pageNo));
  });
  tx(orderedPageNos);
}

/** Apply a new positional order to ALL pages (source + synthetic). Each
 *  entry of `orderedKeys` is either a positive source pageNo or a
 *  negative synthetic page key (= -inserted_pages.id). display_order
 *  is assigned 1, 2, 3, ... across the merged list, written to
 *  whichever table the row lives in. Used by sidebar/split D&D when
 *  the user reorders pages through the UI. */
export function reorderAllPages(db, orderedKeys) {
  const updSrc  = db.prepare("UPDATE pages SET display_order = ? WHERE page_no = ?");
  const updSyn  = db.prepare("UPDATE inserted_pages SET display_order = ? WHERE id = ?");
  const tx = db.transaction((keys) => {
    keys.forEach((key, i) => {
      const order = i + 1;
      if (key > 0) updSrc.run(order, key);
      else if (key < 0) updSyn.run(order, -key);
    });
  });
  tx(orderedKeys);
}

// ---- Inserted pages (white-with-text pages user adds between source pages) ---

export function listInsertedPages(db) {
  // hasImage as 0/1 flag — keeps the (potentially large) image_blob
  // out of the per-page list query. Renderer fetches the bytes via
  // getInsertedPageImage when it actually needs to paint the page.
  // β31: sourcePdfId / sourcePageIndex expose the vector-preserving
  // backing PDF (when present) so the exporter can choose copyPages
  // over rasterised fallback.
  return db
    .prepare(
      `SELECT id, after_page_no AS afterPageNo, order_in_slot AS orderInSlot,
              text, width, height,
              user_rotation AS userRotation,
              CASE WHEN image_blob IS NULL THEN 0 ELSE 1 END AS hasImage,
              image_w AS imageW, image_h AS imageH,
              source_pdf_id AS sourcePdfId,
              source_page_index AS sourcePageIndex,
              display_order AS displayOrder,
              created_at AS createdAt
       FROM inserted_pages
       ORDER BY after_page_no, order_in_slot, id`,
    )
    .all();
}

/** Insert a new pre-rasterised image page (external PDF import).
 *  β31: when `sourcePdfId` + `sourcePageIndex` are supplied, the row
 *  doubles as a vector-preserving reference into inserted_source_pdfs
 *  so the exporter can copyPages instead of using the rasterised image.
 *  The image_blob is still stored as a viewer-preview path. */
export function addInsertedImagePage(db, {
  afterPageNo,
  imageBlob,
  imageW,
  imageH,
  width,
  height,
  sourcePdfId = null,
  sourcePageIndex = null,
  displayOrder = null,
}) {
  const orderRow = db
    .prepare(
      `SELECT COALESCE(MAX(order_in_slot), -1) + 1 AS nextOrder
       FROM inserted_pages WHERE after_page_no = ?`,
    )
    .get(afterPageNo);
  const nextOrder = orderRow?.nextOrder ?? 0;
  // β77: caller may supply an explicit `displayOrder` so the new synth
  // lands exactly between two visible pages regardless of how the slot
  // anchor (afterPageNo) relates to the current visual layout. When
  // omitted, the row falls back to slot-derived ordering in getPages.
  const explicitDisplayOrder =
    typeof displayOrder === "number" && Number.isFinite(displayOrder)
      ? displayOrder
      : null;
  const info = db
    .prepare(
      `INSERT INTO inserted_pages
         (after_page_no, order_in_slot, text, width, height,
          image_blob, image_w, image_h,
          source_pdf_id, source_page_index,
          display_order)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      afterPageNo, nextOrder, width, height,
      imageBlob, imageW, imageH,
      sourcePdfId, sourcePageIndex,
      explicitDisplayOrder,
    );
  return Number(info.lastInsertRowid);
}

/** Read the raw PNG bytes (and dims) of an inserted-image page. */
export function getInsertedPageImage(db, id) {
  const row = db
    .prepare(
      `SELECT image_blob AS imageBlob, image_w AS imageW, image_h AS imageH
       FROM inserted_pages WHERE id = ?`,
    )
    .get(id);
  if (!row || !row.imageBlob) return null;
  return row;
}

/** β31: get-or-create a row in inserted_source_pdfs keyed by SHA-256.
 *  Returns the row id (existing or newly inserted). Caller is expected
 *  to compute the hash from `pdfBlob`. Same content → same id, so
 *  many-page insertions of the same external PDF share one blob. */
export function getOrCreateInsertedSourcePdf(db, { sha256, pdfBlob, byteSize }) {
  const existing = db
    .prepare("SELECT id FROM inserted_source_pdfs WHERE sha256 = ?")
    .get(sha256);
  if (existing) return existing.id;
  const info = db
    .prepare(
      `INSERT INTO inserted_source_pdfs (sha256, pdf_blob, byte_size)
       VALUES (?, ?, ?)`,
    )
    .run(sha256, pdfBlob, byteSize);
  return Number(info.lastInsertRowid);
}

/** β31: read the raw PDF bytes of a stored external source. Used by
 *  the exporter to copyPages for vector-preserving assembly. */
export function getInsertedSourcePdf(db, id) {
  const row = db
    .prepare(
      `SELECT pdf_blob AS pdfBlob, byte_size AS byteSize
       FROM inserted_source_pdfs WHERE id = ?`,
    )
    .get(id);
  if (!row || !row.pdfBlob) return null;
  return row;
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
 *  `afterPageNo = 0` → before page 1. If `orderInSlot` is supplied,
 *  any existing row in the same slot at that order or beyond is
 *  shifted down by one to make room (so callers can insert between
 *  two existing synthetic pages). When omitted, the new row is
 *  appended at the end of the slot. Returns the new row's id. */
export function addInsertedPage(db, {
  afterPageNo,
  text = null,
  width = 595,
  height = 842,
  orderInSlot = null,
}) {
  let order;
  if (typeof orderInSlot === "number" && Number.isFinite(orderInSlot)) {
    db.prepare(
      `UPDATE inserted_pages SET order_in_slot = order_in_slot + 1
       WHERE after_page_no = ? AND order_in_slot >= ?`,
    ).run(afterPageNo, orderInSlot);
    order = orderInSlot;
  } else {
    const orderRow = db
      .prepare(
        `SELECT COALESCE(MAX(order_in_slot), -1) + 1 AS nextOrder
         FROM inserted_pages WHERE after_page_no = ?`,
      )
      .get(afterPageNo);
    order = orderRow?.nextOrder ?? 0;
  }
  const info = db
    .prepare(
      `INSERT INTO inserted_pages
         (after_page_no, order_in_slot, text, width, height)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(afterPageNo, order, text, width, height);
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

// ---- Assets (image stamps + future signature / image overlays) ---------

/** List all assets (without the heavy `blob` column). */
export function listAssets(db) {
  return db
    .prepare(
      `SELECT id, hash, mime, width, height, label, created_at AS createdAt
       FROM assets ORDER BY created_at DESC, rowid DESC`,
    )
    .all();
}

/** Insert a new asset. Returns the id (existing on hash dedupe). */
export function addAsset(db, { mime, blob, width = null, height = null, label = null }) {
  const buf = blob instanceof Uint8Array ? Buffer.from(blob) : Buffer.from(blob);
  const hash = createHashAsset("sha256").update(buf).digest("hex");
  const existing = db.prepare("SELECT id FROM assets WHERE hash = ?").get(hash);
  if (existing) {
    if (label) db.prepare("UPDATE assets SET label = ? WHERE id = ?").run(label, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO assets (id, hash, mime, blob, width, height, label)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, hash, mime, buf, width, height, label);
  return id;
}

/** Read an asset's blob (caller renders it). Returns Uint8Array. */
export function getAsset(db, id) {
  const row = db
    .prepare(
      `SELECT id, mime, blob, width, height, label
       FROM assets WHERE id = ?`,
    )
    .get(id);
  if (!row) return null;
  const u8 = row.blob instanceof Uint8Array ? row.blob : new Uint8Array(row.blob);
  return { id: row.id, mime: row.mime, blob: u8, width: row.width, height: row.height, label: row.label };
}

export function removeAsset(db, id) {
  db.prepare("DELETE FROM assets WHERE id = ?").run(id);
}

// ---- Stamp presets (ADR-0019 MVP) --------------------------------------

export function listStampPresets(db) {
  return db
    .prepare(
      `SELECT id, kind, label, color, frame, font_size AS fontSize,
              text, asset_id AS assetId, width, height,
              sort_order AS sortOrder, created_at AS createdAt
       FROM stamp_presets
       ORDER BY sort_order, created_at, rowid`,
    )
    .all();
}

export function addStampPreset(db, p) {
  // Single-statement upsert via INSERT OR REPLACE so we can't lose to a
  // race / stale lookup. sort_order is preserved on existing rows so
  // the palette layout doesn't jump when the user edits a preset.
  const id = p.id ?? randomUUID();
  const existing = db
    .prepare("SELECT sort_order AS sortOrder FROM stamp_presets WHERE id = ?")
    .get(id);
  let sortOrder;
  if (existing) {
    sortOrder = existing.sortOrder;
  } else {
    const next = db
      .prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM stamp_presets")
      .get();
    sortOrder = next?.n ?? 0;
  }
  db.prepare(
    `INSERT OR REPLACE INTO stamp_presets
       (id, kind, label, color, frame, font_size, text, asset_id, width, height, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, p.kind, p.label, p.color ?? "#cc0000", p.frame ?? "rect",
    p.fontSize ?? 13, p.text ?? null, p.assetId ?? null,
    p.width ?? 80, p.height ?? 80, sortOrder,
  );
  return id;
}

export function removeStampPreset(db, id) {
  db.prepare("DELETE FROM stamp_presets WHERE id = ?").run(id);
}

/** β.85: write `sort_order = index` for each id in `ids`. Run in a
 *  single transaction so the スタンプ管理 reorder UI atomically commits
 *  even if mid-list ids are duplicates of existing rows. Ids not in the
 *  list keep their sort_order (= they sink to the end against listStamp-
 *  Presets's `ORDER BY sort_order, created_at, rowid`). */
export function setStampPresetsOrder(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const stmt = db.prepare("UPDATE stamp_presets SET sort_order = ? WHERE id = ?");
  const tx = db.transaction((arr) => {
    for (let i = 0; i < arr.length; i++) {
      stmt.run(i, arr[i]);
    }
  });
  tx(ids);
}

// ---- Bookmarks (workspace-side editable, ADR-0014 + nested children) ----

export function listBookmarks(db) {
  return db
    .prepare(
      `SELECT id, parent_id AS parentId, title, page_no AS pageNo, sort_order AS sortOrder
       FROM bookmarks
       ORDER BY sort_order, rowid`,
    )
    .all();
}

/** Append a bookmark at the end of the given parent's children. parentId
 *  may be null for top-level entries. */
export function addBookmark(db, { id, title, pageNo, parentId = null }) {
  const next = db
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n
       FROM bookmarks WHERE parent_id IS ?`,
    )
    .get(parentId);
  const sortOrder = next?.n ?? 0;
  db.prepare(
    `INSERT INTO bookmarks (id, parent_id, title, page_no, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, parentId, title, pageNo, sortOrder);
  return { id, parentId, title, pageNo, sortOrder };
}

export function renameBookmark(db, id, title) {
  db.prepare("UPDATE bookmarks SET title = ? WHERE id = ?").run(title, id);
}

export function removeBookmark(db, id) {
  db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
}

/**
 * Move `id` to be the child of `parentId` (null = top level), positioned
 * directly before `beforeId` — or at the end of the parent if beforeId is
 * null. Renumbers `sort_order` of all siblings in the destination parent
 * (and the source parent if different) so they stay densely packed.
 *
 * Throws if the move would create a cycle (parentId is `id` itself or a
 * descendant of `id`).
 */
export function moveBookmark(db, id, { parentId = null, beforeId = null } = {}) {
  // Reject cycles.
  if (parentId === id) throw new Error("cannot make a bookmark its own parent");
  if (parentId) {
    const descendants = collectDescendantIds(db, id);
    if (descendants.has(parentId)) {
      throw new Error("cannot move bookmark under one of its descendants");
    }
  }
  const target = db
    .prepare("SELECT id, parent_id AS parentId FROM bookmarks WHERE id = ?")
    .get(id);
  if (!target) throw new Error(`bookmark not found: ${id}`);
  const oldParent = target.parentId ?? null;

  const tx = db.transaction(() => {
    const siblings = db
      .prepare(
        `SELECT id FROM bookmarks WHERE parent_id IS ? AND id != ?
         ORDER BY sort_order, rowid`,
      )
      .all(parentId, id)
      .map((r) => r.id);
    let insertAt = siblings.length;
    if (beforeId) {
      const idx = siblings.indexOf(beforeId);
      if (idx >= 0) insertAt = idx;
    }
    siblings.splice(insertAt, 0, id);

    db.prepare("UPDATE bookmarks SET parent_id = ? WHERE id = ?").run(parentId, id);
    const upd = db.prepare("UPDATE bookmarks SET sort_order = ? WHERE id = ?");
    siblings.forEach((sid, i) => upd.run(i, sid));

    if (oldParent !== parentId) {
      const oldSiblings = db
        .prepare(
          `SELECT id FROM bookmarks WHERE parent_id IS ?
           ORDER BY sort_order, rowid`,
        )
        .all(oldParent)
        .map((r) => r.id);
      oldSiblings.forEach((sid, i) => upd.run(i, sid));
    }
  });
  tx();
}

function collectDescendantIds(db, rootId) {
  const out = new Set();
  const stack = [rootId];
  const stmt = db.prepare("SELECT id FROM bookmarks WHERE parent_id = ?");
  while (stack.length) {
    const cur = stack.pop();
    for (const row of stmt.all(cur)) {
      out.add(row.id);
      stack.push(row.id);
    }
  }
  return out;
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
