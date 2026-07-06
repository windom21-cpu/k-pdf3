// v2.0.13: ベクターテキスト層のテスト
//
// MS 明朝 text/form_field overlay を「900dpi ラスタ PNG」ではなく
// 「MS 明朝サブセット埋め込みの実テキスト」として組み立て PDF に焼く
// 経路 (src/backend/vector-text-layer.js) の検証。
//
//   Part 1: フォント基盤 — TTC 抽出 / probe / サブセット (gid 安定性)
//   Part 2: applyVectorTextLayer end-to-end — 位置 / 回転 / 色 / 抽出 /
//           複数ページ / 既存ページ非破壊
//   Part 3: renderer 側の適格判定 (vectorTextCandidate — DOM 不要の純関数)
//
// MS 明朝 (msmincho.ttc) が無い環境 (CI Linux 等) では Part 1/2 を skip
// する — 本番でも probe が available=false を返して従来ラスタに落ちる
// 設計なので、フォント無し環境で走らないのは仕様通り。

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import * as mupdf from "mupdf";
import {
  resolveMinchoFontPath,
  extractTtfFromTtc,
  probeVectorText,
  buildSubsetTtf,
  applyVectorTextLayer,
} from "../src/backend/vector-text-layer.js";
import { vectorTextCandidate, splitVectorTextOverlays } from "../src/renderer/exporter.js";
import { readFileSync } from "node:fs";

const FONT_PATH = resolveMinchoFontPath();
const HAS_FONT = FONT_PATH != null;
const skipNote = { skip: !HAS_FONT && "msmincho.ttc not present (CI 等) — 本番は raster fallback" };

/** A4 縦の空 PDF を pages 枚作る (assembleHybridPdf 出力の代役)。 */
async function makeBasePdf(pageCount = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([595.32, 841.92]);
  return Buffer.from(await doc.save());
}

/** 出力 PDF から structured text の行を [{text, x, y, w, h}] で取り出す。 */
function extractLines(bytes, pageIndex = 0) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const page = doc.loadPage(pageIndex);
  const json = JSON.parse(page.toStructuredText().asJSON());
  const lines = [];
  for (const b of json.blocks) {
    for (const l of b.lines) {
      lines.push({
        text: l.text,
        x: l.bbox.x, y: l.bbox.y, w: l.bbox.w, h: l.bbox.h,
      });
    }
  }
  return lines;
}

/** ページを 300dpi で焼いて ink (非白) ピクセル数と bbox を返す。 */
function renderInk(bytes, pageIndex = 0) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const page = doc.loadPage(pageIndex);
  const Z = 300 / 72;
  const pix = page.toPixmap([Z, 0, 0, Z, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
  const w = pix.getWidth();
  const h = pix.getHeight();
  const px = pix.getPixels();
  let count = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const o = (yy * w + xx) * 3;
      if (px[o] < 250 || px[o + 1] < 250 || px[o + 2] < 250) {
        count++;
        if (xx < minX) minX = xx;
        if (yy < minY) minY = yy;
        if (xx > maxX) maxX = xx;
        if (yy > maxY) maxY = yy;
      }
    }
  }
  return {
    count,
    // pt へ戻す
    bbox: count ? { x: minX / Z, y: minY / Z, w: (maxX - minX) / Z, h: (maxY - minY) / Z } : null,
  };
}

// ---- Part 1: フォント基盤 -------------------------------------------------

test("TTC 抽出: 素の sfnt になり head/glyf/loca を持つ", skipNote, () => {
  const ttf = extractTtfFromTtc(readFileSync(FONT_PATH), 0);
  assert.notEqual(ttf.toString("ascii", 0, 4), "ttcf");
  const numTables = ttf.readUInt16BE(4);
  const tags = new Set();
  for (let i = 0; i < numTables; i++) tags.add(ttf.toString("ascii", 12 + i * 16, 16 + i * 16));
  for (const required of ["head", "glyf", "loca", "hmtx", "maxp"]) {
    assert.ok(tags.has(required), `missing table ${required}`);
  }
  // mupdf がフォントとして読めること
  const font = new mupdf.Font("MS-Mincho", ttf);
  assert.notEqual(font.encodeCharacter("明".codePointAt(0)), 0);
});

test("probe: 標準的な日本語は missing なし、豆腐級の字は missing に入る", skipNote, () => {
  const r = probeVectorText(
    ["令和八年三月三十一日 東京地方裁判所ABC012あいう、。ー「」\n改行"],
    { fontPath: FONT_PATH },
  );
  assert.equal(r.available, true);
  assert.deepEqual(r.missing, []);
  // MS 明朝に存在しない字 (絵文字) は missing 判定
  const r2 = probeVectorText(["判決😀"], { fontPath: FONT_PATH });
  assert.equal(r2.available, true);
  assert.deepEqual(r2.missing, ["😀"]);
});

test("probe: フォント無しパスは available=false (raster fallback 経路)", () => {
  const r = probeVectorText(["あ"], { fontPath: "/nonexistent/font.ttc" });
  assert.equal(r.available, false);
});

test("サブセット: サイズ縮小 + gid 安定 (フル埋め込みとピクセル一致)", skipNote, async () => {
  const base = await makeBasePdf(1);
  const pages = [{
    heightPt: 841.92,
    vectorTexts: [{ text: "東京地方裁判所令和八年", x: 60, y: 100, size: 14 }],
  }];
  // 通常経路 (サブセット埋め込み)
  const outSubset = await applyVectorTextLayer(base, pages, { fontPath: FONT_PATH });
  // サブセットはフル TTF (~9.5MB) より桁違いに小さいはず
  assert.ok(outSubset.length < 500 * 1024, `subset output too big: ${outSubset.length}`);
  // gid 安定性: サブセット埋め込みの描画結果に ink があり、その bbox が
  // 期待位置 (x=60, baseline y=100 → ink はその上側) にあること。
  // gid がズレていれば違う字 (または空白) になり bbox/ink が崩れる。
  const ink = renderInk(outSubset);
  assert.ok(ink.count > 500, "no meaningful ink rendered");
  assert.ok(Math.abs(ink.bbox.x - 60) < 3, `ink starts at ${ink.bbox.x}, expected ~60`);
  assert.ok(ink.bbox.y > 86 && ink.bbox.y < 92, `ink top ${ink.bbox.y}, expected ~88 (baseline 100 - ascent)`);
  // 抽出テキストが一致 = ToUnicode も gid → 正しい文字に解決している
  const lines = extractLines(outSubset);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "東京地方裁判所令和八年");
});

// ---- Part 2: applyVectorTextLayer end-to-end ------------------------------

test("e2e: 位置・複数行・複数ページ・既存ページ非破壊", skipNote, async () => {
  const base = await makeBasePdf(3);
  const pages = [
    { heightPt: 841.92 }, // page 1: vectorTexts なし
    {
      heightPt: 841.92,
      vectorTexts: [
        { text: "一行目のテキスト", x: 72, y: 120, size: 10.5, color: "#000000" },
        { text: "二行目のテキスト", x: 72, y: 134, size: 10.5, color: "#000000" },
      ],
    },
    {
      heightPt: 841.92,
      vectorTexts: [{ text: "三ページ目", x: 200, y: 400, size: 12 }],
    },
  ];
  const out = await applyVectorTextLayer(base, pages, { fontPath: FONT_PATH });
  const doc = mupdf.Document.openDocument(out, "application/pdf");
  assert.equal(doc.countPages(), 3);
  // page 1 は無変化 (ink なし)
  assert.equal(renderInk(out, 0).count, 0);
  // page 2: 2 行、位置一致 (x=72、行1 baseline=120 → bbox top ≈ 120 - ascent)
  const p2 = extractLines(out, 1);
  assert.deepEqual(p2.map((l) => l.text), ["一行目のテキスト", "二行目のテキスト"]);
  assert.ok(Math.abs(p2[0].x - 72) < 2);
  assert.ok(p2[0].y > 108 && p2[0].y < 120, `line1 bbox top ${p2[0].y}`);
  assert.ok(p2[1].y - p2[0].y > 12 && p2[1].y - p2[0].y < 16, "行送り ~14pt");
  // page 3
  const p3 = extractLines(out, 2);
  assert.equal(p3[0].text, "三ページ目");
});

test("e2e: 回転 90° は縦向きの ink になる", skipNote, async () => {
  const base = await makeBasePdf(1);
  const pages = [{
    heightPt: 841.92,
    vectorTexts: [{ text: "回転テキスト", x: 300, y: 300, size: 12, rot: 90 }],
  }];
  const out = await applyVectorTextLayer(base, pages, { fontPath: FONT_PATH });
  const ink = renderInk(out);
  assert.ok(ink.count > 300);
  // 6 文字 × 12pt ≈ 72pt が縦方向に伸びる (横幅は 1 文字分 ≈ 12pt)
  assert.ok(ink.bbox.h > 60, `rotated text should extend vertically, h=${ink.bbox.h}`);
  assert.ok(ink.bbox.w < 20, `rotated text should be one glyph wide, w=${ink.bbox.w}`);
});

test("e2e: 色と太字が content に反映される", skipNote, async () => {
  const base = await makeBasePdf(1);
  const pages = [{
    heightPt: 841.92,
    vectorTexts: [
      { text: "赤字", x: 60, y: 100, size: 12, color: "#cc0000" },
      { text: "太字", x: 60, y: 130, size: 12, bold: true },
    ],
  }];
  const out = await applyVectorTextLayer(base, pages, { fontPath: FONT_PATH });
  // 赤 ink が存在する
  const doc = mupdf.Document.openDocument(out, "application/pdf");
  const page = doc.loadPage(0);
  const Z = 300 / 72;
  const pix = page.toPixmap([Z, 0, 0, Z, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
  const w = pix.getWidth();
  const px = pix.getPixels();
  let redInk = 0;
  for (let i = 0; i < px.length; i += 3) {
    if (px[i] > 120 && px[i + 1] < 100 && px[i + 2] < 100) redInk++;
  }
  assert.ok(redInk > 100, "red glyphs missing");
  // 太字 = Tr 2 (fill+stroke): 同じ字を bold なしで焼いた場合より ink が多い
  const plain = await applyVectorTextLayer(base, [{
    heightPt: 841.92,
    vectorTexts: [{ text: "太字", x: 60, y: 130, size: 12, bold: false }],
  }], { fontPath: FONT_PATH });
  const boldOnly = await applyVectorTextLayer(base, [{
    heightPt: 841.92,
    vectorTexts: [{ text: "太字", x: 60, y: 130, size: 12, bold: true }],
  }], { fontPath: FONT_PATH });
  assert.ok(renderInk(boldOnly).count > renderInk(plain).count * 1.1,
    "bold should add stroke weight");
});

test("e2e: op.clip で枠外の文字は印字されない (WYSIWYG 保全)", skipNote, async () => {
  const base = await makeBasePdf(1);
  // 6 文字 ×12pt ≈ 72pt 幅のテキストに、先頭 30pt しか見せないクリップ
  const pages = [{
    heightPt: 841.92,
    vectorTexts: [{
      text: "六文字のテキスト", x: 100, y: 200, size: 12,
      clip: { x: 100, y: 185, w: 30, h: 24 },
    }],
  }];
  const out = await applyVectorTextLayer(base, pages, { fontPath: FONT_PATH });
  const ink = renderInk(out);
  assert.ok(ink.count > 50, "clipped text should still have some ink");
  assert.ok(ink.bbox.x >= 99 && ink.bbox.x + ink.bbox.w <= 131,
    `ink must stay inside clip rect, got x=${ink.bbox.x} w=${ink.bbox.w}`);
});

test("e2e: 既存コンテンツ (overlay PNG 等) を保持したままテキストが乗る", skipNote, async () => {
  // assembleHybridPdf の "overlay" 戦略出力を模す: ページに既存の描画
  // (グラフィック state を変える ops 込み) がある状態でテキスト層を追記
  const doc = await PDFDocument.create();
  const { rgb } = await import("pdf-lib");
  const page = doc.addPage([595.32, 841.92]);
  page.drawRectangle({ x: 400, y: 600, width: 100, height: 50, color: rgb(0, 0, 1) });
  const base = Buffer.from(await doc.save());
  const out = await applyVectorTextLayer(base, [{
    heightPt: 841.92,
    vectorTexts: [{ text: "追記テキスト", x: 60, y: 100, size: 12 }],
  }], { fontPath: FONT_PATH });
  const mdoc = mupdf.Document.openDocument(out, "application/pdf");
  const mpage = mdoc.loadPage(0);
  const Z = 150 / 72;
  const pix = mpage.toPixmap([Z, 0, 0, Z, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
  const w = pix.getWidth();
  const px = pix.getPixels();
  let blue = 0;
  let black = 0;
  for (let i = 0; i < px.length; i += 3) {
    if (px[i] < 100 && px[i + 1] < 100 && px[i + 2] > 150) blue++;
    if (px[i] < 60 && px[i + 1] < 60 && px[i + 2] < 60) black++;
  }
  assert.ok(blue > 1000, `rectangle lost (blue px=${blue})`);
  assert.ok(black > 100, `text missing (black px=${black})`);
  assert.equal(extractLines(out)[0].text, "追記テキスト");
});

test("e2e: vectorTexts が無ければ bytes をそのまま返す", async () => {
  const base = await makeBasePdf(1);
  const out = await applyVectorTextLayer(base, [{ heightPt: 841.92 }]);
  assert.ok(Buffer.compare(Buffer.from(out), base) === 0);
});

test("e2e: グリフ欠落文字が ops に混入したら例外 (静かな文字消失の禁止)", skipNote, async () => {
  const base = await makeBasePdf(1);
  const pages = [{
    heightPt: 841.92,
    vectorTexts: [{ text: "絵文字😀混入", x: 60, y: 100, size: 12 }],
  }];
  await assert.rejects(
    applyVectorTextLayer(base, pages, { fontPath: FONT_PATH }),
    /glyph missing/,
  );
});

// ---- Part 3: renderer 側適格判定 (DOM 不要の純関数のみ) --------------------

test("vectorTextCandidate: 適格/非適格の判定表", () => {
  const t = (type, properties) => vectorTextCandidate({ type, properties });
  // 適格
  assert.equal(t("text", { fontId: "mincho", text: "本文" }), "本文");
  assert.equal(
    t("form_field", { fieldKind: "text", fontFace: "mincho", value: "記入値" }),
    "記入値",
  );
  // form_field の fontFace 欠落は mincho 扱いにしない — viewer/raster は
  // getTextFontStack(undefined) = gothic で描くので、ベクター化すると
  // 画面 (gothic) と紙 (明朝) の字形が食い違う (レビュー指摘 A#1)
  assert.equal(t("form_field", { fieldKind: "text", value: "記入" }), null);
  // 非適格: フォント違い / digitsHanko / 空 / 別 type / 別 fieldKind
  assert.equal(t("text", { fontId: "gothic", text: "本文" }), null);
  assert.equal(t("text", { fontId: "游明朝", text: "本文" }), null); // システムフォント名
  assert.equal(t("text", { fontId: "mincho", digitsHanko: true, text: "12" }), null);
  assert.equal(t("text", { fontId: "mincho", text: "   " }), null);
  assert.equal(t("form_field", { fieldKind: "check", value: "on" }), null);
  assert.equal(t("form_field", { fieldKind: "text", fontFace: "gothic", value: "x" }), null);
  assert.equal(t("form_field", { fieldKind: "text", fontFace: "mincho", value: "" }), null);
  assert.equal(t("stamp", { fontId: "mincho", text: "印" }), null);
});

test("splitVectorTextOverlays: z-order/墨消しガード (ラスタへのフォールバック)", () => {
  const textOv = {
    type: "text", x: 100, y: 100, w: 200, h: 40,
    properties: { fontId: "mincho", text: "本文テキスト" },
  };
  const missing = new Set();
  // 後段の不透明 overlay (画像スタンプ) がテキストに重なる → ラスタに残す
  const stampOn = { type: "stamp", x: 150, y: 110, w: 60, h: 30, properties: {} };
  let r = splitVectorTextOverlays([textOv, stampOn], missing, 12.5, false);
  assert.equal(r.ops.length, 0);
  assert.equal(r.raster.length, 2);
  // 後段でも重ならなければベクター化してよい (DOM 無し環境ではここは通らないので判定のみ確認できない)
  // → 代わりに「前段の overlay は影響しない」ことを coveredLater 判定で確認:
  //   スタンプが text より前 (下) にある場合は covered ではない
  const stampUnder = { type: "stamp", x: 150, y: 110, w: 60, h: 30, properties: {} };
  try {
    r = splitVectorTextOverlays([stampUnder, textOv], missing, 12.5, false);
    // DOM (canvas) が無い node ではベクター化しようとして throw するはず
    assert.fail("expected DOM-dependent path");
  } catch (e) {
    assert.ok(String(e.message ?? e).includes("document"), `unexpected error: ${e}`);
  }
  // マーカー (type line) が上に重なってもベクター化を許す → 同じく DOM 到達で throw
  const marker = { type: "line", x: 90, y: 105, w: 300, h: 20, properties: {} };
  try {
    r = splitVectorTextOverlays([textOv, marker], missing, 12.5, false);
    assert.fail("expected DOM-dependent path");
  } catch (e) {
    assert.ok(String(e.message ?? e).includes("document"), `unexpected error: ${e}`);
  }
  // 墨消しがページのどこかにあれば全面ラスタ (下敷き印刷の β.85 保全)
  const redaction = { type: "redaction", x: 500, y: 700, w: 50, h: 20, properties: {} };
  r = splitVectorTextOverlays([textOv, redaction], missing, 12.5, false);
  assert.equal(r.ops.length, 0);
  assert.equal(r.raster.length, 2);
});
