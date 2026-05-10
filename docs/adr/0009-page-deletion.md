# ADR-0009: ページ削除（workspace-level page hide）

- 日付: 2026-05-10
- ステータス: 採用
- 関連: ADR-0007（workspace 集中保管）、ADR-0010（ページ挿入）、ADR-0011（Save As workspace 切替）、HANDOVER §7.6.1

## Context

法律実務では受け取った PDF の特定ページ（例：表紙、白紙、無関係な添付）を提出版から外したいことが頻出する。要件：

- 元 PDF のバイト列は **触らない**（K-PDF3 の 3-layer 分離 §2.2「PDF は truth ではない」を堅持）
- 削除はワークスペース単位の表示・書出制御
- 取り消しが容易（Ctrl+Z 一発）
- 同一ワークスペースを再度開いたとき、削除状態が復元される
- `coord.js` / overlay / `pages.page_no` の対応関係は壊さない（pageNo は元 PDF の番号で固定）

K-PDF2 は PDF 自体を再構築する方式だったが、3-layer 分離下では「ビュー上の隠蔽」と「export 出力からの除外」の両方を持つフラグで十分。

## Decision

### 1. `pages.is_deleted` フラグ

`pages` テーブルに `is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1))` を追加。元 PDF バイト列はそのまま、SQLite 行単位で hide / show する。

```sql
ALTER TABLE pages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0
  CHECK(is_deleted IN (0, 1));
```

旧 kpdf3 用の idempotent migration（`migratePagesIsDeleted`）を `openWorkspace` で実行。

### 2. pending workflow（renderer state）

renderer 側に `pendingDeletedPages: Set<pageNo>` を持つ。

- サムネ削除操作 → set に追加（DB 未反映）
- Ctrl+Z → set から取り出し（取り消し）
- Ctrl+S → 全要素を `kpdf3:set-page-deleted(pageNo, true)` で flush → set クリア
- 取り消しが overlay の undo と同一の Ctrl+Z で出来る
- ファイルを開きっぱなしで「やっぱり削除取り消し」が安全

挿入（ADR-0010）が即時永続化なのと対比的：削除は完全 reversible 操作で Ctrl+S までは pending、挿入は新規データ作成なので即時永続化（Ctrl+S 待ちで増えても hangup 感が出るだけ）。

### 3. `Workspace.getPages({ includeDeleted })` の二系統

既定では `is_deleted = 0` のみ返す。`includeDeleted: true` で全行返す。

| 用途 | 呼び出し | 理由 |
|---|---|---|
| viewer / sidebar / 印刷 / export | `getPages()` | 削除済を見せない |
| main `reopenActiveDoc().activePages` | `getPages({ includeDeleted: true })` | 削除直後でも古い `render-page` リクエストが解決できるよう保険 |

### 4. PageRegistry の sparse pageNo 対応

旧コードは `entries[pageNo - 1]` で配列インデックス＝ pageNo - 1 を仮定していた。削除でリストが歯抜けになるので：

- `pageNoToPos: Map<pageNo, pos>` を構築
- `pageNoAtPos(pos)` / `posOfPageNo(pageNo)` を公開
- `getCanonicalSize(pageNo)` は Map 経由で lookup
- viewer `scrollToPage` / scrollListener / `_buildLayout` も pos を介する形に書き換え

### 5. UI（renderer）

- サムネサイドバーに multi-select（click / shift-click / ctrl-click + drag）と Delete キー
- 選択範囲 → Delete → `pendingDeletedPages.add(pageNo)` → `markWorkspaceMutated()` → `refreshViewer()` で歯抜けに
- 削除予定のサムネは CSS で半透明 + 取消線

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. is_deleted フラグ + sparse pageNo（採用）** | ✅ | 元 PDF・page_no・overlay の対応を壊さない、reverse 容易 |
| B. pages 行を物理削除して page_no を詰める | ❌ | overlay の page_no FK がズレる、復元不能 |
| C. 別テーブル `deleted_pages` で外側に持つ | ❌ | JOIN が増えて読み出しが遅くなる、将来的に「削除予定の deleted_at」など属性を増やしにくい |
| D. PDF 自体を再構築 | ❌ | 3-layer 分離違反（§2.2） |

pending workflow を入れた理由：DB 即時反映だと「うっかり削除 → Ctrl+Z で戻したい」が IPC round-trip + workspace 再オープンになって遅い。renderer state の Set なら同期的に取り消せる。

## Consequences

### 受け入れる trade-off

#### 1. すべての pageNo 走査ループが pos / pageNo を区別する必要がある

viewer / page-registry / exporter / search の合計 5 箇所程度で「ページ番号は元 PDF のもの」「位置は visible リストの index」を意識する必要が出た。バグの温床になりうるが、`pageNoAtPos` / `posOfPageNo` を必ず経由する規律で吸収。

#### 2. main の activePages と renderer の view の不整合期間

`set-page-deleted` flush 直後、main 側の `activePages` を `reopenActiveDoc()` で更新するが、その間に renderer から古い pageNo で `render-page` が来うる。`includeDeleted: true` で main 側に全行を持たせて吸収する。

#### 3. byte-copy Save As 条件への追加制約

ADR-0008 の「overlay 0 件なら byte-copy」だけでは不十分になり、削除も挿入も無いことが byte-copy の必要条件に追加される。これは ADR-0011 で正式化。

### 影響範囲

- `schema/schema.sql`: `pages.is_deleted` 列追加
- `src/backend/sqlite-store.js`: `migratePagesIsDeleted`、`setPageDeleted`、`getAllPages` が `is_deleted` 返却
- `src/domain/workspace.js`: `getPages({ includeDeleted })`、`setPageDeleted`
- `src/domain/page-registry.js`: `pageNoToPos` Map、`pageNoAtPos`、`posOfPageNo`、`getCanonicalSize` 書き換え
- `src/main/main.js`: `kpdf3:set-page-deleted` IPC、`reopenActiveDoc` で `includeDeleted: true`
- `src/main/preload.cjs`: `setPageDeleted`
- `src/renderer/viewer.js`: 全 pos / pageNo 計算の sparse 化
- `src/renderer/renderer.js`: `pendingDeletedPages` Set、サムネ multi-select、Delete キー、Ctrl+S flush

### 解除条件

将来 PDF 自体の再構築（page reorder / merge）を実装する段階で、`is_deleted` フラグは「この pageNo はソース PDF の page X だが、X は出力に含めない」というセマンティクスのままでよい。再構築は別 ADR で page_no の再採番ポリシーを規定する。

## 検証

- 380 テストは継続 pass（既存 page-registry テストは pageNo 連番だけのケースをカバー、sparse ケースは未追加 — §15.6 リファクタ候補）
- 手動：
  - 5 ページ PDF を開く → ページ 2-3 を Delete → サムネ 2-3 が薄くなる、ビューアからも消える
  - Ctrl+Z → 戻る、Ctrl+S → DB 反映、ファイルを閉じて再開 → 2-3 が消えた状態
  - 削除状態で Save As → ADR-0011 により rasterize ルート → 出力 PDF は 3 ページ
