// 2026-07-14: macOS アプリ内更新 (updater-mac.js) の pure 関数テスト。
//
// Squirrel.Mac はコード署名必須で使えないため自前実装した層。
// 実 I/O (ダウンロード / ditto / 再起動) は Mac 実機で確認する。ここでは
// 「どの版に上げるか」「どのファイルを掴むか」の判断部分を固定する
// — ここを間違えると β を掴む / 古い版に下げる / dmg を zip と誤認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLatestMacYml,
  compareVersions,
  isNewerVersion,
  currentAppBundlePath,
} from "../src/main/updater-mac.js";

const YML = `version: 2.0.14
files:
  - url: K-PDF3-2.0.14-arm64-mac.zip
    sha512: Zm9vYmFyc2hhNTEy
    size: 104857600
  - url: K-PDF3-2.0.14-arm64.dmg
    sha512: ZG1nc2hhNTEy
    size: 109051904
path: K-PDF3-2.0.14-arm64-mac.zip
sha512: Zm9vYmFyc2hhNTEy
releaseDate: '2026-07-14T09:00:00.000Z'
`;

test("parseLatestMacYml: version と **zip** のファイル名/sha512/size を取る", () => {
  assert.deepEqual(parseLatestMacYml(YML), {
    version: "2.0.14",
    fileName: "K-PDF3-2.0.14-arm64-mac.zip",
    sha512: "Zm9vYmFyc2hhNTEy",
    size: 104857600,
  });
});

test("parseLatestMacYml: zip が無いリリース (dmg のみ) は null — 掴んで失敗し続けない", () => {
  const dmgOnly = `version: 2.0.13
files:
  - url: K-PDF3-2.0.13-arm64.dmg
    sha512: ZG1nc2hhNTEy
    size: 109051904
path: K-PDF3-2.0.13-arm64.dmg
`;
  assert.equal(parseLatestMacYml(dmgOnly), null);
});

test("parseLatestMacYml: 壊れた入力は null", () => {
  assert.equal(parseLatestMacYml(""), null);
  assert.equal(parseLatestMacYml("not yaml at all"), null);
  assert.equal(parseLatestMacYml(null), null);
});

test("compareVersions: 数値として比べる (2.0.9 < 2.0.10)", () => {
  assert.equal(compareVersions("2.0.10", "2.0.9"), 1);
  assert.equal(compareVersions("2.0.9", "2.0.10"), -1);
  assert.equal(compareVersions("2.0.14", "2.0.14"), 0);
  assert.equal(compareVersions("2.1.0", "2.0.99"), 1);
});

test("compareVersions: stable は同じ番号の beta に勝つ", () => {
  assert.equal(compareVersions("2.0.14", "2.0.14-beta.4"), 1);
  assert.equal(compareVersions("2.0.14-beta.4", "2.0.14"), -1);
  assert.equal(compareVersions("2.0.14-beta.10", "2.0.14-beta.9"), 1);
});

test("isNewerVersion: 新しいときだけ true (下げない)", () => {
  assert.equal(isNewerVersion("2.0.14", "2.0.13"), true);
  assert.equal(isNewerVersion("2.0.13", "2.0.14"), false, "ダウングレードしない");
  assert.equal(isNewerVersion("2.0.14", "2.0.14"), false, "同版では更新を出さない");
  // Mac に手動で入れたローカル β の方が配布 stable より新しいケース
  assert.equal(isNewerVersion("2.0.14", "2.0.15-beta.1"), false);
});

test("currentAppBundlePath: 実行ファイルから .app バンドルを割り出す", () => {
  assert.equal(
    currentAppBundlePath("/Applications/K-PDF3.app/Contents/MacOS/K-PDF3"),
    "/Applications/K-PDF3.app",
  );
  assert.equal(
    currentAppBundlePath("/Users/me/Desktop/K-PDF3.app/Contents/MacOS/K-PDF3"),
    "/Users/me/Desktop/K-PDF3.app",
  );
  assert.equal(
    currentAppBundlePath("/usr/local/bin/kpdf3"), null,
    ".app 配下でなければ null (自動入れ替えせず明示エラーにする)",
  );
});
