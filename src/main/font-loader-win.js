// ζ Phase 1 (β63): Win 用システム日本語フォント探索 + TTF embed
// 検査 + pdf-lib 用 bytes 提供。
//
// 設計原則:
// - **アプリにフォントは持ち運ばない**。runtime で C:\Windows\Fonts\
//   から TTF を読むだけ。Adobe Reader / Microsoft Word と同じ動作。
// - fsType (OS/2 table) を読んで PDF subset embed 可否を判定。
//   2 (Restricted) は法的に embed 不可なので skip → 上位は raster 経路
//   へ fallback。0/4/8 は embed OK。
// - TTC (Font Collection) は β63 では非対応。Yu Mincho/Gothic は新しい
//   Win では TTF 形式で提供されているのでこれを優先。MS Mincho の TTC
//   対応 + Mac の Hiragino TTC 対応は β66 で予定。
// - TTF が見つからない場合は null を返し、上位は β62 raster 経路で
//   出力する。回帰しない。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WIN_FONTS_DIR = "C:\\Windows\\Fonts";

// 一度発見した font の場所 + bytes を cache (起動毎に再探索しない)。
// key = logical name ("mincho" | "gothic")、value = { path, bytes, fsType }。
const _cache = new Map();

/** TTF Offset Table から特定 table の (offset, length) を見つける。
 *  TTC でない通常 TTF 用。
 *  @param {Buffer} data
 *  @param {string} wantTag  4 byte ASCII tag ("OS/2", "name" 等)
 *  @returns {{offset:number,length:number}|null} */
function findTtfTable(data, wantTag) {
  if (data.length < 12) return null;
  // sfntVersion(4) は 0x00010000 (TrueType) or "OTTO" (CFF/OTF)
  // 本関数では特に判別不要、numTables から table records を読む
  const numTables = data.readUInt16BE(4);
  if (numTables === 0 || numTables > 64) return null;
  const recordsStart = 12;
  for (let i = 0; i < numTables; i++) {
    const off = recordsStart + i * 16;
    if (off + 16 > data.length) return null;
    const tag = data.toString("ascii", off, off + 4);
    if (tag === wantTag) {
      const offset = data.readUInt32BE(off + 8);
      const length = data.readUInt32BE(off + 12);
      return { offset, length };
    }
  }
  return null;
}

/** TTF bytes の OS/2 table から fsType を読む。
 *  OS/2 table layout (Microsoft TT spec):
 *    version          uint16    @ offset 0
 *    xAvgCharWidth    int16     @ offset 2
 *    usWeightClass    uint16    @ offset 4
 *    usWidthClass     uint16    @ offset 6
 *    fsType           uint16    @ offset 8  ← これ
 *  @param {Buffer} data
 *  @returns {number|null}  fsType 値 (0/2/4/8/...) または読めなければ null */
function readFsType(data) {
  const os2 = findTtfTable(data, "OS/2");
  if (!os2) return null;
  if (os2.offset + 10 > data.length) return null;
  return data.readUInt16BE(os2.offset + 8);
}

/** fsType が PDF subset embed を許諾するかの判定。
 *  - 2 (Restricted) → false (法的に不可)
 *  - 0 (Installable) / 4 (Preview & Print) / 8 (Editable) → true
 *  - 上位ビットには「サブセット可否」「ビットマップのみ」等があるが、
 *    法律実務の通常書類では Preview & Print 用途のみで十分なので、
 *    Restricted 以外を許諾扱いにする。 */
function fsTypeAllowsEmbed(fsType) {
  if (typeof fsType !== "number") return false;
  // 下位 4 ビットだけ評価 (上位は subset / bitmap only flags)
  const usage = fsType & 0x000F;
  // 2 = Restricted (NG)、それ以外 (0/4/8) はすべて embed OK
  return usage !== 2;
}

/** ファイル名パターンから「明朝らしい」か判定する。 */
function isMinchoFontFile(name) {
  return /yumin|mincho|min(?!ute)/i.test(name);
}
function isGothicFontFile(name) {
  return /yugot|gothic|gothi/i.test(name);
}

/** Win 標準フォントディレクトリで TTF を走査し、与えられた判定関数
 *  に合致する最初のファイルを返す (fsType 検査 + 読み込み込み)。 */
function findFirstTtfBy(matchFn) {
  if (!existsSync(WIN_FONTS_DIR)) return null;
  let entries;
  try {
    entries = readdirSync(WIN_FONTS_DIR);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/\.ttf$/i.test(name)) continue;
    if (!matchFn(name)) continue;
    const path = join(WIN_FONTS_DIR, name);
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size < 1024 || st.size > 100 * 1024 * 1024) continue;
      const bytes = readFileSync(path);
      const fsType = readFsType(bytes);
      if (!fsTypeAllowsEmbed(fsType)) continue;
      return { path, bytes, fsType };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 指定 logical name (mincho/gothic) に対する TTF bytes を返す。
 * 見つからない / fsType 不許諾 / 読み取り失敗 時は null。
 *
 * @param {"mincho"|"gothic"} logicalName
 * @returns {{path:string,bytes:Buffer,fsType:number}|null}
 */
export function loadSystemJapaneseTtf(logicalName) {
  if (process.platform !== "win32") return null;
  if (_cache.has(logicalName)) return _cache.get(logicalName);

  let matchFn = null;
  if (logicalName === "mincho") matchFn = isMinchoFontFile;
  else if (logicalName === "gothic") matchFn = isGothicFontFile;
  else return null;

  const found = findFirstTtfBy(matchFn);
  _cache.set(logicalName, found); // null も cache (再探索回避)
  return found;
}

/** デバッグ用: 発見状況を報告 (起動時 logCrash に使う想定)。 */
export function reportFontLoaderState() {
  const out = {};
  for (const name of ["mincho", "gothic"]) {
    const found = loadSystemJapaneseTtf(name);
    out[name] = found
      ? { path: found.path, bytes: found.bytes.length, fsType: found.fsType }
      : null;
  }
  return out;
}
