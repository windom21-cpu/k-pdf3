// MS明朝 印刷濃度 検証シート生成 spike (2026-07-06)
//
// 「テキスト overlay を 900dpi グレースケール AA ラスタで印刷すると
// MS明朝が薄い」問題の対策候補 4 方式 + 参考 1 方式を、同一サンプル文で
// 1 枚の A4 PDF に並べる。事務所レーザーで白黒印刷して紙で比較する。
//
//   ① 現行方式シミュレーション: 900dpi AA ラスタ
//        (β76 hairline stroke 0.02×size + β.141 fillText 4回打ち
//         = α' = 1-(1-αs)(1-αf)^4) を SMask 付き RGBA 画像で埋め込み
//   ② 2値化ラスタ: fill coverage を α≥0.5 で 0/1 に snap (SMask は残る)
//   ③ 1-bit ImageMask: 同じ 2値ビットマップを stencil mask で埋め込み
//        (透過 SMask を使わない = flattener 非関与、塗りは常に 100% K)
//   ④ ベクター埋め込み: MS明朝サブセットを実テキストとして埋め込み
//        (Word と同じく printer RIP がデバイス解像度 1-bit で描画する)
//   ⑤ 参考: β.139 以前 (hairline stroke + fillText 1回) 相当
//
// 見出し/説明文はすべて④と同じベクター方式で描くので、どの行でも
// すぐ隣に「あるべき濃さ」の参照がある。
//
// 実行:  node spike/print-density-sheet.mjs
// 出力:  /mnt/c/Users/sk21l/Desktop/mincho-print-density-A4.pdf
//
// 注意: ①⑤の AA は canvas (DirectWrite) ではなく mupdf (FreeType) だが、
// どちらもグレースケール coverage AA で、900dpi (150px/12pt) では
// ヒンティング差は無視できる。網点化・リサンプリングの物理は同一。

import * as mupdf from "mupdf";
import fs from "node:fs";
import zlib from "node:zlib";
// TTC → 単体 TTF 抽出は本体実装 (v2.0.13 ベクターテキスト層) を共用する。
import { extractTtfFromTtc } from "../src/backend/vector-text-layer.js";

const TTC_PATH = "/mnt/c/Windows/Fonts/msmincho.ttc";
const OUT_PATH = "/mnt/c/Users/sk21l/Desktop/mincho-print-density-A4.pdf";
const EXPORT_ZOOM = 900 / 72; // 12.5 — 本体 exporter.js と同値

// ---------------------------------------------------------------------------
// フォント / テキスト helpers
// ---------------------------------------------------------------------------
const ttf = extractTtfFromTtc(fs.readFileSync(TTC_PATH), 0);
console.log(`TTF extracted from TTC: ${(ttf.length / 1024 / 1024).toFixed(1)} MB`);
const mincho = new mupdf.Font("MS-Mincho", ttf);

/** 文字列 → { hex: Identity-H CID hex string, widthEm: advance 合計 (em) } */
function encodeRun(text) {
  let hex = "";
  let widthEm = 0;
  for (const ch of text) {
    const gid = mincho.encodeCharacter(ch.codePointAt(0));
    if (gid === 0) console.warn(`  ⚠ glyph missing for '${ch}'`);
    hex += gid.toString(16).padStart(4, "0");
    widthEm += mincho.advanceGlyph(gid, 0);
  }
  return { hex, widthEm };
}

/** ベクターテキスト 1 行分の content stream 断片 (Tr 0 = 素の fill)。 */
function vectorTextOp(text, size, x, y) {
  const { hex } = encodeRun(text);
  return `BT /F1 ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm <${hex}> Tj ET\n`;
}

// ---------------------------------------------------------------------------
// 900dpi ラスタ生成: サンプル文を fill / stroke-only の 2 変種で描いた
// 使い捨て PDF を組み、alpha 付き pixmap に焼いて coverage を取り出す
// ---------------------------------------------------------------------------
function renderCoverage(text, size, mode /* "fill" | "stroke" */) {
  const { hex, widthEm } = encodeRun(text);
  const wPt = widthEm * size + 4;
  const hPt = size * 1.6;
  const baseline = size * 0.35;
  // β76 hairline: lineWidth = 0.02 × fontSize、round join/cap
  const pen = mode === "stroke"
    ? `1 Tr ${(0.02 * size).toFixed(3)} w 1 J 1 j `
    : "0 Tr ";
  const contents =
    `BT /F1 ${size} Tf ${pen}1 0 0 1 2 ${baseline.toFixed(2)} Tm <${hex}> Tj ET`;
  const doc = new mupdf.PDFDocument();
  const fontRef = doc.addFont(mincho);
  const pageObj = doc.addPage([0, 0, wPt, hPt], 0, { Font: { F1: fontRef } }, contents);
  doc.insertPage(-1, pageObj);
  // 保存 → 再オープンでレンダリング (編集中ドキュメントの描画キャッシュ問題を回避)
  // asUint8Array は wasm メモリの view — メモリ成長で detach されるのでコピー
  const bytes = doc.saveToBuffer("").asUint8Array().slice();
  doc.destroy();
  const rdoc = mupdf.Document.openDocument(bytes, "application/pdf");
  const page = rdoc.loadPage(0);
  const pix = page.toPixmap(
    [EXPORT_ZOOM, 0, 0, EXPORT_ZOOM, 0, 0],
    mupdf.ColorSpace.DeviceRGB,
    true, // alpha — 透明地に coverage が A チャネルに入る (文字は黒なので RGB=0)
  );
  const w = pix.getWidth();
  const h = pix.getHeight();
  // wasm メモリの view なので Node 側にコピーして持ち出す
  const alpha = new Uint8Array(w * h);
  const px = pix.getPixels();
  for (let i = 0, n = w * h; i < n; i++) alpha[i] = px[i * 4 + 3];
  pix.destroy();
  return { w, h, alpha };
}

/** coverage 配列 → RGBA pixmap → mupdf Image (SMask 付きで埋め込まれる)。 */
function coverageToImage(doc, w, h, alpha) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], true);
  pix.clear(); // 全 0 = 透明黒
  const px = pix.getPixels();
  for (let i = 0, n = w * h; i < n; i++) px[i * 4 + 3] = alpha[i]; // RGB=0 のまま A だけ
  const img = new mupdf.Image(pix);
  const ref = doc.addImage(img);
  pix.destroy();
  return ref;
}

/** 2値 coverage → 1-bit ImageMask XObject (FlateDecode)。bit=1 が塗り (Decode [1 0])。 */
function coverageToImageMask(doc, w, h, alpha) {
  const rowBytes = (w + 7) >> 3;
  const packed = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] >= 128) packed[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const deflated = zlib.deflateSync(packed);
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("XObject"));
  dict.put("Subtype", doc.newName("Image"));
  dict.put("Width", w);
  dict.put("Height", h);
  dict.put("ImageMask", true);
  dict.put("BitsPerComponent", 1);
  const dec = doc.newArray();
  dec.push(1);
  dec.push(0);
  dict.put("Decode", dec);
  dict.put("Filter", doc.newName("FlateDecode"));
  return doc.addRawStream(deflated, dict);
}

// ---------------------------------------------------------------------------
// シート組み立て
// ---------------------------------------------------------------------------
const SAMPLE = "令和八年三月三十一日　東京地方裁判所　第一二三号　損害賠償請求事件";
const SIZES = [10.5, 12];

const boost4 = (as, af) => 1 - (1 - as) * (1 - af) ** 4; // β.141 現行
const boost1 = (as, af) => 1 - (1 - as) * (1 - af);      // β.139 以前

const doc = new mupdf.PDFDocument();
const F1 = doc.addFont(mincho);

const PAGE_W = 595.32;
const PAGE_H = 841.92;
const MARGIN = 48;

let ops = "";
const xobjects = {};
let imgSeq = 0;

/** ラスタ画像 1 行を置く (pt 座標、y は行の下端)。 */
function placeImage(ref, w, h, x, y, isMask) {
  const name = `Im${imgSeq++}`;
  xobjects[name] = ref;
  const wPt = w / EXPORT_ZOOM;
  const hPt = h / EXPORT_ZOOM;
  ops += `q 0 g ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q\n`;
  return hPt;
}

// --- ヘッダ (すべてベクター = ④方式) ---
let cursorY = PAGE_H - MARGIN;
ops += vectorTextOp("MS明朝 印刷濃度 検証シート（2026-07-06）", 14, MARGIN, cursorY);
cursorY -= 18;
for (const line of [
  "Adobe Reader から実寸（100%・ページの拡大縮小なし）で白黒レーザー印刷してください。",
  "行見出しと説明文はすべて④ベクター方式です（＝どの行のすぐ隣にも基準の濃さがあります）。",
  "①〜③⑤の本文の濃さ・線の途切れを、④および見出し文字と比較してください。",
]) {
  ops += vectorTextOp(line, 9, MARGIN, cursorY);
  cursorY -= 13;
}
cursorY -= 10;

// --- サンプル行の事前レンダリング (fill / stroke coverage) ---
console.log("rendering 900dpi coverage...");
const cov = {};
for (const size of SIZES) {
  cov[size] = {
    fill: renderCoverage(SAMPLE, size, "fill"),
    stroke: renderCoverage(SAMPLE, size, "stroke"),
  };
  console.log(`  size=${size}pt → ${cov[size].fill.w}×${cov[size].fill.h}px`);
}

/** 行 = 見出し (ベクター 9pt) + サイズごとの本文。renderBody(size) が ops を積む。 */
function row(label, renderBody) {
  ops += vectorTextOp(label, 9, MARGIN, cursorY);
  cursorY -= 6;
  for (const size of SIZES) {
    cursorY -= size * 1.5;
    renderBody(size, MARGIN, cursorY);
  }
  cursorY -= 14;
}

// ① 現行方式 (900dpi AA + hairline stroke + fill 4回打ち)
row("① 現行方式：900dpi AAラスタ＋4回打ち（v2.0.12 相当）", (size, x, y) => {
  const { w, h } = cov[size].fill;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) {
    a[i] = Math.round(255 * boost4(cov[size].stroke.alpha[i] / 255, cov[size].fill.alpha[i] / 255));
  }
  placeImage(coverageToImage(doc, w, h, a), w, h, x, y);
});

// ② 2値化ラスタ
row("② 2値化ラスタ：AA を α≥0.5 で 0/1 に snap（SMask 経由のまま）", (size, x, y) => {
  const { w, h, alpha } = cov[size].fill;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = alpha[i] >= 128 ? 255 : 0;
  placeImage(coverageToImage(doc, w, h, a), w, h, x, y);
});

// ③ 1-bit ImageMask (stencil)
row("③ 1-bit ImageMask：同じ2値ビットマップを stencil で埋め込み（透過なし）", (size, x, y) => {
  const { w, h, alpha } = cov[size].fill;
  placeImage(coverageToImageMask(doc, w, h, alpha), w, h, x, y, true);
});

// ④ ベクター埋め込み
row("④ ベクター埋め込み：MS明朝サブセットを実テキストで埋め込み（案A・推奨）", (size, x, y) => {
  ops += vectorTextOp(SAMPLE, size, MARGIN, y + size * 0.35);
});

// ⑤ 参考: β.139 以前
row("⑤ 参考：β.139以前（hairline stroke＋1回打ち）相当", (size, x, y) => {
  const { w, h } = cov[size].fill;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) {
    a[i] = Math.round(255 * boost1(cov[size].stroke.alpha[i] / 255, cov[size].fill.alpha[i] / 255));
  }
  placeImage(coverageToImage(doc, w, h, a), w, h, x, y);
});

// --- フッタ ---
cursorY -= 6;
ops += vectorTextOp("判定メモ：④が Word 印刷と同等の濃さで、①より明確に濃ければ案A採用。", 9, MARGIN, cursorY);
cursorY -= 13;
ops += vectorTextOp("③が④に迫るなら、フォント無し環境のフォールバックとして案Bも価値あり。", 9, MARGIN, cursorY);

// --- ページ確定 ---
const pageObj = doc.addPage([0, 0, PAGE_W, PAGE_H], 0, { Font: { F1 }, XObject: xobjects }, ops);
doc.insertPage(-1, pageObj);

// フォントサブセット化 (失敗したらフル埋め込みのまま出す)
try {
  doc.subsetFonts();
  console.log("subsetFonts: OK");
} catch (e) {
  console.warn(`subsetFonts failed (${e.message}) — フル埋め込みで続行`);
}

const bytes = doc.saveToBuffer("compress").asUint8Array().slice();
fs.writeFileSync(OUT_PATH, bytes);
console.log(`\n✓ wrote ${OUT_PATH} (${(bytes.length / 1024).toFixed(0)} KB)`);
