# ADR-0012: HiDPI 対応の oversampling と render quality 切替

- 日付: 2026-05-10
- ステータス: 採用
- 関連: ADR-0006（PDF-first UX + 98.css）、HANDOVER §7.6.7

## Context

ビューア上の PDF 表示が（特に文字・細線で）ぼやける、というユーザーフィードバック。原因：

- 旧実装は `viewer._zoom`（CSS scale）をそのまま `renderPage` に渡し、画素 1:1 で描画
- 標準 DPR (devicePixelRatio = 1) のディスプレイでも、PDF の text glyph stroke (0.5pt 程度) が CSS pixel 1 に丸められて消える
- HiDPI ディスプレイ (DPR ≥ 2) では window.devicePixelRatio が乗算されないので、半分の解像度で表示される

要件：

- 標準 DPR でも文字がシャープ
- HiDPI ディスプレイでネイティブ解像度を活かす
- メモリ消費は仮想化（ADR-0006 / virtualization）でバウンド済の前提を壊さない
- 旧式マシン / 大きい PDF では標準描画にも fallback 可能

## Decision

### 1. oversampling factor の構造

```js
const RENDER_QUALITY_MULTIPLIERS = {
  standard: 1.0,
  high:     2.0,
  max:      3.0,
};
const DEFAULT_RENDER_QUALITY = "high";
function computeOversample(level) {
  const mul = RENDER_QUALITY_MULTIPLIERS[level] ?? RENDER_QUALITY_MULTIPLIERS[DEFAULT_RENDER_QUALITY];
  return Math.min(window.devicePixelRatio || 1, 2) * mul;
}
```

renderPage 呼び出し時：

```js
const renderZoom = this._zoom * computeOversample(this._renderQuality);
const result = await window.kpdf3.renderPage(pageNo, { zoom: renderZoom });
```

canvas の `width` / `height` 属性は oversample 後の物理 pixel、CSS の `width: 100%` / `height: auto` でブラウザがダウンスケール。Smoothing は browser GPU 任せ（標準で線形補間）。

### 2. DPR との掛け算 = `Math.min(DPR, 2)`

HiDPI ディスプレイで DPR = 3 のような環境もあるが、3 × 3 = 9 倍の oversample はメモリ・レンダリングコストが見合わない。実用的に DPR は 2 で頭打ちにし、それ以上を望むユーザーは `max` を選ぶ：

| ディスプレイ | レベル | 実効 oversample |
|---|---|---|
| DPR=1 | standard | 1.0 |
| DPR=1 | **high** (default) | **2.0** |
| DPR=1 | max | 3.0 |
| DPR=2 (Retina) | standard | 2.0 |
| DPR=2 | **high** | **4.0** |
| DPR=2 | max | 6.0 |
| DPR=3 | high | 4.0 (DPR=2 にクランプ) |

メモリは oversample² なので high (DPR=1, 2.0) は標準の 4 倍、max (DPR=2, 6.0) は標準の 36 倍。仮想化で同時 mounted ページ数が ~5 程度に抑えられているので、A4 / 600 dpi 相当でも 1 ページ ~30 MB × 5 = 150 MB 程度。実機で問題なし。

### 3. レベル切替 UI と再描画

`Viewer.setRenderQuality(level)`：

- 同一レベルなら no-op
- レベル変更時、`load(this._pages)` を呼んで全 canvas を作り直す
- スクロール位置は保たれる（layout は不変、canvas pixel 密度のみ変化）

メニューから「画質：標準 / 高（推奨） / 最大」を選ぶ。`menu-bar.js` の `setChecked` で現在のレベルにチェックマーク。

### 4. export / print preview には適用しない

`composePagesForExport` は `EXPORT_ZOOM`（PDF point dpi 換算で 144 dpi）の固定値を使用。ビューア表示と export は独立した quality knob を持つ：

- ビューア quality は **画面表示の見栄え**
- export zoom は **配布 PDF の物理解像度**

ユーザーが「印刷できれいに出ない」と感じたら export zoom 側を上げる別 ADR を起草する余地を残す。

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. CSS は等倍 + canvas を oversample でダウンスケール（採用）** | ✅ | CSS layout は変わらず scroll / overlay 座標が壊れない、GPU で smooth scaling |
| B. CSS scale も devicePixelRatio で実寸にする | ❌ | layout 全体が変わって overlay の canonical → CSS pixel 変換が歪む |
| C. mupdf 側で antialias level を上げる | ❌ | mupdf 既に AA しており、低解像度の本質的な情報量不足は補えない |
| D. 常時 DPR × 2 固定（quality knob なし） | ❌ | 旧マシン / 400p PDF でメモリ食い過ぎを訴えるユーザーへの逃げ道がない |

## Consequences

### 受け入れる trade-off

#### 1. メモリ消費が default で 4 倍

DPR=1 マシンで `high` 既定 → 標準の 4 倍（仮想化があるので絶対量は許容範囲）。`standard` への切替を「軽量モード」として位置付けて、ユーザーに逃げ道を提供。

#### 2. ダウンスケール時のシャープネスはブラウザ次第

Chromium の image-rendering デフォルト（`auto` ≒ 高品質双線形）に頼っている。`image-rendering: pixelated` を当てると逆にギザつく。pixel-grid 寄せのスクリーンショット文字は §7.6.7 の `disable-font-subpixel-positioning` 等で別途対応している。

#### 3. レベル変更が全 canvas 再描画

仮想化で mounted は数ページなので体感的には瞬時に終わるが、巨大 PDF 全ページを open しているテスト環境ではちらつきうる。実用上は問題なし。

### 影響範囲

- `src/renderer/viewer.js`:
  - `RENDER_QUALITY_MULTIPLIERS` / `DEFAULT_RENDER_QUALITY` / `computeOversample`
  - `_renderQuality` instance state
  - `setRenderQuality(level)` メソッド
  - `_paintPage` 内で `renderZoom = this._zoom * computeOversample(...)`
- `src/renderer/renderer.js`: `setRenderQuality(level)` で viewer に転送 + メニュー checkmark
- `src/renderer/menu-bar.js`: `setChecked(state)` メソッド
- `src/renderer/index.html`: 「画質」メニュー項目（標準 / 高 / 最大）
- `src/main/main.js`: 補助的に `font-render-hinting=none` / `disable-font-subpixel-positioning` switch（pixel-grid フォント描画と関連）

### 解除条件

- WebGPU / OffscreenCanvas で mupdf 描画を main process 外でやる将来構成 → oversample 実装を移植
- export 解像度の knob を独立に持ちたい要件が出た場合 → 別 ADR、本 ADR は影響なし
- メモリプレッシャーが現実問題化したら、レベルを per-zoom に分けて「縮小表示中は standard、拡大時は high」を自動切替する案（現状 manual 切替で十分）

## 検証

- 380 テストは継続 pass（viewer の oversample は単体テストでは見えない、画面確認のみ）
- 手動：
  - DPR=1 ディスプレイで `standard` → `high` → `max` を切替 → 文字がシャープになり、メモリは 1× → 4× → 9×
  - 高速スクロール中もちらつかない（virtualization が同時 mounted を制限）
  - レベル切替後に scroll 位置がジャンプしない
