// Electron main-process test runner.
//
// Why: better-sqlite3 native binding is built for a single ABI at a time
// (Node ABI vs Electron ABI). Running SQLite-dependent tests under plain
// `node` requires re-rebuilding for Node, which conflicts with `npm start`.
// Running them inside Electron's main process avoids the flip-flop.
//
// ADR-0005 documents this choice and trade-offs.
//
// Usage:  electron --no-sandbox test/electron-runner.cjs
//
// The runner expects each imported test file to:
//   - print its own pass/fail summary
//   - set `process.exitCode` to non-zero on failure (instead of process.exit)
//   - throw only on unrecoverable errors

const { app } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Tests that need Electron ABI (currently: anything touching better-sqlite3).
// Coord and render tests do not need Electron — they run via `node` directly.
const ELECTRON_TESTS = [
  // renderer graph のロード事故 (v2.0.23 TDZ) を最初に検知する
  "./renderer-load-smoke.mjs",
  "./m1-exit-criteria.mjs",
  "./m3-overlay-persistence.mjs",
  "./workspace-cleanup.test.mjs",
  "./source-encrypted-flag.test.mjs",
  "./workspace-portability.test.mjs",
  "./inserted-page-order.test.mjs",
  // ⚠️ userData を一時ディレクトリへ差し替えるため最後に置く
  "./stamp-export-import.test.mjs",
];

// v2.0.27-beta.6: renderer-load-smoke.mjs (first in the list since
// v2.0.24) opens a BrowserWindow and destroys it when done. Electron's
// default `window-all-closed` handler then quits the app — with exit code
// 0 — so every test after the smoke test was silently skipped for a
// month and `npm test` still reported green. Keep the process alive until
// the loop below calls app.exit() itself.
app.on("window-all-closed", () => { /* runner decides when to exit */ });

app.whenReady()
  .then(async () => {
    console.log("[electron-runner] Electron", process.versions.electron, "ready\n");
    let exitCode = 0;
    for (const rel of ELECTRON_TESTS) {
      const abs = path.join(__dirname, rel);
      try {
        await import(pathToFileURL(abs).href);
        if (process.exitCode && process.exitCode !== 0) {
          exitCode = process.exitCode;
          process.exitCode = 0; // reset so next test doesn't inherit
          console.error(`[electron-runner] ${rel}: FAIL (exitCode ${exitCode})`);
          break; // fail-fast
        }
      } catch (err) {
        console.error(`[electron-runner] ${rel}: uncaught error`);
        console.error(err);
        exitCode = 1;
        break;
      }
    }
    app.exit(exitCode);
  })
  .catch((err) => {
    console.error("[electron-runner] boot failure:", err);
    process.exit(2);
  });
