// β.113: mupdf に「フォントが見つからない」局面で呼ばれる load-font
// コールバックを登録し、OS native フォントを返す。Adobe Acrobat は
// 未埋め込みフォントを Windows native (MS ゴシック / Yu Gothic 等) で
// 代替するが、mupdf.js は bundled NotoSansCJK 系で代替するため「中華系
// フォントに見える」問題が出ていた (β.112 ユーザー報告)。
// 2026-07-10: Mac 対応 (§15.6 の積み残し) — MS フォント (Office 由来等)
// があれば優先、無ければヒラギノ。Mac のみ明朝/ゴシックを name から
// 区別。あわせて userData/font-fallback.json による指定を全 OS で追加
// (ファイル無しなら従来挙動と完全一致)。
//
// 実装方針:
//   - mupdf.installLoadFontFunction((name, script, bold, italic) => Font | null)
//     を 1 度だけ登録 (シングルトン、再登録は no-op)
//   - 判定は script タグ (Han/Hira/Kana/Jpan/Hang/Bopo/Hrkt) **か** font name
//     (MS-Gothic / MS-Mincho / HeiseiKakuGo / Adobe-Japan1 等) のいずれか
//     で CJK と確定 → OS native を返す。Adobe プロパティ調査で「name=MS-Gothic,
//     encoding=90ms-RKSJ-H, CID font」のケースが script タグだけだと
//     拾えない懸念があったため、name 側も併用する保険
//   - bold は引数 bold OR font name 末尾の ",Bold" / "Bold" で拾う
//   - フォント file は readFileSync で 1 度読んで Buffer をキャッシュ
//     (load-font callback は内部 C 側からの同期呼出、await 不可)
//
// 副作用: PDF ファイル自体には一切書き込まない (= K-PDF3 の「PDF は
// immutable background」原則を維持)。pixmap 描画の見た目だけが変わる。

import * as mupdf from "mupdf";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const _bufCache = new Map();   // path|subfont -> Buffer
const _fontCache = new Map();  // path|subfont|name -> Font | null
let _registered = false;

// ユーザー指定の fallback フォント (userData/font-fallback.json)。
// キー: gothic / gothicBold / mincho / minchoBold。値は path 文字列か
// { path, subfont }。存在するキーだけ既定候補より優先される。
// ファイルが無ければ全 OS で従来挙動と 1 バイトも変わらない。
let _configChoices = null;

function _normalizeConfigEntry(v) {
  if (!v) return null;
  if (typeof v === "string") return { path: v, subfont: 0 };
  if (typeof v.path === "string") {
    return { path: v.path, subfont: Number.isInteger(v.subfont) ? v.subfont : 0 };
  }
  return null;
}

/** font-fallback.json を読む (無ければ黙って no-op、壊れていれば warn)。 */
export function loadFallbackConfig(configPath) {
  _configChoices = null;
  if (!configPath) return;
  let raw;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch { return; /* ファイル無し = 既定候補のみ */ }
  try {
    const json = JSON.parse(raw);
    const out = {};
    for (const key of ["gothic", "gothicBold", "mincho", "minchoBold"]) {
      const e = _normalizeConfigEntry(json[key]);
      if (e) out[key] = e;
    }
    if (Object.keys(out).length > 0) _configChoices = out;
  } catch (err) {
    console.warn("[mupdf-font-fallback] config parse failed:", configPath, err?.message ?? err);
  }
}

/** font name から明朝系の要求かを判定 (mupdf callback に serif 情報は
 *  来ないので name が唯一の手掛かり。Ryumin=モリサワ リュウミン)。 */
function wantsMincho(name) {
  return /(mincho|明朝|heiseimin|kozmin|ryumin)/i.test(String(name ?? ""));
}

// macOS: MS フォントは OS 標準では入っていないが、MS Office for Mac や
// 手動コピーで入っている環境では Adobe と同じ見た目になるので最優先。
// bold は MS ゴシック/明朝に bold グリフが無いため skip (Win 経路が
// YuGothB に逃がすのと同じ理屈で、ヒラギノ W6 に逃がす)。
const _MAC_MS_FONT_DIRS = [
  path.join(homedir(), "Library/Fonts"),
  "/Library/Fonts",
  "/Library/Fonts/Microsoft",
];

// ヒラギノ明朝 ProN.ttc の subfont: 0=HiraMinProN-W3, 2=HiraMinProN-W6
// (1/3 は Pro 系)。角ゴシックは weight 別 ttc で subfont 0 が ProN 相当。
function _macCandidates(mincho, bold) {
  const list = [];
  if (!bold) {
    const file = mincho ? "msmincho.ttc" : "msgothic.ttc";
    for (const d of _MAC_MS_FONT_DIRS) list.push({ path: path.join(d, file), subfont: 0 });
  }
  if (mincho) {
    list.push({ path: "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc", subfont: bold ? 2 : 0 });
    // 明朝 ttc が無い環境の最終保険 (ゴシックだが CJK グリフは出る)
    list.push({ path: `/System/Library/Fonts/ヒラギノ角ゴシック ${bold ? "W6" : "W3"}.ttc`, subfont: 0 });
  } else {
    list.push({ path: `/System/Library/Fonts/ヒラギノ角ゴシック ${bold ? "W6" : "W3"}.ttc`, subfont: 0 });
  }
  return list;
}

/** 環境別の CJK fallback font 候補。bold 別に Adobe で見える見た目に
 *  最も近いものを選ぶ:
 *
 *   Win: msgothic.ttc (MS ゴシック) = Adobe の和文ゴシック既定代替に相当。
 *        bold は Yu Gothic Bold (msgothic.ttc に専用 bold グリフ無し)。
 *
 *   Linux: Noto Sans CJK JP Regular / Bold (Win 環境想定だが念のため)。
 *
 *   macOS: MS ゴシック/明朝が入っていれば優先、無ければヒラギノ
 *          (角ゴシック W3/W6・明朝 ProN W3/W6)。Mac だけ明朝要求を
 *          name から区別する (Win/Linux は従来通り常にゴシック系)。
 *
 *  platform / existsFn はテスト注入用 (通常呼出では省略)。 */
export function pickFontFile(_script, bold, name, platform = process.platform, existsFn = existsSync) {
  const mincho = wantsMincho(name);
  const override = _configChoices?.[(mincho ? "mincho" : "gothic") + (bold ? "Bold" : "")];
  if (override && existsFn(override.path)) return override;
  if (platform === "win32") {
    if (bold) {
      return { path: "C:\\Windows\\Fonts\\YuGothB.ttc", subfont: 0 };
    }
    return { path: "C:\\Windows\\Fonts\\msgothic.ttc", subfont: 0 };
  }
  if (platform === "linux") {
    const candidates = bold
      ? ["/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"]
      : ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"];
    for (const p of candidates) {
      if (existsFn(p)) return { path: p, subfont: 0 };
    }
    return null;
  }
  if (platform === "darwin") {
    for (const c of _macCandidates(mincho, bold)) {
      if (existsFn(c.path)) return c;
    }
    return null;
  }
  return null;
}

/** script タグ (ISO 15924) もしくは font name から CJK と判定。
 *  Adobe の文書プロパティ調査 (β.113 ユーザー報告) で MS-Gothic /
 *  MS-Mincho / HeiseiKakuGo-W5 等の CID font が頻出することが判明 →
 *  name ベース判定を保険として併用。 */
function isCjkRequest(name, script) {
  if (script && /^(Han|Hira|Kana|Hang|Bopo|Hrkt|Jpan|Kore|Hans|Hant)$/i.test(String(script))) {
    return true;
  }
  if (name && /(Gothic|Mincho|HeiseiKakuGo|HeiseiMin|MS-Gothic|MS-Mincho|YuGothic|YuMincho|Adobe-Japan|Adobe-CNS|Adobe-GB|Adobe-Korea|Kozuka|小塚)/i.test(String(name))) {
    return true;
  }
  return false;
}

/** font name (例: "MS-Gothic,Bold") に Bold 指示が含まれるか。
 *  installLoadFontFunction の bold 引数だけでは Adobe-Japan1 CID font の
 *  「Bold 単独宣言」が漏れることがあるので name 側でも拾う保険。 */
function looksBold(name, bold) {
  if (bold) return true;
  if (name && /(,|-|\s|_)Bold|Bold$|BoldItalic/i.test(String(name))) return true;
  return false;
}

function loadFontCached(choice, name) {
  const key = `${choice.path}|${choice.subfont ?? 0}|${name}`;
  if (_fontCache.has(key)) return _fontCache.get(key);
  try {
    const bufKey = `${choice.path}|${choice.subfont ?? 0}`;
    let data = _bufCache.get(bufKey);
    if (!data) {
      data = readFileSync(choice.path);
      _bufCache.set(bufKey, data);
    }
    const f = new mupdf.Font(name, data, choice.subfont ?? 0);
    _fontCache.set(key, f);
    return f;
  } catch (err) {
    console.warn("[mupdf-font-fallback] load failed:", choice.path, err?.message ?? err);
    _fontCache.set(key, null);
    return null;
  }
}

/**
 * mupdf に load-font callback を登録する。複数回呼んでも 1 度だけ有効。
 * opts.configPath: ユーザー指定 fallback (font-fallback.json) のパス。 */
export function registerFontFallback(opts = {}) {
  if (_registered) return;
  _registered = true;
  loadFallbackConfig(opts.configPath);
  mupdf.installLoadFontFunction((name, script, bold, italic) => {
    const cjk = isCjkRequest(name, script);
    let result = null;
    if (cjk) {
      const isBold = looksBold(name, !!bold);
      const choice = pickFontFile(script, isBold, name);
      if (choice) result = loadFontCached(choice, name);
    }
    return result;
  });
}
