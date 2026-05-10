# ADR-0014: 編集可能なしおり（workspace bookmarks）

- 日付: 2026-05-10
- ステータス: 採用（MVP のみ実装、/Outlines write-back は後送り）
- 関連: ADR-0006（PDF-first UX）、ADR-0009（page deletion）、HANDOVER §17.14、§7.6 のサイドバー仕様

## Context

M5 で実装したサイドバー「しおり」は **PDF /Outlines の read-only 表示** だけ。法律実務では：

- 受け取った PDF にしおりが無い / 不十分なケースが多く、自分で目次を作りたい
- 「証拠 1 章」「主張 2 段落」など独自タグで navigation したい
- 既存の /Outlines を上書きするのではなく、**workspace 単位で追加・編集** できれば PDF の真正性を損なわない

K-PDF3 の 3-layer 分離（§2.2 / ADR-0006）に従い、PDF を変更せず workspace に編集情報を持つ方針が要件と整合する。

スキーマには M1 から `bookmarks` テーブルが用意されていた（id / parent_id / title / page_no / sort_order）。M6 でこれを使う段。

## Decision

### 1. workspace 側 bookmarks が /Outlines を上書きする（**置換ではなく override**）

renderer 側のサイドバーロジック：

```js
const ws = await kpdf3.listBookmarks();
if (ws.length > 0) {
  // workspace 側を表示。「(編集可能)」ラベル + +/− ボタン + 双クリックリネーム
} else {
  // /Outlines を表示。「(元 PDF / 編集不可)」ラベル
}
```

- workspace に **1 件でも** あれば workspace 側のリストだけを見せる
- workspace を空にすれば /Outlines にフォールバック
- ユーザーから見ると「編集モードに入る」 = 「+ ボタンを 1 回押す」

これで「/Outlines を消して書き直す」「PDF 改変ライセンスはどうする」みたいな話を回避。

### 2. スキーマ（既存テーブル + FK 削除 migration）

既存：

```sql
CREATE TABLE bookmarks (
    id          TEXT PRIMARY KEY,
    parent_id   TEXT REFERENCES bookmarks(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    page_no     INTEGER NOT NULL REFERENCES pages(page_no),
    sort_order  INTEGER NOT NULL DEFAULT 0
);
```

問題：`page_no` の `REFERENCES pages(page_no)` FK が **挿入ページ（synthetic、negative pageNo）への bookmark を拒絶** する。overlays でも同じ問題があり ADR と並列で migrateOverlaysDropPageFk として直した（§7.6）。bookmarks も同じ recipe で FK を落とす。

`migrateBookmarksDropPageFk(db)`：
1. `pragma foreign_key_list(bookmarks)` で `pages` への FK の有無を確認
2. あれば `bookmarks_new` を FK なしで作成 → INSERT SELECT → DROP/RENAME → 索引再作成
3. transaction + foreign_keys = OFF で囲んで安全に

### 3. CRUD

backend `sqlite-store.js`：
- `listBookmarks(db)` — flat list、`sort_order, rowid` で並べる
- `addBookmark(db, {id, title, pageNo})` — `MAX(sort_order) + 1` で末尾に追加
- `renameBookmark(db, id, title)` — UPDATE
- `removeBookmark(db, id)` — DELETE（CASCADE で子も消える）

domain `Workspace`：上記の薄いラッパー 4 本。

main IPC：`kpdf3:list-bookmarks` / `add-bookmark` / `rename-bookmark` / `remove-bookmark`。

renderer：
- `+` ボタン → 現在ページに「ページ N」しおりを追加（id は `crypto.randomUUID()`）
- 行の双クリック → input に置換、Enter で commit / Escape で取り消し
- 選択中の行 + `−` ボタン → 削除
- 元 PDF /Outlines はサブ表示「(編集不可)」、workspace 1 件以上で hide

### 4. nested children / drag-reorder は MVP 外

スキーマには `parent_id` を持つので将来の nesting には対応可能。drag-reorder も `sort_order` で実現できる。MVP では**フラット**なリスト + 末尾追加のみ。

### 5. /Outlines への export 時 write-back は本 ADR の範囲外

ユーザー要件 §17.14 は「export 時に PDF /Outlines として出力」も含むが、これは：

- mupdf js の出力経路に /Outlines を仕込む API が必要（現状の export-pdf-rasterized では未対応）
- pdf-lib への切替 / mupdf 側の追加 API 調査が必要
- レイアウト調整中に「/Outlines が壊れた書き出しになる」リスク

を含むため、**MVP 完了後に独立した変更**として扱う。本 ADR は「workspace 側で読み書きできる」ところまで。export パスは後続 ADR（仮 0014b or 0019）で詳細化。

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. 1 件でもあれば workspace 側を表示（採用）** | ✅ | 「編集モード」の概念が要らない、UX 単純、ファイル間で挙動 一貫 |
| B. /Outlines + workspace を併合表示 | ❌ | 同名・同ページ衝突をどう統合するか議論が必要、MVP 範囲拡大 |
| C. PDF /Outlines を workspace の初期データに seed | ❌ | seed 済かどうかフラグ管理が必要、ユーザー操作と区別しにくい |
| D. 既存 /Outlines を直接 PDF に書き戻す | ❌ | 3-layer 分離違反、PDF を改変する |

### スキーマ拡張ではなく既存 `bookmarks` テーブル

- M1 から既に予約されていた → 新規テーブル不要
- FK は削除する必要があるが、これは overlays と同じ ADR-0009 系列の問題で先例あり

## Consequences

### 受け入れる trade-off

#### 1. /Outlines write-back が後送り

ユーザー視点：「workspace 内では編集できるが、export した PDF を別 PDF アプリで開いてもしおりが見えない」状態。実用上は：

- K-PDF3 内で navigation するなら問題なし
- 配布版に /Outlines を含めたいなら別ステップ（pdf-lib 等で post-process）が必要

ADR が分かれていれば、いつ・どう着手するかを別途議論できる。

#### 2. 元 PDF /Outlines が無視される瞬間

workspace に 1 件追加した瞬間、サイドバーから /Outlines 表示が消える。ユーザーが「あれ？元のしおりはどこ？」となる可能性。

**緩和**：UI に「(元 PDF / 編集不可)」「(編集可能)」のラベルを出して状態を可視化。workspace 全削除で /Outlines 復帰することは説明文で覚えてもらう（後日マニュアル追加候補）。

#### 3. nested 構造を持てない

法律実務文書は概ねフラットな目次で十分（章番号で実質階層）。nesting は後からスキーマ拡張なし（parent_id 既存）で追加可能。

### 影響範囲

- `schema/schema.sql`: bookmarks.page_no の FK 削除（comment 追加）
- `src/backend/sqlite-store.js`: `migrateBookmarksDropPageFk`、`listBookmarks` / `addBookmark` / `renameBookmark` / `removeBookmark`
- `src/domain/workspace.js`: 上記 4 メソッドの薄いラッパー
- `src/main/main.js`: `kpdf3:list-bookmarks` / `add-bookmark` / `rename-bookmark` / `remove-bookmark` IPC
- `src/main/preload.cjs`: matching bindings
- `src/renderer/index.html`: `bookmark-toolbar` (+ / −) と source label を追加
- `src/renderer/style.css`: workspace bookmark 専用スタイル（is-workspace / is-selected / page-tag / rename-input）
- `src/renderer/renderer.js`: `refreshBookmarks` の workspace / outline 分岐、`createWorkspaceBookmarkNode`、`startInlineRenameBookmark`、`actionAddBookmark` / `actionRemoveBookmark`

### 解除条件 / 後続 ADR

- **/Outlines write-back を実装する時** → 後続 ADR（仮 0019）。export-pdf-rasterized が flatten PDF を出した後、pdf-lib 等で /Outlines を書き加える pipeline を確立
- **nested children を有効化する時** → 本 ADR を改訂（schema は既存）か、別 ADR
- **/Outlines + workspace 併合表示** にしたい要件が出たら別 ADR

## 検証

- 380 テスト継続 pass
- 手動：
  - 元 /Outlines を持つ PDF を開く → サイドバーに /Outlines 表示、+ ボタン enabled、− は disabled
  - + を押す → 「ページ N」が追加される、サイドバーが workspace モードに切替（/Outlines 消える）
  - 行を双クリック → input に変わる、別タイトルを入力 → Enter → 保存
  - 行を選択 → − ボタンで削除
  - workspace 全削除 → /Outlines 表示に復帰
  - 削除→挿入を繰り返してから bookmarks を追加 → 既存 /Outlines のあるなしに関わらず動く
  - 挿入ページに bookmark を追加（pageNo < 0）→ FK 削除 migration が効いていることを確認
