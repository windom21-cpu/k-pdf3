# ADR-0019: スタンププリセット管理 — 全 PDF 共通の登録制 + 全角/半角フォント別 + 画像スタンプの PDF 試し置き

- 日付: 2026-07-10
- ステータス: **実装済（遡及起草 — REVIEW-2026-07 #7。ADR-0016 を吸収）**
- 関連: **ADR-0016 を吸収 (0016 は歴史文書として残置)**、ADR-0017（画像スタンプ / asset library）、HANDOVER §15.3、§17.5（M6 大物 ✅ 2026-05-10/11）、CHANGELOG-history β3 / β85 / β.105

## Context

ADR-0016 は「1 セッションで実装できる subset」として hardcoded 3 テンプレート（印 / 日付 2 種）+ 色 select の MVP を定義し、フル要件 —「プリセット保存・編集ダイアログ」「画像スタンプ」「全角・英数字のフォント別指定」（§17.5）— を後続 ADR-0019 に委ねた。M6（2026-05-10/11）でそのフル UI を実装し、以後 β 期間の業務並走で次の改修が積み上がった：

- **β3**: テスター指摘「登録したスタンプが別の PDF で見えない」→ preset を workspace 内から **全 PDF 共通の `<userData>/stamps.db`** へ移行（0016 が open question とした「workspace 単位 or アプリ全体？」の決着）
- **β13〜β30**: 画像スタンプ「PDF に試し置き」導入と UX 連続改善
- **β85**: 配布フィードバック — palette 横スクロール禁止（縦 1 列スクロール化）/ テキストスタンプ細字化 / ▲▼ 並び替え
- **β.105**: フォント設定に OS インストール済フォント名も許容（preset 名以外を system font として解決）

本 ADR は ADR-0016 の hardcoded テンプレート方式を**置換**した現行実装を記録する。

## Decision

### 1. 登録制 preset — `stamp_presets` + `assets` テーブル

`kind IN ('date','text','image')`、label / color / `frame IN ('circle','rect','none')` / font_size / text / asset_id / width / height / sort_order（`schema/schema.sql` と `global-stamp-store.js` で同一定義）。画像バイナリは `assets`（SHA-256 hash で重複排除）。0016 の「select から選ぶ hardcode」は廃止し、**palette popup（draggable、縦 1 列 max-height 320px `overflow-y:auto`、`overflow-x:hidden` + label ellipsis）から active preset を選んでクリック配置**。配置は sticky（連打可能）、preset 未登録時は placeStamp が no-op + ステータスバー案内。active preset は `kpdf3.activeStampPresetId` で永続。

### 2. 全 PDF 共通ストア（アプリ全体、workspace 単位ではない）

`src/main/global-stamp-store.js` が `<userData>/stamps.db` を lazy-open。workspace 側 `stamp_presets` スキーマも残し、**workspace open のたびに `migrateFromWorkspaceIfEmpty()`**（global 側が空のときだけ旧 per-workspace preset + 参照 asset をコピー、冪等）で β3 以前の登録を救済。overlay の asset 参照は main.js 側で「workspace に無ければ global へ fallback」に wrap し、移行前後どちらの配置済み overlay も描画が切れない。

### 3. UI — manager + 3 種 register dialog + フォント設定

「ツール > スタンプ管理」で manager dialog（一覧 / 削除 / **▲▼ 並び替え** — β85、`setStampPresetsOrder(db, ids)` で sort_order 一括更新、palette も自動追従）。日付 / テキスト / 画像それぞれの register dialog はプレビュー canvas 付きで色・枠・サイズ・ラベルを確定してから登録。

### 4. 日付スタンプ — 4 形式 + 配置時に日付確定

`renderDateText(formatKey)`（`stamp-helpers.js`）: `date-numeric-dash`（既定 `-8.-5.10`）/ `date-numeric-fw`（全角ピリオド）/ `date-kanji-dash`（`令和-8年-5月10日`）/ `date-numeric-spaced`（区切り無し 3 数字を `spacingMode:'distribute-3'` で枠幅に等配）。派生 `date-numeric-spaced-2` は年月のみ（日は印刷後に手書きする業務向け）。**1 桁はハイフン埋め（`-8`）、2 桁はそのまま** — 日付印の桁揃え慣行。0016 同様、配置時に `new Date()` を読む（令和 = 西暦 − 2018 の hardcode も継承）。

### 5. 全角/半角フォントの独立軸

`splitStampRuns(text)` が文字列を half（ASCII + 半角カナ）/ full の run に分割し、run ごとに `getStampFontStack(full|half)` の stack で描画（`drawStampMixedText` / exporter 側 `drawStampMixedTextOnCanvas`）。既定は **full=明朝、half=numeric（同梱 CrashNumberingSerif = hanko 風数字セリフ）** — 「漢字は明朝のまま、数字だけ印鑑風」を無設定で実現。「フォント設定…」ダイアログで両軸を独立変更でき `kpdf3.stampFontFull/Half` に永続、β.105 から preset 名以外の system font 名も受理。なお**テキストオーバーレイ側にも同思想の半角数字独立軸がある**（`getTextFontStack(fontId, {digitsHanko})` が CrashNumberingDigits を prepend する「数字 hanko 風」チェック、β32 導入 / β.140 で system font 経路の適用漏れ修正）— スタンプの full/half 分離とは実装が別だが、同じ「全角と半角数字を別フォントで」という要件系。

### 6. 画像スタンプの「PDF に試し置き」（プレ押印）

画像 register dialog の「PDF に試し置き」ボタン → クリックで trial canvas（tint + 枠込みの実描画）を実ページ上に pin。ドラッグ移動 + コーナー handle resize で**登録前に実寸・位置の感覚を紙面上で確認**し、確定サイズを dialog へ commit-back してから登録する。dialog ↔ trial が状態を双方向に共有するため `stamp-dialogs.js` に同居（B2 リファクタ時の統合判断）。refreshViewer / applyZoom とは `clearStampTrial` / `reattachStampTrial` で連携。

### 7. テキストスタンプは細字（β85 #6）

`properties.stampKind`（'date' | 'text' | 'image'）を overlay に永続し、`stampKind === 'text'` は bold + overstroke を skip（viewer も fontWeight normal で WYSIWYG）。日付印は印影らしさのため bold 維持。

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. 全 PDF 共通 stamps.db + 登録制 palette（採用）** | ✅ | スタンプは「その人の道具」であり文書に属さない（β3 テスター実証）。0016 の hardcode select は登録数が増えると破綻 |
| B. workspace（.kpdf3）単位の preset | ❌ | PDF ごとに再登録が必要、β3 で実際に不評 |
| C. 全文字同一フォント（0016 継続） | ❌ | 日付印の数字が明朝のままでは印鑑らしさが出ない（§17.5 要件） |
| D. 画像スタンプを登録後に配置して試す | ❌ | サイズ違いのたび「削除→再登録」往復。試し置きなら登録前に確定できる |

## Consequences

- **preset は PDF / .kpdf3 に同梱されない** — 別 PC へは stamps.db を持ち出す必要がある（画像 asset のバイト自体は overlay 配置時に workspace へ fallback 参照されるため、配置済み文書の表示は壊れない）
- 0016 の trade-off のうち「令和 = year − 2018 hardcode」は継承（改元時に micro-ADR）。「ユーザー定義スタンプ不可」「画像スタンプ不可」「フォント別指定なし」の 3 つは本 ADR で解消
- 画像スタンプの品質系は後続で個別対応済: 濃度閾値 ramp（β87）、印刷・書き出しの縦横比保持（β.150）
- **自動テストなし** — preset CRUD / palette / 試し置きは手動確認のみ（HANDOVER §15.5 リファクタ候補の既知のテストカバレッジ不足に含まれる）

## 実装ポインタ

- `schema/schema.sql` — `stamp_presets` / `assets`（workspace 側定義、コメントに ADR-0019 明記）
- `src/main/global-stamp-store.js` — `<userData>/stamps.db`、`listStampPresetsGlobal` ほか + `migrateFromWorkspaceIfEmpty`
- `src/backend/sqlite-store.js` — `addStampPreset` / `listStampPresets` / `removeStampPreset` / `setStampPresetsOrder` / asset CRUD（global と workspace 双方から共用）
- `src/renderer/stamp-presets.js`（491 行）— preset cache / palette popup / ghost cursor / `currentStampPreset()` / `placeStamp()`
- `src/renderer/stamp-dialogs.js`（1109 行）— manager + 日付/テキスト/画像 register dialog + フォント設定 dialog + 試し置き
- `src/renderer/stamp-helpers.js` — `renderDateText` / `drawStampMixedText` / tint
- `src/renderer/fonts.js` — `STAMP_FONT_STACKS` / `getStampFontDefaults` / `getStampFontStack` / `splitStampRuns`（+ text 側 `digitsHanko`）
- IPC（main.js / preload.cjs）: `kpdf3:list-stamp-presets` / `add-stamp-preset` / `remove-stamp-preset` / `set-stamp-presets-order` / `kpdf3:list-assets` / `add-asset` / `add-asset-from-file` / `get-asset` / `remove-asset`
- テスト: 専用テストなし。overlay としての stamp 永続化のみ `test/m3-overlay-persistence.mjs` が間接カバー
