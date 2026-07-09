# ADR-0024: autoshape — overlay type "shape" の中心基準描画 + AABB 派生 bbox モデル

- 日付: 2026-07-10
- ステータス: **実装済（遡及起草 — REVIEW-2026-07 #7。実装は β.100〜104 で完了）**
- 関連: ADR-0003（canonical coordinate）、HANDOVER §9（overlay properties）/ §15.3

## Context

法律実務では証拠 PDF 上に「ここを見て」「この範囲」を指す図形（矢印・直線・枠・楕円）を置きたい
場面が頻出する。β.100 で新 overlay type `'shape'` を最小 4 種（直線 / 細線矢印 / 中空ブロック矢印 /
楕円）で導入し、β.101 でユーザー要望（「中に空白のある矢印を証拠関係で使う」）を受けて `rect` /
`rounded-rect` / `ellipse-x`（楕円+×、却下・無効マーク代用）/ `double-arrow` / `double-block-arrow`
を追加、計 **9 kind + 8 方向（45° 単位、斜め含む）** となった。

問題は方向を持つ図形（directional shape）の座標表現。既存 overlay はすべて軸並行 bbox
（`x, y, w, h`）の rect モデルで、β.100〜103 は矢印もこの bbox から endpoint を導く方式
（`_shapeEndpoints` が bbox 対角・中央線から始終点を決める）だった。その結果：

1. **斜め方向で見切れる** — 斜めブロック矢印の head が bbox からはみ出す（ユーザー報告）
2. **方向によって太さが変わる** — 方向変更を「bbox の w/h swap・斜めは正方形化」で実現した
   （β.102 の `updateShapeOverlay` 初版）ため、太さ・長さが方向に依存して破壊される
3. ドラッグ方向から向きを読む配置（atan2 量子化）は意図と違う向きになりやすく、8 方向 dropdown は煩雑（ユーザー報告）

β.104 でこれらを根治するモデルに再設計した。本 ADR はその最終形を記録する。

## Decision

### 1. properties が truth、bbox は派生値

directional shape（`line` / `arrow` / `double-arrow` / `block-arrow` / `double-block-arrow`）は
**方向不変の寸法 `length`（矢印の長さ pt）/ `crossSize`（軸直交方向の大きさ pt）+ `arrowDir`
（8 方向）を properties に保持**する。bbox（`w, h`）は保存時に
`shapeDirectionalBbox(arrowDir, length, crossSize)` で **rotated AABB として派生計算**する：

```
w = length·|cos θ| + crossSize·|sin θ|
h = length·|sin θ| + crossSize·|cos θ|    （θ = arrowDir の角度、45° 刻み）
```

方向変更時は中心 `(cx, cy)` を固定したまま bbox だけ再計算する（`updateShapeOverlay`）。非 directional（`rect` / `rounded-rect` / `ellipse` / `ellipse-x`）は従来どおり bbox が truth。

### 2. 中心基準描画 + ctx.rotate

`drawShape`（`exporter.js`）は directional shape を **中心 (0,0) 基準・右向き（+X 軸）で描画**
してから `ctx.translate(中心)` + `ctx.rotate(角度)` で arrowDir の向きに回す
（`_drawDirectionalShapeAtOrigin` + 中心基準ポリゴン helper）。方向別の endpoint 計算・
方向別ポリゴンは持たない（β.104 で旧 `_shapeEndpoints` 系は directional 経路から撤去）。

### 3. viewer / exporter で描画関数を単一共有

`drawShape` は `exporter.js` から export し、viewer は overlay div 内の child canvas に
`drawShape(ctx, { ...ov, x: 0, y: 0 }, zoom)` で同一関数を呼ぶ（devicePixelRatio scale 付き）。
印刷・書出（overlay PNG layer）と画面表示が同じコードパスを通る。

### 4. 配置・編集 UI / schema

- 配置はドラッグ方向を読まず常に "right"（β.102）。ドラッグ矩形の長辺 = length、短辺 =
  crossSize として採用（`_placeShape`）。配置直後に自動選択 → shape palette popup
  （ツールバー「図形」ボタン、位置永続化）で後付け編集
- 方向は **「↺ ⟨向き indicator⟩ ↻」ボタン UI** で 45° 単位回転（`rotateSelectedShape(±1)`、
  hidden の `#shape-dir` select を 1 段ずらして change 発火）。indicator は →↘↓↙←↖↑↗ の 8 種
- schema は `migrateOverlaysAddShape`（overlays.type CHECK 制約に 'shape' 追加、β.80
  form_field と同型の idempotent migration）

## Why

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. length/crossSize truth + AABB 派生 bbox + 中心基準 ctx.rotate（採用）** | ✅ | 方向を変えても太さ・長さが厳密に不変。AABB を正確計算するので斜めでも見切れない。描画コードは「右向き 1 種」で 8 方向を賄える |
| B. bbox truth + 方向別 endpoint（β.100〜103） | ❌ | 方向変更 = bbox 変形になり太さ・長さが壊れる。斜めは bbox 内接の近似ではみ出す |
| C. overlay 自体に回転角を持つ一般回転モデル | ❌ | ADR-0003 の canonical 座標（軸並行 bbox 前提）に回転概念を持ち込むと、選択枠・ヒットテスト・resize・export の全インフラに波及する。45° 8 方向で業務用途には十分 |
| D. 任意角度回転 | ❌ | C と同じ波及に加え UI が複雑化。↻↺ ボタン 1 対で済む 45° 量子化を優先 |

AABB 派生により、選択枠・移動・exporter PNG layer・viewer child canvas は既存の軸並行 bbox インフラをそのまま流用でき、shape のためだけの特殊経路が発生しない。

## Consequences

### Positive

- 方向変更・↻↺ 回転で太さ / 長さが不変（β.104 の設計目標）、斜め方向でも bbox 切れなし
- viewer / exporter は `drawShape` 単一関数の共有で WYSIWYG が構造的に保たれる
  （二重実装の drift が原理的に起きない）
- ページ回転との相互作用は単純：canonical 座標は「rotation 適用後のユーザー視点」（ADR-0003）
  なので `arrowDir` も紙アナロジー上の向き。`ctx.rotate` は overlay の bbox ローカル座標に
  しか作用せず、shape 側にページ回転の特別処理は存在しない
- 後方互換：β.100〜103 配置済みの旧 shape（length/crossSize 無し）は `length = max(w,h)` /
  `crossSize = min(w,h)` の fallback で読める

### 受け入れる trade-off

1. **bbox と properties の二重管理** — directional shape は「truth = length/crossSize、
   bbox = 派生」の不変条件を `_placeShape` / `updateShapeOverlay` の 2 箇所で守る必要がある。
   kind の directional ↔ 非 directional 切替時も bbox 整合処理が要る
   （directional→非: bbox を length×crossSize にリセット、逆: bbox の長辺/短辺を採用）
2. **リサイズハンドルは bbox のみ更新** — `handleOverlayResizeEnd`（overlay-edit.js）は
   x/y/w/h だけを書き length/crossSize に追随しない。`drawShape` は `props.length ?? max(w,h)` と
   properties を優先するため、directional shape の手動リサイズは描画寸法に反映されない（寸法変更は popup 経由が正）
3. directional 判定（5 kind の列挙）が exporter.js / overlay-placement.js に重複して存在する

## 実装ポインタ

- `src/renderer/exporter.js` — `drawShape`（export、viewer と共有）、`shapeDirectionalBbox`、
  `SHAPE_DIR_TO_ANGLE`、`_drawDirectionalShapeAtOrigin` + 中心基準ポリゴン helper
- `src/renderer/overlay-placement.js` — `startShapeDrag` / `_placeShape`（配置、zOrder 40）、
  `updateShapeOverlay`（方向・kind 変更時の bbox 再計算）、`rotateSelectedShape`（↻↺）
- `src/renderer/viewer.js` — `ov.type === "shape"` 分岐（child canvas + dpr scale で `drawShape` を再利用）
- `src/renderer/renderer.js` — shape palette popup、popup ↔ 選択 shape の値同期
- `src/renderer/index.html` — `#shape-rot-ccw` / `#shape-dir-indicator` / `#shape-rot-cw`、hidden `#shape-dir` select
- `src/backend/sqlite-store.js` — `migrateOverlaysAddShape`
- 経緯: CHANGELOG-history.md の β100〜β104（2026-05-19）
