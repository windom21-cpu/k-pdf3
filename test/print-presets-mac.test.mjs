// macOS 印刷プリセット → CUPS 直送 (2026-07-10) の pure 関数テスト。
//
// 入力の形は Apeos C2360 実機の plist (plutil -convert json) と
// `lpoptions -p <queue> -l` の実出力から採取。ここで守るのは
// 「PPD が広告していない設定は 1 つも lp に流れない」という安全境界。
// extractPresets / parseLpoptionsChoices / validatePresetOptions は
// pure なので全 OS の CI で走る (listMacPrintPresets 本体は darwin +
// 実 plist 依存のためテスト対象外)。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPresets,
  parseLpoptionsChoices,
  validatePresetOptions,
  pickMonoOption,
  mergeMonoIntoPpdOptions,
} from "../src/main/print-presets-mac.js";

// Apeos C2360 実機 plist の JSON 変換 (実データの縮約)。Cocoa 内部キー
// (com.apple.print.*) と数値設定 (DuplexBindingEdge) が混在するのが本物の形。
const PLIST = {
  "再生紙印刷": {
    "com.apple.print.preset.behavior": 0,
    "com.apple.print.preset.settings": {
      DuplexBindingEdge: 2,
      Duplex: "DuplexNoTumble",
      "com.apple.print.PrintSettings.PMDuplexing": 2,
      InputSlot: "tray-1",
    },
    "com.apple.print.preset.id": "再生紙印刷",
  },
  "com.apple.print.customPresetsInfo": [
    { PresetBehavior: 0, PresetName: "白色印刷" },
    { PresetBehavior: 0, PresetName: "再生紙印刷" },
  ],
  "白色印刷": {
    "com.apple.print.preset.behavior": 0,
    "com.apple.print.preset.id": "白色印刷",
    "com.apple.print.preset.settings": {
      DuplexBindingEdge: 2,
      Duplex: "DuplexNoTumble",
      "com.apple.print.PrintSettings.PMDuplexing": 2,
      InputSlot: "tray-2",
    },
  },
  "com.apple.print.v2.lastUsedSettingsPref": {
    Duplex: "DuplexNoTumble",
    InputSlot: "tray-1",
  },
  "com.apple.print.lastPresetUsedPref": "再生紙印刷",
};

// `lpoptions -p FUJIFILM_Apeos_C2360__55_0e_a5_ -l` 実出力の抜粋
const LPOPTIONS = [
  "PageSize/Media Size: *A4 A3 A5 JB4 JB5 Letter Legal Custom.WIDTHxHEIGHT",
  "InputSlot/Media Source: auto tray-1 tray-2 tray-3 tray-4 manual",
  "Duplex/2-Sided Printing: None *DuplexNoTumble DuplexTumble",
  "ColorModel/Color Mode: *RGB Gray",
].join("\n");

test("extractPresets: PPD 形の文字列設定だけ残し、Cocoa 内部キー/数値は落とす", () => {
  const presets = extractPresets(PLIST);
  assert.equal(presets.length, 2);
  // customPresetsInfo の表示順 (白色 → 再生紙) に従う
  assert.deepEqual(presets.map((p) => p.name), ["白色印刷", "再生紙印刷"]);
  assert.deepEqual(presets[0].settings, { Duplex: "DuplexNoTumble", InputSlot: "tray-2" });
  assert.deepEqual(presets[1].settings, { Duplex: "DuplexNoTumble", InputSlot: "tray-1" });
});

test("extractPresets: メタキーはプリセット扱いしない / 不正入力は []", () => {
  const names = extractPresets(PLIST).map((p) => p.name);
  assert.ok(!names.some((n) => n.startsWith("com.apple.print.")));
  assert.deepEqual(extractPresets(null), []);
  assert.deepEqual(extractPresets("x"), []);
  assert.deepEqual(extractPresets({}), []);
});

test("extractPresets: customPresetsInfo に無い内部エントリは出さない", () => {
  // 共通 plist (com.apple.print.custompresets.plist) の実状態: Cocoa の
  // 内部エントリだけが customPresetsInfo 無しで並ぶ。「最後に使用した
  // 設定」を出すと前回設定の記憶に等しく、毎回明示選択の方針に反する。
  const internalOnly = {
    "デフォルト設定": {
      "com.apple.print.preset.settings": { Duplex: "DuplexNoTumble" },
    },
    "最後に使用した設定": {
      "com.apple.print.preset.settings": { Duplex: "DuplexNoTumble", InputSlot: "tray-1" },
    },
    vendorDefaultSettings: {
      "com.apple.print.preset.settings": { FFOutputMode: "HighSpeed" },
    },
  };
  assert.deepEqual(extractPresets(internalOnly), []);
  // ユーザープリセットと同居していても、customPresetsInfo 記載分だけ返る
  const mixed = {
    ...internalOnly,
    "com.apple.print.customPresetsInfo": [{ PresetBehavior: 0, PresetName: "再生紙印刷" }],
    "再生紙印刷": {
      "com.apple.print.preset.settings": { InputSlot: "tray-1" },
    },
  };
  assert.deepEqual(extractPresets(mixed), [
    { name: "再生紙印刷", settings: { InputSlot: "tray-1" } },
  ]);
});

test("parseLpoptionsChoices: keyword → 選択肢 Set (現在値の * は剥がす)", () => {
  const map = parseLpoptionsChoices(LPOPTIONS);
  assert.deepEqual([...map.keys()], ["PageSize", "InputSlot", "Duplex", "ColorModel"]);
  assert.ok(map.get("Duplex").has("DuplexNoTumble")); // *付きでも入る
  assert.ok(map.get("Duplex").has("None"));
  assert.ok(map.get("InputSlot").has("tray-2"));
  assert.ok(!map.get("InputSlot").has("*auto"));
});

test("parseLpoptionsChoices: 形式外の行は無視 / 空入力は空 Map", () => {
  assert.equal(parseLpoptionsChoices("").size, 0);
  assert.equal(parseLpoptionsChoices(null).size, 0);
  assert.equal(parseLpoptionsChoices("printer FUJIFILM is idle.\n何か別の行").size, 0);
});

test("validatePresetOptions: PPD が広告する組み合わせだけ通す", () => {
  const map = parseLpoptionsChoices(LPOPTIONS);
  assert.deepEqual(
    validatePresetOptions({ Duplex: "DuplexNoTumble", InputSlot: "tray-1" }, map),
    { Duplex: "DuplexNoTumble", InputSlot: "tray-1" },
  );
  // 知らないキー / 知らない値は落ちる
  assert.deepEqual(
    validatePresetOptions(
      { Duplex: "DuplexNoTumble", StapleLocation: "SinglePortrait", InputSlot: "tray-9" },
      map,
    ),
    { Duplex: "DuplexNoTumble" },
  );
});

test("validatePresetOptions: 1 つも残らなければ null (UI に出さない契約)", () => {
  const map = parseLpoptionsChoices(LPOPTIONS);
  assert.equal(validatePresetOptions({ Unknown: "x" }, map), null);
  assert.equal(validatePresetOptions({}, map), null);
  assert.equal(validatePresetOptions(null, map), null);
  assert.equal(validatePresetOptions({ Duplex: "DuplexNoTumble" }, null), null);
});

test("pickMonoOption: PPD が広告する白黒指定を検出 (Apeos = ColorModel Gray)", () => {
  assert.deepEqual(pickMonoOption(parseLpoptionsChoices(LPOPTIONS)), { ColorModel: "Gray" });
  // ColorMode 形のドライバ
  assert.deepEqual(
    pickMonoOption(parseLpoptionsChoices("ColorMode/色: Color *Monochrome")),
    { ColorMode: "Monochrome" },
  );
  // 白黒系の選択肢が無い / 未知の形 → null (print-color-mode 単独に任せる)
  assert.equal(pickMonoOption(parseLpoptionsChoices("ColorModel/Color Mode: *RGB CMYK")), null);
  assert.equal(pickMonoOption(parseLpoptionsChoices(LPOPTIONS.split("\n").slice(0, 3).join("\n"))), null);
  assert.equal(pickMonoOption(null), null);
});

test("mergeMonoIntoPpdOptions: プリセットのカラー系キーは明示の白黒が勝つ", () => {
  // プリセット (トレイ・両面) + 白黒 → 単純合成
  assert.deepEqual(
    mergeMonoIntoPpdOptions({ InputSlot: "tray-1", Duplex: "DuplexNoTumble" }, { ColorModel: "Gray" }),
    { InputSlot: "tray-1", Duplex: "DuplexNoTumble", ColorModel: "Gray" },
  );
  // プリセットが ColorModel=RGB を持っていても白黒で上書き
  assert.deepEqual(
    mergeMonoIntoPpdOptions({ ColorModel: "RGB", InputSlot: "tray-2" }, { ColorModel: "Gray" }),
    { ColorModel: "Gray", InputSlot: "tray-2" },
  );
  // プリセット無し (null) + 白黒 → 白黒だけ
  assert.deepEqual(mergeMonoIntoPpdOptions(null, { ColorModel: "Gray" }), { ColorModel: "Gray" });
  // 両方無し → null
  assert.equal(mergeMonoIntoPpdOptions(null, null), null);
  assert.equal(mergeMonoIntoPpdOptions({ ColorMode: "Color" }, null), null);
});
