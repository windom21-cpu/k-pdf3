# ADR-0029: A4 切り取り（非 A4 ページを A4 縦の枠で切り出して別ファイル化）

- 日付: 2026-08-24
- ステータス: 実装済（β トライアル待ち）
- 関連: ADR-0003（canonical coordinate）、ADR-0022（セキュア書き出し）、rotate-place.js（回転配置の規約）、HANDOVER §8.2

## Context

直接的な動機は「A3 横の PDF を A4 縦 2 枚に分割したい」（2026-08-24 ユーザー要望）。
法律実務では提出・FAX・綴じの都合で A4 縦に揃えたい場面が多く、要件は以下で確定した:

- **縮小ではなく切り取り**（内容を縮めない。A3 横はちょうど A4 縦 2 枚分）
- 切り取り枠は **A4 縦固定サイズ**・ドラッグで位置調整。初期位置は自動提案
  （A3 横だけ左右 2 枠、他のサイズは中央 1 枠 + 「枠を追加」で増やせる）
- A4 未満のページは枠が紙の外（グレー背景）にはみ出してよい = 余白を足して A4 化
- **元ファイル / workspace は一切変更しない**。切り取り結果は別ファイルとして保存し、
  保存後に新しいタブで開く

## Decision

### 1. 「別名保存の仲間」として実装する（workspace のページ属性にはしない）

出力は常に別ファイルなので、可逆確定 (ADR-0026)・byte-copy ゲート・overlay 座標
シフトといった workspace 側の統合は一切不要。既存の書き出し IPC
`kpdf3:export-pdf-rasterized` の payload に **`cropFrames`（`{pageNo: [{x,y,w,h}]}`、
canonical 座標・top-left 原点・pt）を追加**し、main 側で組み立て済み PDF への
**後処理**としてクロップする。`cropFrames` が無い呼び出しは従来と完全に同一経路
（追加分岐のみ、既存経路は不変）。

### 2. クロップは assembleHybridPdf の「後」に、独立モジュールで行う

`src/main/crop-a4.js` の `applyCropFramesToPdf(pdfBytes, pages, cropFrames)`:

- 組み立て済み PDF を pdf-lib で load し、枠を持つページごとに
  「A4 縦の新規ページに `embedPage` + `drawPage`（オフセット配置）」で
  枠 1 つ = 出力 1 ページに差し替える。枠外は A4 の MediaBox/CropBox 境界で切れる。
- **組み立ての verbatim 高速パスは intrinsic /Rotate を持ったままページを運ぶ**
  （strategy source の sourceRot≠0/userRot=0、external の extRot≠0 等）ため、
  canonical 座標の枠をそのまま使うと切り出し位置が回る。対策は
  `_assembleHybridPdfOnce` を触るのではなく、**crop モジュール側で
  `rotatedSourcePlacement`（rotate-place.js の既存規約）を使って /Rotate を
  ベイクしながら配置する**。canonical 寸法は payload ではなくページ自身の
  CropBox + /Rotate から再計算し、内部整合を保証する。
- vectorTexts（MS 明朝ベクターテキスト層）は assembleHybridPdf 内で焼き込み済み
  なので、後処理クロップは自然に整合する（content stream ごと embed される）。
- しおり書き戻し（addFlatOutlinesToPdf）はクロップの**後**。pageOrder は
  `expandPageOrderForCrop` で展開し、枠 2 つ以上のページは**先頭の枠ページ**に
  しおりが乗るようにする（2 枠目以降は pageNo=null のプレースホルダ。
  addFlatOutlinesToPdf の indexByPageNo は Map なので重複 pageNo を並べると
  最後の枠に乗ってしまう — null 埋めが正）。

### 3. UI はサムネ右クリック → 専用ダイアログ（1 ページずつ巡回）

- `#ctx-thumb` に「A4 サイズに切り取り…」を追加。巡回できる対象は**文書内の
  全非 A4 ページ**（canonical 寸法が A4 縦 ±2pt でないページ。A4 横も対象）。
  右クリックしたページが対象ならそこから開始。対象が無ければ案内だけ出す。
- **切り取るのは既定で「右クリックしたその 1 ページ」だけ**（2026-08-25 変更。
  当初は全非 A4 ページに初期枠を配って一斉に切っていたが、「複数の対象ページが
  あるとき同じ枠位置で全部切られてしまう」というユーザー指摘で原則を反転した）。
  初期枠は開始ページにのみ置き、他ページは枠なし = 切り取らない。
- **例外の一括適用はダイアログ内チェックボックス**「同じ枠位置を他の非 A4
  ページにも適用する（他に N ページ）」を明示 ON にしたときだけ。寸法が同じ
  ページは枠座標をそのままコピー、違うサイズのページはそのサイズの既定枠。
  ON 後に個別ページで手調整したページ（`touched`）は再配布で上書きしない。
  OFF に戻すと他ページの枠は落ちて「その 1 ページだけ」に戻る。
- ダイアログ（`src/renderer/crop-a4.js`）はグレーの stage 中央にページプレビュー
  （`composeSinglePageCanvas` = 出力側 exporter 描画なので WYSIWYG）を描き、
  その上に A4 枠 div を重ねる。ドラッグ移動のみ（リサイズなし）、
  ページ端 / 左右半分位置へスナップ。枠は追加・削除でき、**0 枠 = そのページは
  切り取らない**。前へ/次へで非 A4 ページを巡回し、枠状態は保持（巡回先で
  「枠を追加」すればそのページも明示的に対象にできる）。ページラベルには
  枠数（「枠 2」/「枠なし: 切り取らない」）を出す。
- 「切り取って保存」→ いつもの保存ダイアログ（セキュア書き出し / 白黒 トグル付き、
  初期名 `元名_A4.pdf`。1 ページだけ切るときは `元名_pN_A4.pdf`）→
  `composePagesForExport`（**枠のあるページだけ**）→
  `exportPdfRasterized({..., cropFrames})` → `newTabAndOpen(savePath)`。
  actionSavePagesAsPdf (sidebar-thumbs.js) と同じ動線。

### 4. 出力ファイルの構成

**枠を置いたページだけ**を表示順どおり出力し、各ページを「枠 1 = 1 ページ」
（枠は左→右・上→下の順）に置き換える（2026-08-25 変更。当初は文書全ページを
出力して枠付きページだけ差し替えていた）。A3 横 1 ページを切れば出力は
「A4 縦 2 ページの PDF」。枠を置かなかったページは出力に入らない = そのページに
紐づくしおりも付いてこない（ページ部分保存 actionSavePagesAsPdf と同じ性質）。
main 側 `applyCropFramesToPdf` は payload の pages 順で index を引くので、
部分集合を渡しても契約は変わらない（0 枠ページ素通しの経路も残っている）。

## 却下した代替案

- **CropBox を掛けるだけの非破壊クロップ**: 他ビューアで解除できる・Adobe 印刷の
  挙動が読めない・「切ったつもりが残る」は法律実務で事故になる。
- **クロップ対象ページを組み立て時に強制ベイク**（`_assembleHybridPdfOnce` の
  高速パス条件に追記）: 動くが、実機検証済みの組み立て経路に触る。crop モジュール
  側で /Rotate を処理すれば既存経路は 1 バイト不変で済む（採用案）。
- **縮小して A4 に収める**: ユーザー要件が「切り取り」で確定（将来の別機能余地は残る）。

## テスト

`test/crop-a4.test.mjs`（mupdf WASM レンダリングでピクセル検証、
rotation-overlay.test.mjs の harness を流用）:

- A3 横 → 2 枠で左半分 / 右半分が正しく 2 ページに分かれる（マーカー色で確認）
- /Rotate=90/180/270 を持つページ（verbatim 高速パス相当）でも切り出し位置が回らない
- A4 未満ページ + はみ出し枠 → 白余白付き A4 化
- 0 枠ページ素通し・ページ順・expandPageOrderForCrop の展開
