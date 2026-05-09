// K-PDF3 Electron main process.
//
// Responsibilities:
//   - Window lifecycle
//   - Native dialogs (open / save)
//   - Workspace orchestration via IPC
//   - File I/O on behalf of the renderer
//
// This is the M1 skeleton. Real workspace UI lands in M2.

import { app, BrowserWindow, ipcMain, dialog, Menu } from "electron";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join } from "node:path";
import { existsSync } from "node:fs";
import { Workspace } from "../domain/workspace.js";
import { openPdfDocument } from "../backend/mupdf-render.js";
import { renderPageCanonical } from "./render-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Compute the sidecar `.kpdf3` path for a given PDF path.
 * Same directory, same basename, extension swapped to `.kpdf3`.
 *
 *   /path/to/foo.pdf  →  /path/to/foo.kpdf3
 *   /path/to/FOO.PDF  →  /path/to/FOO.kpdf3
 */
function sidecarKpdf3Path(pdfPath) {
  const ext = extname(pdfPath);
  const stem = basename(pdfPath, ext);
  return join(dirname(pdfPath), `${stem}.kpdf3`);
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Workspace | null} */
let activeWorkspace = null;
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
  activeWorkspace = Workspace.create(filePath);
  reopenActiveDoc();
  return { filePath, isNew: true };
});

ipcMain.handle("kpdf3:close-workspace", async () => {
  disposeActiveDoc();
  if (!activeWorkspace) return false;
  activeWorkspace.close();
  activeWorkspace = null;
  return true;
});

ipcMain.handle("kpdf3:import-pdf", async (_, pdfPath) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const info = await activeWorkspace.importPdfFromFile(pdfPath);
  reopenActiveDoc();
  return info;
});

/**
 * Combined "open" entry point for the PDF-first UX (ADR-0006).
 *
 *   1. Resolve the sidecar `.kpdf3` next to the PDF.
 *   2. If it exists, open it (with verifyWorkspace).
 *   3. If it doesn't, create a fresh workspace and import the PDF.
 *   4. Either way, open the mupdf doc and cache page rows.
 *
 * Returns `{ sidecarPath, pdfPath, pageCount, isNew }`.
 */
ipcMain.handle("kpdf3:open-pdf-file", async (_, pdfPath) => {
  const sidecarPath = sidecarKpdf3Path(pdfPath);

  disposeActiveDoc();
  if (activeWorkspace) {
    activeWorkspace.close();
    activeWorkspace = null;
  }

  let isNew;
  if (existsSync(sidecarPath)) {
    activeWorkspace = Workspace.open(sidecarPath);
    isNew = false;
  } else {
    activeWorkspace = Workspace.create(sidecarPath);
    await activeWorkspace.importPdfFromFile(pdfPath);
    isNew = true;
  }
  reopenActiveDoc();
  return {
    sidecarPath,
    pdfPath,
    pageCount: activeWorkspace.getSourceMeta()?.pageCount ?? 0,
    isNew,
  };
});

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
