// qpdf sanitize wrapper (M6 secure export).
//
// Produces a sanitized copy of a PDF byte buffer:
//   - --remove-info     → strips the Info dict (Author / Title / Subject /
//                          Keywords / Creator / Producer / CreationDate /
//                          ModDate). No user-identifying field survives.
//   - --remove-metadata → strips the document-level XMP /Metadata stream.
//   - qpdf rewrites xref from scratch — eliminates any incremental save
//     history that might contain earlier drafts.
//   - Outlines / bookmarks are preserved (qpdf only drops the catalog's
//     /Metadata and trailer's /Info entries; the page tree + outlines tree
//     come through intact).
//
// Object-stream / linearization toggles are intentionally NOT enabled —
// they alter binary signatures in ways some viewers (notably older Acrobat
// builds in scan workflows) complain about.
//
// Binary lookup order (findQpdfBinary):
//   1. process.resourcesPath/qpdf/qpdf[.exe]   ← packaged via extraResources
//   2. <repo>/vendor/qpdf/{win,mac,linux}/qpdf[.exe]   ← dev workspace
//   3. PATH (system-installed qpdf, e.g. apt/brew)
//
// If none found, the caller should warn the user and fall back to a non-
// sanitised export (see kpdf3:export-pdf-rasterized in main.js).

import { spawn } from "node:child_process";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate a usable qpdf binary. Returns absolute path or null if not found.
 *
 * @returns {string | null}
 */
export function findQpdfBinary() {
  const isWin = process.platform === "win32";
  const exeName = isWin ? "qpdf.exe" : "qpdf";

  // 同梱レイアウトはプラットフォームで異なる:
  //   - win: qpdf.exe を root に flat 配置 (依存 DLL も同階層、Windows は
  //     同ディレクトリの DLL を自動ロードする)。
  //   - mac/linux: qpdf 公式 portable 配布の bin/ + lib/ 構造をそのまま
  //     同梱。qpdf は bin/ 配下に置き、RUNPATH ($ORIGIN/../lib) /
  //     install_name (@loader_path/../lib) で同梱 .so/.dylib を解決する。
  const relExe = isWin ? exeName : join("bin", exeName);

  // 1. Packaged app: electron-builder copies vendor/qpdf/{platform}/ → resources/qpdf/.
  //    process.resourcesPath is undefined when running scripts/tests under
  //    plain Node, hence the truthy guard.
  if (process.resourcesPath) {
    const bundled = join(process.resourcesPath, "qpdf", relExe);
    if (existsSync(bundled)) return bundled;
  }

  // 2. Dev workspace: src/main/qpdf-sanitize.js → ../../vendor/qpdf/{platform}/
  const platDir = isWin ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const devCand = join(__dirname, "..", "..", "vendor", "qpdf", platDir, relExe);
  if (existsSync(devCand)) return devCand;

  // 3. System PATH.
  const onPath = resolveOnPath(exeName);
  if (onPath) return onPath;

  return null;
}

function resolveOnPath(name) {
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE").split(";").map((e) => e.toLowerCase())
      : [""];
  const baseName = name.toLowerCase().endsWith(".exe") ? name.slice(0, -4) : name;
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = join(dir, baseName + ext);
      if (existsSync(cand)) return cand;
    }
  }
  return null;
}

/**
 * Sanitize PDF bytes via qpdf. Returns a fresh buffer.
 *
 * Throws if the binary isn't found or qpdf reports a hard error. Warnings
 * are downgraded to success because qpdf still produces valid output in
 * those cases (`--warning-exit-0`).
 *
 * @param {Buffer | Uint8Array} bytes
 * @param {{ qpdfPath?: string }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function sanitizePdfBytes(bytes, opts = {}) {
  const qpdfPath = opts.qpdfPath ?? findQpdfBinary();
  if (!qpdfPath) {
    throw new Error(
      "qpdf binary not found (checked bundled resources, vendor/qpdf, and PATH)",
    );
  }
  const tag = randomUUID();
  const inPath = join(tmpdir(), `kpdf3-qpdf-in-${tag}.pdf`);
  const outPath = join(tmpdir(), `kpdf3-qpdf-out-${tag}.pdf`);
  const buf = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  await writeFile(inPath, buf);
  try {
    await runQpdf(qpdfPath, [
      "--warning-exit-0",
      "--remove-info",
      "--remove-metadata",
      inPath,
      outPath,
    ]);
    return await readFile(outPath);
  } finally {
    await Promise.allSettled([unlink(inPath), unlink(outPath)]);
  }
}

function runQpdf(exe, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`qpdf exited with code ${code}: ${stderr.trim() || "(no stderr)"}`));
    });
  });
}
