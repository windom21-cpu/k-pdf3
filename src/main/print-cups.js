// 2026-07-10: §15.6 Step 1 — Mac/Linux の印刷を Chromium raster 経由から
// CUPS 直送 (`lp`) に置換する印刷エンジン。
//
// macOS / Linux の印刷系 (CUPS) は PDF がネイティブ形式なので、組み立て
// 済み PDF を `lp` でスプーラに渡せば変換なしでドライバに届く:
//   - 実寸 100% が構造的に保証される (Chromium silent の fit-to-printable-
//     area 縮小 (β.91) が経路ごと消える)
//   - ベクター品質のまま (明朝 hairline も raster 劣化しない)
//   - Windows の Adobe 起動→監視→kill のような外部アプリ管理が不要
//
// 設計判断:
//   - orientation (landscape) は **渡さない**。PDF ページ自体が向きを
//     持っており、`-o orientation-requested` を併用すると回転二重がけ
//     (Windows で A3 横 180° 事故を起こしたクラスのバグ) を招くため。
//   - media は 1 ページ目のサイズが既知の定型 (A3-A5 / JIS B4-B5 /
//     Letter / Legal) に一致した時だけ PWG self-describing name で渡す。
//     不明サイズはプリンタ既定に任せる (誤った強制よりも安全)。
//   - FAX キューは対象外 (呼び出し側 main.js が isFax で弾く)。宛先入力
//     はドライバダイアログ前提で、lp 直送では渡せないため。
//
// キャンセル: lp はスプール投入後すぐ exit する。投入前なら子プロセス
// kill、投入後でも request id を覚えておき `cancel <id>` でキュー から
// 取り消す (Windows 経路より一歩良い semantics)。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const LP_PATHS = ["/usr/bin/lp", "/usr/local/bin/lp"];
const CANCEL_PATHS = ["/usr/bin/cancel", "/usr/local/bin/cancel"];

function _firstExisting(paths) {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** CUPS 直送エンジンが使えるか (非 Windows + lp 実在)。 */
export function cupsAvailable() {
  if (process.platform === "win32") return false;
  return _firstExisting(LP_PATHS) !== null;
}

// PDF point 単位の定型用紙 (portrait 基準)。PWG self-describing name は
// モダン CUPS / IPP Everywhere キューの双方が解釈する。許容誤差 ±4pt
// (≒1.4mm、A4 595.28pt の丸め揺れを吸収)。
const _MEDIA_TABLE = [
  { w: 841.89, h: 1190.55, name: "iso_a3_297x420mm" },
  { w: 595.28, h: 841.89, name: "iso_a4_210x297mm" },
  { w: 419.53, h: 595.28, name: "iso_a5_148x210mm" },
  { w: 728.5, h: 1031.81, name: "jis_b4_257x364mm" },
  { w: 515.91, h: 728.5, name: "jis_b5_182x257mm" },
  { w: 612, h: 792, name: "na_letter_8.5x11in" },
  { w: 612, h: 1008, name: "na_legal_8.5x14in" },
];
const _MEDIA_TOLERANCE_PT = 4;

/** ページサイズ (pt) → PWG media name。横向きページは縦横を入れ替えて
 *  照合 (media name は常に portrait 表記、向きは PDF ページ側が持つ)。
 *  定型に一致しなければ null。 */
export function mediaNameForSizePt(widthPt, heightPt) {
  if (!(widthPt > 0) || !(heightPt > 0)) return null;
  const w = Math.min(widthPt, heightPt);
  const h = Math.max(widthPt, heightPt);
  for (const m of _MEDIA_TABLE) {
    if (Math.abs(w - m.w) <= _MEDIA_TOLERANCE_PT && Math.abs(h - m.h) <= _MEDIA_TOLERANCE_PT) {
      return m.name;
    }
  }
  return null;
}

/**
 * lp コマンドの引数列を組み立てる (pure、テスト対象)。
 *
 * opts:
 *   deviceName  CUPS キュー名 (Electron getPrintersAsync の name と一致)
 *   copies      部数 (default 1)
 *   duplex      "simplex" | "long-edge" | "short-edge" | null → -o sides=
 *   color       "mono" | "color" | null → mono のみ -o print-color-mode=
 *   sizing      "fit" | "actual" | null → fit のみ -o fit-to-page
 *   widthPt / heightPt  1 ページ目のサイズ (media 照合用、無ければ omit)
 */
export function buildLpArgs(pdfPath, opts = {}) {
  const args = ["-d", String(opts.deviceName ?? "")];
  const copies = Math.max(1, Number(opts.copies) || 1);
  args.push("-n", String(copies));
  if (opts.duplex === "long-edge") args.push("-o", "sides=two-sided-long-edge");
  else if (opts.duplex === "short-edge") args.push("-o", "sides=two-sided-short-edge");
  else if (opts.duplex === "simplex") args.push("-o", "sides=one-sided");
  if (opts.color === "mono") args.push("-o", "print-color-mode=monochrome");
  if (opts.sizing === "fit") args.push("-o", "fit-to-page");
  // 常に高品質 (IPP print-quality: 3=draft 4=normal 5=high)。AirPrint 系
  // キューは Normal だと低めの解像度でラスタ処理することがあり、墨消し
  // ページ (900dpi 全面画像、β.85) の縮小再標本化でテキストがぼやける
  // (2026-07-10 Apeos C2360 実機で報告)。法律文書用途は品質最優先。
  args.push("-o", "print-quality=5");
  const media = mediaNameForSizePt(opts.widthPt, opts.heightPt);
  if (media) args.push("-o", `media=${media}`);
  args.push("--", pdfPath);
  return args;
}

let _activeLpProcess = null;
let _lastRequestId = null;

/** lp stdout から request id を取り出す。メッセージ文はロケールで翻訳
 *  される (日本語 macOS では「要求IDは<queue>-<n>です...」、しかも
 *  Apple CUPS は LC_ALL=C を無視して OS 設定ロケールを使うことを M1
 *  実機で確認) ため、文言でなく「キュー名-数字」というロケール非依存
 *  パターンで拾う。 */
export function parseRequestId(stdout, deviceName) {
  if (deviceName) {
    const esc = String(deviceName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(${esc}-\\d+)`).exec(stdout);
    if (m) return m[1];
  }
  const en = /request id is (\S+)/.exec(stdout); // 英語ロケールの保険
  return en ? en[1] : null;
}

/**
 * 組み立て済み PDF を CUPS キューへ直送する。lp のスプール投入完了
 * (exit 0) で resolve。stdout の "request id is <id> (N file(s))" から
 * job id を取り出して返す (取れなくても成功扱い)。
 *
 * @returns {Promise<{ requestId: string | null }>}
 */
export function cupsPrintPdf(pdfPath, opts = {}) {
  const lp = _firstExisting(LP_PATHS);
  if (!lp) return Promise.reject(new Error("lp (CUPS) not found"));
  if (!opts.deviceName) return Promise.reject(new Error("cupsPrintPdf: deviceName missing"));
  const args = buildLpArgs(pdfPath, opts);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    // LC_ALL=C は Linux 向け (glibc lp はこれで英語固定)。Apple CUPS は
    // env を無視して OS 設定ロケールで翻訳するため、パース側も
    // parseRequestId のロケール非依存パターンで対応する (M1 実機確認)。
    const child = spawn(lp, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    _activeLpProcess = child;
    // lp はローカルスプール投入のみで通常 1 秒未満。30 秒は「CUPS デーモン
    // 停止等で永久に返らない」事故の防波堤。
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      _activeLpProcess = null;
      reject(new Error("lp timed out (30s) — CUPS デーモンが応答していません"));
    }, 30_000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _activeLpProcess = null;
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _activeLpProcess = null;
      if (code === 0) {
        _lastRequestId = parseRequestId(stdout, opts.deviceName);
        resolve({ requestId: _lastRequestId });
      } else {
        reject(new Error(`lp exited ${code}: ${(stderr || stdout).trim()}`));
      }
    });
  });
}

/** 中止ボタン用: 投入前なら lp 子プロセスを kill、投入済みなら覚えて
 *  いた request id を `cancel` でキューから取り消す (best-effort)。 */
export function cupsCancelInFlight() {
  if (_activeLpProcess) {
    try { _activeLpProcess.kill(); } catch { /* ignore */ }
    _activeLpProcess = null;
  }
  if (_lastRequestId) {
    const cancelBin = _firstExisting(CANCEL_PATHS);
    if (cancelBin) {
      try {
        spawn(cancelBin, [_lastRequestId], { stdio: "ignore", detached: false });
      } catch { /* ignore */ }
    }
    _lastRequestId = null;
  }
}
