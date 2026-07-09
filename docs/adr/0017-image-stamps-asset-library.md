# ADR-0017: 画像スタンプ + アセットライブラリ

- 日付: 2026-07-10
- ステータス: **実装済（遡及起草 — REVIEW-2026-07 #7。実装は β 期間で完了）**
- 関連: ADR-0016（スタンプテンプレート MVP — 本 ADR の前史）、ADR-0019（プリセット管理）、ADR-0018（asset DB 共有）、HANDOVER §17.5、§15.3

## Context

法律事務所の認印・記名印・職印はスキャン画像（2400×2400 級の印影スキャンが典型）で保有されており、ADR-0016 の文字スタンプ「印」は代替表示にすぎなかった。ADR-0016 は「画像スタンプは別 ADR-0017（assets 連携）」と明示的にスコープ外へ切り出しており、本件はその積み残しである。要件：

- PNG/JPEG の印影画像をスタンプとして登録し、クリックで押印できる
- 同じ印影を毎回ファイル選択せず再利用できる（ライブラリ化）
- カラー印影（朱・青）が白黒印刷でも文字スタンプと同等の濃度で出る
- 画面（viewer）・サムネ・印刷・書き出しで見た目が一致する（WYSIWYG）

初期スキーマにはこの日のために `assets` テーブル（id / hash / mime / blob / width / height / label）が予約済みで、MVP 実装（2026-05-10、commit `8e35afb`「register PNG/JPEG as workspace asset (ADR-0017 MVP)」）は **スキーマ変更ゼロ** で着地した。

## Decision

### 1. 保存 — `assets` テーブル + SHA-256 重複排除

画像バイト列は `assets` テーブルに BLOB で保存。`hash TEXT NOT NULL UNIQUE`（SHA-256）により同一画像の二重登録は既存行を再利用する。overlay 側は既存 `type='stamp'` の properties に `kind:'image'` + `assetId` を足すだけで、**新 overlay type もカラム追加も無し**（migration 不要、ADR-0016 §5 と同じ方針）。

### 2. 保存場所 — workspace ローカル → 全 PDF 共通 `stamps.db`（β3）

MVP は workspace（.kpdf3）内 assets に保存したが、β テスター（2026-05-11、β3）が「登録したスタンプは全 PDF で使えるはず」と期待したため、`<userData>/stamps.db`（`src/main/global-stamp-store.js`）へ移行。assets / stamp_presets を workspace 側と同スキーマでミラーし：

- `kpdf3:get-asset` は **workspace → global の順に fallback**（移行前後どちらの overlay も描画できる）
- `migrateFromWorkspaceIfEmpty` が旧 workspace 内プリセットを初回オープン時に global へ吸い上げ（idempotent）

### 3. 登録経路は 2 系統

| 経路 | 導線 | 保存先 | 特徴 |
|---|---|---|---|
| ファイル登録（プリセット化） | スタンプ管理 →「印影画像を選択」（file browser の image filter） | global stamps.db | `kpdf3:add-asset-from-file`。「試し置き」（β13-15）でダイアログ編集中に実 PDF 上へ下書きピン留めして見た目確認 |
| クリップボード paste（一回性） | Ctrl+V / 右クリック貼り付け（β76） | workspace assets | PNG/JPEG/WebP、8MB 上限、1px=1pt 換算 + ページ高 80% clamp。`aspectLocked:true` 付与（β.131、主軸方式 resize で縦横比維持） |

### 4. 描画 — viewer は `<img>`、exporter は ImageBitmap、両者 contain 一致

- **viewer** (`viewer.js:1074`): assetId ごとに blob: URL をキャッシュした `<img>` 子要素、`object-fit: contain`、rotation は CSS transform（紙メタファ）
- **exporter** (`exporter.js`, `drawOverlay` の image 分岐): `getAssetBitmap`（Map キャッシュ）+ `ctx.drawImage`。このために `drawOverlay` / `compositePage` を async 化
- **縦横比**: exporter は当初 w×h に引き伸ばしていたが、β.150 で viewer の object-fit:contain と同じ「contain フィット + 中央 letterbox」に統一（β.131 で palette 画像の resize を自由にした副作用で画面と印刷が食い違っていた）

### 5. tint / 濃度 — luminance→alpha、β87 で閾値 ramp 化

印影背景の白を透過する tint パイプライン（`bg-transparent` = 元 RGB 維持 / `#rrggbb` = 単色化）を持つ。当初の線形 lum→alpha ではカラー印影（朱・青）が 60-70% 透過して薄く印刷され「濃い版の 2 重登録」を強いたため、β87 で閾値 ramp に変更：

- `lum ≤ 0.5 → alpha 1.0`（印影 = 完全不透明）/ `lum ≥ 0.85 → 0.0`（紙白 = 透明）/ 中間は線形 ramp（AA エッジ維持）
- preview（`stamp-helpers.js` `tintCanvasInPlace`）/ exporter（`getTintedAssetCanvas`）/ viewer（`applyTintInPlace`）の **3 経路すべてに同一適用**
- 白黒印刷モードは props.color の有無に関わらず `#000000` へ強制 tint（赤印影が薄く出る事故防止）

### 6. 印刷は bbox raster を受容（β62）

ハイブリッド PDF 組立はページ全面の透過 PNG XObject を重ねると C2360 ドライバが本文ベクタごと raster fallback する（β61 ユーザ報告：スタンプ 1 つで印刷品質が荒れる）。β62 で overlay PNG を **overlays union bbox サイズに切り詰めて配置** し本文の vector 性質を保持。帰結として画像スタンプ自体は出力内で常に raster（bbox 内 900dpi）であり、vector 化は研究課題として受容（HANDOVER §8）。

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. 既存 assets テーブル + properties.assetId 参照（採用）** | ✅ | スキーマ変更ゼロ・migration 不要、hash 重複排除が最初から効く |
| B. overlay properties に画像を base64 inline | ❌ | 同じ印影を押すたび BLOB が複製され workspace が肥大、重複排除不能 |
| C. userData にファイルとして保存（DB 外） | ❌ | workspace 可搬性・トランザクション整合が崩れる、hash 管理を自前実装 |
| D. 新 overlay type `'image'` を追加 | ❌ | スタンプ UX（palette / ghost / 配置モード）を丸ごと二重化することになる。既存 `type='stamp'` の kind 分岐で足りる |
| E. 印刷の画像スタンプを vector（PDF XObject Form）化 | ❌ 保留 | β54-63 の印刷品質試行錯誤で C2360 ドライバ制約が判明済。bbox raster（β62）で実用十分と判断 |

全 PDF 共通化（Decision 2）を「global へ一本化」でなく「workspace 併存 + fallback」にしたのは、移行前に押された overlay の assetId を壊さないため。クリップボード paste が今も workspace 保存なのは一回性が前提のため（プリセット化したい画像はスタンプ管理から登録する棲み分け）。

## Consequences

### 受け入れる trade-off

1. **画像スタンプは印刷・書き出しで常に raster**（β62 の bbox 制約）。900dpi 運用で実害は出ていないが、拡大耐性は vector 印影に劣る。vector 化は研究課題として棚上げ
2. **中間グレー（lum 0.5-0.85）はやや濃く印刷される**（β87 ramp の副作用）。印刷品質としては改善方向であり受容。閾値 LO=0.5/HI=0.85 が業務印影を全カバーするかは実機フィードバック待ちだった（stable 化まで問題報告なし）
3. **登録キャンセルで orphan asset が残る**。画像登録ダイアログはプレビューのために先に asset 登録する設計（`stamp-dialogs.js` にコメントで明記）。dedupe により実容量への影響は小さく、最適化は follow-up 扱い
4. **workspace を他マシンへ持ち出すと global asset 参照が解決できない可能性**。get-asset fallback は同一マシン内の移行を想定した設計（持ち出し時の挙動の経緯記録なし）
5. **専用自動テストなし**。`test/m3-overlay-persistence.mjs` の assetId round-trip 検証のみで、asset ライブラリ・tint・contain フィットは手動確認のみ（HANDOVER §15.6 のテストカバレッジ不足に計上済）

### 影響範囲（実装ポインタ）

- `schema/schema.sql`: `assets` テーブル（既存）、overlays properties の `stamp: { kind, assetId?, ... }`
- `src/backend/sqlite-store.js`: `addAsset` / `getAsset` / `removeAsset` / `listAssets`
- `src/main/global-stamp-store.js`: `<userData>/stamps.db`（assets + stamp_presets ミラー、`migrateFromWorkspaceIfEmpty`）
- `src/main/main.js`: IPC `kpdf3:list-assets` / `add-asset` / `add-asset-from-file` / `get-asset`（workspace→global fallback）/ `remove-asset`
- `src/main/preload.cjs`: 上記 IPC の bindings
- `src/renderer/stamp-dialogs.js`: 画像登録ダイアログ + 試し置き（trial placement）
- `src/renderer/stamp-helpers.js`: `rampLumToAlpha`（LO=0.5 / HI=0.85）、`tintCanvasInPlace`
- `src/renderer/viewer.js`: `<img>` + object-fit:contain 描画（1074 付近）、`applyTintInPlace`
- `src/renderer/exporter.js`: `getAssetBitmap` / `getTintedAssetCanvas` / contain フィット描画（1782 付近）、β62 bbox（1219 付近）
- `src/renderer/renderer.js`: `pasteImageBlob`（1228 付近、クリップボード経路）

### 解除条件 / 後続

- **ADR-0019（プリセット管理）** — 画像プリセットの並び順・ラベル編集・フォント別指定はそちらで正式化
- **ADR-0018（asset DB 共有）** — stamps.db / workspace assets の容量肥大が現実化したら起草
- **画像スタンプ vector 化** — bbox raster を PDF XObject で置換する研究（現状は受容、HANDOVER §8）

## 検証

- 経緯の一次資料: commit `8e35afb`（MVP、2026-05-10）、`93f27d5`（β62 bbox）、β87 ramp、β.150 contain 一致（各 tag / CHANGELOG-history.md §6.4）
- 実機（β 業務並走）: カラー印影 1 登録で押印/印刷の濃度が白黒版と同等（β87 実機確認項目）、クリップボード画像の Windows ネイティブ表示（β145 確認項目）、画像スタンプの blob: 表示は Electron 41 CSP スモークで確認済（2026-06-03）
