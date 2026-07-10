// 2026-07-10: macOS 印刷プリセットの CUPS 直送対応。
//
// ユーザーがプレビュー等のシステム印刷ダイアログで保存した「プリセット」
// (トレイ・両面など) は、システムダイアログ専用の機能ではなく、実体は
//   ~/Library/Preferences/com.apple.print.custompresets.forprinter.<queue>.plist
//   ~/Library/Preferences/com.apple.print.custompresets.plist   (全プリンタ共通)
// に保存された設定の束で、中身の大半は PPD オプション (InputSlot=tray-1 /
// Duplex=DuplexNoTumble 等) がそのまま入っている。これは `lp -o Key=Value`
// にそのまま渡せる形式なので、K-PDF3 自前ダイアログにプリセット選択欄を
// 出し、高品質な CUPS 直送 (print-cups.js) のままプリセットを効かせられる。
//
// システムダイアログ (`webContents.print({silent:false})`) を出す案は
// 「ダイアログを閉じた瞬間に Electron の PDF プラグイン teardown が crash」
// (HANDOVER §「直結 print が落ちる」、β72 案 D 移行の理由) で却下済のため
// 使わない。
//
// 安全設計:
//   - plist の設定のうち、**そのプリンタの PPD (`lpoptions -p <q> -l`) が
//     実際に広告しているオプション名 × 選択肢に一致するものだけ**通す。
//     Cocoa 内部キー (com.apple.print.*, 数値の DuplexBindingEdge 等) や
//     ドライバが知らない値は、送っても無視されるのではなく事故のもとに
//     なり得るので構造的に落とす。
//   - 有効なオプションが 1 つも残らないプリセット (Cocoa 内部設定だけの
//     もの) は一覧に出さない。「選んだのに何も効かない」を UI に出さない。
//   - プリセットの並びは plist の customPresetsInfo (システムダイアログの
//     表示順) に従う。プリンタ専用 → 全プリンタ共通の順で、同名は専用優先。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUTIL = "/usr/bin/plutil";
const LPOPTIONS_PATHS = ["/usr/bin/lpoptions", "/usr/local/bin/lpoptions"];

// PPD メインキーワード / 選択肢キーワードとして妥当な形。PPD の keyword は
// 空白を含まない ASCII 語 (例: InputSlot / tray-1 / DuplexNoTumble)。
// lp の引数は spawn の配列渡しで shell を経由しないが、`-o` の解釈段でも
// 変な文字列を作らないよう二重に絞る。
const PPD_KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const PPD_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * plist (JSON 変換済) からプリセット候補を取り出す (pure、テスト対象)。
 * 返り値: [{ name, settings: { Key: "Value", ... } }] — settings は
 * 「PPD オプションの形をした文字列設定」のみ (PPD 照合は呼び出し側)。
 *
 * **customPresetsInfo に載っている名前だけがユーザーの作ったプリセット。**
 * plist には Cocoa の内部エントリ (「デフォルト設定」「最後に使用した設定」
 * "vendorDefaultSettings") も同じ形で同居しており、これらは
 * customPresetsInfo (システムダイアログのプリセット一覧そのもの) には
 * 載らない — M1 実機の 2 plist で確認。特に「最後に使用した設定」を
 * 出してしまうと「前回設定の記憶」に等しく、毎回明示選択の運用方針
 * (FAX 誤送信の教訓) に反する。customPresetsInfo が無い plist (共通 plist
 * が内部エントリだけの状態) はプリセット 0 件として扱う。
 */
export function extractPresets(plistJson) {
  if (!plistJson || typeof plistJson !== "object") return [];
  const info = plistJson["com.apple.print.customPresetsInfo"];
  if (!Array.isArray(info)) return [];
  const entries = [];
  for (const e of info) {
    const name = e?.PresetName;
    if (typeof name !== "string" || name.startsWith("com.apple.print.")) continue;
    const raw = plistJson[name]?.["com.apple.print.preset.settings"];
    if (!raw || typeof raw !== "object") continue;
    const settings = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!PPD_KEY_RE.test(k)) continue;               // com.apple.* 等を除外
      if (typeof v !== "string" || !PPD_VALUE_RE.test(v)) continue;
      settings[k] = v;
    }
    entries.push({ name, settings });
  }
  return entries;
}

/**
 * `lpoptions -p <queue> -l` の出力を { keyword → Set(選択肢) } に変換
 * (pure、テスト対象)。行形式: "Duplex/2-Sided Printing: None *DuplexNoTumble ..."
 * (現在値の * は剥がす)。
 */
export function parseLpoptionsChoices(output) {
  const map = new Map();
  for (const line of String(output ?? "").split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9]*)\/[^:]*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const choices = new Set(
      m[2].split(/\s+/).map((c) => c.replace(/^\*/, "")).filter(Boolean),
    );
    if (choices.size > 0) map.set(m[1], choices);
  }
  return map;
}

/**
 * プリセットの settings を「PPD が実際に広告しているもの」だけに絞る
 * (pure、テスト対象)。1 つも残らなければ null。
 */
export function validatePresetOptions(settings, choicesMap) {
  if (!settings || !(choicesMap instanceof Map)) return null;
  const out = {};
  for (const [k, v] of Object.entries(settings)) {
    if (choicesMap.get(k)?.has(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function _plistPathsFor(deviceName) {
  const prefs = join(homedir(), "Library", "Preferences");
  return [
    join(prefs, `com.apple.print.custompresets.forprinter.${deviceName}.plist`),
    join(prefs, "com.apple.print.custompresets.plist"),
  ];
}

function _execText(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/**
 * 指定 CUPS キューで使える macOS 印刷プリセットの一覧。
 * 返り値: [{ name, options: { Key: "Value", ... } }] (options は PPD 照合済)。
 * darwin 以外・plist 不在・lpoptions 不在では []。失敗も [] (印刷自体は
 * プリセット無しで従来通り可能なので、ここでは絶対に throw しない)。
 */
export async function listMacPrintPresets(deviceName) {
  if (process.platform !== "darwin") return [];
  const name = String(deviceName ?? "");
  // キュー名はそのまま plist ファイル名に入る。パス区切りを含む名前は
  // CUPS 上あり得ないが、path traversal 防止として構造的に弾く。
  if (!name || /[/\\]|\.\./.test(name)) return [];
  const lpoptions = LPOPTIONS_PATHS.find((p) => existsSync(p));
  if (!lpoptions || !existsSync(PLUTIL)) return [];
  const lpoptOut = await _execText(lpoptions, ["-p", name, "-l"]);
  if (!lpoptOut) return [];
  const choicesMap = parseLpoptionsChoices(lpoptOut);
  if (choicesMap.size === 0) return [];

  const out = [];
  const seen = new Set();
  for (const plistPath of _plistPathsFor(name)) {
    if (!existsSync(plistPath)) continue;
    const json = await _execText(PLUTIL, ["-convert", "json", "-o", "-", plistPath]);
    if (!json) continue;
    let parsed;
    try { parsed = JSON.parse(json); } catch { continue; }
    for (const preset of extractPresets(parsed)) {
      if (seen.has(preset.name)) continue; // プリンタ専用が共通より優先
      const options = validatePresetOptions(preset.settings, choicesMap);
      if (!options) continue;
      seen.add(preset.name);
      out.push({ name: preset.name, options });
    }
  }
  return out;
}

/**
 * プリセット名 → PPD オプション。見つからなければ null (呼び出し側で
 * 明示エラーにする — 黙って素通し印刷にすると「プリセットで刷れた」と
 * 誤認させるため)。
 */
export async function resolveMacPresetOptions(deviceName, presetName) {
  const presets = await listMacPrintPresets(deviceName);
  return presets.find((p) => p.name === presetName)?.options ?? null;
}
