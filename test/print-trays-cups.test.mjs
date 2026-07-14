// 2026-07-14: CUPS 直送の給紙トレイ選択 (print-trays-cups.js)。
//
// 「用紙サイズごとにトレイが分けてある」事務所運用で、プリセットを作らずに
// 印刷ダイアログからトレイを指名できるようにした分の pure 関数テスト。
// 実機 I/O (lpoptions / PPD 読み) を伴う listCupsTrays / resolveTrayOption は
// ここでは対象外 (Mac 実機で確認する)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLpoptionsChoices } from "../src/main/print-presets-mac.js";
import {
  pickTrayKey,
  parsePpdChoiceLabels,
  buildTrayChoices,
  mergeTrayIntoPpdOptions,
  ippTrayLabel,
} from "../src/main/print-trays-cups.js";

// Apeos C2360 相当の lpoptions 出力 (現在値の * 付き)
const LPOPTIONS_OUT = `
ColorModel/Color Mode: CMYK Gray *RGB
Duplex/2-Sided Printing: *None DuplexNoTumble DuplexTumble
InputSlot/Paper Source: *Auto Tray1 Tray2 Tray3 Manual
PageSize/Page Size: *A4 A3 B4 Letter
`;

// PPD の該当部 (翻訳ラベル付き。Auto は翻訳なし = キーワード表示になる)
const PPD_TEXT = `*OpenUI *InputSlot/給紙: PickOne
*DefaultInputSlot: Auto
*InputSlot Auto: "<</MediaPosition 0>>setpagedevice"
*InputSlot Tray1/トレイ 1 (A4): "<</MediaPosition 1>>setpagedevice"
*InputSlot Tray2/トレイ 2 (A3): "<</MediaPosition 2>>setpagedevice"
*InputSlot Tray3/トレイ 3: "<</MediaPosition 3>>setpagedevice"
*InputSlot Manual/手差し: "<</MediaPosition 4>>setpagedevice"
*CloseUI: *InputSlot
`;

test("pickTrayKey: PPD が広告している給紙キーワードを選ぶ", () => {
  const choices = parseLpoptionsChoices(LPOPTIONS_OUT);
  assert.equal(pickTrayKey(choices), "InputSlot");
});

test("pickTrayKey: 給紙オプションを広告しないプリンタでは null (欄を出さない)", () => {
  const choices = parseLpoptionsChoices("PageSize/Page Size: *A4 A3\n");
  assert.equal(pickTrayKey(choices), null);
  assert.equal(pickTrayKey(null), null);
});

test("pickTrayKey: ベンダー別名 (MediaSource) も拾う", () => {
  const choices = parseLpoptionsChoices("MediaSource/Source: *Auto Cassette1 Cassette2\n");
  assert.equal(pickTrayKey(choices), "MediaSource");
});

test("parsePpdChoiceLabels: 選択肢の日本語ラベルを拾う (翻訳無しは省略)", () => {
  const labels = parsePpdChoiceLabels(PPD_TEXT, "InputSlot");
  assert.equal(labels.get("Tray1"), "トレイ 1 (A4)");
  assert.equal(labels.get("Tray2"), "トレイ 2 (A3)");
  assert.equal(labels.get("Manual"), "手差し");
  assert.equal(labels.has("Auto"), false, "翻訳の無い行はラベルを持たない");
});

test("buildTrayChoices: 広告された選択肢だけを、ラベル付きで UI に出す", () => {
  const choices = parseLpoptionsChoices(LPOPTIONS_OUT);
  const key = pickTrayKey(choices);
  const list = buildTrayChoices(choices.get(key), parsePpdChoiceLabels(PPD_TEXT, key));
  assert.deepEqual(list, [
    { value: "Auto", label: "自動選択" }, // PPD 翻訳が無い分は IPP 和訳で補う
    { value: "Tray1", label: "トレイ 1 (A4)" },
    { value: "Tray2", label: "トレイ 2 (A3)" },
    { value: "Tray3", label: "トレイ 3" },
    { value: "Manual", label: "手差し" },
  ]);
});

test("buildTrayChoices: PPD が無い (driverless) キューでも読める日本語になる", () => {
  const choices = parseLpoptionsChoices(LPOPTIONS_OUT);
  const list = buildTrayChoices(choices.get("InputSlot"), new Map());
  assert.deepEqual(
    list.map((c) => c.label),
    ["自動選択", "トレイ 1", "トレイ 2", "トレイ 3", "手差し"],
  );
});

// 2026-07-14 実機 (Apeos C2360): PPD の翻訳が無く、選択肢が IPP 標準キーワード
// (`auto` / `tray-1` …) のまま出てきた。キーワード直出しはダイアログとして読めない。
test("ippTrayLabel: IPP 標準キーワードを日本語にする", () => {
  assert.equal(ippTrayLabel("auto"), "自動選択");
  assert.equal(ippTrayLabel("tray-1"), "トレイ 1");
  assert.equal(ippTrayLabel("tray-2"), "トレイ 2");
  assert.equal(ippTrayLabel("Tray3"), "トレイ 3", "大文字/区切り無しの揺れも畳む");
  assert.equal(ippTrayLabel("manual"), "手差し");
  assert.equal(ippTrayLabel("by-pass-tray"), "手差しトレイ");
  assert.equal(ippTrayLabel("weird-vendor-slot"), null, "未知の値は意訳せず null");
});

test("buildTrayChoices: PPD 翻訳が無い IPP キューでも日本語で出す", () => {
  const advertised = new Set(["auto", "tray-1", "tray-2", "manual", "vendor-x"]);
  assert.deepEqual(buildTrayChoices(advertised, new Map()), [
    { value: "auto", label: "自動選択" },
    { value: "tray-1", label: "トレイ 1" },
    { value: "tray-2", label: "トレイ 2" },
    { value: "manual", label: "手差し" },
    { value: "vendor-x", label: "vendor-x" }, // 未知はキーワードのまま
  ]);
});

test("buildTrayChoices: PPD の翻訳があればそちらが勝つ (ドライバの言い回しが正)", () => {
  const advertised = new Set(["tray-1"]);
  assert.deepEqual(
    buildTrayChoices(advertised, new Map([["tray-1", "トレイ 1 (A4 普通紙)"]])),
    [{ value: "tray-1", label: "トレイ 1 (A4 普通紙)" }],
  );
});

test("mergeTrayIntoPpdOptions: 明示したトレイがプリセットの給紙指定に勝つ", () => {
  const preset = { InputSlot: "Tray1", Duplex: "DuplexNoTumble" };
  assert.deepEqual(
    mergeTrayIntoPpdOptions(preset, { InputSlot: "Tray2" }),
    { Duplex: "DuplexNoTumble", InputSlot: "Tray2" },
    "プリセットが持つ古い給紙キーは剥がしてから明示トレイを載せる",
  );
});

test("mergeTrayIntoPpdOptions: トレイ未指定ならプリセットを素通し (挙動不変)", () => {
  const preset = { InputSlot: "Tray1", Duplex: "DuplexNoTumble" };
  assert.deepEqual(mergeTrayIntoPpdOptions(preset, null), preset);
  assert.equal(mergeTrayIntoPpdOptions(null, null), null, "何も無ければ null (lp -o を足さない)");
});

test("mergeTrayIntoPpdOptions: プリセット無しでもトレイ単独で渡せる", () => {
  assert.deepEqual(
    mergeTrayIntoPpdOptions(null, { InputSlot: "Tray2" }),
    { InputSlot: "Tray2" },
  );
});
