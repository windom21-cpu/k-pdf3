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
import { PDFDocument } from "pdf-lib";
import { repairPdfBytes } from "../src/backend/pdf-repair.js";

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
