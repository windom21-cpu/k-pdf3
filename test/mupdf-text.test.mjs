// mupdf-text (テキスト選択モードのバックエンド) — extractPageTextLines
//
// テキスト選択モード (renderer/text-select.js) は、この抽出結果を
// 「fitz 空間 (post-/Rotate、page bounds 左上原点) × zoom」でページ canvas
// に重ねる契約。テストで恒久固定するのは:
//   1. 行テキストと bbox が返る (OCR 済み PDF の透明テキスト層も同じ経路)
//   2. bbox が fitz 空間に乗っている (pdf-lib の下原点 y → 上原点 y に反転)
//   3. /Rotate 90 ページは回転後の空間 (幅高さ交換) で返る = pixmap と同空間
//   4. テキストのないページは lines 空 (エラーにしない)
//
// mupdf は WASM なので plain `node --test` で走る (vector-redaction と同じ)。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { extractPageTextLines } from "../src/backend/mupdf-text.js";

const W = 595, H = 842;

async function makeTextPdf(sourceRotate = 0) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("HELLO", { x: 50, y: 700, size: 20, font });
  page.drawText("WORLD", { x: 50, y: 600, size: 20, font });
  if (sourceRotate) page.setRotation(degrees(sourceRotate));
  return doc.save();
}

function openDoc(bytes) {
  return mupdf.Document.openDocument(Buffer.from(bytes), "application/pdf");
}

test("フラットページ: 行テキスト + fitz 空間 bbox", async () => {
  const doc = openDoc(await makeTextPdf(0));
  try {
    const res = extractPageTextLines(doc, 0);
    assert.equal(Math.round(res.w), W, "page w");
    assert.equal(Math.round(res.h), H, "page h");

    const hello = res.lines.find((l) => l.text.includes("HELLO"));
    const world = res.lines.find((l) => l.text.includes("WORLD"));
    assert.ok(hello, "HELLO 行が抽出される");
    assert.ok(world, "WORLD 行が抽出される");

    // pdf-lib の drawText は下原点 baseline y=700。fitz は上原点なので
    // 行 top はおよそ H - 700 - size 付近 (フォントメトリクスで数 pt ずれる)。
    assert.ok(
      hello.y > H - 700 - 25 && hello.y < H - 700 + 5,
      `HELLO y が上原点系 (got ${hello.y})`,
    );
    assert.ok(hello.x > 45 && hello.x < 55, `HELLO x ≈ 50 (got ${hello.x})`);
    assert.ok(hello.w > 0 && hello.h > 0, "bbox が正の寸法");
    assert.ok(hello.size > 15 && hello.size < 25, `size ≈ 20 (got ${hello.size})`);
    assert.equal(hello.wmode, 0, "横書き");
    // HELLO (y=700) は WORLD (y=600) より上 = fitz y が小さい
    assert.ok(hello.y < world.y, "行の上下関係が保たれる");
  } finally {
    doc.destroy();
  }
});

test("/Rotate 90 ページ: bbox は回転後の空間 (pixmap と同空間) に乗る", async () => {
  const doc = openDoc(await makeTextPdf(90));
  try {
    const res = extractPageTextLines(doc, 0);
    // 回転後空間なので幅高さが交換される
    assert.equal(Math.round(res.w), H, "回転後 w = 元 h");
    assert.equal(Math.round(res.h), W, "回転後 h = 元 w");
    const hello = res.lines.find((l) => l.text.includes("HELLO"));
    assert.ok(hello, "HELLO 行が抽出される");
    // bbox が回転後 page bounds の中に収まっている
    assert.ok(hello.x >= 0 && hello.x + hello.w <= res.w + 1, "x が bounds 内");
    assert.ok(hello.y >= 0 && hello.y + hello.h <= res.h + 1, "y が bounds 内");
  } finally {
    doc.destroy();
  }
});

test("テキストなしページ: lines 空 (エラーにしない)", () => {
  // render-service.test と同じ、空 content stream のページを直接組む
  const pdoc = new mupdf.PDFDocument();
  const resources = pdoc.addObject(pdoc.newDictionary());
  const content = new TextEncoder().encode("q Q\n");
  const pageObj = pdoc.addPage([0, 0, W, H], 0, resources, content);
  pdoc.insertPage(pdoc.countPages(), pageObj);
  const buf = pdoc.saveToBuffer();
  const bytes = Buffer.from(buf.asUint8Array());
  pdoc.destroy();

  const doc = openDoc(bytes);
  try {
    const res = extractPageTextLines(doc, 0);
    assert.equal(Math.round(res.w), W);
    assert.equal(Math.round(res.h), H);
    assert.deepEqual(res.lines, [], "lines は空配列");
  } finally {
    doc.destroy();
  }
});
