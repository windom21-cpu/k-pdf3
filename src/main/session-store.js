// Session persistence for restore-after-update.
//
// Remembers which source PDFs were open and the app version that wrote the
// record. On the next boot the caller compares the stored version with the
// running one: if they differ an update happened, so the remembered files
// are restored. A normal same-version restart restores nothing (the user
// starts fresh, exactly as before this feature).
//
// Electron-independent (the userData dir is injected) so it can be unit
// tested in plain Node — same pattern as sidecar-sweep.js.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_FILE = "session.json";

function sessionPath(dir) {
  return join(dir, SESSION_FILE);
}

/** Sanitize a candidate file list into a deduped array of non-empty strings. */
function cleanFiles(files) {
  if (!Array.isArray(files)) return [];
  return [...new Set(files.filter((p) => typeof p === "string" && p.length > 0))];
}

/** Read the persisted session. Missing / corrupt file → empty session. */
export function readSession(dir) {
  try {
    const j = JSON.parse(readFileSync(sessionPath(dir), "utf8"));
    return {
      version: typeof j?.version === "string" ? j.version : null,
      openFiles: cleanFiles(j?.openFiles),
    };
  } catch {
    return { version: null, openFiles: [] };
  }
}

/** Persist the session (single writeFileSync). Returns the JSON written. */
export function writeSession(dir, { version, openFiles }) {
  const payload = JSON.stringify({
    version: typeof version === "string" ? version : null,
    openFiles: cleanFiles(openFiles),
  });
  writeFileSync(sessionPath(dir), payload, "utf8");
  return payload;
}

/**
 * Decide what to restore on boot. Restore only when the app version changed
 * since the session was written (= an update happened) AND there are
 * remembered files. An optional `fileExists` filter drops files that have
 * since been moved / deleted so we don't spam open errors.
 *
 * @param {{version: string|null, openFiles: string[]}} prev
 * @param {string} currentVersion
 * @param {(p: string) => boolean} [fileExists]
 * @returns {{restore: boolean, files: string[]}}
 */
export function computeRestore(prev, currentVersion, fileExists) {
  const changed = !!prev && prev.version !== currentVersion;
  let files = changed ? cleanFiles(prev.openFiles) : [];
  if (typeof fileExists === "function") files = files.filter(fileExists);
  return { restore: changed && files.length > 0, files };
}
