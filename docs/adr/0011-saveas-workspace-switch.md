# ADR-0011: Save As で active workspace を新ファイルへ自動切替

- 日付: 2026-05-10
- ステータス: 採用
- 関連: ADR-0007（fingerprint 索引）、ADR-0008（Smart Save As / byte-copy）、ADR-0009（ページ削除）、ADR-0010（ページ挿入）、HANDOVER §7.6.4

## Context

Word / Excel の Save As セマンティクス：「`A.docx` を開いている状態で Save As で `B.docx` 保存 → 以降は `B.docx` を編集している状態」。ユーザーは「`B` を保存したつもりが `A` を上書きした」事故を避けるためにこの挙動を期待する。

K-PDF3 の旧実装（M4 期）は Save As しても **元の `.kpdf3` ワークスペースを開いたまま**だった：

- `001.pdf` を開く → 編集 → Save As `008.pdf` で書き出し → ビューには `001` が表示されたまま
- ここで Ctrl+S すると `001.pdf` 由来の workspace が更新される（`008.pdf` ではない）
- ユーザーから見ると「`008` を保存しているつもり」で `001` を変更してしまうリスク

ADR-0008 の Smart Save As 導入で「overlay 0 件なら byte-copy」になったが、ADR-0009（削除）/ ADR-0010（挿入）で workspace mutation の判定軸が増えた：

- byte-copy 条件：overlay 0 件 **かつ** 削除（pending + persisted）0 件 **かつ** 挿入 0 件
- 1 つでも当てはまれば rasterize export

## Decision

### 1. Save As 直後の workspace 切替

`actionExport()` の出力完了直後：

```js
await kpdf3.closeWorkspace();
const opened = await kpdf3.openPdfFile(savePath);
projectStore.reset(opened.overlays ?? []);
pendingDeletedPages.clear();
workspaceMutated = false;
thumbSelection.pageNos.clear();
history.clear();
await refreshViewer();
```

挙動：
- byte-copy 経路：`savePath` の fingerprint = 元 PDF の fingerprint なので、ADR-0007 の `workspace-registry` は **既存 workspace を再利用**（同一 .kpdf3 を再オープンするのと等価）。実害なし
- rasterize 経路：新しい `.kpdf3` が ADR-0007 の userData に作成され、それが active になる
- どちらの経路でも、ユーザーから見ると「Save As した `008.pdf` を編集している状態」に切り替わる

### 2. byte-copy 検出の三条件

`actionExport()` 内で：

```js
const overlayCount    = projectStore.count();
const hasInsertions   = pages.some((p) => p.isSynthetic || p.pageNo < 0);
const sourcePagesCount = pages.filter((p) => !p.isSynthetic && p.pageNo > 0).length;
const hasDeletions    = pendingDeletedPages.size > 0
                        || (meta && sourcePagesCount < (meta.pageCount ?? sourcePagesCount));
const isCopy          = overlayCount === 0 && !hasDeletions && !hasInsertions;
```

`hasDeletions` の OR は 2 系統：

1. `pendingDeletedPages.size > 0` — Ctrl+S 前の renderer state
2. `sourcePagesCount < meta.pageCount` — 既に flush 済みの persisted 削除

この 2 つを両方見ないと、「削除して Ctrl+S 済 → そのまま Save As」が byte-copy になってしまう（元 PDF の全ページが出てしまう）。

### 3. ステータスバー表示

`isCopy ? "コピー" : "書き出し"` を `verb` として、進捗・完了メッセージで使い分け：

- `元 PDF をコピー中...` → `... に切り替えました（コピー, rev xxxxxxxx）`
- `N / M ページを描画中...` → `... に切り替えました（書き出し, rev xxxxxxxx）`

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. 自動切替（Word/Excel 流、採用）** | ✅ | 多くのユーザーが暗黙に期待する挙動、誤上書きリスク低減 |
| B. 切替せず元 workspace を保持（旧実装） | ❌ | 上記事故、Ctrl+S が紛らわしい |
| C. 確認ダイアログ「切り替えますか？」 | ❌ | 1 ステップ余計、Word/Excel と挙動不一致 |
| D. 「Save As」を「Save Copy」に分離 | ❌ | Word の Save As に慣れたユーザーには直感に反する、UI 増加 |

## Consequences

### 受け入れる trade-off

#### 1. byte-copy 条件が 3 軸に増えた

ADR-0008 では「overlay 0 件」だけだったが、ADR-0009 / ADR-0010 で 2 軸増えた。条件式が複雑化したので、将来の機能追加（ページ並び替え等）でこの条件が古びるリスクがある。新しい mutation を導入するときは必ずこの条件式を見直す（コード内コメントで明示）。

#### 2. byte-copy で workspace 再利用 = 監査ログが「同一 workspace 内」に積まれる

ADR-0007 で fingerprint = SHA-256 が同じ kpdf3 は再利用される。byte-copy Save As で再利用された場合、その workspace の `exports` テーブルには「Save As で出した revision」が追加される。これは記録が一箇所に集まる利点でもあり、「`008.pdf` 専用の workspace」が独立しないという欠点でもある。後者は法律実務上問題になっていないので採用。

#### 3. 切替直後の状態リセット

切替直後に：
- `projectStore.reset(opened.overlays)` — 新ファイルの overlay
- `pendingDeletedPages.clear()` — 削除キャンセル
- `workspaceMutated = false`
- `thumbSelection.clear()` — UI 状態
- `history.clear()` — 旧ファイルの undo は不可

「あ、間違えた、戻したい」が出来なくなる。これは Save As の Word 流セマンティクスとして許容（元ファイルは保存済みなので普通に開き直せばよい）。

### 影響範囲

- `src/renderer/renderer.js`: `actionExport` の最後にワークスペース切替 + 状態リセット
- `src/main/main.js`: `kpdf3:get-source-meta` で `activeSourcePdfPath` の basename を上書き返却（切替後にすぐに正しいファイル名が表示されるよう）

main process 側は ADR-0007 の `workspace-registry` がそのまま活きる：fingerprint で既存を再利用するか新規を作るかを判断するロジックは変更不要。

### 解除条件

- 「Save As 後も元 workspace の編集を続けたい」要件が出た場合 → 「Save Copy」（切替なし）コマンドを別途追加。本 ADR は変更不要、既存 Save As は Word 流のまま

## 検証

- 380 テストは継続 pass
- 手動：
  - 単純 Save As：`A.pdf` を開く → 編集なし → Save As `B.pdf` → タイトルバーが `B.pdf` に → byte-copy なので `cmp A.pdf B.pdf` で一致
  - 編集付き Save As：overlay 追加 → Save As `B.pdf` → flatten 版が `B.pdf` に、ビューも `B.pdf` の workspace に切替
  - 削除 + Save As：ページ 2 削除 → Ctrl+S → Save As `B.pdf` → rasterize 経路、`B.pdf` は元の N - 1 ページ
  - 挿入 + Save As：白紙挿入 → Save As `B.pdf` → rasterize 経路
