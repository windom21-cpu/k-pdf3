-- K-PDF3 workspace schema
-- File extension: .kpdf3
-- SQLite version: 3.38+ (R*Tree, FTS5 are required)
--
-- ADR: docs/adr/0001-workspace-sqlite.md
-- Schema version: 1.0.0

PRAGMA application_id = 0x4B504446;  -- "KPDF" magic number for `file` command
PRAGMA user_version = 1;             -- schema version (incremented per migration)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;         -- WAL mode で十分

-- ===================================================================
-- metadata: workspace 全体のメタ情報（key/value）
-- ===================================================================
CREATE TABLE metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ===================================================================
-- source_pdf: 元 PDF を bit-identical で BLOB 保管
-- 1 workspace = 1 source PDF
-- ===================================================================
CREATE TABLE source_pdf (
    id           INTEGER PRIMARY KEY CHECK(id = 1),  -- 単一行を保証
    file_name    TEXT NOT NULL,
    blob         BLOB NOT NULL,
    byte_size    INTEGER NOT NULL,
    page_count   INTEGER NOT NULL,
    fingerprint  TEXT NOT NULL,              -- file hash (SHA-256)
    imported_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================================================================
-- pages: 各ページの幾何情報（canonical 座標系の起点）
-- ===================================================================
CREATE TABLE pages (
    page_no   INTEGER PRIMARY KEY,
    -- mediabox（PDF native 座標、bottom-left origin、PDF point）
    media_x   REAL NOT NULL,
    media_y   REAL NOT NULL,
    media_w   REAL NOT NULL,
    media_h   REAL NOT NULL,
    -- cropbox（表示される領域）
    crop_x    REAL NOT NULL,
    crop_y    REAL NOT NULL,
    crop_w    REAL NOT NULL,
    crop_h    REAL NOT NULL,
    -- rotation: 0 / 90 / 180 / 270
    rotation  INTEGER NOT NULL DEFAULT 0 CHECK(rotation IN (0, 90, 180, 270)),
    -- ユーザーが追加した「論理的な回転」（紙アナロジー、export 時に PDF rotation に合成）
    user_rotation INTEGER NOT NULL DEFAULT 0 CHECK(user_rotation IN (0, 90, 180, 270)),
    -- ページ削除フラグ。ソース PDF はそのまま、workspace 単位で表示・書き出しから除外
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1))
);

-- ===================================================================
-- inserted_pages: 元 PDF にない、ユーザーが挿入した白紙ページ（任意のテキスト付き）
-- 元ページとは別管理。getPages() 時に after_page_no / order_in_slot で間に並ぶ
-- ===================================================================
CREATE TABLE inserted_pages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    after_page_no   INTEGER NOT NULL,    -- 0 = 全ページの先頭、N = 元ページ N の直後
    order_in_slot   INTEGER NOT NULL DEFAULT 0,
    text            TEXT,                -- 72pt で表示するテキスト（NULL/空 = 純粋な白紙）
    width           REAL NOT NULL DEFAULT 595,   -- A4 portrait, points
    height          REAL NOT NULL DEFAULT 842,
    user_rotation   INTEGER NOT NULL DEFAULT 0 CHECK(user_rotation IN (0, 90, 180, 270)),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inserted_pages_slot ON inserted_pages(after_page_no, order_in_slot);

-- ===================================================================
-- overlays: 編集可能な overlay object
-- 座標は canonical（PDF point 72dpi、top-left、rotation 適用後）
-- ===================================================================
CREATE TABLE overlays (
    id          TEXT PRIMARY KEY,                     -- UUID v4
    -- page_no は元 PDF ページ (正) または 挿入ページ id の負数。
    -- inserted_pages とのまたがり整合性は app 層で保証 (workspace).
    page_no     INTEGER NOT NULL,
    type        TEXT NOT NULL CHECK(type IN (
                    'text', 'stamp', 'image', 'redaction',
                    'line', 'rect', 'signature', 'page_number'
                )),
    -- canonical bbox（top-left origin）
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    w           REAL NOT NULL,
    h           REAL NOT NULL,
    z_order     INTEGER NOT NULL DEFAULT 0,
    -- type 固有のプロパティ（JSON）
    --   text:      { text, fontSize, fontId, color, lineHeight, ... }
    --   stamp:     { kind, text?, dateText?, color, frame, assetId?, fontSize? }
    --   redaction: { color, mode } -- mode: 'draft' | 'applied'
    --   etc.
    properties  TEXT NOT NULL,
    asset_id    TEXT REFERENCES assets(id),           -- 画像系の場合
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_overlays_page ON overlays(page_no, z_order);
CREATE INDEX idx_overlays_type ON overlays(type);

-- ===================================================================
-- overlays_spatial: R*Tree spatial index（hit-test 高速化）
-- ===================================================================
CREATE VIRTUAL TABLE overlays_spatial USING rtree(
    rowid,            -- 内部 rowid（overlay の rowid と一致させる）
    min_x, max_x,
    min_y, max_y
);
-- page_no を別 column で持って WHERE で絞ることも可能（R*Tree の aux column 機能、SQLite 3.24+）

-- ===================================================================
-- assets: 画像 asset（スタンプ画像・印影など）
-- 同一 hash は重複排除
-- ===================================================================
CREATE TABLE assets (
    id          TEXT PRIMARY KEY,                     -- UUID v4
    hash        TEXT NOT NULL UNIQUE,                 -- BLOB の SHA-256
    mime        TEXT NOT NULL,                        -- 'image/png', 'image/jpeg', ...
    blob        BLOB NOT NULL,
    width       INTEGER,                              -- pixel
    height      INTEGER,
    label       TEXT,                                 -- ユーザーが付ける名前
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================================================================
-- bookmarks: しおり（PDF /Outlines として export 可能）
-- ===================================================================
CREATE TABLE bookmarks (
    id          TEXT PRIMARY KEY,                     -- UUID v4
    parent_id   TEXT REFERENCES bookmarks(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    page_no     INTEGER NOT NULL REFERENCES pages(page_no),
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_bookmarks_parent ON bookmarks(parent_id, sort_order);

-- ===================================================================
-- exports: 配布版 PDF の監査ログ（メタデータのみ、ADR-0008）
-- 当初は bit-identical な PDF blob を保管していたが、容量肥大の問題
-- から ADR-0008 で blob 列を廃止。ハッシュ + サイズ + revision_id で
-- ユーザーが別名保存運用で残す現物との照合が可能。
-- ===================================================================
CREATE TABLE exports (
    id            TEXT PRIMARY KEY,                   -- UUID v4
    revision_id   TEXT NOT NULL UNIQUE,               -- PDF metadata に埋め込む ID
    timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
    output_hash   TEXT NOT NULL,                      -- output PDF の SHA-256
    output_size   INTEGER NOT NULL,
    note          TEXT,                               -- ユーザーが付ける説明（提出先・用途等）
    is_secure     INTEGER NOT NULL DEFAULT 0          -- secure export かどうか
);

CREATE INDEX idx_exports_timestamp ON exports(timestamp);

-- ===================================================================
-- history: undo/redo + 監査ログ（command pattern）
-- ===================================================================
CREATE TABLE history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
    command_type  TEXT NOT NULL,                      -- 'addOverlay', 'removeOverlay', 'updateOverlay', ...
    target_id     TEXT,                               -- overlay id 等
    forward_data  TEXT NOT NULL,                      -- JSON: 適用に必要なデータ
    inverse_data  TEXT NOT NULL,                      -- JSON: undo 用
    is_undone     INTEGER NOT NULL DEFAULT 0,         -- 1 なら undo されている（redo 候補）
    batch_id      TEXT                                -- 複数 command を 1 操作として束ねる
);

CREATE INDEX idx_history_timestamp ON history(timestamp);
CREATE INDEX idx_history_batch ON history(batch_id);

-- ===================================================================
-- settings: viewport / zoom / UI state
-- ===================================================================
CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

-- ===================================================================
-- overlay_fts: 全文検索（FTS5）
-- ===================================================================
CREATE VIRTUAL TABLE overlay_fts USING fts5(
    overlay_id UNINDEXED,
    page_no    UNINDEXED,
    content    -- 検索対象テキスト
);

-- ===================================================================
-- 初期メタデータ
-- ===================================================================
INSERT INTO metadata (key, value) VALUES
    ('schema_version', '1.0.0'),
    ('app_version',    '2.0.0'),
    ('created_at',     datetime('now'));

-- ===================================================================
-- 推奨 PRAGMA（runtime で再設定）
-- ===================================================================
-- PRAGMA wal_autocheckpoint = 1000;  -- 1000 pages ごとに checkpoint
-- PRAGMA cache_size = -64000;         -- 64MB cache
-- PRAGMA temp_store = MEMORY;
