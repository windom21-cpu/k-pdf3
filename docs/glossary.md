# K-PDF3 Glossary

K-PDF3 で使う用語の定義。AI セッション交代時に最優先で参照すること。

## 基礎概念

### workspace
編集の真実源。`.kpdf3` という単一 SQLite ファイル。source PDF + overlay objects + assets + export history を含む。

### project
1 つの workspace = 1 project = 1 source PDF。
タブで複数 project を同時に開けるが、project 間は独立。

### source PDF
編集の出発点となる元 PDF。**immutable background** として扱い、編集対象ではない。SQLite の BLOB 列に bit-identical で保管。

### overlay object
編集の単位。canonical 座標系で位置を持つ。
種類：text / stamp / image / redaction / line / rectangle / signature。

### canonical coordinate
内部統一座標系。PDF point (72dpi) / top-left origin / page rotation 適用後の論理座標。
overlay object はこの座標系のみを知る。

### export
workspace を flatten PDF として出力する操作。配布・閲覧・印刷用の成果物を生成する。

### secure export
metadata strip / xref rebuild / sanitize を施した export。qpdf 経由。法律実務の真正性要件用。

### flatten
overlay object を PDF content stream に焼き込む処理。

### revision id
export ごとに発行される ID。PDF metadata に埋め込み、workspace の export 履歴と紐付ける。

## 状態系

### dirty
workspace に保存されていない変更がある状態。

### unexported
workspace は保存済みだが、最後の export 以降に変更がある状態。

### exported
最後の export 時点と workspace が一致する状態。

### safe mode
source PDF の fingerprint mismatch 時の安全停止モード。overlay lock / export 禁止。

## レイヤ

### domain layer
純粋ロジック層。overlay store / coordinate / history / page registry を含む。
backend adapter を直接知らない。

### render layer
画面表示と PDF 出力を司る層。layout engine / viewer renderer / pdf renderer / print pipeline を含む。

### backend adapter
外部ライブラリ（mupdf.js / pdf-lib / qpdf）を隔離する wrapper 層。

### viewer renderer
画面表示の renderer。Canvas（visual truth）+ DOM（編集中・IME・accessibility）の hybrid。

### pdf renderer
export 用の renderer。overlay → draw command → content stream → PDF。

### layout engine
text + font + size から glyph 配置と bbox を計算するエンジン。mupdf.js の Font/Text API を共通利用し、viewer / pdf renderer のピクセル一致を保証する。

## annotation

### annotation
PDF 標準の注釈 object（/FreeText, /Stamp 等）。K-PDF3 では **read-only visual proxy** として扱う。

### visual proxy
外部 viewer が作った annotation を K-PDF3 が表示用に解釈した object。編集不可。

### appearance stream (/AP)
annotation の見た目を保持する PDF 内 content stream。存在すれば最優先で利用。

## 通信・配布

### communication layer
annotation を「外部との軽量なやり取り用」として位置付ける概念レイヤ。truth ではない。

### export snapshot
workspace 内の `exports` テーブルに BLOB 保管された配布版 PDF。法律実務の「あの時提出した版」を bit-identical 復元するため。

### source fingerprint
source PDF の同一性検査用キー。MVP では file hash + page count + mediabox。

## 禁止用語（使わない / 概念として持ち込まない）

- 「annotation roundtrip」: K-PDF3 では実装しない
- 「annotation editability guarantee」: 保証しない
- 「viewer-native rendering」: 自前 renderer で描画する
- 「DOM screenshot」: export source として使わない
- 「browser pixel coordinate」: canonical 座標のみを扱う
