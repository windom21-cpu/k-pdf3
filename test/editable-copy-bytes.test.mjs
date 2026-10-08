// ADR-0030「編集可能として別名保存」— makeDistinctPdfBytes の単体テスト。
//
// 別名コピーが元ファイルと同じ workspace を共有しない (= fingerprint が
// 違う) ことがこの機能の成立条件。同時に「見た目は同じ」(ページ数不変・
// 元バイト列が先頭からそのまま残る・mupdf で開ける) を固定する。
//
// Plain node で走る (mupdf は WASM)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as mupdf from "mupdf";
import { makeDistinctPdfBytes } from "../src/backend/editable-copy-bytes.js";

function sha256(b) {
  return createHash("sha256").update(b).digest("hex");
}

function buildPdf(pageCount = 2) {
  const doc = new mupdf.PDFDocument();
  const empty = new TextEncoder().encode("q Q\n");
  for (let i = 0; i < pageCount; i++) {
    const resources = doc.addObject(doc.newDictionary());
    const pageObj = doc.addPage([0, 0, 595, 842], 0, resources, empty);
    doc.insertPage(doc.countPages(), pageObj);
  }
  const bytes = Buffer.from(doc.saveToBuffer("").asUint8Array().slice());
  doc.destroy();
  return bytes;
}

function countPages(bytes) {
  const doc = mupdf.PDFDocument.openDocument(bytes, "application/pdf");
  try {
    return doc.countPages();
  } finally {
    doc.destroy();
  }
}

test("incremental: fingerprint differs, prefix preserved, page count intact", () => {
  const src = buildPdf(2);
  const { bytes, method } = makeDistinctPdfBytes(src, { stamp: "2026-10-08T00:00:00Z test" });
  assert.equal(method, "incremental");
  assert.notEqual(sha256(bytes), sha256(src), "fingerprint must differ");
  assert.ok(bytes.length > src.length, "incremental update appends");
  assert.ok(bytes.subarray(0, src.length).equals(src), "original bytes kept verbatim at the front");
  assert.equal(countPages(bytes), 2, "page count unchanged");
  assert.match(bytes.subarray(src.length).toString("latin1"), /KPDF3EditableCopy/);
});

test("two copies of the same source get different fingerprints", () => {
  const src = buildPdf(1);
  const a = makeDistinctPdfBytes(src, { stamp: "stamp-A" }).bytes;
  const b = makeDistinctPdfBytes(src, { stamp: "stamp-B" }).bytes;
  assert.notEqual(sha256(a), sha256(b));
  // そして複製の複製も元とも互いとも違う (孫コピーのケース)。
  const aa = makeDistinctPdfBytes(a, { stamp: "stamp-AA" }).bytes;
  assert.notEqual(sha256(aa), sha256(a));
  assert.equal(countPages(aa), 1);
});

test("same stamp twice is deterministic (caller must vary the stamp on collision)", () => {
  const src = buildPdf(1);
  const a = makeDistinctPdfBytes(src, { stamp: "same" }).bytes;
  const b = makeDistinctPdfBytes(src, { stamp: "same" }).bytes;
  assert.equal(sha256(a), sha256(b));
});

test("fallback (append) when the source exceeds the incremental size cap", () => {
  const src = buildPdf(1);
  const { bytes, method } = makeDistinctPdfBytes(src, {
    stamp: "big",
    maxIncrementalBytes: 10, // force the fallback path
  });
  assert.equal(method, "append");
  assert.notEqual(sha256(bytes), sha256(src));
  assert.ok(bytes.subarray(0, src.length).equals(src));
  assert.equal(countPages(bytes), 1, "trailing comment is ignored by the reader");
});

test("fallback (append) when the bytes are not a parseable PDF", () => {
  const junk = Buffer.from("%PDF-1.4\nthis is not really a pdf\n%%EOF\n", "latin1");
  const { bytes, method } = makeDistinctPdfBytes(junk, { stamp: "junk" });
  assert.equal(method, "append");
  assert.ok(bytes.subarray(0, junk.length).equals(junk));
  assert.notEqual(sha256(bytes), sha256(junk));
});
