# ADR-0023: 画像書き出し（PDF→PNG/JPEG + 範囲画像）

- 日付: 2026-07-10
- ステータス: **実装済（遡及起草 — REVIEW-2026-07 #7。実装は β.97 で完了）**
- 関連: ADR-0003（canonical coordinate）、ADR-0012（HiDPI render quality — viewer 画質と export 解像度の分離）、HANDOVER §15.3、CHANGELOG-history.md β.97 / β.98 / β.128

## Context

法律実務では PDF の内容を「画像として」他へ持ち出す需要が頻出する：

- 準備書面や Word 書面に証拠 PDF の該当箇所（条文・図面・写真の一部）を貼り込む
- 記録の 1 ページをメール・チャットでそのまま画像として送る
- 画面共有 / SNS 向けに軽い解像度、印刷代用には高解像度、と用途で解像度が変わる

要件：

- K-PDF3 で加えた編集（overlay：テキスト・スタンプ・墨消し等）を **合成済み** の見た目で出力する（画面と同じもの）
- ページ全体の書き出しと、ドラッグで囲んだ **矩形範囲だけ** の書き出しの両方
- 形式は PNG（無劣化）と JPEG（軽量）、解像度は用途別に選択可能
- 複数ページを一括で書き出せる（範囲指定 `1-3,5,7-10` 形式）

## Decision

### 1. renderer 側で合成、main 側は書き込みのみ（`composePageImage` / `composeRegionImage`）

`src/renderer/exporter.js` に 2 関数を新設。いずれも PDF 書き出しと同じ `composeSinglePageCanvas`（元ページ render + overlay 合成）を流用し、canvas を PNG/JPEG に encode して bytes を返す：

- `composePageImage`: ページ全体。zoom = dpi / 72、JPEG quality 0.92
- `composeRegionImage`: canonical 座標（ADR-0003、post-userRotation top-left origin、pt 単位）の bbox で crop

透過 RGBA の PDF（Excel→PDF 等、白塗り背景なし）対策として、encode 前に不透明な白地へ合成する（β.97 当初は region の JPEG 経路のみ → β.128 で PNG/JPEG × 全ページ/範囲の全経路に統一。放置すると JPEG は黒背景に焼き込まれる）。

ファイル書き込みは main の `kpdf3:save-image-file`（単一）/ `kpdf3:save-image-files`（複数、`<base>_p001.png` の 3 桁以上ゼロ埋め連番。連番は選択順 seq ベースなので `3,5,7` 指定でも p001/p002/p003 と連続する。baseName のパス区切り文字は sanitize）。

### 2. UI 導線は 2 本

- **機能 1（ページ全体）**: ファイル > 画像として保存… → 専用ダイアログで 範囲（全 / 現在 / `1-3,5,7-10` 指定）・形式（PNG 既定 / JPEG）・解像度（96 / 150 / **300 既定** / 600 / 900 dpi）・白黒モード・ファイル名 を選択。単一ページは save ダイアログで 1 ファイル、複数ページはフォルダ選択 → 連番出力。形式 / dpi / 白黒は localStorage（`kpdf3.imageExportPrefs`）に記憶、範囲は毎回リセット
- **機能 2（範囲画像）**: ツールバー「範囲画像」ボタン or メニュー「選んだ範囲を画像で保存…」→ placementMode `region-image` に入り、ページ上をドラッグ → リリースで mode-options-bar の形式 / dpi / 白黒を反映して save ダイアログへ。1 ドラッグ = 1 保存で mode を抜ける（5pt 未満はリトライ）

### 3. 解像度は dpi の 5 段階、900 dpi = `EXPORT_ZOOM`

viewer 画質（ADR-0012 の oversampling）とは独立の knob。900 dpi は PDF 書き出しの `EXPORT_ZOOM`（900/72）と同一で「原本品質」、既定 300 dpi は送付・印刷代用の実用値。

### 4. overlay は常に flatten、白黒モードは overlay 色→黒変換

画像出力では overlay を分離保持できないため常に焼き込み。`monoOverlays` フラグは overlay（テキスト・図形等）の色を黒に射影する（FAX・モノクロ印刷提出向け）。

### 5. クリップボードへのコピーは採用しない（ファイル保存のみ）

出力先はファイルに限定。クリップボード方向は「画像の貼り付け」（OS クリップボード → 画像スタンプ、β.131）のみで、書き出し側のコピー導線は実装していない。

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. renderer で `composeSinglePageCanvas` 流用 + main は bytes 書き込みだけ（採用）** | ✅ | PDF 書き出し / 印刷と同一の合成経路なので「画面 = 画像」が構造的に保証される。encode も canvas API で済み、main に画像コーデック依存を増やさない |
| B. main 側で mupdf render + encode | ❌ | overlay 合成ロジック（renderer 側 canvas 描画）を main に二重実装することになる |
| C. OS スクリーンショット / 外部ツール任せ | ❌ | 表示解像度でしか取れず、複数ページ一括・dpi 指定・白黒変換ができない |
| D. クリップボードコピーも同時実装 | ❌ | 貼り込み先は Word 等でファイル挿入が確実。まずファイル保存で運用し、需要が出たら追加（現時点で要望なし） |

## Consequences

### 受け入れる trade-off

1. **画像は完全 flatten** — overlay の後編集は不可。編集を残したい場合は .kpdf3 / PDF 書き出しを使う運用
2. **複数ページ × 高 dpi はメモリを食う** — 全ページの bytes を配列に貯めてから IPC に渡す。900 dpi 大量ページでは重い（実用上は 300 dpi 既定で問題化していない）
3. **白黒モードは overlay のみ** — 元 PDF のピクセルはグレースケール化しない（ラベルも「overlay の色を黒に変換」と明記）
4. 98.css との `<label><input></label>` 非互換で β.97 直後にダイアログの radio が不可視 → β.98 で並列構造に hotfix（β.86 と同型）

### 影響範囲

- `src/renderer/exporter.js`: `composePageImage` / `composeRegionImage`（`composeSinglePageCanvas` 流用、`monoOverlays` 引数追加、白地合成）
- `src/renderer/renderer.js`: `actionExportAsImage` / `showImageExportDialog` / `parseMultiPageRange` / `startRegionImageDrag` / `saveRegionImage`
- `src/renderer/index.html`: `image-export-dialog`、mode-options `region-image`（形式 / dpi / 白黒）、メニュー 2 項目 + ツールバーボタン
- `src/main/main.js`: `kpdf3:save-image-file` / `kpdf3:save-image-files` IPC
- `src/main/preload.cjs`: `saveImageFile` / `saveImageFiles`

### 解除条件

- クリップボードコピーの要望が出たら、同じ compose 結果を `nativeImage` で writeImage する拡張を別途検討（本 ADR の合成経路は不変）
- 元 PDF ごとグレースケール化する「真の白黒」需要が出たら `monoOverlays` とは別フラグで追加

## 検証

- β.97 リリース時に実装、β.98（ダイアログ radio 可視化）/ β.128（透過 PDF の黒背景 → 白地合成の全経路化）で追修正。以降 stable まで画像書き出し起因の報告なし（v2.0.7 の byte-copy 回転バグでも「画像書き出しは always-rasterized で元から正常」と確認済み）
- 手動確認観点は CHANGELOG-history.md「β.97 画像書き出しの実機検証」項（範囲パース / 連番桁数 / 300 dpi 既定の妥当性 / 白黒 overlay 変換）
