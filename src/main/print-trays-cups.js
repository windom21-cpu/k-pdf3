// 2026-07-14: CUPS 直送 (Mac/Linux) の給紙トレイ選択。
//
// 動機 (ユーザー): 用紙サイズごとにトレイが用意されているので、印刷時に
// トレイを指名したい。従来は macOS プリセット (print-presets-mac.js) を
// 作らないと指定できず、自前ダイアログにトレイ欄が無かった。
//
// 実体は PPD の給紙オプション (Apeos C2360 なら InputSlot=Tray1 等) で、
// プリセットが lp -o に渡しているのと同じもの。よってここでも
//   1. `lpoptions -p <queue> -l` が **実際に広告している** 給紙キーワードと
//      その選択肢だけを扱う (ドライバが知らない値は構造的に送らない)
//   2. PPD ファイル (/etc/cups/ppd/<queue>.ppd) があれば、選択肢の
//      **人間向けラベル** ("Tray1/トレイ 1") を拾って UI に出す
//      (PPD が無い AirPrint/driverless キューではキーワードをそのまま表示)
// という print-presets-mac.js と同じ安全設計に乗せる。
//
// 運用方針: 選択は記憶せず毎回「(プリンタ任せ)」に戻す (プリンタ記憶が
// FAX 誤送信を招いた教訓と同じ。印刷のたびに明示させる)。
//
// Windows (Adobe /p 経路) は対象外 — トレイは従来どおりプリンタの
// 「プロパティ...」(DEVMODE、printer-properties-win.js) で指定する。

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { parseLpoptionsChoices } from "./print-presets-mac.js";

const LPOPTIONS_PATHS = ["/usr/bin/lpoptions", "/usr/local/bin/lpoptions"];

// 給紙オプションの PPD キーワード (優先順)。InputSlot が標準で、
// ベンダー PPD が別名を使う場合に備えて既知の別名も見る。**広告されて
// いるものだけ**採用するので、複数該当しても最初の 1 つに決まる。
const TRAY_KEYS = ["InputSlot", "MediaSource", "InputTray"];

// PPD の翻訳ラベルにも一応の形を要求する (UI に流し込むので制御文字を弾く)。
const LABEL_RE = /^[^\x00-\x1f]{1,60}$/;

// 2026-07-14 実機 (Apeos C2360): 選択肢が `auto` / `tray-1` … の **IPP 標準
// キーワード**で出てきた (PPD が無い or 翻訳行を持たない driverless/IPP キュー)。
// キーワードのままではダイアログとして読めないので、既知キーワードは日本語に
// 直す。**PPD に翻訳がある場合はそちらが勝つ** (ドライバの言い回しが正)。
// 表に無いキーワードはそのまま表示する (勝手に意訳して取り違えるより安全)。
const IPP_TRAY_LABELS = new Map(Object.entries({
  "auto": "自動選択",
  "auto-select": "自動選択",
  "default": "プリンタ既定",
  "main": "主トレイ",
  "main-roll": "主ロール",
  "manual": "手差し",
  "bypass-tray": "手差しトレイ",
  "by-pass-tray": "手差しトレイ",
  "alternate": "代替トレイ",
  "top": "上トレイ",
  "middle": "中トレイ",
  "bottom": "下トレイ",
  "side": "横トレイ",
  "large-capacity": "大容量トレイ",
  "envelope": "封筒トレイ",
}));

/** IPP 標準キーワードの日本語ラベル (pure)。tray-N / tray_N / trayN は
 *  「トレイ N」に畳む。未知のキーワードは null (呼び出し側がそのまま表示)。 */
export function ippTrayLabel(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const v = value.trim().toLowerCase();
  const known = IPP_TRAY_LABELS.get(v);
  if (known) return known;
  const n = /^tray[-_ ]?(\d+)$/.exec(v)?.[1];
  return n ? `トレイ ${Number(n)}` : null;
}

/** choicesMap (parseLpoptionsChoices の出力) から給紙キーワードを選ぶ。
 *  広告が無ければ null (= このプリンタではトレイ指定不可 → 欄を出さない)。 */
export function pickTrayKey(choicesMap) {
  if (!(choicesMap instanceof Map)) return null;
  for (const key of TRAY_KEYS) {
    const choices = choicesMap.get(key);
    if (choices && choices.size > 0) return key;
  }
  return null;
}

/**
 * PPD 本文から指定キーワードの「選択肢 → 表示ラベル」を拾う (pure)。
 * PPD の行形式:  *InputSlot Tray1/トレイ 1: "<</MediaPosition 1>>setpagedevice"
 * 翻訳が無い (`*InputSlot Auto: "..."`) 行はラベル省略 = 呼び出し側が
 * キーワードをそのまま使う。
 */
export function parsePpdChoiceLabels(ppdText, key) {
  const labels = new Map();
  if (typeof ppdText !== "string" || !key) return labels;
  const re = new RegExp(`^\\*${key}\\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?:/([^:]*))?:`, "gm");
  for (const m of ppdText.matchAll(re)) {
    const value = m[1];
    const label = (m[2] ?? "").trim();
    if (label && LABEL_RE.test(label)) labels.set(value, label);
  }
  return labels;
}

/** 広告された選択肢を UI 用の配列にする (pure)。表示名の優先順位:
 *  ①PPD の翻訳 (ドライバの言い回しが正) → ②IPP 標準キーワードの和訳
 *  → ③キーワードそのまま (未知の値を意訳して取り違えない)。 */
export function buildTrayChoices(advertised, labels) {
  if (!(advertised instanceof Set)) return [];
  const out = [];
  for (const value of advertised) {
    out.push({
      value,
      label: labels?.get(value) ?? ippTrayLabel(value) ?? value,
    });
  }
  return out;
}

function _execText(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

function _safeQueueName(deviceName) {
  const name = String(deviceName ?? "");
  // キュー名は PPD のファイル名に入る。CUPS 上あり得ない形は構造的に弾く
  // (print-presets-mac.js と同じ path traversal ガード)。
  if (!name || /[/\\]|\.\./.test(name)) return null;
  return name;
}

/**
 * 指定 CUPS キューで選べる給紙トレイ。
 * 返り値: { key: "InputSlot", choices: [{ value, label }] } — 指定不可なら null。
 * lpoptions 不在 / Windows / 失敗はすべて null (印刷自体はトレイ指定なしで
 * 従来どおり可能なので、ここでは絶対に throw しない)。
 */
export async function listCupsTrays(deviceName) {
  if (process.platform === "win32") return null;
  const name = _safeQueueName(deviceName);
  if (!name) return null;
  const lpoptions = LPOPTIONS_PATHS.find((p) => existsSync(p));
  if (!lpoptions) return null;
  const out = await _execText(lpoptions, ["-p", name, "-l"]);
  if (!out) return null;
  const choicesMap = parseLpoptionsChoices(out);
  const key = pickTrayKey(choicesMap);
  if (!key) return null;

  // PPD があれば日本語ラベル ("トレイ 1" 等) を拾う。driverless キューには
  // PPD が無いので、その場合はキーワードをそのまま見せる。
  let labels = new Map();
  const ppdPath = `/etc/cups/ppd/${name}.ppd`;
  if (existsSync(ppdPath)) {
    try {
      labels = parsePpdChoiceLabels(
        readFileSync(ppdPath, { encoding: "latin1" }), key,
      );
    } catch { /* 読めなければキーワード表示にフォールバック */ }
  }
  const choices = buildTrayChoices(choicesMap.get(key), labels);
  return choices.length > 0 ? { key, choices } : null;
}

/**
 * ppdOptions (プリセット由来、null 可) にトレイ指定を合成する (pure)。
 * **ダイアログで明示したトレイがプリセットの給紙指定に勝つ** (白黒と同じ
 * 方針 — 明示選択を黙って上書きされる方が事故)。tray が null なら素通し。
 */
export function mergeTrayIntoPpdOptions(ppdOptions, trayOption) {
  const out = {};
  for (const [k, v] of Object.entries(ppdOptions ?? {})) {
    if (trayOption && TRAY_KEYS.includes(k)) continue;
    out[k] = v;
  }
  Object.assign(out, trayOption ?? {});
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * ダイアログで選ばれたトレイ値を **印刷時点で** PPD 照合し、
 * { InputSlot: "Tray2" } の形にする。ダイアログを開いたあとにキューが
 * 差し替わった等で選択肢が消えていたら null → 呼び出し側は明示エラーに
 * する (黙ってプリンタ任せで刷ると「トレイ指定で刷れた」と誤認させる。
 * プリセット解決と同じ思想)。
 */
export async function resolveTrayOption(deviceName, trayValue) {
  if (!trayValue) return null;
  const trays = await listCupsTrays(deviceName);
  if (!trays) return null;
  const hit = trays.choices.find((c) => c.value === trayValue);
  return hit ? { [trays.key]: hit.value } : null;
}
