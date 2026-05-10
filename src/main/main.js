// K-PDF3 Electron main process.
//
// Responsibilities:
//   - Window lifecycle
//   - Native dialogs (open / save)
//   - Workspace orchestration via IPC
//   - File I/O on behalf of the renderer
//
// This is the M1 skeleton. Real workspace UI lands in M2.

import { app, BrowserWindow, ipcMain, dialog, Menu, shell, globalShortcut } from "electron";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as mupdf from "mupdf";
import { Workspace } from "../domain/workspace.js";
import { openPdfDocument } from "../backend/mupdf-render.js";
import { addFlatOutlinesToPdf } from "../backend/pdf-outlines.js";
import { computePdfFingerprint } from "../backend/mupdf-pdf-info.js";
import { renderPageCanonical } from "./render-service.js";
import {
  closeRegistry,
  findWorkspaceByFingerprint,
  generateWorkspaceId,
  listRecentPdfs,
  registerWorkspace,
  touchWorkspace,
  workspacePathFor,
} from "./workspace-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Pixel-grid font rendering: disable hinting + subpixel positioning so
// MS UI Gothic snaps to whole pixels (closer to the SVG-icon look).
// MUST be set before app.whenReady().
app.commandLine.appendSwitch("font-render-hinting", "none");
app.commandLine.appendSwitch("disable-font-subpixel-positioning");

// Force xwayland on Wayland sessions — native Wayland delivery for
// keyboard events / globalShortcut is unreliable on GNOME (user
// reproed F5 / Ctrl+R / F12 not firing). xwayland gives the same
// behaviour as classic X11 where every key event reaches the window.
if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") {
  app.commandLine.appendSwitch("ozone-platform-hint", "x11");
}

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
// ---- Tab registry (ADR-0015 案 B) ----------------------------------------
//
// Each tab owns an open Workspace + mupdf Document handle. The
// renderer is the source of truth for tab order / titles; main only
// needs to know which tab is active so existing IPC handlers
// (render-page / save-overlays / get-pages / ...) keep using the
// `activeWorkspace` etc. references they already do. `kpdf3:switch-
// tab` swaps those references atomically; `kpdf3:open-pdf-file`
// accepts a tabId so each tab gets its own handle.

/** @typedef {{
 *   workspace: Workspace,
 *   doc: import("mupdf").Document | null,
 *   pages: Array<ReturnType<Workspace['getPages']>[number]>,
 *   sourcePdfPath: string,
 *   sourceName: string,
 * }} TabHandle */

/** @type {Map<string, TabHandle>} */
const tabHandles = new Map();
/** @type {string | null} */
let activeTabId = null;

/** @type {Workspace | null} */
let activeWorkspace = null;
/** @type {string | null} the absolute path of the source PDF that opened
 *                        the active workspace — used for export defaults. */
let activeSourcePdfPath = null;
/** @type {import("mupdf").Document | null} */
let activeDoc = null;
/** @type {Array<ReturnType<Workspace['getPages']>[number]>} */
let activePages = [];

/** Point the module-level "active *" refs at the given tab (or null). */
function activateTab(tabId) {
  const h = tabId ? tabHandles.get(tabId) : null;
  if (!h) {
    activeTabId = null;
    activeWorkspace = null;
    activeDoc = null;
    activePages = [];
    activeSourcePdfPath = null;
    return;
  }
  activeTabId = tabId;
  activeWorkspace = h.workspace;
  activeDoc = h.doc;
  activePages = h.pages;
  activeSourcePdfPath = h.sourcePdfPath;
}

/** Dispose a tab's resources and drop it from the registry. If the
 *  tab was active, leaves the active-* refs nulled — callers should
 *  pick a successor (or accept "no active") afterward. */
function disposeTab(tabId) {
  const h = tabHandles.get(tabId);
  if (!h) return;
  if (h.doc) {
    try { h.doc.destroy(); } catch { /* ignore */ }
  }
  if (h.workspace) {
    try { h.workspace.close(); } catch { /* ignore */ }
  }
  tabHandles.delete(tabId);
  if (activeTabId === tabId) activateTab(null);
}

/**
 * Refresh the active tab's mupdf Document + pages cache. Used after
 * page insert/delete operations on the active workspace to keep the
 * tab handle's `pages` in sync (so subsequent render-page calls see
 * the new layout).
 */
function reopenActiveDoc() {
  disposeActiveDoc();
  if (!activeWorkspace) return;
  const bytes = activeWorkspace.getSourceBytes();
  if (!bytes) return;
  activeDoc = openPdfDocument(bytes);
  // Always keep ALL pages here (including deleted) so render-page can
  // resolve any source-PDF pageNo even when the renderer briefly issues
  // a stale request for a now-hidden page.
  activePages = activeWorkspace.getPages({ includeDeleted: true });
  // Mirror back into the tab handle so a subsequent switch-tab+back
  // keeps the refreshed view.
  if (activeTabId) {
    const h = tabHandles.get(activeTabId);
    if (h) {
      h.doc = activeDoc;
      h.pages = activePages;
    }
  }
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
    icon: join(__dirname, "..", "renderer", "vendor", "app-icon.png"),
    frame: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // sandbox=false to allow preload using require('electron')
    },
  });
  mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"));
  // Hide the menu bar (Linux / Windows) while keeping the accelerators
  // registered via setApplicationMenu — frame:false plus visible menu
  // would double the title-bar height with the OS menu strip.
  mainWindow.setMenuBarVisibility(false);
  mainWindow.autoHideMenuBar = true;
  // Notify the renderer when maximize state changes so the
  // maximize/restore button glyph stays in sync.
  const broadcastMax = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        "kpdf3:window-state",
        { maximized: mainWindow.isMaximized() },
      );
    }
  };
  mainWindow.on("maximize", broadcastMax);
  mainWindow.on("unmaximize", broadcastMax);
  // frame:false + Menu.setApplicationMenu(null) means no default
  // accelerators. Use globalShortcut while the window is focused —
  // before-input-event was unreliable on Wayland in testing. Each
  // shortcut is unregistered on blur so it doesn't fire while another
  // app is in the foreground.
  // Ask the renderer to reload itself — the renderer runs a dirty-check
  // confirm dialog and disarms the beforeunload listener before calling
  // location.reload(). A direct webContents.reload() would be silently
  // blocked by the beforeunload guard.
  const reloadFn = () => {
    if (mainWindow) mainWindow.webContents.send("kpdf3:reload-request");
  };
  const devtoolsFn = () => {
    if (!mainWindow) return;
    const wc = mainWindow.webContents;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: "detach" });
  };
  const registerShortcuts = () => {
    try {
      globalShortcut.register("F5", reloadFn);
      globalShortcut.register("CommandOrControl+R", reloadFn);
      globalShortcut.register("CommandOrControl+Shift+R", reloadFn);
      globalShortcut.register("F12", devtoolsFn);
      globalShortcut.register("CommandOrControl+Shift+I", devtoolsFn);
    } catch (e) {
      console.warn("[shortcuts] register failed:", e);
    }
  };
  const unregisterShortcuts = () => {
    globalShortcut.unregisterAll();
  };
  // Register straight away (window is shown) and re-arm on focus / drop on blur.
  registerShortcuts();
  mainWindow.on("focus", registerShortcuts);
  mainWindow.on("blur", unregisterShortcuts);
  app.on("will-quit", unregisterShortcuts);
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
  // Set a "hidden" application menu — invisible on screen but still
  // wires standard accelerators (F5 reload / F12 DevTools / Ctrl+R
  // reload). frame:false means we never want the menu BAR drawn, but
  // accelerators still need to be registered somewhere; null breaks
  // them entirely (which was the original cause of "shortcuts don't
  // work"). The renderer hides the bar on Linux/Windows via
  // mainWindow.setMenuBarVisibility(false) after the window opens.
  const reloadViaRenderer = () => {
    const w = BrowserWindow.getFocusedWindow() || mainWindow;
    if (w) w.webContents.send("kpdf3:reload-request");
  };
  const toggleDevToolsForFocused = () => {
    const w = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!w) return;
    const wc = w.webContents;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: "detach" });
  };
  const accelMenu = Menu.buildFromTemplate([
    {
      label: "_dev",
      submenu: [
        { label: "Reload", accelerator: "F5", click: reloadViaRenderer },
        { label: "Reload", accelerator: "CommandOrControl+R", click: reloadViaRenderer },
        { label: "Force Reload", accelerator: "CommandOrControl+Shift+R", click: reloadViaRenderer },
        { label: "DevTools", accelerator: "F12", click: toggleDevToolsForFocused },
        { label: "DevTools", accelerator: "CommandOrControl+Shift+I", click: toggleDevToolsForFocused },
      ],
    },
  ]);
  Menu.setApplicationMenu(accelMenu);
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Close every tab so SQLite WAL flushes for each workspace.
  for (const id of [...tabHandles.keys()]) disposeTab(id);
  disposeActiveDoc();
  if (activeWorkspace) {
    try { activeWorkspace.close(); } catch { /* ignore */ }
    activeWorkspace = null;
  }
  activeSourcePdfPath = null;
  activeTabId = null;
  closeRegistry();
  if (printWindow && !printWindow.isDestroyed()) {
    try { printWindow.destroy(); } catch { /* ignore */ }
    printWindow = null;
  }
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

/**
 * Custom file-browser support: list a directory's entries (folders + files).
 * Hidden entries (starting with `.`) are excluded. Folders are sorted before
 * files; both are sorted alphabetically (locale-aware). Returns the resolved
 * absolute path so the renderer can display it and use it for navigation.
 */
ipcMain.handle("kpdf3:list-directory", async (_, dirPath) => {
  const target = dirPath && dirPath.length > 0 ? dirPath : app.getPath("home");
  let resolved;
  try {
    resolved = join(target);
    const dirents = await readdir(resolved, { withFileTypes: true });
    const entries = [];
    for (const ent of dirents) {
      if (ent.name.startsWith(".")) continue;
      const full = join(resolved, ent.name);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      entries.push({
        name: ent.name,
        isDir: ent.isDirectory(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, "ja");
    });
    const parent = dirname(resolved);
    return {
      path: resolved,
      parent: parent === resolved ? null : parent,
      entries,
    };
  } catch (err) {
    return {
      path: resolved ?? target,
      parent: null,
      entries: [],
      error: err?.message ?? String(err),
    };
  }
});

ipcMain.handle("kpdf3:get-default-paths", async () => {
  const safe = (key) => {
    try {
      return app.getPath(key);
    } catch {
      return null;
    }
  };
  return {
    home: safe("home"),
    desktop: safe("desktop"),
    documents: safe("documents"),
    downloads: safe("downloads"),
  };
});

/**
 * Renderer-driven export flow needs the directory of the source PDF
 * (so the save dialog opens next to it) and the suggested basename.
 */
/**
 * Search the active PDF for `query`. Returns per-page hit counts so the
 * renderer can display total matches and jump-to-page navigation.
 * Returns { totalMatches, pages: [{ pageNo, count }] }.
 */
ipcMain.handle("kpdf3:search-pdf", async (_, query) => {
  if (!activeWorkspace || !query || typeof query !== "string") {
    return { totalMatches: 0, pages: [] };
  }
  const bytes = activeWorkspace.getSourceBytes();
  if (!bytes) return { totalMatches: 0, pages: [] };
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const doc = mupdf.Document.openDocument(buf, "application/pdf");
  const out = { totalMatches: 0, pages: [] };
  try {
    const pageCount = doc.countPages();
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        let hits = [];
        try {
          hits = page.search(query, 200) ?? [];
        } catch {
          hits = [];
        }
        if (hits.length > 0) {
          out.pages.push({ pageNo: i + 1, count: hits.length });
          out.totalMatches += hits.length;
        }
      } finally {
        page.destroy();
      }
    }
  } finally {
    doc.destroy();
  }
  return out;
});

ipcMain.handle("kpdf3:get-export-defaults", async () => {
  return {
    sourceDir: activeSourcePdfPath ? dirname(activeSourcePdfPath) : null,
    defaultName: defaultExportName(),
  };
});

ipcMain.handle("kpdf3:file-exists", async (_, filePath) => {
  if (!filePath) return false;
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
});

// ---- Custom Win95-style window controls (frame: false) ---------------
ipcMain.handle("kpdf3:window-minimize", async () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.handle("kpdf3:window-maximize-toggle", async () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle("kpdf3:window-close", async () => {
  if (mainWindow) mainWindow.close();
});
ipcMain.handle("kpdf3:window-is-maximized", async () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.handle("kpdf3:toggle-devtools", async () => {
  if (!mainWindow) return;
  const wc = mainWindow.webContents;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: "detach" });
});

/**
 * Open the OS-native printer properties dialog for a given printer.
 * Implementation is platform-specific:
 *   - Windows : rundll32 printui.dll,PrintUIEntry /e /n "Name" — printing preferences
 *   - Linux   : system-config-printer --show "Name", fallback CUPS web UI
 *   - macOS   : System Preferences > Printers (no per-printer URL exists)
 * Non-blocking: the spawned process is detached so the app keeps running.
 */
ipcMain.handle("kpdf3:printer-properties", async (_, deviceName) => {
  if (!deviceName) return { ok: false, error: "プリンタ名が指定されていません" };
  try {
    if (process.platform === "win32") {
      const child = spawn(
        "rundll32.exe",
        ["printui.dll,PrintUIEntry", "/e", "/n", deviceName],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      return { ok: true };
    }
    if (process.platform === "linux") {
      // Try system-config-printer; if missing, fall back to CUPS web UI.
      const child = spawn("system-config-printer", ["--show", deviceName], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      child.on("error", () => {
        const url = `http://localhost:631/printers/${encodeURIComponent(deviceName)}`;
        shell.openExternal(url);
      });
      return { ok: true };
    }
    if (process.platform === "darwin") {
      shell.openExternal("x-apple.systempreferences:com.apple.preference.printfax");
      return { ok: true };
    }
    return { ok: false, error: `未対応のプラットフォーム: ${process.platform}` };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
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
  // ADR-0015: under tabs, "close workspace" means "close every tab".
  // Used by the legacy single-workspace renderer path and by app exit.
  if (tabHandles.size === 0 && !activeWorkspace) return false;
  for (const id of [...tabHandles.keys()]) disposeTab(id);
  disposeActiveDoc();
  activeWorkspace = null;
  activeSourcePdfPath = null;
  activeTabId = null;
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
ipcMain.handle("kpdf3:open-pdf-file", async (_, pdfPath, tabId = null) => {
  // ADR-0015: each tab gets its own workspace handle. If a tabId is
  // passed, we register the new handle under that id (replacing any
  // existing one for the same id). Otherwise generate a fresh tabId.
  const targetTabId = tabId ?? `tab-${Date.now().toString(36)}`;
  // If we're reusing an existing tabId, drop its previous handle so
  // we don't leak the old workspace + doc. (Renderer drives re-opens
  // by passing the same tabId.)
  if (tabHandles.has(targetTabId)) disposeTab(targetTabId);
  // Detach the active-* refs first; we'll re-point them via
  // activateTab() once the new handle is built.
  if (activeTabId === targetTabId) {
    disposeActiveDoc();
    activeWorkspace = null;
    activeSourcePdfPath = null;
  }

  const pdfBytes = readFileSync(pdfPath);
  const fingerprint = await computePdfFingerprint(pdfBytes);
  const sourceName = basename(pdfPath);

  let isNew = false;
  let migrated = false;
  let workspace;
  const existing = findWorkspaceByFingerprint(fingerprint);
  if (existing && existsSync(existing.workspacePath)) {
    workspace = Workspace.open(existing.workspacePath);
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
      workspace = Workspace.open(wsPath);
      migrated = true;
    } else {
      workspace = Workspace.create(wsPath);
      await workspace.importPdfFromFile(pdfPath);
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

  // Open the mupdf Document for this tab. Each tab carries its own
  // handle so a tab switch is just pointer-swapping the active-* refs.
  const bytes = workspace.getSourceBytes();
  const doc = bytes ? openPdfDocument(bytes) : null;
  const pages = workspace.getPages({ includeDeleted: true });
  tabHandles.set(targetTabId, {
    workspace,
    doc,
    pages,
    sourcePdfPath: pdfPath,
    sourceName,
  });
  activateTab(targetTabId);

  return {
    tabId: targetTabId,
    pdfPath,
    pageCount: workspace.getSourceMeta()?.pageCount ?? 0,
    isNew,
    migrated,
    overlays: workspace.loadOverlays(),
  };
});

ipcMain.handle("kpdf3:switch-tab", async (_, tabId) => {
  // tabId === null/undefined → clear active (renderer just navigated
  // to an empty tab that has no main-side handle yet).
  if (tabId == null) {
    activateTab(null);
    return { ok: true, activeTabId: null };
  }
  if (!tabHandles.has(tabId)) throw new Error(`Unknown tab: ${tabId}`);
  activateTab(tabId);
  return { ok: true, activeTabId };
});

ipcMain.handle("kpdf3:close-tab", async (_, tabId) => {
  disposeTab(tabId);
  return { ok: true, remaining: tabHandles.size, activeTabId };
});

ipcMain.handle("kpdf3:list-recent-pdfs", async () => {
  return listRecentPdfs(10);
});

ipcMain.handle("kpdf3:get-outline", async () => {
  if (!activeWorkspace) return [];
  return activeWorkspace.getOutline();
});

ipcMain.handle("kpdf3:list-bookmarks", async () => {
  if (!activeWorkspace) return [];
  return activeWorkspace.listBookmarks();
});

ipcMain.handle("kpdf3:add-bookmark", async (_, { id, title, pageNo, parentId }) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  return activeWorkspace.addBookmark({ id, title, pageNo, parentId: parentId ?? null });
});

ipcMain.handle("kpdf3:rename-bookmark", async (_, { id, title }) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.renameBookmark(id, title);
  return { ok: true };
});

ipcMain.handle("kpdf3:remove-bookmark", async (_, { id }) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.removeBookmark(id);
  return { ok: true };
});

ipcMain.handle("kpdf3:move-bookmark", async (_, { id, parentId, beforeId }) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.moveBookmark(id, {
    parentId: parentId ?? null,
    beforeId: beforeId ?? null,
  });
  return { ok: true };
});

// ---- Assets (image stamps) — ADR-0017 -----------------------------

ipcMain.handle("kpdf3:list-assets", async () => {
  if (!activeWorkspace) return [];
  return activeWorkspace.listAssets();
});

ipcMain.handle("kpdf3:add-asset", async (_, { mime, blob, width, height, label }) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const id = activeWorkspace.addAsset({ mime, blob: u8, width, height, label });
  return { id };
});

ipcMain.handle("kpdf3:get-asset", async (_, id) => {
  if (!activeWorkspace) return null;
  const r = activeWorkspace.getAsset(id);
  if (!r) return null;
  return { ...r, blob: r.blob instanceof Uint8Array ? r.blob : new Uint8Array(r.blob) };
});

ipcMain.handle("kpdf3:remove-asset", async (_, id) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.removeAsset(id);
  return { ok: true };
});

// ---- Stamp presets (ADR-0019 MVP) ---------------------------------

ipcMain.handle("kpdf3:list-stamp-presets", async () => {
  if (!activeWorkspace) return [];
  return activeWorkspace.listStampPresets();
});

ipcMain.handle("kpdf3:add-stamp-preset", async (_, preset) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const id = activeWorkspace.addStampPreset(preset ?? {});
  return { id };
});

ipcMain.handle("kpdf3:remove-stamp-preset", async (_, id) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.removeStampPreset(id);
  return { ok: true };
});

/**
 * Read a local file (PNG/JPG) and register it as a workspace asset.
 * Used by the image-stamp registration UI which only knows the file
 * path. Returns { id, width, height, mime, label }.
 */
ipcMain.handle("kpdf3:add-asset-from-file", async (_, { path: filePath, label }) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  if (!filePath) throw new Error("path missing");
  const buf = readFileSync(filePath);
  // Sniff mime from extension. Image stamps support PNG / JPEG.
  const ext = filePath.toLowerCase().split(".").pop();
  const mime =
    ext === "png" ? "image/png" :
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
    "application/octet-stream";
  // Decode dimensions via the renderer's createImageBitmap path is
  // expensive to do from main; defer width/height to first render
  // (renderer can backfill via update-asset-dims if useful).
  const id = activeWorkspace.addAsset({
    mime,
    blob: new Uint8Array(buf),
    label: label ?? filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? null,
  });
  return { id, mime };
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

ipcMain.handle("kpdf3:pick-export-folder", async () => {
  const dir = activeSourcePdfPath ? dirname(activeSourcePdfPath) : null;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "分割した PDF を保存するフォルダ",
    defaultPath: dir ?? undefined,
    properties: ["openDirectory", "createDirectory"],
  });
  return r.canceled ? null : r.filePaths[0];
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

// Reusable hidden BrowserWindow for silent printing. Singleton avoids
// the close-mid-teardown crash we saw with per-print windows. Destroyed
// on `before-quit` alongside the workspace + registry handles.
//
// Note (M5-4 history): OS dialogs (silent: false) crashed Electron's
// PDF-plugin teardown on Linux + Electron 38. The renderer-side custom
// dialog + silent: true path below avoids that whole code path.
//
// @type {BrowserWindow | null}
let printWindow = null;

function getPrintWindow() {
  if (printWindow && !printWindow.isDestroyed()) return printWindow;
  printWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      plugins: true, // enable Chromium's built-in PDF viewer
      contextIsolation: true,
      sandbox: false,
    },
  });
  return printWindow;
}

/**
 * Silently print a PDF file to a specific printer using
 * webContents.print({ silent: true, deviceName }). No OS print dialog
 * is shown — the renderer-side custom dialog has already collected
 * the user's choices.
 *
 * @param {string} pdfPath
 * @param {{ deviceName: string, copies?: number }} opts
 * @returns {Promise<{ success: boolean }>}
 */
function silentPrintPdf(pdfPath, opts) {
  return new Promise((resolve, reject) => {
    const win = getPrintWindow();
    let settled = false;
    /** @type {(() => void) | null} */
    let cleanup = null;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (cleanup) cleanup();
      fn(value);
    };

    const onDidFinishLoad = () => {
      setTimeout(() => {
        if (settled) return;
        try {
          win.webContents.print(
            {
              silent: true,
              deviceName: opts.deviceName,
              copies: opts.copies ?? 1,
              printBackground: true,
              color: true,
              landscape: opts.landscape ?? false,
            },
            (success, errorType) => {
              if (success) {
                settle(resolve, { success: true });
              } else {
                settle(reject, new Error(errorType || "silent print failed"));
              }
            },
          );
        } catch (err) {
          settle(reject, err);
        }
      }, 250);
    };

    const onDidFailLoad = (_e, code, desc) => {
      settle(reject, new Error(`PDF load failed (${code}): ${desc}`));
    };

    cleanup = () => {
      win.webContents.off("did-finish-load", onDidFinishLoad);
      win.webContents.off("did-fail-load", onDidFailLoad);
    };

    win.webContents.once("did-finish-load", onDidFinishLoad);
    win.webContents.once("did-fail-load", onDidFailLoad);

    win.loadFile(pdfPath).catch((err) => settle(reject, err));
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
  let pdfBytes = assembleRasterizedPdf(pages);
  // §17.14 — write workspace bookmarks back as PDF /Outlines so other
  // viewers (Adobe / Preview / etc.) can navigate them too.
  // pageOrder lines up with the order pages were composed in (the
  // renderer passes the visible-pages list to composePagesForExport,
  // and assembleRasterizedPdf builds the PDF in that same order).
  try {
    const bookmarks = activeWorkspace.listBookmarks();
    if (Array.isArray(bookmarks) && bookmarks.length > 0) {
      const pageOrder = pages.map((p) => p.pageNo);
      pdfBytes = await addFlatOutlinesToPdf(pdfBytes, bookmarks, pageOrder);
    }
  } catch (err) {
    console.error("[export] /Outlines write-back failed (continuing without):", err);
  }
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
 * Enumerate available system printers via the main window's webContents.
 * Each printer has { name, displayName, description, isDefault, status }.
 */
ipcMain.handle("kpdf3:list-printers", async () => {
  if (!mainWindow) return [];
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((p) => ({
      name: p.name,
      displayName: p.displayName ?? p.name,
      description: p.description ?? "",
      isDefault: !!p.isDefault,
      status: p.status ?? 0,
    }));
  } catch (err) {
    console.error("[main] getPrintersAsync failed:", err);
    return [];
  }
});

/**
 * Silent print of a flatten / byte-copy PDF to a chosen printer. The
 * renderer collects deviceName / copies from a custom dialog and calls
 * this; main writes the temp PDF, loads it in the singleton hidden
 * window, and silent-prints. No OS dialog appears.
 *
 * payload:
 *   { source: 'byte-copy' | 'rasterized',
 *     pages?: composedPages[],
 *     deviceName: string,
 *     copies?: number }
 */
ipcMain.handle("kpdf3:print-pdf-silent", async (_, payload) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const {
    source,
    pages,
    deviceName,
    copies = 1,
    landscape = false,
  } = payload ?? {};
  if (!deviceName) throw new Error("print-pdf-silent: deviceName missing");

  let pdfBytes;
  if (source === "byte-copy") {
    pdfBytes = activeWorkspace.getSourceBytes();
    if (!pdfBytes) throw new Error("No source PDF in workspace");
  } else if (source === "rasterized" && Array.isArray(pages) && pages.length > 0) {
    pdfBytes = assembleRasterizedPdf(pages);
  } else {
    throw new Error("print-pdf-silent: invalid source / pages");
  }

  const tempPath = tempPrintPath();
  writeFileSync(tempPath, pdfBytes);
  await silentPrintPdf(tempPath, { deviceName, copies, landscape });
  return { tempPath, deviceName, copies, landscape };
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
  if (pageNo < 0) {
    // Synthetic (user-inserted) pages are rendered on the renderer side
    // (canvas-backed). Main has no canvas API and refuses these.
    throw new Error(
      `Page ${pageNo} is synthetic — render on the renderer side`,
    );
  }
  if (!activeDoc) throw new Error("No PDF loaded");
  // Look up by source-PDF pageNo (sparse-safe after page deletions).
  const row = activePages.find((p) => p.pageNo === pageNo);
  if (!row) throw new Error(`Page ${pageNo} not found in workspace`);
  return renderPageCanonical(activeDoc, row, {
    zoom: opts?.zoom ?? 1.0,
    alpha: opts?.alpha ?? true,
  });
});

ipcMain.handle("kpdf3:get-source-meta", async () => {
  if (!activeWorkspace) return null;
  const meta = activeWorkspace.getSourceMeta();
  // The workspace's stored fileName reflects the PDF first imported into
  // it. With ADR-0007 fingerprint dedupe, byte-copy Save As reuses the
  // original workspace, so the stored name lags behind the file the user
  // is actually viewing. Override with the active path's basename so the
  // title bar / status updates match the user's mental model.
  if (meta && activeSourcePdfPath) {
    meta.fileName = basename(activeSourcePdfPath);
  }
  return meta;
});

ipcMain.handle("kpdf3:get-pages", async () => {
  if (!activeWorkspace) return [];
  return activeWorkspace.getPages();
});

ipcMain.handle("kpdf3:set-page-deleted", async (_, pageNo, deleted) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.setPageDeleted(pageNo, !!deleted);
  return { ok: true };
});

ipcMain.handle("kpdf3:set-page-rotation", async (_, pageNo, userRotation) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.setPageUserRotation(pageNo, userRotation);
  // Refresh activePages so render-page returns the rotated dimensions.
  reopenActiveDoc();
  return { ok: true };
});

ipcMain.handle("kpdf3:reorder-pages", async (_, orderedPageNos) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.reorderPages(orderedPageNos);
  reopenActiveDoc();
  return { ok: true };
});

// Apply a positional reorder across both source + synthetic pages.
ipcMain.handle("kpdf3:reorder-all-pages", async (_, orderedKeys) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.reorderAllPages(orderedKeys);
  reopenActiveDoc();
  return { ok: true };
});

ipcMain.handle("kpdf3:add-inserted-page", async (_, opts) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const syntheticPageNo = activeWorkspace.addInsertedPage(opts ?? {});
  // Refresh activePages so subsequent render-page calls can resolve the new
  // synthetic row (server-side rendering is not used for synthetics, but
  // keeping the cache in sync avoids surprises).
  reopenActiveDoc();
  return { syntheticPageNo };
});

ipcMain.handle("kpdf3:remove-inserted-page", async (_, syntheticPageNo) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.removeInsertedPage(syntheticPageNo);
  reopenActiveDoc();
  return { ok: true };
});

/**
 * Import every page of an external PDF file as image-backed inserted
 * pages, anchored at `afterPageNo`. Each page is rasterised at 144 dpi
 * (zoom 2.0) and stored as a PNG in inserted_pages.image_blob. Returns
 * the new synthetic pageNos so the renderer can scroll to the first
 * inserted page if it wants. (§17.3 MVP: rasterize → synthetic.)
 */
ipcMain.handle(
  "kpdf3:add-inserted-pdf-pages",
  async (_, { afterPageNo, externalPath }) => {
    if (!activeWorkspace) throw new Error("No active workspace");
    if (!externalPath) throw new Error("externalPath missing");
    const buf = readFileSync(externalPath);
    const doc = mupdf.Document.openDocument(
      new Uint8Array(buf),
      "application/pdf",
    );
    const synthetic = [];
    try {
      const count = doc.countPages();
      for (let i = 0; i < count; i++) {
        const page = doc.loadPage(i);
        try {
          const bounds = page.getBounds();
          const pdfW = bounds[2] - bounds[0];
          const pdfH = bounds[3] - bounds[1];
          const ZOOM = 2.0; // 144 dpi
          const matrix = mupdf.Matrix.scale(ZOOM, ZOOM);
          const pixmap = page.toPixmap(
            matrix,
            mupdf.ColorSpace.DeviceRGB,
            false,
            false,
          );
          let imgW, imgH, pngBytes;
          try {
            imgW = pixmap.getWidth();
            imgH = pixmap.getHeight();
            pngBytes = pixmap.asPNG();
          } finally {
            pixmap.destroy?.();
          }
          const syntheticPageNo = activeWorkspace.addInsertedImagePage({
            afterPageNo,
            imageBlob: Buffer.from(pngBytes),
            imageW: imgW,
            imageH: imgH,
            width: pdfW,
            height: pdfH,
          });
          synthetic.push(syntheticPageNo);
        } finally {
          page.destroy?.();
        }
      }
    } finally {
      doc.destroy?.();
    }
    reopenActiveDoc();
    return { syntheticPageNos: synthetic };
  },
);

ipcMain.handle("kpdf3:get-inserted-page-image", async (_, id) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const row = activeWorkspace.getInsertedPageImage(id);
  if (!row) return null;
  // imageBlob comes back as a Buffer from better-sqlite3; convert to
  // a Uint8Array so the IPC serializer doesn't lose typing.
  const u8 = row.imageBlob instanceof Uint8Array
    ? row.imageBlob
    : new Uint8Array(row.imageBlob);
  return { imageBlob: u8, imageW: row.imageW, imageH: row.imageH };
});

ipcMain.handle("kpdf3:get-app-info", async () => {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    isPackaged: app.isPackaged,
  };
});
