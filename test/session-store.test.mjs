// session-store unit test — restore-after-update persistence.
//
// Covers the decision boundary: files are restored ONLY when the stored
// version differs from the running one (= an update happened) and there are
// remembered files; same-version restarts restore nothing. The IO half is
// exercised against a real temp dir.

import {
  readSession,
  writeSession,
  computeRestore,
} from "../src/main/session-store.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
function sameArr(a, b, msg) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);
}

// ---- pure: computeRestore ------------------------------------------------
console.log("[1] computeRestore — version changed → restore");
{
  const r = computeRestore({ version: "2.0.2", openFiles: ["/a.pdf", "/b.pdf"] }, "2.0.3");
  ok(r.restore === true, "restores when version changed");
  sameArr(r.files, ["/a.pdf", "/b.pdf"], "returns remembered files");
}

console.log("[2] computeRestore — same version → no restore");
{
  const r = computeRestore({ version: "2.0.3", openFiles: ["/a.pdf"] }, "2.0.3");
  ok(r.restore === false, "no restore on same-version restart");
  sameArr(r.files, [], "no files when not restoring");
}

console.log("[3] computeRestore — changed but no files → no restore");
{
  const r = computeRestore({ version: "2.0.2", openFiles: [] }, "2.0.3");
  ok(r.restore === false, "nothing to restore");
}

console.log("[4] computeRestore — fileExists filter drops missing files");
{
  const r = computeRestore(
    { version: "2.0.2", openFiles: ["/keep.pdf", "/gone.pdf"] },
    "2.0.3",
    (p) => p === "/keep.pdf",
  );
  ok(r.restore === true, "still restores the surviving file");
  sameArr(r.files, ["/keep.pdf"], "missing file filtered out");
}

console.log("[5] computeRestore — null prev (first ever run) → no restore");
{
  const r = computeRestore({ version: null, openFiles: [] }, "2.0.3");
  ok(r.restore === false, "fresh install has nothing to restore");
}

// ---- IO: read / write round-trip -----------------------------------------
const dir = mkdtempSync(join(tmpdir(), "kpdf3-session-"));
try {
  console.log("[6] missing file → empty session");
  {
    const s = readSession(dir);
    sameArr([s.version, s.openFiles], [null, []], "missing session.json is empty");
  }

  console.log("[7] write then read round-trips + dedupes + drops junk");
  {
    writeSession(dir, {
      version: "2.0.3",
      openFiles: ["/a.pdf", "/a.pdf", "/b.pdf", "", null, 7],
    });
    const s = readSession(dir);
    ok(s.version === "2.0.3", "version round-trips");
    sameArr(s.openFiles, ["/a.pdf", "/b.pdf"], "deduped + sanitized");
  }

  console.log("[8] corrupt JSON → empty session, no throw");
  {
    writeFileSync(join(dir, "session.json"), "{not json", "utf8");
    const s = readSession(dir);
    sameArr([s.version, s.openFiles], [null, []], "corrupt file falls back to empty");
  }

  console.log("[9] end-to-end: write v2.0.2 session, boot as v2.0.3 → restore");
  {
    writeSession(dir, { version: "2.0.2", openFiles: ["/x.pdf"] });
    const r = computeRestore(readSession(dir), "2.0.3");
    ok(r.restore === true && r.files[0] === "/x.pdf", "stored-then-restored across an update");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) console.log("session-store test: FAIL");
process.exitCode = fail > 0 ? 1 : 0;
