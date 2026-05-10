# ADR-0010: ページ挿入（白紙 / テキスト付き）

- 日付: 2026-05-10
- ステータス: 採用
- 関連: ADR-0009（ページ削除）、ADR-0011（Save As workspace 切替）、HANDOVER §7.6.2

## Context

法律実務での頻出操作：

- 提出版の前に「契約書 in lieu の表紙」を 1 枚足したい
- 章間に「**第 1 部 / 第 2 部**」と書いた区切りページを挟みたい
- 純粋な白紙ページを挟みたい（書類の体裁上）

要件：

- 元 PDF のバイト列は **触らない**（§2.2 PDF is not truth）
- 挿入位置は元 PDF の任意のページの **直前 / 直後**、または全先頭
- 同じスロットに複数枚連続で挿入できる
- ページ番号体系（`pages.page_no` / overlay の `page_no` FK）は壊さない
- 挿入ページにも 72 pt フォントでテキストを描ける（章タイトルが主用途）
- 再オープンで挿入状態が完全復元

ADR-0009 の sparse pageNo インフラ（PageRegistry の `pageNoToPos`）が前提。

## Decision

### 1. 専用テーブル `inserted_pages`

元 PDF 由来の `pages` とは別管理：

```sql
CREATE TABLE inserted_pages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    after_page_no   INTEGER NOT NULL,    -- 0 = 全ページの先頭、N = 元 PDF の page N の直後
    order_in_slot   INTEGER NOT NULL DEFAULT 0,
    text            TEXT,                -- NULL/空 = 純粋な白紙、それ以外 = 72pt で描画
    width           REAL NOT NULL DEFAULT 595,   -- A4 portrait, points
    height          REAL NOT NULL DEFAULT 842,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inserted_pages_slot ON inserted_pages(after_page_no, order_in_slot);
```

`order_in_slot` は同じ `after_page_no` への複数挿入の順序付け。`addInsertedPage` 時に `MAX(order_in_slot) + 1` で採番。

旧 kpdf3 用の idempotent migration（`migrateInsertedPagesTable`）を `openWorkspace` で実行。

### 2. negative pageNo namespace

挿入ページは「元 PDF にない仮想ページ」なので、`pages.page_no` と同じ namespace を共有させない：

- 挿入ページの `pageNo = -id`（常に負）
- `Workspace.addInsertedPage()` は新規 `id` の負数を返す
- `Workspace.removeInsertedPage(syntheticPageNo)` は `syntheticPageNo >= 0` で no-op（防衛的）

これにより：
- 1 行のループで挿入と元ページを同列に扱える（pageNo の符号で識別）
- 既存の overlay は `page_no > 0` の正の整数なので衝突しない
- IPC 越しの `render-page(pageNo)` は負数を見たら `synthetic` ルートへ分岐

### 3. ドキュメント順マージ — `Workspace.getPages()` 内で実施

```
out = []
flushSlot(0)             // before page 1
for p in sourcePages:
  if includeDeleted or not p.isDeleted: out.push(p)
  flushSlot(p.pageNo)
return out
```

`flushSlot(N)` は `inserted_pages WHERE after_page_no = N ORDER BY order_in_slot, id` を `out` に追加。挿入ページの行は `cropW` / `cropH` / `mediaW` / `mediaH` を `width` / `height` から、`rotation` / `userRotation` を 0、`syntheticText` / `syntheticId` / `isSynthetic: true` を埋めて返す。

### 4. synthetic page rendering — renderer-side canvas

main process は mupdf しか持たないので合成テキスト描画ができない。代わりに renderer 側の Canvas API で完結：

- `viewer.renderSyntheticPagePixels(row, zoom)` : `cropW × cropH` の白い canvas に 72 pt テキストを描いて `ImageData` を返す
- `viewer.renderPage` 内で `pageNo < 0` なら `renderSyntheticPagePixels` 経由
- `exporter.composePagesForExport` / `composeSinglePageCanvas` は `renderSyntheticPage` callback を受ける（main の `kpdf3.renderPage` と同じ shape を返す）

main の `kpdf3:render-page` IPC は負の pageNo に対して明示的に `throw`（renderer 側でハンドルすべき）。

### 5. 即時 DB 永続化（ADR-0009 と対称的）

挿入は `addInsertedPage` IPC で同期書き込み。理由：

- 削除と違い「うっかり挿入」はそれほど起きない（明示的に挿入ダイアログを開く操作）
- pending 化すると DB の `inserted_pages.id` の番号 = synthetic pageNo を後から再採番する複雑度
- workspace を閉じる前に保存忘れ → 挿入消失、を避ける

ただし dirty workflow との整合のため `workspaceMutated` フラグ（renderer state）を立てて Ctrl+S / 閉じ警告の対象にする（純粋に overlay 編集だけが dirty ではないことを示す）。

### 6. UI（renderer）

- サムネ間の細い水平 gap がクリッカブル（`makeInsertGap`）
- クリック → `showInsertDialog` → 「白紙」ラジオ or 「テキスト付き」ラジオ → 確定で `addInsertedPage` IPC → サムネ + viewer 再構築
- `kpdf3.removeInsertedPage(syntheticPageNo)` は ADR-0009 の削除フローと統合（負の pageNo は別エンドポイント）

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. 専用テーブル + negative pageNo（採用）** | ✅ | 既存 `pages` / overlay と完全に独立、衝突なし、後から拡張しやすい |
| B. `pages` テーブルに `is_inserted` 行を増やす | ❌ | `page_no` の連続性（元 PDF の物理ページ番号）が壊れる、overlay の page_no FK の意味が破綻 |
| C. PDF 自体に新規ページを書き込む（mupdf） | ❌ | §2.2 違反。元 PDF を変更してしまう |
| D. 仮想ページではなく overlay の集合体（白塗り四角 + テキスト）を新ページ扱い | ❌ | 1 ページが overlay 列のメタなページ扱いになり viewer / exporter の場合分けが混乱 |

negative pageNo を選んだのは「元 PDF の `page_no` は常に正、合成は常に負」のシンプルなルールで分岐できるため。`isSynthetic: true` フィールドも併用するが、コアの分岐は符号 1 つで足りる。

## Consequences

### 受け入れる trade-off

#### 1. 削除と挿入の workflow 非対称

削除は pending（renderer state）、挿入は即時永続化。コードの規律としては `pendingDeletedPages` と `inserted_pages` テーブルの 2 系統を覚える必要がある。一貫させるなら挿入も pending にできるが、temp pageNo 採番ロジックが複雑（§15.6 リファクタ候補参照）。当面は実用性優先。

#### 2. 全 IPC / 全 module が「pageNo は負か」を意識する必要

- `render-page` で main 側は負を reject
- `composePagesForExport` / `compositePage` で synthetic 経路を分岐
- viewer の `pageEls` Map は `Number` キーなので符号は問題ない

#### 3. synthetic page の解像度・フォントは renderer 環境依存

`MS UI Gothic` がない環境では fallback chain で代替。export 時の文字レンダリングも renderer の Canvas API に依存（main の mupdf 経由ではない）。テキストレイヤは持たない（ラスタ化されたテキスト）。

### 影響範囲

- `schema/schema.sql`: `inserted_pages` テーブル + index
- `src/backend/sqlite-store.js`: `migrateInsertedPagesTable`、`listInsertedPages`、`addInsertedPage`、`removeInsertedPage`
- `src/domain/workspace.js`: `getPages` の merge ロジック、`addInsertedPage`、`removeInsertedPage`
- `src/main/main.js`: `kpdf3:add-inserted-page` / `remove-inserted-page` IPC、`render-page` の負 pageNo reject
- `src/main/preload.cjs`: `addInsertedPage` / `removeInsertedPage`
- `src/renderer/viewer.js`: `renderSyntheticPagePixels`、`renderPage` の負 pageNo 分岐
- `src/renderer/exporter.js`: `renderSyntheticPage` callback、`compositePage` の `zoom` 引数化
- `src/renderer/renderer.js`: `makeInsertGap` / `showInsertDialog` / `promptAndInsertBlank`、`workspaceMutated` flag

### 解除条件

- フォントレンダリング品質を mupdf 側で揃えたくなった場合 → main 側で synthetic page 専用の Pixmap 生成 API を追加（ただし mupdf の text shaping は CJK fallback が貧弱、現状の renderer canvas が現実解）
- iPad 双方向のような外部互換が要件化したら、synthetic page を実 PDF ページ（mupdf で組成）に変換する flatten パスが必要 → 別 ADR

## 検証

- 380 テストは継続 pass（synthetic page の round-trip テストは未追加 — §15.6）
- 手動：
  - 3 ページ PDF を開く → ページ 1 と 2 の間の gap をクリック → 「第 1 部」テキストで挿入 → サムネ 4 枚に
  - 再オープン → 4 枚で復元
  - 同じ slot にもう 1 枚挿入 → `order_in_slot = 1` で 5 枚目位置
  - viewer の挿入ページが 72 pt で正しくレンダリングされる
  - 削除と組み合わせ：ページ 2 を削除 → サムネ {1, 第1部, 3} で表示
  - Save As: 削除＋挿入があると ADR-0011 により rasterize ルート、byte-copy にはならない
