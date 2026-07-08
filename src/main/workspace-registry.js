// Workspace registry (ADR-0007).
//
// Maps the SHA-256 fingerprint of a source PDF to the path of the
// `.kpdf3` workspace file that holds its overlays. The registry lives
// at `<userData>/index.db`, the workspace files at
// `<userData>/workspaces/{id}.kpdf3`. Both paths are app-private —
// the user never sees them in their PDF directories.

import Database from "better-sqlite3";
import { app } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** @type {import("better-sqlite3").Database | null} */
let _db = null;

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** Lazy-open the index database. The DDL is idempotent. */
function getDb() {
  if (_db) return _db;
  const userDir = app.getPath("userData");
  ensureDir(userDir);
  const dbPath = join(userDir, "index.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS pdf_workspaces (
      fingerprint     TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL UNIQUE,
      workspace_path  TEXT NOT NULL,
      source_pdf_path TEXT,
      source_pdf_name TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return _db;
}

/** Path of the directory holding all workspace files. Created on demand. */
export function workspacesDir() {
  const dir = join(app.getPath("userData"), "workspaces");
  ensureDir(dir);
  return dir;
}

/**
 * Generate a workspace id of the form
 *   YYYYMMDD-HHMMSS_xxxxxxxx
 * sortable by date, suffix random for uniqueness.
 */
export function generateWorkspaceId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const short = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${stamp}_${short}`;
}

/** Convenience: full path to a workspace file with the given id. */
export function workspacePathFor(id) {
  return join(workspacesDir(), `${id}.kpdf3`);
}

/**
 * @param {string} fingerprint
 * @returns {{
 *   fingerprint: string,
 *   workspaceId: string,
 *   workspacePath: string,
 *   sourcePdfPath: string | null,
 *   sourcePdfName: string | null,
 *   createdAt: string,
 *   updatedAt: string,
 * } | null}
 */
export function findWorkspaceByFingerprint(fingerprint) {
  const row = getDb()
    .prepare(`
      SELECT
        fingerprint,
        workspace_id    AS workspaceId,
        workspace_path  AS workspacePath,
        source_pdf_path AS sourcePdfPath,
        source_pdf_name AS sourcePdfName,
        created_at      AS createdAt,
        updated_at      AS updatedAt
      FROM pdf_workspaces
      WHERE fingerprint = ?
    `)
    .get(fingerprint);
  if (!row) return null;
  // workspace_path は登録時の絶対パスなので、userData を移動した環境
  // (Mac 移行 / PC 買い替え / userData 引越し) では stale になり、呼び出し側の
  // existsSync 不成立 → 新規 workspace 作成 = 既存 overlay が「消えた」ように
  // 見える。workspace ファイルの置き場所は「現在の workspacesDir/{id}.kpdf3」
  // が規約なので、stale のときだけ id 導出パスを試し、見つかれば行を自己修復。
  if (!existsSync(row.workspacePath)) {
    const derived = workspacePathFor(row.workspaceId);
    if (derived !== row.workspacePath && existsSync(derived)) {
      getDb()
        .prepare("UPDATE pdf_workspaces SET workspace_path = ? WHERE fingerprint = ?")
        .run(derived, fingerprint);
      row.workspacePath = derived;
    }
  }
  return row;
}

/**
 * Insert (or overwrite on conflict) a registry row.
 *
 * @param {object} entry
 * @param {string} entry.fingerprint
 * @param {string} entry.workspaceId
 * @param {string} entry.workspacePath
 * @param {string | null} [entry.sourcePdfPath]
 * @param {string | null} [entry.sourcePdfName]
 */
export function registerWorkspace(entry) {
  getDb()
    .prepare(`
      INSERT INTO pdf_workspaces
        (fingerprint, workspace_id, workspace_path, source_pdf_path, source_pdf_name)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        workspace_id    = excluded.workspace_id,
        workspace_path  = excluded.workspace_path,
        source_pdf_path = excluded.source_pdf_path,
        source_pdf_name = excluded.source_pdf_name,
        updated_at      = datetime('now')
    `)
    .run(
      entry.fingerprint,
      entry.workspaceId,
      entry.workspacePath,
      entry.sourcePdfPath ?? null,
      entry.sourcePdfName ?? null,
    );
}

/** Update last-known source PDF path / name and bump updated_at. */
export function touchWorkspace(fingerprint, sourcePdfPath, sourcePdfName) {
  getDb()
    .prepare(`
      UPDATE pdf_workspaces
      SET source_pdf_path = ?, source_pdf_name = ?, updated_at = datetime('now')
      WHERE fingerprint = ?
    `)
    .run(sourcePdfPath, sourcePdfName, fingerprint);
}

/**
 * List the most-recently-touched workspaces, newest first.
 * Used to populate「最近開いた PDF」menu (M5-7).
 *
 * @param {number} [limit=10]
 * @returns {Array<{
 *   workspaceId: string,
 *   workspacePath: string,
 *   sourcePdfPath: string | null,
 *   sourcePdfName: string | null,
 *   updatedAt: string,
 * }>}
 */
export function listRecentPdfs(limit = 10) {
  return getDb()
    .prepare(`
      SELECT
        workspace_id    AS workspaceId,
        workspace_path  AS workspacePath,
        source_pdf_path AS sourcePdfPath,
        source_pdf_name AS sourcePdfName,
        updated_at      AS updatedAt
      FROM pdf_workspaces
      WHERE source_pdf_path IS NOT NULL
      ORDER BY datetime(updated_at) DESC
      LIMIT ?
    `)
    .all(limit);
}

/**
 * All registry rows — feeds the ADR-0027 cleanup scan with last-access
 * times (`updated_at`) and display names.
 *
 * @returns {Array<{
 *   workspaceId: string,
 *   workspacePath: string,
 *   sourcePdfName: string | null,
 *   updatedAt: string,
 * }>}
 */
export function listAllWorkspaces() {
  return getDb()
    .prepare(`
      SELECT
        workspace_id    AS workspaceId,
        workspace_path  AS workspacePath,
        source_pdf_name AS sourcePdfName,
        updated_at      AS updatedAt
      FROM pdf_workspaces
    `)
    .all();
}

/**
 * Remove registry rows for workspaces deleted by the ADR-0027 cleanup so
 * the fingerprint index never points at trashed files.
 *
 * @param {string[]} workspaceIds
 * @returns {number} rows deleted
 */
export function deleteWorkspaceEntries(workspaceIds) {
  if (!workspaceIds?.length) return 0;
  const stmt = getDb().prepare("DELETE FROM pdf_workspaces WHERE workspace_id = ?");
  let deleted = 0;
  const run = getDb().transaction((ids) => {
    for (const id of ids) deleted += stmt.run(id).changes;
  });
  run(workspaceIds);
  return deleted;
}

/** Close the registry handle (called on app quit). */
export function closeRegistry() {
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
