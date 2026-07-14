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
import { createWriteStream, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, statSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get as httpsGet } from "node:https";

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
  const yml = await fetchText(YML_URL);
  const info = parseLatestMacYml(yml);
  if (!info) throw new Error("latest-mac.yml を解釈できませんでした (zip 未公開の可能性)");
  if (!isNewerVersion(info.version, currentVersion)) return { available: false, version: info.version };
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
          cleanup();
          reject(new Error("ダウンロードした更新ファイルの検証に失敗しました (sha512 不一致)"));
          return;
        }
        resolve(dest);
      });
      out.on("error", (err) => { cleanup(); reject(err); });
    }, (err) => { cleanup(); reject(err); });
  });
}

function _run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`))));
  });
}

/** zip の中の .app を取り出して、展開先の .app パスを返す。 */
async function extractApp(zipPath) {
  const dir = join(zipPath, "..", "extracted");
  // cp -R ではなく ditto (Electron Framework の symlink を保つ)。
  await _run("/usr/bin/ditto", ["-x", "-k", zipPath, dir]);
  const app = readdirSync(dir).find((n) => n.endsWith(".app"));
  if (!app) throw new Error("更新ファイルの中に .app が見つかりません");
  return join(dir, app);
}

/** 起動中の .app バンドルのパス (/Applications/K-PDF3.app)。 */
export function currentAppBundlePath(execPath) {
  // <bundle>.app/Contents/MacOS/<exe>
  const idx = execPath.indexOf(".app/Contents/MacOS/");
  return idx > 0 ? execPath.slice(0, idx + 4) : null;
}

/**
 * ダウンロード済み zip を適用して再起動する。
 *
 * 起動中の自分自身は上書きできないので、切り離したスクリプトに任せる:
 *   親 PID の終了待ち → 旧 .app を削除 → ditto で新 .app を配置 →
 *   quarantine 属性を除去 → open で再起動。
 * 呼び出し側はこの関数のあと **すぐに app.quit()** すること。
 */
export async function applyMacUpdate(zipPath, { execPath, pid }) {
  const bundle = currentAppBundlePath(execPath);
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

  const newApp = await extractApp(zipPath);
  const scriptPath = join(zipPath, "..", "apply-update.sh");
  // shell 変数展開に流し込まない (パスは "..." で括り、内部で $ を使わない)。
  const script = `#!/bin/bash
set -e
# 親 (K-PDF3) の終了を待つ — 起動中の .app は差し替えられない
for i in $(seq 1 100); do
  kill -0 ${Number(pid)} 2>/dev/null || break
  sleep 0.2
done
rm -rf "${bundle}"
# cp -R は Electron Framework の symlink を壊すので必ず ditto
/usr/bin/ditto "${newApp}" "${bundle}"
/usr/bin/xattr -dr com.apple.quarantine "${bundle}" 2>/dev/null || true
/usr/bin/open "${bundle}"
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  const child = spawn("/bin/bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { bundle };
}
