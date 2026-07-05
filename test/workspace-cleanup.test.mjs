// Unit tests for src/main/workspace-cleanup.js (ADR-0027).
//
// Two halves, same style as sidecar-sweep.test.mjs:
//   1. pure decision helpers (decideRetention / resolvePredecessorProtection)
//   2. real-file scan: temp dir + real .kpdf3 files built from schema.sql,
//      table-driven "edit kind × candidate?" coverage for inspectWorkspaceDb
//      (the same shape as the byte-copy gate tests — every new
//      workspace-only edit kind must add a row here).
//
// Runs under plain Node (better-sqlite3 works in both ABIs here).

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import {
  monthsAgoMs,
  decideRetention,
  resolvePredecessorProtection,
  inspectWorkspaceDb,
  scanWorkspaces,
  DEFAULT_RETENTION_MONTHS,
} from "../src/main/workspace-cleanup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, "..", "schema", "schema.sql"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

// Fixed "now" so month arithmetic is deterministic.
const NOW = Date.parse("2026-07-05T12:00:00Z");
const MONTH_OPTS = { nowMs: NOW, retentionMonths: DEFAULT_RETENTION_MONTHS };
const daysAgo = (n) => NOW - n * 24 * 3600 * 1000;

// -------------------------------------------------------------------
console.log("[1] decideRetention — pure rules");
// -------------------------------------------------------------------
{
  let r = decideRetention({ isOpen: true, hasEdits: true, lastAccessMs: daysAgo(400) }, MONTH_OPTS);
  ok(!r.candidate && r.reason === "open", "open tab is kept even when ancient");

  r = decideRetention({ isOpen: false, hasEdits: false, lastAccessMs: daysAgo(0) }, MONTH_OPTS);
  ok(r.candidate && r.reason === "opened-only", "opened-only is a candidate even when brand new");

  r = decideRetention({ isOpen: false, hasEdits: true, lastAccessMs: daysAgo(10) }, MONTH_OPTS);
  ok(!r.candidate && r.reason === "recent", "edited + recent is kept");

  r = decideRetention({ isOpen: false, hasEdits: true, lastAccessMs: daysAgo(120) }, MONTH_OPTS);
  ok(r.candidate && r.reason === "stale", "edited + 120 days old is stale under N=3");

  r = decideRetention(
    { isOpen: false, hasEdits: true, lastAccessMs: daysAgo(120) },
    { nowMs: NOW, retentionMonths: 6 },
  );
  ok(!r.candidate && r.reason === "recent", "same age survives under N=6");

  // Boundary: exactly on the cutoff is NOT stale (strict <).
  const cutoff = monthsAgoMs(NOW, 3);
  r = decideRetention({ isOpen: false, hasEdits: true, lastAccessMs: cutoff }, MONTH_OPTS);
  ok(!r.candidate, "lastAccess exactly at cutoff is kept");
  r = decideRetention({ isOpen: false, hasEdits: true, lastAccessMs: cutoff - 1 }, MONTH_OPTS);
  ok(r.candidate, "1ms older than cutoff is a candidate");
}

// -------------------------------------------------------------------
console.log("[2] resolvePredecessorProtection — lineage fixpoint");
// -------------------------------------------------------------------
{
  // kept referrer protects its predecessor
  let p = resolvePredecessorProtection([
    { id: "flat", predecessorId: "master", candidate: false },
    { id: "master", predecessorId: null, candidate: true },
  ]);
  ok(p.has("master"), "predecessor of a KEPT workspace is protected");

  // candidate referrer does NOT protect — both go together
  p = resolvePredecessorProtection([
    { id: "flat", predecessorId: "master", candidate: true },
    { id: "master", predecessorId: null, candidate: true },
  ]);
  ok(!p.has("master"), "predecessor of a candidate referrer is NOT protected");

  // chain: kept A → B → C protects the whole chain (fixpoint)
  p = resolvePredecessorProtection([
    { id: "a", predecessorId: "b", candidate: false },
    { id: "b", predecessorId: "c", candidate: true },
    { id: "c", predecessorId: null, candidate: true },
  ]);
  ok(p.has("b") && p.has("c"), "multi-hop lineage is protected transitively");

  // dangling predecessor id (file already gone) is a no-op
  p = resolvePredecessorProtection([
    { id: "a", predecessorId: "ghost", candidate: false },
  ]);
  ok(p.size === 0, "dangling predecessor reference is ignored");
}

// -------------------------------------------------------------------
// Real-file half: build actual .kpdf3 workspaces in a temp dir.
// -------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "kpdf3-cleanup-"));

/**
 * Create a real workspace file. `edit` mutates the open db to apply one
 * edit kind. mtimeDaysAgo back-dates the file like an untouched old case.
 */
function makeWorkspace(id, { edit = null, predecessorId = null, mtimeDaysAgo = 0 } = {}) {
  const path = join(dir, `${id}.kpdf3`);
  const db = new Database(path);
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO source_pdf (id, file_name, blob, byte_size, page_count, fingerprint) VALUES (1, ?, ?, ?, 1, ?)",
  ).run(`${id}.pdf`, Buffer.from("%PDF-fake"), 9, `fp-${id}`);
  db.prepare(
    "INSERT INTO pages (page_no, media_x, media_y, media_w, media_h, crop_x, crop_y, crop_w, crop_h) VALUES (1, 0, 0, 595, 842, 0, 0, 595, 842)",
  ).run();
  if (predecessorId) {
    db.prepare("INSERT INTO metadata (key, value) VALUES ('predecessor_workspace_id', ?)").run(predecessorId);
  }
  if (edit) edit(db);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  if (mtimeDaysAgo) {
    const t = new Date(daysAgo(mtimeDaysAgo));
    utimesSync(path, t, t);
  }
  return path;
}

const EDIT_KINDS = {
  overlay: (db) =>
    db
      .prepare(
        "INSERT INTO overlays (id, page_no, type, x, y, w, h, properties) VALUES ('o1', 1, 'text', 0, 0, 10, 10, '{}')",
      )
      .run(),
  pageDelete: (db) => db.prepare("UPDATE pages SET is_deleted = 1 WHERE page_no = 1").run(),
  userRotation: (db) => db.prepare("UPDATE pages SET user_rotation = 90 WHERE page_no = 1").run(),
  reorder: (db) => db.prepare("UPDATE pages SET display_order = 2 WHERE page_no = 1").run(),
  insertedPage: (db) =>
    db.prepare("INSERT INTO inserted_pages (after_page_no, text) VALUES (0, 'blank')").run(),
  bookmark: (db) =>
    db.prepare("INSERT INTO bookmarks (id, title, page_no) VALUES ('b1', 'ch1', 1)").run(),
};

try {
  // -----------------------------------------------------------------
  console.log("[3] inspectWorkspaceDb — edit kind × hasEdits (table-driven)");
  // -----------------------------------------------------------------
  {
    const path = makeWorkspace("pristine");
    const db = new Database(path, { readonly: true });
    const info = inspectWorkspaceDb(db);
    db.close();
    ok(info.hasEdits === false, "pristine workspace: hasEdits = false");
    ok(info.sourceName === "pristine.pdf", "sourceName read from source_pdf");
    ok(info.predecessorId === null, "no lineage → predecessorId null");
  }
  for (const [kind, edit] of Object.entries(EDIT_KINDS)) {
    const path = makeWorkspace(`edit-${kind}`, { edit });
    const db = new Database(path, { readonly: true });
    const info = inspectWorkspaceDb(db);
    db.close();
    ok(info.hasEdits === true, `edit kind "${kind}": hasEdits = true`);
  }
  {
    const path = makeWorkspace("has-pred", { predecessorId: "some-master" });
    const db = new Database(path, { readonly: true });
    const info = inspectWorkspaceDb(db);
    db.close();
    ok(info.predecessorId === "some-master", "predecessor_workspace_id is surfaced");
  }

  // -----------------------------------------------------------------
  console.log("[4] scanWorkspaces — end-to-end classification");
  // -----------------------------------------------------------------
  {
    // fresh temp dir per scenario keeps the fixture readable
    const sdir = mkdtempSync(join(tmpdir(), "kpdf3-cleanup-scan-"));
    const mk = (id, opts) => {
      const path = join(sdir, `${id}.kpdf3`);
      const db = new Database(path);
      db.exec(SCHEMA);
      db.prepare(
        "INSERT INTO source_pdf (id, file_name, blob, byte_size, page_count, fingerprint) VALUES (1, ?, ?, ?, 1, ?)",
      ).run(`${id}.pdf`, Buffer.from("%PDF-fake"), 9, `fp-${id}`);
      db.prepare(
        "INSERT INTO pages (page_no, media_x, media_y, media_w, media_h, crop_x, crop_y, crop_w, crop_h) VALUES (1, 0, 0, 595, 842, 0, 0, 595, 842)",
      ).run();
      if (opts?.predecessorId)
        db.prepare("INSERT INTO metadata (key, value) VALUES ('predecessor_workspace_id', ?)").run(
          opts.predecessorId,
        );
      if (opts?.edit) opts.edit(db);
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
      if (opts?.mtimeDaysAgo) {
        const t = new Date(daysAgo(opts.mtimeDaysAgo));
        utimesSync(path, t, t);
      }
    };

    mk("opened-only-new", {}); // candidate (opened-only, age irrelevant)
    mk("edited-recent", { edit: EDIT_KINDS.overlay, mtimeDaysAgo: 10 }); // kept
    mk("edited-old", { edit: EDIT_KINDS.overlay, mtimeDaysAgo: 200 }); // candidate (stale)
    mk("old-master", { edit: EDIT_KINDS.overlay, mtimeDaysAgo: 400 }); // stale BUT predecessor of kept
    mk("flat-recent", { edit: EDIT_KINDS.overlay, mtimeDaysAgo: 5, predecessorId: "old-master" });
    mk("open-old", { edit: EDIT_KINDS.overlay, mtimeDaysAgo: 300 }); // stale BUT open in a tab
    mk("registry-fresh", { edit: EDIT_KINDS.overlay, mtimeDaysAgo: 300 }); // stale mtime, fresh registry
    writeFileSync(join(sdir, "garbage.kpdf3"), "this is not sqlite"); // unreadable → kept

    const regDate = new Date(daysAgo(2))
      .toISOString()
      .replace("T", " ")
      .slice(0, 19); // sqlite datetime format, UTC
    const res = scanWorkspaces({
      dir: sdir,
      retentionMonths: 3,
      nowMs: NOW,
      openWorkspaceIds: ["open-old"],
      registryRows: [{ workspaceId: "registry-fresh", updatedAt: regDate, sourcePdfName: null }],
    });

    const ids = res.candidates.map((c) => c.id).sort();
    ok(
      JSON.stringify(ids) === JSON.stringify(["edited-old", "opened-only-new"]),
      `candidates are exactly [edited-old, opened-only-new] (got [${ids}])`,
    );
    ok(res.keptPredecessors === 1, "old-master kept via predecessor protection");
    ok(res.keptOpen === 1, "open-old kept because its tab is open");
    ok(res.unreadable === 1, "garbage.kpdf3 counted unreadable, never a candidate");
    ok(res.scanned === 7, "scanned counts readable workspaces only");
    ok(
      res.totalCandidateBytes === res.candidates.reduce((s, c) => s + c.sizeBytes, 0) &&
        res.totalCandidateBytes > 0,
      "totalCandidateBytes sums candidate sizes",
    );
    const openedOnly = res.candidates.find((c) => c.id === "opened-only-new");
    ok(openedOnly.reason === "opened-only" && openedOnly.hasEdits === false, "reason/hasEdits surfaced for UI");
    ok(res.candidates[0].id === "edited-old", "candidates sorted oldest-first");

    // registry updated_at (fresh) must override the stale file mtime
    ok(
      !ids.includes("registry-fresh"),
      "fresh registry updated_at overrides stale mtime (kept as recent)",
    );

    rmSync(sdir, { recursive: true, force: true });
  }

  // -----------------------------------------------------------------
  console.log("[5] scanWorkspaces — missing dir is a no-op");
  // -----------------------------------------------------------------
  {
    const res = scanWorkspaces({
      dir: join(dir, "does-not-exist"),
      retentionMonths: 3,
      nowMs: NOW,
    });
    ok(res.candidates.length === 0 && res.scanned === 0, "missing dir scans to empty without throwing");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`=== Result: ${pass} pass, ${fail} fail ===`);
process.exitCode = fail > 0 ? 1 : 0;
