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
import { extractPageAnnotationsFromDoc } from "../backend/mupdf-annotations.js";
import { findQpdfBinary, sanitizePdfBytes } from "./qpdf-sanitize.js";
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
  applyCleanFaxDevmode,
  restoreUserPrinterDevmode,
  restoreInflightDevmodeSync,
  applyFaxAsDefaultPrinter,
  restoreDefaultPrinter,
  restoreInflightDefaultPrinterSync,
  setDevmodeCachePathResolver,
  loadDevmodeCacheFromDisk,
} from "./printer-properties-win.js";
import { findPdfReader, findAllPdfReaders } from "./pdf-reader-finder.js";
// β59: PS/PCL raw print 経路は撤去。C2360 で auto-detect エラー
// (016-726 / 106-726) を引き起こすことが判明し、raw datatype で
// ドライバを完全バイパスする経路は本機種では使えないと結論。
// Sumatra 経由 (β53 J8) に戻し、明朝細字問題はドライバ側「線幅補正」
// 等の設定で救済する運用 (γ アプローチ)。

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
// β75 diag: renderer から fire-and-forget でログを残せるチャンネル。
// D&D 経路の追跡 (drop event 発火 / path 解決 / openPdfSmart 結果) に使う。
ipcMain.on("kpdf3:log-diag", (_event, label, data) => {
  try { logCrash(String(label ?? "diag"), data); } catch { /* swallow */ }
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

// ---- Multi-window registry (B3-α) -------------------------------------
//
// Each BrowserWindow owns 0..N tabs. `tabHandles` is a flat Map keyed
// by tabId (workspace + doc + pages live there); `windowState` adds
// the per-window concept of "which tabs does this window own" + "which
// tab is active in this window".
//
// The legacy `activeWorkspace` / `activeDoc` / `activePages` /
// `activeTabId` globals are kept in sync with the focused window's
// active tab via window.on("focus") + switch-tab IPC. Existing IPC
// handlers continue to read those globals; only the hot path
// (render-page) and new B3 handlers resolve via `activeForEvent`.
//
// Race window: an unfocused window doing background renders while
// another window is focused will read the focused window's globals.
// render-page is hardened via activeForEvent; thumb refreshes triggered
// from background are still subject to this. Acceptable for B3-α MVP;
// proper fix is per-event resolution for ALL handlers (B3-γ candidate).
/** @typedef {{ win: BrowserWindow, activeTabId: string | null, ownedTabIds: Set<string> }} WindowState */
/** @type {Map<number, WindowState>} */
const windowState = new Map();

function registerWindow(win) {
  windowState.set(win.id, {
    win,
    activeTabId: null,
    ownedTabIds: new Set(),
    // B3-γ dock-back: window-relative bbox of the tab-bar element so
    // main can resolve a screen point to "is this over some window's
    // tab-bar?". null until the renderer reports it.
    tabBarOffset: null,
    // B3-γ "last-tab-dragged-out closes child window": child windows
    // (spawned via detach / open-in-new-window) auto-close when
    // their last owned tab is moved away. Primary window persists
    // even when empty. Set by configureWindowChrome.
    isPrimary: false,
  });
}

function unregisterWindow(winId) {
  const ws = windowState.get(winId);
  if (!ws) return;
  // Dispose tabs owned by this window — their workspaces close, doc
  // handles destroyed.
  for (const tabId of ws.ownedTabIds) disposeTab(tabId);
  windowState.delete(winId);
}

function windowStateForEvent(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  return windowState.get(win.id) ?? null;
}

/** Resolve the active tab handle for an IPC event. Returns the
 *  workspace / doc / pages / sourcePdfPath of the calling window's
 *  active tab. Used by hot-path IPCs (render-page, etc.) so a render
 *  request from window A always reads window A's tab — even if the
 *  global active-* refs currently point at window B's. */
function activeForEvent(event) {
  const ws = windowStateForEvent(event);
  if (!ws?.activeTabId) {
    return { workspace: null, doc: null, pages: [], sourcePdfPath: null, tabId: null };
  }
  const h = tabHandles.get(ws.activeTabId);
  if (!h) {
    return { workspace: null, doc: null, pages: [], sourcePdfPath: null, tabId: null };
  }
  return {
    workspace: h.workspace,
    doc: h.doc,
    pages: h.pages,
    sourcePdfPath: h.sourcePdfPath,
    tabId: ws.activeTabId,
  };
}

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

// Process-level shortcut handlers (globalShortcut is process-wide so
// these are window-agnostic — they always target the currently
// focused BrowserWindow).
const reloadFocused = () => {
  const target = BrowserWindow.getFocusedWindow();
  if (target) target.webContents.send("kpdf3:reload-request");
};
const devtoolsFocused = () => {
  const target = BrowserWindow.getFocusedWindow();
  if (!target) return;
  const wc = target.webContents;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: "detach" });
};
const registerShortcuts = () => {
  try {
    globalShortcut.register("F5", reloadFocused);
    globalShortcut.register("CommandOrControl+R", reloadFocused);
    globalShortcut.register("CommandOrControl+Shift+R", reloadFocused);
    globalShortcut.register("F12", devtoolsFocused);
    globalShortcut.register("CommandOrControl+Shift+I", devtoolsFocused);
  } catch (e) {
    console.warn("[shortcuts] register failed:", e);
  }
};
const unregisterShortcuts = () => {
  // β74: 2nd instance が singleton lock を取れず app.quit() 経由で
  // will-quit に入った時、whenReady 未到達のため globalShortcut が
  // "cannot be used before the app is ready" で throw する。crash.log
  // に "PDF 開閉繰り返しでクラッシュ" として記録され続けていた症状の根治。
  if (!app.isReady()) return;
  globalShortcut.unregisterAll();
};
app.on("will-quit", unregisterShortcuts);

/** Refresh the legacy active-* globals to point at the focused window's
 *  active tab. Existing IPC handlers read these globals; this keeps
 *  their workspace selection in sync as the user moves between windows.
 *  No-op if the focused window has no active tab (e.g. blank window). */
function refreshGlobalsToFocusedWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused) return;
  const ws = windowState.get(focused.id);
  if (!ws?.activeTabId) return;
  if (ws.activeTabId !== activeTabId) {
    activateTab(ws.activeTabId);
  }
}

/** Common chrome wiring for both the main window and detach child
 *  windows: register in windowState, hide menu bar, broadcast maximize
 *  state, install focus → globals + shortcut sync, install close
 *  print-in-flight guard, dispose owned tabs on closed.
 *
 *  isPrimary marks the window as the legacy `mainWindow`; only the
 *  primary persists window bounds and clears the legacy `mainWindow`
 *  ref on close. */
function configureWindowChrome(win, { isPrimary }) {
  registerWindow(win);
  const ws = windowState.get(win.id);
  if (ws) ws.isPrimary = !!isPrimary;
  // Hide menu bar (Linux / Windows) while keeping the accelerators
  // registered via setApplicationMenu — frame:false plus visible menu
  // would double the title-bar height with the OS menu strip.
  win.setMenuBarVisibility(false);
  win.autoHideMenuBar = true;
  // Notify the renderer when maximize state changes so the
  // maximize/restore button glyph stays in sync.
  const broadcastMax = () => {
    if (!win.isDestroyed()) {
      win.webContents.send("kpdf3:window-state", { maximized: win.isMaximized() });
    }
  };
  win.on("maximize", broadcastMax);
  win.on("unmaximize", broadcastMax);
  // frame:false + Menu.setApplicationMenu(null) means no default
  // accelerators. Use globalShortcut while a window is focused —
  // before-input-event was unreliable on Wayland in testing.
  win.on("focus", () => {
    refreshGlobalsToFocusedWindow();
    registerShortcuts();
  });
  win.on("blur", unregisterShortcuts);
  // β50 J6: when a print job is still in flight, block the close and
  // ask the user whether to wait for it or cancel the spool. Adobe-
  // style: clicking 「キャンセルして終了」kills Sumatra / tears down
  // the FAX OS dialog before quitting. Default = wait so an accidental
  // X click doesn't murder a long-running print.
  win.on("close", (event) => {
    if (isPrintInFlight()) {
      const choice = dialog.showMessageBoxSync(win, {
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
        event.preventDefault();
        return;
      }
      cancelInFlightPrint();
    }
    if (isPrimary) saveWindowState(win);
  });
  win.on("closed", () => {
    // Dispose tabs this window owned (closes their workspaces).
    unregisterWindow(win.id);
    if (isPrimary) {
      disposeActiveDoc();
      if (activeWorkspace) {
        try { activeWorkspace.close(); } catch { /* ignore */ }
        activeWorkspace = null;
      }
      activeSourcePdfPath = null;
      mainWindow = null;
    }
  });
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
  configureWindowChrome(mainWindow, { isPrimary: true });
  // The main window is created after app.whenReady, so it's the
  // focused one — wire shortcuts immediately rather than waiting for
  // the focus event.
  registerShortcuts();
}

/** Spawn a sibling BrowserWindow with the same chrome as the main
 *  window. Caller is responsible for any post-load IPC (bootstrap
 *  message, OS-open path, etc.). Used as the building block for both
 *  tab tearout (spawnDetachedTabWindow) and "open new PDF in new
 *  window" (kpdf3:open-in-new-window).
 *
 *  Position rules:
 *  - atScreen=null (default) → offset 40px from focused window
 *  - atScreen={x,y}          → place the title-bar near (x,y) so the
 *                              new window appears under the user's
 *                              cursor (B3-β drag-tearout drop point) */
function spawnEmptyChildWindow({ atScreen = null } = {}) {
  const focused = BrowserWindow.getFocusedWindow() ?? mainWindow;
  const srcBounds = focused?.getBounds?.() ?? { x: 100, y: 100, width: 1100, height: 820 };
  let x, y;
  if (atScreen
      && Number.isFinite(atScreen.x)
      && Number.isFinite(atScreen.y)) {
    // Anchor the new window's title-bar area near the cursor.
    // Slight upward offset (-30) so the title bar lands under the
    // pointer; horizontal centre-ish (-100) so the user's release
    // point is roughly in the tab-bar zone of the new window.
    x = Math.round(atScreen.x - 100);
    y = Math.round(atScreen.y - 30);
  } else {
    x = srcBounds.x + 40;
    y = srcBounds.y + 40;
  }
  const child = new BrowserWindow({
    width: srcBounds.width,
    height: srcBounds.height,
    x,
    y,
    title: "K-PDF3",
    icon: join(__dirname, "..", "renderer", "vendor", "app-icon.png"),
    frame: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  child.loadFile(join(__dirname, "..", "renderer", "index.html"));
  configureWindowChrome(child, { isPrimary: false });
  return child;
}

/** Spawn a sibling BrowserWindow that boots into a single tab handed
 *  off from another window (B3-α tab tearout). The detach payload is
 *  sent to the renderer once it has loaded; the renderer treats it as
 *  the boot tab instead of creating a fresh blank one. */
function spawnDetachedTabWindow(detachPayload) {
  const child = spawnEmptyChildWindow({ atScreen: detachPayload?.atScreen });
  child.webContents.once("did-finish-load", () => {
    if (!child.isDestroyed()) {
      child.webContents.send("kpdf3:bootstrap-detached-tab", detachPayload);
    }
  });
  return child;
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
const _diagInitArgvPdfs = pdfPathsFromArgv(process.argv);
if (!gotInstanceLock
    && process.platform === "win32"
    && _diagInitArgvPdfs.length === 0) {
  // β48 J5b: β47 used Atomics.wait + SharedArrayBuffer for a precise
  // synchronous sleep but Electron's main process disables shared
  // memory by default → the call threw, the unhandled error escaped
  // the script and the new instance crashed silently on launch. The
  // user saw the same "click does nothing" symptom and had to manually
  // kill via Task Manager. Replace with a plain busy-wait inside a
  // try/catch so any koffi/taskkill failure can't take down startup.
  // β75 diag: zombie-kill が生きた 1st instance を誤殺している疑い
  // を晴らす / 確定させるため、attempt と result をログに残す。
  const _j5Start = Date.now();
  logCrash("j5-zombie-kill-attempt", { pid: process.pid });
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
  logCrash("j5-zombie-kill-result", {
    pid: process.pid,
    gotLockAfter: gotInstanceLock,
    elapsedMs: Date.now() - _j5Start,
  });
}
if (!gotInstanceLock) {
  // β75 diag: 2nd instance が silent quit する瞬間を残す。hadPdfArg=true
  // なら 1st instance の second-instance event で開かれるはず、false
  // なら β47 J5 が動かなかった経路 (zombie-kill 失敗 / non-win32)。
  logCrash("second-instance-quit", {
    pid: process.pid,
    hadPdfArg: _diagInitArgvPdfs.length > 0,
    argvPdfs: _diagInitArgvPdfs,
  });
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const paths = pdfPathsFromArgv(argv);
    const mwAlive = !!(mainWindow && !mainWindow.isDestroyed());
    // β75 diag: 2nd instance が PDF arg を持って来た時の routing を残す。
    // mainWindow 死亡 + B3 子ウインドウ alive のケースで paths が宙に
    // 浮く疑いを確証 / 否認するための情報。
    let allWindowsCount = 0;
    try { allWindowsCount = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length; } catch { /* noop */ }
    logCrash("second-instance-received", {
      paths,
      mainWindowAlive: mwAlive,
      mainWindowMinimized: mwAlive ? mainWindow.isMinimized() : null,
      totalWindows: allWindowsCount,
    });
    if (mwAlive) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      for (const p of paths) {
        mainWindow.webContents.send("kpdf3:open-pdf-by-os", p);
      }
    } else {
      pendingOpens.push(...paths);
      logCrash("second-instance-deferred", { paths, reason: "no-main-window" });
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
  // β60 F2: DEVMODE 永続キャッシュのパスを resolver で渡し、保存済の
  // ユーザ設定を _userDevmodeCache に rehydrate。これにより以降の
  // プロパティ起動が「前回設定」を起点に開く + 印刷経路にも継承される。
  setDevmodeCachePathResolver(() =>
    join(app.getPath("userData"), "printer-devmode-cache.json"),
  );
  loadDevmodeCacheFromDisk();
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
  // β54: 同じ理由で、FAX 印刷経路で一時差し替えた Windows 規定
  // プリンタも sync 復元する。これを忘れると次回起動時の OS 既定
  // プリンタが FAX のままになり、別アプリの印刷でも FAX が選ばれて
  // しまうので safety-critical。
  try { restoreInflightDefaultPrinterSync(); } catch { /* ignore */ }
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
ipcMain.handle("kpdf3:open-pdf-file", async (event, pdfPath, tabId = null) => {
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
  // Mark this tab as owned by the calling window so window-close
  // disposes it (B3-α multi-window).
  const winSt = windowStateForEvent(event);
  if (winSt) {
    winSt.ownedTabIds.add(targetTabId);
    winSt.activeTabId = targetTabId;
  }

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

ipcMain.handle("kpdf3:switch-tab", async (event, tabId) => {
  // tabId === null/undefined → clear active (renderer just navigated
  // to an empty tab that has no main-side handle yet).
  const winSt = windowStateForEvent(event);
  if (tabId == null) {
    if (winSt) winSt.activeTabId = null;
    activateTab(null);
    return { ok: true, activeTabId: null };
  }
  if (!tabHandles.has(tabId)) throw new Error(`Unknown tab: ${tabId}`);
  if (winSt) winSt.activeTabId = tabId;
  activateTab(tabId);
  return { ok: true, activeTabId };
});

ipcMain.handle("kpdf3:close-tab", async (event, tabId) => {
  const winSt = windowStateForEvent(event);
  if (winSt) {
    winSt.ownedTabIds.delete(tabId);
    if (winSt.activeTabId === tabId) winSt.activeTabId = null;
  }
  disposeTab(tabId);
  return { ok: true, remaining: tabHandles.size, activeTabId };
});

/** B3-α: open a PDF in a freshly spawned child BrowserWindow, leaving
 *  the calling window untouched. The new window boots with an empty
 *  boot tab; once its renderer is ready, main pushes the PDF path via
 *  the existing kpdf3:open-pdf-by-os channel so the renderer's
 *  openPdfSmart routes it into the boot tab (isOpen=false → openPdfPath).
 *
 *  Used by: ファイル → 別ウインドウで開く... menu item. (For "move
 *  EXISTING tab to a new window" use kpdf3:detach-tab instead.) */
ipcMain.handle("kpdf3:open-in-new-window", async (_event, pdfPath) => {
  if (!pdfPath || typeof pdfPath !== "string") {
    throw new Error("open-in-new-window: pdfPath missing");
  }
  const child = spawnEmptyChildWindow();
  // pendingOpens-style: queue the path until the child renderer signals
  // ready, then deliver via the OS-open channel which is already wired
  // to openPdfSmart on the renderer side.
  child.webContents.once("did-finish-load", () => {
    if (!child.isDestroyed()) {
      child.webContents.send("kpdf3:open-pdf-by-os", pdfPath);
    }
  });
  return { ok: true };
});

/** B3-γ active drag tracking. Set when a renderer fires the
 *  source-side dragstart for a tab. Consumed by either:
 *   - tab-bar-drop IPC from a sibling window's bar → dock there
 *   - detach-tab IPC from the source's dragend → tearout (when
 *     dragend fires; in Electron cross-window dragend is unreliable
 *     so the bar-drop path is the primary signal for dock).
 *
 *  Cleared on consumption. Stored payload is the full TabState
 *  snapshot built renderer-side at dragstart time. */
let activeTabDrag = null;

ipcMain.handle("kpdf3:tab-drag-start", async (event, payload) => {
  const ws = windowStateForEvent(event);
  activeTabDrag = { payload, sourceWinId: ws?.win?.id ?? null };
  return { ok: true };
});

ipcMain.handle("kpdf3:tab-drag-end", async () => {
  // dragend signal from source — clear the active drag if not yet
  // consumed. Cross-window dragend is unreliable in Electron, so
  // this is best-effort.
  activeTabDrag = null;
  return { ok: true };
});

/** Target window's tab-bar received a drop. If there's an active
 *  cross-window tab drag and we're not the source, dock the tab
 *  into us. Source receives a tab-was-docked-away push so it can
 *  remove the tab from its local renderer-side Map. */
ipcMain.handle("kpdf3:tab-bar-drop", async (event) => {
  if (!activeTabDrag) return { ok: false, reason: "no-active-drag" };
  const tgtSt = windowStateForEvent(event);
  if (!tgtSt) return { ok: false, reason: "no-target-window" };
  const tgtId = tgtSt.win.id;
  if (tgtId === activeTabDrag.sourceWinId) {
    // Same-window drop on the bar — let intra-bar reorder logic handle
    // it (no-op here).
    return { ok: false, reason: "same-window" };
  }
  const payload = activeTabDrag.payload;
  const tabId = payload?.tabId;
  if (!tabId || !tabHandles.has(tabId)) {
    activeTabDrag = null;
    return { ok: false, reason: "no-such-tab" };
  }
  // Move ownership: source → target.
  const srcSt = windowState.get(activeTabDrag.sourceWinId);
  if (srcSt) {
    srcSt.ownedTabIds.delete(tabId);
    if (srcSt.activeTabId === tabId) srcSt.activeTabId = null;
  }
  tgtSt.ownedTabIds.add(tabId);
  // Target adopts.
  tgtSt.win.webContents.send("kpdf3:adopt-docked-tab", payload);
  try { tgtSt.win.focus(); } catch { /* ignore */ }
  // Source removes from local registry.
  if (srcSt?.win && !srcSt.win.isDestroyed()) {
    srcSt.win.webContents.send("kpdf3:tab-was-docked-away", tabId);
    // Chrome-style "last tab dragged out → window dies": if the
    // source is a child window (spawned via detach / open-in-new-
    // window) and its last tab was just transferred, close it. The
    // primary window stays alive even when empty so the user always
    // has a home base. setImmediate so the renderer's docked-away
    // handler gets to run cleanup first.
    if (!srcSt.isPrimary && srcSt.ownedTabIds.size === 0) {
      setImmediate(() => {
        if (!srcSt.win.isDestroyed()) {
          try { srcSt.win.close(); } catch { /* ignore */ }
        }
      });
    }
  }
  activeTabDrag = null;
  return { ok: true, dockedTo: tgtId };
});

/** B3-γ: each renderer reports its tab-bar's bounding rect (in
 *  window-client coords) so main can resolve a drag-end screen point
 *  to "did the user drop over some sibling window's tab-bar?".
 *  rect = { left, top, right, bottom } or null to clear. Renderer
 *  re-reports on boot, on resize, and on sidebar visibility toggle. */
ipcMain.handle("kpdf3:report-tab-bar-rect", async (event, rect) => {
  const ws = windowStateForEvent(event);
  if (!ws) return { ok: false };
  if (rect && Number.isFinite(rect.left) && Number.isFinite(rect.top)
      && Number.isFinite(rect.right) && Number.isFinite(rect.bottom)) {
    ws.tabBarOffset = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
  } else {
    ws.tabBarOffset = null;
  }
  return { ok: true };
});

/** Find the BrowserWindow whose tab-bar (in screen coords) contains
 *  the given screen point. excludeWinId skips the source window so a
 *  tab dragged out can't immediately re-dock to itself. Returns null
 *  when no sibling matches → caller falls back to tearout. */
function findDockTargetWindow(screenX, screenY, excludeWinId) {
  for (const [winId, ws] of windowState) {
    if (winId === excludeWinId) continue;
    if (!ws.tabBarOffset || ws.win.isDestroyed()) continue;
    const wb = ws.win.getBounds();
    const left = wb.x + ws.tabBarOffset.left;
    const top = wb.y + ws.tabBarOffset.top;
    const right = wb.x + ws.tabBarOffset.right;
    const bottom = wb.y + ws.tabBarOffset.bottom;
    if (screenX >= left && screenX <= right && screenY >= top && screenY <= bottom) {
      return ws.win;
    }
  }
  return null;
}

/** B3-α + B3-γ: hand a tab off from the calling window to either
 *  (γ) an existing sibling window whose tab-bar contains the drop
 *  point — dock — or (α) a freshly spawned child window — tearout.
 *
 *  The tab handle in `tabHandles` stays alive throughout — only its
 *  window affiliation changes. The renderer-side dirty state
 *  (overlays, pendingDeletedPages, scroll, zoom, ...) is shipped in
 *  `payload` so the receiving window can reproduce the live tab
 *  without re-opening the PDF from disk. */
ipcMain.handle("kpdf3:detach-tab", async (event, payload) => {
  const tabId = payload?.tabId;
  if (!tabId) throw new Error("detach-tab: missing tabId");
  if (!tabHandles.has(tabId)) {
    return { ok: true, alreadyMovedAway: true };
  }
  // B3-γ race guard: if a parallel tab-bar-drop already moved this
  // tab away from the source, the dragend's detach-tab fires stale.
  // Detect by checking the source's current ownership.
  const srcSt = windowStateForEvent(event);
  const srcWinId = srcSt?.win?.id ?? null;
  if (srcSt && !srcSt.ownedTabIds.has(tabId)) {
    return { ok: true, alreadyMovedAway: true };
  }
  // Strip the tab from the source window's ownedTabIds — the
  // receiving window will claim it on adopt.
  if (srcSt) {
    srcSt.ownedTabIds.delete(tabId);
    if (srcSt.activeTabId === tabId) srcSt.activeTabId = null;
  }
  // B3-γ: dock target lookup. Only attempt when a screen point came
  // through (D&D tearout path includes atScreen; right-click /
  // toolbar 「別窓化」 paths don't, so they always tearout).
  if (payload?.atScreen
      && Number.isFinite(payload.atScreen.screenX)
      && Number.isFinite(payload.atScreen.screenY)) {
    const target = findDockTargetWindow(
      payload.atScreen.screenX,
      payload.atScreen.screenY,
      srcWinId,
    );
    if (target) {
      // Take ownership in the target window's state proactively so
      // the renderer's subsequent switch-tab IPC finds the right
      // affiliation. activeTabId stays null until renderer confirms.
      const tgtSt = windowState.get(target.id);
      if (tgtSt) tgtSt.ownedTabIds.add(tabId);
      target.webContents.send("kpdf3:adopt-docked-tab", payload);
      // Bring the target to the front so the user sees the result.
      try { target.focus(); } catch { /* ignore */ }
      return { ok: true, dockedTo: target.id };
    }
  }
  // Don't unset the active-* globals here — the source window's
  // renderer will switch to a sibling tab and call switch-tab, which
  // re-points the globals correctly. Spawning the child kicks off
  // bootstrap which also calls switch-tab once the renderer is up.
  spawnDetachedTabWindow(payload);
  return { ok: true, dockedTo: null };
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

ipcMain.handle("kpdf3:get-outline", async (event) => {
  // B3-α: per-event resolution (race-safe across windows)
  const ws = activeForEvent(event).workspace ?? activeWorkspace;
  if (!ws) return [];
  return ws.getOutline();
});

ipcMain.handle("kpdf3:list-bookmarks", async (event) => {
  const ws = activeForEvent(event).workspace ?? activeWorkspace;
  if (!ws) return [];
  return ws.listBookmarks();
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

ipcMain.handle("kpdf3:save-overlays", async (event, overlays) => {
  // B3-α: writes go to the calling window's active tab, never the global
  // (which may have shifted to another window's active tab).
  const ws = activeForEvent(event).workspace ?? activeWorkspace;
  if (!ws) throw new Error("No active workspace");
  ws.saveOverlays(overlays);
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
// β64: β63 (ζ Phase 1) は revert。C2360 ドライバが embedded CID TrueType
// の存在をトリガに全面 raster fallback する挙動を実機検証で確認した
// ため、PDF へのフォント埋め込み経路ごと撤去。代わりに β64 では
// Adobe Reader / Foxit Reader 等 OS インストール済の PDF Reader を CLI
// で呼び出す経路を第一選択にし、Sumatra は fallback として温存する
// 三段構造に切替 (C アプローチ採用)。
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
          // β62: overlayBBox があれば bbox サイズの XObject を bbox 位置に
          // 配置する。これにより複合機ドライバが「画像がページ内 →
          // ページ全面を raster fallback」する挙動を避け、bbox の外側は
          // vector の本文が保持される (C2360 で「細い線を太く」が
          // スタンプ含有ページでも効くようになる)。
          // overlayBBox が null の場合は β61 までと同じ full-page 配置に
          // フォールバック (互換性のため)。
          // canonical 座標は top-left 原点、PDF は bottom-left 原点なので
          // bbox.y を Y 軸反転で変換する: y_pdf = pageH - bbox.y - bbox.h
          const bb = p.overlayBBox;
          if (bb && Number.isFinite(bb.x) && Number.isFinite(bb.y)
              && Number.isFinite(bb.w) && Number.isFinite(bb.h)
              && bb.w > 0 && bb.h > 0) {
            copied.drawImage(overlayImg, {
              x: bb.x,
              y: p.heightPt - bb.y - bb.h,
              width: bb.w,
              height: bb.h,
            });
          } else {
            // 互換 fallback (overlayBBox 未送信 or 不正値)
            copied.drawImage(overlayImg, {
              x: 0, y: 0,
              width: p.widthPt, height: p.heightPt,
            });
          }
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
          // β62: bbox-cropped overlay (same as "overlay" strategy path)
          const bb = p.overlayBBox;
          if (bb && Number.isFinite(bb.x) && Number.isFinite(bb.y)
              && Number.isFinite(bb.w) && Number.isFinite(bb.h)
              && bb.w > 0 && bb.h > 0) {
            copied.drawImage(overlayImg, {
              x: bb.x,
              y: p.heightPt - bb.y - bb.h,
              width: bb.w,
              height: bb.h,
            });
          } else {
            copied.drawImage(overlayImg, {
              x: 0, y: 0,
              width: p.widthPt, height: p.heightPt,
            });
          }
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
    } else if (p.strategy === "overlay-only") {
      // β.80 下敷き印刷: 背景の元 PDF は一切 copy せず、用紙サイズ
      // (canonical w/h) の空白ページに overlay PNG だけを bbox 位置に
      // 配置する。プリンタトレイにセットした白紙の申請書 (不動文字
      // 入り) に物理的に重ね刷りされることが前提。overlay の無いペー
      // ジは完全に空白のまま出る (= 何も書かれない = 用紙の不動文字
      // だけが残る)。
      const page = newPdf.addPage([p.widthPt, p.heightPt]);
      if (p.imageBytes && p.imageBytes.length > 0) {
        const overlayImg = await newPdf.embedPng(p.imageBytes);
        const bb = p.overlayBBox;
        if (bb && Number.isFinite(bb.x) && Number.isFinite(bb.y)
            && Number.isFinite(bb.w) && Number.isFinite(bb.h)
            && bb.w > 0 && bb.h > 0) {
          page.drawImage(overlayImg, {
            x: bb.x,
            y: p.heightPt - bb.y - bb.h,
            width: bb.w,
            height: bb.h,
          });
        } else {
          page.drawImage(overlayImg, {
            x: 0, y: 0,
            width: p.widthPt, height: p.heightPt,
          });
        }
      }
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
      setTimeout(async () => {
        if (settled) return;
        // β54: FAX 経路で OS 印刷ダイアログを開く直前に Windows 規定
        // プリンタを FAX に一時切替。silent:false の Chromium 印刷
        // ダイアログは deviceName を無視し OS 既定プリンタを選んだ
        // 状態で開く仕様のため、ユーザに 2 回プリンタ選択を強いて
        // いたのを解消する。print callback の success/fail 両方で
        // restore するので、ダイアログをユーザがキャンセルしても
        // 規定プリンタは元に戻る。
        let faxDefaultToken = null;
        const isFax = isFaxDevice(opts.deviceName);
        if (isFax) {
          try {
            faxDefaultToken = await applyFaxAsDefaultPrinter(opts.deviceName);
          } catch (err) {
            // 規定切替に失敗しても従来の挙動 (OS 既定がプリセット)
            // で印刷自体は可能。warn だけ吐いて続行。
            console.warn(
              "[print] applyFaxAsDefaultPrinter failed:",
              err?.message ?? err,
            );
          }
        }
        try {
          // FAX: silent:true で送信すると Chromium がドライバ UI を
          // 抑止し送信先入力ダイアログ無しで失敗 → silent:false で OS
          // 印刷ダイアログを通す。FAX 以外は従来通り silent:true。
          const useSilent = !isFax;
          // β46 J3: webContents.print の duplexMode / color に駆動側
          // プロパティを反映。Chromium API は tray (bin) を持たない
          // ので opts.bin は無視される (Sumatra 経路でのみ効く)。
          const duplexMode =
            opts.duplex === "long-edge" ? "longEdge"
            : opts.duplex === "short-edge" ? "shortEdge"
            : opts.duplex === "simplex" ? "simplex"
            : undefined;
          const colorOpt = opts.color === "mono" ? false : true;
          const printOpts = {
            silent: useSilent,
            deviceName: opts.deviceName,
            copies: opts.copies ?? 1,
            printBackground: true,
            color: colorOpt,
            landscape: opts.landscape ?? false,
            ...(duplexMode ? { duplexMode } : {}),
          };
          win.webContents.print(
            printOpts,
            (success, errorType) => {
              // 規定プリンタの復元は print の結果に関係なく必要。
              // restore は fire-and-forget で良い (ベストエフォート)。
              if (faxDefaultToken) {
                restoreDefaultPrinter(faxDefaultToken).catch(() => {});
              }
              if (success) {
                settle(resolve, { success: true });
              } else {
                // β52 J7b: log full context so the next failure tells us
                // *why* Chromium rejected the job (empty errorType is the
                // common case and was previously opaque).
                logCrash("silent-print-failed", {
                  errorType: errorType ?? "(empty)",
                  opts: printOpts,
                });
                settle(reject, new Error(errorType || "silent print failed"));
              }
            },
          );
        } catch (err) {
          if (faxDefaultToken) {
            restoreDefaultPrinter(faxDefaultToken).catch(() => {});
          }
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

// β55 で導入した ensureSumatraPortableSettings (PrintAsImage = true を
// Sumatra に書かせる) は β56 検証で「Sumatra 3.6.1 のバイナリに
// PrintAsImage という文字列が存在しない = 設定キー自体が未実装」と
// 判明したため撤回。β56 からは案 M (printer-print-win.js) の自前 GDI
// 直接印刷を第一選択にしているので、Sumatra 側の品質トークンに依存
// する必要がなくなった。既存ユーザの %resources%/sumatrapdf/
// SumatraPDF-settings.txt は Sumatra が不明キーを silently ignore する
// だけで実害はないので、ファイル削除コードは入れず放置 (次回再
// インストール時に消える)。

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

/** β64: Adobe / Foxit / PDF-XChange CLI で印刷したジョブの child
 *  process tracking。kpdf3:cancel-print と β50 J6 印刷中クローズ確認の
 *  両方で参照される。 */
let _activePdfReaderProcess = null;

/**
 * β64: OS インストール済 PDF Reader (Adobe Acrobat / Reader / Foxit /
 * PDF-XChange) を CLI 経由で起動して印刷する。
 *
 * 共通 CLI 規約:
 *   <exe> /n /t "pdfPath" "deviceName"
 *
 * 各 Reader の挙動:
 * - Adobe Acrobat Reader DC / Acrobat Pro:
 *   /n = 新規プロセスとして起動 (既存 instance を流用しない)
 *   /t = サイレント印刷後 exit。printer 名 + 紙サイズ + ドライバ名は
 *        オプション (printer のみで十分)
 *   バックグラウンドで起動するが、初回起動時にタスクバーに短時間
 *   アイコンが出る場合あり
 * - Foxit / PDF-XChange も Adobe 互換の /n /t を実装している
 *
 * 設定 (duplex/tray/color/copies) は β48 J4b の SetPrinter level 9 で
 * per-user 既定 DEVMODE に押し込んでおけば各 Reader が読み込む。CLI
 * 引数で直接渡す方式は Reader によって差があるので未使用。
 *
 * 戻り値: { success: true } または process が non-zero で reject。
 */
/** β66: tasklist で指定 exe 名のプロセス PID 一覧を取得する。
 *  PDF Reader の残留プロセス検出 + kill に使用。Win 限定。 */
function getProcessPidsByName(exeName) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve([]);
      return;
    }
    try {
      const sp = spawn(
        "tasklist",
        ["/FI", `IMAGENAME eq ${exeName}`, "/FO", "CSV", "/NH"],
        { windowsHide: true },
      );
      let out = "";
      sp.stdout?.on("data", (d) => { out += d.toString(); });
      sp.on("error", () => resolve([]));
      sp.on("close", () => {
        const pids = [];
        for (const line of out.split(/\r?\n/)) {
          // CSV: "Image","PID","Session","Session#","MemUsage"
          const m = line.match(/^"[^"]*","(\d+)",/);
          if (m) {
            const pid = parseInt(m[1], 10);
            if (Number.isFinite(pid)) pids.push(pid);
          }
        }
        resolve(pids);
      });
    } catch {
      resolve([]);
    }
  });
}

/** β67: PDF Reader engine ごとに生成しうるヘルパープロセスの exe 名
 *  リスト。Adobe Acrobat Pro / Reader DC は主プロセスの他に Chromium
 *  ベースの UI (AcroCEF.exe) や IPC ブローカ (AcroBroker.exe) を派生
 *  させ、主プロセス exit 後もタスクバーアイコンが残る挙動を取る。
 *  これらを kill ターゲットに加えて完全に閉じる。
 *  AdobeARM.exe (自動更新) / AdobeCollabSync.exe (クラウド同期) は
 *  ユーザ業務のバックグラウンドに必要なので kill しない。 */
const PDF_READER_HELPER_EXES = {
  "Acrobat.exe":      ["AcroCEF.exe", "AcroBroker.exe", "AcroFlattener.exe"],
  "AcroRd32.exe":     ["AcroCEF.exe", "AcroBroker.exe"],
  "FoxitReader.exe":  [],
  "FoxitPDFReader.exe": [],
  "PDFXEdit.exe":     [],
  "PDFXCview.exe":    [],
};

/** β66/β67: 印刷起因で生まれた PDF Reader プロセス + ヘルパープロセス
 *  群を kill する。before 時点で存在していた PID は exe 名ごとに保護
 *  (ユーザが別途開いている Adobe ウィンドウを誤って閉じない)。
 *  失敗時は no-op (kill 失敗してもユーザの業務は継続可能なので
 *  最善 effort)。
 *  @param {{exePath:string, engine:string, displayName:string}} readerInfo
 *  @param {Record<string, number[]>} beforePidsByExe  exe 名ごとの PID 一覧
 */
async function killNewPdfReaderProcesses(readerInfo, beforePidsByExe) {
  const killedCounts = {};
  for (const [exeName, beforePids] of Object.entries(beforePidsByExe)) {
    try {
      const afterPids = await getProcessPidsByName(exeName);
      const newPids = afterPids.filter((pid) => !beforePids.includes(pid));
      killedCounts[exeName] = newPids.length;
      for (const pid of newPids) {
        try {
          spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
            windowsHide: true,
            detached: false,
          });
        } catch {
          // ignore — best-effort cleanup
        }
      }
    } catch {
      killedCounts[exeName] = -1; // 取得失敗
    }
  }
  try {
    logCrash("pdfreader-cleanup", {
      engine: readerInfo.engine,
      killed: killedCounts,
    });
  } catch { /* ignore */ }
}

/**
 * β72: 印刷キューのジョブ ID 一覧を PowerShell 経由で snapshot する。
 * Get-CimInstance Win32_PrintJob で全プリンタ・全 FAX のジョブを列挙し
 * JobId だけ抜き出す。ジョブが無いとき / 取得失敗時は空配列。
 *
 * 用途: printPdfViaReaderDialog が起動前と polling tick で snapshot を
 * 取り、差分 (= ユーザが Adobe ダイアログで「印刷」を押したことで投入
 * された新規ジョブ) を検出する。
 */
function snapshotPrintJobs() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") { resolve([]); return; }
    try {
      const ps =
        "Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue"
        + " | Select-Object -ExpandProperty JobId";
      const sp = spawn(
        "powershell.exe",
        ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
        { windowsHide: true },
      );
      let out = "";
      sp.stdout?.on("data", (d) => { out += d.toString(); });
      sp.on("error", () => resolve([]));
      sp.on("close", () => {
        const ids = out
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number)
          .filter(Number.isFinite);
        resolve(ids);
      });
    } catch {
      resolve([]);
    }
  });
}

/**
 * β72 (案 D + 案 X): PDF Reader を `/p` フラグで起動して印刷ダイアログを
 * 出させる。ユーザがプリンタ・部数・FAX 送信先を Adobe ダイアログで設定
 * してから「印刷」ボタンを押す → 印刷キュー監視で新規ジョブ投入を検知
 * → 3 秒バッファ後に Reader を kill する (Pro DC は `/p` 経路でも自然
 * exit しないため、kill が主要 exit メカニズム)。
 *
 * 5 分の安全網タイムアウト (ユーザがダイアログ放置 / キャンセル / × 閉じ
 * の場合)。Reader 自身が exit した時 (× 閉じ等) は即 finish。
 *
 * `/p` 仕様 (Adobe / Foxit / PDF-XChange 共通):
 *   <exe> /n /s /o /p <pdf>
 *     /n = 新インスタンス
 *     /s = スプラッシュ抑止
 *     /o = open リマインダー抑止
 *     /p = 印刷ダイアログ付きで開く
 *
 * `/h` (hidden) や `/t` (silent print) は使わない: 印刷ダイアログを
 * ユーザに見せるのが目的。FAX 送信先入力ダイアログも Reader ネイティブ
 * 経路で正しく出る (β54-β70 で苦労した FAX freeze 問題が根治)。
 */
async function printPdfViaReaderDialog(readerInfo, pdfPath) {
  const exeName = basename(readerInfo.exePath);
  const helpers = PDF_READER_HELPER_EXES[exeName] ?? [];
  const allExes = [exeName, ...helpers];
  // β73: PID snapshot (4 回 tasklist) と印刷キュー snapshot (1 回 PowerShell)
  // は元々完全に独立な操作なので Promise.all で並列化。逐次だと
  // ~1.3-2.3 秒、並列なら ~max(800ms, 1500ms) ≈ 1.5 秒。Adobe spawn 前の
  // 体感待ちが約 1 秒短くなる (Adobe 自体の startup 3-5 秒は外部依存で
  // 削れない)。
  const [pidsArr, beforeJobIds] = await Promise.all([
    Promise.all(allExes.map((name) => getProcessPidsByName(name))),
    snapshotPrintJobs(),
  ]);
  /** @type {Record<string, number[]>} */
  const beforePidsByExe = {};
  for (let i = 0; i < allExes.length; i++) {
    beforePidsByExe[allExes[i]] = pidsArr[i];
  }

  return new Promise((resolve, reject) => {
    const args = ["/n", "/s", "/o", "/p", pdfPath];
    let sp;
    try {
      sp = spawn(readerInfo.exePath, args, {
        windowsHide: true,
        detached: false,
      });
    } catch (err) {
      reject(new Error(
        `Spawn ${readerInfo.displayName} failed: ${err?.message ?? err}`,
      ));
      return;
    }
    _activePdfReaderProcess = sp;

    let settled = false;
    const POLL_MS = 1000;
    const POST_JOB_BUFFER_MS = 3000;
    const SAFETY_TIMEOUT_MS = 5 * 60 * 1000;
    const startMs = Date.now();

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      _activePdfReaderProcess = null;
      try {
        logCrash("pdfreader-dialog-finish", {
          engine: readerInfo.engine,
          reason,
          elapsedMs: Date.now() - startMs,
        });
      } catch { /* ignore */ }
      killNewPdfReaderProcesses(readerInfo, beforePidsByExe).catch(() => {});
      resolve({ success: true, reason });
    };

    sp.on("error", (err) => {
      if (settled) return;
      settled = true;
      _activePdfReaderProcess = null;
      reject(err);
    });
    sp.on("close", () => {
      // Reader 自身が exit (主に Reader DC の自然 exit / ユーザ × 閉じ)
      // → 印刷せずに終了したと判断、即 finish (helpers cleanup のみ)
      if (settled) return;
      finish("reader-closed");
    });

    const tick = async () => {
      if (settled) return;
      const elapsed = Date.now() - startMs;
      if (elapsed > SAFETY_TIMEOUT_MS) {
        finish("timeout");
        return;
      }
      try {
        const currentJobs = await snapshotPrintJobs();
        const newJobs = currentJobs.filter((id) => !beforeJobIds.includes(id));
        if (newJobs.length > 0) {
          // 新規ジョブ検出 = ユーザが Adobe ダイアログで「印刷」を押した
          // → 3 秒バッファ後に Reader を kill (spool 投入完了待ち)
          setTimeout(() => finish("job-detected"), POST_JOB_BUFFER_MS);
          return;
        }
      } catch { /* ignore — keep polling */ }
      setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);
  });
}

/**
 * Heuristic: does the device name look like a FAX device?
 * Most FAX drivers pop a「送信先番号」prompt during the print spool
 * call, and -silent suppresses driver UI → driver fails with exit 1
 * (β41 user report on a複合機 FAX 経路).
 *
 * β52 J3b: the initial /fax/i substring match was too loose — printers
 * with a name like "ApeosPort C2360 FAX対応" or "Brother MFC-XXX (Faxable)"
 * tripped the substring even though they're regular print queues, which
 * incorrectly routed them to Chromium silent:false instead of Sumatra
 * and silent printing then failed (user β51 report). Tighten to a word-
 * boundary match: "fax" must sit at the edge of a token (start/end or
 * adjacent to whitespace / punctuation common in device names like
 * " ", "-", "_", "(", ")", "/", "\"). The katakana variants stay
 * substring because Japanese device names rarely surround them with
 * spaces.
 */
function isFaxDevice(name) {
  if (!name) return false;
  if (/(?:^|[\s_\-()/\\:])fax(?:$|[\s_\-()/\\:])/i.test(name)) return true;
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
 *   - Revision id / exports BLOB history — M4-2.
 *
 * Secure export (β.84+): when payload.secureExport is true the assembled
 * PDF is passed through qpdf with --remove-info --remove-metadata (xref is
 * also rebuilt as a side effect). If the qpdf binary isn't available the
 * non-sanitised bytes are written and the response carries qpdfMissing:true
 * so the renderer can warn the user; sanitize-time errors surface as
 * thrown rejections so the user knows the file is NOT secure.
 */
ipcMain.handle("kpdf3:export-pdf-rasterized", async (_, payload) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const { savePath, pages, secureExport = false } = payload;
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
  let secureExportApplied = false;
  let qpdfMissing = false;
  if (secureExport) {
    const qpdfPath = findQpdfBinary();
    if (!qpdfPath) {
      qpdfMissing = true;
      console.warn("[export] secureExport requested but qpdf not found — writing raw");
    } else {
      pdfBytes = await sanitizePdfBytes(pdfBytes, { qpdfPath });
      secureExportApplied = true;
    }
  }
  writeFileSync(savePath, pdfBytes);
  const rev = activeWorkspace.recordExport(pdfBytes, {
    note: payload.note ?? null,
    isSecure: secureExportApplied,
  });
  return {
    savedAt: rev.timestamp,
    savePath,
    pageCount: pages.length,
    revisionId: rev.revisionId,
    outputHash: rev.outputHash,
    outputSize: rev.outputSize,
    secureExportApplied,
    qpdfMissing,
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
 * β70: 印刷エンジン候補を列挙して renderer へ返す。検出された PDF
 * Reader (Adobe Acrobat Reader DC / Acrobat Pro / Foxit / PDF-XChange)
 * + 内蔵 Sumatra + Chromium silent。ユーザが印刷ダイアログで選択可能に。
 *
 * 並び順 = priority 順 (Reader DC > Pro > Foxit > PDF-XChange > Sumatra >
 * Chromium)。recommended = priority 順で最初の項目に true。
 *
 * @returns {Array<{id: string, displayName: string, recommended: boolean}>}
 */
ipcMain.handle("kpdf3:list-print-engines", async () => {
  const out = [];
  // PDF Reader 系 (検出済のみ)
  const readers = findAllPdfReaders();
  for (const r of readers) {
    out.push({
      id: r.engine,
      displayName: r.displayName,
    });
  }
  // Sumatra (内蔵、常に利用可能)
  if (sumatraPath()) {
    out.push({ id: "sumatra", displayName: "SumatraPDF (内蔵)" });
  }
  // Chromium silent (Electron 標準、常に利用可能)
  out.push({ id: "chromium", displayName: "Chromium silent print" });

  // 先頭を recommended として返す
  return out.map((e, i) => ({ ...e, recommended: i === 0 }));
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
  // β64: Adobe / Foxit / PDF-XChange CLI 経由の印刷 child process も kill。
  // PDF Reader は spool 投入後すぐ exit するので通常はここで掴むことは
  // 少ないが、起動が遅い大型 Reader (Acrobat Pro 等) の対応として。
  if (_activePdfReaderProcess) {
    try { _activePdfReaderProcess.kill(); } catch { /* ignore */ }
    _activePdfReaderProcess = null;
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
  // β54: webContents.print() の callback は印刷ウインドウを destroy
  // した時に発火しないことがある → FAX 経路で仕掛けた規定プリンタ
  // 一時切替の restore が落ちる。ここでも sync 復元しておく。
  try { restoreInflightDefaultPrinterSync(); } catch { /* ignore */ }
}

/**
 * β72: ある PDF Reader (Adobe / Foxit / PDF-XChange) が OS にインストール
 * されているかを検出して boolean で返す。renderer 側はこれで「印刷ボタン
 * → Adobe ダイアログ直行 (案 D)」と「印刷ボタン → 自前ダイアログ + Sumatra
 * /Chromium silent (Reader 不在 fallback)」のどちらに分岐するかを決める。
 */
ipcMain.handle("kpdf3:has-pdf-reader", async () => {
  return findPdfReader() !== null;
});

/**
 * β72 (案 D): K-PDF3 の印刷ボタンから直接 Adobe / Foxit / PDF-XChange の
 * 印刷ダイアログを開く経路。renderer 側はサイドバー / split-view 選択を
 * 読んで filteredPages を作り、ここに渡す。プリンタ・部数・FAX 送信先・
 * 各種 driver プロパティはすべて Reader ダイアログでユーザが設定する。
 *
 * payload:
 *   { source: 'byte-copy' | 'rasterized', pages?: composedPages[] }
 *
 * 中止: Adobe ダイアログを × で閉じれば中止 (K-PDF3 側の中止 IPC は廃止)。
 */
ipcMain.handle("kpdf3:print-via-reader-dialog", async (_, payload) => {
  if (!activeWorkspace) throw new Error("No active workspace");
  const { source, pages } = payload ?? {};
  let pdfBytes;
  if (source === "byte-copy") {
    pdfBytes = activeWorkspace.getSourceBytes();
    if (!pdfBytes) throw new Error("No source PDF in workspace");
  } else if (source === "rasterized" && Array.isArray(pages) && pages.length > 0) {
    const sourceBytes = activeWorkspace.getSourceBytes() ?? null;
    pdfBytes = await assembleHybridPdf(pages, sourceBytes);
  } else {
    throw new Error("print-via-reader-dialog: invalid source / pages");
  }
  const tempPath = tempPrintPath();
  writeFileSync(tempPath, pdfBytes);

  const reader = findPdfReader();
  if (!reader) throw new Error("No PDF Reader detected");

  logCrash("print-via-reader-dialog-start", {
    source,
    pageCount: Array.isArray(pages) ? pages.length : 0,
    engine: reader.engine,
    exe: reader.exePath,
  });
  _printInFlight = true;
  try {
    const result = await printPdfViaReaderDialog(reader, tempPath);
    return { tempPath, engine: reader.engine, reason: result.reason };
  } finally {
    _printInFlight = false;
  }
});

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
    // β70: ユーザが印刷ダイアログで選択した印刷エンジンの id 上書き。
    // null/undefined なら main の自動検出 (PDF Reader > Sumatra > Chromium)。
    engineOverride = null,
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
  // β72: PDF Reader (Adobe / Foxit / PDF-XChange) 検出時の経路は
  // kpdf3:print-via-reader-dialog に分離した (案 D)。本ハンドラは Reader
  // 不在環境向けの fallback path 専用となり、Sumatra (Win + 非 FAX) →
  // Chromium silent / silent:false (FAX or 非 Win or Sumatra 不在) の二段
  // のみで構成される。
  //
  // β42 J2: FAX devices CANNOT go through Sumatra — mupdf + WinSpool
  // fails to initialize the FAX driver ("プリンタを初期化できませんで
  // した" / exit 1). FAX は silentPrintPdf へ直行し、silent:false で
  // OS 印刷ダイアログ (送信先入力含む) を出す。
  const isFax = isFaxDevice(deviceName);
  const sumatraExe = sumatraPath();
  let forceSumatra = false;
  let forceChromium = false;
  if (engineOverride === "sumatra") forceSumatra = true;
  else if (engineOverride === "chromium") forceChromium = true;
  const canSumatra =
    process.platform === "win32"
    && !isFax
    && sumatraExe !== null;
  logCrash("print-route", {
    deviceName,
    source,
    pageCount: Array.isArray(pages) ? pages.length : 0,
    isFax,
    sumatraExe: sumatraExe ?? "(missing)",
    canSumatra,
    forceSumatra,
    forceChromium,
    copies,
    landscape,
    duplex,
    bin,
    color,
  });
  // β48 J4b: push the user-modified DEVMODE as per-user default for the
  // Sumatra / Chromium fallback paths.
  // β61: FAX のときは applyCleanFaxDevmode を呼んで dmDriverExtra (driver-
  // private bytes) を 0 埋めしてから push。FUJIFILM Apeos C2360 等が
  // driver-private に「最後の宛先」を残す挙動への対策で、毎送信前に
  // 宛先欄を空でリセットする。
  let devmodeToken = null;
  if (process.platform === "win32") {
    if (isFax) {
      devmodeToken = await applyCleanFaxDevmode(deviceName);
    } else {
      devmodeToken = await applyUserPrinterDevmode(deviceName);
    }
  }
  _printInFlight = true;
  let usedEngine = null;
  try {
    // 第一選択 = Sumatra (Win + 非 FAX + Sumatra 同梱あり、forceChromium
    // 時はスキップ)
    if (canSumatra && !forceChromium) {
      await sumatraPrintPdf(tempPath, { deviceName, copies, landscape, duplex, bin, color });
      usedEngine = "sumatra";
    }
    // 最終 = Chromium silent / silent:false (FAX、非 Win、Sumatra 不在、
    //                                       force chromium のいずれか)
    if (!usedEngine) {
      await silentPrintPdf(tempPath, { deviceName, copies, landscape, duplex, bin, color });
      usedEngine = "chromium";
    }
    logCrash("print-route-end", { engine: usedEngine, deviceName, engineOverride });
  } finally {
    _printInFlight = false;
    if (devmodeToken) await restoreUserPrinterDevmode(devmodeToken);
  }
  return { tempPath, deviceName, copies, landscape, engine: usedEngine };
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

ipcMain.handle("kpdf3:render-page", async (event, pageNo, opts) => {
  if (pageNo < 0) {
    // Synthetic (user-inserted) pages are rendered on the renderer side
    // (canvas-backed). Main has no canvas API and refuses these.
    throw new Error(
      `Page ${pageNo} is synthetic — render on the renderer side`,
    );
  }
  // B3-α: resolve via the calling window's active tab so a render
  // request from window A always reads window A's workspace, even if
  // the legacy active-* globals currently point at window B's. Falls
  // back to globals for legacy single-window flows.
  const { doc, pages } = activeForEvent(event);
  const useDoc = doc ?? activeDoc;
  const usePages = doc ? pages : activePages;
  if (!useDoc) throw new Error("No PDF loaded");
  const row = usePages.find((p) => p.pageNo === pageNo);
  if (!row) throw new Error(`Page ${pageNo} not found in workspace`);
  return renderPageCanonical(useDoc, row, {
    zoom: opts?.zoom ?? 1.0,
    alpha: opts?.alpha ?? true,
  });
});

ipcMain.handle("kpdf3:get-source-meta", async (event) => {
  // B3-α: refreshViewer reads this; per-event so a request from
  // window A always returns A's metadata even if the global active-*
  // refs currently point at window B's tab.
  const { workspace, sourcePdfPath } = activeForEvent(event);
  const ws = workspace ?? activeWorkspace;
  const path = sourcePdfPath ?? activeSourcePdfPath;
  if (!ws) return null;
  const meta = ws.getSourceMeta();
  // The workspace's stored fileName reflects the PDF first imported into
  // it. With ADR-0007 fingerprint dedupe, byte-copy Save As reuses the
  // original workspace, so the stored name lags behind the file the user
  // is actually viewing. Override with the active path's basename so the
  // title bar / status updates match the user's mental model.
  if (meta && path) {
    meta.fileName = basename(path);
  }
  return meta;
});

ipcMain.handle("kpdf3:get-pages", async (event) => {
  const ws = activeForEvent(event).workspace ?? activeWorkspace;
  if (!ws) return [];
  return ws.getPages();
});

// C3 annotation read-only proxy. Extract annotations from the active tab's
// source PDF on first request, cache on the tab handle. Returns a plain
// object keyed by 1-based pageNo so the renderer can hold a Map cheaply.
// Caller may pre-fetch once on workspace open or fetch lazily per page.
ipcMain.handle("kpdf3:get-all-annotations", async (event) => {
  const { doc, tabId } = activeForEvent(event);
  if (!doc || !tabId) return {};
  const h = tabHandles.get(tabId);
  if (!h) return {};
  if (h.annotations) return h.annotations;
  /** @type {Record<number, ReturnType<typeof extractPageAnnotationsFromDoc>>} */
  const map = {};
  const pageCount = doc.countPages();
  for (let i = 0; i < pageCount; i++) {
    const annots = extractPageAnnotationsFromDoc(doc, i);
    if (annots.length > 0) map[i + 1] = annots;
  }
  h.annotations = map;
  return map;
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
 * β31/β34/β78: dual-track storage —
 *   - image_blob (96 dpi PNG): viewer fallback. β31 で 300 dpi に上げた
 *     が、β34 で vector path (`kpdf3:render-inserted-source-page`) が
 *     入って以降は viewer プレビューも vector が主経路。image_blob は
 *     vector 失敗時のフォールバックに縮退したので β78 で 96 dpi まで
 *     下げ、挿入時のメモリ・時間・workspace 容量を圧縮。
 *   - inserted_source_pdfs (vector): the entire external PDF is stored
 *     once (dedup by SHA-256). Exporter/print uses copyPages on this
 *     blob so vector text + lines stay crisp at any output resolution.
 *
 * Returns the new synthetic pageNos so the renderer can scroll to the
 * first inserted page if it wants. (§17.3, β31 vector path.)
 */
ipcMain.handle(
  "kpdf3:add-inserted-pdf-pages",
  async (event, { afterPageNo, afterKey, externalPath }) => {
    if (!activeWorkspace) throw new Error("No active workspace");
    if (!externalPath) throw new Error("externalPath missing");
    const buf = readFileSync(externalPath);
    const out = await _insertPdfBytesIntoWorkspace({
      workspace: activeWorkspace,
      pdfBytes: buf,
      afterPageNo,
      afterKey,
      sender: event?.sender,
    });
    reopenActiveDoc();
    return { syntheticPageNos: out };
  },
);

/**
 * Core: insert every page of a PDF (provided as raw bytes) into the given
 * workspace as synthetic, image-backed pages. Shared between the file-drop
 * IPC (`kpdf3:add-inserted-pdf-pages`) and the cross-window thumb D&D path
 * (`kpdf3:page-bar-drop`, β.79) so vector dedup, display_order math, and
 * the progress IPC stay identical.
 *
 * Caller is responsible for refreshing any mupdf doc / pages cache after
 * this returns — `reopenActiveDoc()` or `_reopenDocForTab()`.
 *
 * @returns {Promise<number[]>} synthetic pageNos (negative) of the new rows
 */
async function _insertPdfBytesIntoWorkspace({
  workspace,
  pdfBytes,
  afterPageNo,
  afterKey,
  sender,
}) {
  // Store the entire external PDF once for vector-preserving export.
  // Many pages from the same PDF share this row via SHA-256 dedup.
  const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
  const sourcePdfId = workspace.getOrCreateInsertedSourcePdf({
    sha256,
    pdfBlob: pdfBytes,
    byteSize: pdfBytes.length,
  });
  const doc = mupdf.Document.openDocument(
    new Uint8Array(pdfBytes),
    "application/pdf",
  );
  // β77: when `afterKey` is supplied we anchor on the *visible* page
  // just before the drop target (positive = source pageNo, negative =
  // synthetic key, 0 = before-everything). Reorder operations can move
  // synth rows away from their slot anchor, so the legacy
  // `MAX(order_in_slot)+1` strategy no longer matches the user's
  // visual gap; we compute explicit display_orders in [lower, upper)
  // around the visible neighbours instead.
  let lower = null;
  let upper = null;
  let resolvedAfterPageNo = typeof afterPageNo === "number" ? afterPageNo : 0;
  if (typeof afterKey === "number") {
    const pages = workspace.getPages();
    let idx;
    if (afterKey === 0) {
      idx = -1;
    } else {
      idx = pages.findIndex((p) => p.pageNo === afterKey);
      if (idx < 0) {
        throw new Error(
          `insert-pdf-bytes: afterKey ${afterKey} not in visible pages`,
        );
      }
    }
    lower = idx >= 0 ? pages[idx].orderKey : 0;
    upper =
      idx + 1 < pages.length ? pages[idx + 1].orderKey : lower + 1;
    // Derive the slot anchor (after_page_no column) from the visible
    // neighbour. Even with explicit display_order set, after_page_no
    // is kept consistent so listInsertedPages's secondary sort and any
    // future legacy fallback stay sensible.
    if (typeof afterPageNo !== "number") {
      if (afterKey > 0) {
        resolvedAfterPageNo = afterKey;
      } else if (afterKey < 0) {
        const synthRow = pages[idx];
        resolvedAfterPageNo = synthRow.syntheticAfterPageNo ?? 0;
      } else {
        resolvedAfterPageNo = 0;
      }
    }
  }
  const synthetic = [];
  try {
    const count = doc.countPages();
    for (let i = 0; i < count; i++) {
        // β78: yield to the event loop between pages so the UI thread
        // can answer renderer IPC pings / heartbeats. Without this the
        // 25-page external PDF case blocks main for ~20-30s and the OS
        // pops up a "Not responding" dialog even though we finish fine.
        // The setImmediate gap is ~1ms — negligible vs the 0.5-1s per
        // page raster.
        if (i > 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (sender && !sender.isDestroyed()) {
          try {
            sender.send("kpdf3:insert-pdf-progress", { i, total: count });
          } catch { /* renderer gone, keep going */ }
        }
        const page = doc.loadPage(i);
        try {
          const bounds = page.getBounds();
          const pdfW = bounds[2] - bounds[0];
          const pdfH = bounds[3] - bounds[1];
          // β78: 300 → 96 dpi. β31 で 300 dpi に上げたのは vector path
          // 不在時に viewer プレビューを鮮明化する目的だったが、β34 で
          // `kpdf3:render-inserted-source-page` が入って以降は image_blob
          // は vector 失敗時のフォールバック専用に縮退。実用上の鮮明さは
          // vector path が担保するので、ここはフォールバック用の軽量
          // サムネで十分。30 MB × 25 ページ級の外部 PDF を挿入する典型
          // 操作で raster 時間 ~7x 短縮 + ピーク pixmap 26 → 2.7 MB
          // (OOM 回避) + workspace 増分 25 MB → 5 MB の三重メリット。
          const ZOOM = 96 / 72; // 96 dpi fallback thumbnail
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
          // Spread n pages evenly across (lower, upper) so subsequent
          // inserts at the same gap retain headroom on both sides.
          let displayOrder = null;
          if (lower != null && upper != null) {
            displayOrder = lower + ((i + 1) / (count + 1)) * (upper - lower);
          }
          const syntheticPageNo = workspace.addInsertedImagePage({
            afterPageNo: resolvedAfterPageNo,
            imageBlob: Buffer.from(pngBytes),
            imageW: imgW,
            imageH: imgH,
            width: pdfW,
            height: pdfH,
            sourcePdfId,
            sourcePageIndex: i,
            displayOrder,
          });
          synthetic.push(syntheticPageNo);
        } finally {
          page.destroy?.();
        }
      }
  } finally {
    doc.destroy?.();
  }
  return synthetic;
}

// ---- Cross-window thumb D&D (β.79) -----------------------------------
//
// Mirrors B3-γ activeTabDrag but at page granularity. The source window's
// sidebar fires `page-drag-start` on dragstart with the multi-selected
// page keys (positive = source pageNo, negative = synthetic key). A
// sibling window's sidebar / thumb / +gap consumes via `page-bar-drop`,
// supplying the visual anchor (afterPageNo + β77 afterKey). Main extracts
// the requested pages from the source workspace into a single mini-PDF
// buffer, then feeds it into the same `_insertPdfBytesIntoWorkspace`
// path the external file drop uses — vector dedup + 96 dpi fallback
// thumbnail + progress IPC are shared automatically.

/** @type {{ sourceWinId: number, sourceTabId: string, pageKeys: number[] } | null} */
let activePageDrag = null;

ipcMain.handle("kpdf3:page-drag-start", async (event, payload) => {
  const ws = windowStateForEvent(event);
  const sourceTabId = ws?.activeTabId ?? null;
  const pageKeys = Array.isArray(payload?.pageKeys)
    ? payload.pageKeys.filter((k) => Number.isInteger(k) && k !== 0)
    : [];
  if (!sourceTabId || pageKeys.length === 0) {
    return { ok: false, reason: "no-payload" };
  }
  activePageDrag = {
    sourceWinId: ws.win.id,
    sourceTabId,
    pageKeys,
  };
  return { ok: true };
});

ipcMain.handle("kpdf3:page-drag-end", async () => {
  // Source's dragend often fires BEFORE the target's drop in
  // cross-window scenarios on Linux/Electron, so clearing immediately
  // races bar-drop and the user sees "no-active-drag". Defer the
  // cleanup behind a 500ms grace so bar-drop wins. If another dragstart
  // overwrites the slot in the meantime, the snapshot check leaves
  // the new drag intact.
  const snapshot = activePageDrag;
  setTimeout(() => {
    if (activePageDrag === snapshot) activePageDrag = null;
  }, 500);
  return { ok: true };
});

ipcMain.handle(
  "kpdf3:page-bar-drop",
  async (event, { afterPageNo, afterKey } = {}) => {
    if (!activePageDrag) return { ok: false, reason: "no-active-drag" };
    const tgtSt = windowStateForEvent(event);
    if (!tgtSt) return { ok: false, reason: "no-target-window" };
    if (tgtSt.win.id === activePageDrag.sourceWinId) {
      // Same-window drop should have been caught by the local reorder
      // path; bail without consuming so a later target window can still
      // pick it up if the user drags again.
      return { ok: false, reason: "same-window" };
    }
    const targetTabId = tgtSt.activeTabId;
    if (!targetTabId) return { ok: false, reason: "no-target-tab" };
    const tgtH = tabHandles.get(targetTabId);
    const srcH = tabHandles.get(activePageDrag.sourceTabId);
    if (!tgtH?.workspace || !srcH?.workspace) {
      return { ok: false, reason: "tab-handle-missing" };
    }
    const pageKeys = activePageDrag.pageKeys;
    activePageDrag = null; // consume
    let pdfBytes;
    try {
      pdfBytes = await _extractPagesAsPdfBuffer(srcH.workspace, pageKeys);
    } catch (err) {
      console.error("[page-bar-drop] extract failed", err);
      return { ok: false, reason: `extract-failed: ${err.message ?? err}` };
    }
    let syntheticPageNos;
    try {
      syntheticPageNos = await _insertPdfBytesIntoWorkspace({
        workspace: tgtH.workspace,
        pdfBytes,
        afterPageNo,
        afterKey,
        sender: event?.sender,
      });
    } catch (err) {
      console.error("[page-bar-drop] insert failed", err);
      return { ok: false, reason: `insert-failed: ${err.message ?? err}` };
    }
    // Refresh target tab's mupdf doc + pages cache so subsequent
    // render-page calls (and renderer refreshViewer) see the new layout.
    _reopenDocForTab(targetTabId);
    return { ok: true, syntheticPageNos };
  },
);

/** Build a single in-memory PDF containing exactly the requested pages
 *  from `srcWorkspace`, preserving sidebar order. Source pages copy
 *  vector via pdf-lib; synth pages backed by `inserted_source_pdfs`
 *  ditto; image-only synth pages embed their PNG into a fresh A4-sized
 *  page. User-applied rotation is folded into each output page's
 *  /Rotate so the receiving workspace records swapped dims naturally. */
async function _extractPagesAsPdfBuffer(srcWorkspace, pageKeys) {
  const newPdf = await PDFDocument.create();
  const visible = srcWorkspace.getPages();
  const byKey = new Map(visible.map((p) => [p.pageNo, p]));
  let srcPdfDoc = null;
  async function getSrcPdfDoc() {
    if (srcPdfDoc) return srcPdfDoc;
    const bytes = srcWorkspace.getSourceBytes();
    if (!bytes) return null;
    srcPdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return srcPdfDoc;
  }
  const extCache = new Map();
  async function getExtPdf(id) {
    if (extCache.has(id)) return extCache.get(id);
    const row = srcWorkspace.getInsertedSourcePdf(id);
    if (!row?.pdfBlob) {
      throw new Error(`inserted_source_pdfs id=${id} missing`);
    }
    const doc = await PDFDocument.load(row.pdfBlob, { ignoreEncryption: true });
    extCache.set(id, doc);
    return doc;
  }
  for (const key of pageKeys) {
    const row = byKey.get(key);
    if (!row) continue; // page removed / undeleted between dragstart and drop
    const userRot = (((row.userRotation ?? 0) % 360) + 360) % 360;
    if (!row.isSynthetic && key > 0) {
      const src = await getSrcPdfDoc();
      if (!src) throw new Error("source PDF bytes missing");
      const idx = key - 1; // 1-based pageNo → 0-based source PDF index
      const [copied] = await newPdf.copyPages(src, [idx]);
      if (userRot !== 0) {
        const cur = copied.getRotation().angle ?? 0;
        copied.setRotation(degrees(((cur + userRot) % 360 + 360) % 360));
      }
      newPdf.addPage(copied);
    } else if (row.isSynthetic && row.syntheticSourcePdfId != null
        && row.syntheticSourcePageIndex != null) {
      // β34-vector path: synth references an `inserted_source_pdfs` blob.
      const ext = await getExtPdf(row.syntheticSourcePdfId);
      const [copied] = await newPdf.copyPages(
        ext, [row.syntheticSourcePageIndex],
      );
      if (userRot !== 0) {
        const cur = copied.getRotation().angle ?? 0;
        copied.setRotation(degrees(((cur + userRot) % 360 + 360) % 360));
      }
      newPdf.addPage(copied);
    } else if (row.isSynthetic && row.syntheticHasImage) {
      // Image-only synth (β.78 fallback or legacy 300dpi rows). Fetch
      // the PNG and embed it into a fresh page at canonical dims, then
      // bake the user rotation into /Rotate.
      const img = srcWorkspace.getInsertedPageImage(row.syntheticId);
      if (!img?.imageBlob) continue;
      const pngBytes = img.imageBlob instanceof Uint8Array
        ? img.imageBlob
        : new Uint8Array(img.imageBlob);
      const embedded = await newPdf.embedPng(pngBytes);
      const w = row.cropW ?? embedded.width;
      const h = row.cropH ?? embedded.height;
      const page = newPdf.addPage([w, h]);
      page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
      if (userRot !== 0) {
        page.setRotation(degrees(((userRot) % 360 + 360) % 360));
      }
    } else {
      // White / text-only synth pages aren't part of MVP scope; skip
      // silently rather than throwing so a mixed selection still
      // produces useful output for the other pages.
      continue;
    }
  }
  if (newPdf.getPageCount() === 0) {
    throw new Error("no extractable pages in selection");
  }
  const bytes = await newPdf.save();
  return Buffer.from(bytes);
}

/** Refresh a tab's mupdf doc + pages cache after a mutation. Mirrors
 *  `reopenActiveDoc()` but addresses any tab (not just the focused
 *  window's active one), so cross-window inserts can refresh the target
 *  tab without touching globals when the source window is focused. */
function _reopenDocForTab(tabId) {
  const h = tabHandles.get(tabId);
  if (!h?.workspace) return;
  if (h.doc) {
    try { h.doc.destroy(); } catch { /* ignore */ }
  }
  const bytes = h.workspace.getSourceBytes();
  h.doc = bytes ? openPdfDocument(bytes) : null;
  h.pages = h.workspace.getPages({ includeDeleted: true });
  // Keep the legacy globals in sync if the refreshed tab is the active
  // one — render-page IPC reads them for the focused window's render path.
  if (activeTabId === tabId) {
    activeDoc = h.doc;
    activePages = h.pages;
  }
}

/** β31: fetch the vector-source PDF bytes for an inserted page so the
 *  exporter/print path can copyPages it instead of using image_blob.
 *  β.79: resolve per-event so a cross-window page insert (which puts
 *  the new synth row into target's workspace while source is focused)
 *  fetches from the *calling* window's tab, not the global active. */
ipcMain.handle("kpdf3:get-inserted-source-pdf", async (event, id) => {
  const ws = activeForEvent(event).workspace ?? activeWorkspace;
  if (!ws) throw new Error("No active workspace");
  const row = ws.getInsertedSourcePdf(id);
  if (!row) return null;
  const u8 = row.pdfBlob instanceof Uint8Array
    ? row.pdfBlob
    : new Uint8Array(row.pdfBlob);
  return { pdfBlob: u8, byteSize: row.byteSize };
});

ipcMain.handle("kpdf3:get-inserted-page-image", async (event, id) => {
  const ws = activeForEvent(event).workspace ?? activeWorkspace;
  if (!ws) throw new Error("No active workspace");
  const row = ws.getInsertedPageImage(id);
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

/**
 * β.80: OS にインストールされた system font 名一覧を返す (申請書テンプレ
 * のフォーム枠でフォント指定するため)。result は string[]、エラー時は
 * 空配列。OS 別の手段:
 *
 *   - Linux: `fc-list :scalable=true family` を spawn。同義 alias は
 *     コンマ区切りで返るので primary name (先頭) のみ採用
 *   - Windows: PowerShell + System.Drawing.Text.InstalledFontCollection
 *   - macOS: `system_profiler SPFontsDataType -json` (将来対応、現状は
 *     空配列で fallback)
 *
 * 取得結果は 1 セッション分 module-level でキャッシュ (毎回 spawn せず
 * とも変化しない前提)。
 */
let _systemFontsCache = null;
ipcMain.handle("kpdf3:list-system-fonts", async () => {
  if (_systemFontsCache) return _systemFontsCache;
  const fonts = await _collectSystemFonts();
  _systemFontsCache = fonts;
  return fonts;
});

function _runOnce(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { windowsHide: true });
      const chunks = [];
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch { /* ignore */ }
        resolve(value);
      };
      const timer = setTimeout(() => settle(""), timeoutMs);
      proc.stdout.on("data", (b) => chunks.push(b));
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks).toString("utf-8"));
        else settle("");
      });
      proc.on("error", () => { clearTimeout(timer); settle(""); });
    } catch {
      resolve("");
    }
  });
}

async function _collectSystemFonts() {
  const platform = process.platform;
  try {
    if (platform === "linux") {
      const stdout = await _runOnce("fc-list", [":scalable=true", "family"]);
      if (!stdout) return [];
      const set = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        // 各行は "Family A,Family A Bold,Family A 太字" のようにカンマ
        // 区切り alias を持つことがある。primary name = 先頭フィールド。
        const primary = line.split(",")[0].trim();
        if (primary && primary.length <= 64) set.add(primary);
      }
      return [...set].sort((a, b) => a.localeCompare(b, "ja"));
    }
    if (platform === "win32") {
      const ps =
        "Add-Type -AssemblyName System.Drawing; " +
        "(New-Object System.Drawing.Text.InstalledFontCollection).Families | " +
        "ForEach-Object { $_.Name }";
      const stdout = await _runOnce(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        8000,
      );
      if (!stdout) return [];
      const set = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        const name = line.trim();
        if (name && name.length <= 64) set.add(name);
      }
      return [...set].sort((a, b) => a.localeCompare(b, "ja"));
    }
    // macOS: 後回し (system_profiler は出力が巨大、parse を別途実装)
    return [];
  } catch {
    return [];
  }
}

ipcMain.handle("kpdf3:get-app-info", async () => {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    isPackaged: app.isPackaged,
  };
});
