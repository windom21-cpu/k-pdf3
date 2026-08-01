// 回転済み吹き出し (props.rotation 90/270) の自動フィット軸写像。
//
// 契約 (viewer.js 回転 textNode / exporter.js drawOverlay): canonical の
// w/h は回転後の外枠、本文は回転前 (natural) の枠で折り返す — 90/270 では
// naturalW = canonical h / naturalH = canonical w。overlay-edit.js の
// リサイズ (handleOverlayResizeEnd)・書式変更 (fitCalloutBox)・本文 commit
// (handleTextEditCommit) は natural frame で採寸して canonical に転置して
// 返すこと、および rot=0/180 の従来経路が 1 バイトも変わらないことを固定。
//
// stub の規約は text-layout-measure.test.mjs と同じ: 文字幅 = フォント px
// × 0.5 / 一定。fontSize 12 → 1 文字 6pt。CALLOUT_PAD_X=5 → 内寸 = w−10。
// measureCalloutMinWidth は widest の floor が fontSize なので minW = 22。

import { test } from "node:test";
import assert from "node:assert/strict";

function stubCtx() {
  return {
    font: "",
    measureText(s) {
      const px = parseFloat(this.font); // "12px ..." → 12
      return { width: [...s].length * px * 0.5 };
    },
  };
}
globalThis.document = {
  createElement: () => ({ getContext: () => stubCtx() }),
};

const {
  initOverlayEdit,
  fitCalloutBox,
  handleOverlayResizeEnd,
  handleTextEditCommit,
} = await import("../src/renderer/overlay-edit.js");

function makeHarness(overlays) {
  const store = {
    get: (id) => overlays[id],
  };
  const hist = { last: null, execute(cmd) { this.last = cmd; } };
  initOverlayEdit({
    isOpen: () => true,
    projectStore: () => store,
    history: () => hist,
    viewer: { _pages: [] },
  });
  return hist;
}

const callout = (extra, props) => ({
  id: "c1",
  type: "rect",
  pageNo: 1,
  x: 0,
  y: 0,
  ...extra,
  properties: { kind: "callout", text: "aaaa", fontSize: 12, ...props },
});

// ---- fitCalloutBox ----------------------------------------------------

test("fitCalloutBox rot=0: 従来どおり幅維持 + 折返し高さ", () => {
  const r = fitCalloutBox(callout({ w: 40, h: 5 }, {}));
  // naturalW = max(40, minW 22) = 40 → 内寸 30 に "aaaa"(24pt) は 1 行
  // → h = 12×1 + 上下 border 2 = 14
  assert.deepEqual(r, { w: 40, h: 14 });
});

test("fitCalloutBox rot=180: rot=0 と同一 (転置なし)", () => {
  const r = fitCalloutBox(callout({ w: 40, h: 5 }, { rotation: 180 }));
  assert.deepEqual(r, { w: 40, h: 14 });
});

test("fitCalloutBox rot=90: natural 幅 = canonical h で採寸し転置して返す", () => {
  const r = fitCalloutBox(callout({ w: 5, h: 40 }, { rotation: 90 }));
  // naturalW = max(ov.h 40, minW 22) = 40 → naturalH = 14 → 転置
  assert.deepEqual(r, { w: 14, h: 40 });
});

test("fitCalloutBox rot=270: 90 と同じ軸写像", () => {
  const r = fitCalloutBox(callout({ w: 5, h: 40 }, { rotation: 270 }));
  assert.deepEqual(r, { w: 14, h: 40 });
});

// ---- handleOverlayResizeEnd ------------------------------------------

test("resize rot=0: 従来どおり w 維持・h スナップ (回帰)", () => {
  const hist = makeHarness({ c1: callout({ w: 40, h: 14 }, {}) });
  handleOverlayResizeEnd("c1", { x: 0, y: 0, w: 24, h: 5 });
  // naturalW = max(24, 22) = 24 → 内寸 14 → "aa"/"aa" の 2 行 → h = 26
  assert.deepEqual(hist.last.patch, { x: 0, y: 0, w: 24, h: 26 });
});

test("resize rot=90: ドラッグの h が natural 幅、w が折返し高さにスナップ", () => {
  const hist = makeHarness({ c1: callout({ w: 14, h: 40 }, { rotation: 90 }) });
  handleOverlayResizeEnd("c1", { x: 2, y: 3, w: 20, h: 60 });
  // naturalW = max(bbox.h 60, 22) = 60 → 1 行 → naturalH 14 → 転置
  assert.deepEqual(hist.last.patch, { x: 2, y: 3, w: 14, h: 60 });
});

test("resize rot=90: 本文より小さく縮めても natural 軸で最小に戻る", () => {
  const hist = makeHarness({ c1: callout({ w: 14, h: 40 }, { rotation: 90 }) });
  handleOverlayResizeEnd("c1", { x: 0, y: 0, w: 20, h: 10 });
  // naturalW = max(10, minW 22) = 22 → 内寸 12 → "aa"×2 行 → naturalH 26
  assert.deepEqual(hist.last.patch, { x: 0, y: 0, w: 26, h: 22 });
});

// ---- handleTextEditCommit (visible size 経路) -------------------------

test("commit rot=0: 報告された可視サイズをそのまま保存 (回帰)", () => {
  const hist = makeHarness({ c1: callout({ w: 40, h: 14 }, {}) });
  handleTextEditCommit("c1", "xyz", { visibleCanonicalW: 50, visibleCanonicalH: 13 });
  assert.equal(hist.last.patch.w, 50);
  assert.equal(hist.last.patch.h, 13);
  assert.equal(hist.last.patch.properties.text, "xyz");
});

test("commit rot=90 (callout): 直立エディタの可視サイズを転置して保存", () => {
  const hist = makeHarness({ c1: callout({ w: 14, h: 40 }, { rotation: 90 }) });
  handleTextEditCommit("c1", "xyz", { visibleCanonicalW: 50, visibleCanonicalH: 13 });
  // naturalW = max(40, 50) = 50 / naturalH = max(12, 13) = 13 → 転置
  assert.equal(hist.last.patch.w, 13);
  assert.equal(hist.last.patch.h, 50);
});

test("commit rot=90 (text overlay): 同じ転置が掛かる", () => {
  const hist = makeHarness({
    t1: {
      id: "t1", type: "text", pageNo: 1, x: 0, y: 0, w: 13, h: 50,
      properties: { text: "old", fontSize: 12, rotation: 90 },
    },
  });
  handleTextEditCommit("t1", "xyz", { visibleCanonicalW: 60, visibleCanonicalH: 15 });
  assert.equal(hist.last.patch.w, 15);
  assert.equal(hist.last.patch.h, 60);
});
