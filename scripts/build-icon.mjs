#!/usr/bin/env node
//
// Stage app-icon files for electron-builder.
//
// Source of truth lives in `favicon-k3/` (designed PNG/ICO/SVG set).
// electron-builder reads `build/icon.png` and `build/icon.ico` from
// `directories.buildResources`, so this script just copies the right
// sizes into place. Idempotent — safe to re-run on every CI build.
//
// We intentionally leave .icns generation to electron-builder itself
// on the macOS runner (it converts from build/icon.png via the system
// `iconutil`/`sips`), so we don't need extra deps here.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const SRC_DIR = resolve(ROOT, "favicon-k3");
const BUILD_DIR = resolve(ROOT, "build");
const VENDOR_DIR = resolve(ROOT, "src/renderer/vendor");

// Pairs: [source under favicon-k3/, destination]. The destination's
// parent directory is created on demand.
const COPIES = [
  // electron-builder picks these up from `build/` (configured as
  // `directories.buildResources` in package.json).
  [resolve(SRC_DIR, "favicon-512.png"), resolve(BUILD_DIR, "icon.png")],
  [resolve(SRC_DIR, "favicon.ico"), resolve(BUILD_DIR, "icon.ico")],
  // Used at runtime by main.js for BrowserWindow's `icon:` option and
  // by the renderer for <link rel="icon">. Lives under src/ so it ends
  // up inside the packaged app (via the "src/**/*" build.files glob).
  [resolve(SRC_DIR, "favicon-256.png"), resolve(VENDOR_DIR, "app-icon.png")],
  [resolve(SRC_DIR, "favicon-32.png"), resolve(VENDOR_DIR, "favicon-32.png")],
];

if (!existsSync(SRC_DIR)) {
  console.error(`build-icon: missing source dir ${SRC_DIR} — keeping existing icons`);
  process.exit(0);
}

let updated = 0;
for (const [src, dest] of COPIES) {
  if (!existsSync(src)) {
    console.warn(`build-icon: source missing, skipped: ${src}`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  // Skip the copy if the dest already matches (avoid spurious mtime churn).
  let needCopy = true;
  if (existsSync(dest)) {
    const a = statSync(src), b = statSync(dest);
    if (a.size === b.size && a.mtimeMs <= b.mtimeMs) needCopy = false;
  }
  if (needCopy) {
    copyFileSync(src, dest);
    updated += 1;
    console.log(`copied  ${src} → ${dest}`);
  }
}
console.log(`build-icon: ${updated} file(s) updated`);
