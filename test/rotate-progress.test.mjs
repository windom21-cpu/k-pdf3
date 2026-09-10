// ページ回転インジケーター (src/renderer/rotate-progress.js) の % と文言。
//
// 契約: 単ページは commit 10% → rebuild 70% → 完了 100%。複数ページは
// (完了数 + 段階分) / 総数。revert は戻し終えた数 / 戻す総数。文言には常に
// 経過秒が入り、commit が 5 秒以上続くと「大きな PDF は…」の補足が付く。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROTATE_STAGE,
  SLOW_HINT_AFTER_SEC,
  rotateProgressPercent,
  formatRotateMessage,
} from "../src/renderer/rotate-progress.js";

test("単ページ: commit 10% → rebuild 70% → 完了 100%", () => {
  assert.equal(rotateProgressPercent({ done: 0, total: 1, stage: ROTATE_STAGE.COMMIT }), 10);
  assert.equal(rotateProgressPercent({ done: 0, total: 1, stage: ROTATE_STAGE.REBUILD }), 70);
  assert.equal(rotateProgressPercent({ done: 1, total: 1 }), 100);
});

test("複数ページ: 完了数 + 段階分を総数で割る", () => {
  assert.equal(rotateProgressPercent({ done: 0, total: 4, stage: ROTATE_STAGE.COMMIT }), 3); // 0.1/4
  assert.equal(rotateProgressPercent({ done: 2, total: 4, stage: ROTATE_STAGE.REBUILD }), 68); // 2.7/4
  assert.equal(rotateProgressPercent({ done: 4, total: 4 }), 100);
  // done が total を超えても 100 で止まる
  assert.equal(rotateProgressPercent({ done: 9, total: 4 }), 100);
});

test("revert: 戻し終えた数 / 戻す総数", () => {
  assert.equal(rotateProgressPercent({ done: 3, total: 5, stage: ROTATE_STAGE.REVERT, reverted: 0, revertTotal: 3 }), 0);
  assert.equal(rotateProgressPercent({ done: 3, total: 5, stage: ROTATE_STAGE.REVERT, reverted: 2, revertTotal: 3 }), 67);
  assert.equal(rotateProgressPercent({ done: 3, total: 5, stage: ROTATE_STAGE.REVERT, reverted: 3, revertTotal: 3 }), 100);
});

test("不正値でも 0..100 の整数を返す", () => {
  for (const s of [
    { done: -1, total: 0 },
    { done: NaN, total: NaN, stage: "bogus" },
    { done: 0, total: 1, stage: ROTATE_STAGE.REVERT, reverted: 5, revertTotal: 0 },
  ]) {
    const p = rotateProgressPercent(s);
    assert.ok(Number.isInteger(p) && p >= 0 && p <= 100, JSON.stringify(s) + " → " + p);
  }
});

test("文言: commit は記録中 + 経過秒、5 秒以上で補足が付く", () => {
  const m1 = formatRotateMessage({ pageNo: 150, done: 0, total: 1, stage: ROTATE_STAGE.COMMIT, elapsedSec: 2 });
  assert.match(m1, /^p\.150 回転を PDF に記録しています\.\.\. — 経過 2 秒$/);
  const m2 = formatRotateMessage({ pageNo: 150, done: 0, total: 1, stage: ROTATE_STAGE.COMMIT, elapsedSec: SLOW_HINT_AFTER_SEC });
  assert.match(m2, /経過 5 秒。大きな PDF は再読込に時間がかかります/);
  assert.match(m2, /フリーズではありません/);
});

test("文言: rebuild / 複数ページ / 中止 / revert", () => {
  assert.match(
    formatRotateMessage({ pageNo: 7, done: 1, total: 3, stage: ROTATE_STAGE.REBUILD, elapsedSec: 9 }),
    /^p\.7 画面とサムネイルを更新しています\.\.\. \(2\/3 ページ目\) — 経過 9 秒$/,
  );
  // rebuild には「大きな PDF」補足を付けない (再読込は終わっている)
  assert.doesNotMatch(
    formatRotateMessage({ pageNo: 7, done: 0, total: 1, stage: ROTATE_STAGE.REBUILD, elapsedSec: 30 }),
    /大きな PDF/,
  );
  assert.match(
    formatRotateMessage({ done: 0, total: 1, stage: ROTATE_STAGE.COMMIT, elapsedSec: 12, cancelled: true }),
    /^中止しています — 処理中のページが終わり次第、元に戻します\.\.\. — 経過 12 秒$/,
  );
  assert.match(
    formatRotateMessage({ done: 2, total: 3, stage: ROTATE_STAGE.REVERT, reverted: 1, revertTotal: 2, elapsedSec: 15 }),
    /^元に戻しています\.\.\. \(1\/2\) — 経過 15 秒$/,
  );
});

test("文言: pageNo 無し・単ページなら件数表記を省く", () => {
  const m = formatRotateMessage({ done: 0, total: 1, stage: ROTATE_STAGE.COMMIT, elapsedSec: 0 });
  assert.equal(m, "回転を PDF に記録しています... — 経過 0 秒");
});
