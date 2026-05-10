// Global stamp preset store.
//
// Stamp presets (date / text / image) used to live inside each workspace
// (.kpdf3) under `stamp_presets`, which made registered stamps invisible
// from any other PDF. β testers expected stamps to be a user-level tool
// reused across every document, so this module hosts a *global* SQLite
// db at `<userData>/stamps.db` that serves all workspaces.
//
// Image stamp bytes also live here (mirror `assets` table). Workspace
// `getAsset()` is wrapped in main.js so a missing-from-workspace lookup
// falls back to this store — overlays placed before / after the move
// continue to render without copying bytes around.

import Database from "better-sqlite3";
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  addAsset,
  getAsset,
  removeAsset,
  listAssets,
  addStampPreset,
  removeStampPreset,
  listStampPresets,
} from "../backend/sqlite-store.js";

/** @type {import("better-sqlite3").Database | null} */
let _db = null;

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** Lazy-open the global stamps database. Schema is bootstrapped on
 *  first access — kept in sync with the workspace-side definitions in
 *  schema/schema.sql + sqlite-store.migrateStampPresetsTable. */
function getDb() {
  if (_db) return _db;
  const userDir = app.getPath("userData");
  ensureDir(userDir);
  const dbPath = join(userDir, "stamps.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id          TEXT PRIMARY KEY,
      hash        TEXT NOT NULL UNIQUE,
      mime        TEXT NOT NULL,
      blob        BLOB NOT NULL,
      width       INTEGER,
      height      INTEGER,
      label       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
  return _db;
}

export function listStampPresetsGlobal() {
  return listStampPresets(getDb());
}

export function addStampPresetGlobal(preset) {
  return addStampPreset(getDb(), preset ?? {});
}

export function removeStampPresetGlobal(id) {
  removeStampPreset(getDb(), id);
}

export function addStampAssetGlobal(opts) {
  return addAsset(getDb(), opts);
}

export function getStampAssetGlobal(id) {
  return getAsset(getDb(), id);
}

export function removeStampAssetGlobal(id) {
  removeAsset(getDb(), id);
}

export function listStampAssetsGlobal() {
  return listAssets(getDb());
}

/** Convenience used by the renderer's "pick image file" path. Reads the
 *  bytes synchronously, sniffs mime from the extension, and inserts. */
export function addStampAssetFromFileGlobal(filePath, label = null) {
  const buf = readFileSync(filePath);
  const ext = (filePath.toLowerCase().split(".").pop() ?? "").trim();
  const mime =
    ext === "png" ? "image/png" :
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
    "application/octet-stream";
  const id = addAsset(getDb(), {
    mime,
    blob: new Uint8Array(buf),
    label,
  });
  return { id, mime, label };
}

/** Migrate a workspace's stamp_presets (and referenced image assets)
 *  into the global store, ONLY if the global store is currently empty.
 *  Called every time a workspace opens so β testers who registered
 *  stamps under the old per-workspace design see them in the global
 *  palette on first run. Idempotent — once anything has been written
 *  globally this returns 0. */
export function migrateFromWorkspaceIfEmpty(workspace) {
  if (!workspace || typeof workspace.listStampPresets !== "function") return 0;
  const gdb = getDb();
  const existing = gdb.prepare("SELECT COUNT(*) AS n FROM stamp_presets").get();
  if ((existing?.n ?? 0) > 0) return 0;
  const presets = workspace.listStampPresets();
  if (!presets || presets.length === 0) return 0;
  let copied = 0;
  for (const p of presets) {
    let assetId = p.assetId ?? null;
    if (assetId) {
      const a = workspace.getAsset(assetId);
      if (a) {
        // addAsset assigns a fresh UUID even on dedupe-by-hash misses,
        // so we always re-resolve the new id and push it onto the
        // preset row we copy across.
        assetId = addAsset(gdb, {
          mime: a.mime,
          blob: a.blob,
          width: a.width,
          height: a.height,
          label: a.label,
        });
      } else {
        assetId = null;
      }
    }
    addStampPreset(gdb, { ...p, assetId });
    copied += 1;
  }
  return copied;
}

export function closeStampStore() {
  if (_db) {
    try {
      _db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore */
    }
    _db.close();
    _db = null;
  }
}
