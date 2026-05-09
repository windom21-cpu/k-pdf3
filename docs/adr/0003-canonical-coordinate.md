# ADR-0003: Canonical coordinate を PDF point 72dpi / top-left origin / 紙アナロジーに固定する

- 日付: 2026-05-09
- ステータス: 採用

## Context

K-PDF3 では overlay object が「ページ上のどこにあるか」を一意に表現する座標系が必要。
混乱の元になる軸：

1. **単位**: PDF point (72dpi) / pixel / mm のどれを内部とするか
2. **origin**: top-left / bottom-left のどちら
3. **rotation**: PDF native 座標 / ユーザー視点（rotation 適用後）のどちら
4. **cropbox / mediabox**: どちらを基準にするか

K-PDF2 では一部混在していた。新アーキでは **完全に一意化** する。

## Decision

### 内部 canonical coordinate の仕様

| 項目 | 採用 |
|---|---|
| 単位 | **PDF point (72dpi)** 固定 |
| origin | **top-left** |
| 軸 | x: 右が正 / y: 下が正 |
| rotation | **rotation 適用後のユーザー視点（紙アナロジー）** |
| 基準矩形 | **cropbox（表示される領域）** |

overlay object はこの座標系のみを保持する。PDF native 座標は知らない。

## Rationale

### 単位 = PDF point

- PDF 仕様の基本単位
- DPI 依存しない（72dpi 固定）
- mupdf.js / pdf-lib も point 基準

### origin = top-left

- ブラウザ / Canvas / 多くの UI ライブラリと一致 → render layer での変換が少ない
- PDF native は bottom-left なので backend adapter で y 反転

### rotation = 紙アナロジー

- ユーザーが「縦になっているページ」を見ているとき、上が y=0、下が y=高さ
- K-PDF2 v0.25.0 で採用した方式と整合（既存の実装哲学を継承）
- object は「自分が回転している」ことを意識しない

### 基準矩形 = cropbox

- ユーザーが見ているのは cropbox（表示領域）
- mediabox 外に置かれた object は viewer で見えないため、cropbox を基準とする
- export 時に必要に応じて mediabox 座標へ変換

## 変換責務の配置

```
┌──────────────────────────────────┐
│ Domain Layer                     │
│ - overlay は canonical のみ      │
│ - PDF native を知らない          │
└──────────────────────────────────┘
              ↑↓ transform
┌──────────────────────────────────┐
│ Coordinate Adapter (domain/coord)│
│ - canonical ↔ PDF native         │
│ - rotation 適用 / 逆適用         │
│ - cropbox / mediabox 変換        │
│ - inverse transform 必須         │
└──────────────────────────────────┘
              ↑↓
┌──────────────────────────────────┐
│ Render / Backend layer           │
│ - PDF native 座標で mupdf を呼ぶ │
│ - viewer 描画は canonical のまま │
└──────────────────────────────────┘
```

## 不変条件（テストで担保）

1. **roundtrip**: canonical → PDF native → canonical で同一値
2. **rotation 0/90/180/270 で対称**: 90 を 4 回適用すると元に戻る
3. **mixed-page-size**: 異なるページサイズが混在しても各ページ独立に正しく動く
4. **cropbox shifted**: cropbox の origin が (0,0) でなくても overlay 位置が正しい

これらを `test/coord.test.js` の必須ケースとする。

## debug 機能

開発中の座標バグを早期発見するため：
- canonical grid overlay 表示機能（5pt / 10pt / 50pt のグリッド）
- ページの bbox 可視化（mediabox 緑、cropbox 青、ユーザー領域 赤）

## Consequences

### Positive
- object の位置計算が単純（rotation を意識しない）
- viewer / export で座標差異が起きない
- テストが書きやすい（roundtrip + rotation 対称）

### Negative
- backend layer で常に変換が走る（性能影響は微小）
- ページごとに transform matrix を持つ必要

### Neutral
- K-PDF2 v0.25.0 の紙アナロジーと一致 → 概念継承可能

## 禁止事項

- overlay object に PDF native 座標を直接保存する
- canonical 座標を渡さずに PDF API（mupdf 等）を呼ぶ
- ブラウザ pixel 単位で位置を計算する
- rotation を考慮しない位置計算

これらは architecture 違反として扱う。

## Alternatives Considered

- **PDF native 座標を canonical とする**: 既存 PDF tooling と一致するが、object が rotation を意識する必要があり実装複雑化。却下。
- **bottom-left origin**: PDF 仕様準拠だが、render layer での変換が増える。却下。
- **mm 単位**: 法律書面で印刷時に扱いやすいが、内部は point 統一として、UI 表示だけ mm に変換する方針で十分。

## References

- HANDOVER.md（K-PDF2）の「§10. 次にやりたいこと」内の回転 WYSIWYG 課題
- ADR-0002（mupdf-layout-engine）
