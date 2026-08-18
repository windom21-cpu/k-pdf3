// qpdf /Outlines fallback のユニットテスト (2026-08-18)。
//
// 背景: 741MB の PDF を確定保存した直後、しおりの自動取込が mupdf の
// `malloc (740227416 bytes) failed` で無言失敗し「しおりが全部消えた」
// ように見えた実機事故。main.js の kpdf3:get-outline は mupdf が落ちたら
// 同梱 qpdf にファイル経路で読ませて逃がすので、その fallback が mupdf と
// 同じ木 (title / pageNo / children) を返すことをここで担保する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { addFlatOutlinesToPdf } from "../src/backend/pdf-outlines.js";
import { extractOutline } from "../src/backend/mupdf-pdf-info.js";
import { findQpdfBinary } from "../src/main/qpdf-sanitize.js";
import { extractOutlineViaQpdf, convertQpdfOutlines } from "../src/main/qpdf-outline.js";

/** 階層付きしおりを持つ 5 ページの合成 PDF を作って一時ファイルに置く。 */
async function buildFixture() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 5; i++) pdf.addPage([595, 842]);
  const base = await pdf.save();
  const bookmarks = [
    { id: "a", parentId: null, title: "記録表紙", pageNo: 1, sortOrder: 0 },
    { id: "b", parentId: null, title: "申立書", pageNo: 2, sortOrder: 1 },
    { id: "b1", parentId: "b", title: "土地目録", pageNo: 3, sortOrder: 2 },
    { id: "b2", parentId: "b", title: "建物目録", pageNo: 4, sortOrder: 3 },
    { id: "c", parentId: null, title: "報告書（空き巣被害）", pageNo: 5, sortOrder: 4 },
  ];
  const withOutlines = await addFlatOutlinesToPdf(base, bookmarks, [1, 2, 3, 4, 5]);
  const dir = mkdtempSync(join(tmpdir(), "kpdf3-qpdf-outline-"));
  const path = join(dir, "fixture.pdf");
  writeFileSync(path, Buffer.from(withOutlines));
  return { dir, path, bytes: Buffer.from(withOutlines) };
}

test("qpdf fallback は mupdf と同じしおり木 (階層 + CJK タイトル + ページ番号) を返す", async (t) => {
  const qpdfPath = findQpdfBinary();
  if (!qpdfPath) {
    t.skip("qpdf バイナリ未検出 (vendor 同梱なし / PATH になし)");
    return;
  }
  const fx = await buildFixture();
  try {
    const viaMupdf = extractOutline(fx.bytes);
    const viaQpdf = await extractOutlineViaQpdf(fx.path, { qpdfPath });

    assert.deepEqual(
      viaQpdf.map((n) => [n.title, n.pageNo, n.children.length]),
      [
        ["記録表紙", 1, 0],
        ["申立書", 2, 2],
        ["報告書（空き巣被害）", 5, 0],
      ],
    );
    assert.deepEqual(
      viaQpdf[1].children.map((n) => [n.title, n.pageNo]),
      [
        ["土地目録", 3],
        ["建物目録", 4],
      ],
    );
    // mupdf 経路と一致すること (fallback が別物を返さない)。
    assert.deepEqual(viaQpdf, viaMupdf);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("しおりの無い PDF では空配列 (無言 0 件でエラーにしない)", async (t) => {
  const qpdfPath = findQpdfBinary();
  if (!qpdfPath) {
    t.skip("qpdf バイナリ未検出");
    return;
  }
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  const bytes = Buffer.from(await pdf.save());
  const dir = mkdtempSync(join(tmpdir(), "kpdf3-qpdf-outline-"));
  const path = join(dir, "no-outline.pdf");
  writeFileSync(path, bytes);
  try {
    assert.deepEqual(await extractOutlineViaQpdf(path, { qpdfPath }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("壊れた入力 / 存在しないファイルは throw する (呼び元が握って表示できるように)", async (t) => {
  const qpdfPath = findQpdfBinary();
  if (!qpdfPath) {
    t.skip("qpdf バイナリ未検出");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "kpdf3-qpdf-outline-"));
  const path = join(dir, "broken.pdf");
  writeFileSync(path, Buffer.from("not a pdf at all\n"));
  try {
    await assert.rejects(() => extractOutlineViaQpdf(path, { qpdfPath }));
    await assert.rejects(() =>
      extractOutlineViaQpdf(join(dir, "missing.pdf"), { qpdfPath }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qpdf が見つからないときは即 throw (静かに空しおりを返さない)", async () => {
  await assert.rejects(
    () => extractOutlineViaQpdf("/tmp/whatever.pdf", { qpdfPath: null }),
    /qpdf binary not found/,
  );
});

test("convertQpdfOutlines: destpageposfrom1 が無いノードは pageNo=null / kids を再帰", () => {
  const tree = convertQpdfOutlines([
    { title: "章", kids: [{ title: "節", destpageposfrom1: 7, kids: [] }] },
    { title: "解決できない dest", destpageposfrom1: null, kids: [] },
    { title: "0 は無効扱い", destpageposfrom1: 0, kids: [] },
  ]);
  assert.deepEqual(tree, [
    { title: "章", pageNo: null, children: [{ title: "節", pageNo: 7, children: [] }] },
    { title: "解決できない dest", pageNo: null, children: [] },
    { title: "0 は無効扱い", pageNo: null, children: [] },
  ]);
  assert.deepEqual(convertQpdfOutlines(undefined), []);
});
