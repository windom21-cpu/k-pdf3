# ADR-0002: Layout engine に mupdf.js を採用する

- 日付: 2026-05-09
- ステータス: 一部 supersede（→ ADR-0028、2026-07-23）— 「viewer/pdf 共通 layout engine と
  して mupdf を使う」部分は canvas 採寸（`wrapCanvasText` @ `EXPORT_ZOOM`）に置き換え、
  `backend/mupdf-layout.js` は復活させない。mupdf のレンダリング・probe・修復用途は現役のまま。

## Context

K-PDF3 は **viewer renderer と pdf renderer のピクセル一致** を構造的に保証する必要がある。これは新アーキの最大の技術リスク。

K-PDF2 v0.27.1 では html2canvas-pro の baseline 計算がブラウザ HTML rendering と数 px 違うため、annotation 位置がずれる問題に遭遇。
原因は viewer / export 側で異なる layout engine を使ったこと。

## Decision

**mupdf.js（WASM 版 MuPDF）を共通 layout engine として採用**する。

viewer renderer と pdf renderer の双方で mupdf.js の `Font` + `Text` API を呼び、glyph 配置・bbox の計算を一致させる。

## Rationale

### Spike 結果（2026-05-09 実施、`spike/mupdf-layout.mjs`）

- ✅ TTF buffer から `Font` 構築（CJK 含む、Kosugi で検証）
- ✅ `Font.encodeCharacter(uni)` で Unicode → glyph id
- ✅ `Font.advanceGlyph(gid)` で文字幅取得
- ✅ `Text.showString(font, trm, str)` で文字列配置 + 終了 Matrix 取得
- ✅ `Text.walk()` で各 glyph の transform matrix 取得
- ✅ size 10/12/14 でレイアウトが完全比例（決定性確認）

例：「印影テスト2026年5月9日」を fontSize=12 で配置 → 132pt 幅が計算通りに取れた。

### 利点

- **viewer / export 完全同一の layout 計算** → ピクセル一致が構造的に保証される
- **CJK 完全対応**（Adobe-Japan1 ベース）
- **PDF font subset embedding** が同じ API でできる（export 時）
- **Artifex の本業**（CJK / PDF 仕様準拠は信頼できる）
- **AGPL** だが個人＋スタッフ内利用なら OK

## 制約

- mupdf.js は **単一行レイアウトのみ**。行折り返し（line break）は別途 K-PDF3 側で実装。
- 禁則処理（行頭・行末禁則）は MVP 範囲外（「最小対応」とする）。
- WASM dependency → renderer プロセスで動かす（main では使わない）。
- 将来の backend swap を考慮し、`backend/mupdf-layout.js` 経由でのみ呼び出す（domain layer に mupdf 型を持ち込まない）。

## Consequences

### Positive
- ピクセル一致が API 共有で構造的に保証
- CJK 自前実装の沼を回避
- export 時の font embedding も同じ API で可能

### Negative
- **AGPL ライセンス** → 外部公開する場合は K-PDF3 自体を OSS 化する必要
- WASM の memory 制約（大きい PDF で注意）
- 単一行のみなので、複数行 / 折り返しは自前実装

### Neutral
- 配布バイナリ +5〜10MB（既に K-PDF2 v0.27.0 で確認済）

## 行折り返しの実装方針

mupdf.js が単一行のみなので、複数行テキストは：

```
1. テキストを「文字単位」に分解
2. 累積 advance を計算
3. width 制限を超えた位置で行を分割
4. 各行を mupdf.js で配置
```

禁則処理は MVP 後に追加検討（行頭の「、。」を前行末尾へ等）。

## Alternatives Considered

- **harfbuzz.js**: CJK shaping 可能だが、layout API が low-level で実装コスト高
- **opentype.js**: フォント情報取得は可能だが PDF embedding と分離が必要
- **自前 layout 実装**: 禁則・縦中横で 3〜5 週間の追加コスト、却下
- **ICU line break + 自前 metrics**: 構造が複雑、mupdf 共有の利点を失う

## References

- `spike/mupdf-layout.mjs`（spike script）
- HANDOVER.md（K-PDF2）の「【最重要・更新】2026-05-09 後半」
- ADR-0003（canonical coordinate）
