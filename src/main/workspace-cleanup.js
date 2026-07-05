// Manual workspace retention sweep (ADR-0027).
//
// Scans `userData/workspaces/*.kpdf3` and classifies each workspace:
//   - referenced as a `predecessor_workspace_id` by a KEPT workspace → keep
//     (deleting it would break ADR-0026「編集可能な状態に戻す」)
//   - currently open in a tab → keep
//   - "opened only" (no overlays / deletions / insertions / rotations /
//     reorders / bookmarks) → delete candidate regardless of age
//   - edited → delete candidate only when last access is older than the
//     retention window (N months, user-picked at run time)
//
// Deletion itself is NOT performed here — the caller (main.js) moves the
// files to the OS trash via `shell.trashItem` and removes the matching
// `index.db` rows, so this module stays unit-testable under plain Node
// (same philosophy as sidecar-sweep.js; better-sqlite3 works in both ABIs).

import Database from "better-sqlite3";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const RETENTION_MONTH_CHOICES = [3, 6, 12];
export const DEFAULT_RETENTION_MONTHS = 3;

/** Calendar-correct "N months before nowMs" in epoch ms. */
export function monthsAgoMs(nowMs, months) {
  const d = new Date(nowMs);
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

/**
 * Inspect one workspace DB (opened read-only by the caller). Never throws:
 * a query failure on any single axis is treated as "edited" so uncertain
 * workspaces are never classified as disposable "opened only".
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {{ predecessorId: string | null, hasEdits: boolean, sourceName: string | null }}
 */
export function inspectWorkspaceDb(db) {
  const count = (sql) => {
    try {
      return db.prepare(sql).get()?.n ?? 0;
    } catch {
      return -1; // unknown → conservative (counts as edits below)
    }
  };
  let predecessorId = null;
  try {
    predecessorId =
      db
        .prepare("SELECT value FROM metadata WHERE key = 'predecessor_workspace_id'")
        .get()?.value ?? null;
  } catch {
    /* metadata unreadable → no lineage info */
  }
  let sourceName = null;
  try {
    sourceName = db.prepare("SELECT file_name FROM source_pdf WHERE id = 1").get()?.file_name ?? null;
  } catch {
    /* ignore */
  }
  const axes = [
    count("SELECT COUNT(*) AS n FROM overlays"),
    count("SELECT COUNT(*) AS n FROM inserted_pages"),
    count("SELECT COUNT(*) AS n FROM bookmarks"),
    count("SELECT COUNT(*) AS n FROM pages WHERE is_deleted = 1"),
    count("SELECT COUNT(*) AS n FROM pages WHERE user_rotation != 0"),
    count("SELECT COUNT(*) AS n FROM pages WHERE display_order IS NOT NULL"),
  ];
  const hasEdits = axes.some((n) => n !== 0); // -1 (unknown) counts as edits
  return { predecessorId, hasEdits, sourceName };
}

/**
 * Pure retention decision for one workspace, BEFORE predecessor protection
 * (which needs the whole set — see resolvePredecessorProtection).
 *
 * @param {{ isOpen: boolean, hasEdits: boolean, lastAccessMs: number }} info
 * @param {{ nowMs: number, retentionMonths: number }} opts
 * @returns {{ candidate: boolean, reason: "open" | "opened-only" | "stale" | "recent" }}
 */
export function decideRetention(info, opts) {
  if (info.isOpen) return { candidate: false, reason: "open" };
  if (!info.hasEdits) return { candidate: true, reason: "opened-only" };
  const cutoffMs = monthsAgoMs(opts.nowMs, opts.retentionMonths);
  return info.lastAccessMs < cutoffMs
    ? { candidate: true, reason: "stale" }
    : { candidate: false, reason: "recent" };
}

/**
 * ADR-0027 §Consequences 3: a predecessor is protected as long as ANY kept
 * workspace references it; if the referrer itself is a candidate, both may
 * go in the same run. Fixpoint over lineage chains (確定を重ねた多段参照).
 *
 * @param {Array<{ id: string, predecessorId: string | null, candidate: boolean }>} items
 * @returns {Set<string>} ids protected as predecessors (removed from candidates)
 */
export function resolvePredecessorProtection(items) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const protectedIds = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const it of items) {
      const kept = !it.candidate || protectedIds.has(it.id);
      if (!kept || !it.predecessorId) continue;
      const pred = byId.get(it.predecessorId);
      if (pred && pred.candidate && !protectedIds.has(pred.id)) {
        protectedIds.add(pred.id);
        changed = true;
      }
    }
  }
  return protectedIds;
}

/**
 * Scan a workspaces directory and compute delete candidates.
 * Read-only: opens each `.kpdf3` with `readonly: true` and never mutates
 * anything. Unreadable workspaces are kept and reported, never candidates.
 *
 * @param {object} opts
 * @param {string} opts.dir absolute path to the workspaces directory
 * @param {number} opts.retentionMonths retention window for edited workspaces
 * @param {number} opts.nowMs current time (injectable for tests)
 * @param {string[]} [opts.openWorkspaceIds] workspace ids currently open in tabs
 * @param {Array<{ workspaceId: string, updatedAt: string, sourcePdfName: string | null }>}
 *   [opts.registryRows] rows from index.db (workspace-registry) for
 *   last-access and display names
 * @returns {{
 *   candidates: Array<{
 *     id: string, path: string, sizeBytes: number, lastAccessMs: number,
 *     hasEdits: boolean, reason: "opened-only" | "stale", sourceName: string | null,
 *   }>,
 *   totalCandidateBytes: number,
 *   scanned: number,
 *   keptPredecessors: number,
 *   keptOpen: number,
 *   keptRecent: number,
 *   unreadable: number,
 * }}
 */
export function scanWorkspaces(opts) {
  const {
    dir,
    retentionMonths,
    nowMs,
    openWorkspaceIds = [],
    registryRows = [],
  } = opts;
  const openSet = new Set(openWorkspaceIds);
  const registryById = new Map(registryRows.map((r) => [r.workspaceId, r]));

  let names = [];
  try {
    names = readdirSync(dir).filter(
      (n) => n.endsWith(".kpdf3") && !n.endsWith(".kpdf3.source.pdf"),
    );
  } catch {
    /* dir missing → nothing to scan */
  }

  const items = [];
  let unreadable = 0;
  for (const name of names) {
    const id = name.slice(0, -".kpdf3".length);
    const path = join(dir, name);
    let sizeBytes = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(path);
      sizeBytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      unreadable++;
      continue;
    }
    let inspected;
    let db = null;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
      // The open above is lazy — force a real read so a corrupt / non-SQLite
      // file lands in the unreadable bucket instead of masquerading as
      // "edited" via inspectWorkspaceDb's defensive catches.
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get();
      inspected = inspectWorkspaceDb(db);
    } catch {
      unreadable++;
      continue;
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
    const reg = registryById.get(id);
    // registry updated_at is sqlite datetime('now') = "YYYY-MM-DD HH:MM:SS" in UTC
    const regMs = reg?.updatedAt
      ? Date.parse(reg.updatedAt.replace(" ", "T") + (reg.updatedAt.endsWith("Z") ? "" : "Z")) || 0
      : 0;
    const lastAccessMs = Math.max(mtimeMs, regMs);
    const { candidate, reason } = decideRetention(
      { isOpen: openSet.has(id), hasEdits: inspected.hasEdits, lastAccessMs },
      { nowMs, retentionMonths },
    );
    items.push({
      id,
      path,
      sizeBytes,
      lastAccessMs,
      hasEdits: inspected.hasEdits,
      sourceName: inspected.sourceName ?? reg?.sourcePdfName ?? null,
      predecessorId: inspected.predecessorId,
      candidate,
      reason,
    });
  }

  const protectedIds = resolvePredecessorProtection(items);

  const candidates = [];
  let keptPredecessors = 0;
  let keptOpen = 0;
  let keptRecent = 0;
  let totalCandidateBytes = 0;
  for (const it of items) {
    if (it.candidate && protectedIds.has(it.id)) {
      keptPredecessors++;
      continue;
    }
    if (!it.candidate) {
      if (it.reason === "open") keptOpen++;
      else if (it.reason === "recent") keptRecent++;
      // opened-only/stale can't be non-candidates; predecessor keeps counted above
      continue;
    }
    totalCandidateBytes += it.sizeBytes;
    candidates.push({
      id: it.id,
      path: it.path,
      sizeBytes: it.sizeBytes,
      lastAccessMs: it.lastAccessMs,
      hasEdits: it.hasEdits,
      reason: it.reason,
      sourceName: it.sourceName,
    });
  }
  // Oldest first — the least-recently-used work floats to the top of the list.
  candidates.sort((a, b) => a.lastAccessMs - b.lastAccessMs);

  return {
    candidates,
    totalCandidateBytes,
    scanned: items.length,
    keptPredecessors,
    keptOpen,
    keptRecent,
    unreadable,
  };
}
