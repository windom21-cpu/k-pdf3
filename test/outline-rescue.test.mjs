// 確定/別名保存の「元 PDF の /Outlines 救済」テスト (2026-08-18)。
//
// 背景: workspace しおりが 0 件のとき、export-pdf-rasterized は /Outlines の
// write-back を丸ごとスキップしていた。pdf-lib 再合成は元 PDF の /Outlines を
// 運ばないので、0 件のまま確定するとファイルからしおりが消える。741MB PDF で
// 自動取込が OOM した実機事故では、マスター workspace 側にしおりが残っていた
// から助かっただけだった。
// ユーザー決定 (2026-08-18):「しおりを意図的に全部消す運用は無い」→ 0 件なら
// 元 PDF のしおりをそのまま書き戻す。
//
// ここでは救済経路の合成 (extractOutline → outlineToFlatBookmarks →
// addFlatOutlinesToPdf) が、階層・CJK タイトル・ページ対応を保ったまま
// 往復することを担保する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { addFlatOutlinesToPdf, outlineToFlatBookmarks } from "../src/backend/pdf-outlines.js";
import { extractOutline } from "../src/backend/mupdf-pdf-info.js";

/** n ページの素の PDF。 */
async function blankPdf(n) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < n; i++) pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save());
}

/** 階層付きしおりを持つ 5 ページ PDF (= 確定前の「元 PDF」相当)。 */
async function pdfWithOutlines() {
  const base = await blankPdf(5);
  const bookmarks = [
    { id: "a", parentId: null, title: "記録表紙", pageNo: 1, sortOrder: 0 },
    { id: "b", parentId: null, title: "申立書", pageNo: 2, sortOrder: 1 },
    { id: "b1", parentId: "b", title: "土地目録", pageNo: 3, sortOrder: 2 },
    { id: "b2", parentId: "b", title: "建物目録", pageNo: 4, sortOrder: 3 },
    { id: "c", parentId: null, title: "報告書（空き巣被害）", pageNo: 5, sortOrder: 4 },
  ];
  return Buffer.from(await addFlatOutlinesToPdf(base, bookmarks, [1, 2, 3, 4, 5]));
}

test("救済経路: workspace 0 件でも元 PDF のしおりが階層ごと出力に載る", async () => {
  const src = await pdfWithOutlines();
  const srcOutline = extractOutline(src);

  // 確定 = 再合成された無しおり PDF に、元 PDF から拾ったしおりを書き戻す。
  const flattened = await blankPdf(5);
  const rescued = outlineToFlatBookmarks(srcOutline);
  const out = await addFlatOutlinesToPdf(flattened, rescued, [1, 2, 3, 4, 5]);

  assert.deepEqual(extractOutline(Buffer.from(out)), srcOutline);
});

test("救済しないと出力からしおりが消える (回帰の見張り)", async () => {
  const flattened = await blankPdf(5);
  assert.deepEqual(extractOutline(flattened), []);
});

test("削除ページを指す元しおりは落ちるが、子は繰り上がって残る", async () => {
  const src = await pdfWithOutlines();
  const rescued = outlineToFlatBookmarks(extractOutline(src));
  // p.2「申立書」を削除して確定したケース: 出力は 4 ページ。
  const flattened = await blankPdf(4);
  const out = await addFlatOutlinesToPdf(flattened, rescued, [1, 3, 4, 5]);
  const tree = extractOutline(Buffer.from(out));
  assert.deepEqual(
    tree.map((n) => [n.title, n.pageNo, n.children.length]),
    [
      ["記録表紙", 1, 0],
      // 「申立書」は消えるが子が top-level に繰り上がる
      ["土地目録", 2, 0],
      ["建物目録", 3, 0],
      ["報告書（空き巣被害）", 4, 0],
    ],
  );
});

test("outlineToFlatBookmarks: 階層を parentId + sortOrder に落とす", () => {
  const flat = outlineToFlatBookmarks([
    {
      title: "第1章",
      pageNo: 2,
      children: [{ title: "第1節", pageNo: 3, children: [] }],
    },
    { title: "付録", pageNo: 9, children: [] },
  ]);
  assert.equal(flat.length, 3);
  assert.deepEqual(
    flat.map((b) => [b.title, b.pageNo, b.sortOrder]),
    [
      ["第1章", 2, 0],
      ["第1節", 3, 1],
      ["付録", 9, 2],
    ],
  );
  assert.equal(flat[0].parentId, null);
  assert.equal(flat[1].parentId, flat[0].id);
  assert.equal(flat[2].parentId, null);
});

test("outlineToFlatBookmarks: ページを持たない見出しは親のページを継承 / 空タイトルは (無題)", () => {
  const flat = outlineToFlatBookmarks([
    {
      title: "",
      pageNo: null,
      children: [{ title: "本文", pageNo: null, children: [] }],
    },
    { title: "章のみ", pageNo: 0, children: [] },
  ]);
  assert.deepEqual(
    flat.map((b) => [b.title, b.pageNo]),
    [
      ["(無題)", 1], // 親なし + ページなし → 1 ページ目
      ["本文", 1], // 親のページを継承
      ["章のみ", 1], // pageNo 0 は無効扱い
    ],
  );
  assert.deepEqual(outlineToFlatBookmarks(undefined), []);
});
