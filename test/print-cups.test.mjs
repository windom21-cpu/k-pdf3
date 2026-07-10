// CUPS 直送印刷エンジン (2026-07-10、§15.6 Step 1) の引数組み立てテスト。
//
// lp の引数列は「何を渡すか」と同じくらい「何を渡さないか」が安全性に
// 直結する (orientation を渡すと回転二重がけ、未知サイズに media を
// 渡すと誤った強制)。ここで固定して回帰を防ぐ。
// buildLpArgs / mediaNameForSizePt は pure なので全 OS の CI で走る。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLpArgs, mediaNameForSizePt, parseRequestId } from "../src/main/print-cups.js";

test("media: 定型サイズを PWG name に解決 (±4pt 許容)", () => {
  assert.equal(mediaNameForSizePt(595.28, 841.89), "iso_a4_210x297mm");
  assert.equal(mediaNameForSizePt(595, 842), "iso_a4_210x297mm");     // 丸め揺れ
  assert.equal(mediaNameForSizePt(841.89, 1190.55), "iso_a3_297x420mm");
  assert.equal(mediaNameForSizePt(728.5, 1031.81), "jis_b4_257x364mm");
  assert.equal(mediaNameForSizePt(515.91, 728.5), "jis_b5_182x257mm");
  assert.equal(mediaNameForSizePt(612, 792), "na_letter_8.5x11in");
  assert.equal(mediaNameForSizePt(612, 1008), "na_legal_8.5x14in");
});

test("media: 横向きページは縦横 swap で照合 (name は portrait 表記のまま)", () => {
  assert.equal(mediaNameForSizePt(841.89, 595.28), "iso_a4_210x297mm");
  assert.equal(mediaNameForSizePt(1190.55, 841.89), "iso_a3_297x420mm");
});

test("media: 未知サイズ / 不正値は null (プリンタ既定に任せる)", () => {
  assert.equal(mediaNameForSizePt(500, 700), null);
  assert.equal(mediaNameForSizePt(0, 842), null);
  assert.equal(mediaNameForSizePt(undefined, undefined), null);
});

test("args: 最小構成 (プリンタ + 部数 + ファイル)", () => {
  assert.deepEqual(buildLpArgs("/tmp/x.pdf", { deviceName: "Apeos" }), [
    "-d", "Apeos", "-n", "1", "--", "/tmp/x.pdf",
  ]);
});

test("args: 部数は 1 未満/非数を 1 に矯正", () => {
  assert.ok(buildLpArgs("/t.pdf", { deviceName: "p", copies: 0 }).join(" ").includes("-n 1"));
  assert.ok(buildLpArgs("/t.pdf", { deviceName: "p", copies: "3" }).join(" ").includes("-n 3"));
});

test("args: duplex / mono / fit / media の対応", () => {
  const args = buildLpArgs("/t.pdf", {
    deviceName: "Apeos",
    copies: 2,
    duplex: "long-edge",
    color: "mono",
    sizing: "fit",
    widthPt: 595.28,
    heightPt: 841.89,
  });
  const s = args.join(" ");
  assert.ok(s.includes("-o sides=two-sided-long-edge"), s);
  assert.ok(s.includes("-o print-color-mode=monochrome"), s);
  assert.ok(s.includes("-o fit-to-page"), s);
  assert.ok(s.includes("-o media=iso_a4_210x297mm"), s);
  assert.ok(s.endsWith("-- /t.pdf"), s);
});

test("args: simplex / short-edge の sides 対応", () => {
  assert.ok(buildLpArgs("/t.pdf", { deviceName: "p", duplex: "simplex" })
    .join(" ").includes("sides=one-sided"));
  assert.ok(buildLpArgs("/t.pdf", { deviceName: "p", duplex: "short-edge" })
    .join(" ").includes("sides=two-sided-short-edge"));
});

test("requestId: ロケール非依存パース (日本語 macOS / 英語 / 取れない時 null)", () => {
  // 日本語 macOS 実出力 (M1 で確認)。Apple CUPS は LC_ALL=C を無視する
  assert.equal(
    parseRequestId("要求IDはFUJIFILM_Apeos_C2360__55_0e_a5_-596です（1個のファイル）",
      "FUJIFILM_Apeos_C2360__55_0e_a5_"),
    "FUJIFILM_Apeos_C2360__55_0e_a5_-596");
  assert.equal(
    parseRequestId("request id is Office-12 (1 file(s))", "Office"),
    "Office-12");
  // deviceName 無しでも英語なら拾える
  assert.equal(parseRequestId("request id is Office-12 (1 file(s))", null), "Office-12");
  // 正規表現メタ文字を含むキュー名でも安全
  assert.equal(parseRequestId("id Queue(A4)-7 done", "Queue(A4)"), "Queue(A4)-7");
  assert.equal(parseRequestId("何も出ない", "Office"), null);
});

test("args: 渡さないものを固定 — orientation 系 / color 指定 / 実寸時の fit", () => {
  const s = buildLpArgs("/t.pdf", {
    deviceName: "p",
    color: "color",
    sizing: "actual",
    landscape: true,          // 受け取っても無視される (回転二重がけ防止)
    widthPt: 500, heightPt: 700, // 未知サイズ → media 無し
  }).join(" ");
  assert.ok(!s.includes("orientation"), s);
  assert.ok(!s.includes("landscape"), s);
  assert.ok(!s.includes("print-color-mode"), s);
  assert.ok(!s.includes("fit-to-page"), s);
  assert.ok(!s.includes("media="), s);
});
