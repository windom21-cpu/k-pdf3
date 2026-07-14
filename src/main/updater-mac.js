// 2026-07-14: macOS のアプリ内更新 (自前実装)。
//
// 動機 (ユーザー): Mac では新版のたびに手動で /Applications を入れ替えて
// いる。アプリ内で完結させたい。
//
// **なぜ electron-updater に乗せないか**: macOS の autoUpdater は Squirrel.Mac
// が実体で、**コード署名 (Developer ID) された .app しか受け付けない**。
// K-PDF3 は「署名/公証は不要、dmg 直配布 + 初回右クリック開く」で運用する
// 決定 (HANDOVER §15.6) なので、署名を入れない限り構造的に使えない。
// そこで Sparkle 相当の最小限を自前で持つ:
//
//   1. 配布フィード (k-pdf3-releases の latest リリース) の `latest-mac.yml`
//      を読む — electron-builder が zip と一緒に publish するファイルで、
//      version / ファイル名 / sha512 が入っている
//   2. 新しければ zip をダウンロード (進捗を UI へ)
//   3. **sha512 を検証** (改竄・途中切れの検出。ここを通らないものは捨てる)
//   4. `ditto -x -k` で展開 → 中の .app を取り出す
//   5. 起動中の自分自身は上書きできないので、**切り離した shell スクリプト**に
//      「親プロセスの終了を待つ → ditto で差し替え → quarantine を剥がす →
//      再起動」を任せ、アプリは quit する
//
// ⚠️ `cp -R` は Electron Framework の symlink 構造を壊す (半壊コピーで起動
// しなくなる) ので **必ず ditto** を使う (2026-07-10 に手動更新で判明済、
// HANDOVER 冒頭 patch 一覧)。
//
// Windows/Linux は従来どおり electron-updater (updater.js)。この層は darwin
// でしか呼ばれない。

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, statSync, accessSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { get as httpsGet } from "node:https";

// 2026-07-14 実機報告「ダウンロードまでは進むのに、再起動もせず版も上がらない」
// への対策: **この経路は失敗が無言になりやすい** (差し替えは別プロセスの
// シェルスクリプトで、アプリはもう終了している)。全段階をログに残し、
// 「何が起きて どこで止まったか」を後から必ず特定できるようにする。
const LOG_PATH = join(homedir(), "Library", "Logs", "K-PDF3", "mac-update.log");

/** 更新ログのパス (UI から案内するのに使う)。 */
export function macUpdateLogPath() {
  return LOG_PATH;
}

/** 1 行追記。ログが書けないこと自体で更新を失敗させない。 */
export function logMacUpdate(message) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch { /* noop */ }
}

// 配布フィード = k-pdf3-releases の **latest リリース** (= stable)。
// β タグは CI で Windows のみビルドされるので、Mac がここを見て β を掴む
// ことはない (prerelease は /releases/latest に載らない)。
const FEED_BASE = "https://github.com/windom21-cpu/k-pdf3-releases/releases/latest/download";
const YML_URL = `${FEED_BASE}/latest-mac.yml`;

/**
 * latest-mac.yml から更新情報を取り出す (pure、テスト対象)。
 * electron-builder の出力形:
 *   version: 2.0.14
 *   files:
 *     - url: K-PDF3-2.0.14-arm64-mac.zip
 *       sha512: <base64>
 *       size: 123456
 *   path: K-PDF3-2.0.14-arm64-mac.zip
 *   releaseDate: '2026-07-14T...'
 * 返り値: { version, fileName, sha512, size } — zip が無ければ null
 * (dmg しか無い古いリリースを掴んで無限に失敗しないため)。
 */
export function parseLatestMacYml(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (!version) return null;
  // files: の各エントリ (url/sha512/size) を拾い、zip のものを採用する。
  const entries = [];
  const re = /-\s*url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)\s*\n\s*size:\s*(\d+)/g;
  for (const m of text.matchAll(re)) {
    entries.push({ fileName: m[1], sha512: m[2], size: Number(m[3]) });
  }
  const zip = entries.find((e) => e.fileName.toLowerCase().endsWith(".zip"));
  if (!zip) return null;
  return { version, ...zip };
}

/**
 * バージョン比較 (pure、テスト対象)。a > b なら 1、a < b なら -1、同じなら 0。
 * "2.0.14" > "2.0.14-beta.3" (stable が prerelease に勝つ) / "2.0.14-beta.10" >
 * "2.0.14-beta.9" (数値比較)。
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v ?? "").trim().split("-", 2);
    const nums = core.split(".").map((n) => Number(n) || 0);
    return { nums, pre: pre ?? null };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const d = (A.nums[i] ?? 0) - (B.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === null) return 1;   // stable > prerelease
  if (B.pre === null) return -1;
  // beta.3 vs beta.10 — 数値部分を数として比べる
  const an = Number(/(\d+)$/.exec(A.pre)?.[1] ?? 0);
  const bn = Number(/(\d+)$/.exec(B.pre)?.[1] ?? 0);
  if (an !== bn) return an > bn ? 1 : -1;
  return A.pre > B.pre ? 1 : A.pre < B.pre ? -1 : 0;
}

/** 現在版より新しいか (pure、テスト対象)。 */
export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

function _httpsGetFollow(url, onResponse, onError, depth = 0) {
  if (depth > 5) {
    onError(new Error("リダイレクトが多すぎます"));
    return;
  }
  httpsGet(url, { headers: { "User-Agent": "K-PDF3" } }, (res) => {
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      _httpsGetFollow(res.headers.location, onResponse, onError, depth + 1);
      return;
    }
    if (status !== 200) {
      res.resume();
      onError(new Error(`HTTP ${status}`));
      return;
    }
    onResponse(res);
  }).on("error", onError);
}

/** テキストを取得 (リダイレクト追従)。 */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    _httpsGetFollow(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    }, reject);
  });
}

/**
 * 配布フィードを見て更新の有無を返す。
 * { available: false } | { available: true, version, fileName, sha512, size }
 */
export async function checkMacUpdate(currentVersion) {
  logMacUpdate(`check: current=${currentVersion}`);
  const yml = await fetchText(YML_URL);
  const info = parseLatestMacYml(yml);
  if (!info) throw new Error("latest-mac.yml を解釈できませんでした (zip 未公開の可能性)");
  if (!isNewerVersion(info.version, currentVersion)) {
    logMacUpdate(`check: up to date (feed=${info.version})`);
    return { available: false, version: info.version };
  }
  logMacUpdate(`check: update available ${currentVersion} -> ${info.version} (${info.fileName})`);
  return { available: true, ...info };
}

/**
 * zip をダウンロードして sha512 を検証し、保存先パスを返す。
 * onProgress({ percent, transferred, total }) を随時呼ぶ。
 * shouldCancel() が true を返したら中断して部分ファイルを消す。
 */
export function downloadMacUpdate(info, { onProgress, shouldCancel } = {}) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "kpdf3-update-"));
    const dest = join(dir, info.fileName);
    const url = `${FEED_BASE}/${encodeURIComponent(info.fileName)}`;
    const hash = createHash("sha512");
    let transferred = 0;
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } };

    _httpsGetFollow(url, (res) => {
      const total = Number(res.headers["content-length"]) || info.size || 0;
      const out = createWriteStream(dest);
      res.on("data", (chunk) => {
        if (shouldCancel?.()) {
          res.destroy();
          out.destroy();
          cleanup();
          reject(Object.assign(new Error("cancelled"), { cancelled: true }));
          return;
        }
        hash.update(chunk);
        transferred += chunk.length;
        onProgress?.({
          percent: total > 0 ? (transferred / total) * 100 : 0,
          transferred,
          total,
        });
      });
      res.pipe(out);
      out.on("finish", () => {
        // 改竄・途中切れの検出。ここを通らないものは **絶対に展開しない**。
        const digest = hash.digest("base64");
        if (digest !== info.sha512) {
          logMacUpdate(`download: sha512 MISMATCH (got ${digest.slice(0, 16)}…, want ${String(info.sha512).slice(0, 16)}…, bytes=${transferred})`);
          cleanup();
          reject(new Error("ダウンロードした更新ファイルの検証に失敗しました (sha512 不一致)"));
          return;
        }
        logMacUpdate(`download: ok (${transferred} bytes, sha512 verified) -> ${dest}`);
        resolve(dest);
      });
      out.on("error", (err) => { logMacUpdate(`download: write error ${err?.message}`); cleanup(); reject(err); });
    }, (err) => { logMacUpdate(`download: http error ${err?.message}`); cleanup(); reject(err); });
  });
}

function _run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`))));
  });
}

/**
 * zip の中の .app を取り出して、展開先の .app パスを返す。
 *
 * **ダウンロード直後に呼ぶこと** (適用時ではなく)。130MB の展開に数秒かかるので、
 * 終了直前にやるとアプリが固まったように見える。適用段はスクリプトを起こすだけに
 * しておく。
 */
export async function extractMacUpdate(zipPath) {
  const dir = join(zipPath, "..", "extracted");
  // cp -R ではなく ditto (Electron Framework の symlink を保つ)。
  await _run("/usr/bin/ditto", ["-x", "-k", zipPath, dir]);
  const app = readdirSync(dir).find((n) => n.endsWith(".app"));
  if (!app) throw new Error("更新ファイルの中に .app が見つかりません");
  const appPath = join(dir, app);
  logMacUpdate(`extract: ok -> ${appPath}`);
  return appPath;
}

/** 起動中の .app バンドルのパス (/Applications/K-PDF3.app)。 */
export function currentAppBundlePath(execPath) {
  // <bundle>.app/Contents/MacOS/<exe>
  const idx = execPath.indexOf(".app/Contents/MacOS/");
  return idx > 0 ? execPath.slice(0, idx + 4) : null;
}

/**
 * 展開済みの新 .app を適用して (必要なら) 再起動する。
 *
 * 起動中の自分自身は上書きできないので、切り離したスクリプトに任せる:
 *   親 PID の終了待ち → 旧 .app を削除 → ditto で新 .app を配置 →
 *   quarantine 属性を除去 → (relaunch なら) open で再起動。
 * 呼び出し側はこの関数のあと **必ずアプリを終了させる** こと (終了しない限り
 * スクリプトは差し替えを中止する — 起動中の .app を壊さないため)。
 */
export async function applyMacUpdate(newApp, { execPath, pid, relaunch = true }) {
  const bundle = currentAppBundlePath(execPath);
  logMacUpdate(`apply: bundle=${bundle} pid=${pid} relaunch=${relaunch}`);
  if (!bundle || !existsSync(bundle)) {
    throw new Error("アプリ本体の場所を特定できませんでした (手動で入れ替えてください)");
  }
  // 書き込み権限が無い場所 (別ユーザー所有の /Applications 等) では、
  // 黙って失敗させず先に明示エラーにする。
  try {
    accessSync(bundle, constants.W_OK);
    accessSync(join(bundle, ".."), constants.W_OK);
  } catch {
    throw new Error(`${bundle} を書き換える権限がありません。K-PDF3 を自分のユーザーが書ける場所に置くか、手動で入れ替えてください`);
  }
  if (!statSync(bundle).isDirectory()) throw new Error("アプリ本体が壊れています");

  if (!newApp || !existsSync(newApp)) {
    throw new Error("展開済みの更新が見つかりません。もう一度ダウンロードしてください");
  }
  const scriptPath = join(newApp, "..", "..", "apply-update.sh");
  // スクリプト側も **全部ログに残す** (アプリはもう終了しているので、
  // ここで無言に失敗すると「何も起きなかった」としか分からない = 今回の事故)。
  // パスは "..." で括り、シェル変数展開に流し込まない。
  const script = `#!/bin/bash
exec >> "${LOG_PATH}" 2>&1
set -x
echo "[apply-update.sh] start $(date -u +%FT%TZ)"
# 親 (K-PDF3) の終了を待つ — **起動中の .app は差し替えてはいけない**
for i in $(seq 1 300); do
  kill -0 ${Number(pid)} 2>/dev/null || break
  sleep 0.2
done
if kill -0 ${Number(pid)} 2>/dev/null; then
  echo "[apply-update.sh] ABORT: K-PDF3 (pid ${Number(pid)}) がまだ終了していないため差し替えを中止"
  exit 1
fi
set -e
rm -rf "${bundle}"
# cp -R は Electron Framework の symlink を壊すので必ず ditto
/usr/bin/ditto "${newApp}" "${bundle}"
/usr/bin/xattr -dr com.apple.quarantine "${bundle}" 2>/dev/null || true
echo "[apply-update.sh] replaced: $(/usr/bin/defaults read "${bundle}/Contents/Info" CFBundleShortVersionString 2>/dev/null)"
${relaunch ? `/usr/bin/open "${bundle}"` : `echo "[apply-update.sh] relaunch skipped (apply-on-quit)"`}
echo "[apply-update.sh] done"
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  const child = spawn("/bin/bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  logMacUpdate(`apply: launched ${scriptPath} (detached pid=${child.pid})`);
  return { bundle, scriptPath };
}
