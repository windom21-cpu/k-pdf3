# クラッシュ診断ロガー撤去 — 適用準備書 (stable 残務 #6)

> **状態: 準備のみ完了 / 未適用。** 引継ぎ §8.2-3 の「**前倒しは NG**」に従い、
> **stable タグを切る直前 (= Mac dmg ビルド + 実機確認が済んだ後)** に適用する。
> Mac ビルド待ちの間に印刷/Adobe 系が再発しても診断データを取れるよう、安全網
> (本ロガー) は最後まで残す。本ファイルは適用時に即実行できるよう棚卸し済の作業書。
>
> 作成: 2026-06-05 (qpdf Mac 同梱完了の直後、ローカルを `b21d7d9` に同期した状態で棚卸し)。
> 行番号は当時の値。**適用時はアンカー (関数名 / イベント名 / IPC チャネル名) で再特定**すること
> (stable までに β が進んで行番号がずれる前提)。

---

## 0. スコープと完了判定

撤去対象は「β.51〜.138 で累積したクラッシュ診断ロガー一式」= 下記 3 系統:

1. **中核基盤**: `crashLogPath()` / `logCrash()` / IPC `kpdf3:log-diag` / IPC `kpdf3:open-crash-log` /
   preload `logDiag` `openCrashLog` / index.html メニュー項目 / renderer `actionOpenCrashLog`。
2. **logCrash 呼び出し 34 箇所** (main.js) + **logDiag 呼び出し 9 箇所** (renderer.js) +
   **logFn 呼び出し 2 箇所** (mupdf-font-fallback.js)。
3. それらに**ログ payload を作るためだけに存在する診断変数/ブロック** (survivors / killDetails /
   `_diag` ヘルパ / print-tick tracking / followup-snapshot タイマー 等)。

**完了判定**:
- `grep -rn "logCrash\|logDiag\|crashLogPath\|log-diag\|open-crash-log\|openCrashLog\|actionOpenCrashLog" src/` が
  **0 ヒット** (コメント含め一掃)。
- `npm test` フルチェーン **exit 0 / 全 pass** (現状 415 pass)。
- 機能スモーク (§4 チェックリスト) を実機で確認。

---

## 1. ⚠️ 適用前に確定が必要な「判断ポイント」(2 件)

撤去は機械的に進められるが、以下 2 件だけは**挙動が変わる**ので、適用時にユーザー確認する。

### 判断 A: `uncaughtException` / `unhandledRejection` ハンドラをどうするか

`main.js:125-130` の
```js
process.on("uncaughtException", (err) => { logCrash("uncaughtException", err); });
process.on("unhandledRejection", (reason) => { logCrash("unhandledRejection", reason); });
```
は**ログだけでなく「未捕捉例外を握りつぶしてプロセス継続させる」副作用**を持つ。
ハンドラごと削除すると Node 既定動作に戻り、**未捕捉例外でアプリがクラッシュするようになる**
(= β.51 以前の挙動)。

- **案 a (推奨 / 忠実)**: ハンドラごと削除 = β.51 以前へ復帰。「診断ロガー一式の撤去」の文言に最も忠実。
  ただし stable 直前に「落ちる挙動」へ変える点はリスク。**実機スモークで未捕捉例外を起こしにくい
  ことを確認した上で採用**。
- **案 b (保守的)**: ログ行だけ消して `process.on("uncaughtException", () => {});` の **no-op ハンドラを残す**。
  クラッシュ抑止の現挙動を維持。「ロガー」は消えるが「握りつぶし」は残る。
- `render-process-gone` / `child-process-gone` (`main.js:131-136`) は**復旧ロジックを持たず純ログ**
  (β.90 の zombie 復旧は second-instance / window ライフサイクル側にある) なので、こちらは
  どちらの案でもハンドラごと削除でよい。

> 推奨: **案 a** (忠実撤去) + 適用直前の実機スモーク。ただしユーザーがリスク回避を望むなら案 b。

### 判断 B: 「クラッシュログを開く」メニューを残すか

`crash.log` 自体を撤去すると、`index.html:116` の `data-action="open-crash-log"` /
renderer `actionOpenCrashLog` / preload `openCrashLog` / IPC `kpdf3:open-crash-log` は
**開く対象が無くなる**。

- **案 a (推奨)**: メニュー項目ごと撤去 (4 箇所を一式削除)。一般ユーザー配布物にデバッグ導線は不要。
- **案 b**: メニューは残し、`crash.log` 不在時の「ログはありません」表示だけにする
  → ただしロガーが無いので常に空。意味が薄いので非推奨。

> 推奨: **案 a** (メニューごと撤去)。

---

## 2. 中核基盤の撤去 (unwire)

| # | 場所 (アンカー) | 当時行 | 作業 |
|---|---|---|---|
| 1 | `function crashLogPath()` (main.js) | 108-110 | 関数ごと削除 |
| 2 | `function logCrash(label, err)` (main.js) | 111-124 | 関数ごと削除 |
| 3 | `process.on("uncaughtException"...)` `..."unhandledRejection"...` (main.js) | 125-130 | **判断 A** に従う |
| 4 | `app.on("render-process-gone"...)` `..."child-process-gone"...` (main.js) | 131-136 | ハンドラごと削除 (純ログ) |
| 5 | `app.whenReady().then(() => logCrash("session-start"...))` (main.js) | 169-171 | `whenReady` ブロックごと削除 (中身が session-start ログのみ) |
| 6 | `registerFontFallback(logCrash)` の try/catch (main.js) | 178-182 | `registerFontFallback()` へ (引数削除)。catch の `logCrash("font-fallback-register-failed")` も削除。try/catch は残してよい (font 登録失敗の握りつぶしは機能) |
| 7 | `ipcMain.on("kpdf3:log-diag"...)` (main.js) | 185-187 | ハンドラごと削除 |
| 8 | `ipcMain.handle("kpdf3:open-crash-log"...)` (main.js) | 1660-1669 | **判断 B**=案a ならハンドラごと削除 |
| 9 | preload `logDiag:` (preload.cjs) | 95 | 行削除 + 上の β75 diag コメント (92-94) も削除 |
| 10 | preload `openCrashLog:` (preload.cjs) | 106 | **判断 B**=案a なら行削除 |
| 11 | index.html `data-action="open-crash-log"` メニュー | 116 | **判断 B**=案a なら `<div>` ごと削除 |
| 12 | renderer `async function actionOpenCrashLog()` | 5908-5919 | **判断 B**=案a なら関数ごと削除 |
| 13 | renderer action map `"open-crash-log": actionOpenCrashLog` | 6136 | エントリ削除 |
| 14 | renderer hint `"open-crash-log": "..."` | 6604 | エントリ削除 |

`appendFileSync` の import が他で未使用になったら削除 (要 grep 確認、main.js)。

---

## 3. 呼び出しサイトの撤去 (分類別)

分類: **A=純ログ** (行ごと削除で済む) / **B=診断変数を伴う** (payload を作る変数/ブロックも削除) /
**C=機能ハンドラ内** (周囲のロジックは残しログだけ剥がす)。

### 3.1 main.js — A (純ログ、当該行/ブロック削除のみ)

`session-start`*, `font-fallback-register-failed`*, `second-instance-deferred` (801),
`second-instance-recovery-window-spawned` (804), `second-instance-recovery-failed` (806),
`j5-zombie-kill-attempt` (731), `listAdobeRelatedProcesses-timeout` (2401),
`getProcessPidsByName-timeout` (2462), `pdfreader-cleanup-start` (2539-2543, 囲い try/catch ごと),
`pdfreader-followup-snapshot-error` (2736-2740), `pdfreader-dialog-finish` (2936-2942),
`pdfreader-jobs-drained` (2953), `pdfreader-cleanup-error` (2957), `pdfreader-process-closed` (2976-2983),
`print-cancel-by-user` (3200), `print-cancel-failed` (3202), `print-route` (3603-3617),
`print-route-end` (3662), `silent-print-failed` (2255-2258)。
(*=基盤側 §2 で扱い済)

> 注: `print-route` / `print-route-end` は payload に `isFax` `canSumatra` 等を渡すが、これらは
> **印刷ルーティングで別途使われる機能変数**。ログ行だけ消せばよい (変数は残す)。

### 3.2 main.js — B (診断変数も道連れに削除)

- **`primary-window-closed`** (555): 直前の `survivingWindows` (551-554) はログ専用 → 一緒に削除。
- **`j5-zombie-kill-result`** (753-757): `_j5Start` (730) / `gotLockAfter` 系はログ専用 → 削除。
- **`second-instance-quit`** (763-767): `_diagInitArgvPdfs` (717 付近) はログ専用 → 削除。
- **`second-instance-received`** (778-783): `allWindowsCount` (776) はログ専用 → 削除。
- **`open-pdf-stage`** (`open-pdf-file` ハンドラ, 1304-1382): `_t0` `_fileSize` `_diag` ヘルパ
  (1304-1309) と **全 `_diag(...)` 呼び出し** (1310/1330/1334/1345/1360/1366/1382 + catch 節内も)、
  および計測専用ローカル `_tRead` `_tFp` `_tImp` `_tDoc` を削除。
  **機能行 (`readFileSync` / `computePdfFingerprint` / `Workspace.*` / `openPdfDocument` 等) は残す**。
  例: `const _tRead = Date.now(); const pdfBytes = readFileSync(pdfPath); _diag("read-done", {...});`
  → `const pdfBytes = readFileSync(pdfPath);`
- **`print-tick`** (3013-3072 付近): `_tickN` `_lastLoggedTitlesKey` `titlesKey` `titlesChanged`
  `shouldLogTick` 等 tick 追跡変数とログ条件ブロックを削除。tick を回している**機能ループ本体は残す**
  (titles/marker 監視は印刷モーダル auto-close=β.138 の機能。**どの変数が auto-close 判定に使われて
  いるか適用時に再確認** — `docOpenedSeen` / `titleHasMarker` 等が機能側で参照されるなら残す)。
- **`print-via-reader-dialog-start`** (3503-3514): `tempBytes` (3501-3502) はログ専用 → 削除。

### 3.3 main.js — C の最重要トラップ: `killNewPdfReaderProcesses` (2532-2744)

この関数は **Adobe/Reader 実 kill (機能)** と **診断ログ用データ収集** が密に絡む。ログだけ剥がすと
**機能が壊れる箇所が 1 つある**ので注意。

機能として残すもの:
- 第 1 kill ループ (2565-2607): `getProcessPidsByName` → `killTargets = afterPids` → `taskkill /F /T`。
- `adobeRelatedAtCleanup` (2558/2562): **2618 の extra kill ループで実 kill 対象に使う = 機能**。残す。
- extra kill ループ (2617-2639): `taskkill` 本体は機能。残す。

診断専用として削除するもの:
- `killedCounts` / `newPidsByExe` / `preExistingPidsByExe` (2545-2575) — ログ専用。
- `adobeRelatedAtCleanupWide` (2559/2563) — wide は診断専用 (kill しない)。削除。
- survivors 一式 (2653-2668) — 500ms 待ち + 再 snapshot は**診断専用** (kill しない)。ブロックごと削除。
  ※ 500ms の `await` が消えると cleanup が ~0.5s 早く返る。呼び出し側に依存が無いことを確認 (無いはず)。
- `pdfreader-cleanup` ログ (2670-2687) — 削除。
- followup-snapshot タイマー一式 (2702-2743) — コメント明記「診断目的なので副作用ゼロ (kill しない)」。
  `setTimeout(...).unref()` 3 本ごと削除。

> 🔴 **トラップ (必ず対応)**: `killDetails` は診断に見えて、**2611-2616 で `knownKilled` セットを
> 作るのに使われ、それが extra kill ループ (2618-2619 の `if (knownKilled.has(pid)) continue`) で
> 二重 kill 防止に機能している**。`killDetails` を単純削除すると `knownKilled` が空になり、第 1 ループで
> 既に kill 済の PID を extra ループが再 taskkill する (実害は軽微だが余計動作)。
> **対応**: `killDetails` の代わりに第 1 ループで kill を試みた PID を貯める最小セットを導入する。
> ```js
> const killedPids = new Set();
> // 第1ループ内、killTargets を回す箇所で:
> for (const pid of killTargets) { killedPids.add(pid); /* ...taskkill... */ }
> // 2611-2616 の knownKilled 構築を置換:
> const knownKilled = killedPids;
> ```
> `details` / `killDetails[exeName] = details` / 各 `outcome` の収集は削除してよい (kill 自体は
> `taskkill` 実行が副作用。戻り値の outcome はログ専用)。extra ループの `extraKilled.push(outcome)` も
> 削除 (await は順序維持のため残す)。

### 3.4 renderer.js — A (logDiag、全て純ログ・行削除のみ)

`open-pdf-renderer-error` (2936-2941), `gap-drop-file` (5143), `drop-no-files` (6678),
`drop-no-path` (6687), `drop-not-pdf` (6692), `drop-opening` (6696), `drop-opened` (6701),
`drop-error` (6703), `os-open-received` (6815)。

> `_diagBase` (drop ハンドラ内) が logDiag 専用なら一緒に削除。drop ハンドラの**実オープン処理
> (`openPdfSmart` 等) は機能**なので残す。各 logDiag は `kpdf3.logDiag?.(...)` の単独文 → 行削除で済む。

### 3.5 mupdf-font-fallback.js — B/C (clean)

`registerFontFallback(logFn = null)` (112-138): main が `registerFontFallback()` を引数なしで
呼ぶようになる (§2-6) ので `logFn` は常に null。
- `logCount` / `MAX_LOG` (115-116) 削除。
- `if (logFn && logCount < MAX_LOG){ ...logFn("font-fallback-callback"...) }` ブロック (125-132) 削除。
- `if (logFn){ logFn("font-fallback-registered"...) }` (135-137) 削除。
- **機能コア (`installLoadFontFunction` のコールバックで CJK 判定 → `pickFontFile` → `loadFontCached`、
  および `return result`) は残す**。引数 `logFn` も消して `registerFontFallback()` に。

---

## 4. 適用後の検証チェックリスト

- [ ] `grep -rn "logCrash\|logDiag\|crashLogPath\|log-diag\|open-crash-log\|openCrashLog\|actionOpenCrashLog\|font-fallback-callback\|font-fallback-register" src/` が **0 ヒット** (コメント含む)
- [ ] `appendFileSync` / その他 import が孤児になっていないか (未使用 import 削除)
- [ ] `npm test` フルチェーン exit 0 / 全 pass
- [ ] 実機スモーク: 通常起動 → PDF open/close 反復 → 印刷 1 経路 → Adobe 残留 cleanup が従来どおり走る
      (kill 機能を壊していない確認。特に §3.3 の `knownKilled` 置換)
- [ ] 巨大 PDF (200MB 超) を 1 回 open (open-pdf-stage 診断を抜いても開けること)
- [ ] CJK フォント fallback が効く PDF を 1 枚描画 (font-fallback の機能コアが生きている確認)
- [ ] 判断 A=案a を採った場合: 未捕捉例外まわりで明らかな regression が無いか軽く触る
- [ ] メニューから「クラッシュログを開く」が消えている (判断 B=案a)

---

## 5. 参考: 引継ぎ側の記述

- HANDOVER §8.2-3 (オープン項目 3) / §6.3 項目 20 / §「v2.0.0 stable に向けた残作業」の
  「🔴 クラッシュ診断ロガー撤去 (stable 残務 #6、最後)」に対象シンボルの列挙あり。本書はその実装版。
- 適用が済んだら HANDOVER の該当行を ✅ に更新 (ただし **HANDOVER 更新はユーザー明示依頼時のみ** の方針に従う)。
</content>
</invoke>
