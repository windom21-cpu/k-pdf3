// sidecar-sweep unit test — orphan β.134 source-sidecar cleanup (残務 #7).
//
// Covers the safety boundary: a sidecar (`{id}.kpdf3.source.pdf`) is an
// orphan ONLY when its owning workspace file (`{id}.kpdf3`) is absent. The
// IO half is exercised against a real temp dir so the actual delete /
// preserve behaviour is verified, not just the predicate.

import {
  findOrphanSourceSidecars,
  sweepOrphanSourceSidecars,
  findOrphanWalShm,
  sweepOrphanWalShm,
} from "../src/main/sidecar-sweep.js";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}
function sameSet(actual, expected, msg) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  ok(
    a.length === e.length && a.every((v, i) => v === e[i]),
    `${msg}: expected [${e.join(", ")}], got [${a.join(", ")}]`,
  );
}

console.log("=== sidecar-sweep test ===\n");

const ID_A = "20260604-101010_aaaaaaaa";
const ID_B = "20260604-202020_bbbbbbbb";

// ---- Pure predicate: findOrphanSourceSidecars ----

// 1. Sidecar whose owning .kpdf3 is MISSING → orphan.
sameSet(
  findOrphanSourceSidecars([`${ID_A}.kpdf3.source.pdf`]),
  [`${ID_A}.kpdf3.source.pdf`],
  "lone sidecar (no sibling .kpdf3) is an orphan",
);

// 2. Sidecar whose owning .kpdf3 EXISTS → NOT an orphan (never delete).
sameSet(
  findOrphanSourceSidecars([`${ID_A}.kpdf3`, `${ID_A}.kpdf3.source.pdf`]),
  [],
  "sidecar with live sibling .kpdf3 is kept",
);

// 3. Plain workspace files (and their WAL sidecars) are never orphans.
sameSet(
  findOrphanSourceSidecars([
    `${ID_A}.kpdf3`,
    `${ID_A}.kpdf3-wal`,
    `${ID_A}.kpdf3-shm`,
  ]),
  [],
  "bare .kpdf3 / -wal / -shm are not matched",
);

// 4. Mixed dir: A orphaned, B live. Only A's sidecar comes back.
sameSet(
  findOrphanSourceSidecars([
    `${ID_A}.kpdf3.source.pdf`, // orphan (no ${ID_A}.kpdf3)
    `${ID_B}.kpdf3`,
    `${ID_B}.kpdf3.source.pdf`, // kept (sibling present)
    "index.db",
    "printer-devmode-cache.json",
  ]),
  [`${ID_A}.kpdf3.source.pdf`],
  "only the sibling-less sidecar is selected from a mixed dir",
);

// 5. A .source.pdf NOT in the β.134 `{id}.kpdf3.source.pdf` layout is ignored.
sameSet(
  findOrphanSourceSidecars(["foo.source.pdf", "bar.pdf"]),
  [],
  "non-.kpdf3 .source.pdf files are ignored",
);

// 6. Empty input → empty output.
sameSet(findOrphanSourceSidecars([]), [], "empty dir yields no orphans");

// ---- Pure predicate: findOrphanWalShm ----

// 7. wal/shm whose owning .kpdf3 is MISSING → orphans (整理の消し残し).
sameSet(
  findOrphanWalShm([`${ID_A}.kpdf3-wal`, `${ID_A}.kpdf3-shm`]),
  [`${ID_A}.kpdf3-wal`, `${ID_A}.kpdf3-shm`],
  "ownerless -wal/-shm are orphans",
);

// 8. wal/shm with a live .kpdf3 → kept (live wal may hold committed data).
sameSet(
  findOrphanWalShm([`${ID_A}.kpdf3`, `${ID_A}.kpdf3-wal`, `${ID_A}.kpdf3-shm`]),
  [],
  "-wal/-shm with live sibling .kpdf3 are kept",
);

// 9. Non-companion files are never matched.
sameSet(
  findOrphanWalShm([
    `${ID_A}.kpdf3`,
    `${ID_A}.kpdf3.source.pdf`,
    "index.db",
    "index.db-wal", // index.db 随伴 — .kpdf3-wal ではないので対象外
  ]),
  [],
  ".kpdf3 / .source.pdf / index.db(-wal) are not matched",
);

// 10. Mixed dir: A orphaned, B live.
sameSet(
  findOrphanWalShm([
    `${ID_A}.kpdf3-wal`,
    `${ID_A}.kpdf3-shm`,
    `${ID_B}.kpdf3`,
    `${ID_B}.kpdf3-wal`,
  ]),
  [`${ID_A}.kpdf3-wal`, `${ID_A}.kpdf3-shm`],
  "only ownerless companions selected from a mixed dir",
);

// ---- IO half: sweepOrphanSourceSidecars against a real temp dir ----

const dir = mkdtempSync(join(tmpdir(), "kpdf3-sweep-"));
try {
  // Orphan A: sidecar with no .kpdf3 → should be deleted.
  writeFileSync(join(dir, `${ID_A}.kpdf3.source.pdf`), Buffer.alloc(2048));
  // Live B: .kpdf3 + sidecar → both must survive.
  writeFileSync(join(dir, `${ID_B}.kpdf3`), Buffer.from("KPDF"));
  writeFileSync(join(dir, `${ID_B}.kpdf3.source.pdf`), Buffer.alloc(4096));
  // Bystanders that must never be touched.
  writeFileSync(join(dir, "index.db"), Buffer.from("x"));

  const { removed, freedBytes } = sweepOrphanSourceSidecars(dir);

  ok(removed === 1, `removed exactly 1 orphan (got ${removed})`);
  ok(freedBytes === 2048, `freed the orphan's bytes (got ${freedBytes})`);
  ok(
    !existsSync(join(dir, `${ID_A}.kpdf3.source.pdf`)),
    "orphan sidecar A was deleted",
  );
  ok(existsSync(join(dir, `${ID_B}.kpdf3`)), "live workspace B kept");
  ok(
    existsSync(join(dir, `${ID_B}.kpdf3.source.pdf`)),
    "live sidecar B kept (sibling present)",
  );
  ok(existsSync(join(dir, "index.db")), "unrelated index.db untouched");

  // Idempotent: a second sweep finds nothing to do.
  const second = sweepOrphanSourceSidecars(dir);
  ok(second.removed === 0, `second sweep is a no-op (got ${second.removed})`);

  // Missing dir → graceful no-op, no throw.
  const gone = sweepOrphanSourceSidecars(join(dir, "does-not-exist"));
  ok(gone.removed === 0, "missing dir sweeps to 0 without throwing");

  // Sanity: the only files left are B's pair + index.db.
  sameSet(
    readdirSync(dir),
    [`${ID_B}.kpdf3`, `${ID_B}.kpdf3.source.pdf`, "index.db"],
    "post-sweep dir holds only the survivors",
  );

  // ---- IO half: sweepOrphanWalShm ----

  // Orphan A: wal+shm with no .kpdf3 → deleted. Live B: kept.
  writeFileSync(join(dir, `${ID_A}.kpdf3-wal`), Buffer.alloc(1024));
  writeFileSync(join(dir, `${ID_A}.kpdf3-shm`), Buffer.alloc(512));
  writeFileSync(join(dir, `${ID_B}.kpdf3-wal`), Buffer.alloc(256));
  writeFileSync(join(dir, "index.db-wal"), Buffer.from("x"));

  const ws = sweepOrphanWalShm(dir);
  ok(ws.removed === 2, `removed exactly A's wal+shm (got ${ws.removed})`);
  ok(ws.freedBytes === 1536, `freed the orphans' bytes (got ${ws.freedBytes})`);
  ok(!existsSync(join(dir, `${ID_A}.kpdf3-wal`)), "orphan wal A deleted");
  ok(!existsSync(join(dir, `${ID_A}.kpdf3-shm`)), "orphan shm A deleted");
  ok(existsSync(join(dir, `${ID_B}.kpdf3-wal`)), "live wal B kept (sibling present)");
  ok(existsSync(join(dir, "index.db-wal")), "index.db-wal untouched");

  // Idempotent + missing dir graceful.
  ok(sweepOrphanWalShm(dir).removed === 0, "second wal/shm sweep is a no-op");
  ok(
    sweepOrphanWalShm(join(dir, "does-not-exist")).removed === 0,
    "missing dir wal/shm sweep is a no-op",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  console.log("sidecar-sweep test: FAIL");
}
process.exitCode = fail > 0 ? 1 : 0;
