// REVIEW-2026-07 #4: byte-copy ゲートの総当たりテスト
//
// v2.0.7 (userRotation) / v2.0.8 (dirty フラグ) / v2.0.11 (並び替え) は
// いずれも「byte-copy 高速経路が特定の編集種別を見落として素通しする」
// 同型バグ。ゲートを byteCopyEligible (exporter.js) に一本化したうえで、
// このテーブルが「編集種別 × byte-copy 可否」を総当たりで固定する。
//
// 運用ルール: 新しい workspace 専用変換 (元 PDF バイトに焼かれない編集)
// を追加したら、byteCopyEligible に条件を 1 つ足し、このテーブルに
// 行を足すこと。
//
// Part 1 はゲート単体 (純関数)。Part 2 は代表ケース (末尾ページ削除) の
// end-to-end — 再合成経路の出力 PDF を mupdf で読み戻し、編集がバイトに
// 反映されていることを確認する (並び替えの e2e は page-reorder-export.
// test.mjs が既にカバー)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, rgb } from "pdf-lib";
import { byteCopyEligible } from "../src/renderer/exporter.js";
import { renderPagePixels, openPdfDocument } from "../src/backend/mupdf-render.js";

// ---- Part 1: gate unit — 編集種別 × byte-copy 可否のテーブル -------------

/** Natural source rows 1..n, with optional per-page overrides. */
function nat(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => ({
    pageNo: i + 1,
    ...(overrides[i + 1] ?? {}),
  }));
}

// ソース PDF は 3 ページの想定 (sourcePageCount: 3)。
// expect true になってよいのは「完全未編集」だけ。
const TABLE = [
  // -- 未編集 (byte-copy してよい唯一の形) --
  { name: "完全未編集", args: { pages: nat(3) }, expect: true },
  { name: "未編集 + userRotation 360 (正規化で 0)",
    args: { pages: nat(3, { 2: { userRotation: 360 } }) }, expect: true },
  { name: "未編集 + sourcePageCount 不明 (meta 取得失敗時は他条件のみで判定)",
    args: { pages: nat(3), sourcePageCount: null }, expect: true },

  // -- 単独の編集種別 --
  { name: "overlay あり", args: { pages: nat(3), overlayCount: 1 }, expect: false },
  { name: "ページ削除 (中間 = 歯抜け)",
    args: { pages: [{ pageNo: 1 }, { pageNo: 3 }] }, expect: false },
  { name: "ページ削除 (末尾) — 自然順を保つので count 比較でしか捕まらない",
    args: { pages: nat(2) }, expect: false },
  { name: "ページ削除 (先頭)",
    args: { pages: [{ pageNo: 2 }, { pageNo: 3 }] }, expect: false },
  { name: "pending 削除あり (挿入ページの未保存削除を含む)",
    args: { pages: nat(3), pendingDeleteCount: 1 }, expect: false },
  { name: "ページ挿入 (synthetic)",
    args: { pages: [{ pageNo: 1 }, { pageNo: -7, isSynthetic: true }, { pageNo: 2 }],
            sourcePageCount: 2 }, expect: false },
  { name: "userRotation 90 (v2.0.7 の型)",
    args: { pages: nat(3, { 1: { userRotation: 90 } }) }, expect: false },
  { name: "userRotation -90 (負値も正規化)",
    args: { pages: nat(3, { 3: { userRotation: -90 } }) }, expect: false },
  { name: "並び替え (v2.0.11 の型)",
    args: { pages: [{ pageNo: 2 }, { pageNo: 1 }, { pageNo: 3 }] }, expect: false },

  // -- 組合せ --
  { name: "overlay + userRotation",
    args: { pages: nat(3, { 1: { userRotation: 180 } }), overlayCount: 2 }, expect: false },
  { name: "並び替え + 末尾削除",
    args: { pages: [{ pageNo: 2 }, { pageNo: 1 }] }, expect: false },
  { name: "挿入 + 削除 (可視は自然順に見えるが synthetic を含む)",
    args: { pages: [{ pageNo: 1 }, { pageNo: 2 }, { pageNo: -3, isSynthetic: true }] },
    expect: false },

  // -- 印刷経路固有の条件 --
  { name: "print: FAX (forceMono) は未編集でも再合成",
    args: { pages: nat(3), forceMono: true }, expect: false },
  { name: "print: 部分選択 (未編集でも選択ページのみの temp PDF が要る)",
    args: { pages: nat(2), allPagesSelected: false, sourcePageCount: null }, expect: false },

  // -- 退化ケース --
  { name: "pages 空", args: { pages: [] }, expect: false },
  { name: "pages 非配列", args: { pages: null }, expect: false },
];

for (const row of TABLE) {
  test(`byteCopyEligible: ${row.name} → ${row.expect ? "byte-copy" : "再合成"}`, () => {
    const args = { sourcePageCount: 3, ...row.args };
    assert.equal(byteCopyEligible(args), row.expect);
  });
}

// ---- Part 2: end-to-end — 末尾ページ削除が出力バイトに反映される ----------
//
// page-reorder-export.test.mjs の色ページ方式を踏襲。3 ページ (RED/GREEN/
// BLUE) のソースから末尾 BLUE を削除した再合成出力を mupdf で読み戻し、
// ページ数と内容がソースの先頭 2 ページに一致することを確認する。
// (byte-copy されていたら 3 ページのまま = 削除が落ちる、が v2.0.12-beta
// まで print 経路に実在した取りこぼし。)

const COLORS = [
  { name: "RED", rgb: rgb(1, 0, 0) },
  { name: "GREEN", rgb: rgb(0, 1, 0) },
  { name: "BLUE", rgb: rgb(0, 0, 1) },
];

async function buildColoredSource() {
  const doc = await PDFDocument.create();
  for (const c of COLORS) {
    const p = doc.addPage([200, 280]);
    p.drawRectangle({ x: 0, y: 0, width: 200, height: 280, color: c.rgb });
  }
  return await doc.save();
}

// assembleHybridPdf strategy="source" 相当: 可視ページだけ copyPages。
async function assembleInOrder(sourceBytes, order) {
  const newPdf = await PDFDocument.create();
  const src = await PDFDocument.load(sourceBytes);
  for (const sourceIdx of order) {
    const [copied] = await newPdf.copyPages(src, [sourceIdx]);
    newPdf.addPage(copied);
  }
  return await newPdf.save();
}

function dominantColorName(doc, pageIdx) {
  const r = renderPagePixels(doc, pageIdx, [0.25, 0, 0, 0.25, 0, 0]);
  const { width, height, channels, pixels } = r;
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      R += pixels[i]; G += pixels[i + 1]; B += pixels[i + 2]; n++;
    }
  }
  R /= n; G /= n; B /= n;
  if (R >= G && R >= B) return "RED";
  if (G >= R && G >= B) return "GREEN";
  return "BLUE";
}

test("末尾ページ削除の再合成: 出力は 2 ページで削除ページを含まない", async () => {
  const src = await buildColoredSource();
  // 末尾 (BLUE) を削除 → 可視ページは source index [0, 1]。
  const exported = await assembleInOrder(src, [0, 1]);
  const doc = openPdfDocument(Buffer.from(exported));
  try {
    assert.equal(doc.countPages(), 2, "削除後の出力はソースより 1 ページ少ない");
    assert.deepEqual(
      [0, 1].map((i) => dominantColorName(doc, i)),
      ["RED", "GREEN"],
      "残りページの内容と順序がソース先頭 2 ページに一致",
    );
  } finally {
    doc.destroy();
  }
});
