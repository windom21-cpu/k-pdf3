// ADR-0029: A4 切り取り (src/main/crop-a4.js) のテスト。
//
// applyCropFramesToPdf は「assembleHybridPdf の出力」を受ける後処理なので、
// ここでは pdf-lib で組み立て出力の代役 PDF を作り、mupdf (WASM) で
// レンダリングして切り出し位置をピクセルで検証する
// (rotation-overlay.test.mjs と同じ harness)。
//
//   [1] A3 横 + 2 枠 → A4 縦 2 ページに左右分割 (本丸ユースケース)
//   [2] /Rotate=90 を持つページ (verbatim 高速パス相当) でも切り出し位置が
//       回らない — crop-a4.js が rotatedSourcePlacement でベイクする経路
//   [3] A4 未満 (A5) + はみ出し枠 → 白余白付きで A4 化
//   [4] 枠なしページの素通し・ページ順・expandPageOrderForCrop の展開
//   [5] normalizeCropFrames の入力正規化 (文字列キー / 不正枠)

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import {
  applyCropFramesToPdf,
  expandPageOrderForCrop,
  normalizeCropFrames,
  A4_W,
  A4_H,
} from "../src/main/crop-a4.js";
import { renderPagePixels, openPdfDocument } from "../src/backend/mupdf-render.js";

const A3_W = 1190.55;

/** ページを 1 枚レンダリングして、色マーカーの重心と紙サイズを返す。 */
function inspect(bytes, pageIdx) {
  const doc = openPdfDocument(Buffer.from(bytes));
  try {
    const r = renderPagePixels(doc, pageIdx, [1, 0, 0, 1, 0, 0]);
    const { width, height, channels, pixels } = r;
    const acc = {
      red: { x: 0, y: 0, n: 0 },
      blue: { x: 0, y: 0, n: 0 },
      green: { x: 0, y: 0, n: 0 },
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        const R = pixels[i], G = pixels[i + 1], B = pixels[i + 2];
        if (R > 180 && G < 80 && B < 80) { acc.red.x += x; acc.red.y += y; acc.red.n++; }
        if (B > 180 && R < 80 && G < 80) { acc.blue.x += x; acc.blue.y += y; acc.blue.n++; }
        if (G > 140 && R < 80 && B < 80) { acc.green.x += x; acc.green.y += y; acc.green.n++; }
      }
    }
    const c = (m) => (m.n ? { x: m.x / m.n, y: m.y / m.n, n: m.n } : null);
    // 余白判定用の点サンプル (RGBA — 描画の無い場所は alpha=0 の透明)
    const at = (x, y) => {
      const i = (Math.round(y) * width + Math.round(x)) * channels;
      return [pixels[i], pixels[i + 1], pixels[i + 2], channels > 3 ? pixels[i + 3] : 255];
    };
    return { width, height, red: c(acc.red), blue: c(acc.blue), green: c(acc.green), at };
  } finally {
    doc.destroy();
  }
}

// [1] A3 横 (1190.55×841.89) — 左半分の中央に青、右半分の中央に赤。
//     左右 2 枠 (x=0 / x=W−A4_W) で切ると A4 縦 2 ページに分かれ、
//     各マーカーが各ページの中央付近に来るはず。
test("[1] A3 横 + 2 枠 → A4 縦 2 ページに左右分割", async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([A3_W, A4_H]);
  // 青: 左半分の中央 (canonical x≈297.6, y 中央)
  p.drawRectangle({ x: 267, y: 391, width: 60, height: 60, color: rgb(0, 0, 1) });
  // 赤: 右半分の中央 (canonical x≈892.9)
  p.drawRectangle({ x: 863, y: 391, width: 60, height: 60, color: rgb(1, 0, 0) });
  const bytes = await doc.save();

  const out = await applyCropFramesToPdf(
    bytes,
    [{ pageNo: 1 }],
    { 1: [{ x: 0, y: 0, w: A4_W, h: A4_H }, { x: A3_W - A4_W, y: 0, w: A4_W, h: A4_H }] },
  );
  const outDoc = await PDFDocument.load(out);
  assert.equal(outDoc.getPageCount(), 2);
  for (const size of [outDoc.getPage(0).getSize(), outDoc.getPage(1).getSize()]) {
    assert.ok(Math.abs(size.width - A4_W) < 0.01 && Math.abs(size.height - A4_H) < 0.01,
      `出力ページが A4 縦でない: ${size.width}×${size.height}`);
  }
  const page0 = inspect(out, 0);
  const page1 = inspect(out, 1);
  // ページ 1 = 左半分: 青だけ。中央付近 (x≈297, y≈421 — mupdf は y-down)。
  assert.ok(page0.blue && !page0.red, `左ページ: blue=${!!page0.blue} red=${!!page0.red}`);
  assert.ok(Math.abs(page0.blue.x - 297) < 4 && Math.abs(page0.blue.y - 421) < 4,
    `左ページの青位置ずれ: (${page0.blue.x}, ${page0.blue.y})`);
  // ページ 2 = 右半分: 赤だけ。右枠は x=W−A4_W 開始なので赤の canonical
  // x≈892.9 は枠内 x≈892.9−595.27=297.6。
  assert.ok(page1.red && !page1.blue, `右ページ: red=${!!page1.red} blue=${!!page1.blue}`);
  assert.ok(Math.abs(page1.red.x - 297.6) < 4 && Math.abs(page1.red.y - 421) < 4,
    `右ページの赤位置ずれ: (${page1.red.x}, ${page1.red.y})`);
});

// [2] /Rotate=90 を持ったページ (assembleHybridPdf の verbatim 高速パスが
//     intrinsic /Rotate を運ぶケースの代役)。native A3 縦 + /Rotate=90 =
//     canonical A3 横。canonical 座標のマーカー位置は [1] と同じになるよう
//     native 座標に逆変換して描き、[1] と同じ枠・同じ検証を通す。
test("[2] /Rotate=90 ページでも切り出し位置が回らない (ベイク経路)", async () => {
  const Wn = A4_H;   // native 841.89
  const Hn = A3_W;   // native 1190.55
  const doc = await PDFDocument.create();
  const p = doc.addPage([Wn, Hn]);
  p.setRotation(degrees(90));
  // canonical (xd, yd) → native: xn = Wn − yd, yn = xd  (90° CW 表示の逆写像)
  // 青 canonical 中心 (297, 421) → 矩形左下 native (Wn−451−?, ...) は
  // 逆写像で矩形ごと変換する: canonical 矩形 x:[267,327], y-up y:[391,451]
  //   → native x:[Wn−451, Wn−391], y:[267, 327]
  p.drawRectangle({ x: Wn - 451, y: 267, width: 60, height: 60, color: rgb(0, 0, 1) });
  // 赤 canonical x:[863,923], y-up y:[391,451] → native x:[Wn−451, Wn−391], y:[863, 923]
  p.drawRectangle({ x: Wn - 451, y: 863, width: 60, height: 60, color: rgb(1, 0, 0) });
  const bytes = await doc.save();

  const out = await applyCropFramesToPdf(
    bytes,
    [{ pageNo: 1 }],
    { 1: [{ x: 0, y: 0 }, { x: A3_W - A4_W, y: 0 }] }, // w/h 省略 = A4 既定
  );
  const outDoc = await PDFDocument.load(out);
  assert.equal(outDoc.getPageCount(), 2);
  const page0 = inspect(out, 0);
  const page1 = inspect(out, 1);
  assert.ok(page0.blue && !page0.red, `左ページ: blue=${!!page0.blue} red=${!!page0.red}`);
  assert.ok(Math.abs(page0.blue.x - 297) < 4 && Math.abs(page0.blue.y - 421) < 4,
    `左ページの青位置ずれ (回転ベイク不全?): (${page0.blue.x}, ${page0.blue.y})`);
  assert.ok(page1.red && !page1.blue, `右ページ: red=${!!page1.red} blue=${!!page1.blue}`);
  assert.ok(Math.abs(page1.red.x - 297.6) < 4 && Math.abs(page1.red.y - 421) < 4,
    `右ページの赤位置ずれ (回転ベイク不全?): (${page1.red.x}, ${page1.red.y})`);
});

// [3] A5 縦 (419.53×595.28) を緑で全面塗り + 中央はみ出し枠 → A4 化。
//     出力は A4 縦 1 ページ、中央に緑、四辺は白い余白。
test("[3] A4 未満ページ + はみ出し枠 → 白余白付きで A4 化", async () => {
  const A5_W = 419.53, A5_H = 595.28;
  const doc = await PDFDocument.create();
  const p = doc.addPage([A5_W, A5_H]);
  p.drawRectangle({ x: 0, y: 0, width: A5_W, height: A5_H, color: rgb(0, 0.7, 0) });
  const bytes = await doc.save();

  const fx = (A5_W - A4_W) / 2;  // 負値 = 枠が紙の左外にはみ出す
  const fy = (A5_H - A4_H) / 2;
  const out = await applyCropFramesToPdf(
    bytes,
    [{ pageNo: 1 }],
    { 1: [{ x: fx, y: fy, w: A4_W, h: A4_H }] },
  );
  const outDoc = await PDFDocument.load(out);
  assert.equal(outDoc.getPageCount(), 1);
  const size = outDoc.getPage(0).getSize();
  assert.ok(Math.abs(size.width - A4_W) < 0.01 && Math.abs(size.height - A4_H) < 0.01);
  const page0 = inspect(out, 0);
  // 緑の重心 ≈ ページ中央
  assert.ok(page0.green, "緑マーカーが消えた");
  assert.ok(Math.abs(page0.green.x - A4_W / 2) < 4 && Math.abs(page0.green.y - A4_H / 2) < 4,
    `A5 内容が中央に来ていない: (${page0.green.x}, ${page0.green.y})`);
  // 四隅は余白 (描画なし = 透明 or 白。緑がはみ出していないこと)
  for (const [x, y] of [[10, 10], [page0.width - 10, 10], [10, page0.height - 10]]) {
    const [R, G, B, A] = page0.at(x, y);
    const blank = A === 0 || (R > 230 && G > 230 && B > 230);
    assert.ok(blank, `余白に描画がある at (${x},${y}): rgba(${R},${G},${B},${A})`);
  }
});

// [4] 枠なしページは素通し + ページ順維持。しおり用 pageOrder の展開も検証。
test("[4] 素通しページとページ順、expandPageOrderForCrop", async () => {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([A4_W, A4_H]);
  p1.drawRectangle({ x: 100, y: 100, width: 50, height: 50, color: rgb(0, 0, 1) }); // 青
  doc.addPage([A3_W, A4_H]); // 白紙 A3 (2 枠で切る)
  const p3 = doc.addPage([A4_W, A4_H]);
  p3.drawRectangle({ x: 100, y: 100, width: 50, height: 50, color: rgb(1, 0, 0) }); // 赤
  const bytes = await doc.save();

  const pages = [{ pageNo: 1 }, { pageNo: 2 }, { pageNo: 3 }];
  const cropFrames = { 2: [{ x: 0, y: 0 }, { x: A3_W - A4_W, y: 0 }] };
  const out = await applyCropFramesToPdf(bytes, pages, cropFrames);
  const outDoc = await PDFDocument.load(out);
  assert.equal(outDoc.getPageCount(), 4); // 1 + 2 + 1
  // 先頭 = 元ページ 1 (青)、末尾 = 元ページ 3 (赤) — 素通し・順序維持
  assert.ok(inspect(out, 0).blue, "素通しページ 1 の内容が失われた");
  assert.ok(inspect(out, 3).red, "素通しページ 3 の内容が失われた");
  // しおり pageOrder: 2 枠目は null 埋め (先頭の枠ページにしおりを乗せる)
  assert.deepEqual(expandPageOrderForCrop(pages, cropFrames), [1, 2, null, 3]);
  // 枠なしなら恒等
  assert.deepEqual(expandPageOrderForCrop(pages, {}), [1, 2, 3]);
});

// [5] normalizeCropFrames — IPC/JSON 由来の文字列キーと不正枠の除去。
test("[5] normalizeCropFrames の入力正規化", () => {
  const map = normalizeCropFrames({
    "3": [{ x: 1, y: 2 }, { x: "bad" }, null],
    "abc": [{ x: 0, y: 0 }],
    "-2": [{ x: 5, y: 6 }], // 挿入ページ (負の pageNo) も通す
    "7": [],
  });
  assert.deepEqual([...map.keys()].sort((a, b) => a - b), [-2, 3]);
  assert.equal(map.get(3).length, 1);
  assert.equal(normalizeCropFrames(null).size, 0);
  assert.equal(normalizeCropFrames("x").size, 0);
});
