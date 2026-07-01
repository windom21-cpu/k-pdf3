# ADR-0004: Electron を ^38.8.6 に一時固定する（better-sqlite3 互換性のため）

- 日付: 2026-05-09
- ステータス: 採用（一時的、解除条件あり）
- 関連: ADR-0001（workspace SQLite 採用）

## Context

M1 完了後、`build-essential` を導入して `npm run postinstall`（`electron-builder install-app-deps`）を初めて実行したところ、**better-sqlite3 12.9.0 のソースコードが Electron 42 同梱の V8 13.x の API と非互換** であることが判明した。

具体的なコンパイルエラー：

- `error: call of overloaded 'SetNativeDataProperty(...)' is ambiguous`（`src/util/helpers.cpp:89`）
- `error: no matching function for call to 'v8::External::Value()'`（`src/util/macros.cpp:30`、複数箇所）
- `error: no matching function for call to 'v8::External::New(v8::Isolate*&, Addon*&)'`（`src/better_sqlite3.cpp:60`）

### 上流の状況（2026-05-09 時点）

- `WiseLibs/better-sqlite3` は 2026-03 〜 2026-05 にかけて Electron 41+ への対応で連続的に苦戦している
- v12.7.0（2026-03-11）：「Electron v41 bit us」として NOT A VIABLE RELEASE
- v12.7.1（2026-03-13）：再度 NOT A VIABLE
- v12.8.0（2026-03-13）：`HolderV2()` 対応で V8 ≥ 12.5 の一部 API 修正
- v12.9.0（2026-04-12）：npm 公開最新だが Electron 42 のソースビルド非対応
- v12.9.1（2026-05-06、3 日前）：GitHub Release のみ、npm 未公開、`Electron v42 prebuilds` PR を含むが「NOT A VIABLE RELEASE」と公式警告。実際の prebuilt asset は **Electron 38（NMV 139）まで** しか焼けていない

### Electron version → NMV 対応（node-abi 4.31.0）

| Electron | NMV | better-sqlite3 12.9.1 prebuild |
|---|---|---|
| 42.0.0 | 146 | ❌ |
| 41.0.0 | 145 | ❌ |
| 40.0.0 | 143 | ❌ |
| 39.0.0 | 140 | ❌ |
| **38.8.6** | **139** | **✅** |
| 37.x | 136 | ✅ |

**結論**: 現時点で Electron 39 以降に対応した better-sqlite3 ビルドは、ソース・prebuilt とも存在しない。

## Decision

`package.json` の `devDependencies.electron` を `42.0.0` → `^38.8.6` に固定する。

これは **一時的な措置** であり、後述の解除条件を満たした時点で Electron 最新へ戻す。

## Why この選択肢か

### 検討した options

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. Electron を ^38.8.6 にピン留め** | ✅ 採用 | architecture を一切変更せず、可逆、即実行可能、prebuilt が揃っている |
| B. node:sqlite（Node 22 builtin）に移行 | ❌ 見送り | experimental、FTS5 / R\*Tree / WAL 対応未確認、ADR-0001 と schema の前提が崩れる、M2 直前にやる作業ではない |
| C. libsql / @libsql/client に移行 | ❌ 見送り | SQLite フォーク、互換性検証コスト、外部依存追加、§13.2 の依存簡素化方針と逆行 |
| D. 上流対応を待機 | ❌ 見送り | M2 着手不能、解決時期不明、業務凍結期間を浪費 |

### 整合する HANDOVER 原則

- **§2.1 architecture-first**: 3-layer 分離・座標系・schema 等の本体設計は一切変更しない。ツールチェーンだけを安定線に戻す。
- **§3.1 ユーザー像**: 法律実務家、業務凍結中。実装に集中できる時期に依存ライブラリ debug で時間を溶かさない。
- **§17.1 配布要件**: ローカル完結・私的配布のみ。最新 Chromium が必須ではない。

## Consequences

### 受け入れる trade-off

#### 1. Electron 38 の高セベリティ脆弱性 4 件

`npm audit` が以下を報告している：

- GHSA-532v-xpq5-8h95: offscreen child window paint callback の use-after-free
- GHSA-8x5q-pvf5-64mp: offscreen shared texture release() の use-after-free
- GHSA-f37v-82c4-4x64: clipboard.readImage() の不正画像によるクラッシュ
- GHSA-f3pv-wv63-48x8: window.open ターゲットの opener スコープ破り

**評価**: K-PDF3 の脅威モデルでは **実害は限定的**。

- アプリは **ローカル完結**、Web コンテンツのレンダリングはしない（ADR-0001 / §17.1）
- 画像 clipboard 経由の悪意ある PDF 入力は、source PDF を mupdf.js が parse する経路では発火しない
- 配布範囲は自分中心 + スタッフ数名、信頼境界が明確

**ただし** v2.0.0-beta.1 リリース（M5 完了時）までに Electron 39+ に戻せていない場合は、配布前に再評価する。

#### 2. dev workflow の二重 ABI 問題

`better-sqlite3` のネイティブバインディングは **Node ABI（`npm test`）と Electron ABI（`npm start`）を同時に保持できない**。NMV が 127（Node 22）と 139（Electron 38）で食い違うため、どちらか一方を build したらもう一方は使えない。

**当面の運用**:

```bash
# Node CLI テストを走らせる前
npm rebuild better-sqlite3 --build-from-source

# Electron アプリを起動する前
npm run postinstall
```

**M2 で恒久対応**: `electron-mocha` または同等の Electron 内テストランナーを導入し、`npm test` を Electron ABI 環境で実行できるようにする。これにより一方の ABI に統一できる。

#### 3. Chromium バージョンが Electron 42 比で 138 → ~134 に後退

Web 公開機能なし、UI も `98.css` + DOM の伝統的構成のため、新 CSS / JS API への依存はない。実害なし。

## 解除条件（Electron 最新化のトリガー）

以下のうち **いずれか一つでも** 満たされた時点で再評価し、最新 Electron へ戻す PR を起こす：

1. `WiseLibs/better-sqlite3` が Electron 42（NMV 146）以上の安定 prebuild を npm 公開した
2. `WiseLibs/better-sqlite3` の HEAD がソースから Electron 42 でクリーンビルドできるようになった（[issue tracker](https://github.com/WiseLibs/better-sqlite3/issues) でメンテナーが安定宣言）
3. M5 着手前（v2.0.0-beta.1 リリース 2 週間前）の時点で①②が実現していない場合は、ADR を改訂したうえで node:sqlite / libsql 等への移行を再検討する

## Watch list（次セッションで確認すべき情報源）

- https://github.com/WiseLibs/better-sqlite3/releases
- https://github.com/WiseLibs/better-sqlite3/issues
- 特に `m4heshd` の Electron prebuild 関連 PR

## 影響範囲

- `package.json`: `devDependencies.electron` を `^38.8.6` に変更
- `package-lock.json`: `npm install` で再生成
- HANDOVER.md §15.1（build-essential 記述の現状反映）と §15.2（dual-ABI 注記）に追記が必要
- M2 着手時に `electron-mocha` 導入を検討（`ROADMAP.md` の M2 タスクに追加候補）

## 検証

- `npm install` 成功（Electron 38 prebuild ダウンロード + better-sqlite3 native build OK）
- `npm test`（Node ABI rebuild 後）: 62/62 + 51/51 = **113/113 pass**
- `npm start`（Electron ABI rebuild 後）: 手動確認は次のセッションで実施予定

## 更新 (2026-06-03): Electron 41 へ前進（38 が EOL のため）

### 背景
- **Electron 38 が 2026-03-10 で EOL**（[endoflife.date](https://endoflife.date/electron)）。サポートは最新3メジャー = 40 / 41 / 42 のみ。固定継続＝**今後のセキュリティパッチが当たらない**状態となり、本来「アップグレード起因の脆弱性を避ける」目的の固定が逆効果（本末転倒）になった。
- ブロッカーだった **better-sqlite3 が 12.10.0 (2026-05-12) で Electron 39/40/41 の prebuild を提供**（ABI 上限 electron-v145 = Electron 41、全7プラットフォーム）。本 ADR 起草時（12.9.1 = Electron 38 止まり）から状況が改善。
- **Electron 42 はまだ不可**：better-sqlite3 が 42 対応 prebuild を一度入れて取り下げ（PR #1470）、V8 external API 周りでソースビルド失敗が継続（upstream issue #1474 / #1475 オープン）。

### 決定（本 ADR の解除条件の精神に沿った前進）
- `devDependencies.electron` を `^38.8.6` → **`41.7.1` (exact)** に更新。`dependencies.better-sqlite3` を `^12.0.0` → **`12.10.0` (exact)** に更新（ユーザーの exact-pin 方針に準拠）。
- これにより **EOL を脱却し、現役サポート（41 は〜2026-08-25）＝パッチ供給ありの状態**へ。`npm audit` が報告していた4件（offscreen UAF ×2 / clipboard クラッシュ / window.open scope）も Electron 41 で解消。
- 解除条件①（Electron **42** の安定 prebuild）は未達だが、当時存在しなかった「41 という現役・パッチ供給ありの着地点」が新たに利用可能になったための前進。**42 が better-sqlite3 で通り次第（#1474/#1475 解決）、42（〜2026-10-20）へ再度上げる**。

### 併せて投入した hardening（バージョンに依存しない防御一層）
- `app.on("web-contents-created")` で全 webContents に **`setWindowOpenHandler` deny ＋ `will-navigate`/`will-redirect` のリモート遷移拒否**（src/main/main.js）。
- index.html / page-popup.html に **CSP メタ**（`script-src 'self'`、style は `'unsafe-inline'`、img は blob:/data:）。
- → いずれもアプリ挙動は不変だが、将来 untrusted/remote コンテンツや注入が入ったときの被害を構造的に抑止。

### 検証方針
- 38→41 はメジャー3つ飛び（Chromium ~134→146 / 主プロセス Node 22→24）。**CI の test.yml（3 OS で実 Electron 起動 = test:m1）で検証**。CSP は headless で全描画を検証しきれないため、**実機 Windows でのスモーク確認**を別途要する（blob 画像・印刷・ポップアップ表示）。

## 更新 (2026-07-01): Electron 42 へ更新

### 背景
- **Electron 41 は 2026-08-25 で EOL**。現役サポートへ移行するため 42 を目指していた。
- 上流の解除条件が充足された:
  - `WiseLibs/better-sqlite3` **v12.11.1** が **electron-v146（Electron 42）prebuild** を win32-x64 / darwin-x64 / darwin-arm64 / linux-x64 の全4プラットフォームで提供。
  - V8 external API 修正 issue **#1474**（Build failure starting with electron 42.0.1）が **closed**。
  - issue **#1475**（Fix V8 external API usage for Electron 42）が **closed**。

### 決定
- `devDependencies.electron` を `41.7.1` → **`42.5.2` (exact)** に更新。
- `dependencies.better-sqlite3` を `12.10.0` → **`12.11.1` (exact)** に更新。
- これにより **EOL を脱却し、Electron 42（サポート期限 〜2026-10-20）に移行**。

### 検証方針
- CI の test.yml（3 OS で実 Electron 起動 = test:m1）が緑になったことを確認してからマージ。
- CSP は headless で全描画を検証しきれないため、**実機 Windows でのスモーク確認**を別途要する（blob 画像・印刷・ポップアップ表示）。
