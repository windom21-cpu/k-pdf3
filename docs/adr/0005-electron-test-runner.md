# ADR-0005: SQLite 依存テストを Electron main process で走らせる軽量自前 runner

- 日付: 2026-05-09
- ステータス: 採用
- 関連: ADR-0004（Electron 版数の一時固定で表面化した問題）

## Context

ADR-0004 で記録した dual-ABI 問題の運用上の影響：

`better-sqlite3` のネイティブバインディングは **Node ABI（NMV 127）** または **Electron 38 ABI（NMV 139）** のいずれか一方しか保持できない。`npm run postinstall` で Electron 用に rebuild すると `npm test` が `ERR_DLOPEN_FAILED` で落ち、`npm rebuild --build-from-source` で Node 用に戻すと `npm start` が落ちる。

開発中は `npm start` ↔ `npm test` を頻繁に往復するため、毎回 30 秒〜数十秒の rebuild が走る。M2 以降はテストが増え、頻度はさらに上がる。

### テストごとの依存

実態を整理すると、SQLite に依存するテストは限定的：

| テスト | 依存 | dual-ABI 影響 |
|---|---|---|
| `test/coord.test.mjs` | 純 JS のみ | なし |
| `test/m1-exit-criteria.mjs` | `better-sqlite3`（Workspace 経由）| あり |
| `test/render.test.mjs` | `mupdf`（WASM）のみ | なし |

つまり問題は **「SQLite を触る一部のテストを Electron ABI で動かす経路が必要」** に集約される。

## Decision

- SQLite を触らないテストは引き続き **plain `node`** で実行
- SQLite を触るテストは **Electron main process 内で import して実行** する軽量自前 runner（`test/electron-runner.cjs`）を導入
- `npm test` は `test:coord`（node）→ `test:m1`（electron-runner）→ `test:render`（node）の順に走る
- 新規 npm 依存は **追加しない**

## Why この選択肢か

検討した options：

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. 軽量自前 runner** | ✅ 採用 | 依存追加なし、既存テスト書式維持、refactor は m1 テスト末尾の 2 行 + .cjs 1 ファイル |
| B. `electron-mocha` 導入 | ❌ 見送り | mocha 記法への 3 ファイル全面書き換え、依存 2 個追加（mocha + electron-mocha）、§13.2 の依存簡素化方針に逆行 |
| C. 毎回 rebuild する shell 自動化 | ❌ 見送り | 開発フロー毎に 30 秒〜の待ち時間、根本解決しない |
| D. `node:sqlite` で test だけ別実装 | ❌ 見送り | テストとプロダクションで実装が乖離。§17 の「真正性」要件に反する |

### 整合する HANDOVER 原則

- **§13.2 依存の簡素化**: `html2canvas-pro` / `pdf.js` 等を捨てた方針と整合
- **§14.4 ADR 起草**: 新規ライブラリ追加判断を明文化
- **§3.2 先回り提案**: 当面の friction を解消し、M2 以降の生産性を確保

## Consequences

### 受け入れる trade-off

#### 1. テスト本体に小さな refactor が必要

`test/m1-exit-criteria.mjs` の末尾を `process.exit(exitCode)` から `process.exitCode = exitCode` に変更した。理由：runner で `await import(...)` した時に process が即死すると後続テストが走れない。`process.exitCode` 設定なら、plain `node` 実行時も Electron runner 経由時も両方で正しく振る舞う。

将来の Electron ABI テストもこのパターンに従う必要がある。

#### 2. Electron 起動コストが test:m1 に乗る

毎回 Electron プロセスを spawn するため、`node` 直実行と比べて起動 1〜2 秒のオーバーヘッドがある。M2 以降のテスト数が増えても、Electron テストファイルは少数に留めれば無視できる。

#### 3. fail-fast の挙動

runner は最初のテスト失敗で停止する。複数テストを Electron 内で走らせるようになっても、失敗したものより後ろは走らない。CI では問題ないが、ローカルで「全部の失敗を一気に見たい」場合は調整が要る（M5 の CI 整備時に再評価）。

### 解除条件 / 将来の見直し

- ADR-0004 が解除（Electron 最新化）された場合、本 ADR の前提も再検討する。Node と Electron の NMV 差が縮まれば、より単純な構成へ戻せる可能性がある
- M3 / M4 で SQLite を触るテストが大量に増えた場合は、`electron-mocha` 等の汎用ツールへの乗り換えを再検討（テスト記法統一のメリットがコスト超過するライン）
- testing-library 系の UI テストを導入する場合は、本 runner ではカバーできない。その時点で別の test infrastructure を検討（ADR を新設）

## 影響範囲

- `test/electron-runner.cjs` 新規（〜50 行）
- `test/m1-exit-criteria.mjs` 末尾を runner 互換に修正
- `package.json` の `scripts.test:m1` を `electron --no-sandbox test/electron-runner.cjs` に変更
- HANDOVER.md §8.2（dev workflow）と §15.1（dual-ABI 注記）を更新
- ADR-0004 から「M2 で `electron-mocha` 検討」と書いた記述は、本 ADR の採用により上書き

## 検証

- `npm run postinstall` で Electron ABI rebuild
- `npm test`：62 coord + 51 m1 + 11 render = **124/124 pass**
- `npm start`：M1 placeholder UI 起動（手動確認）
- 同じ better-sqlite3 ビルドで両者が動く（rebuild の往復なし）
