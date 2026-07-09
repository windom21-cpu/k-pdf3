# ADR-0020: 申請書テンプレ機能（form_field 4 サブタイプ + 記入モード + 下敷き印刷）

- 日付: 2026-07-10
- ステータス: **実装済（遡及起草 — REVIEW-2026-07 #7。実装は β.80〜β.82 で完了）**
- 関連: ADR-0003（canonical 座標 — overlay 配置の共通基盤）、ADR-0016（スタンプテンプレ MVP — palette popup / 位置永続化の流儀）、HANDOVER §8.2（下敷き 180° / 精度キャリブレーション）、§15.3、CLAUDE.md NG リスト、memory `[[project_underlay_print_180flip_adobe]]`

## Context

法律実務では、役所・裁判所等の**紙の申請書式**に同じ項目を繰り返し記入する業務が頻出する。要件：

- 申請書 PDF（スキャン原本等）を**雛形化**し、記入欄を一度定義したら再利用したい
- 記入は Tab で欄を巡回する「フォーム入力」の操作感が欲しい
- 提出は**実際の紙の申請書**に行うことがある → 背景を刷らず**記入内容だけを白紙の申請書用紙に重ね印刷**する「下敷き印刷」が要る（K-PDF2 世代からの業務要望）
- 役所書式の見た目に合わせるため、記入文字のフォントをシステムフォントから選びたい
- 配置済みの欄の書式（フォント/サイズ/色等）を**後から**直せること

前提となる既存基盤：overlay は canonical 座標（ADR-0003）で workspace に持ち、元 PDF バイトには触らない（3-layer 分離 §2.2「PDF は truth ではない」）。印刷は案 D = `composePagesForExport` で組み立てた PDF を Adobe `/p` に委譲する経路（β72）が確立済み。

## Decision

β.80 で Phase A〜E として一括投入し、β.81/β.82 でユーザー要望を反映した。

### 1. 新 overlay 種別 `form_field` + 4 サブタイプ（Phase A）

AcroForm 等 PDF 側のフォーム機構は使わず、**既存 overlay 基盤の 1 type** として追加する。サブタイプは `properties.fieldKind` で判別：`text`（記入欄）/ `check`（レ点）/ `circle`（丸囲み）/ `radio`（択一群、`radioGroupId`）。SQLite は CHECK 制約に type を列挙しているため、`migrateOverlaysAddFormField` で**テーブル再構築型の idempotent migration**を実装（SQLite は CHECK の ALTER 不可）。properties には `value` / `fontFace` / `fontSize` / `color` / `checkStyle` / `alignH` / `alignV` / `tabOrder` 等を持つ。

### 2. フォーム palette + 記入モード（Phase B/C）

- ツールバー「フォーム」1 ボタン → popup（スタンプ palette と同流儀：draggable + 位置永続化）。popup に 4 サブタイプの配置ボタンと「記入モード」トグル。
- **記入モード**（`src/renderer/form-fill.js`）：Tab/Shift+Tab で次/前のフィールドへ、Enter は commit + 次へ（Shift+Enter は改行 = β.81）、Space は check/circle/radio をトグル（radio は同 group の他を OFF）、Esc で解除。
- 雛形作成（placement）と記入（fill）を**モードで分離**し、記入モード / placement / Tab 順編集は排他制御。

### 3. Tab 順 = 自動順 + 手動編集（β.82 B-6）

- 既定は自動順：ページ順 → Y 昇順 → X 昇順（6pt ε の行バケット）。
- `properties.tabOrder`（整数）を持つフィールドは**明示順として先頭**、残りは自動順で末尾（`_computeTabOrder` の合成順）。
- 編集 UI：palette の「Tab 順を編集」→ 全 form_field 左上に**番号バッジ**（赤チップ、ドラッグで「その位置に挿入 + 1..N 再採番」を 1 CompositeCommand で）+ 別 popup「**Tab 順**」（縦リスト、行ドラッグ並べ替え、行クリックで本文選択 + 中央スクロール + 1 秒 pulse highlight、位置永続化 `kpdf3.tabOrderPopupPos`）。paste 時は tabOrder を捨てて重複を防止。

### 4. 下敷き印刷（Phase D）

「下敷き印刷」ボタン → 注意ダイアログ（白紙申請書のトレイセット + Adobe「実際のサイズ」案内）→ 全ページ（または sidebar/split 選択範囲）を **overlay-only strategy** で組み立て → 既存 Adobe `/p` 印刷ダイアログ経路へ。背景 PDF は出力せず**空白ページ + overlay だけ**が用紙に乗る。`composePagesForExport` に `overlayOnly` フラグ、main の `assembleHybridPdf` に `"overlay-only"` strategy を追加しただけで、印刷経路本体は既存の案 D を再利用。Adobe「実際のサイズ」を CLI で強制する手段は無い（検証済）ため注意書きで担保。Reader 不在環境（Sumatra/Chromium のみ）はメッセージで断る。

### 5. システムフォント選択（Phase E）

main に IPC `kpdf3:list-system-fonts`（Linux=fc-list / Win=PowerShell + InstalledFontCollection、cache あり）。form-text-font select を「optgroup プリセット + システム」で再構築し、`getTextFontStack` を未知 fontId → システムフォント名 fallback に拡張。β.105 で `src/renderer/system-fonts.js` に共通化（テキスト挿入/スタンプにも展開、PowerShell 出力の UTF-8 強制で文字化け解消）。

### 6. 後付け編集（β.81 → β.82 B-5）

配置済み form_field を選択（or 編集中）→ options bar の select 変更で即反映（β.81 `applyFormTextStyleToEditingOrSelected`、text 限定）。β.82 で **form_field を 1 つ選択した瞬間に options bar が fieldKind 専用パネルへ自動切替 + 現在値 populate** に強化し、`applyFormFieldStyleToEditingOrSelected` へ拡張して check/circle/radio も後付け編集可（`document.activeElement` ガードで入力中のカーソル消失を防止）。

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. overlay type `form_field` + overlay-only 印刷（採用）** | ✅ | undo / canonical 座標 / 保存 / export / 印刷（案 D）が既存機構にそのまま乗る。schema は CHECK 拡張 1 本、印刷は strategy 1 種の追加で済む |
| B. 元 PDF の AcroForm に値を書き込む | ❌ | 3-layer 分離違反（§2.2「PDF は truth ではない」）。スキャン原本にはそもそもフィールドが無い |
| C. 下敷き印刷を専用印刷経路として新設 | ❌ | 印刷は案 D（Adobe `/p` 委譲）に一本化済み。overlay-only は「背景を出さない組み立て」の差だけで、経路を増やす理由が無い |
| D. Tab 順を完全手動（自動順なし） | ❌ | 欄数の多い申請書で全欄採番は非現実的。自動順（ページ→Y→X）を既定にし、狂う箇所だけ β.82 の手動 tabOrder で上書きする合成順が実務的 |

## Consequences

### 下敷き印刷の 180° 上下さかさま → 警告 + 必須チェック運用で確定（v2.0.6）

下敷き印刷で「紙全体が上下さかさま」になる事故が発生した。真因は K-PDF3 ではなく **Adobe 印刷ダイアログの「向き=自動」が“ほぼ白紙の下敷きページ”の天地を判定できず 180° 回す**こと（実機テストで確定。overlay 配置座標は通常印刷と完全一致、overlay-only 出力の組み立ては β.80 から無変更 = Adobe 既定挙動の変化で顕在化）。K-PDF3 側から確実に制御できないことを実地で確認済みで、以下は**すべて却下済み — 再提案 NG**（CLAUDE.md NG リスト掲載）：

- ✗ **white-cover**（白で隠したフォーム埋込で向き判定を誘導）— Adobe は不可視内容を向き判定に使わない
- ✗ **180° 先回り**（K-PDF3 側で予め回す）— Adobe 仕様変更でサイレント故障し法律文書に危険
- ✗ **DEVMODE 向き強制** — DEVMODE 押込は silent fallback 専用で Adobe `/p` 経路は不使用（β63 案M/N/ζ と同じドライバ制約の壁）

採用した運用：確認ダイアログに**赤枠警告**（「向きを必ず【縦】に」）+ **必須チェックボックス**（「向きを【縦】に設定しました」が ON になるまで [印刷] 無効、storageKey なし = 毎回再確認）。`dialogs.js` `customConfirm` に `warning` / `checkbox.required` を汎用追加。**Adobe は縦設定を記憶しないことがあるため、毎回「向き=縦」を選ぶ運用が前提。**

なお調査中の「A3 横向き**通常**印刷の 180°」（HANDOVER §8.2 先頭）は**別機構**（横向きページの回転二重がけ仮説）であり、本件の警告運用とは切り分けて扱う。

### その他の trade-off / 残課題

1. **精度キャリブレーション未検証**（§8.2 #11）：用紙送り誤差で X/Y 数 mm ズレる可能性。実機測定 → 必要ならプリンタ別オフセット / 倍率補正等を段階追加。
2. **viewer/exporter 描画の二重実装リスクが実際に顕在化**：Phase B-3（commit cf1eff5）で viewer 側にしか form_field 描画が無く、下敷き印刷で値が一切印字されない状態を Phase D で発見 → `drawOverlay`（exporter.js）に 4 サブタイプの実描画を追加して修正。**overlay type 追加時は両実装が必須**（CLAUDE.md の恒久注意と同根）。
3. **下敷き印刷は Adobe 系 Reader 必須**（Sumatra legacy 経路では不可）。
4. 下敷き印刷は墨消し時の full 格上げ（β.85）の対象外のため、v2.0.13 のベクターテキスト導入時に「墨消しの上に抽出可能テキストが出る」穴をガードで塞いだ（exporter.js の墨消しページ・ベクター全面禁止）。
5. CHECK 制約のテーブル再構築 migration パターンは β.100 `shape` が踏襲。システムフォント選択は β.105 で全 overlay 系へ展開。v2.0.13 系の MS 明朝ベクター濃度化は form_field(text) の `fontFace` 判定にも連動する。

## 実装ポインタ

- `src/renderer/form-fill.js` — 記入モード本体（Tab 巡回 / `_computeTabOrder` 合成順 / Space トグル）
- `src/renderer/print-flow.js:711-845` — `actionPrintOverlayOnly`（下敷き印刷、赤枠警告 + 必須チェック含む）
- `src/renderer/exporter.js` — `composePagesForExport` の `overlayOnly` フラグ（1056 付近）、`"overlay-only"` strategy（1239 付近）、`drawOverlay` の form_field 4 サブタイプ描画（2065-2144）
- `src/renderer/viewer.js:1477,1940` — 画面側 form_field 描画（`grep -a` 必要）
- `src/renderer/renderer.js:7736` — `applyFormFieldStyleToEditingOrSelected`（後付け編集）、tabOrder 編集モード（1848 付近ほか）
- `src/renderer/dialogs.js` — `customConfirm` の `warning` / `checkbox.required`（v2.0.6）
- `src/renderer/system-fonts.js` / `src/main/main.js:4434` — `kpdf3:list-system-fonts`
- `src/main/main.js:2362` — `assembleHybridPdf` の `"overlay-only"` strategy
- `src/backend/sqlite-store.js:218` — `migrateOverlaysAddFormField`
- `schema/schema.sql:124,136` — overlays type CHECK + form_field properties コメント
- `src/domain/project-store.js:19-21` — OverlayType typedef
