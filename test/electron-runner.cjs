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
  "./m1-exit-criteria.mjs",
];

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
