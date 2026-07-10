// mupdf CJK font fallback の候補選択 (pickFontFile) のテスト。
//
// 2026-07-10 の Mac 対応 (§15.6 積み残し) で入った分岐を固定する:
//   - darwin: MS フォント (Office 由来) があれば優先、無ければヒラギノ。
//     明朝要求 (font name に Mincho/明朝 等) は明朝系へ、bold は W6 へ。
//   - win32 / linux: 従来挙動から 1 バイトも変わらないこと (回帰ガード)。
//   - font-fallback.json のユーザー指定が既定候補より優先されること。
//
// platform と existsFn を注入できるので、どの OS の CI でも全分岐が走る。
// 加えて実行マシンが Mac のときだけ、実在フォントの subfont index が
// mupdf.Font として本当に開けるかを検証する (ttc の中身が OS 更新で
// 変わった事故をここで検知する)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import * as mupdf from "mupdf";
import { pickFontFile, loadFallbackConfig } from "../src/backend/mupdf-font-fallback.js";

const HIRAGINO_GOTHIC_W3 = "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc";
const HIRAGINO_GOTHIC_W6 = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc";
const HIRAGINO_MINCHO = "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc";
const MS_GOTHIC_USER = path.join(homedir(), "Library/Fonts/msgothic.ttc");
const MS_MINCHO_USER = path.join(homedir(), "Library/Fonts/msmincho.ttc");

const existsAll = () => true;
const existsNone = () => false;
const existsOnly = (...paths) => (p) => paths.includes(p);

test("darwin: MS フォントがあれば最優先 (ゴシック/明朝を name で区別)", () => {
  const g = pickFontFile("Jpan", false, "MS-Gothic", "darwin", existsAll);
  assert.equal(g.path, MS_GOTHIC_USER);
  const m = pickFontFile("Jpan", false, "MS-Mincho", "darwin", existsAll);
  assert.equal(m.path, MS_MINCHO_USER);
  // script タグだけで name に明朝の手掛かりが無ければゴシック側
  const s = pickFontFile("Jpan", false, "SomeUnknownFont", "darwin", existsAll);
  assert.equal(s.path, MS_GOTHIC_USER);
});

test("darwin: MS フォントが無ければヒラギノ (W3/W6, 明朝 ProN)", () => {
  const hira = existsOnly(HIRAGINO_GOTHIC_W3, HIRAGINO_GOTHIC_W6, HIRAGINO_MINCHO);
  assert.deepEqual(pickFontFile("Jpan", false, "MS-Gothic", "darwin", hira),
    { path: HIRAGINO_GOTHIC_W3, subfont: 0 });
  assert.deepEqual(pickFontFile("Jpan", true, "MS-Gothic,Bold", "darwin", hira),
    { path: HIRAGINO_GOTHIC_W6, subfont: 0 });
  assert.deepEqual(pickFontFile("Jpan", false, "MS-Mincho", "darwin", hira),
    { path: HIRAGINO_MINCHO, subfont: 0 });
  // 明朝 bold は同 ttc の W6 face (subfont 2)
  assert.deepEqual(pickFontFile("Jpan", true, "MS-Mincho,Bold", "darwin", hira),
    { path: HIRAGINO_MINCHO, subfont: 2 });
});

test("darwin: bold は MS フォントを skip (bold グリフが無い)", () => {
  const c = pickFontFile("Jpan", true, "MS-Gothic,Bold", "darwin", existsAll);
  assert.equal(c.path, HIRAGINO_GOTHIC_W6);
});

test("darwin: 明朝判定のバリエーション (HeiseiMin / 小塚 / リュウミン)", () => {
  const hira = existsOnly(HIRAGINO_GOTHIC_W3, HIRAGINO_GOTHIC_W6, HIRAGINO_MINCHO);
  for (const name of ["HeiseiMin-W3", "KozMinPr6N-Regular", "Ryumin-Light", "游明朝"]) {
    assert.equal(pickFontFile("Jpan", false, name, "darwin", hira).path, HIRAGINO_MINCHO, name);
  }
});

test("darwin: 候補が全滅なら null (mupdf default に委ねる)", () => {
  assert.equal(pickFontFile("Jpan", false, "MS-Gothic", "darwin", existsNone), null);
});

test("win32: 従来挙動そのまま (明朝要求でもゴシック / bold は YuGothB)", () => {
  assert.deepEqual(pickFontFile("Jpan", false, "MS-Mincho", "win32", existsNone),
    { path: "C:\\Windows\\Fonts\\msgothic.ttc", subfont: 0 });
  assert.deepEqual(pickFontFile("Jpan", true, "MS-Gothic,Bold", "win32", existsNone),
    { path: "C:\\Windows\\Fonts\\YuGothB.ttc", subfont: 0 });
});

test("linux: 従来挙動そのまま (Noto Sans CJK)", () => {
  const noto = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
  assert.deepEqual(pickFontFile("Jpan", false, "MS-Mincho", "linux", existsOnly(noto)),
    { path: noto, subfont: 0 });
  assert.equal(pickFontFile("Jpan", false, "MS-Gothic", "linux", existsNone), null);
});

test("font-fallback.json のユーザー指定が既定候補より優先される", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kpdf3-font-"));
  const cfg = path.join(dir, "font-fallback.json");
  try {
    writeFileSync(cfg, JSON.stringify({
      gothic: "/custom/gothic.ttc",
      mincho: { path: "/custom/mincho.ttc", subfont: 1 },
    }));
    loadFallbackConfig(cfg);
    // 指定 path が実在するとき: 全 OS で override が勝つ
    assert.deepEqual(pickFontFile("Jpan", false, "MS-Gothic", "darwin", existsAll),
      { path: "/custom/gothic.ttc", subfont: 0 });
    assert.deepEqual(pickFontFile("Jpan", false, "MS-Mincho", "win32", existsAll),
      { path: "/custom/mincho.ttc", subfont: 1 });
    // 指定 path が実在しないとき: 既定候補へフォールバック
    const hira = existsOnly(HIRAGINO_GOTHIC_W3);
    assert.deepEqual(pickFontFile("Jpan", false, "MS-Gothic", "darwin", hira),
      { path: HIRAGINO_GOTHIC_W3, subfont: 0 });
    // 未指定キー (gothicBold) は override 対象外
    assert.equal(pickFontFile("Jpan", true, "MS-Gothic,Bold", "darwin", existsNone), null);
  } finally {
    loadFallbackConfig(null); // 後続テストへ設定を漏らさない
    rmSync(dir, { recursive: true, force: true });
  }
});

test("壊れた font-fallback.json は warn のみで既定挙動を維持", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kpdf3-font-"));
  const cfg = path.join(dir, "font-fallback.json");
  try {
    writeFileSync(cfg, "{ not json");
    loadFallbackConfig(cfg);
    assert.deepEqual(pickFontFile("Jpan", false, "MS-Gothic", "win32", existsNone),
      { path: "C:\\Windows\\Fonts\\msgothic.ttc", subfont: 0 });
  } finally {
    loadFallbackConfig(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

// 実行マシンが Mac のときだけ: 実在フォントが宣言した subfont index で
// mupdf.Font として開けることを実証 (OS 更新で ttc の face 順が変わる
// 事故の検知)。他 OS ではファイルが無いので skip。
test("darwin 実機: 候補フォントが mupdf.Font として開ける", { skip: process.platform !== "darwin" }, () => {
  const cases = [
    pickFontFile("Jpan", false, "MS-Gothic"),
    pickFontFile("Jpan", true, "MS-Gothic,Bold"),
    pickFontFile("Jpan", false, "MS-Mincho"),
    pickFontFile("Jpan", true, "MS-Mincho,Bold"),
  ];
  for (const c of cases) {
    assert.ok(c, "候補が null (ヒラギノすら見つからない Mac は想定外)");
    assert.ok(existsSync(c.path), c.path);
    const f = new mupdf.Font("test", readFileSync(c.path), c.subfont ?? 0);
    assert.ok(f.getName(), `${c.path}#${c.subfont} → ${f.getName()}`);
  }
});
