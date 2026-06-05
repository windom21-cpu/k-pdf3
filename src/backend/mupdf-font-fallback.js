// β.113: mupdf に「フォントが見つからない」局面で呼ばれる load-font
// コールバックを登録し、OS native フォントを返す。Adobe Acrobat は
// 未埋め込みフォントを Windows native (MS ゴシック / Yu Gothic 等) で
// 代替するが、mupdf.js は bundled NotoSansCJK 系で代替するため「中華系
// フォントに見える」問題が出ていた (β.112 ユーザー報告)。
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
import { readFileSync } from "node:fs";

const _bufCache = new Map();   // path|subfont -> Buffer
const _fontCache = new Map();  // path|subfont|name -> Font | null
let _registered = false;

/** 環境別の CJK fallback font 候補。bold 別に Adobe で見える見た目に
 *  最も近いものを選ぶ:
 *
 *   Win: msgothic.ttc (MS ゴシック) = Adobe の和文ゴシック既定代替に相当。
 *        bold は Yu Gothic Bold (msgothic.ttc に専用 bold グリフ無し)。
 *
 *   Linux: Noto Sans CJK JP Regular / Bold (Win 環境想定だが念のため)。
 *
 *   macOS: 後日対応 (一旦 null で mupdf default に委ねる)。 */
function pickFontFile(_script, bold) {
  const platform = process.platform;
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
      try {
        readFileSync(p, { flag: "r" });
        return { path: p, subfont: 0 };
      } catch { /* try next */ }
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
 * mupdf に load-font callback を登録する。複数回呼んでも 1 度だけ有効。 */
export function registerFontFallback() {
  if (_registered) return;
  _registered = true;
  mupdf.installLoadFontFunction((name, script, bold, italic) => {
    const cjk = isCjkRequest(name, script);
    let result = null;
    if (cjk) {
      const isBold = looksBold(name, !!bold);
      const choice = pickFontFile(script, isBold);
      if (choice) result = loadFontCached(choice, name);
    }
    return result;
  });
}
