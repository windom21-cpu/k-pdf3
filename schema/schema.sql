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
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
    -- ユーザーが並び替えた表示順（サムネ D&D で更新）。NULL のとき page_no が初期値。
    display_order REAL
);

-- ===================================================================
-- inserted_pages: 元 PDF にない、ユーザーが挿入した白紙ページ（任意のテキスト付き）
-- after_page_no + order_in_slot は新規挿入時のスロット情報。display_order
-- は元ページと共通の正規順序キーで、サムネ D&D による並び替えで更新される。
-- ===================================================================
CREATE TABLE inserted_pages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    after_page_no   INTEGER NOT NULL,    -- 0 = 全ページの先頭、N = 元ページ N の直後
    order_in_slot   INTEGER NOT NULL DEFAULT 0,
    text            TEXT,                -- 72pt で表示するテキスト（NULL/空 = 純粋な白紙）
    width           REAL NOT NULL DEFAULT 595,   -- A4 portrait, points
    height          REAL NOT NULL DEFAULT 842,
    user_rotation   INTEGER NOT NULL DEFAULT 0 CHECK(user_rotation IN (0, 90, 180, 270)),
    -- image_blob は外部 PDF 取り込みの場合に PNG バイト列を保持（viewer
    -- 用プレビュー）。NULL の行は純粋な白紙 / テキスト挿入。image_w/h は
    -- PNG のピクセル寸法（width/height は PDF point 単位の表示寸法）。
    image_blob      BLOB,
    image_w         INTEGER,
    image_h         INTEGER,
    -- β31: 外部 PDF を vector のまま inserted_source_pdfs に dedup 保存し、
    -- 書き出し/印刷時は image_blob ではなく元 PDF を copyPages して vector
    -- 維持。source_pdf_id NULL = β30 以前に挿入した image-only ページ
    -- （後方互換、export 時は image_blob にフォールバック）。
    source_pdf_id     INTEGER REFERENCES inserted_source_pdfs(id),
    source_page_index INTEGER,
    -- 元ページと共通の正規順序キー。NULL のときは after_page_no/order_in_slot
    -- に基づくスロット位置を使う（後方互換）。並び替え後は INTEGER で詰まる。
    display_order   REAL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inserted_pages_slot ON inserted_pages(after_page_no, order_in_slot);

-- ===================================================================
-- inserted_source_pdfs (β31): 外部 PDF を挿入した時に元の PDF バイト列を
-- vector のまま保持。SHA-256 で dedup（複数ページを同じ PDF から挿入し
-- ても 1 行のみ）。書き出し / 印刷時は inserted_pages.source_pdf_id 経由で
-- この blob を取り出し、pdf-lib copyPages で vector のまま貼る。
-- ===================================================================
CREATE TABLE inserted_source_pdfs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256      TEXT NOT NULL UNIQUE,
    pdf_blob    BLOB NOT NULL,
    byte_size   INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

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
                    'line', 'rect', 'signature', 'page_number',
                    'form_field'
                )),
    -- canonical bbox（top-left origin）
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    w           REAL NOT NULL,
    h           REAL NOT NULL,
    z_order     INTEGER NOT NULL DEFAULT 0,
    -- type 固有のプロパティ（JSON）
    --   text:       { text, fontSize, fontId, color, lineHeight, ... }
    --   stamp:      { kind, text?, dateText?, color, frame, assetId?, fontSize? }
    --   redaction:  { color, mode } -- mode: 'draft' | 'applied'
    --   form_field: { fieldKind, value, fontFace?, fontSize?, color?,
    --                 checkStyle?, tabIndex?, radioGroupId? } -- β.80+
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
-- ===================================================================
-- stamp_presets: ユーザー登録のスタンプテンプレート（ADR-0019 MVP）
-- 日付 / テキスト / 画像の 3 種類。登録時に色・枠・サイズ等を確定し
-- toolbar の stamp template select から呼び出して配置する。
-- ===================================================================
CREATE TABLE stamp_presets (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('date', 'text', 'image')),
    label       TEXT NOT NULL,                  -- ユーザー視点の名前
    color       TEXT NOT NULL DEFAULT '#cc0000',
    frame       TEXT NOT NULL DEFAULT 'rect' CHECK (frame IN ('circle', 'rect', 'none')),
    font_size   INTEGER NOT NULL DEFAULT 13,
    -- date kind: 形式キー (date-numeric-dash / date-numeric-fw / date-kanji-dash)
    -- text kind: リテラル文字列
    -- image kind: NULL
    text        TEXT,
    asset_id    TEXT REFERENCES assets(id) ON DELETE SET NULL,
    width       INTEGER NOT NULL DEFAULT 80,
    height      INTEGER NOT NULL DEFAULT 80,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_stamp_presets_kind ON stamp_presets(kind, sort_order);

CREATE TABLE bookmarks (
    id          TEXT PRIMARY KEY,                     -- UUID v4
    parent_id   TEXT REFERENCES bookmarks(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    -- page_no は元 PDF ページ (正) または 挿入ページ id の負数。
    -- inserted_pages とのまたがり整合性は app 層で保証 (overlays と同じ規約)。
    page_no     INTEGER NOT NULL,
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
