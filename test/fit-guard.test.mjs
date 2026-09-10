// fit-width / fit-page 再フィット判定 (src/renderer/fit-guard.js)。
//
// 契約: fit-width は幅が変わらない RO 通知 (横スクロールバー出没 = 高さだけ
// 変化) では再フィットしない。fit-page は幅・高さどちらでも再フィットするが、
// ズーム履歴が A,B,A,B と往復していたら isZoomFlipping が true になる。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldRefitOnResize,
  isZoomFlipping,
  pushZoomHistory,
  FLIP_HISTORY_MAX,
  FLIP_WINDOW_MS,
} from "../src/renderer/fit-guard.js";

test("fit-width: 高さだけ変わった (横バー出没) → 再フィットしない", () => {
  assert.equal(shouldRefitOnResize({ mode: "fit-width", w: 826, h: 1727, lastW: 826, lastH: 1744 }), false);
});

test("fit-width: 幅が変わった → 再フィット (初回 -1 も含む)", () => {
  assert.equal(shouldRefitOnResize({ mode: "fit-width", w: 826, h: 1744, lastW: 1062, lastH: 1744 }), true);
  assert.equal(shouldRefitOnResize({ mode: "fit-width", w: 826, h: 1744, lastW: -1, lastH: -1 }), true);
});

test("fit-page: 幅か高さが変われば再フィット、両方同じなら不要", () => {
  assert.equal(shouldRefitOnResize({ mode: "fit-page", w: 826, h: 1727, lastW: 826, lastH: 1744 }), true);
  assert.equal(shouldRefitOnResize({ mode: "fit-page", w: 800, h: 1744, lastW: 826, lastH: 1744 }), true);
  assert.equal(shouldRefitOnResize({ mode: "fit-page", w: 826, h: 1744, lastW: 826, lastH: 1744 }), false);
});

test("fixed ズームでは再フィットしない", () => {
  assert.equal(shouldRefitOnResize({ mode: "fixed", w: 1, h: 1, lastW: -1, lastH: -1 }), false);
});

test("isZoomFlipping: A,B,A,B を時間窓内で検知", () => {
  let h = [];
  h = pushZoomHistory(h, 0.943, 1000);
  h = pushZoomHistory(h, 1.334, 1500);
  h = pushZoomHistory(h, 0.943, 2000);
  assert.equal(isZoomFlipping(h, 2000), false, "3 件では判定しない");
  h = pushZoomHistory(h, 1.334, 2500);
  assert.equal(isZoomFlipping(h, 2600), true);
  // 時間窓を超えたら往復と見ない
  assert.equal(isZoomFlipping(h, 1000 + FLIP_WINDOW_MS + 1), false);
});

test("isZoomFlipping: 単調変化 (A,B,C,D) や同値連続 (A,A,A,A) は往復ではない", () => {
  const mono = [1, 2, 3, 4].map((z, i) => ({ zoom: z, t: 1000 + i * 100 }));
  assert.equal(isZoomFlipping(mono, 1400), false);
  const same = [1, 1, 1, 1].map((z, i) => ({ zoom: z, t: 1000 + i * 100 }));
  assert.equal(isZoomFlipping(same, 1400), false);
  assert.equal(isZoomFlipping([], 0), false);
  assert.equal(isZoomFlipping(null, 0), false);
});

test("pushZoomHistory は FLIP_HISTORY_MAX に丸め、元配列を変えない", () => {
  const base = [];
  let h = base;
  for (let i = 0; i < FLIP_HISTORY_MAX + 3; i++) h = pushZoomHistory(h, i, i);
  assert.equal(h.length, FLIP_HISTORY_MAX);
  assert.equal(h[h.length - 1].zoom, FLIP_HISTORY_MAX + 2);
  assert.equal(base.length, 0);
});
