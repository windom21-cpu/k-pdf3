// K-PDF3 Electron main process.
//
// Responsibilities:
//   - Window lifecycle
//   - Native dialogs (open / save)
//   - Workspace orchestration via IPC
//   - File I/O on behalf of the renderer
//
// This is the M1 skeleton. Real workspace UI lands in M2.

import { app, BrowserWindow, ipcMain, dialog, Menu, shell, globalShortcut, screen } from "electron";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as mupdf from "mupdf";
import { Workspace } from "../domain/workspace.js";
import { openPdfDocument } from "../backend/mupdf-render.js";
import { addFlatOutlinesToPdf } from "../backend/pdf-outlines.js";
import { PDFDocument, degrees } from "pdf-lib";
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
import {
  listStampPresetsGlobal,
  addStampPresetGlobal,
  removeStampPresetGlobal,
  getStampAssetGlobal,
  addStampAssetFromFileGlobal,
  migrateFromWorkspaceIfEmpty as migrateStampPresetsToGlobalIfEmpty,
  closeStampStore,
} from "./global-stamp-store.js";
import { setupAutoUpdater } from "./updater.js";
import {
  openPrinterPropertiesNative,
  applyUserPrinterDevmode,
  restoreUserPrinterDevmode,
  restoreInflightDevmodeSync,
} from "./printer-properties-win.js";

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

// β51 J7: crash log. ユーザー報告「PDF 開いて閉じて、次の PDF を開こう
// とするとクラッシュ」「アップデート時に zombie が残る」など、ハード
// 落ち系の事象が再現性低めで根本原因の特定が難しい。 main process
// のあらゆる例外 / 子プロセス死亡 / renderer 死亡を timestamp 付き
// で userData/crash.log に append しておけば、次に発生したときに
// ユーザーがファイルを共有してくれれば確実に診断できる。
function crashLogPath() {
  return join(app.getPath("userData"), "crash.log");
}
function logCrash(label, err) {
  try {
    const ts = new Date().toISOString();
    let detail;
    if (err == null) detail = "(no detail)";
    else if (err instanceof Error) detail = err.stack ?? err.message ?? String(err);
    else if (typeof err === "object") {
      try { detail = JSON.stringify(err); } catch { detail = String(err); }
    } else detail = String(err);
    appendFileSync(crashLogPath(), `[${ts}] ${label}: ${detail}\n`);
  } catch {
    // Can't log? nothing we can do — don't cascade into another crash.
  }
}
process.on("uncaughtException", (err) => {
  logCrash("uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  logCrash("unhandledRejection", reason);
});
app.on("render-process-gone", (_event, webContents, details) => {
  logCrash("render-process-gone", details);
});
app.on("child-process-gone", (_event, details) => {
  logCrash("child-process-gone", details);
});
// Mark each session start so the log is easy to read chronologically.
// Deferred to whenReady because logCrash uses app.getPath('userData')
// which is only safe after the app is initialised.
app.whenReady().then(() => {
  logCrash("session-start", `pid=${process.pid} version=${app.getVersion()}`);
});
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
  // β34: inserted-source-pdf doc cache is workspace-scoped — destroy when
  // switching workspaces so mupdf doesn't keep handles into a closed file.
  _destroyInsertedSourceCache();
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

/** Persisted window-state path. Keeping it next to stamps.db in userData
 *  so it lives across upgrades but is wiped if the user removes the app
 *  config. */
function windowStatePath() {
  return join(app.getPath("userData"), "window-state.json");
}

/** Read last-saved bounds + maximized flag. Returns null on any failure
 *  (missing file, malformed JSON, off-screen bounds). The caller falls
 *  back to the historical default size. */
function loadWindowState() {
  try {
    const p = windowStatePath();
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const w = Number(raw.width), h = Number(raw.height);
    const x = raw.x == null ? null : Number(raw.x);
    const y = raw.y == null ? null : Number(raw.y);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 320 || h < 240) return null;
    // Off-screen guard: if the saved x/y put the top-left outside every
    // current display, drop the position (Electron will center). Width/
    // height are still honoured.
    let pos = null;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height;
      });
      if (onScreen) pos = { x, y };
    }
    return {
      width: Math.round(w),
      height: Math.round(h),
      ...(pos ?? {}),
      maximized: raw.maximized === true,
    };
  } catch {
    return null;
  }
}

/** Persist current bounds + maximized state. Called on the window's
 *  close event. `getNormalBounds` returns the un-maximized rect so we
 *  remember the user's manual size for next launch. */
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    writeFileSync(
      windowStatePath(),
      JSON.stringify({ ...b, maximized }, null, 2),
      "utf8",
    );
  } catch (err) {
    console.warn("[window-state] save failed:", err);
  }
}

function createMainWindow() {
  const saved = loadWindowState();
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1100,
    height: saved?.height ?? 820,
    ...(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
      ? { x: saved.x, y: saved.y } : {}),
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
  if (saved?.maximized) mainWindow.maximize();
  mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"));
  // Flush any PDF paths the OS handed us via argv / open-file once the
  // renderer is ready to receive IPC. did-finish-load fires after the
  // initial HTML + scripts have settled.
  mainWindow.webContents.once("did-finish-load", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    while (pendingOpens.length > 0) {
      const p = pendingOpens.shift();
      mainWindow.webContents.send("kpdf3:open-pdf-by-os", p);
    }
  });
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
  // Persist size + position on close. `close` fires before `closed` and
  // still has live bounds; `closed` would return zeros. Saving inside
  // close (not on resize/move) avoids hammering the disk while the user
  // is dragging the edge.
  //
  // β50 J6: when a print job is still in flight, block the close and
  // ask the user whether to wait for it or cancel the spool. Adobe-
  // style: clicking 「キャンセルして終了」kills Sumatra / tears down
  // the FAX OS dialog before quitting. Default = wait so an accidental
  // X click doesn't murder a long-running print.
  mainWindow.on("close", (event) => {
    if (isPrintInFlight()) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "warning",
        buttons: ["完了まで待つ", "印刷をキャンセルして終了"],
        defaultId: 0,
        cancelId: 0,
        title: "印刷ジョブ進行中",
        message: "印刷ジョブが進行中です。",
        detail:
          "今アプリを閉じると印刷が途中で止まる可能性があります。" +
          "完了まで待つか、印刷をキャンセルして終了するか選んでください。",
      });
      if (choice === 0) {
        // "wait" — keep the window alive. User clicks X again later
        // (after status bar shows print completed).
        event.preventDefault();
        return;
      }
      // Cancel + quit path: kill the active spool then fall through to
      // the normal close save / disposal flow below.
      cancelInFlightPrint();
    }
    saveWindowState(mainWindow);
  });
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

// ---- OS-driven PDF file open (Windows / Linux / macOS) -------------------
//
// File-association (build.fileAssociations in package.json) registers
// K-PDF3 as a candidate "Open with" app for .pdf files. When the user
// chooses K-PDF3 from the OS file manager, the OS launches the binary
// with the PDF path either on argv (Win/Linux) or via the macOS
// `open-file` AppleEvent. We capture those paths here and forward them
// to the renderer via `kpdf3:open-pdf-by-os`.
//
// `pendingOpens` buffers paths that arrive BEFORE the renderer is
// ready (the most common case at cold start — argv is available the
// moment the main process boots). They're flushed once the renderer
// has finished its initial load.

/** @type {string[]} */
const pendingOpens = [];

/** Walk argv looking for a .pdf path the OS handed us. argv[0] is the
 *  electron binary; subsequent entries can include CLI flags (which we
 *  skip) plus the file path. */
function pdfPathsFromArgv(argv) {
  /** @type {string[]} */
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== "string") continue;
    if (a.startsWith("-")) continue; // flags
    if (!/\.pdf$/i.test(a)) continue;
    if (!existsSync(a)) continue;
    out.push(a);
  }
  return out;
}

// Single-instance: when the user double-clicks another PDF while K-PDF3
// is already running, route the new path to the existing window instead
// of launching a duplicate process.
//
// β47 J5: zombie auto-recovery. If autoUpdater's process kill failed to
// fully reap the previous version, a stale K-PDF3.exe lingers in the
// task list and holds the singleton mutex. The next launch then
// silently quits because requestSingleInstanceLock() returns false,
// looking like "nothing happens" to the user. Heuristic recovery:
//   - PDF arg present (Explorer double-click on .pdf): a healthy first
//     instance handles the OS file event via second-instance. Quit
//     normally so we don't murder a live editor session.
//   - No PDF arg (user clicked the K-PDF3 icon to launch): the lock
//     fail almost certainly means zombie. Kill all other K-PDF3.exe
//     processes (except us) via taskkill, busy-wait briefly for the
//     mutex to release, then retry. If retry succeeds, continue
//     normally.
let gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock
    && process.platform === "win32"
    && pdfPathsFromArgv(process.argv).length === 0) {
  // β48 J5b: β47 used Atomics.wait + SharedArrayBuffer for a precise
  // synchronous sleep but Electron's main process disables shared
  // memory by default → the call threw, the unhandled error escaped
  // the script and the new instance crashed silently on launch. The
  // user saw the same "click does nothing" symptom and had to manually
  // kill via Task Manager. Replace with a plain busy-wait inside a
  // try/catch so any koffi/taskkill failure can't take down startup.
  try {
    spawnSync(
      "taskkill",
      ["/F", "/IM", "K-PDF3.exe", "/FI", `PID ne ${process.pid}`],
      { stdio: "ignore", windowsHide: true },
    );
    // Busy-wait up to 1s for the killed process's mutex to be released.
    // 50ms ticks; CPU pegging at startup is acceptable for this rescue
    // path. 1s is plenty for the kernel to reap a force-killed process.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      gotInstanceLock = app.requestSingleInstanceLock();
      if (gotInstanceLock) break;
      const tick = Date.now() + 50;
      while (Date.now() < tick) { /* spin */ }
    }
  } catch (err) {
    // Last-resort log to stderr — visible if run with --enable-logging
    // or when the user attaches a console. Never throw from here.
    console.warn("[startup] zombie-kill recovery failed:", err?.message ?? err);
  }
}
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const paths = pdfPathsFromArgv(argv);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      for (const p of paths) {
        mainWindow.webContents.send("kpdf3:open-pdf-by-os", p);
      }
    } else {
      pendingOpens.push(...paths);
    }
  });
}

// macOS: file launches come through this AppleEvent rather than argv.
app.on("open-file", (event, path) => {
  event.preventDefault();
  if (!path || !/\.pdf$/i.test(path)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("kpdf3:open-pdf-by-os", path);
  } else {
    pendingOpens.push(path);
  }
});

// Catch argv-borne paths from cold launch.
pendingOpens.push(...pdfPathsFromArgv(process.argv));

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
  // Wire auto-update (§17.15). No-op in dev mode (!app.isPackaged) and
  // when launched with --no-update. The initial check fires ~3s after
  // the window is shown so the renderer has time to subscribe.
  if (mainWindow) setupAutoUpdater(mainWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // β49 J4c: emergency restore of per-user printer DEVMODE if a print
  // job was in-flight when the user closed the window. process.exit()
  // doesn't wait for the print-pdf-silent Promise's finally clause, so
  // without this hook the printer would be left with our modified
  // per-user default (e.g. mono / tray2 / duplex) and the next app
  // would print with those settings unexpectedly. Synchronous call so
  // it completes before the process actually exits.
  try { restoreInflightDevmodeSync(); } catch { /* ignore */ }
  // Close every tab so SQLite WAL flushes for each workspace.
  for (const id of [...tabHandles.keys()]) disposeTab(id);
  disposeActiveDoc();
  // β34: release mupdf handles for inserted-source-pdf cache so no
  // dangling Document/Page/Pixmap objects are left when the WASM heap
  // tears down.
  _destroyInsertedSourceCache();
  if (activeWorkspace) {
    try { activeWorkspace.close(); } catch { /* ignore */ }
    activeWorkspace = null;
  }
  activeSourcePdfPath = null;
  activeTabId = null;
  closeRegistry();
  closeStampStore();
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
      let isDir = ent.isDirectory();
      let targetPath = null;
      // Windows .lnk shortcuts: shell.readShortcutLink resolves the
      // shortcut's target so the user can navigate INTO a shortcut-
      // to-folder from the in-app file browser. β15 testers reported
      // being unable to open desktop shortcut folders (e.g., a
      // 「業務フォルダ」 shortcut on Desktop). When the resolved
      // target is itself a directory we mark isDir=true and the
      // renderer's click handler navigates to targetPath. Shortcut-
      // to-file isn't handled here — the file dialog's filter
      // wouldn't accept the .lnk anyway.
      if (process.platform === "win32"
          && !isDir
          && ent.name.toLowerCase().endsWith(".lnk")) {
        try {
          const link = shell.readShortcutLink(full);
          if (link?.target) {
            try {
              const targetSt = await stat(link.target);
              if (targetSt.isDirectory()) {
                isDir = true;
                targetPath = link.target;
              }
            } catch { /* dangling shortcut — leave as a plain .lnk */ }
          }
        } catch { /* not a parseable shortcut — leave as plain file */ }
      }
      entries.push({
        name: ent.name,
        isDir,
        size: st.size,
        mtimeMs: st.mtimeMs,
        targetPath,
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
// Sender-aware so popup windows can also close themselves via the
// same IPC. For the main window this resolves identically to
// `mainWindow.close()`.
ipcMain.handle("kpdf3:window-close", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
});
ipcMain.handle("kpdf3:window-is-maximized", async () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.handle("kpdf3:toggle-always-on-top", async (event, on) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  win.setAlwaysOnTop(!!on);
  return win.isAlwaysOnTop();
});

ipcMain.handle("kpdf3:resize-popup-to-fit", async (event, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const { width: imgW, height: imgH } = opts ?? {};
  if (!imgW || !imgH) return;
  // Pick a reasonable default size: 75% of screen height, scaled to
  // the page's aspect, then add the 22-px popup-bar.
  const display = require("electron").screen.getPrimaryDisplay();
  const targetH = Math.max(400, Math.round(display.workAreaSize.height * 0.75));
  const aspect = imgW / imgH;
  const targetW = Math.round(targetH * aspect) + 16; // tiny padding
  const cappedW = Math.min(targetW, display.workAreaSize.width - 40);
  const cappedH = Math.min(targetH + 22, display.workAreaSize.height - 40);
  win.setSize(cappedW, cappedH);
  win.center();
});

/**
 * Open a frameless popup BrowserWindow that displays a single
 * pre-rendered page PNG. Used by ツール > 別窓で表示 / toolbar 別窓
 * for side-by-side comparison with another file.
 */
const popupWindows = new Set();
ipcMain.handle("kpdf3:open-page-popup", async (_event, payload) => {
  const win = new BrowserWindow({
    width: 800,
    height: 1000,
    title: "K-PDF3 ポップアップ",
    icon: join(__dirname, "..", "renderer", "vendor", "app-icon.png"),
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  popupWindows.add(win);
  win.on("closed", () => popupWindows.delete(win));
  win.loadFile(join(__dirname, "..", "renderer", "page-popup.html"));
  // Wait for the renderer to finish booting, then push the payload.
  win.webContents.once("did-finish-load", () => {
    if (!win.isDestroyed()) {
      win.webContents.send("kpdf3:popup-data", payload);
    }
  });
  return { ok: true };
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
ipcMain.handle("kpdf3:printer-properties", async (event, deviceName) => {
  if (!deviceName) return { ok: false, error: "プリンタ名が指定されていません" };
  try {
    if (process.platform === "win32") {
      // Try the DPI-aware DocumentProperties path so the driver UI
      // renders crisply on 4K monitors. The helper falls back to the
      // legacy rundll32 path internally if koffi / the API call fails.
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      const hwndBuf = senderWin?.getNativeWindowHandle?.() ?? null;
      return await openPrinterPropertiesNative(deviceName, hwndBuf);
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

  // First-run migration of workspace-local stamp presets to the
  // global stamps.db. Idempotent — only fires when the global store
  // is empty AND the just-opened workspace has presets to copy. Runs
  // every open so β testers who registered presets in any of several
  // workspaces under the old design get the first one's set surfaced.
  try {
    migrateStampPresetsToGlobalIfEmpty(workspace);
  } catch (err) {
    console.warn("[stamp-presets] global migration failed (non-fatal):", err);
  }

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

ipcMain.handle("kpdf3:open-crash-log", async () => {
  const path = crashLogPath();
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  try {
    await shell.openPath(path);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
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
  // Workspace first; fall back to the global stamp store so image
  // stamps (now stored globally — see global-stamp-store.js) render
  // even when the active workspace's `assets` table is empty.
  let r = activeWorkspace ? activeWorkspace.getAsset(id) : null;
  if (!r) {
    try {
      r = getStampAssetGlobal(id);
    } catch {
      r = null;
    }
  }
  if (!r) return null;
  return { ...r, blob: r.blob instanceof Uint8Array ? r.blob : new Uint8Array(r.blob) };
});

ipcMain.handle("kpdf3:remove-asset", async (_, id) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  activeWorkspace.removeAsset(id);
  return { ok: true };
});

// ---- Stamp presets (ADR-0019 MVP, global since β bug-fix pass) -----
//
// Presets and their image bytes live in <userData>/stamps.db so a
// stamp registered against one PDF appears for every other PDF the
// user opens. Workspace-side stamp_presets remains as legacy data;
// migrateFromWorkspaceIfEmpty pulls it into the global store on the
// first open after upgrade.

ipcMain.handle("kpdf3:list-stamp-presets", async () => {
  return listStampPresetsGlobal();
});

ipcMain.handle("kpdf3:add-stamp-preset", async (_, preset) => {
  const id = addStampPresetGlobal(preset ?? {});
  return { id };
});

ipcMain.handle("kpdf3:remove-stamp-preset", async (_, id) => {
  removeStampPresetGlobal(id);
  return { ok: true };
});

/**
 * Read a local file (PNG/JPG) and register it as a stamp asset in the
 * global store. Used by the image-stamp registration UI which only
 * knows the file path. Returns { id, mime, label }.
 */
ipcMain.handle("kpdf3:add-asset-from-file", async (_, { path: filePath, label }) => {
  if (!filePath) throw new Error("path missing");
  const fallbackLabel =
    label ?? filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? null;
  return addStampAssetFromFileGlobal(filePath, fallbackLabel);
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
/**
 * Hybrid PDF assembly. Each page is one of:
 *
 *   - strategy "source"  → copy the original PDF page verbatim. Vector
 *                          text and lines stay crisp at any zoom; file
 *                          stays small.
 *   - strategy "overlay" → copy the source page, then drop a PNG layer
 *                          (transparent background) on top so overlays
 *                          (text boxes, stamps, marker, etc.) render
 *                          above the preserved vectors.
 *   - strategy "full"    → no source vector to preserve (synthetic page
 *                          inserted by the user, or a rotated source
 *                          page where overlay alignment under hybrid
 *                          would be off): rasterized full-page JPEG.
 *
 * Replaces the earlier mupdf-only assembler that always image-encoded
 * every page → ballooned legal-document outputs to 100 MB / page even
 * for content the source already carried as vectors.
 *
 * @param {Array<{ pageNo: number, widthPt: number, heightPt: number,
 *                  strategy: "source" | "overlay" | "full",
 *                  sourceIdx: number | null,
 *                  userRotation?: 0 | 90 | 180 | 270,
 *                  imageBytes?: Uint8Array }>} pages
 * @param {Uint8Array | null} sourceBytes raw source-PDF bytes
 * @returns {Promise<Buffer>}
 */
async function assembleHybridPdf(pages, sourceBytes) {
  const newPdf = await PDFDocument.create();
  const sourcePdf = sourceBytes
    ? await PDFDocument.load(sourceBytes, { ignoreEncryption: true })
    : null;
  // β31: cache external-source PDFDocument handles per inserted_source_pdfs.id.
  // Multiple inserted pages from the same external PDF share one PDFDocument
  // so copyPages doesn't re-parse the bytes for every page.
  const externalPdfCache = new Map();
  async function getExternalPdf(id) {
    if (externalPdfCache.has(id)) return externalPdfCache.get(id);
    if (!activeWorkspace) {
      throw new Error("assembleHybridPdf: external-source requested but no active workspace");
    }
    const row = activeWorkspace.getInsertedSourcePdf(id);
    if (!row || !row.pdfBlob) {
      throw new Error(`assembleHybridPdf: inserted_source_pdfs id=${id} not found`);
    }
    const doc = await PDFDocument.load(row.pdfBlob, { ignoreEncryption: true });
    externalPdfCache.set(id, doc);
    return doc;
  }
  for (const p of pages) {
    const userRot = (((p.userRotation ?? 0) % 360) + 360) % 360;
    if (p.strategy === "source") {
      if (!sourcePdf) throw new Error("assembleHybridPdf: source page strategy but no source PDF");
      if (userRot === 0) {
        // Fast path — verbatim copy retains the source page's intrinsic
        // /Rotate so vectors stay crisp at native zoom.
        const [copied] = await newPdf.copyPages(sourcePdf, [p.sourceIdx]);
        newPdf.addPage(copied);
      } else {
        await _placeRotatedSourcePage(newPdf, sourcePdf, p, userRot, null);
      }
    } else if (p.strategy === "overlay") {
      if (!sourcePdf) throw new Error("assembleHybridPdf: overlay strategy but no source PDF");
      if (userRot === 0) {
        const [copied] = await newPdf.copyPages(sourcePdf, [p.sourceIdx]);
        newPdf.addPage(copied);
        if (p.imageBytes && p.imageBytes.length > 0) {
          const overlayImg = await newPdf.embedPng(p.imageBytes);
          // Draw the overlay across the (canonical) page bounds. pdf-lib's
          // coordinate origin is bottom-left; the overlay PNG was authored
          // with y-down semantics for the same canvas dimensions, and
          // pdf-lib's drawImage flips it back to right-side-up — matches
          // the on-screen overlay orientation.
          copied.drawImage(overlayImg, {
            x: 0,
            y: 0,
            width: p.widthPt,
            height: p.heightPt,
          });
        }
      } else {
        await _placeRotatedSourcePage(newPdf, sourcePdf, p, userRot, p.imageBytes);
      }
    } else if (p.strategy === "external") {
      // β31: vector-preserving external PDF insertion. Pull the stored
      // source PDF (dedup'd via inserted_source_pdfs) and copyPages the
      // referenced page. Overlays (when any) ride on top as a PNG layer,
      // same shape as the "overlay" strategy.
      if (p.externalSourcePdfId == null || p.externalSourcePageIndex == null) {
        throw new Error(`assembleHybridPdf: external strategy missing source ids (page ${p.pageNo})`);
      }
      const extDoc = await getExternalPdf(p.externalSourcePdfId);
      if (userRot === 0) {
        const [copied] = await newPdf.copyPages(extDoc, [p.externalSourcePageIndex]);
        newPdf.addPage(copied);
        if (p.imageBytes && p.imageBytes.length > 0) {
          const overlayImg = await newPdf.embedPng(p.imageBytes);
          copied.drawImage(overlayImg, {
            x: 0,
            y: 0,
            width: p.widthPt,
            height: p.heightPt,
          });
        }
      } else {
        // Reuse the rotated-source helper with the external doc as source
        // and `externalSourcePageIndex` standing in for `sourceIdx`.
        await _placeRotatedSourcePage(
          newPdf,
          extDoc,
          { ...p, sourceIdx: p.externalSourcePageIndex },
          userRot,
          p.imageBytes,
        );
      }
    } else if (p.strategy === "full") {
      if (!p.imageBytes || p.imageBytes.length === 0) {
        throw new Error(`assembleHybridPdf: full strategy without imageBytes (page ${p.pageNo})`);
      }
      // Header sniff: first two bytes of JPEG are 0xFF 0xD8.
      const isJpeg = p.imageBytes[0] === 0xff && p.imageBytes[1] === 0xd8;
      const img = isJpeg
        ? await newPdf.embedJpg(p.imageBytes)
        : await newPdf.embedPng(p.imageBytes);
      const page = newPdf.addPage([p.widthPt, p.heightPt]);
      page.drawImage(img, { x: 0, y: 0, width: p.widthPt, height: p.heightPt });
    } else {
      throw new Error(`assembleHybridPdf: unknown strategy "${p.strategy}" on page ${p.pageNo}`);
    }
  }
  const bytes = await newPdf.save();
  return Buffer.from(bytes);
}

/**
 * Place a rotated source page (β5 §17.15 follow-up: hybrid for rotated
 * pages) onto a freshly-added canonical-sized page in newPdf, then
 * (optionally) draw an overlay PNG on top.
 *
 * Approach: embed the source page as a PDFEmbeddedPage (pdf-lib bakes
 * in the source's intrinsic /Rotate when computing the embedded form's
 * bounding box, so the embedded form is *already* in "post-/Rotate"
 * orientation). We then drawPage with the additional userRotation, plus
 * a translation that keeps the rotated bounding box inside the new
 * canvas. This keeps source content as vectors so text stays crisp —
 * β4 fell back to full-rasterize JPEG which blurred + bloated.
 *
 * Translation table — `embedded.width` / `embedded.height` are the
 * post-/Rotate displayed dimensions. After rotating CCW by `userRot`
 * around the placement point (x, y), the embedded form's corners need
 * to land in the first quadrant [0, canonicalW] × [0, canonicalH].
 *
 *   userRot=0   → (x, y) = (0, 0)             new page = (W_emb, H_emb)
 *   userRot=90  → (x, y) = (H_emb, 0)          new page = (H_emb, W_emb)
 *   userRot=180 → (x, y) = (W_emb, H_emb)      new page = (W_emb, H_emb)
 *   userRot=270 → (x, y) = (0, W_emb)          new page = (H_emb, W_emb)
 *
 * The overlay PNG, when present, is drawn AFTER the rotated source so
 * it sits on top at (0, 0) of the new page in canonical dimensions —
 * no transform needed because the overlay was rendered by the renderer
 * in canonical/post-rotation coordinates.
 */
async function _placeRotatedSourcePage(newPdf, sourcePdf, p, userRot, overlayBytes) {
  const [embedded] = await newPdf.embedPdf(sourcePdf, [p.sourceIdx]);
  const page = newPdf.addPage([p.widthPt, p.heightPt]);
  const W = embedded.width;
  const H = embedded.height;
  let tx = 0;
  let ty = 0;
  if (userRot === 90) { tx = H; ty = 0; }
  else if (userRot === 180) { tx = W; ty = H; }
  else if (userRot === 270) { tx = 0; ty = W; }
  page.drawPage(embedded, {
    x: tx,
    y: ty,
    width: W,
    height: H,
    rotate: degrees(userRot),
  });
  if (overlayBytes && overlayBytes.length > 0) {
    const overlayImg = await newPdf.embedPng(overlayBytes);
    page.drawImage(overlayImg, {
      x: 0,
      y: 0,
      width: p.widthPt,
      height: p.heightPt,
    });
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
          // FAX: silent:true で送信すると Chromium がドライバ UI を
          // 抑止し送信先入力ダイアログ無しで失敗 → silent:false で OS
          // 印刷ダイアログを通す。FAX 以外は従来通り silent:true。
          const useSilent = !isFaxDevice(opts.deviceName);
          // β46 J3: webContents.print の duplexMode / color に駆動側
          // プロパティを反映。Chromium API は tray (bin) を持たない
          // ので opts.bin は無視される (Sumatra 経路でのみ効く)。
          const duplexMode =
            opts.duplex === "long-edge" ? "longEdge"
            : opts.duplex === "short-edge" ? "shortEdge"
            : opts.duplex === "simplex" ? "simplex"
            : undefined;
          const colorOpt = opts.color === "mono" ? false : true;
          win.webContents.print(
            {
              silent: useSilent,
              deviceName: opts.deviceName,
              copies: opts.copies ?? 1,
              printBackground: true,
              color: colorOpt,
              landscape: opts.landscape ?? false,
              ...(duplexMode ? { duplexMode } : {}),
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
 * Resolve the bundled SumatraPDF.exe path. Packaged via electron-builder's
 * extraResources → lands at `<resourcesPath>/sumatrapdf/SumatraPDF.exe`.
 * In dev (npm start) we read from `<repo>/vendor/sumatrapdf/SumatraPDF.exe`.
 * Returns null when the binary isn't present (Mac/Linux builds, dev tree
 * without the vendored exe, etc.).
 */
function sumatraPath() {
  if (process.platform !== "win32") return null;
  const candidates = [
    join(process.resourcesPath, "sumatrapdf", "SumatraPDF.exe"),
    join(__dirname, "..", "..", "vendor", "sumatrapdf", "SumatraPDF.exe"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Print via the bundled SumatraPDF (Windows). SumatraPDF parses the PDF
 * with its own engine and sends a print job directly via WinSpool —
 * bypasses Chromium's PDF plugin entirely. Used for the rasterized path
 * because Chromium silent print stalls (~55s → fail) on certain hardware
 * drivers (β3 testing reproduced this on FUJIFILM Apeos C2360 wireless)
 * when handed mupdf-generated PDFs with large PNG XObjects.
 *
 *   SumatraPDF.exe -print-to "<deviceName>"
 *     -print-settings "<settings>" -silent -exit-when-done <pdfPath>
 *
 * `-print-settings` accepts a comma-separated string: `Nx` for copies,
 * `landscape`/`portrait`, `noscale`/`shrink`/`fit`, etc. We pre-rasterize
 * to canonical PDF-point dimensions so `noscale` is correct.
 */
/** Active SumatraPDF child for cancel support; set during print, cleared
 *  on exit or by `kpdf3:cancel-print`. */
let _activeSumatraProcess = null;

/**
 * Heuristic: does the device name look like a FAX device?
 * Most FAX drivers pop a「送信先番号」prompt during the print spool
 * call, and -silent suppresses driver UI → driver fails with exit 1
 * (β41 user report on a複合機 FAX 経路). Latin "fax" + Japanese
 * カタカナ variants. False positives (a normal printer named "Fax-
 * Server") just lose the silent flag, which is harmless.
 */
function isFaxDevice(name) {
  if (!name) return false;
  if (/fax/i.test(name)) return true;
  return /ファックス|ファクス|ﾌｧｯｸｽ|ﾌｧｸｽ/.test(name);
}

function sumatraPrintPdf(pdfPath, opts) {
  return new Promise((resolve, reject) => {
    const exe = sumatraPath();
    if (!exe) {
      reject(new Error("SumatraPDF not bundled (vendor/sumatrapdf/SumatraPDF.exe missing)"));
      return;
    }
    const settings = [];
    if (opts.copies && opts.copies > 1) settings.push(`${opts.copies}x`);
    if (opts.landscape) settings.push("landscape");
    settings.push("noscale");
    // β46 J3: forward duplex / tray / color from the driver プロパティ
    // dialog so the user's picks aren't lost between dialog OK and
    // spool. Sumatra -print-settings tokens (see vendor/sumatrapdf
    // command-line docs): simplex / duplex (=duplexlong) / duplexshort,
    // color / monochrome, bin=N for tray.
    if (opts.duplex === "simplex") settings.push("simplex");
    else if (opts.duplex === "long-edge") settings.push("duplex");
    else if (opts.duplex === "short-edge") settings.push("duplexshort");
    if (opts.color === "color") settings.push("color");
    else if (opts.color === "mono") settings.push("monochrome");
    if (Number.isInteger(opts.bin) && opts.bin > 0) settings.push(`bin=${opts.bin}`);
    const isFax = isFaxDevice(opts.deviceName);
    const args = [
      "-print-to", opts.deviceName,
      "-print-settings", settings.join(","),
      // FAX devices: drop -silent so the driver's 送信先入力ダイアログが
      // 立ち上がれる経路を空ける。-silent 付きだとドライバ UI が抑止
      // されて driver は exit 1 (stderr 出力もなし) で失敗する。
      ...(isFax ? [] : ["-silent"]),
      "-exit-when-done",
      pdfPath,
    ];
    const sp = spawn(exe, args, { windowsHide: true });
    _activeSumatraProcess = sp;
    let stderr = "";
    sp.stderr?.on("data", (d) => { stderr += d.toString(); });
    sp.on("error", (err) => {
      _activeSumatraProcess = null;
      reject(err);
    });
    sp.on("close", (code) => {
      _activeSumatraProcess = null;
      if (code === 0) resolve({ success: true });
      else reject(new Error(`SumatraPDF print failed (exit ${code}): ${stderr.trim() || "no output"}`));
    });
  });
}

/**
 * Abort whatever silent-print is in flight. Best-effort: we can cleanly
 * kill the SumatraPDF subprocess, but Chromium's `webContents.print` has
 * no public cancellation API — the callback will still eventually fire
 * and we silently ignore it.
 */
ipcMain.handle("kpdf3:cancel-print", async () => {
  if (_activeSumatraProcess) {
    try { _activeSumatraProcess.kill(); } catch { /* ignore */ }
    _activeSumatraProcess = null;
    return { ok: true, killed: "sumatra" };
  }
  return { ok: true, killed: null };
});

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
  const sourceBytes = activeWorkspace.getSourceBytes() ?? null;
  let pdfBytes = await assembleHybridPdf(pages, sourceBytes);
  // §17.14 — write workspace bookmarks back as PDF /Outlines so other
  // viewers (Adobe / Preview / etc.) can navigate them too.
  // pageOrder lines up with the order pages were composed in (the
  // renderer passes the visible-pages list to composePagesForExport,
  // and assembleHybridPdf builds the PDF in that same order).
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
// β50 J6: track in-flight print job so we can block window close with
// a confirmation dialog ("印刷中です。完了を待ちますか / キャンセル
// して終了しますか") rather than letting the user kill the app mid-
// spool and end up with a half-printed page or unsent FAX.
let _printInFlight = false;
function isPrintInFlight() { return _printInFlight; }
function cancelInFlightPrint() {
  if (_activeSumatraProcess) {
    try { _activeSumatraProcess.kill(); } catch { /* ignore */ }
    _activeSumatraProcess = null;
  }
  // Chromium path (FAX / byte-copy): destroying printWindow tears down
  // the offscreen renderer that owns webContents.print's OS dialog.
  // For a FAX that's still in the driver-side fax-number dialog this
  // dismisses without sending; for one already submitted to the OS
  // spooler it's already too late to recall (correct semantics).
  if (printWindow && !printWindow.isDestroyed()) {
    try { printWindow.destroy(); } catch { /* ignore */ }
    printWindow = null;
  }
}

ipcMain.handle("kpdf3:print-pdf-silent", async (_, payload) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const {
    source,
    pages,
    deviceName,
    copies = 1,
    landscape = false,
    // β46 J3: extras from the driver プロパティダイアログ. null/
    // undefined = leave Sumatra's defaults alone for that field.
    duplex = null,   // "simplex" | "long-edge" | "short-edge"
    bin = null,      // dmDefaultSource integer
    color = null,    // "mono" | "color"
  } = payload ?? {};
  if (!deviceName) throw new Error("print-pdf-silent: deviceName missing");

  let pdfBytes;
  if (source === "byte-copy") {
    pdfBytes = activeWorkspace.getSourceBytes();
    if (!pdfBytes) throw new Error("No source PDF in workspace");
  } else if (source === "rasterized" && Array.isArray(pages) && pages.length > 0) {
    const sourceBytes = activeWorkspace.getSourceBytes() ?? null;
    pdfBytes = await assembleHybridPdf(pages, sourceBytes);
  } else {
    throw new Error("print-pdf-silent: invalid source / pages");
  }

  const tempPath = tempPrintPath();
  writeFileSync(tempPath, pdfBytes);
  // Windows + rasterized: hand off to bundled SumatraPDF, which uses its
  // own PDF engine + WinSpool directly. Chromium silent print stalls on
  // some hardware drivers (β3 testing reproduced ~55s timeout on FUJIFILM
  // Apeos C2360 wireless) when handed our mupdf-generated PDFs with
  // large PNG XObjects. byte-copy keeps using Chromium silent print —
  // the source PDF is normal-shape and goes through quickly.
  //
  // β42 J2: FAX devices CANNOT go through Sumatra at all — mupdf +
  // WinSpool fails to initialize the FAX driver ("プリンタを初期化でき
  // ませんでした" / exit 1). Routing FAX to silentPrintPdf, which in
  // turn already uses silent:false for FAX (β42 J1) → OS print dialog
  // pops, user enters fax number through the driver UI, send. The
  // β3-era Chromium stall was specifically silent:TRUE + mupdf PDFs;
  // silent:false uses a different code path (interactive spool) that
  // does not stall.
  const isFax = isFaxDevice(deviceName);
  const useSumatra =
    process.platform === "win32"
    && source === "rasterized"
    && !isFax
    && sumatraPath() !== null;
  // β48 J4b: push the user-modified DEVMODE (with driver-private
  // extension intact) as per-user default. Sumatra reads it via its
  // own GetPrinter call → tray + preset choices land correctly even
  // when stored in the driver's private DEVMODE extension. Chromium
  // (FAX / byte-copy) also benefits because webContents.print's OS
  // dialog uses the same per-user default. Best-effort: null token =
  // no cached DEVMODE → run without override.
  let devmodeToken = null;
  if (process.platform === "win32") {
    devmodeToken = await applyUserPrinterDevmode(deviceName);
  }
  _printInFlight = true;
  try {
    if (useSumatra) {
      await sumatraPrintPdf(tempPath, { deviceName, copies, landscape, duplex, bin, color });
    } else {
      await silentPrintPdf(tempPath, { deviceName, copies, landscape, duplex, bin, color });
    }
  } finally {
    _printInFlight = false;
    if (devmodeToken) await restoreUserPrinterDevmode(devmodeToken);
  }
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
 * pages, anchored at `afterPageNo`.
 *
 * β31: dual-track storage —
 *   - image_blob (300 dpi PNG): viewer-preview path. Bumped from 144 dpi
 *     to make the on-screen preview sharp; printer/export does NOT use
 *     this when source_pdf_id is available.
 *   - inserted_source_pdfs (vector): the entire external PDF is stored
 *     once (dedup by SHA-256). Exporter/print uses copyPages on this
 *     blob so vector text + lines stay crisp at any output resolution.
 *
 * Returns the new synthetic pageNos so the renderer can scroll to the
 * first inserted page if it wants. (§17.3, β31 vector path.)
 */
ipcMain.handle(
  "kpdf3:add-inserted-pdf-pages",
  async (_, { afterPageNo, externalPath }) => {
    if (!activeWorkspace) throw new Error("No active workspace");
    if (!externalPath) throw new Error("externalPath missing");
    const buf = readFileSync(externalPath);
    // Store the entire external PDF once for vector-preserving export.
    // Many pages from the same PDF share this row via SHA-256 dedup.
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const sourcePdfId = activeWorkspace.getOrCreateInsertedSourcePdf({
      sha256,
      pdfBlob: buf,
      byteSize: buf.length,
    });
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
          const ZOOM = 300 / 72; // 300 dpi viewer preview
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
            sourcePdfId,
            sourcePageIndex: i,
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

/** β31: fetch the vector-source PDF bytes for an inserted page so the
 *  exporter/print path can copyPages it instead of using image_blob. */
ipcMain.handle("kpdf3:get-inserted-source-pdf", async (_, id) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const row = activeWorkspace.getInsertedSourcePdf(id);
  if (!row) return null;
  const u8 = row.pdfBlob instanceof Uint8Array
    ? row.pdfBlob
    : new Uint8Array(row.pdfBlob);
  return { pdfBlob: u8, byteSize: row.byteSize };
});

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

/**
 * β34: viewer-side vector render for external-PDF-backed synthetic pages.
 * Opens the stored source PDF via mupdf (cached per source_pdf_id) and
 * rasterises the referenced page at the requested zoom — same RGBA
 * payload shape as the regular `kpdf3:render-page` IPC so the renderer
 * can reuse the existing draw loop. This makes the viewer pixel-sharp at
 * any zoom (the legacy image_blob path was a 300dpi raster that softened
 * past 100% zoom).
 *
 * Cache lifetime: per-workspace. Documents are destroyed when the workspace
 * closes — see `_destroyInsertedSourceCache` invocations below.
 */
const _insertedSourcePdfDocCache = new Map(); // sourcePdfId → mupdf.Document
function _destroyInsertedSourceCache() {
  for (const doc of _insertedSourcePdfDocCache.values()) {
    try { doc.destroy?.(); } catch { /* ignore */ }
  }
  _insertedSourcePdfDocCache.clear();
}

function _getInsertedSourcePdfDoc(sourcePdfId) {
  if (_insertedSourcePdfDocCache.has(sourcePdfId)) {
    return _insertedSourcePdfDocCache.get(sourcePdfId);
  }
  if (!activeWorkspace) throw new Error("No active workspace");
  const row = activeWorkspace.getInsertedSourcePdf(sourcePdfId);
  if (!row || !row.pdfBlob) {
    throw new Error(`inserted_source_pdfs id=${sourcePdfId} not found`);
  }
  const buf = row.pdfBlob instanceof Uint8Array
    ? row.pdfBlob
    : new Uint8Array(row.pdfBlob);
  const doc = mupdf.Document.openDocument(buf, "application/pdf");
  _insertedSourcePdfDocCache.set(sourcePdfId, doc);
  return doc;
}

ipcMain.handle("kpdf3:render-inserted-source-page", async (_, payload) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const { syntheticId, zoom } = payload ?? {};
  if (!Number.isFinite(syntheticId) || syntheticId <= 0) {
    throw new Error(`render-inserted-source-page: invalid syntheticId ${syntheticId}`);
  }
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new Error(`render-inserted-source-page: invalid zoom ${zoom}`);
  }
  // Locate the inserted_pages row. listInsertedPages is cheap (no blobs)
  // and avoids adding a new sqlite-store helper for a single field lookup.
  const rows = activeWorkspace.listInsertedPages();
  const row = rows.find((r) => r.id === syntheticId);
  if (!row) throw new Error(`Inserted page id=${syntheticId} not found`);
  if (row.sourcePdfId == null || row.sourcePageIndex == null) {
    throw new Error(`Inserted page id=${syntheticId} has no vector source`);
  }
  const doc = _getInsertedSourcePdfDoc(row.sourcePdfId);
  const page = doc.loadPage(row.sourcePageIndex);
  try {
    const matrix = mupdf.Matrix.scale(zoom, zoom);
    const pixmap = page.toPixmap(
      matrix,
      mupdf.ColorSpace.DeviceRGB,
      true,  // alpha — match the regular render-page IPC's default
      false,
    );
    try {
      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const pixels = pixmap.getPixels();
      return {
        width,
        height,
        channels: 4,
        pixels: Buffer.from(pixels),
      };
    } finally {
      pixmap.destroy?.();
    }
  } finally {
    page.destroy?.();
  }
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
