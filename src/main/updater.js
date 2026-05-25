// electron-updater integration (§17.15).
//
// Wires GitHub Release based auto-update into the main process and
// forwards updater events to the renderer over IPC, so the renderer can
// drive a 98-styled UX (instead of electron-updater's built-in
// `checkForUpdatesAndNotify` which only emits an OS-native toast).
//
// Skip paths:
//   - app.isPackaged === false (npm start / electronmon dev runs)
//   - --no-update CLI flag (manual escape hatch for testers)
//
// Renderer events emitted:
//   - kpdf3:updater-checking       (auto-check just started)
//   - kpdf3:updater-update-available    { version, releaseNotes }
//   - kpdf3:updater-not-available  (current is latest)
//   - kpdf3:updater-download-progress  { percent, bytesPerSecond, transferred, total }
//   - kpdf3:updater-update-downloaded   { version }
//   - kpdf3:updater-error          { message }
//
// IPC handlers (renderer → main):
//   - kpdf3:updater-check          force a manual check
//   - kpdf3:updater-download       begin downloading the staged update
//   - kpdf3:updater-cancel-download   abort an in-flight download + drop
//                                     any partial files (electron-updater
//                                     uses CancellationToken to do this
//                                     cleanly — partial.* / blockmap
//                                     caches get removed)
//   - kpdf3:updater-install        quit & install the downloaded update

import { app, ipcMain } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater, CancellationToken } = electronUpdater;

let initialised = false;
/** @type {import('electron').BrowserWindow | null} */
let updaterWindow = null;
/** Active download's cancellation token. Held so the renderer's cancel
 *  button on the download busy-modal can abort cleanly — electron-updater
 *  removes the partial.* cache when a download is cancelled via token,
 *  which is the **β.31/β.32 起動クラッシュ仮説** root-cause mitigation
 *  ("後で" 経路で中間ファイルが残って次バージョン取得時に整合性破壊). */
/** @type {InstanceType<typeof CancellationToken> | null} */
let activeDownloadToken = null;

/** True when this run should never talk to the update server. */
function shouldSkip() {
  if (!app.isPackaged) return true;
  if (process.argv.includes("--no-update")) return true;
  return false;
}

/** Send an event to the renderer if the window is still alive. */
function sendToWindow(channel, payload) {
  if (!updaterWindow || updaterWindow.isDestroyed()) return;
  try {
    updaterWindow.webContents.send(channel, payload ?? null);
  } catch (err) {
    console.warn(`[updater] send(${channel}) failed:`, err);
  }
}

/** Install the autoUpdater event listeners. Idempotent. */
function wireEvents() {
  autoUpdater.on("checking-for-update", () => {
    sendToWindow("kpdf3:updater-checking");
  });
  autoUpdater.on("update-available", (info) => {
    sendToWindow("kpdf3:updater-update-available", {
      version: info?.version ?? "",
      releaseNotes: typeof info?.releaseNotes === "string"
        ? info.releaseNotes
        : "",
      releaseDate: info?.releaseDate ?? "",
    });
  });
  autoUpdater.on("update-not-available", () => {
    sendToWindow("kpdf3:updater-not-available");
  });
  autoUpdater.on("download-progress", (p) => {
    sendToWindow("kpdf3:updater-download-progress", {
      percent: typeof p?.percent === "number" ? p.percent : 0,
      bytesPerSecond: p?.bytesPerSecond ?? 0,
      transferred: p?.transferred ?? 0,
      total: p?.total ?? 0,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    sendToWindow("kpdf3:updater-update-downloaded", {
      version: info?.version ?? "",
    });
  });
  autoUpdater.on("error", (err) => {
    sendToWindow("kpdf3:updater-error", {
      message: err?.message || String(err),
    });
  });
}

/** Install the IPC handlers. Idempotent (re-register is a no-op). */
function wireIpc() {
  ipcMain.handle("kpdf3:updater-check", async () => {
    if (shouldSkip()) {
      return { skipped: true, reason: app.isPackaged ? "no-update flag" : "dev mode" };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      // result may be null when no update is available — normalize.
      return {
        skipped: false,
        version: result?.updateInfo?.version ?? null,
      };
    } catch (err) {
      return { skipped: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("kpdf3:updater-download", async () => {
    if (shouldSkip()) return { skipped: true };
    // If a previous download was abandoned without proper cancel (e.g.
    // app crashed mid-DL), the token would already be released; create
    // a fresh one. Holding the reference lets `updater-cancel-download`
    // abort cleanly.
    const token = new CancellationToken();
    activeDownloadToken = token;
    try {
      await autoUpdater.downloadUpdate(token);
      return { ok: true };
    } catch (err) {
      // CancellationError is the expected outcome when the user clicked
      // the busy-modal cancel button. Surface as ok:false with cancelled
      // flag so the renderer can suppress the error confirm.
      const cancelled =
        err?.name === "CancellationError" || /cancell?ed/i.test(err?.message ?? "");
      return { ok: false, cancelled, error: err?.message || String(err) };
    } finally {
      if (activeDownloadToken === token) activeDownloadToken = null;
    }
  });

  // β.132: in-flight download cancel. Called from the renderer's busy-modal
  // cancel button. electron-updater removes the .partial download (and
  // blockmap cache) when cancelled via token, which is the mitigation for
  // the autoUpdater "後で" 仮説 (β.31/β.32) — no half-baked cache lingers
  // to corrupt the next version's diff calculation.
  ipcMain.handle("kpdf3:updater-cancel-download", () => {
    if (shouldSkip()) return { skipped: true };
    if (!activeDownloadToken) return { ok: true, hadActive: false };
    try {
      activeDownloadToken.cancel();
      return { ok: true, hadActive: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("kpdf3:updater-install", () => {
    if (shouldSkip()) return { skipped: true };
    // isSilent=false: show the installer UI on Windows so the user can
    // confirm the install path. isForceRunAfter=true: relaunch K-PDF3
    // once the new version is in place.
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });
}

/**
 * Initialise the auto-updater and start the first check ~3s after the
 * window is shown. Subsequent checks can be triggered from the renderer
 * via the `kpdf3:updater-check` IPC.
 *
 * @param {import('electron').BrowserWindow} win
 */
export function setupAutoUpdater(win) {
  updaterWindow = win;

  if (initialised) return;
  initialised = true;

  // We drive download from the renderer, so opt out of auto-download.
  autoUpdater.autoDownload = false;
  // β.132: flip `autoInstallOnAppQuit` to true so that when the user
  // chooses 「次回起動時に適用」 in the download-complete confirm, the
  // staged update actually applies on normal quit (was a no-op before
  // — next launch re-prompted "ダウンロードしますか？" for an already
  // downloaded version, leading to double-DL + cache mismatch, which
  // is the second leg of the autoUpdater "後で" 仮説).
  autoUpdater.autoInstallOnAppQuit = true;
  // Allow downgrading pre-release tags (β5 → β4) only when the user
  // explicitly asks. Default false — we never silently downgrade.
  autoUpdater.allowDowngrade = false;
  // Treat every tag as a candidate so β5 → β6 → β7 chain is followed
  // until stable. Set to false post-stable if we want testers to stop
  // receiving betas.
  autoUpdater.allowPrerelease = true;

  // Pipe electron-updater's internal logs through console so they show
  // up alongside our existing main-process logs. Mild verbosity is
  // useful during β; we can quiet this once stable.
  autoUpdater.logger = console;

  wireEvents();
  wireIpc();

  if (shouldSkip()) {
    console.log("[updater] skipped (dev mode or --no-update)");
    return;
  }

  // Small delay so the renderer has time to subscribe to the events
  // before the first burst of `checking-for-update` / `update-available`
  // fires. 3s is enough on slow disks; the user-facing dialog is
  // dismissable so a few extra seconds aren't disruptive.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[updater] initial check failed:", err?.message || err);
    });
  }, 3000);
}
