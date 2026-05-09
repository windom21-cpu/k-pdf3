// ProjectStore unit test — pure domain layer, no SQLite / mupdf needed.

import { ProjectStore } from "../src/domain/project-store.js";

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
  ok(actual === expected, `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log("=== ProjectStore smoke test ===\n");

// ---------- 1. Empty store --------------------------------------------
console.log("[1] Empty store");
const empty = new ProjectStore();
eq(empty.count(), 0, "count = 0");
eq(empty.isDirty(), false, "fresh store is clean");
eq(empty.get("nonexistent"), null, "get(unknown) returns null");
eq(empty.getPageOverlays(1).length, 0, "no overlays on page 1");
eq(empty.hitTest(1, { x: 0, y: 0, w: 100, h: 100 }).length, 0, "empty hit-test");

// ---------- 2. add ----------------------------------------------------
console.log("\n[2] add() generates id, timestamps, dirty flag");
const store = new ProjectStore();
const ov1 = store.add({
  pageNo: 1, type: "text",
  x: 50, y: 50, w: 100, h: 20,
  zOrder: 0, properties: { text: "hello", fontSize: 12 },
});
ok(typeof ov1.id === "string" && ov1.id.length === 36, `id is UUID-like (${ov1.id})`);
ok(typeof ov1.createdAt === "string" && ov1.createdAt.includes("T"), "createdAt is ISO");
eq(ov1.createdAt, ov1.updatedAt, "createdAt === updatedAt on insert");
eq(store.count(), 1, "count after add = 1");
eq(store.isDirty(), true, "dirty after add");
ok(store.get(ov1.id) === ov1, "get returns inserted overlay");

// ---------- 3. add multiple, ordering by zOrder -----------------------
console.log("\n[3] getPageOverlays sorted by zOrder ascending");
const ov2 = store.add({ pageNo: 1, type: "stamp",     x: 60, y: 60, w: 30, h: 30, zOrder: 5 });
const ov3 = store.add({ pageNo: 1, type: "redaction", x: 0,  y: 0,  w: 10, h: 10, zOrder: -1 });
const list = store.getPageOverlays(1);
eq(list.length, 3, "3 overlays on page 1");
eq(list[0].id, ov3.id, "lowest zOrder first (ov3 = -1)");
eq(list[1].id, ov1.id, "middle zOrder (ov1 = 0)");
eq(list[2].id, ov2.id, "highest zOrder last (ov2 = 5)");

// ---------- 4. Cross-page isolation -----------------------------------
console.log("\n[4] Per-page index isolation");
const ovP2 = store.add({ pageNo: 2, type: "text", x: 0, y: 0, w: 50, h: 20 });
eq(store.getPageOverlays(1).length, 3, "page 1 still has 3");
eq(store.getPageOverlays(2).length, 1, "page 2 has 1");
eq(store.getPageOverlays(99).length, 0, "page 99 (unused) has 0");

// ---------- 5. update -------------------------------------------------
console.log("\n[5] update()");
// Tiny delay to ensure updatedAt differs from createdAt at ms granularity.
await new Promise((r) => setTimeout(r, 5));
const u = store.update(ov1.id, { x: 75, properties: { text: "hello!", fontSize: 14 } });
ok(u !== null, "update returned non-null");
eq(u.x, 75, "x updated");
eq(u.y, 50, "y preserved");
eq(u.properties.text, "hello!", "properties.text updated");
eq(u.properties.fontSize, 14, "properties.fontSize updated");
ok(u.updatedAt > u.createdAt, "updatedAt advanced");
eq(store.update("missing-id", { x: 0 }), null, "update unknown id returns null");

// ---------- 6. remove --------------------------------------------------
console.log("\n[6] remove()");
const removed = store.remove(ov3.id);
eq(removed, true, "remove existing returns true");
eq(store.count(), 3, "count after remove (was 4 with ovP2, now 3)");
eq(store.get(ov3.id), null, "removed overlay no longer retrievable");
eq(store.getPageOverlays(1).length, 2, "page 1 has 2 after remove");
eq(store.remove("missing"), false, "remove unknown returns false");

// ---------- 7. hitTest -------------------------------------------------
console.log("\n[7] hitTest()");
// ov1 is at (75, 50, 100, 20) → covers [75..175] × [50..70]
// ov2 is at (60, 60, 30, 30)  → covers [60..90]  × [60..90]
// rect (50, 55, 30, 10) → [50..80] × [55..65] overlaps both
const hits = store.hitTest(1, { x: 50, y: 55, w: 30, h: 10 });
eq(hits.length, 2, "hit-test rect overlaps ov1 + ov2");
// rect (200, 200, 10, 10) overlaps neither
const noHits = store.hitTest(1, { x: 200, y: 200, w: 10, h: 10 });
eq(noHits.length, 0, "non-overlapping hit-test empty");
// edge-touching only: rect right edge exactly at ov1 left edge → not a hit
const edge = store.hitTest(1, { x: 65, y: 55, w: 10, h: 10 }); // [65..75]×[55..65], ov1 starts at x=75
eq(edge.length, 1, "rect that only touches ov1 edge does not count, but overlaps ov2");

// ---------- 8. Subscriber receives events ------------------------------
console.log("\n[8] subscribe() — events on add / update / remove");
const events = [];
const unsub = store.subscribe((e) => events.push(e));
const ovS = store.add({ pageNo: 3, type: "text", x: 0, y: 0, w: 10, h: 10 });
eq(events.length, 1, "1 event after add");
eq(events[0].kind, "add", "kind = add");
eq(events[0].overlay.id, ovS.id, "event carries overlay");
eq(events[0].pages[0], 3, "event.pages = [3]");

store.update(ovS.id, { x: 5 });
eq(events.length, 2, "2 events after update");
eq(events[1].kind, "update", "kind = update");

store.remove(ovS.id);
eq(events.length, 3, "3 events after remove");
eq(events[2].kind, "remove", "kind = remove");

// ---------- 9. Unsubscribe via returned function -----------------------
console.log("\n[9] returned unsubscribe stops events");
unsub();
store.add({ pageNo: 3, type: "text", x: 0, y: 0, w: 10, h: 10 });
eq(events.length, 3, "no new events after unsubscribe");

// ---------- 10. AbortSignal-based unsubscribe --------------------------
console.log("\n[10] AbortController unsubscribes");
const ac = new AbortController();
const events2 = [];
store.subscribe((e) => events2.push(e), { signal: ac.signal });
store.add({ pageNo: 4, type: "text", x: 0, y: 0, w: 10, h: 10 });
eq(events2.length, 1, "received pre-abort event");
ac.abort();
store.add({ pageNo: 4, type: "text", x: 0, y: 0, w: 10, h: 10 });
eq(events2.length, 1, "no events after abort");

// Subscribe with already-aborted signal: should not register
const ac2 = new AbortController();
ac2.abort();
const events3 = [];
store.subscribe((e) => events3.push(e), { signal: ac2.signal });
store.add({ pageNo: 5, type: "text", x: 0, y: 0, w: 10, h: 10 });
eq(events3.length, 0, "subscribe with pre-aborted signal receives nothing");

// ---------- 11. Multiple subscribers -----------------------------------
console.log("\n[11] Multiple subscribers");
const e1 = [];
const e2 = [];
const u1 = store.subscribe((e) => e1.push(e));
const u2 = store.subscribe((e) => e2.push(e));
store.add({ pageNo: 6, type: "text", x: 0, y: 0, w: 10, h: 10 });
eq(e1.length, 1, "subscriber 1 received");
eq(e2.length, 1, "subscriber 2 received");
u1();
store.add({ pageNo: 6, type: "text", x: 0, y: 0, w: 10, h: 10 });
eq(e1.length, 1, "subscriber 1 stopped");
eq(e2.length, 2, "subscriber 2 still active");
u2();

// ---------- 12. Throwing subscriber doesn't break store ----------------
console.log("\n[12] Throwing subscriber is isolated");
const goodEvents = [];
const u3 = store.subscribe(() => {
  throw new Error("boom");
});
const u4 = store.subscribe((e) => goodEvents.push(e));
// Suppress error console for this test by capturing console.error
const origErr = console.error;
const captured = [];
console.error = (...args) => captured.push(args.join(" "));
store.add({ pageNo: 7, type: "text", x: 0, y: 0, w: 10, h: 10 });
console.error = origErr;
eq(goodEvents.length, 1, "non-throwing subscriber still received");
ok(captured.some((s) => s.includes("subscriber threw")), "throw was logged");
u3();
u4();

// ---------- 13. reset --------------------------------------------------
console.log("\n[13] reset() replaces state, emits single event, clears dirty");
const resetEvents = [];
const uR = store.subscribe((e) => resetEvents.push(e));
const fresh = [
  {
    id: "fixed-1", pageNo: 1, type: "text",
    x: 0, y: 0, w: 1, h: 1, zOrder: 0,
    properties: {}, assetId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "fixed-2", pageNo: 2, type: "stamp",
    x: 0, y: 0, w: 1, h: 1, zOrder: 0,
    properties: {}, assetId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];
store.reset(fresh);
eq(store.count(), 2, "reset → count = 2");
eq(store.isDirty(), false, "reset clears dirty flag");
eq(resetEvents.length, 1, "single reset event emitted");
eq(resetEvents[0].kind, "reset", "kind = reset");
ok(resetEvents[0].pages.includes(1) && resetEvents[0].pages.includes(2), "pages = [1, 2]");
ok(store.get("fixed-1") !== null, "reset overlay retrievable by id");
uR();

// ---------- 14. markClean ----------------------------------------------
console.log("\n[14] markClean()");
store.add({ pageNo: 1, type: "text", x: 0, y: 0, w: 1, h: 1 });
eq(store.isDirty(), true, "dirty after add");
store.markClean();
eq(store.isDirty(), false, "markClean → not dirty");

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) console.log("ProjectStore test: FAIL");
process.exitCode = fail > 0 ? 1 : 0;
