// Regression (v2.0.27-beta.5): a blank page inserted via the ＋gap right
// AFTER a freshly added (unsaved) external-PDF / image / Word page must
// land after it, not in front of it.
//
// Why it broke: external-PDF insertion (β77) gives each new synth row an
// explicit fractional display_order spread across (lower, upper) — e.g.
// two pages dropped after p1 get 1.333 / 1.667. Blank insertion had no
// display_order at all and fell back to Workspace.getPages' slot-derived
// key `anchor + 0.5 + orderInSlot * 0.001` (= 1.502 for orderInSlot=2),
// which sorts BETWEEN 1.333 and 1.667 → the blank showed up before the
// 2nd added page. After 確定保存 the synths become source pages so the
// bug only surfaces "before saving".
//
// Fix: the renderer passes `afterKey` (the visible page the gap sits
// after) and main resolves it to the midpoint of the two visible
// neighbours' orderKeys (Workspace.visualGapAfter), stored as the blank's
// display_order — identical maths to the external-PDF path.
//
// Runs under the Electron runner (better-sqlite3 ABI).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/domain/workspace.js";
import { setPages } from "../src/backend/sqlite-store.js";

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

const mkPage = (n) => ({
  pageNo: n,
  mediaX: 0, mediaY: 0, mediaW: 595, mediaH: 842,
  cropX: 0, cropY: 0, cropW: 595, cropH: 842,
  rotation: 0, userRotation: 0,
});

/** Mirror of main._insertPdfBytesIntoWorkspace's display_order spread. */
function addExternalPages(ws, { afterKey, afterPageNo, count }) {
  const { lower, upper } = ws.visualGapAfter(afterKey);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(
      ws.addInsertedImagePage({
        afterPageNo,
        imageBlob: Buffer.alloc(1),
        imageW: 1, imageH: 1, width: 595, height: 842,
        displayOrder: lower + ((i + 1) / (count + 1)) * (upper - lower),
      }),
    );
  }
  return out;
}

/** Mirror of main's kpdf3:add-inserted-page handler (fixed path). */
function addBlankAfterVisible(ws, { afterPageNo, orderInSlot, afterKey, text = null }) {
  const { lower, upper } = ws.visualGapAfter(afterKey);
  return ws.addInsertedPage({
    afterPageNo, orderInSlot, text,
    displayOrder: lower + (upper - lower) / 2,
  });
}

/** What the sidebar ＋gap after a synthetic row passes. */
function gapAfterSynth(ws, synthPageNo) {
  const row = ws.getPages().find((p) => p.pageNo === synthPageNo);
  return {
    afterPageNo: row.syntheticAfterPageNo ?? 0,
    orderInSlot: (row.syntheticOrderInSlot ?? 0) + 1,
    afterKey: row.pageNo,
  };
}

const order = (ws) => ws.getPages().map((p) => p.pageNo);

console.log("=== inserted page order: blank after unsaved added page ===\n");

const tmpRoot = mkdtempSync(join(tmpdir(), "kpdf3-inserted-order-"));
try {
  // ---- (1) the reported case: 2 external pages after p1, blank after the 2nd
  {
    const ws = Workspace.create(join(tmpRoot, "a.kpdf3"));
    setPages(ws.db, [1, 2, 3].map(mkPage));
    const [x1, x2] = addExternalPages(ws, { afterKey: 1, afterPageNo: 1, count: 2 });
    ok(order(ws).join() === [1, x1, x2, 2, 3].join(), "外部 PDF 2 ページが p1 の直後に並ぶ (前提)");

    // Legacy (slot-only) call reproduces the bug — kept as a guard that the
    // test actually exercises the failing shape.
    const legacy = ws.addInsertedPage({ afterPageNo: 1, orderInSlot: 2, text: "legacy" });
    const legacyOrder = order(ws);
    ok(
      legacyOrder.indexOf(legacy) === legacyOrder.indexOf(x2) - 1,
      "(再現ガード) afterKey なしの旧経路では白紙が追加 2 ページ目の前に落ちる",
    );
    ws.removeInsertedPage(legacy);

    const blank = addBlankAfterVisible(ws, { ...gapAfterSynth(ws, x2), text: "blank" });
    ok(
      order(ws).join() === [1, x1, x2, blank, 2, 3].join(),
      `afterKey 経路: 白紙が追加 2 ページ目の直後 (${order(ws).join(" ")})`,
    );

    // A second blank after the first blank (gap after a synth that itself
    // has an explicit display_order) still lands right after it.
    const blank2 = addBlankAfterVisible(ws, { ...gapAfterSynth(ws, blank), text: "blank2" });
    ok(
      order(ws).join() === [1, x1, x2, blank, blank2, 2, 3].join(),
      "白紙の後ろにもう 1 枚 → その直後",
    );

    // Blank between the two added pages (gap after the 1st).
    const mid = addBlankAfterVisible(ws, { ...gapAfterSynth(ws, x1), text: "mid" });
    ok(
      order(ws).join() === [1, x1, mid, x2, blank, blank2, 2, 3].join(),
      "追加 1 ページ目と 2 ページ目の間の＋ → その間",
    );
    ws.close();
  }

  // ---- (2) source-page gaps and the top gap are unchanged in effect
  {
    const ws = Workspace.create(join(tmpRoot, "b.kpdf3"));
    setPages(ws.db, [1, 2, 3].map(mkPage));
    const b1 = addBlankAfterVisible(ws, { afterPageNo: 2, orderInSlot: null, afterKey: 2 });
    ok(order(ws).join() === [1, 2, b1, 3].join(), "p2 の後ろの＋ → p2 と p3 の間");
    const top = addBlankAfterVisible(ws, { afterPageNo: 0, orderInSlot: null, afterKey: 0 });
    ok(order(ws).join() === [top, 1, 2, b1, 3].join(), "先頭の＋ → 1 ページ目の前");
    const last = addBlankAfterVisible(ws, { afterPageNo: 3, orderInSlot: null, afterKey: 3 });
    ok(order(ws).join() === [top, 1, 2, b1, 3, last].join(), "最終ページの後ろの＋ → 末尾");
    ws.close();
  }

  // ---- (3) after a reorder (every row has display_order) the gap still wins
  {
    const ws = Workspace.create(join(tmpRoot, "c.kpdf3"));
    setPages(ws.db, [1, 2, 3].map(mkPage));
    const [x1] = addExternalPages(ws, { afterKey: 1, afterPageNo: 1, count: 1 });
    // Move the added page to the very end: 1 2 3 x1
    ws.reorderAllPages([1, 2, 3, x1]);
    ok(order(ws).join() === [1, 2, 3, x1].join(), "並び替え後 1 2 3 x1 (前提)");
    const blank = addBlankAfterVisible(ws, { ...gapAfterSynth(ws, x1) });
    ok(
      order(ws).join() === [1, 2, 3, x1, blank].join(),
      `並び替えで slot から離れた追加ページの後ろでも直後に入る (${order(ws).join(" ")})`,
    );
    ws.close();
  }

  // ---- (4) legacy call without displayOrder is byte-for-byte unchanged
  {
    const ws = Workspace.create(join(tmpRoot, "d.kpdf3"));
    setPages(ws.db, [1, 2].map(mkPage));
    const a = ws.addInsertedPage({ afterPageNo: 1 });
    const b = ws.addInsertedPage({ afterPageNo: 1 });
    const c = ws.addInsertedPage({ afterPageNo: 1, orderInSlot: 1 });
    ok(order(ws).join() === [1, a, c, b, 2].join(), "旧経路 (displayOrder なし) のスロット順は従来どおり");
    const row = ws.db.prepare("SELECT display_order AS d FROM inserted_pages WHERE id = ?").get(-a);
    ok(row.d === null, "旧経路は display_order を書かない");
    ws.close();
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
