// HistoryStack + commands round-trip (M3-2).

import { ProjectStore } from "../src/domain/project-store.js";
import { HistoryStack } from "../src/domain/history.js";
import {
  AddOverlayCommand,
  UpdateOverlayCommand,
  RemoveOverlayCommand,
} from "../src/domain/commands.js";

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

console.log("=== HistoryStack + commands ===\n");

// ---------- 1. Empty state ----------
console.log("[1] Empty stack");
const h0 = new HistoryStack();
eq(h0.canUndo(), false, "empty canUndo");
eq(h0.canRedo(), false, "empty canRedo");
eq(h0.undo(), null, "empty undo returns null");
eq(h0.redo(), null, "empty redo returns null");

// ---------- 2. AddOverlayCommand undo/redo ----------
console.log("\n[2] Add → undo → redo round-trip");
const store = new ProjectStore();
const history = new HistoryStack();

const addCmd = new AddOverlayCommand(store, {
  pageNo: 1, type: "text",
  x: 50, y: 50, w: 100, h: 20, zOrder: 0,
  properties: { text: "hello", fontSize: 12 },
});
history.execute(addCmd);
eq(store.count(), 1, "after add: count = 1");
eq(history.canUndo(), true, "canUndo true after add");
eq(history.canRedo(), false, "canRedo false after add");

const id = addCmd._snapshot.id;
ok(typeof id === "string" && id.length === 36, "snapshot captured id");

history.undo();
eq(store.count(), 0, "after undo: count = 0");
eq(store.get(id), null, "after undo: get(id) is null");
eq(history.canUndo(), false, "canUndo false after undoing single");
eq(history.canRedo(), true, "canRedo true after undo");

history.redo();
eq(store.count(), 1, "after redo: count = 1");
const restored = store.get(id);
ok(restored !== null, "redo restored overlay with same id");
eq(restored.id, id, "id preserved across redo");
eq(restored.properties.text, "hello", "properties preserved across redo");

// ---------- 3. UpdateOverlayCommand undo/redo ----------
console.log("\n[3] Update → undo → redo round-trip");
const updCmd = new UpdateOverlayCommand(store, id, { x: 200, properties: { text: "edited", fontSize: 16 } });
history.execute(updCmd);
const after = store.get(id);
eq(after.x, 200, "after update: x = 200");
eq(after.properties.text, "edited", "after update: text changed");
eq(after.properties.fontSize, 16, "after update: fontSize changed");

history.undo();
const back = store.get(id);
eq(back.x, 50, "undo: x restored to 50");
eq(back.properties.text, "hello", "undo: text restored");
eq(back.properties.fontSize, 12, "undo: fontSize restored");

history.redo();
const redone = store.get(id);
eq(redone.x, 200, "redo: x = 200 again");
eq(redone.properties.text, "edited", "redo: text edited again");

// ---------- 4. RemoveOverlayCommand undo/redo ----------
console.log("\n[4] Remove → undo → redo round-trip");
const rmCmd = new RemoveOverlayCommand(store, id);
history.execute(rmCmd);
eq(store.count(), 0, "after remove: count = 0");

history.undo();
eq(store.count(), 1, "undo: count = 1");
const ressurected = store.get(id);
ok(ressurected !== null, "undo: overlay back with same id");
eq(ressurected.x, 200, "undo: overlay state preserved (x=200 from prior redo)");

history.redo();
eq(store.count(), 0, "redo: gone again");

// ---------- 5. Multi-step linear history ----------
console.log("\n[5] Multi-step linear history (Add A, Add B, Update A, undo×2, redo×2)");
const s2 = new ProjectStore();
const h2 = new HistoryStack();
const addA = new AddOverlayCommand(s2, { pageNo: 1, type: "text", x: 0, y: 0, w: 10, h: 10 });
const addB = new AddOverlayCommand(s2, { pageNo: 1, type: "stamp", x: 50, y: 50, w: 30, h: 30 });
h2.execute(addA);
h2.execute(addB);
const aId = addA._snapshot.id;
const bId = addB._snapshot.id;

const updA = new UpdateOverlayCommand(s2, aId, { x: 100 });
h2.execute(updA);
eq(s2.get(aId).x, 100, "A.x = 100 after update");

h2.undo();   // undo updA
eq(s2.get(aId).x, 0, "after undo: A.x = 0");
h2.undo();   // undo addB
eq(s2.count(), 1, "after second undo: count = 1");
ok(s2.get(bId) === null, "B is gone");

h2.redo();   // redo addB
eq(s2.count(), 2, "after redo: count = 2");
ok(s2.get(bId) !== null, "B back");
h2.redo();   // redo updA
eq(s2.get(aId).x, 100, "after second redo: A.x = 100");

// ---------- 6. New action after undo invalidates redo ----------
console.log("\n[6] New action invalidates redo branch");
const s3 = new ProjectStore();
const h3 = new HistoryStack();
const c1 = new AddOverlayCommand(s3, { pageNo: 1, type: "text", x: 0, y: 0, w: 10, h: 10 });
h3.execute(c1);
h3.undo();
eq(h3.canRedo(), true, "before new action: canRedo true");
const c2 = new AddOverlayCommand(s3, { pageNo: 1, type: "rect", x: 1, y: 1, w: 2, h: 2 });
h3.execute(c2);
eq(h3.canRedo(), false, "after new action: redo cleared");

// ---------- 7. Listener notifications ----------
console.log("\n[7] subscribe() fires on each state change");
const events = [];
const unsub = h3.subscribe(() => events.push(true));
const c3 = new AddOverlayCommand(s3, { pageNo: 1, type: "stamp", x: 10, y: 10, w: 5, h: 5 });
h3.execute(c3);
eq(events.length, 1, "1 event after execute");
h3.undo();
eq(events.length, 2, "2 events after undo");
h3.redo();
eq(events.length, 3, "3 events after redo");
h3.clear();
eq(events.length, 4, "4 events after clear");
unsub();
h3.execute(new AddOverlayCommand(s3, { pageNo: 2, type: "text", x: 0, y: 0, w: 1, h: 1 }));
eq(events.length, 4, "no events after unsubscribe");

// ---------- 8. Limit cap ----------
console.log("\n[8] limit caps undo stack");
const hLim = new HistoryStack({ limit: 3 });
const sLim = new ProjectStore();
for (let i = 0; i < 5; i++) {
  hLim.execute(new AddOverlayCommand(sLim, { pageNo: 1, type: "text", x: i, y: 0, w: 1, h: 1 }));
}
eq(hLim._undo.length, 3, "undo length capped to 3");
eq(sLim.count(), 5, "all 5 add still present in store (limit drops oldest history, not state)");

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
process.exitCode = fail > 0 ? 1 : 0;
