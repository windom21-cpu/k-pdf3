// Orphan source-sidecar cleanup (stable 残務 #7).
//
// β.134 stores an oversized (>200MB) source PDF's bytes in a sidecar file
// `{id}.kpdf3.source.pdf` next to its workspace DB `{id}.kpdf3`, recording
// the path in `source_pdf.external_path`. If the workspace file is later
// removed — e.g. an overwrite "new" flow (`openWorkspace({force:true})`) or
// a manual deletion — the sidecar is left behind as a confirmed orphan:
// `Workspace.getSourceBytes()` only reaches it via the workspace DB's
// `external_path` row, so with no `.kpdf3` it can never be read again and
// merely wastes disk (potentially hundreds of MB for a court-copy PDF).
//
// This module is intentionally dependency-free (only node:fs / node:path,
// no Electron import) and takes the directory as an argument, so it stays
// unit-testable under plain Node.

import { readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Pure helper. Given the base names present in a directory, return the
 * subset of β.134 source sidecars (`{id}.kpdf3.source.pdf`) whose owning
 * workspace file (`{id}.kpdf3`) is ABSENT from the same directory.
 *
 * Sidecars whose `.kpdf3` still exists are NOT returned — we never delete a
 * sidecar that a live workspace might still resolve via `external_path`.
 *
 * @param {string[]} fileNames  base names found in the directory
 * @returns {string[]} base names of orphaned sidecars
 */
export function findOrphanSourceSidecars(fileNames) {
  const SUFFIX = ".source.pdf";
  const present = new Set(fileNames);
  return fileNames.filter((name) => {
    if (!name.endsWith(".kpdf3" + SUFFIX)) return false;
    const owner = name.slice(0, -SUFFIX.length); // → "{id}.kpdf3"
    return !present.has(owner);
  });
}

/**
 * Pure helper. Given the base names present in a directory, return the
 * subset of SQLite companion files (`{id}.kpdf3-wal` / `{id}.kpdf3-shm`)
 * whose owning workspace file (`{id}.kpdf3`) is ABSENT.
 *
 * Companions whose `.kpdf3` still exists are NOT returned — a live wal may
 * hold committed-but-not-yet-checkpointed data, so only the ownerless ones
 * (which SQLite can never read again) are disposable.
 *
 * Background: v2.0.12-beta.2 の「ワークスペースの整理」は `.kpdf3` 本体と
 * `.source.pdf` をごみ箱に移す一方 `-wal`/`-shm` を道連れにしていなかった
 * (2026-07-05 の実行で孤児 1,338 組が残存、K-SystemZ 側バックアップ調査で
 * 発覚)。execute 側の道連れ (main.js) と、この起動時掃除の両輪で塞ぐ。
 *
 * @param {string[]} fileNames  base names found in the directory
 * @returns {string[]} base names of orphaned wal/shm companions
 */
export function findOrphanWalShm(fileNames) {
  const present = new Set(fileNames);
  return fileNames.filter((name) => {
    let owner = null;
    if (name.endsWith(".kpdf3-wal")) owner = name.slice(0, -"-wal".length);
    else if (name.endsWith(".kpdf3-shm")) owner = name.slice(0, -"-shm".length);
    else return false;
    return !present.has(owner);
  });
}

/**
 * Best-effort sweep of orphaned wal/shm companions under `dir`. Same
 * contract as sweepOrphanSourceSidecars: startup-safe, per-file failures
 * swallowed, never touches a companion whose `.kpdf3` is still present.
 *
 * @param {string} dir  absolute path to the workspaces directory
 * @returns {{ removed: number, freedBytes: number }}
 */
export function sweepOrphanWalShm(dir) {
  let removed = 0;
  let freedBytes = 0;
  try {
    const orphans = findOrphanWalShm(readdirSync(dir));
    for (const name of orphans) {
      const full = join(dir, name);
      try {
        let size = 0;
        try { size = statSync(full).size; } catch { /* size best-effort */ }
        rmSync(full, { force: true });
        removed++;
        freedBytes += size;
      } catch { /* per-file best-effort */ }
    }
  } catch { /* dir missing / unreadable → nothing to sweep */ }
  return { removed, freedBytes };
}

/**
 * Best-effort sweep of orphaned source sidecars under `dir`. Safe to call
 * on every startup: it deletes only `*.kpdf3.source.pdf` files whose
 * sibling `*.kpdf3` is missing, and never touches workspace files
 * themselves. Per-file failures are swallowed so a single locked / vanished
 * file can't abort the rest.
 *
 * NOTE: accumulated EMPTY `.kpdf3` workspaces are intentionally NOT swept —
 * those hold user overlay work and removing them needs a retention policy.
 *
 * ADR-0026 caveat: this sweep only removes ORPHAN `.source.pdf` sidecars
 * (owner `.kpdf3` absent), so an editable master (`{id}.kpdf3` kept alive as
 * a 確定 predecessor) and its sidecar are already safe here. But any FUTURE
 * "orphan / empty workspace sweep" MUST skip workspaces referenced as a
 * `predecessor_workspace_id`, or「編集可能な状態に戻す」silently breaks.
 *
 * @param {string} dir  absolute path to the workspaces directory
 * @returns {{ removed: number, freedBytes: number }}
 */
export function sweepOrphanSourceSidecars(dir) {
  let removed = 0;
  let freedBytes = 0;
  try {
    const orphans = findOrphanSourceSidecars(readdirSync(dir));
    for (const name of orphans) {
      const full = join(dir, name);
      try {
        let size = 0;
        try { size = statSync(full).size; } catch { /* size best-effort */ }
        rmSync(full, { force: true });
        removed++;
        freedBytes += size;
      } catch { /* per-file best-effort */ }
    }
  } catch { /* dir missing / unreadable → nothing to sweep */ }
  return { removed, freedBytes };
}
