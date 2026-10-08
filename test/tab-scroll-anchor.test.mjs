// タブ復帰のスクロール位置 = ページ基準アンカー (2026-10-08)。
//
// 「別タブへ行ってスクロール → 元タブに戻ると違うページが表示される」の
// 根因は、復元が scrollTop の生値だったこと: 復帰時にズームが違う / fit が
// 別ページ幅で再計算された、のどちらでも同じ scrollTop は別ページを指す。
// viewer.getScrollAnchor (ページ + ページ内相対位置 + nav pin) と
// viewer.scrollTopForAnchor (現在レイアウトで引き直し) を、DOM 無しの
// 疑似 viewer (layout / registry / container.scrollTop だけ) で検証する。
//
// Plain node で走る (viewer.js は import 時に DOM を触らない)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { Viewer } from "../src/renderer/viewer.js";
import { PageRegistry } from "../src/domain/page-registry.js";

const GAP = 16;

function fakeViewer(pages, zoom, scrollTop, navPin = null) {
  const registry = new PageRegistry(pages);
  const layout = registry.layout({ zoom, gap: GAP });
  return {
    registry,
    layout,
    container: { scrollTop },
    _navPin: navPin,
    getScrollAnchor: Viewer.prototype.getScrollAnchor,
    scrollTopForAnchor: Viewer.prototype.scrollTopForAnchor,
  };
}

const A4 = { cropW: 595, cropH: 842, rotation: 0 };
const pages = Array.from({ length: 10 }, (_, i) => ({ pageNo: i + 1, ...A4 }));

test("anchor = viewport 上端が属するページ + ページ内相対位置", () => {
  const v = fakeViewer(pages, 1, 0);
  const pos4 = v.registry.posOfPageNo(5);
  // ページ 5 の先頭から 40% 下を見ている
  v.container.scrollTop = v.layout.pageTops[pos4] + 0.4 * v.layout.pageHeights[pos4];
  const a = v.getScrollAnchor();
  assert.equal(a.pageNo, 5);
  assert.ok(Math.abs(a.offsetRatio - 0.4) < 1e-9);
  assert.equal(a.pinPageNo, null);
});

test("倍率が変わっても同じページの同じ相対位置に戻る (scrollTop 生値では別ページ)", () => {
  const before = fakeViewer(pages, 1.5, 0);
  const p7 = before.registry.posOfPageNo(7);
  before.container.scrollTop = before.layout.pageTops[p7] + 0.25 * before.layout.pageHeights[p7];
  const rawScrollTop = before.container.scrollTop;
  const anchor = before.getScrollAnchor();

  // 別タブで 100% にされた状態で戻ってくる
  const after = fakeViewer(pages, 1.0, 0);
  const target = after.scrollTopForAnchor(anchor);
  after.container.scrollTop = target;
  const restored = after.getScrollAnchor();
  assert.equal(restored.pageNo, 7, "anchor 復元: ページ 7");
  assert.ok(Math.abs(restored.offsetRatio - 0.25) < 0.01, "anchor 復元: ページ内位置 25%");

  // 従来方式 (生 scrollTop) だと倍率 1.5 → 1.0 で別ページに飛ぶ
  after.container.scrollTop = rawScrollTop;
  const naive = after.getScrollAnchor();
  assert.notEqual(naive.pageNo, 7, "scrollTop 生値では別ページ (= 報告の症状)");
});

test("nav pin 採用中 (scrollToPage 直後) は行き先ページを pinPageNo に保持", () => {
  const v = fakeViewer(pages, 1, 0);
  const p3 = v.registry.posOfPageNo(3);
  v.container.scrollTop = v.layout.pageTops[p3];
  v._navPin = { pageNo: 3, scrollTop: v.container.scrollTop };
  assert.equal(v.getScrollAnchor().pinPageNo, 3);
  // そこから 1px でも scroll したら pin は無効
  v.container.scrollTop += 2;
  assert.equal(v.getScrollAnchor().pinPageNo, null);
});

test("anchor のページが無い (削除された) なら null → 呼び出し側が生値 fallback", () => {
  const v = fakeViewer(pages.filter((p) => p.pageNo !== 5), 1, 0);
  assert.equal(v.scrollTopForAnchor({ pageNo: 5, offsetRatio: 0.2 }), null);
  assert.equal(v.scrollTopForAnchor(null), null);
});

test("先頭 (scrollTop 0) と末尾の境界", () => {
  const v = fakeViewer(pages, 1, 0);
  assert.deepEqual(
    { ...v.getScrollAnchor() },
    { pageNo: 1, offsetRatio: 0, pinPageNo: null },
  );
  const last = v.layout.pageTops.length - 1;
  v.container.scrollTop = v.layout.pageTops[last] + v.layout.pageHeights[last] - 1;
  assert.equal(v.getScrollAnchor().pageNo, 10);
  // 相対位置は 1.5 で頭打ち (gap に落ちた値を暴走させない)
  assert.equal(
    v.scrollTopForAnchor({ pageNo: 10, offsetRatio: 9 }),
    Math.round(v.layout.pageTops[last] + 1.5 * v.layout.pageHeights[last]),
  );
});

test("混在サイズ (A3 横 + A4) でも各ページ基準で復元", () => {
  const mixed = [
    { pageNo: 1, ...A4 },
    { pageNo: 2, cropW: 1190, cropH: 842, rotation: 0 },
    { pageNo: 3, ...A4 },
  ];
  const before = fakeViewer(mixed, 1.2, 0);
  const p3 = before.registry.posOfPageNo(3);
  before.container.scrollTop = before.layout.pageTops[p3] + 10;
  const anchor = before.getScrollAnchor();
  assert.equal(anchor.pageNo, 3);
  const after = fakeViewer(mixed, 0.8, 0);
  after.container.scrollTop = after.scrollTopForAnchor(anchor);
  assert.equal(after.getScrollAnchor().pageNo, 3);
});
