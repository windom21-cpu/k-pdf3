// 真の墨消し v2 (2026-07-10) — mupdf applyRedactions によるベクター維持の
// 物理削除 (src/main/redact-source.js + coord.js canonicalRectToFitz)。
//
// セキュリティ要件をテストで恒久固定する:
//   1. 墨消し領域内のテキストが出力 PDF から抽出不能 (物理削除)
//   2. 領域外のテキストはベクターのまま残る (抽出できる = raster 化なし)
//   3. スキャン PDF (全面画像) は覆われた画素のみ黒抜き、画像自体は保持
//   4. 回転 (source /Rotate × userRotation) の全組み合わせで正しい領域が
//      消える — β.142 で実害の出た座標変換クラスの回帰ガード
//   5. 領域を横切るだけの罫線は保持 (REMOVE_IF_COVERED)
//
// mupdf は WASM なので plain `node --test` で走る (rotation-overlay と同じ)。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { redactSourceBytes } from "../src/main/redact-source.js";
import { canonicalRectToFitz, pdfRectToCanonical } from "../src/domain/coord.js";

const W = 595, H = 842;

async function makeTextPdf(sourceRotate = 0) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("SECRET", { x: 50, y: 700, size: 20, font });
  page.drawText("PUBLIC", { x: 50, y: 600, size: 20, font });
  if (sourceRotate) page.setRotation(degrees(sourceRotate));
  return doc.save();
}

function extractText(bytes) {
  const doc = mupdf.Document.openDocument(Buffer.from(bytes), "application/pdf");
  return doc.loadPage(0).toStructuredText().asText();
}

/** fitz 空間 (= mupdf structured text と同じ) での行 bbox を実測で取る */
function fitzBboxOf(bytes, needle) {
  const doc = mupdf.Document.openDocument(Buffer.from(bytes), "application/pdf");
  const st = JSON.parse(doc.loadPage(0).toStructuredText().asJSON());
  for (const b of st.blocks) {
    for (const l of b.lines ?? []) {
      if (l.text?.includes(needle)) return l.bbox; // {x,y,w,h} fitz 空間
    }
  }
  return null;
}

/** page box (crop 原点 0 前提、composePagesForExport と同じ組み立て) */
function pageBoxFor(sourceRotate, userRotation) {
  return {
    mediaX: 0, mediaY: 0, mediaW: 0, mediaH: 0,
    cropX: 0, cropY: 0, cropW: W, cropH: H,
    rotation: sourceRotate, userRotation,
  };
}

test("領域内テキスト物理削除 + 領域外はベクター保持 (flat)", async () => {
  const src = await makeTextPdf(0);
  const box = fitzBboxOf(src, "SECRET");
  assert.ok(box, "SECRET の bbox が取れる");
  const out = redactSourceBytes(src, [{
    sourceIdx: 0,
    rects: [{ x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 }],
  }]);
  const text = extractText(out);
  assert.ok(!text.includes("SECRET"), "SECRET が抽出不能");
  assert.ok(text.includes("PUBLIC"), "PUBLIC はベクターのまま抽出できる");
});

// source /Rotate × userRotation の全 16 組み合わせ。overlay は canonical
// (ユーザーが見る向き) で置かれるので、実測 fitz bbox → canonical へ逆変換
// した矩形を canonicalRectToFitz で戻し、正しい場所が消えることを確認する。
for (const srcRot of [0, 90, 180, 270]) {
  for (const userRot of [0, 90, 180, 270]) {
    test(`回転の座標変換: /Rotate=${srcRot} userRotation=${userRot}`, async () => {
      const src = await makeTextPdf(srcRot);
      const fitz = fitzBboxOf(src, "SECRET");
      assert.ok(fitz);
      const pageBox = pageBoxFor(srcRot, userRot);
      // fitz bbox → canonical (overlay が置かれる空間) を作る。
      // fitz = userRotation 抜きの canonical なので、fitz → PDF native →
      // canonical(userRot 込み) の順で「ユーザーが置いた矩形」を合成する。
      const noUserRot = { ...pageBox, userRotation: 0 };
      // fitz (top-left y-down) → PDF native (bottom-left y-up)
      const nativeW = (srcRot % 180 === 0) ? W : W; // crop は常に W×H (native)
      void nativeW;
      const fitzTopLeft = { x: fitz.x, y: fitz.y, w: fitz.w, h: fitz.h };
      // pdfRectToCanonical の逆変換が無いので、canonicalRectToPdf(noUserRot)
      // の逆 = pdfRectToCanonical(noUserRot) を使って fitz→native を経由:
      // fitz 空間 == canonical(noUserRot) である (canonicalRectToFitz の定義)。
      // よって canonical(userRot 込み) は native を介して:
      const { canonicalRectToPdf } = await import("../src/domain/coord.js");
      const nat = canonicalRectToPdf(fitzTopLeft, noUserRot);
      const canonical = pdfRectToCanonical(
        [nat.x, nat.y, nat.x + nat.w, nat.y + nat.h], pageBox,
      );
      // 本番経路と同じ変換で fitz へ戻す
      const rect = canonicalRectToFitz(canonical, pageBox);
      const out = redactSourceBytes(src, [{
        sourceIdx: 0,
        rects: [{ x: rect.x - 2, y: rect.y - 2, w: rect.w + 4, h: rect.h + 4 }],
      }]);
      const text = extractText(out);
      assert.ok(!text.includes("SECRET"), `SECRET 消去 (${srcRot}/${userRot})`);
      assert.ok(text.includes("PUBLIC"), `PUBLIC 保持 (${srcRot}/${userRot})`);
    });
  }
}

test("スキャン PDF: 覆われた画素のみ黒抜き、画像は保持", async () => {
  // 上半分=赤 / 下半分=青 の画像 1 枚をページ全面に置いた PDF を合成
  const png = makeHalfPng();
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 0, y: 0, width: 200, height: 200 });
  const bytes = await doc.save();

  const out = redactSourceBytes(bytes, [{
    sourceIdx: 0,
    rects: [{ x: 0, y: 0, w: 200, h: 100 }], // fitz 空間 = 上半分 (赤)
  }]);
  const vdoc = mupdf.Document.openDocument(Buffer.from(out), "application/pdf");
  const pix = vdoc.loadPage(0).toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
  const px = pix.getPixels(), pw = pix.getWidth();
  const at = (x, y) => [px[(y * pw + x) * 3], px[(y * pw + x) * 3 + 1], px[(y * pw + x) * 3 + 2]];
  // black_boxes=false では覆われた画素は白へ消去される (黒塗りの見た目は
  // overlay PNG が担う。白墨消し指定でも黒が透けない利点がある)。元の
  // 赤 (255,0,0) が残っていないことが本質。
  const top = at(100, 50);
  assert.ok(top[0] > 200 && top[1] > 200 && top[2] > 200,
    `墨消し領域の画素が消去されている (白、実測 ${top})`);
  const bottom = at(100, 150);
  assert.ok(bottom[2] > 200 && bottom[0] < 50, "領域外の画像 (青) は保持");
});

test("領域を横切る罫線は保持される (REMOVE_IF_COVERED)", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("SECRET", { x: 50, y: 700, size: 20, font });
  // 墨消し領域を縦に貫通する罫線 (表の枠線を想定)
  page.drawLine({
    start: { x: 100, y: 500 }, end: { x: 100, y: 800 },
    thickness: 2, color: rgb(0, 0, 1),
  });
  const bytes = await doc.save();
  const box = fitzBboxOf(bytes, "SECRET");
  const out = redactSourceBytes(bytes, [{
    sourceIdx: 0,
    rects: [{ x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 }],
  }]);
  assert.ok(!extractText(out).includes("SECRET"));
  // 罫線が領域の外側 (fitz y = 842-550 = 292 付近) にまだ描かれているか
  const vdoc = mupdf.Document.openDocument(Buffer.from(out), "application/pdf");
  const pix = vdoc.loadPage(0).toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
  const px = pix.getPixels(), pw = pix.getWidth();
  const at = (x, y) => [px[(y * pw + x) * 3], px[(y * pw + x) * 3 + 1], px[(y * pw + x) * 3 + 2]];
  const lineBelow = at(100, H - 550); // 領域より下の線上
  assert.ok(lineBelow[2] > 150 && lineBelow[0] < 100, `罫線が保持されている (実測 ${lineBelow})`);
});

test("入力検証: 不正 rect / 範囲外ページで throw (raster フォールバック用)", async () => {
  const src = await makeTextPdf(0);
  assert.throws(() => redactSourceBytes(src, [{ sourceIdx: 5, rects: [{ x: 0, y: 0, w: 10, h: 10 }] }]));
  assert.throws(() => redactSourceBytes(src, [{ sourceIdx: 0, rects: [{ x: 0, y: 0, w: 0, h: 10 }] }]));
  assert.throws(() => redactSourceBytes(src, []));
});

/** 上半分=赤 / 下半分=青 の 100x100 RGB PNG を依存なしで生成 */
function makeHalfPng() {
  const zlib = require_zlib();
  const w = 100, h = 100;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const off = 1 + x * 3;
      if (y < h / 2) row[off] = 255; else row[off + 2] = 255;
    }
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const b of td) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const cb = Buffer.alloc(4); cb.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, cb]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}

import zlibMod from "node:zlib";
function require_zlib() { return zlibMod; }
