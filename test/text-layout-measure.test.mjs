// ADR-0028 案 C: 非編集時テキスト表示の共有採寸 measureOverlayTextLayout
//
// viewer の「1 行 = 1 span」絶対配置が使う行分割・行位置 (canonical pt) の
// 数式を stub ctx で固定する。実フォント採寸は DOM が要るのでここでは
// 「wrap / align / baseline / 回転 natural frame / 空行スキップ」の構造を
// 検証する (exporter の drawOverlay / vector ops と同一数式であることが
// 契約 — exporter.js 側のコメント参照)。
//
// stub の規約: 文字幅 = フォント px × 0.5 / 一定、baseline offset
// (textBaseline top→alphabetic の actualBoundingBoxAscent 差) = フォント px × 0.6。
// EXPORT_ZOOM = 12.5 なので canonical pt に直すと 1 文字 = fontSize×0.5 pt、
// baseOff = fontSize×0.6 pt。

import { test } from "node:test";
import assert from "node:assert/strict";
import { measureOverlayTextLayout, EXPORT_ZOOM } from "../src/renderer/exporter.js";

function stubCtx() {
  return {
    font: "",
    textBaseline: "alphabetic",
    measureText(s) {
      const px = parseFloat(this.font); // "150px ..." → 150
      return {
        width: [...s].length * px * 0.5,
        actualBoundingBoxAscent: this.textBaseline === "top" ? 0 : px * 0.6,
      };
    },
  };
}

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test("text overlay: wrap 幅は canonical w × EXPORT_ZOOM、行位置は i×lineHeight+baseOff", () => {
  // fontSize 12 → 1 文字 6pt。w=30pt → 5 文字/行。
  const ov = {
    type: "text",
    x: 10, y: 20, w: 30, h: 24,
    properties: { text: "aaaaaa", fontSize: 12 },
  };
  const r = measureOverlayTextLayout(ov, stubCtx());
  assert.equal(r.rot, 0);
  assert.equal(r.naturalW, 30);
  assert.equal(r.naturalH, 24);
  assert.deepEqual(r.lines.map((l) => l.text), ["aaaaa", "a"]);
  // baseOff = 12×0.6 = 7.2pt、lineHeight = fontSize×1 = 12pt
  approx(r.lines[0].x, 0);
  approx(r.lines[0].baseline, 7.2);
  approx(r.lines[1].baseline, 12 + 7.2);
  assert.equal(EXPORT_ZOOM, 900 / 72);
});

test("text overlay: 空行は含めないが後続行の絶対位置はずれない", () => {
  const ov = {
    type: "text",
    x: 0, y: 0, w: 100, h: 40,
    properties: { text: "A\n\nB", fontSize: 10, lineHeight: 1.5 },
  };
  const r = measureOverlayTextLayout(ov, stubCtx());
  assert.deepEqual(r.lines.map((l) => l.text), ["A", "B"]);
  // lineHeight = 10×1.5 = 15、baseOff = 10×0.6 = 6
  approx(r.lines[0].baseline, 6);
  approx(r.lines[1].baseline, 2 * 15 + 6); // 空行 (i=1) の分を飛ばした絶対位置
});

test("text overlay 90°: natural frame は w/h スワップ、wrap は回転前幅", () => {
  // fontSize 10 → 1 文字 5pt。naturalW = h = 40pt → 8 文字/行。
  const ov = {
    type: "text",
    x: 0, y: 0, w: 20, h: 40,
    properties: { text: "ccccccccc", fontSize: 10, rotation: 90 },
  };
  const r = measureOverlayTextLayout(ov, stubCtx());
  assert.equal(r.rot, 90);
  assert.equal(r.naturalW, 40);
  assert.equal(r.naturalH, 20);
  assert.deepEqual(r.lines.map((l) => l.text), ["cccccccc", "c"]);
});

test("form_field(text): padX=1pt / alignH / alignV middle の per-line 解決", () => {
  // fontSize 12 → 1 文字 6pt。"abc" は 18pt 幅の 1 行。
  const base = {
    type: "form_field",
    x: 0, y: 0, w: 100, h: 30,
    properties: { fieldKind: "text", value: "abc", fontSize: 12 },
  };
  const mk = (alignH) => measureOverlayTextLayout(
    { ...base, properties: { ...base.properties, alignH } }, stubCtx(),
  );
  const left = mk("left");
  const center = mk("center");
  const right = mk("right");
  assert.equal(left.lines.length, 1);
  // lineHeight = 12×1.2 = 14.4、middle: baseY = (30−14.4)/2 = 7.8、baseOff = 7.2
  approx(left.lines[0].baseline, 7.8 + 7.2);
  approx(left.lines[0].x, 1); // padX
  approx(center.lines[0].x, (100 - 18) / 2);
  approx(right.lines[0].x, 100 - 1 - 18);
});

test("form_field(text): alignV top / bottom と複数行", () => {
  // w=14pt (innerW=12pt) → 2 文字/行。"abcd" → ab / cd。
  const ov = {
    type: "form_field",
    x: 0, y: 0, w: 14, h: 60,
    properties: { fieldKind: "text", value: "abcd", fontSize: 12, alignV: "top" },
  };
  const top = measureOverlayTextLayout(ov, stubCtx());
  assert.deepEqual(top.lines.map((l) => l.text), ["ab", "cd"]);
  approx(top.lines[0].baseline, 7.2); // baseY=0
  approx(top.lines[1].baseline, 14.4 + 7.2);
  const bottom = measureOverlayTextLayout(
    { ...ov, properties: { ...ov.properties, alignV: "bottom" } }, stubCtx(),
  );
  // baseY = h − totalH = 60 − 28.8 = 31.2
  approx(bottom.lines[0].baseline, 31.2 + 7.2);
});

test("対象外 overlay は null (stamp / callout / check / 空値)", () => {
  const ctx = stubCtx();
  assert.equal(measureOverlayTextLayout({ type: "stamp", properties: { text: "印" } }, ctx), null);
  assert.equal(
    measureOverlayTextLayout(
      { type: "rect", properties: { kind: "callout", text: "x" } }, ctx,
    ),
    null,
  );
  assert.equal(
    measureOverlayTextLayout(
      { type: "form_field", properties: { fieldKind: "check", value: "on" } }, ctx,
    ),
    null,
  );
  const empty = measureOverlayTextLayout(
    { type: "form_field", x: 0, y: 0, w: 10, h: 10, properties: { fieldKind: "text", value: "" } },
    ctx,
  );
  assert.deepEqual(empty.lines, []);
});
