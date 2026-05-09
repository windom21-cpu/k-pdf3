# K-PDF3 Architecture Overview

このドキュメントは K-PDF3 の構造を 1 ページで俯瞰するためのもの。詳細な決定根拠は `docs/adr/` 配下を参照。

## 設計思想

### 3-layer 分離（最重要）

```
┌─────────────────────────────────────────────────────────────┐
│  K-PDF3 workspace      = 編集の唯一の真実源 (.kpdf3)         │
│  PDF                   = 配布・閲覧・印刷用の成果物          │
│  annotation            = 外部との通信レイヤ (read-only 表示) │
└─────────────────────────────────────────────────────────────┘
```

- **PDF は truth ではない**。truth は project data（overlay objects）。
- **PDF は export/render result** として扱う。
- 既存 PDF は **immutable background**。編集対象は overlay object のみ。

## レイヤ構造

```
┌─────────────────────────────────────────────────────────────┐
│  UI Layer                                                   │
│  - DOM + 98.css chrome（ウィンドウ・メニュー・ダイアログ）  │
│  - tab bar / sidebar / panels                               │
│  - フォント: Kosugi 同梱                                    │
└─────────────────────────────────────────────────────────────┘
                  ↓ events
┌─────────────────────────────────────────────────────────────┐
│  Application Layer                                          │
│  - Workspace manager（multi-project、タブ管理）             │
│  - Selection / focus / shortcut                             │
│  - Save / Export flow                                       │
└─────────────────────────────────────────────────────────────┘
                  ↓ commands
┌─────────────────────────────────────────────────────────────┐
│  Domain Layer (the truth)                                   │
│  - Project store: overlay objects                           │
│  - History store: command stack                             │
│  - Coordinate system: canonical (PDF point 72dpi)           │
│  - Pub/Sub store（自前、React 不採用）                      │
└─────────────────────────────────────────────────────────────┘
                  ↓ render request
┌─────────────────────────────────────────────────────────────┐
│  Render Layer                                               │
│  - Layout engine（mupdf.js Font + Text）                    │
│  - Viewer renderer（Canvas truth + DOM editing）            │
│  - PDF renderer（export、content stream 直接生成）          │
│  - Print pipeline（export → temp PDF → OS print）           │
└─────────────────────────────────────────────────────────────┘
                  ↓ persistence / IO
┌─────────────────────────────────────────────────────────────┐
│  Persistence Layer                                          │
│  - SQLite（better-sqlite3、WAL モード）                     │
│  - Asset library（アプリ全体で 1 つ）                       │
│  - File I/O（Electron main process）                        │
└─────────────────────────────────────────────────────────────┘
                  ↓ adapters
┌─────────────────────────────────────────────────────────────┐
│  Backend Adapters (isolated)                                │
│  - mupdf.js（WASM、AGPL）— layout / page render / export    │
│  - pdf-lib（utility ops）— metadata / outline 等            │
│  - qpdf（Apache 2.0）— sanitize / xref rebuild              │
└─────────────────────────────────────────────────────────────┘
```

## 依存ルール（必須）

1. 上位 layer は下位 layer を呼んでよい
2. 下位 layer は上位 layer を **知らない**
3. Domain layer は Backend Adapter を **直接知らない**（Render Layer 経由）
4. mupdf.js / pdf-lib / qpdf は Backend Adapter 内に **閉じ込める**
5. 編集の真実は Domain Layer にしかない（render は読み取り、persistence は書き出し）

これらは将来的に dependency-cruiser で機械チェックする（v2.0 stable 後）。

## モジュール命名規則

```
src/
├── main/         Electron メインプロセス（IPC、native dialog、file I/O）
├── renderer/     Electron レンダラ（UI、viewer、editor）
├── domain/       純 JS / 純粋 logic（store / coordinate / history / overlay model）
├── backend/      mupdf wrapper / qpdf wrapper / pdf-lib wrapper
└── shared/       ipc 型定義 / 共通型
```

依存方向：
- `renderer` → `domain` → （`backend` を直接呼ばない、render layer 経由）
- `main` → `domain` (file I/O、persistence の orchestration)
- `backend` → 外部 native lib のみ

## 主要 module 一覧（Week 1-2 で実装着手）

| module | 役割 |
|---|---|
| `domain/coord.js` | canonical ↔ PDF native の transform |
| `domain/project-store.js` | overlay collection + R*Tree インデックス |
| `domain/history.js` | command pattern undo/redo |
| `domain/page-registry.js` | virtualization 用 page metrics cache |
| `backend/mupdf-layout.js` | mupdf.js Font + Text の薄い wrapper |
| `backend/sqlite-store.js` | better-sqlite3 wrapper、schema migration |
| `renderer/viewer.js` | Canvas 描画 + DOM editor overlay |
| `renderer/editor.js` | overlay editing UI |
| `main/file-io.js` | `.kpdf3` open/save、native dialog |

## 用語

`docs/glossary.md` 参照。

## ADR

`docs/adr/` 配下：
- ADR-0001: Workspace を SQLite 単一ファイルで保存する
- ADR-0002: Layout engine に mupdf.js を採用する
- ADR-0003: Canonical coordinate を PDF point 72dpi / top-left に固定する

## 禁止事項（重要）

以下は architecture 違反として扱う：

- annotation を editable overlay object に変換する
- viewer rendering を export source として使う（DOM screenshot 等）
- canonical 座標系を渡さずに PDF native 座標で object を保持する
- ブラウザ pixel 基準で位置を計算する
- backend layer の API（mupdf 型・pdf-lib 型）を domain layer に持ち込む

## 非目標

- Adobe Acrobat 互換完全編集
- 既存 PDF 文字の自然編集
- annotation 完全互換往復
- 他ビューアでの再編集互換
