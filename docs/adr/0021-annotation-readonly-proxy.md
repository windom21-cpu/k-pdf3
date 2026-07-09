# ADR-0021: annotation read-only proxy（mupdf 経由抽出 + 15 種別 viewer 表示）

- 日付: 2026-07-10
- ステータス: **実装済（遡及起草 — REVIEW-2026-07 #7。実装は β.83 で完了）**
- 関連: ADR-0002（mupdf layout engine）、ADR-0003（canonical coordinate）、ADR-0006（PDF-first UX）、HANDOVER §1（3-layer 分離）、§2.3 非目標 / §2.4 禁止事項、CHANGELOG-history の β83（2026-05-17、M6 残作業 C3）

## Context

法律実務では、外部アプリで annotation を付けた PDF を受け取る場面が日常的にある。相手方や裁判所、依頼者が Adobe Acrobat 等で付箋（コメント）・ハイライト・取消線・押印（Stamp）を付けて送ってくる。K-PDF3 でそれを開いたときに annotation が**見えない**と、指摘箇所を見落として実害になる。

一方、K-PDF3 のアーキテクチャは annotation の「編集」を明確に拒否している：

- K-PDF2 v0.27.1 で PDF Annotation 書き出しを 4 アプローチ試行した結果、**viewer 間の baseline / appearance 差異により法律実務に必要な位置精度は構造的に達成不可能**と判明（2026-05-09）。これが K-PDF3 への作り直しの直接動機
- その帰結として 3-layer 分離（HANDOVER §1）では annotation を「**外部との通信レイヤ（read-only visual proxy として表示のみ）**」と位置付け、§2.3 非目標に「annotation 完全互換往復」「viewer 依存 annotation 設計」、§2.4 禁止事項に「**annotation を editable overlay object に変換する**」を明記済み

つまり「見えないのは困る／編集に踏み込むのはアーキ違反」の間を埋める設計が必要だった。M6 の残作業 C3 として β.83（2026-05-17）で実装。

## Decision

外部 annotation を **読み取り専用の視覚 proxy** として viewer に表示する。K-PDF3 の overlay（編集系）とは完全に別系統。

1. **抽出（backend）**: `src/backend/mupdf-annotations.js` が mupdf 経由で source PDF から annotation を抽出。対象は `PROXIED_TYPES` の Text / FreeText / Stamp / Highlight / Underline / Squiggly / StrikeOut / Ink / Line / Square / Circle / Polygon / PolyLine / Caret / FileAttachment / Redact（form widget・リンク・マルチメディア等の基盤系は対象外）。保持するのは `/Rect` + `/Contents` + `/T`（author）+ `/C`（color）+ Highlight 系の `/QuadPoints` + Ink の per-stroke bbox のみ — appearance stream の再現はしない
2. **キャッシュ（main）**: IPC `kpdf3:get-all-annotations` が初回呼出で全ページ抽出し、`TabHandle.annotations` に per-tab メモリキャッシュ。workspace には**一切保存しない**
3. **座標変換**: `domain/coord.js` に `pdfRectToCanonical`（`canonicalRectToPdf` の逆関数）を追加。viewer の `_pageBoxMap` で PDF native rect → canonical に変換するので、zoom 変更や DOM 再構築でも位置が保たれる（ADR-0003 の canonical 座標系に載せる）
4. **表示（viewer）**: `viewer.js` が page div 内に **non-interactive な `.annotation-layer`** を構築。種別ごとに retro 風の視覚分岐 — 付箋（Text）=黄 "T" / Caret=水色 "^" / FileAttachment=紫 "@" / Highlight=半透明黄 per-quad / Underline=緑線 / Squiggly=赤波線 / StrikeOut=赤取消 / FreeText=青破線枠+内容 / Stamp=オレンジ枠 / Square・Circle・Line・Polygon=茶薄枠 / Redact=赤破線 / Ink=灰点線。ホバーで OS native の `title` tooltip（種別 + author + 内容）
5. **書き出し・印刷は不変**: annotation は workspace に持たないため、export 経路と印刷経路（Adobe `/p`）には一切影響しない。元 PDF に annotation が入ったまま byte-copy / 印刷される

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. read-only visual proxy（採用）** | ✅ | 「外部の指摘が見える」業務要件を満たしつつ、編集の真実源は overlay のみという 3-layer 分離を守る。抽出は rect+メタ情報だけなので位置精度リスクが小さい |
| B. annotation を editable overlay に変換して双方向編集 | ❌ | §2.4 禁止事項そのもの。K-PDF2 で 4 アプローチ全滅した「viewer 間 baseline / appearance 差異」の沼に戻る。編集した結果を書き戻せば PDF の真正性（immutable background 原則）も崩れる |
| C. 外部 annotation を無視（表示しない） | ❌ | 相手方・裁判所の指摘が見えず実務で見落とし事故になる。M6 前まではこの状態で、C3 として解消が予定されていた |
| D. mupdf の appearance stream をそのまま raster 描画 | ❌ | 「本物そっくり」に見えるほど編集できると誤解されやすい。種別が一目で「外部 annotation」と判別できる retro 風の意匠分岐の方が、編集不可であることが UI から伝わる |

**核心**: 編集可能にしない理由は技術的困難の回避だけではない。annotation を「外部との通信レイヤ」と定義し、K-PDF3 側の編集は overlay に一本化することで、**「どちらが真実源か」の曖昧さを構造的に排除**する。read-only proxy は 3-layer 分離の annotation 行をそのまま実装したもの。

## Consequences

### Positive

- 外部アプリの付箋・ハイライト・押印等が開いた瞬間に見える。視覚分岐 + tooltip で「誰が・何を」まで確認できる
- workspace スキーマ変更ゼロ・export / 印刷経路への影響ゼロ（純追加）
- per-tab キャッシュで再表示・zoom 変更が軽い

### Negative / trade-off

- **K-PDF3 から annotation へ返信・編集・削除はできない**。外部との annotation ベースの往復作業は Adobe 等で行う前提（非目標として意図的に受容）
- appearance stream を再現しないので、見た目は元アプリと同一ではない（rect ベースの意匠表示）。位置とタイプと内容が分かれば業務要件は満たすという割り切り
- annotation が更新された PDF は開き直し（タブ単位キャッシュのため、同一タブ内での外部変更は追従しない）

### 影響範囲（実装ポインタ）

- `src/backend/mupdf-annotations.js` — `extractAllAnnotations` / `extractPageAnnotationsFromDoc`、`PROXIED_TYPES`、`AnnotationRecord` typedef
- `src/main/main.js` — IPC `kpdf3:get-all-annotations`（TabHandle.annotations キャッシュ）
- `src/main/preload.cjs` — `getAllAnnotations` binding
- `src/domain/coord.js` — `pdfRectToCanonical`
- `src/renderer/viewer.js` — `setAnnotations` / `_renderPageAnnotations` / `_createAnnotationElement` / `_annotationTooltipText` / `_annotationMarkerGlyph`、`_annotations` は zoom / DOM 再構築を跨いで保持
- `src/renderer/renderer.js` — PDF 切替時に `setAnnotations(null)` → `kpdf3.getAllAnnotations()` を 1 回 fetch
- `src/renderer/style.css` — `.annotation-layer` ほか種別別スタイル

### 備考

- HANDOVER / CHANGELOG は「15 種別」と記すが、コード上の `PROXIED_TYPES` は 16 エントリ（上記列挙のとおり）。抽出対象の実態はコードが正
- 双方向編集を将来検討する場合は本 ADR の Why 表 B 案の却下理由（K-PDF2 の 4 アプローチ全滅）を先に再評価すること
