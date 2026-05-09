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
import { dirname, join } from "node:path";
import { Workspace } from "../domain/workspace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Workspace | null} */
let activeWorkspace = null;

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
    filters: [{ name: "K-PDF3 workspace", extensions: ["kpdf3"] }],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle("kpdf3:pick-workspace-open", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "workspace を開く",
    filters: [{ name: "K-PDF3 workspace", extensions: ["kpdf3"] }],
    properties: ["openFile"],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("kpdf3:pick-pdf", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "PDF を選択",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    properties: ["openFile"],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("kpdf3:open-workspace", async (_, filePath) => {
  if (activeWorkspace) {
    activeWorkspace.close();
    activeWorkspace = null;
  }
  activeWorkspace = Workspace.open(filePath);
  return { filePath, isNew: activeWorkspace.isNew };
});

ipcMain.handle("kpdf3:close-workspace", async () => {
  if (!activeWorkspace) return false;
  activeWorkspace.close();
  activeWorkspace = null;
  return true;
});

ipcMain.handle("kpdf3:import-pdf", async (_, pdfPath) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  return await activeWorkspace.importPdfFromFile(pdfPath);
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
