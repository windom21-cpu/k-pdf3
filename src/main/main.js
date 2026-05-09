// K-PDF3 Electron main process.
//
// Responsibilities:
//   - Window lifecycle
//   - Native dialogs (open / save)
//   - Workspace orchestration via IPC
//   - File I/O on behalf of the renderer
//
// This is the M1 skeleton. Real workspace UI lands in M2.

import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from "electron";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as mupdf from "mupdf";
import { Workspace } from "../domain/workspace.js";
import { openPdfDocument } from "../backend/mupdf-render.js";
import { computePdfFingerprint } from "../backend/mupdf-pdf-info.js";
import { renderPageCanonical } from "./render-service.js";
import {
  closeRegistry,
  findWorkspaceByFingerprint,
  generateWorkspaceId,
  registerWorkspace,
  touchWorkspace,
  workspacePathFor,
} from "./workspace-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Path of a legacy sidecar `.kpdf3` next to the PDF (the ADR-0006 layout).
 * Used only by the migration step in `kpdf3:open-pdf-file`.
 *
 *   /path/to/foo.pdf  →  /path/to/foo.kpdf3
 */
function legacySidecarPath(pdfPath) {
  const ext = extname(pdfPath);
  const stem = basename(pdfPath, ext);
  return join(dirname(pdfPath), `${stem}.kpdf3`);
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Workspace | null} */
let activeWorkspace = null;
/** @type {string | null} the absolute path of the source PDF that opened
 *                        the active workspace — used for export defaults. */
let activeSourcePdfPath = null;
/** @type {import("mupdf").Document | null} */
let activeDoc = null;
/** @type {Array<ReturnType<Workspace['getPages']>[number]>} */
let activePages = [];

/**
 * Open the active workspace's source PDF into mupdf and cache the page list.
 * No-op if there's no active workspace or the workspace has no source PDF yet.
 */
function reopenActiveDoc() {
  disposeActiveDoc();
  if (!activeWorkspace) return;
  const bytes = activeWorkspace.getSourceBytes();
  if (!bytes) return;
  activeDoc = openPdfDocument(bytes);
  activePages = activeWorkspace.getPages();
}

function disposeActiveDoc() {
  if (activeDoc) {
    try {
      activeDoc.destroy();
    } catch {
      /* ignore */
    }
    activeDoc = null;
  }
  activePages = [];
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    title: "K-PDF3",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // sandbox=false to allow preload using require('electron')
    },
  });
  mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"));
  mainWindow.on("closed", () => {
    disposeActiveDoc();
    if (activeWorkspace) {
      try {
        activeWorkspace.close();
      } catch {
        /* ignore */
      }
      activeWorkspace = null;
    }
    activeSourcePdfPath = null;
    mainWindow = null;
  });
}

// ---- App lifecycle -------------------------------------------------------

app.whenReady().then(() => {
  // No native menu in M1 (will be customized in M3 with Save/Export shortcuts).
  Menu.setApplicationMenu(null);
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Close the workspace + registry handles cleanly so SQLite WAL flushes.
  disposeActiveDoc();
  if (activeWorkspace) {
    try { activeWorkspace.close(); } catch { /* ignore */ }
    activeWorkspace = null;
  }
  activeSourcePdfPath = null;
  closeRegistry();
});

// ---- IPC: workspace ------------------------------------------------------

ipcMain.handle("kpdf3:pick-workspace-save", async () => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: "新しい workspace を保存",
    defaultPath: "untitled.kpdf3",
    filters: [
      { name: "K-PDF3 workspace", extensions: ["kpdf3"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle("kpdf3:pick-workspace-open", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "workspace を開く",
    filters: [
      { name: "K-PDF3 workspace", extensions: ["kpdf3"] },
      { name: "All Files", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("kpdf3:pick-pdf", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "PDF を選択",
    filters: [
      { name: "PDF", extensions: ["pdf", "PDF"] },
      { name: "All Files", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("kpdf3:open-workspace", async (_, filePath) => {
  disposeActiveDoc();
  if (activeWorkspace) {
    activeWorkspace.close();
    activeWorkspace = null;
  }
  activeSourcePdfPath = null;
  activeWorkspace = Workspace.open(filePath);
  reopenActiveDoc();
  return { filePath, isNew: activeWorkspace.isNew };
});

ipcMain.handle("kpdf3:create-workspace", async (_, filePath) => {
  disposeActiveDoc();
  if (activeWorkspace) {
    activeWorkspace.close();
    activeWorkspace = null;
  }
  activeSourcePdfPath = null;
  activeWorkspace = Workspace.create(filePath);
  reopenActiveDoc();
  return { filePath, isNew: true };
});

ipcMain.handle("kpdf3:close-workspace", async () => {
  disposeActiveDoc();
  if (!activeWorkspace) return false;
  activeWorkspace.close();
  activeWorkspace = null;
  activeSourcePdfPath = null;
  return true;
});

ipcMain.handle("kpdf3:import-pdf", async (_, pdfPath) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const info = await activeWorkspace.importPdfFromFile(pdfPath);
  reopenActiveDoc();
  return info;
});

/**
 * Combined "open" entry point for the PDF-first UX (ADR-0006 + ADR-0007).
 *
 *   1. Hash the chosen PDF (SHA-256) and look it up in the registry.
 *   2. Hit  → open `userData/workspaces/{id}.kpdf3` directly.
 *   3. Miss → check for a legacy sidecar next to the PDF (ADR-0006 layout)
 *             and migrate it into userData; or create a fresh workspace.
 *   4. Open the mupdf doc, cache page rows, return overlays to renderer.
 */
ipcMain.handle("kpdf3:open-pdf-file", async (_, pdfPath) => {
  disposeActiveDoc();
  if (activeWorkspace) {
    activeWorkspace.close();
    activeWorkspace = null;
  }
  activeSourcePdfPath = null;

  const pdfBytes = readFileSync(pdfPath);
  const fingerprint = await computePdfFingerprint(pdfBytes);
  const sourceName = basename(pdfPath);

  let isNew = false;
  let migrated = false;
  const existing = findWorkspaceByFingerprint(fingerprint);
  if (existing && existsSync(existing.workspacePath)) {
    activeWorkspace = Workspace.open(existing.workspacePath);
    touchWorkspace(fingerprint, pdfPath, sourceName);
  } else {
    const id = generateWorkspaceId();
    const wsPath = workspacePathFor(id);
    const legacy = legacySidecarPath(pdfPath);
    if (existsSync(legacy)) {
      // Migrate the ADR-0006 sidecar into userData/.
      try {
        renameSync(legacy, wsPath);
      } catch (err) {
        console.error("[main] sidecar migration rename failed:", err);
        throw err;
      }
      activeWorkspace = Workspace.open(wsPath);
      migrated = true;
    } else {
      activeWorkspace = Workspace.create(wsPath);
      await activeWorkspace.importPdfFromFile(pdfPath);
      isNew = true;
    }
    registerWorkspace({
      fingerprint,
      workspaceId: id,
      workspacePath: wsPath,
      sourcePdfPath: pdfPath,
      sourcePdfName: sourceName,
    });
  }

  activeSourcePdfPath = pdfPath;
  reopenActiveDoc();

  return {
    pdfPath,
    pageCount: activeWorkspace.getSourceMeta()?.pageCount ?? 0,
    isNew,
    migrated,
    overlays: activeWorkspace.loadOverlays(),
  };
});

ipcMain.handle("kpdf3:get-outline", async () => {
  if (!activeWorkspace) return [];
  return activeWorkspace.getOutline();
});

ipcMain.handle("kpdf3:save-overlays", async (_, overlays) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.saveOverlays(overlays);
  return { savedAt: new Date().toISOString(), count: overlays.length };
});

/**
 * Byte-copy the workspace's source PDF to a user-chosen path. Used by
 * "Save As" when the project store has no overlays — preserves the
 * original PDF bytes (text layer, exact size) instead of degrading to
 * the rasterized flatten path. ADR-0008.
 */
ipcMain.handle("kpdf3:copy-source-pdf", async (_, savePath) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  if (!savePath) throw new Error("copy-source-pdf: savePath missing");
  const bytes = activeWorkspace.getSourceBytes();
  if (!bytes) throw new Error("copy-source-pdf: workspace has no source PDF");
  writeFileSync(savePath, bytes);
  const rev = activeWorkspace.recordExport(bytes, {
    note: "byte-copy of source PDF",
    isSecure: false,
  });
  return {
    savedAt: rev.timestamp,
    savePath,
    pageCount: activeWorkspace.getSourceMeta()?.pageCount ?? 0,
    revisionId: rev.revisionId,
    outputHash: rev.outputHash,
    outputSize: rev.outputSize,
    byteCopy: true,
  };
});

ipcMain.handle("kpdf3:pick-export-pdf", async () => {
  // Default dir = the directory of the source PDF the user opened (so the
  // export sits next to its source); default name = the source PDF's
  // basename, no marker. Same name + same dir means the OS dialog will
  // surface its native overwrite-confirmation, which we let stand.
  const dir = activeSourcePdfPath ? dirname(activeSourcePdfPath) : null;
  const name = defaultExportName();
  const defaultPath = dir ? join(dir, name) : name;
  const r = await dialog.showSaveDialog(mainWindow, {
    title: "PDF として書き出し",
    defaultPath,
    filters: [
      { name: "PDF", extensions: ["pdf"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return r.canceled ? null : r.filePath;
});

/**
 * Build a flatten PDF from per-page composited PNG bytes. Shared between
 * the export and print pipelines (they only differ in where the bytes
 * end up). Caller is responsible for destroying nothing — this manages
 * mupdf handles internally and returns plain Buffer bytes.
 *
 * @param {Array<{ pageNo:number, png:Uint8Array, widthPt:number, heightPt:number }>} pages
 * @returns {Buffer}
 */
function assembleRasterizedPdf(pages) {
  const newDoc = new mupdf.PDFDocument();
  try {
    for (const p of pages) {
      const png = p.png instanceof Uint8Array ? p.png : new Uint8Array(p.png);
      const image = new mupdf.Image(png);
      try {
        const imageRef = newDoc.addImage(image);
        const xobjects = newDoc.newDictionary();
        xobjects.put("Im0", imageRef);
        const resources = newDoc.newDictionary();
        resources.put("XObject", xobjects);
        const cs = `q\n${p.widthPt} 0 0 ${p.heightPt} 0 0 cm\n/Im0 Do\nQ\n`;
        const contents = new TextEncoder().encode(cs);
        const pageObj = newDoc.addPage(
          [0, 0, p.widthPt, p.heightPt],
          0,
          resources,
          contents,
        );
        newDoc.insertPage(newDoc.countPages(), pageObj);
      } finally {
        image.destroy?.();
      }
    }
    const buf = newDoc.saveToBuffer();
    try {
      return Buffer.from(buf.asUint8Array());
    } finally {
      buf.destroy?.();
    }
  } finally {
    newDoc.destroy();
  }
}

function tempPrintPath() {
  return join(app.getPath("temp"), `kpdf3-print-${randomUUID()}.pdf`);
}

/**
 * Show the OS print dialog directly for a PDF file by loading it into a
 * hidden BrowserWindow (Chromium's built-in PDF viewer renders it) and
 * invoking webContents.print(). Resolves on success / user-cancelled,
 * rejects on a real failure so the caller can fall back to
 * shell.openPath.
 *
 * @param {string} pdfPath
 * @returns {Promise<{ success: boolean, cancelled: boolean }>}
 */
function printPdfViaHiddenWindow(pdfPath) {
  return new Promise((resolve, reject) => {
    const printWin = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        plugins: true, // enable Chromium's built-in PDF viewer
        contextIsolation: true,
        sandbox: false,
      },
    });

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        printWin.close();
      } catch {
        /* ignore */
      }
      fn(value);
    };

    printWin.webContents.once("did-finish-load", () => {
      // Give the PDF plugin a beat to actually render the first page
      // before invoking print. 250 ms is long enough on the development
      // hardware we've tested with; if you see "blank pages printed"
      // bumps that to 500 ms.
      setTimeout(() => {
        try {
          printWin.webContents.print({}, (success, errorType) => {
            if (success) {
              finish(resolve, { success: true, cancelled: false });
            } else if (errorType === "cancelled") {
              finish(resolve, { success: false, cancelled: true });
            } else {
              finish(reject, new Error(errorType || "print failed"));
            }
          });
        } catch (err) {
          finish(reject, err);
        }
      }, 250);
    });

    printWin.webContents.once("did-fail-load", (_e, code, desc) => {
      finish(reject, new Error(`PDF load failed (${code}): ${desc}`));
    });

    printWin.loadFile(pdfPath).catch((err) => finish(reject, err));
  });
}

/**
 * Assemble a flatten PDF from per-page composited PNG bytes (from the
 * renderer) and write it to disk.
 *
 * Each page becomes an image-only page in the new PDF, sized to the
 * canonical PDF-point dimensions. The image is embedded as a single
 * /XObject and drawn with a single `cm` + `Do` content-stream pair.
 *
 * Limitations to address in later M4 sub-steps:
 *   - File size: PNG is lossless and large. M4 polish: switch to
 *     JPEG / DCT for source pages when no overlays touch them.
 *   - No metadata strip / no xref rebuild — qpdf integration M4-3.
 *   - Revision id / exports BLOB history — M4-2.
 */
ipcMain.handle("kpdf3:export-pdf-rasterized", async (_, payload) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const { savePath, pages } = payload;
  if (!savePath || !Array.isArray(pages) || pages.length === 0) {
    throw new Error("export-pdf-rasterized: invalid payload");
  }
  const pdfBytes = assembleRasterizedPdf(pages);
  writeFileSync(savePath, pdfBytes);
  const rev = activeWorkspace.recordExport(pdfBytes, {
    note: payload.note ?? null,
    isSecure: false,
  });
  return {
    savedAt: rev.timestamp,
    savePath,
    pageCount: pages.length,
    revisionId: rev.revisionId,
    outputHash: rev.outputHash,
    outputSize: rev.outputSize,
  };
});

/**
 * Print pipeline (M5-4):
 *   - flatten path: same composer as export → mupdf assembly → temp PDF
 *   - byte-copy path: when the workspace has no overlays the user is
 *     printing the source PDF as-is, so just write the source bytes
 *     to the same temp slot (preserves text layer for crisp printing)
 *   - shell.openPath opens the temp PDF in the OS-default PDF viewer
 *     where the user presses Ctrl+P
 *
 * The temp file lingers under app.getPath('temp') until the OS purges
 * its tmp directory; we don't try to delete it because the spawned PDF
 * viewer typically still has it open.
 */
/**
 * @param {string} tempPath  the PDF file we just wrote
 * @returns {Promise<{ method: 'os-dialog' | 'external-viewer', cancelled: boolean }>}
 */
async function tryPrintOrOpenExternal(tempPath) {
  try {
    const r = await printPdfViaHiddenWindow(tempPath);
    return { method: "os-dialog", cancelled: r.cancelled };
  } catch (err) {
    // Fall back to opening the file with the OS's default PDF viewer
    // so the user can still print it from there.
    console.warn("[main] direct print failed, falling back to shell:", err);
    const errMsg = await shell.openPath(tempPath);
    if (errMsg) throw new Error(`Print + fallback both failed: ${err.message} | ${errMsg}`);
    return { method: "external-viewer", cancelled: false };
  }
}

ipcMain.handle("kpdf3:print-pdf-rasterized", async (_, payload) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const { pages } = payload;
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("print-pdf-rasterized: invalid payload");
  }
  const pdfBytes = assembleRasterizedPdf(pages);
  const tempPath = tempPrintPath();
  writeFileSync(tempPath, pdfBytes);
  const r = await tryPrintOrOpenExternal(tempPath);
  return { tempPath, pageCount: pages.length, ...r };
});

ipcMain.handle("kpdf3:print-source-pdf", async () => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const bytes = activeWorkspace.getSourceBytes();
  if (!bytes) throw new Error("print-source-pdf: workspace has no source PDF");
  const tempPath = tempPrintPath();
  writeFileSync(tempPath, bytes);
  const r = await tryPrintOrOpenExternal(tempPath);
  return {
    tempPath,
    pageCount: activeWorkspace.getSourceMeta()?.pageCount ?? 0,
    byteCopy: true,
    ...r,
  };
});

/**
 * Default filename for the export dialog. ADR-0007: the export should
 * look like a plain PDF — same name as the source, no app-specific
 * marker — so the recipient sees a「普通の PDF」name. The OS dialog's
 * own overwrite confirmation handles the source-overwrite case.
 *
 *   /path/契約書.pdf   →   契約書.pdf  (default name)
 *
 * The activeSourcePdfPath in pick-export-pdf supplies the directory.
 */
function defaultExportName() {
  if (activeSourcePdfPath) return basename(activeSourcePdfPath);
  if (activeWorkspace) {
    const meta = activeWorkspace.getSourceMeta();
    if (meta?.fileName) return meta.fileName;
  }
  return "export.pdf";
}

ipcMain.handle("kpdf3:render-page", async (_, pageNo, opts) => {
  if (!activeDoc) throw new Error("No PDF loaded");
  const row = activePages[pageNo - 1];
  if (!row) throw new Error(`Page ${pageNo} out of range (have ${activePages.length})`);
  return renderPageCanonical(activeDoc, row, {
    zoom: opts?.zoom ?? 1.0,
    alpha: opts?.alpha ?? true,
  });
});

ipcMain.handle("kpdf3:get-source-meta", async () => {
  if (!activeWorkspace) return null;
  return activeWorkspace.getSourceMeta();
});

ipcMain.handle("kpdf3:get-pages", async () => {
  if (!activeWorkspace) return [];
  return activeWorkspace.getPages();
});

ipcMain.handle("kpdf3:get-app-info", async () => {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
  };
});
