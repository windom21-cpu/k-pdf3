// pdf-repair unit test — mupdf 修復再保存 fallback (§8.2🔴(1))。
//
// 再現フィクスチャ: /Filter /FlateDecode なのに中身が raw deflate
// (zlib ヘッダ無し) の content stream を持つ PDF。mupdf は寛容に開けるが
// pdf-lib は `Unknown compression method in flate stream` で throw する —
// ユーザーの大部 PDF 別名保存失敗 (175, 253) と同じエラー署名。
// (問題ページ本体は機密のため、この合成 PDF で構図を再現する)

import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import * as mupdf from "mupdf";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { repairPdfBytes, decryptPdfBytesIfEncrypted } from "../src/backend/pdf-repair.js";

/** 1 ページ・A4・content stream が raw deflate (壊れ zlib) の合成 PDF。 */
function buildBrokenFlatePdf() {
  const content = "q 1 0 0 1 0 0 cm 0 0 0 RG 72 72 200 100 re S Q\n";
  const compressed = deflateRawSync(Buffer.from(content, "latin1"));
  const parts = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>\nendobj\n",
  ];
  let pdf = Buffer.from("%PDF-1.4\n", "latin1");
  const offs = [];
  for (const p of parts) {
    offs.push(pdf.length);
    pdf = Buffer.concat([pdf, Buffer.from(p, "latin1")]);
  }
  offs.push(pdf.length);
  pdf = Buffer.concat([
    pdf,
    Buffer.from(
      `4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
      "latin1",
    ),
    compressed,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]);
  const xrefOff = pdf.length;
  let xref = "xref\n0 5\n0000000000 65535 f \n";
  for (const o of offs) xref += String(o).padStart(10, "0") + " 00000 n \n";
  xref += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from(xref, "latin1")]);
}

/** assembleHybridPdf が元 PDF に対して行う pdf-lib 操作一式 (load →
 *  copyPages [strategy source/overlay] → embedPdf [回転ベイク] → save)。 */
async function pdfLibFullPipeline(bytes) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [0]);
  out.addPage(copied);
  await out.embedPdf(src, [0]);
  return out.save();
}

test("フィクスチャ: 壊れ flate は pdf-lib が実事例と同じ署名で throw する", async () => {
  await assert.rejects(
    () => pdfLibFullPipeline(buildBrokenFlatePdf()),
    /flate stream/i,
    "pdf-lib が寛容化したらこの fixture ごと見直す (fallback 不要になる)",
  );
});

test("repairPdfBytes: 修復後は pdf-lib の load/copyPages/embedPdf/save が通る", async () => {
  const repaired = repairPdfBytes(buildBrokenFlatePdf());
  const outBytes = await pdfLibFullPipeline(repaired);
  assert.ok(outBytes.length > 0);
  // ページ数・寸法が保存される (ベクター維持の前提)
  const doc = await PDFDocument.load(repaired, { ignoreEncryption: true });
  assert.equal(doc.getPageCount(), 1);
  const { width, height } = doc.getPage(0).getSize();
  assert.equal(Math.round(width), 595);
  assert.equal(Math.round(height), 842);
});

test("repairPdfBytes: 健全な PDF はページ数・寸法・/Rotate を保って round-trip", async () => {
  const src = await PDFDocument.create();
  src.addPage([595, 842]);
  const p2 = src.addPage([842, 595]);
  p2.drawText("2", { x: 10, y: 10 });
  const p3 = src.addPage([595, 842]);
  p3.setRotation({ type: "degrees", angle: 90 });
  const healthy = Buffer.from(await src.save());

  const repaired = repairPdfBytes(healthy);
  const doc = await PDFDocument.load(repaired, { ignoreEncryption: true });
  assert.equal(doc.getPageCount(), 3);
  assert.equal(Math.round(doc.getPage(0).getSize().width), 595);
  assert.equal(Math.round(doc.getPage(1).getSize().width), 842);
  assert.equal(doc.getPage(2).getRotation().angle % 360, 90);
});

test("repairPdfBytes: PDF でないバイト列は throw (呼び出し側は元エラーへ)", () => {
  assert.throws(() => repairPdfBytes(Buffer.from("not a pdf at all")));
});

// ───────────────────────────────────────────────────────────────────
// 暗号化 PDF (2026-07-14 — 別名保存 `Unknown compression method in flate
// stream: 190, 7` の再発)。挿入した外部 PDF は復号ゲートを通らず暗号化の
// まま blob 保存され、mupdf は開けるのに pdf-lib だけが破綻する。
// ───────────────────────────────────────────────────────────────────

const TEXT = "Kensho0123";

/** 権限のみ暗号化 (ユーザーパスワード空 = 開くのに合言葉が要らない) PDF。
 *  裁判所・登記簿系の配布 PDF に多い形で、mupdf は黙って開ける。 */
async function buildEncryptedPdf(kind = "rc4-128") {
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  src.addPage([595, 842]).drawText(TEXT, { x: 50, y: 700, size: 24, font });
  const doc = mupdf.PDFDocument.openDocument(
    Buffer.from(await src.save()),
    "application/pdf",
  );
  return Buffer.from(
    doc
      .saveToBuffer(`compress,encrypt=${kind},owner-password=owner,permissions=-print`)
      .asUint8Array()
      .slice(),
  );
}

/** 出力 PDF に元の文字が残っているか (= 中身が復号できているか)。 */
function outputHasText(bytes) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf");
  const json = JSON.stringify(doc.loadPage(0).toStructuredText().asJSON());
  return json.includes(TEXT);
}

test("フィクスチャ: 暗号化 PDF は mupdf では開けるが pdf-lib の embedPdf が実事例と同じ署名で throw", async () => {
  const enc = await buildEncryptedPdf();
  const doc = mupdf.Document.openDocument(new Uint8Array(enc), "application/pdf");
  assert.equal(doc.countPages(), 1, "mupdf では普通に開ける (画面・サムネが正常な理由)");
  await assert.rejects(
    () => pdfLibFullPipeline(enc),
    /flate stream/i,
    "pdf-lib に復号機能が付いたらこの経路ごと見直す",
  );
});

test("暗号化 PDF を copyPages で素通しすると無言で白紙ページになる (エラーより悪い事故)", async () => {
  const enc = await buildEncryptedPdf();
  const src = await PDFDocument.load(enc, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [0]); // throw しない
  out.addPage(copied);
  assert.equal(
    outputHasText(await out.save()),
    false,
    "copyPages は暗号化ストリームを素通しする — だから load 前の復号が要る",
  );
});

for (const kind of ["rc4-128", "aes-256"]) {
  test(`decryptPdfBytesIfEncrypted: ${kind} を復号すると pdf-lib 全経路が通り中身も保たれる`, async () => {
    const dec = decryptPdfBytesIfEncrypted(await buildEncryptedPdf(kind));
    assert.equal(dec.includes(Buffer.from("/Encrypt")), false, "暗号化辞書が残っていない");
    const outBytes = await pdfLibFullPipeline(dec); // load/copyPages/embedPdf/save
    assert.ok(outputHasText(outBytes), "白紙化せず文字が残る (ベクター維持)");
    const doc = await PDFDocument.load(dec, { ignoreEncryption: true });
    assert.equal(doc.getPageCount(), 1);
    assert.equal(Math.round(doc.getPage(0).getSize().width), 595);
  });
}

test("decryptPdfBytesIfEncrypted: 非暗号化 PDF は入力そのものを返す (正常系は 1 バイトも触らない)", async () => {
  const src = await PDFDocument.create();
  src.addPage([595, 842]);
  const healthy = Buffer.from(await src.save());
  assert.equal(decryptPdfBytesIfEncrypted(healthy), healthy, "同一オブジェクトを素通し");
});

test("repairPdfBytes: 暗号化を維持したまま再保存しない (修復 retry が同じエラーで落ちない)", async () => {
  const repaired = repairPdfBytes(await buildEncryptedPdf());
  assert.equal(repaired.includes(Buffer.from("/Encrypt")), false);
  assert.ok(outputHasText(await pdfLibFullPipeline(repaired)));
});
