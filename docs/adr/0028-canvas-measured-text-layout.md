# ADR-0028: テキスト表示レイアウトの正を canvas 採寸に統一する（非編集時 1 行=1 要素 絶対配置）

- 日付: 2026-07-23
- ステータス: 採用（ADR-0002 の「mupdf を viewer/pdf 共通 layout engine とする」部分を supersede）

## Context

2026-07-22 のユーザー報告: 横長ディスプレイ（最大化）でテキストを挿入 → 下書きのまま
縦長ディスプレイで表示すると挿入位置が数 px ずれて見える。縦長側の見た目を基準に微調整して
確定保存したら、実は横長側が正しく、意図と違う位置に焼かれた。

2026-07-23 の分析で原因を確定した:

- 保存座標（canonical PDF pt）は表示に依存せず**最初から正しい**。ずれるのは表示側。
- テキストの見た目レイアウトは ①横長画面の DOM ②縦長画面の DOM ③確定出力（exporter）の
  **3 つの別エンジンが各自再計算**している。
- ③ = `wrapCanvasText` による canvas 採寸（`EXPORT_ZOOM` = 900/72 固定、
  `src/renderer/exporter.js`）が**事実上の真の位置**（印刷・確定/別名保存・サムネ・分割
  ビュー共通）。
- viewer は canonical×zoom の CSS px で DOM に組ませるため、fit-width 既定でモニタ幅により
  倍率が変わる + モニタごとの DPR で、Chromium の折返し判定・字送り丸め・ベースライン
  スナップが数 px 級にずれる。倍率の大きい横長画面が③に近かったのは必然（量子化誤差が
  相対的に小さい）。

**ADR-0002（2026-05-09 採用）はまさにこの問題のために「viewer/pdf 共通 layout engine
(mupdf)」を決定済み**で、ラッパー `src/backend/mupdf-layout.js` も M1 で作られたが、
IME=contentEditable 制約（HANDOVER §13.1）で立ち消え、import ゼロのまま休眠していた。
一方、現実の製品は v2.0.13 までに「canvas 採寸 + ベクターテキスト層（1 行=1 op）」という
別の共通化資産を exporter 側に築いており、全出力経路がそれで一致している。

## Decision

**レイアウトの正（truth）を mupdf ではなく exporter の canvas 採寸
（`wrapCanvasText` @ `EXPORT_ZOOM`）と定める。**

1. **非編集時**の text / form_field(text) overlay の viewer 表示は、DOM の自動折返しを
   捨て、exporter と同一の canvas 採寸で行分割・行位置を計算した
   **「1 行 = 1 要素 (span)」の絶対配置**で描く（案 C）。
   採寸は `EXPORT_ZOOM`（900dpi 相当）固定で行い canonical pt で返すので、
   **モニタ幅（fit-width 倍率）にも DPR にも依存しない** — どのディスプレイでも
   折返し・行位置が確定出力と一致する。
2. **編集中は contentEditable を維持**する（IME 制約。mupdf 案が立ち消えた理由その
   もので、ここは変えない）。編集を抜けた瞬間に採寸表示へ戻る。
3. `src/backend/mupdf-layout.js` は**復活させない**（ADR-0002 の layout-engine 部分を
   supersede）。mupdf 自体はレンダリング・probe・修復用途で引き続き中核（そこは
   ADR-0002 の範囲外で不変）。

## 実装

- `src/renderer/exporter.js` に共有採寸関数 `measureOverlayTextLayout(ov)` を追加
  （追加のみ、既存経路は不変更）。`_textOverlayVectorOps` / `_formFieldTextVectorOps`
  と同じ数式（wrap 幅・lineHeight・align・padX・baseline offset）で、natural frame
  （回転前）の overlay 左上原点の canonical pt を返す:
  `{ rot, naturalW, naturalH, lines: [{ text, x, baseline }] }`
- `src/renderer/viewer.js` `_createOverlayElement`:
  - text overlay: `textContent` の代わりに 1 行 = 1 span を絶対配置。回転
    (`props.rotation`) は従来どおり inner コンテナの CSS transform（natural frame で
    行を組んでから回す = exporter の「pre-rotation 幅で wrap → 中心 anchor で回転」と
    同型）。
  - form_field(text): 値の表示を同方式に（alignH/alignV/padX は採寸側で解決済みの
    per-line x/baseline を使う）。flex/textAlign 等の既存スタイルは contentEditable の
    caret 揃えのため残す（絶対配置の子には影響しない）。
- text overlay の画面クリップを exporter と同じ「枠+8pt」に統一
  (`clip-path: inset(−8pt×zoom)`)。従来の `overflow:hidden`（枠ぴったり）では、
  採寸行が DOM 描画でわずかに太ったとき行末の字が欠け、紙には出る +8pt 内の
  はみ出しが画面に出ない。form_field は従来どおり枠クリップ（padX=1pt の
  スラックで足りる + 記入枠から滲むのは見た目上の破綻）。
- **DOM ベースライン合わせ**: span の `line-height` を
  `fontBoundingBoxAscent + fontBoundingBoxDescent`（canvas measureText 実測、
  viewer 表示サイズで採寸）に固定すると half-leading が 0 になり、行ボックスの
  baseline は top + ascent に確定する。そこで
  `span.top = baseline×zoom − ascent` で canvas 採寸のベースラインに合わせる。
  canvas と DOM は同じフォントラスタライザなので、行内の字形描画も一致する。
- 編集キャンセル時（Esc）は `textContent` 復元ではなくページ overlay 再描画で
  採寸表示に戻す。

## スコープ

- 対象: text overlay（回転含む）+ form_field(text)。ベクターテキスト層（v2.0.13）の
  1 行=1 op と同じ対象範囲。
- 対象外（従来 DOM 表示のまま）: stamp（短文・run 分割/distribute 等の独自レイアウト）、
  callout 本文（textNode + padding の独自レイアウト。v2.0.13-beta.3 で exporter と実機
  一致済みの完成領域 — 非干渉原則）。ずれが実害として報告されたら個別に拡張する。

## ユーザー許容済みの制約（2026-07-23 承認）

1. 編集終了時に文字がスナップして動くことがある（DOM 折返し → 採寸折返しへの切替）。
2. 編集中は従来のずれが残る（位置判断は編集を抜けてから行う）。
3. 禁則の見え方が編集中と確定表示で変わる（`wrapCanvasText` は禁則なし）。
4. 既存文書の画面折返しが変わって見えることがある（紙の折返しは元々採寸側なので不変 =
   むしろ画面が紙に寄る）。

付随する小さな挙動変更: リサイズ中のライブ再折返しは行わない（ドラッグ中は clip され、
確定時に再折返し）。move/zoom は再描画経由なので従来どおり。

## Consequences

### Positive

- **WYSIWYG の構造保証**: 画面（非編集時）と紙の行分割・行位置が同一の採寸コードから
  出る。「画面は正しいのに出力だけおかしい」「モニタによって見え方が違う」系のずれが
  クラスごと消える。
- マルチディスプレイ・DPR 混在環境（ユーザーの実運用）で表示が安定する。
- 既存の完成領域（exporter・ベクターテキスト層・回転ベイク）は 1 バイトも変えない
  追加分岐で実現。

### Negative

- 行内の字送りは viewer 表示サイズでのラスタライズなので、行末端の位置が確定出力と
  サブピクセル〜数 px 残差を持ち得る（行頭位置と折返しは完全一致。実害があれば
  行単位 scale 表示に拡張可能）。
- 非編集時の DOM 要素数が増える（1 overlay → 行数分の span）。実務文書のテキスト
  overlay 数では無視できる規模。

### Neutral

- ADR-0002 の mupdf 採用のうち「共通 layout engine」だけが置き換わる。レンダラ・
  probe・修復・ベクターテキスト層のフォント処理（mupdf/カスタム）は不変。

## Alternatives Considered

- **案 A: mupdf-layout.js の復活（ADR-0002 完遂）**: IME=contentEditable 制約で編集中は
  結局 DOM レイアウトが残る + 出力の真は既に canvas 採寸へ移っており、mupdf を正に
  すると全出力経路の再検証が要る。却下。
- **案 B: 確定表示トグル**（表示だけ exporter レンダを重ねるモード）: ずれの根治に
  ならず操作が 1 段増える。案 C 決定により見送り。
- **非編集時を canvas 要素で描く**: 位置は完全一致するが、DPR/zoom 変更ごとの再描画
  管理と選択・テキストのシャープさで span 方式に劣後。承認済みの案 C（1 行=1 要素）を
  採用。

## References

- HANDOVER.md §8.2 「マルチディスプレイでテキスト挿入位置が数 px ずれて見える」
  (2026-07-22〜23)
- ADR-0002（mupdf layout engine — 本 ADR で layout 部分を supersede）
- ADR-0003（canonical coordinate）
- v2.0.13 ベクターテキスト層（`exporter.js` `_textOverlayVectorOps` — 1 行=1 op 資産）
- memory `project_text_layout_unification_plan`
