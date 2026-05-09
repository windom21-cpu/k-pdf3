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
  return row ?? null;
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
