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

import { app, BrowserWindow, ipcMain } from "electron";
import electronUpdater from "electron-updater";

import { checkMacUpdate, downloadMacUpdate, extractMacUpdate, applyMacUpdate, logMacUpdate, macUpdateLogPath } from "./updater-mac.js";

const { autoUpdater, CancellationToken } = electronUpdater;

// 2026-07-14: macOS はコード署名が無いと Squirrel.Mac (electron-updater の
// mac 実装) が更新を受け付けないため、自前の更新層 (updater-mac.js) に
// 委譲する。**renderer に飛ばすイベント名と IPC の返り値は同じ** なので、
// 98 風の更新 UX (確認 → 進捗 → 再起動) はそのまま使い回せる。
// Windows/Linux の経路 (β.132〜139 で実機検証済) は 1 バイトも変えない。
const IS_MAC = process.platform === "darwin";

/** darwin: 直近の checkMacUpdate 結果 (download が使う)。 */
let macPendingUpdate = null;
/** darwin: 検証 + 展開済みで、まだ適用していない新 .app のパス。 */
let macDownloadedZip = null;
/** darwin: 展開済みの新 .app (差し替え元)。 */
let macStagedApp = null;
let macCancelRequested = false;
/** darwin: 差し替えスクリプトを起こしたか (二重適用と will-quit 再入の防止)。 */
let macApplyStarted = false;

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

// ---- macOS 自前更新 (2026-07-14) -------------------------------------
//
// electron-updater と **同じイベント名・同じ返り値** で振る舞うので、
// renderer 側 (98 風の確認 → 進捗 → 再起動 UX) は一切変更しなくてよい。
// 詳細と「なぜ Squirrel.Mac が使えないか」は updater-mac.js 冒頭。

/** darwin: 更新確認。electron-updater の checkForUpdates 相当。 */
async function macCheck() {
  sendToWindow("kpdf3:updater-checking");
  try {
    const info = await checkMacUpdate(app.getVersion());
    if (!info.available) {
      sendToWindow("kpdf3:updater-not-available");
      macPendingUpdate = null;
      return { skipped: false, version: null };
    }
    macPendingUpdate = info;
    sendToWindow("kpdf3:updater-update-available", {
      version: info.version,
      releaseNotes: "",
      releaseDate: "",
    });
    return { skipped: false, version: info.version };
  } catch (err) {
    const message = err?.message || String(err);
    sendToWindow("kpdf3:updater-error", { message });
    return { skipped: false, error: message };
  }
}

/** darwin: zip をダウンロードして sha512 検証まで済ませる。 */
async function macDownload() {
  if (!macPendingUpdate) return { ok: false, error: "更新情報がありません。もう一度「更新を確認」してください" };
  macCancelRequested = false;
  try {
    const zipPath = await downloadMacUpdate(macPendingUpdate, {
      onProgress: (p) => {
        sendToWindow("kpdf3:updater-download-progress", {
          percent: p.percent,
          bytesPerSecond: 0, // 自前 DL では計測しない (UI は percent のみ使用)
          transferred: p.transferred,
          total: p.total,
        });
      },
      shouldCancel: () => macCancelRequested,
    });
    macDownloadedZip = zipPath;
    // 展開はここで済ませる (130MB の ditto は数秒かかる)。適用段はスクリプトを
    // 起こすだけにしておかないと、終了直前に固まったように見える。
    macStagedApp = await extractMacUpdate(zipPath);
    sendToWindow("kpdf3:updater-update-downloaded", { version: macPendingUpdate.version });
    return { ok: true };
  } catch (err) {
    if (err?.cancelled) return { ok: false, cancelled: true };
    const message = err?.message || String(err);
    logMacUpdate(`download: FAILED ${message}`);
    sendToWindow("kpdf3:updater-error", {
      message: `${message}\n(ログ: ${macUpdateLogPath()})`,
    });
    return { ok: false, cancelled: false, error: message };
  }
}

/** darwin: 検証済み zip を適用して再起動 (切り離しスクリプトが差し替える)。 */
async function macInstall() {
  if (!macStagedApp) return { ok: false, error: "適用できる更新がありません" };
  try {
    await applyMacUpdate(macStagedApp, {
      execPath: process.execPath,
      pid: process.pid,
      relaunch: true,
    });
  } catch (err) {
    const message = err?.message || String(err);
    logMacUpdate(`install: FAILED ${message}`);
    sendToWindow("kpdf3:updater-error", {
      message: `${message}\n(ログ: ${macUpdateLogPath()})`,
    });
    return { ok: false, error: message };
  }
  macApplyStarted = true;
  // スクリプトは「親の終了待ち → 差し替え → 再起動」。**アプリが終了しない限り
  // 差し替えは始まらない** (起動中の .app を壊さないためスクリプト側で中止する)
  // ので、確実に終了させる。窓を先に destroy (Linux 経路と同じ理由)。
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.destroy(); } catch { /* already gone */ }
  }
  app.quit();
  // quit が何かに阻まれた場合の保険 — ここで残ると「再起動もせず版も上がらない」
  // (2026-07-14 実機報告と同じ見え方) になるので、少し待って強制終了する。
  setTimeout(() => {
    logMacUpdate("install: app.quit() did not exit in 4s — forcing exit");
    app.exit(0);
  }, 4000).unref?.();
  return { ok: true };
}

/**
 * darwin: 「次回起動時に適用」(= 確認モーダルの右ボタン) の実装。
 * Windows/Linux は electron-updater の autoInstallOnAppQuit が担うが、
 * Mac は自前層なので **終了時に自分で適用する** 必要がある。これが無いと
 * 「次回起動時に適用」を選んでも永遠に何も起きない (2026-07-14 実機報告の
 * 有力候補)。終了は user 起点なので再起動はしない。
 */
function wireMacApplyOnQuit() {
  app.on("will-quit", (e) => {
    if (!macStagedApp || macApplyStarted) return;
    macApplyStarted = true;
    e.preventDefault(); // スクリプトを起こすまで数十 ms だけ終了を待たせる
    applyMacUpdate(macStagedApp, {
      execPath: process.execPath,
      pid: process.pid,
      relaunch: false, // ユーザーが自分で終了した = 勝手に再起動しない
    }).catch((err) => {
      logMacUpdate(`apply-on-quit: FAILED ${err?.message || err}`);
    }).finally(() => {
      app.exit(0);
    });
  });
}

/** Install the IPC handlers. Idempotent (re-register is a no-op). */
function wireIpc() {
  ipcMain.handle("kpdf3:updater-check", async () => {
    if (shouldSkip()) {
      return { skipped: true, reason: app.isPackaged ? "no-update flag" : "dev mode" };
    }
    if (IS_MAC) return macCheck();
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
    if (IS_MAC) return macDownload();
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
    if (IS_MAC) {
      // downloadMacUpdate は次のチャンク受信時に shouldCancel() を見て中断し、
      // 部分ファイルごと temp ディレクトリを消す。
      macCancelRequested = true;
      return { ok: true, hadActive: true };
    }
    if (!activeDownloadToken) return { ok: true, hadActive: false };
    try {
      activeDownloadToken.cancel();
      return { ok: true, hadActive: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("kpdf3:updater-install", async () => {
    if (shouldSkip()) return { skipped: true };
    if (IS_MAC) return macInstall();
    // Linux (deb): electron-updater applies the update with a synchronous
    // pkexec/dpkg spawn inside quitAndInstall, freezing the main process
    // for 10+ seconds. If windows are still alive during that freeze,
    // GNOME flags them 「応答していません」 and offers 強制終了 (2026-07-10
    // 実機で確認)。窓を先に destroy してから適用すれば固まる対象が無く
    // ダイアログは出ない。Install 自体は別プロセスで走るので影響なし。
    // Windows の実績経路 (β.132〜139 実機検証済) は不変。
    if (process.platform === "linux") {
      for (const w of BrowserWindow.getAllWindows()) {
        try { w.destroy(); } catch { /* already gone */ }
      }
    }
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
  if (IS_MAC) wireMacApplyOnQuit();

  if (shouldSkip()) {
    console.log("[updater] skipped (dev mode or --no-update)");
    return;
  }

  // Small delay so the renderer has time to subscribe to the events
  // before the first burst of `checking-for-update` / `update-available`
  // fires. 3s is enough on slow disks; the user-facing dialog is
  // dismissable so a few extra seconds aren't disruptive.
  setTimeout(() => {
    if (IS_MAC) {
      // 自前の Mac 更新層。エラーはイベントで renderer に出る (起動時の
      // 通信失敗でアプリを止めない)。
      macCheck().catch((err) => {
        console.warn("[updater] initial mac check failed:", err?.message || err);
      });
      return;
    }
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[updater] initial check failed:", err?.message || err);
    });
  }, 3000);
}
