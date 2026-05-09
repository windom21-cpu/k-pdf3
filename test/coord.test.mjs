// K-PDF3 coordinate transform unit tests
//
// Invariants verified:
// 1. roundtrip:    canonical → PDF native → canonical = identity
// 2. rotation:     applying rotation 4 times (each 90deg via userRotation 90,180,270,0) returns same
// 3. mixed-page:   different mediabox / cropbox / rotation combinations work independently
// 4. cropbox:      origin shifted cropbox produces correct positions

import {
  canonicalToPdf,
  pdfToCanonical,
  canonicalRectToPdf,
  canonicalPageSize,
  effectiveRotation,
  simplePage,
  canonicalToPdfMatrix,
} from "../src/domain/coord.js";

let pass = 0;
let fail = 0;
const failures = [];

const EPS = 1e-9;

function approxEq(a, b) {
  return Math.abs(a - b) < EPS;
}

function pointEq(p, q) {
  return approxEq(p.x, q.x) && approxEq(p.y, q.y);
}

function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function describe(name, fn) {
  console.log(`\n[${name}]`);
  fn();
}

// =====================================================================
// 1. Roundtrip: canonical → PDF → canonical
// =====================================================================
describe("roundtrip identity (rotation 0)", () => {
  const page = simplePage(595, 842); // A4
  const pts = [
    { x: 0, y: 0 },
    { x: 100, y: 200 },
    { x: 595, y: 842 },
    { x: 50.5, y: 137.25 },
  ];
  for (const p of pts) {
    const pdf = canonicalToPdf(p, page);
    const back = pdfToCanonical(pdf, page);
    assert(pointEq(p, back), `roundtrip rot=0 ${JSON.stringify(p)} → ${JSON.stringify(back)}`);
  }
});

describe("roundtrip identity (rotation 90/180/270)", () => {
  const baseW = 595, baseH = 842;
  for (const rot of [90, 180, 270]) {
    const page = simplePage(baseW, baseH, rot, 0);
    const pts = [
      { x: 0, y: 0 },
      { x: 50, y: 100 },
      { x: 200, y: 300 },
    ];
    for (const p of pts) {
      const pdf = canonicalToPdf(p, page);
      const back = pdfToCanonical(pdf, page);
      assert(pointEq(p, back), `roundtrip rot=${rot} ${JSON.stringify(p)} → ${JSON.stringify(back)}`);
    }
  }
});

describe("roundtrip identity (userRotation only)", () => {
  const baseW = 595, baseH = 842;
  for (const rot of [90, 180, 270]) {
    const page = simplePage(baseW, baseH, 0, rot);
    const p = { x: 100, y: 100 };
    const back = pdfToCanonical(canonicalToPdf(p, page), page);
    assert(pointEq(p, back), `userRot=${rot} roundtrip`);
  }
});

describe("roundtrip identity (rotation + userRotation combinations)", () => {
  const baseW = 400, baseH = 600;
  for (const rot of [0, 90, 180, 270]) {
    for (const uRot of [0, 90, 180, 270]) {
      const page = simplePage(baseW, baseH, rot, uRot);
      const p = { x: 73, y: 211 };
      const back = pdfToCanonical(canonicalToPdf(p, page), page);
      assert(pointEq(p, back), `rot=${rot} uRot=${uRot} roundtrip ${JSON.stringify(p)} → ${JSON.stringify(back)}`);
    }
  }
});

// =====================================================================
// 2. Rotation 4-cycle: applying 4×90° returns same canonical position
// =====================================================================
describe("4-cycle rotation symmetry", () => {
  // Place a point at (100, 200) on a 400x600 page.
  // Then ask: what PDF native coord is it for each user rotation?
  // Then transform back to canonical with same userRotation. Should be identity.
  const baseW = 400, baseH = 600;
  for (const uRot of [0, 90, 180, 270]) {
    const page = simplePage(baseW, baseH, 0, uRot);
    const p = { x: 100, y: 200 };
    const back = pdfToCanonical(canonicalToPdf(p, page), page);
    assert(pointEq(p, back), `4-cycle uRot=${uRot}`);
  }
});

// =====================================================================
// 3. Canonical page size respects rotation
// =====================================================================
describe("canonical page size", () => {
  const page0 = simplePage(595, 842, 0);
  const page90 = simplePage(595, 842, 90);
  const page180 = simplePage(595, 842, 180);
  const page270 = simplePage(595, 842, 270);

  assert(canonicalPageSize(page0).w === 595 && canonicalPageSize(page0).h === 842, "rot=0 size");
  assert(canonicalPageSize(page90).w === 842 && canonicalPageSize(page90).h === 595, "rot=90 size (swapped)");
  assert(canonicalPageSize(page180).w === 595 && canonicalPageSize(page180).h === 842, "rot=180 size");
  assert(canonicalPageSize(page270).w === 842 && canonicalPageSize(page270).h === 595, "rot=270 size (swapped)");
});

// =====================================================================
// 4. Cropbox shifted (cropX/cropY != 0)
// =====================================================================
describe("cropbox-shifted page", () => {
  // mediabox 800x1000, cropbox is 595x842 starting at (100, 79)
  /** @type {import("../src/domain/coord.js").PageBox} */
  const page = {
    mediaX: 0,
    mediaY: 0,
    mediaW: 800,
    mediaH: 1000,
    cropX: 100,
    cropY: 79,
    cropW: 595,
    cropH: 842,
    rotation: 0,
    userRotation: 0,
  };

  // canonical (0, 0) is the top-left of the cropbox.
  // In PDF native, the top-left of cropbox is (cropX, cropY + cropH) = (100, 921).
  const tl = canonicalToPdf({ x: 0, y: 0 }, page);
  assert(pointEq(tl, { x: 100, y: 79 + 842 }), `cropbox top-left → PDF (100, 921), got ${JSON.stringify(tl)}`);

  // canonical (cropW, cropH) is the bottom-right of cropbox.
  // PDF native: (cropX + cropW, cropY) = (695, 79).
  const br = canonicalToPdf({ x: 595, y: 842 }, page);
  assert(pointEq(br, { x: 695, y: 79 }), `cropbox bottom-right → PDF (695, 79), got ${JSON.stringify(br)}`);

  // Roundtrip
  const p = { x: 100, y: 200 };
  const back = pdfToCanonical(canonicalToPdf(p, page), page);
  assert(pointEq(p, back), `cropbox-shifted roundtrip`);
});

// =====================================================================
// 5. Rect transform sanity
// =====================================================================
describe("canonical rect → PDF native rect", () => {
  const page = simplePage(595, 842);
  const r = { x: 100, y: 200, w: 50, h: 30 };
  const pdfRect = canonicalRectToPdf(r, page);
  // Expected: top-left of rect (100, 200) → PDF (100, 642)
  //           bottom-right (150, 230) → PDF (150, 612)
  // PDF rect (bottom-left): x=100, y=612, w=50, h=30
  assert(
    approxEq(pdfRect.x, 100) && approxEq(pdfRect.y, 612) &&
    approxEq(pdfRect.w, 50) && approxEq(pdfRect.h, 30),
    `rect rot=0: expected {100,612,50,30}, got ${JSON.stringify(pdfRect)}`
  );
});

// =====================================================================
// 6. Effective rotation
// =====================================================================
describe("effective rotation = (rotation + userRotation) mod 360", () => {
  assert(effectiveRotation(simplePage(100, 100, 0, 0)) === 0, "0+0=0");
  assert(effectiveRotation(simplePage(100, 100, 90, 0)) === 90, "90+0=90");
  assert(effectiveRotation(simplePage(100, 100, 90, 90)) === 180, "90+90=180");
  assert(effectiveRotation(simplePage(100, 100, 270, 90)) === 0, "270+90=360→0");
  assert(effectiveRotation(simplePage(100, 100, 180, 270)) === 90, "180+270=450→90");
});

// =====================================================================
// 7. Matrix form vs point form must agree
// =====================================================================
describe("matrix form matches point form", () => {
  const page = simplePage(400, 600, 90, 0);
  const m = canonicalToPdfMatrix(page);
  const [a, b, c, d, e, f] = m;
  const cp = { x: 50, y: 100 };
  const viaMatrix = { x: a * cp.x + c * cp.y + e, y: b * cp.x + d * cp.y + f };
  const viaPoint = canonicalToPdf(cp, page);
  assert(pointEq(viaMatrix, viaPoint), `matrix vs point: ${JSON.stringify(viaMatrix)} vs ${JSON.stringify(viaPoint)}`);
});

describe("matrix form: all rotations", () => {
  for (const rot of [0, 90, 180, 270]) {
    const page = simplePage(400, 600, rot, 0);
    const m = canonicalToPdfMatrix(page);
    const [a, b, c, d, e, f] = m;
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 200, y: 300 }];
    for (const cp of pts) {
      const viaMatrix = { x: a * cp.x + c * cp.y + e, y: b * cp.x + d * cp.y + f };
      const viaPoint = canonicalToPdf(cp, page);
      assert(pointEq(viaMatrix, viaPoint),
        `matrix vs point rot=${rot} ${JSON.stringify(cp)}: ${JSON.stringify(viaMatrix)} vs ${JSON.stringify(viaPoint)}`);
    }
  }
});

// =====================================================================
// Summary
// =====================================================================
console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
