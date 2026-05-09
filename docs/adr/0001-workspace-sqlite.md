# ADR-0001: Workspace を SQLite 単一ファイルで保存する

- 日付: 2026-05-09
- ステータス: 採用

## Context

K-PDF3 の workspace 保存形式を決める必要がある。法律実務での真正性・耐障害性が最優先非機能要件。

検討した選択肢：

| 形式 | 信頼性 | 単一ファイル性 | atomic save | クラウド同期 | 復旧容易性 |
|---|---|---|---|---|---|
| ZIP コンテナ | 中（壊れやすい）| ◎ | △ | △ | ✗（バイナリ） |
| sidecar JSON + PDF | ◎ | ✗（複数ファイル） | ◎ | ◎ | ◎（テキスト） |
| フォルダ形式 | ◎ | △（macOS bundle 風） | ◎ | ✗ | ◎ |
| **SQLite 単一 DB** | ◎ | ◎ | ◎（WAL） | ◎ | ○（SQL で検査） |
| PDF attachment | 中 | ◎ | △ | ◎ | △ |

## Decision

**SQLite を採用する**。

ファイル拡張子は `.kpdf3`。

## Rationale

- **WAL モード**で write-ahead logging → crash 復元が自動
- **transaction** で atomic commit → 編集中 crash でも整合性維持
- **R*Tree 拡張**（spatial index）→ overlay の hit-test を SQL で高速化
- **FTS5 拡張**（全文検索）→ overlay text 検索を SQL で実装可能
- **単一ファイル** → メール添付・Drive 同期・USB 持ち運び OK
- **better-sqlite3**（Node.js）で同期 API、Electron 統合容易
- **schema migration** が成熟（pragma + 手動 migration で十分）
- **append-only journal を自前実装する必要がない**（WAL が代替）

## 構造

```sql
-- 詳細は schema/schema.sql 参照

table metadata        -- key/value（schema_version, created_at, source_fingerprint, ...）
table source_pdf      -- 元 PDF を BLOB で bit-identical 保管
table pages           -- 各ページの mediabox / cropbox / rotation
table overlays        -- overlay object（canonical 座標）
table assets          -- 画像 asset
table bookmarks       -- しおり
table exports         -- 配布版 PDF を BLOB で履歴保管
table history         -- undo/redo + 監査ログ（command pattern）
table settings        -- viewport / zoom 等の UI state
```

加えて：
- `overlays_spatial` (R*Tree virtual table) — spatial index
- `overlay_fts` (FTS5 virtual table) — 全文検索

## Consequences

### Positive
- 法律実務の真正性要件（提出版の bit-identical 復元）を `exports` テーブル BLOB で実現
- 単一ファイルなので運用がシンプル
- crash 耐性が built-in
- 将来の検索・index 機能が SQL で素直に実装可能

### Negative
- **better-sqlite3 がネイティブモジュール** → 各 OS でビルドが必要（electron-rebuild + GitHub Actions matrix）
- 配布バイナリ +2〜3MB
- **WAL ファイル**（`.kpdf3-wal` / `.kpdf3-shm`）が一時的に生成される
  - クラウド同期時は close 前に WAL checkpoint を強制する必要
  - .gitignore で除外する
- bit-identical 保管のため source PDF サイズがそのまま workspace サイズに加算される

### Neutral
- AGPL ではない（Public Domain ライセンス相当）

## Alternatives Considered

- **ZIP コンテナ**: 単純だが crash で壊れやすく、復旧が困難。法律実務には不向き。
- **sidecar JSON + PDF**: シンプルで信頼性高いが、ファイル数が増えてユーザー運用が複雑化。移動時にバラバラに飛ぶリスク。
- **フォルダ形式**: macOS bundle 風で macOS では自然だが、Windows での扱いが不自然。
- **PDF attachment**: 旧 K-PDF2 の edits.json 方式の発展。攻撃面が広く、他ビューアで保存されると消失するリスクが残る。

## References

- HANDOVER.md（K-PDF2）の「【最重要・更新】2026-05-09 後半」セクション
- ROADMAP.md M1 / M2
- `schema/schema.sql`
