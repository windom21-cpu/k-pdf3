// ベクターテキスト層 (v2.0.13): text / form_field(text) overlay を 900dpi
// ラスタ PNG ではなく「MS 明朝サブセット埋め込みの実テキスト」として
// 組み立て済み PDF に焼き込む。
//
// 背景 (2026-07-06 実機検証 `spike/print-density-sheet.mjs`):
//   テキストをグレースケール AA ラスタで印刷する限り、(a) AA 縁のハーフ
//   トーン網点化、(b) 900→600dpi 非整数リサンプリング、(c) 明朝横画が
//   900dpi で 2〜3px しかなく線全体がエッジ化する、の 3 点で Word より
//   薄く出る。β31 900dpi 化 / β76 hairline stroke / β.140-141 fillText
//   4 回打ちはこのアプローチの理論上限で、実機シートで「ベクター埋め込み
//   = Word と同一濃度」を確認したため経路ごと切替える。
//   ※ β63 ζ (font embed) の C2360 撤回は旧・自前印刷経路の制約。β64 で
//     Adobe Reader へ印刷委譲した現行構造では、embedded CID TrueType を
//     含む検証シートが実機 C2360 系で Word 同等に刷れることを確認済み。
//
// 設計:
//   - renderer (exporter.js) が canvas 採寸で行分割・整列まで済ませ、
//     「1 行 = 1 op」(text / baseline 座標 / size / color / bold / rot) を
//     pages[].vectorTexts として送る。本モジュールは再レイアウトしない
//     (画面と紙の行分割が絶対に一致することを優先)。
//   - 座標系: op.x / op.y は canonical (post-effRot, top-left 原点) pt の
//     ベースライン左端。assembleHybridPdf の出力ページは canonical
//     /Rotate=0 に正規化される (回転ページは _placeRotatedSourcePage が
//     ベイク) ので、変換は Y 反転のみで全戦略・全回転共通 (overlay PNG の
//     bbox 配置と同じ数式)。既知の例外: sourceRot+userRot が打ち消し
//     合って effRot=0 になるページ (例 /Rotate=180 を更に 180 回転) は
//     verbatim copy で /Rotate が残る — これは overlay PNG 配置も同じ
//     前提を置く既存挙動で、本テキスト層は PNG と常に同座標系 (parity)。
//   - フォント: Windows 同梱 msmincho.ttc subfont 0 (= MS 明朝、fsType=8
//     編集可能埋め込み許可)。mupdf の addFont = pdf_add_cid_font で
//     Identity-H / CIDToGIDMap=Identity 埋め込み → コンテンツは glyph id
//     直書きの hex 文字列。サブセット化は「隔離した scratch PDF で mupdf
//     subsetFonts() を回して FontFile2 を抜き出す」方式 (gid 番号は維持
//     される)。元 PDF 側のフォントには一切触れない。
//   - フォント無し環境 (Mac/Linux) やグリフ欠落は、renderer が事前に
//     probeVectorText で判定して従来ラスタへフォールバックする。ここに
//     到達した ops は「必ず描ける」前提で、失敗は例外 = 書き出し/印刷ごと
//     失敗させる (サイレントな文字消失を絶対に起こさないため)。

import * as mupdf from "mupdf";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** @typedef {{ text: string, x: number, y: number, size: number,
 *              color?: string, bold?: boolean, rot?: 0|90|180|270 }} VectorTextOp */

// ---------------------------------------------------------------------------
// フォント発見 / 読み込み
// ---------------------------------------------------------------------------

/** MS 明朝 (msmincho.ttc) の探索候補。本番 = Windows、後者は WSL 開発/テスト用。 */
export function resolveMinchoFontPath() {
  const candidates = [
    join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "msmincho.ttc"),
    "/mnt/c/Windows/Fonts/msmincho.ttc",
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // 継続 — 次の候補へ
    }
  }
  return null;
}

/**
 * TTC → 単体 TTF 抽出 (subfont 0 = MS 明朝)。
 *
 * FontFile2 に TTC をそのまま入れるのは PDF 仕様外で、Acrobat が代替
 * フォントへ落とす恐れがあるため、subfont のテーブルを素の sfnt に
 * 組み直す。テーブル本体は無改変 = per-table checksum は元の値を流用し、
 * head.checkSumAdjustment だけ再計算する。
 *
 * @param {Buffer} buf  .ttc ファイル全体
 * @param {number} subfontIndex
 * @returns {Buffer} 単体 TTF
 */
export function extractTtfFromTtc(buf, subfontIndex = 0) {
  if (buf.toString("ascii", 0, 4) !== "ttcf") {
    // 既に単体 TTF (テスト等で直接渡された場合) はそのまま
    return buf;
  }
  const numFonts = buf.readUInt32BE(8);
  if (subfontIndex >= numFonts) {
    throw new Error(`extractTtfFromTtc: subfont ${subfontIndex} not in TTC (numFonts=${numFonts})`);
  }
  const off = buf.readUInt32BE(12 + subfontIndex * 4);
  const numTables = buf.readUInt16BE(off + 4);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const rec = off + 12 + i * 16;
    tables.push({
      tag: buf.toString("ascii", rec, rec + 4),
      checksum: buf.readUInt32BE(rec + 4),
      offset: buf.readUInt32BE(rec + 8),
      length: buf.readUInt32BE(rec + 12),
    });
  }
  const headerSize = 12 + numTables * 16;
  let dataSize = 0;
  for (const t of tables) dataSize += (t.length + 3) & ~3;
  const out = Buffer.alloc(headerSize + dataSize);
  buf.copy(out, 0, off, off + 12); // sfnt version + numTables + search fields
  let cursor = headerSize;
  let headOut = -1;
  tables.forEach((t, i) => {
    const rec = 12 + i * 16;
    out.write(t.tag, rec, "ascii");
    out.writeUInt32BE(t.checksum, rec + 4);
    out.writeUInt32BE(cursor, rec + 8);
    out.writeUInt32BE(t.length, rec + 12);
    buf.copy(out, cursor, t.offset, t.offset + t.length);
    if (t.tag === "head") headOut = cursor;
    cursor += (t.length + 3) & ~3;
  });
  if (headOut < 0) throw new Error("extractTtfFromTtc: no head table");
  out.writeUInt32BE(0, headOut + 8);
  let sum = 0;
  for (let i = 0; i < out.length; i += 4) sum = (sum + out.readUInt32BE(i)) >>> 0;
  out.writeUInt32BE((0xb1b0afba - sum) >>> 0, headOut + 8);
  return out;
}

// フォントは 1 プロセスにつき 1 回だけ読む (path+mtime でキャッシュ)。
// mupdf.Font はエンコード専用 (embed には都度サブセットを作る)。
let _fontCache = null; // { path, mtimeMs, ttf: Buffer, font: mupdf.Font, gidMap: Map }

function loadMinchoFont(fontPath) {
  const p = fontPath ?? resolveMinchoFontPath();
  if (!p) return null;
  const mtimeMs = statSync(p).mtimeMs;
  if (_fontCache && _fontCache.path === p && _fontCache.mtimeMs === mtimeMs) {
    return _fontCache;
  }
  const ttf = extractTtfFromTtc(readFileSync(p), 0);
  const font = new mupdf.Font("MS-Mincho", ttf);
  _fontCache = { path: p, mtimeMs, ttf, font, gidMap: new Map() };
  return _fontCache;
}

/** codepoint → glyph id (キャッシュ付き)。0 = グリフ欠落。 */
function gidOf(cache, cp) {
  let gid = cache.gidMap.get(cp);
  if (gid === undefined) {
    gid = cache.font.encodeCharacter(cp);
    cache.gidMap.set(cp, gid);
  }
  return gid;
}

// ---------------------------------------------------------------------------
// probe: renderer が「この文字列群はベクター化できるか」を事前判定する
// ---------------------------------------------------------------------------

/**
 * @param {string[]} strings  ベクター化候補の全テキスト
 * @param {{ fontPath?: string }} [opts]
 * @returns {{ available: boolean, missing: string[] }}
 *   available=false → フォント自体が無い (Mac/Linux 等)。missing は
 *   グリフの無い文字の一覧 (これを含む overlay だけラスタへ落とす)。
 */
export function probeVectorText(strings, opts = {}) {
  let cache;
  try {
    cache = loadMinchoFont(opts.fontPath);
  } catch (err) {
    console.warn("[vector-text] font load failed — falling back to raster:", err?.message);
    return { available: false, missing: [] };
  }
  if (!cache) return { available: false, missing: [] };
  const missing = new Set();
  for (const s of Array.isArray(strings) ? strings : []) {
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      if (ch === "\n") continue;
      if (gidOf(cache, cp) === 0) missing.add(ch);
    }
  }
  return { available: true, missing: [...missing] };
}

// ---------------------------------------------------------------------------
// サブセット: 隔離 scratch PDF で mupdf subsetFonts() を回し FontFile2 を抜く
// ---------------------------------------------------------------------------

/**
 * 使用 gid だけを残したサブセット TTF を作る。mupdf の subsetFonts は
 * glyph id の番号を維持したまま未使用グリフを空にする方式なので、
 * フル TTF でエンコードした gid をそのままサブセット埋め込みにも使える。
 * 失敗したらフル TTF を返す (サイズは増えるが出力は正しい)。
 *
 * @param {Buffer} ttf
 * @param {number[]} gids
 * @returns {Buffer|Uint8Array}
 */
export function buildSubsetTtf(ttf, gids) {
  let scratch = null;
  try {
    scratch = new mupdf.PDFDocument();
    const font = new mupdf.Font("MS-Mincho", ttf);
    const ref = scratch.addFont(font);
    const hex = gids.map((g) => g.toString(16).padStart(4, "0")).join("");
    const page = scratch.addPage(
      [0, 0, 100, 100], 0, { Font: { F0: ref } },
      `BT /F0 10 Tf <${hex}> Tj ET`,
    );
    scratch.insertPage(-1, page);
    scratch.subsetFonts();
    const ff = scratch
      .findPage(0)
      .get("Resources").get("Font").get("F0")
      .get("DescendantFonts").get(0)
      .get("FontDescriptor").get("FontFile2");
    if (!ff || ff.isNull()) throw new Error("FontFile2 not found after subsetFonts");
    const bytes = ff.readStream();
    if (!bytes || bytes.length === 0) throw new Error("empty FontFile2");
    // wasm メモリの view の可能性があるためコピーして返す
    return Buffer.from(bytes.asUint8Array ? bytes.asUint8Array().slice() : bytes);
  } catch (err) {
    console.warn("[vector-text] subset failed — embedding full font:", err?.message);
    return ttf;
  } finally {
    try { scratch?.destroy(); } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// テキスト層適用
// ---------------------------------------------------------------------------

function parseHexColor(s) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(s ?? ""));
  if (!m) return [0, 0, 0];
  const v = m[1];
  return [
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  ];
}

const fmt = (n) => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

/**
 * 1 op → content stream 断片。
 *
 * 回転: op.rot は canvas 系 (y 下向き) の視覚時計回り角。PDF (y 上向き)
 * のベースライン方向は (cosθ, -sinθ)、グリフ上方向は (sinθ, cosθ) になる
 * ので Tm = [cosθ -sinθ sinθ cosθ e f]。θ=0 で単位行列。
 *
 * 太字: canvas 側の paintGlyphRun (strokeText lineWidth=0.06×size +
 * fillText、round join/cap) と同値の Tr 2 (fill+stroke) + w 0.06×size。
 *
 * クリップ: op.clip (canonical top-left 原点 pt 矩形) があれば W n で
 * その範囲に制限する。viewer の overflow:hidden / ラスタの bbox 切りと
 * 揃えて「画面に見えない溢れ行が紙にだけ出る」ことを防ぐ。op ごとに
 * q/Q で囲うのでクリップは次の op に波及しない。
 */
function opToContent(cache, op, pageHeightPt, fontName) {
  const size = op.size;
  const [r, g, b] = parseHexColor(op.color ?? "#000000");
  const rot = (((op.rot ?? 0) % 360) + 360) % 360;
  const th = (rot * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const e = op.x;
  const f = pageHeightPt - op.y;
  let hex = "";
  for (const ch of String(op.text)) {
    const gid = gidOf(cache, ch.codePointAt(0));
    if (gid === 0) {
      // probe でゲートしている前提。ここに来たら設計違反なので即失敗
      // (黙って文字を落とす方が法律文書ではよほど危険)。
      throw new Error(`vector-text: glyph missing for U+${ch.codePointAt(0).toString(16)}`);
    }
    hex += gid.toString(16).padStart(4, "0");
  }
  if (hex === "") return "";
  const c = op.clip;
  const clipOp = c && [c.x, c.y, c.w, c.h].every(Number.isFinite) && c.w > 0 && c.h > 0
    ? `${fmt(c.x)} ${fmt(pageHeightPt - c.y - c.h)} ${fmt(c.w)} ${fmt(c.h)} re W n `
    : "";
  const pen = op.bold
    ? `2 Tr ${fmt(0.06 * size)} w 1 J 1 j ${fmt(r)} ${fmt(g)} ${fmt(b)} RG `
    : "0 Tr ";
  return (
    `q ${clipOp}BT /${fontName} ${fmt(size)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${pen}` +
    `${fmt(cos)} ${fmt(-sin)} ${fmt(sin)} ${fmt(cos)} ${fmt(e)} ${fmt(f)} Tm ` +
    `<${hex}> Tj ET Q\n`
  );
}

/**
 * ToUnicode CMap を自作する。サブセット TTF は cmap テーブルを持たない
 * ため addFont が自動生成できず (mupdf warning)、無いと Adobe でのコピー
 * /検索が文字化けする。コンテンツの文字コード = gid なので、gid →
 * UTF-16BE の bfchar 対応表をそのまま書けばよい。
 *
 * @param {Map<number, number>} gidToCp  gid → codepoint (使用分のみ)
 * @returns {string}
 */
function buildToUnicodeCMap(gidToCp) {
  const entries = [...gidToCp.entries()].sort((a, b) => a[0] - b[0]);
  const utf16Hex = (cp) => {
    const s = String.fromCodePoint(cp);
    let hex = "";
    for (let i = 0; i < s.length; i++) {
      hex += s.charCodeAt(i).toString(16).padStart(4, "0");
    }
    return hex;
  };
  let body = "";
  // bfchar ブロックは仕様上 100 エントリまで
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n`;
    for (const [gid, cp] of chunk) {
      body += `<${gid.toString(16).padStart(4, "0")}> <${utf16Hex(cp)}>\n`;
    }
    body += "endbfchar\n";
  }
  return (
    "/CIDInit /ProcSet findresource begin\n" +
    "12 dict begin\n" +
    "begincmap\n" +
    "/CIDSystemInfo <</Registry (Adobe) /Ordering (UCS) /Supplement 0>> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n" +
    "/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    body +
    "endcmap\n" +
    "CMapName currentdict /CMap defineresource pop\n" +
    "end\nend\n"
  );
}

/** ページの Resources/Font に衝突しない資源名を選ぶ。 */
function pickFontName(fontsDict) {
  for (let i = 0; ; i++) {
    const name = `KPF3V${i}`;
    const existing = fontsDict.get(name);
    if (!existing || existing.isNull()) return name;
  }
}

/**
 * assembleHybridPdf の出力 bytes に vectorTexts を焼き込む。
 *
 * @param {Buffer|Uint8Array} pdfBytes  組み立て済み PDF
 * @param {Array<{ heightPt: number, vectorTexts?: VectorTextOp[] }>} pages
 *          assembleHybridPdf に渡したのと同じ配列 (出力ページ順と 1:1)
 * @param {{ fontPath?: string }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function applyVectorTextLayer(pdfBytes, pages, opts = {}) {
  const targets = pages
    .map((p, i) => ({ p, i }))
    .filter((t) => Array.isArray(t.p.vectorTexts) && t.p.vectorTexts.length > 0);
  if (targets.length === 0) return Buffer.from(pdfBytes);

  const cache = loadMinchoFont(opts.fontPath);
  if (!cache) {
    // renderer 側 probe が false を返していれば vectorTexts は来ない。
    // ここに来るのは設計違反 (probe を通さず ops を作った) のみ。
    throw new Error("vector-text: ops present but MS Mincho font unavailable");
  }

  // 使用 gid を全ページから収集してサブセットを 1 つ作る。gid → cp の
  // 対応は ToUnicode CMap 生成にも使う (同一 gid に複数 cp が map される
  // ことは MS 明朝では実質ないが、先勝ちで 1 つに固定)。
  const gidSet = new Set([0]); // .notdef は常に保持
  const gidToCp = new Map();
  for (const { p } of targets) {
    for (const op of p.vectorTexts) {
      for (const ch of String(op.text)) {
        const cp = ch.codePointAt(0);
        const gid = gidOf(cache, cp);
        if (gid !== 0) {
          gidSet.add(gid);
          if (!gidToCp.has(gid)) gidToCp.set(gid, cp);
        }
      }
    }
  }
  // 同一 gid 集合のサブセットはメモ化 (同じ書類を続けて 印刷→別名保存
  // する典型パターンで、scratch PDF + subsetFonts の再実行を省く)。
  const gids = [...gidSet].sort((a, b) => a - b);
  const subsetKey = gids.join(",");
  let subsetTtf;
  if (cache.subsetMemo && cache.subsetMemo.key === subsetKey) {
    subsetTtf = cache.subsetMemo.ttf;
  } else {
    subsetTtf = buildSubsetTtf(cache.ttf, gids);
    cache.subsetMemo = { key: subsetKey, ttf: subsetTtf };
  }

  const doc = mupdf.PDFDocument.openDocument(
    pdfBytes instanceof Buffer ? pdfBytes : Buffer.from(pdfBytes),
    "application/pdf",
  );
  try {
    const fontRef = doc.addFont(new mupdf.Font("MS-Mincho", subsetTtf));
    // サブセットは cmap を持たず addFont が ToUnicode を作れないので自作
    // (無いと Adobe でのテキストコピー/検索が文字化けする)。
    fontRef.put("ToUnicode", doc.addStream(buildToUnicodeCMap(gidToCp), null));

    for (const { p, i } of targets) {
      const pageObj = doc.findPage(i);

      // Resources/Font に埋め込みフォントを登録 (名前衝突は回避)
      let res = pageObj.get("Resources");
      if (!res || res.isNull()) {
        res = doc.newDictionary();
        pageObj.put("Resources", res);
      }
      let fonts = res.get("Font");
      if (!fonts || fonts.isNull()) {
        fonts = doc.newDictionary();
        res.put("Font", fonts);
      }
      const fontName = pickFontName(fonts);
      fonts.put(fontName, fontRef);

      // content 生成
      let body = "";
      for (const op of p.vectorTexts) {
        body += opToContent(cache, op, p.heightPt, fontName);
      }
      if (body === "") continue;
      const content = `q\n${body}Q\n`;

      // 既存 Contents を q/Q で挟んで graphics state を隔離してから追記
      // (コピー元ページの content が CTM を復元せず終わっていても、
      //  我々のテキストが常に素の座標系で描かれることを保証する)。
      const qRef = doc.addStream("q\n", null);
      const tailRef = doc.addStream(`Q\n${content}`, null);
      const contents = pageObj.get("Contents");
      const arr = doc.newArray();
      arr.push(qRef);
      if (contents && contents.isArray()) {
        for (let k = 0; k < contents.length; k++) arr.push(contents.get(k));
      } else if (contents && !contents.isNull()) {
        arr.push(contents);
      }
      arr.push(tailRef);
      pageObj.put("Contents", arr);
    }

    const out = doc.saveToBuffer("compress").asUint8Array().slice();
    return Buffer.from(out);
  } finally {
    try { doc.destroy(); } catch { /* noop */ }
  }
}
