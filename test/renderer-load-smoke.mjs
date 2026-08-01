// Renderer module-graph load smoke test.
//
// なぜ: renderer は index.html → renderer.js の単一 ES module graph で、
// import 先のどれか 1 ファイルでもトップレベル評価が throw すると UI 全体が
// 無反応になる (v2.0.23 stable: sidebar-thumbs.js のモジュールレベル TDZ
// 参照で全 OS の renderer が死んだ)。node --test 系は関数単位の import
// しかせず、electron-runner の他テストはメインプロセス専用なので、この
// 事故クラスを検知できるのは「実 BrowserWindow で index.html をロードして
// graph 完走を確認する」本テストだけ。
//
// renderer.js は graph 評価の最終行で window.__rendererLoaded = true を
// 立てる (module-load sentinel)。ここではそれを poll で assert する。
// ipcMain handler は登録されていないため invoke 系は reject するが、
// それは async であり module 評価の完走には影響しない。

import { BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

console.log("=== Renderer module-graph load smoke test ===\n");

const indexHtml = path.join(__dirname, "..", "src", "renderer", "index.html");
const preload = path.join(__dirname, "..", "src", "main", "preload.cjs");

const win = new BrowserWindow({
  show: false,
  webPreferences: {
    // 本番 (main.js createWindow) と同一設定でロードする
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  },
});

// 診断用: renderer console の error を拾っておく (失敗時に表示)
const consoleErrors = [];
win.webContents.on("console-message", (e) => {
  if (e.level === "error") consoleErrors.push(e.message);
});
let loadFailed = null;
win.webContents.on("did-fail-load", (_e, code, desc) => {
  loadFailed = `${code} ${desc}`;
});

try {
  await win.loadURL(pathToFileURL(indexHtml).href);
  ok(!loadFailed, `index.html loaded${loadFailed ? ` (${loadFailed})` : ""}`);

  // module 評価は loadURL resolve 後も続き得るので sentinel を poll する
  const deadline = Date.now() + 15000;
  let loaded = false;
  while (Date.now() < deadline) {
    loaded = await win.webContents.executeJavaScript(
      "window.__rendererLoaded === true",
    );
    if (loaded) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  ok(loaded, "renderer module graph evaluated to completion (__rendererLoaded)");
  if (!loaded && consoleErrors.length) {
    console.error("  renderer console errors:");
    for (const m of consoleErrors) console.error(`    ${m}`);
  }
} catch (err) {
  fail++;
  console.error("  ✗ uncaught error during load:", err);
} finally {
  win.destroy();
}

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  console.log("Renderer load smoke: FAIL");
  process.exitCode = 1;
} else {
  console.log("Renderer load smoke: PASS ✅");
}
