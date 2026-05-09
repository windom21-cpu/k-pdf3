// PageRegistry unit test — pure domain layer, no SQLite / mupdf needed.

import {
  PageRegistry,
  visiblePageRange,
} from "../src/domain/page-registry.js";

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(
    actual === expected,
    `${msg}: expected ${expected}, got ${actual}`,
  );
}
function close(actual, expected, eps, msg) {
  ok(
    Math.abs(actual - expected) <= eps,
    `${msg}: expected ≈${expected} (±${eps}), got ${actual}`,
  );
}

console.log("=== PageRegistry smoke test ===\n");

// 5-page synthetic document with mixed rotation values.
// Pages 1, 3, 5 are A4 portrait (595 × 842).
// Page 2 is A4 with rotation 90 → canonical 842 × 595.
// Page 4 is A4 with userRotation 270 (rotation 0 + user 270 = 270 effective)
//   → canonical 842 × 595.
const pagesInput = [
  { pageNo: 1, cropW: 595, cropH: 842, rotation: 0, userRotation: 0 },
  { pageNo: 2, cropW: 595, cropH: 842, rotation: 90, userRotation: 0 },
  { pageNo: 3, cropW: 595, cropH: 842, rotation: 0, userRotation: 0 },
  { pageNo: 4, cropW: 595, cropH: 842, rotation: 0, userRotation: 270 },
  { pageNo: 5, cropW: 595, cropH: 842, rotation: 0, userRotation: 0 },
];

console.log("[1] Construction & count()");
const reg = new PageRegistry(pagesInput);
eq(reg.count(), 5, "count = 5");

console.log("\n[2] Canonical sizes (rotation applied)");
const s1 = reg.getCanonicalSize(1);
eq(s1.w, 595, "page 1 canonical W");
eq(s1.h, 842, "page 1 canonical H");
const s2 = reg.getCanonicalSize(2);
eq(s2.w, 842, "page 2 (rot 90) canonical W → swapped");
eq(s2.h, 595, "page 2 (rot 90) canonical H → swapped");
const s4 = reg.getCanonicalSize(4);
eq(s4.w, 842, "page 4 (userRot 270) canonical W → swapped");
eq(s4.h, 595, "page 4 (userRot 270) canonical H → swapped");

console.log("\n[3] Out-of-range pageNo throws");
let threw = false;
try {
  reg.getCanonicalSize(0);
} catch (e) {
  threw = e instanceof RangeError;
}
ok(threw, "pageNo=0 throws RangeError");
threw = false;
try {
  reg.getCanonicalSize(6);
} catch (e) {
  threw = e instanceof RangeError;
}
ok(threw, "pageNo=6 throws RangeError");

console.log("\n[4] layout() at zoom=1, gap=0 — total height = sum of heights");
const lay0 = reg.layout({ zoom: 1, gap: 0 });
const expectedTotal = 842 + 595 + 842 + 595 + 842;
eq(lay0.totalHeight, expectedTotal, `totalHeight = ${expectedTotal}`);
eq(lay0.maxWidth, 842, "maxWidth = 842 (rotated pages are widest)");
eq(lay0.pageTops[0], 0, "pageTops[0] = 0");
eq(lay0.pageTops[1], 842, "pageTops[1] = 842 (after page 1)");
eq(lay0.pageTops[2], 842 + 595, "pageTops[2] after pages 1-2");
eq(lay0.pageHeights[0], 842, "pageHeights[0]");
eq(lay0.pageWidths[1], 842, "pageWidths[1] (rotated)");

console.log("\n[5] layout() at zoom=2, gap=10 — scaled with gaps");
const lay2 = reg.layout({ zoom: 2, gap: 10 });
close(lay2.pageHeights[0], 842 * 2, 1e-9, "pageHeights[0] doubled");
close(lay2.pageWidths[0], 595 * 2, 1e-9, "pageWidths[0] doubled");
close(lay2.pageTops[1], 842 * 2 + 10, 1e-9, "pageTops[1] = page1 + 1 gap");
close(lay2.pageTops[2], 842 * 2 + 595 * 2 + 20, 1e-9, "pageTops[2] = pages 1-2 + 2 gaps");
const expectedTotal2 = (842 + 595 + 842 + 595 + 842) * 2 + 10 * 4; // 4 gaps between 5 pages
close(lay2.totalHeight, expectedTotal2, 1e-9, `totalHeight zoom=2 gap=10`);

console.log("\n[6] visiblePageRange basic cases (lay0: zoom=1 gap=0)");
let v = visiblePageRange(lay0, 0, 100); // Top of doc, small viewport
eq(v.first, 1, "scroll=0 vp=100 first");
eq(v.last, 1, "scroll=0 vp=100 last");

v = visiblePageRange(lay0, 0, 1000); // Top of doc, viewport spans page 1+2
eq(v.first, 1, "scroll=0 vp=1000 first");
eq(v.last, 2, "scroll=0 vp=1000 last (covers page 1 and 2)");

v = visiblePageRange(lay0, 842, 1); // Exactly at page 1/2 boundary, infinitesimal
// page1 bottom = 842 (excluded since pageBot > top is required), page 2 starts at 842
// Implementation: first = page where pageBot > top → page 2 (top=842)
eq(v.first, 2, "scroll=842 vp=1 first = page 2 (boundary)");
eq(v.last, 2, "scroll=842 vp=1 last = page 2");

v = visiblePageRange(lay0, lay0.totalHeight - 100, 200); // Near end
eq(v.first, 5, "near-end first = 5");
eq(v.last, 5, "near-end last = 5");

console.log("\n[7] visiblePageRange edge cases");
v = visiblePageRange(lay0, lay0.totalHeight + 10, 100); // Past end
eq(v.first, 0, "past-end → empty range first");
eq(v.last, -1, "past-end → empty range last");

v = visiblePageRange(lay0, 0, 0); // Zero-height viewport
eq(v.first, 0, "vp=0 → empty first");
eq(v.last, -1, "vp=0 → empty last");

v = visiblePageRange(lay0, 0, lay0.totalHeight + 1000); // Viewport > doc
eq(v.first, 1, "vp > doc first = 1");
eq(v.last, 5, "vp > doc last = 5");

console.log("\n[8] Empty document");
const empty = new PageRegistry([]);
const lay = empty.layout({ zoom: 1, gap: 8 });
eq(empty.count(), 0, "empty count");
eq(lay.totalHeight, 0, "empty totalHeight");
eq(lay.maxWidth, 0, "empty maxWidth");
const ev = visiblePageRange(lay, 0, 1000);
eq(ev.first, 0, "empty vis first");
eq(ev.last, -1, "empty vis last");

console.log("\n[9] visiblePageRange spans gap (lay2: zoom=2 gap=10)");
// Page 1 spans [0, 1684], gap [1684, 1694], Page 2 starts at 1694
// Viewport scrollY=1680, h=20 → covers tail of page 1 and head of page 2
v = visiblePageRange(lay2, 1680, 20);
eq(v.first, 1, "viewport across gap starts at page 1");
eq(v.last, 2, "viewport across gap ends at page 2");

// Viewport inside the gap only — should produce no visible page
v = visiblePageRange(lay2, 1685, 5);
eq(v.first, 0, "viewport entirely within gap → empty first");
eq(v.last, -1, "viewport entirely within gap → empty last");

console.log("\n[10] 400-page synthetic — binary search returns quickly");
const big = [];
for (let i = 1; i <= 400; i++) {
  big.push({ pageNo: i, cropW: 595, cropH: 842, rotation: 0, userRotation: 0 });
}
const bigReg = new PageRegistry(big);
const bigLay = bigReg.layout({ zoom: 1, gap: 8 });
eq(bigReg.count(), 400, "400-page count");
const expectedTotal400 = 400 * 842 + 399 * 8;
eq(bigLay.totalHeight, expectedTotal400, `400-page totalHeight = ${expectedTotal400}`);

// Spot-check: scroll to halfway, viewport 1000 px
const t0 = process.hrtime.bigint();
v = visiblePageRange(bigLay, expectedTotal400 / 2, 1000);
const t1 = process.hrtime.bigint();
ok(v.first >= 1 && v.last <= 400 && v.first <= v.last, `halfway visible range = [${v.first}, ${v.last}]`);
ok(Number(t1 - t0) < 1_000_000, `binary search < 1ms (${Number(t1 - t0) / 1000}μs)`);

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  console.log("PageRegistry test: FAIL");
}
process.exitCode = fail > 0 ? 1 : 0;
