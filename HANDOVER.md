# K-PDF3 開発引き継ぎ書

最終更新: 2026-05-16
現在のバージョン: **v2.0.0-beta.78** (autoUpdater 経由で配布中)
リポジトリ: 開発リポ [windom21-cpu/k-pdf3](https://github.com/windom21-cpu/k-pdf3) (Public) / 配布フィード [windom21-cpu/k-pdf3-releases](https://github.com/windom21-cpu/k-pdf3-releases) (Public)

このドキュメントは、K-PDF3 の開発を引き継ぐ次の AI アシスタント（または別環境の自分）が会話履歴なしで作業継続できるよう書かれている。**着手前に §0 → §1 → §2 → §3 → §6 → §8 → §17 の順で必ず読むこと**。

> クローン同期メモ: 2026-05-12 に開発リポを Public 化する際 `git filter-branch` で全 commit/tag を rewrite + force push 済。同期済の環境では追加対応不要。古いクローンの場合のみ `git fetch --all --tags --force && git reset --hard origin/main` で再同期。

---

## 現状サマリ (1 分で把握)

**フェーズ**: M5 + M6 大半完了、**β テスト継続中** (法律実務家本人 + スタッフ数名で実利用)。M6 残: annotation read-only proxy / qpdf sanitize / 「後で」仮説恒久対応 / 診断ロガー撤去。

**直近完了 (β71〜β78、2026-05-14〜16)**:
- **β71** — B2 renderer.js モジュール分離完結 (8631→4472 行 / -48.2% / 12 モジュール) + B3 タブ別ウインドウ完成 (右クリック / ツールバー / File menu / drag tearout / drag dock-back の 5 経路)
- **β72** — 印刷経路を**案 D に再々設計**: K-PDF3 自前ダイアログを skip して Adobe `/p` でネイティブ印刷ダイアログ直接起動。**FAX freeze バグ根治** (β54-β70 の構造的問題、Adobe `/t` silent flag が driver UI 抑止する仕様 + β70 SW_HIDE 併発が原因)。案 X 印刷キュー監視 (`Win32_PrintJob` PowerShell) で Pro DC を 3 秒バッファ後 auto-kill
- **β73** — テキスト太字化バグ修正 (β34 の 0.03×fontSize overstroke を bold OFF 時 skip)。Adobe spawn の preamble を `Promise.all` で並列化 (~1 秒短縮)
- **β74** — **β51 以来未特定だった「PDF 開閉繰り返しクラッシュ」根治** (2nd-instance の `app.quit()` → `will-quit` → `globalShortcut.unregisterAll()` が `whenReady` 未到達で throw → `app.isReady()` ガード)。テキスト系 overlay の **シングル=選択 / ダブル=編集** 分離
- **β75** — D&D「開かない」報告対応で診断ログ仕込み。**最有力仮説**: β47 J5 の no-PDF-arg + lock 失敗 → `taskkill /F` が生きた 1st instance を誤殺している (2-30 秒間隔の session-start クラスタ多発)
- **β76** — クリップボード画像 paste (Ctrl+V / 右クリック、PNG/JPEG/WebP、max 200pt/8MB) / 明朝-serif の hairline 補強 (bold OFF + mincho/serif 限定 `0.02×fontSize` stroke) / 混在サイズ PDF の fit-width 中央寄せ + Ctrl+3 / 分割サムネに非 A4 バッジ
- **β77** — **外部 PDF D&D 挿入位置を視覚位置で確定**: 並び替えで synth ページが元のスロットアンカーから離れた状態で青線にドロップすると新規ページが「数ページ手前」にズレていた問題を根治。drop 時に gap 直前ページのキー (`afterKey`: source=pageNo / synth=-id / 先頭=0) を main に渡し、`getPages` の `orderKey` から `(lower, upper)` 算出 → ε 等分布で `display_order` 直接書込みに切替。`afterPageNo + order_in_slot` ベースの旧経路は `afterKey` 無し呼出向けに残置 (後方互換)。`addInsertedImagePage` に `displayOrder` 引数追加 (workspace + sqlite-store)
- **β78** — **外部 PDF 挿入の OOM + 応答停止を解消**: 30 MB × 25 ページ級の外部 PDF を青線にドロップすると main が同期で全ページ raster + SQLite BLOB 書込を回し、(1) wasm heap 累積 + ピーク 26 MB pixmap で OOM SIGKILL、(2) イベントループ 20-30 秒占有で OS の「応答がありません」検出が出る、の 2 段不具合があった。修正: (a) `image_blob` 生成 zoom を 300 → 96 dpi に下げ — β34 で `kpdf3:render-inserted-source-page` (vector path) が入って以降 image_blob はフォールバック専用、viewer / サムネ / 書き出し / 印刷の鮮明さは全て vector path が担保 (詳細は memory `[[k-pdf3]]` 例外節)。ピーク pixmap 26 → 2.7 MB、workspace 増分 25 MB → 5 MB、raster 時間 ~7x 短縮。(b) 各ページループ先頭で `setImmediate` yield 1 tick → OS「応答監視」をパス。(c) `kpdf3:insert-pdf-progress` IPC 新設、busy modal で「外部 PDF を取り込み中... (N / M)」+ navy バーが進む

**当面の残課題 / 未解決事項** (優先順):

1. **D&D「開かない」根因確定 → β.N+1 修正** (進行中) — β75 で診断ログ仕込み済。ユーザの 1 日使用後 crash.log を集計 → 仮説確定 → 修正。最有力仮説は J5 zombie-kill。修正候補: (a) taskkill 前に他 K-PDF3 の最近 session-start を確認、(b) `second-instance` で mainWindow 死亡 + B3 子ウインドウ alive 時の routing 改善、(c) renderer の getPathForFile fallback (OneDrive / 添付 placeholder)
2. **サムネ D&D で別ウインドウへ選択ページ挿入** (設計済、未着手) — A ウインドウのサムネ複数選択 → B のサイドバー or 分割画面 gap にドロップ → 選択ページだけ B に synthetic page として挿入。B3-γ `activeTabDrag` の page 版を main に新設、`addInsertedPdfPages` を `pageIndices?: number[]` 対応に拡張。~150 行/半日
3. **C3 Adobe で押した annotation が viewer 表示されない** (印刷では出る) — annotation read-only proxy。マーカーアイコン + ツールチップ案で確定済
4. **「後で」仮説の恒久対応** — autoUpdater 「ダウンロードしますか?」で「後で」を選ぶと中間ダウンロード残留 → 後続バージョン取得時に整合性破壊の仮説。対応案: (a) ダイアログから「後で」撤去、(b) キャンセル時の差分ファイル cleanup
5. **CI release matrix race** — β タグでは案 B-2 (Win 単独) で構造的に解消、stable v2.0.0 リリース時に手動シーケンシャル trigger or `needs:` 化を検討
6. **stable リリース時の cleanup**: β51 で追加したクラッシュ診断ロガー一式 + β75 D&D 診断ログを撤去 (`crashLogPath()` / `logCrash()` / `kpdf3:log-diag` IPC 等)。**β78 の `addpdf-*` 系診断は撤去済**、`kpdf3:insert-pdf-progress` は実用 UI なので残置
7. **Wayland ショートカット** — F5 / Ctrl+R / F12 が Ubuntu Wayland で発火しない。バージョン情報ダイアログのリロード / 開発者ツールボタンで代替可
8. **既存 workspace の leftover synth (300 dpi image_blob) 削減** (低優先) — β78 以前に挿入された synth は 300 dpi の image_blob を持つ。新規挿入分は 96 dpi。混在は問題ないが、storage 圧縮目的で migration を打つなら考慮余地

**HANDOVER 更新ルール**: HANDOVER.md は **ユーザーが明示的に依頼した時だけ** 書き換える。β タグを切る毎に勝手に refresh しない (2026-05-12 にユーザーから明示)。

---

## 0. このドキュメントの読み方

### まず必ず読む（5 分）

1. **冒頭ヘッダ + 「現状サマリ」** — 現在地と直近完了 / 残課題を 1 分で把握
2. **§1 プロジェクトの全体像** — 何を作っているか、何を作らないか
3. **§2 設計思想と禁止事項** — 絶対に守る制約
4. **§3 ユーザーとの協働方針** — どう振る舞うか
5. **§6 開発ロードマップ** — どこまで来てどこへ向かうか (β テストフェーズ)
6. **§8 次にやること** — 次セッションでスムーズに着手するための優先順
7. **§17 ユーザー要望タスクリスト** — 中期タスクの全体像 (大半は完了、未完了だけ詳細)

### 必要に応じて参照する

- §4: アーキテクチャ詳細（実装時の依存ルール）
- §5: 技術スタック
- §7: 実装済み機能カタログ
- §9: データモデル / SQLite schema
- §10: ファイル構成
- §11: 環境セットアップ・動作確認
- §12: リポジトリ・配布インフラ
- §13: K-PDF2 からの継承と破棄
- §14: AI セッション交代時の注意
- §15: 既知の制約・ADR 状況
- §16: 引き継ぎ運用

### 別ファイルで読む

- `docs/architecture.md` — レイヤ図と依存ルール
- `docs/glossary.md` — 用語定義
- `docs/adr/0001..0016.md` — 重要な設計判断の根拠
- `schema/schema.sql` — SQLite テーブル定義
- `ROADMAP.md` — マイルストーン一覧

---

## 1. プロジェクトの全体像（1 分で把握）

### このアプリは何か

**K-PDF3** は **法律実務向けの PDF Workspace アプリ**。Windows 98 風レトロ UI を継承しつつ、**「PDF を編集する」のではなく「PDF を背景にした workspace を編集する」** 設計。

### 3-layer 分離（最重要コンセプト）

| レイヤ | 役割 |
|---|---|
| **K-PDF3 workspace**（`.kpdf3` 単一ファイル）| 編集の唯一の真実源（overlay objects） |
| **PDF** | 配布・閲覧・印刷用の成果物（read-only artifact） |
| **annotation** | 外部との通信レイヤ（read-only visual proxy として表示のみ） |

### なぜ K-PDF2 を捨てて作り直しているか

K-PDF2 v0.27.1 で PDF Annotation 書き出しを 4 アプローチ試行 → **viewer 間の baseline / appearance 差異により法律実務に必要な位置精度を構造的に達成不可能** と判明（2026-05-09）。

「Adobe 互換」「他ビューア annotation 互換」「iPad 双方向」を **非目標** として撤回し、**workspace 中心 + flatten 配布** のアーキテクチャへ全面転換。

### 最終的に到達するもの

- 400 ページ PDF を滑らかに開ける軽量 PDF Workspace
- テキスト・スタンプ・印影・墨消し・しおり・ページ番号を **overlay として** 編集
- workspace を保存（Ctrl+S）→ PDF として書き出し（Ctrl+E）の 2 段操作
- 配布版 PDF は flatten された read-only 成果物
- 提出版を `.kpdf3` 内に bit-identical 履歴保管 → 法律実務の真正性要件を満たす
- 真の墨消し（300dpi ラスタ化 + sanitize）
- secure export（qpdf 経由で metadata strip / xref rebuild）
- Win/Mac/Linux クロスビルド配布

---

## 2. 設計思想と禁止事項（絶対に守る）

### 2.1 architecture-first 原則

機能追加より構造の純度を優先する。設計違反のコードは「動いても」マージしない。

### 2.2 PDF は truth ではない

- 真の編集状態は **project data（overlay objects）**
- PDF は **export/render result** として扱う
- 既存 PDF は **immutable background**
- 編集対象は **overlay object のみ**

### 2.3 非目標（向かうべきでない方向）

以下に向かう提案を見たら **stop して § 2.4 を確認**：

- Adobe Acrobat 互換完全編集
- 既存 PDF 文字の自然編集
- HTML→Canvas→PDF による精密再現
- annotation 完全互換往復
- DOM スクリーンショットベース保存
- viewer 依存 annotation 設計
- incremental save 依存
- ブラウザ pixel 基準座標

### 2.4 禁止事項（architecture 違反）

以下はコードレビューで rejected：

- annotation を editable overlay object に変換する
- viewer rendering を export source として使う（DOM screenshot 等）
- canonical 座標系を渡さずに PDF native 座標で object を保持する
- ブラウザ pixel 基準で位置を計算する
- backend layer の API（mupdf 型・pdf-lib 型）を domain layer に持ち込む
- 上位 layer から下位 layer の内部状態を直接いじる
- `domain/` から `backend/` を直接 import する（render layer 経由）

### 2.5 小手先修正の禁止

以下の方向に「逃げる」修正は禁止：

- annotation 位置オフセットの経験的調整
- CSS 微調整による pixel 一致の捏造
- html2canvas 系の workaround
- DOM snapshot hacks

→ **問題は構造で解く**。小手先で隠さない。

---

## 3. ユーザーとの協働方針（重要）

### 3.1 ユーザー像

- **法律実務家、プログラミングは素人**
- 業務で K-PDF2 を実利用している
- 全面作り直しのため業務凍結を許容している（K-PDF2 v0.27.0 を継続利用）
- 判断材料を整理して提示すれば、的確に決断する
- 字義通りより **趣旨を読み取って** 提案する方が喜ぶ

### 3.2 推奨される振る舞い

- **判断材料を整理** → 選択肢の比較とおすすめを提示 → 最終決定はユーザー
- **先回り提案**：「こうした方が良いと思います」を常に
- **趣旨優先**：プロンプトを字義通りに解さない
- **長期目的を見失わない**：目の前のステップに没頭して 3-layer 分離を破る変更をしない
- **重要判断時は §2 に立ち返る**
- **アーキテクチャ判断は ADR を新設してから着手**

### 3.3 やってはいけないこと

- 過度に技術用語で説明する（必要なら平易な表現に置き換える）
- 自動更新で HANDOVER.md を頻繁に書き換える（明示依頼時のみ）
- 黙って大規模変更を加える
- ユーザーの方針確認を待たずに architectural decision を作る

---

## 4. アーキテクチャ詳細

### 4.1 レイヤ構造

```
┌─────────────────────────────────────────────────────────────┐
│  UI Layer                                                   │
│  - DOM + 98.css chrome（ウィンドウ・メニュー・ダイアログ）  │
│  - tab bar / sidebar / panels                               │
│  - フォント: MS UI Gothic                                   │
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
│  - Print pipeline（export → temp PDF → PDF Reader CLI）     │
└─────────────────────────────────────────────────────────────┘
                  ↓ persistence / IO
┌─────────────────────────────────────────────────────────────┐
│  Persistence Layer                                          │
│  - SQLite（better-sqlite3、WAL モード）                     │
│  - Asset library（アプリ全体で 1 つ、stamps.db）            │
│  - File I/O（Electron main process）                        │
└─────────────────────────────────────────────────────────────┘
                  ↓ adapters
┌─────────────────────────────────────────────────────────────┐
│  Backend Adapters (isolated)                                │
│  - mupdf.js（WASM、AGPL）— layout / page render / export    │
│  - pdf-lib（utility ops）— metadata / outline 等            │
│  - qpdf（Apache 2.0）— sanitize / xref rebuild (M6 残)      │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 依存ルール（必須、将来 dependency-cruiser でチェック予定）

1. 上位 layer は下位 layer を呼んでよい
2. 下位 layer は上位 layer を **知らない**
3. `domain/` は `backend/` を **直接知らない**（render layer 経由）
4. `mupdf.js / pdf-lib / qpdf` は `backend/` 内に **閉じ込める**
5. 編集の真実は Domain Layer にしかない（render は読み取り、persistence は書き出し）

### 4.3 ディレクトリと責務

```
src/
├── main/         Electron メインプロセス（IPC、native dialog、file I/O、印刷経路）
├── renderer/     Electron レンダラ（UI、viewer、editor、12 モジュールに分散）
├── domain/       純 JS / 純粋 logic（store / coordinate / history / overlay model）
├── backend/      mupdf wrapper / pdf-lib wrapper
└── shared/       ipc 型定義 / 共通型（必要に応じて拡張）
```

依存方向：
- `renderer/` → `domain/` →（`backend/` を直接呼ばない、render layer 経由）
- `main/` → `domain/`（file I/O、persistence の orchestration）
- `backend/` → 外部 native lib のみ

### 4.4 renderer モジュール構成 (B2 で確立、β71)

renderer.js (4472 行) は中央 orchestrator として残し、機能別に 12 モジュールに分散:

| ファイル | 行数 | 役割 |
|---|---|---|
| `busy-modal.js` | 59 | showBusy / updateBusy / hideBusy + cancel handler |
| `dialogs.js` | 58 | customConfirm (98 風 window.confirm 代替) |
| `file-browser.js` | 351 | 自前 open/save/folder ファイルダイアログ + .lnk 解決 |
| `overlay-edit.js` | 297 | text/callout 編集 commit + measure helpers |
| `overlay-selection.js` | 353 | multi-select Set + Ctrl/Shift + alignment + Single/Double click 分離 |
| `overlay-placement.js` | 438 | placeText/Marker/Callout/Redaction + toolbar accessor |
| `stamp-helpers.js` | 124 | HiDPI canvas / tint / drawStampMixedText (純粋ヘルパー) |
| `stamp-presets.js` | 491 | preset cache + palette UI + ghost cursor + placeStamp |
| `stamp-dialogs.js` | 1109 | manager + 3 register dialog + font + 試し置き trial 統合 |
| `bookmark-pane.js` | 591 | CRUD + DnD + Tab indent/outdent + 右クリックメニュー |
| `print-flow.js` | 568 | printDialog + プロパティ→DocumentPropertiesW + actionPrint |
| `tab-manager.js` | 408 | tabs Map + applyTab + DnD reorder + 別ウインドウ間 docking |

renderer.js に残る責務: `isOpen` / `projectStore` / `history` / `viewer` 等の core state、`refreshViewer` / `actionOpen` / `openPdfPath` / `actionExport` / `actionSave`、split-view、sidebar thumbs、search、各種メニュー glue。将来候補: split-view + sidebar-thumbs 抽出 (S6)。緊急性なし。

設計パターン:
1. state は renderer.js に残し、各モジュールは `init({ ...getters })` で getter callback を受ける (alias 切替が live で追従)
2. DOM 単独要素は `document.getElementById` で直接取得 (ID は stable)
3. state が頻繁に書き換わるモジュール (selection 等) は state も移動、外部参照は API 経由
4. TabState 連携モジュールは get/set/clear Snapshot を export し tab-manager 経由で読み書き
5. 双方向密結合は統合 (stamp-dialogs ↔ trial が典型)
6. Module 間の前方参照はアロー関数で遅延解決

### 4.5 主要モジュール (domain / backend / main)

| module | 役割 |
|---|---|
| `domain/coord.js` | canonical ↔ PDF native の transform (rotation 0/90/180/270 + userRotation、matrix + point) |
| `domain/workspace.js` | workspace 高レベル API (open/create、source PDF 取込、page メタ、overlay save/load、export 監査、outline) |
| `domain/page-registry.js` | virtualization 用 page metrics cache + 縦レイアウト + visiblePageRange |
| `domain/project-store.js` | overlay CRUD + per-page index + Pub/Sub + dirty flag (renderer 側で生存) |
| `domain/history.js` | command-pattern undo/redo stack |
| `domain/commands.js` | AddOverlay / UpdateOverlay / RemoveOverlay + CompositeCommand |
| `backend/mupdf-pdf-info.js` | page metrics 抽出 / fingerprint / outline |
| `backend/mupdf-layout.js` | layout engine wrapper (shapeLine / measureLine / wrapLines) |
| `backend/mupdf-render.js` | page → Pixmap → RGBA bytes |
| `backend/sqlite-store.js` | better-sqlite3 wrapper (WAL、schema migration、CRUD) |
| `main/main.js` | Electron skeleton + IPC surface (workspace lifecycle / viewer / overlay / export / print / bookmarks / recent / window-state / tab D&D / global-stamp / global-asset / printer-properties / autoUpdater) |
| `main/render-service.js` | page 描画オーケストレーション |
| `main/workspace-registry.js` | userData/index.db で fingerprint → kpdf3 索引 (ADR-0007) |
| `main/updater.js` | electron-updater のラッパ + 98 風 confirm/busy modal IPC |
| `main/global-stamp-store.js` | userData/stamps.db (全 PDF 共通プリセット) |
| `main/printer-properties-win.js` | DocumentPropertiesW + SetThreadDpiAwarenessContext (4K 対応) |
| `main/preload.cjs` | renderer に露出する `window.kpdf3` API |

---

## 5. 技術スタック

### 5.1 ランタイム

| 項目 | バージョン | 役割 |
|---|---|---|
| Electron | ^38.8.6 | デスクトップアプリ化（ADR-0004 により一時固定） |
| Node.js | 22.22.2 | JavaScript 実行環境 |
| nvm | 0.40.4 | Node バージョン管理 |
| electron-builder | 26.8.1 | クロスビルド配布 |
| electron-updater | 6.8.5 (exact) | 自動アップデート (β5+) |
| koffi | 2.16.2 | Win API 直接コール (printer properties 4K 対応) |

### 5.2 主要ライブラリ

| 項目 | バージョン | ライセンス | 役割 |
|---|---|---|---|
| **mupdf** | ^1.27.0 | **AGPL-3.0** | layout engine / page render / export |
| **better-sqlite3** | ^12.0.0 | MIT | workspace persistence (.kpdf3) |
| pdf-lib | ^1.17 | MIT | utility ops (metadata、/Outlines、embedPdf for 回転ページ) |
| qpdf | 未同梱 | Apache 2.0 | secure export sanitize (M6 残務) |

### 5.3 同梱バイナリ

| 項目 | ライセンス | 配置 | 役割 |
|---|---|---|---|
| SumatraPDF.exe | GPLv3 (spawn なので link 制約なし) | `vendor/sumatrapdf/` | Win 印刷 fallback (Reader 不在時) |

### 5.4 フォント（同梱想定）

| 項目 | ライセンス | 役割 |
|---|---|---|
| MS UI Gothic | システム標準 | UI フォント (Win) |
| IPAex 明朝 | IPA フォントライセンス | PDF 出力時の日本語 fallback (M6 同梱予定) |
| CrashNumberingSerif / Gothic | PSY/OPS Freeware | 日付スタンプ数字 (同梱済) |
| CrashNumberingDigits | 同上 (β32 で派生作成) | unicode-range `U+0030-0039` で 0-9 限定、`digitsHanko` チェック用 |

### 5.5 ライセンス注意点

- **mupdf.js が AGPL** → 開発リポを Public 化済 (2026-05-12)、installer も公衆配布されているため AGPL の source 公開要件を厳密に満たす方向に。
- mupdf.js は `backend/` に閉じ込めて、将来の backend swap を可能にする設計。
- SumatraPDF は spawn として呼ぶだけなので GPLv3 の感染なし。

---

## 6. 開発ロードマップ

### 6.1 全体像

```
M1 Foundation → M2 Core → M3 Editing UI → M4 Export → M5 Feature Migration → M6 Polish
   ✅ DONE      ✅ DONE     ✅ DONE        ✅ DONE      ✅ DONE              🚧 大半完了
```

着手日：2026-05-09。実装速度は想定より速く、2026-05-09 の 1 セッション内で M1 → M5 大半まで進んだ。

### 6.2 マイルストーン進行ルール

- 各 M の **Exit criteria を満たすまで次へ進まない**
- 着手前に該当する ADR / glossary 項目を整備
- M5 完了で **v2.0.0-beta.1 release**（業務移行可能）
- M6 完了で **v2.0.0 stable release**
- ユーザー確認は M2 / M3 / M4 / M5 完了時に実施

### 6.3 各マイルストーン

| M | 状態 | 主な成果 |
|---|---|---|
| ✅ **M1** | 完了 | architecture / SQLite / coordinate / mupdf wrapper |
| ✅ **M2** | tag: `v2.0.0-alpha.M2` | object model / virtualization / page render / Win95 chrome (98.css) / PDF-first UX |
| ✅ **M3** | tag: `v2.0.0-alpha.M3` | text/stamp/redaction 編集 / IME / Undo/Redo / Ctrl+S / drag・resize / 右クリック削除 / zoom / page navigation |
| ✅ **M4** | tag: `v2.0.0-alpha.M4` | export pipeline / Smart Save As (byte-copy) / exports 監査ログ / userData 集中保管 |
| ✅ **M5** | tag: `v2.0.0-beta.78` (配布中) | K-PDF2 主要機能 + α (タブ並列編集 / タブ別ウインドウ / 自動アップデート / 印刷 (案 D) / しおり / スタンプ / 画像スタンプ / 検索 / 範囲書出 / 分割保存) |
| 🚧 **M6 (大半完了)** | β に同梱 | UI ポリッシュ + 機能投入済 (自前タイトルバー / カスタムファイルダイアログ / 印刷プレビュー / 98 風アップデート / マーカー / 墨消し白 / 吹き出し / 編集可能しおり (階層 + drag-reorder) / フォント設定 / ページ番号フッター / B2 モジュール分離 / B3 タブ別ウインドウ / 案 D 印刷 / 4K DPI 対応)。**残**: annotation read-only proxy / qpdf sanitize / Wayland ショートカット / 「後で」恒久対応 / 診断ロガー撤去 |

### 6.4 β テストフロー（**現在ここ**）

2026-05-10 以降のフェーズ。新機能着手より、ユーザー（法律実務家本人 + スタッフ）が β を実機で使い込んでフィードバックを集める段階。

#### 主要マイルストーン β

per-β の詳細は `git log --oneline` + 各 tag の commit message が一次資料。要点のみ:

| β | 日付 | 内容 |
|---|---|---|
| β1 | 05-10 | 初回 β。CI 設定で転倒 (GH_TOKEN 不在 + icon.ico サイズ) → 同タグ再 build |
| β2 | 05-10 | ページポップアップ機能 (`actionOpenPagePopup`、見比べ用スナップショット) |
| β3 | 05-11 | β2 テスター指摘 11 件 (分割保存区切り線 / × 削除遅延 / しおり自動取込 / **スタンプを全 PDF 共通化** stamps.db / タブバー再配置 / HiDPI プレビュー 等) |
| β4 | 05-11 | β3 テスター指摘 14 件: **SumatraPDF 同梱で印刷フリーズ根治** / 元 PDF 上書き保存 (Word Ctrl+S 化) / **ハイブリッド PDF 組立** (vector 維持、100MB→300KB) / テキスト改行・色・コピペ / 複数ページ→単一 PDF 保存 / 印影背景透過 |
| β5 | 05-11 | **autoUpdater 組込み** (electron-updater@6.8.5 + 98 風 confirm/busy + 公開 feed リポ `k-pdf3-releases` 新設、`--publish=always` で direct push) |
| β6 | 05-11 | テキスト複数選択 + 整列 (Ctrl/Shift modifier + `#align-bar` + `CompositeCommand`) |
| β7 | 05-11 | NSIS oneClick=true (silent install、`Next > Install` UX 廃止) |
| β8 | 05-11 | ハイブリッド組立を回転ページに対応 (`_placeRotatedSourcePage` + pdf-lib `embedPdf`) |
| β9〜β11 | 05-11 | 回転対象解決ロジック修正 (split / sidebar / viewer の優先順)、race condition 修正 (`visiblePageNow` 二分探索) |
| β12 | 05-12 | 回転後サムネ白紙化バグ修正 (`renderThumb` 末尾の `isConnected` ガード)。CI matrix race を初観測 (macOS 422 already_exists) |
| β13〜β15 | 05-12 | スタンプ palette drag / 画像スタンプ「PDF に試し置き」/ **4K DPI 対応** (printer properties + NSIS manifest) / 吹き出し UX 拡充 / 日付スタンプ字間 / マーカー opacity 0.3 / **PDF 関連付け + singleInstance** |
| β16〜β30 | 05-12 | テスター指摘 13 件 + 試し置き UX 連続改善 |
| β31〜β33 | 05-12 | D 系 (印刷 600→900dpi / 外部 PDF vector / 数字 hanko 独立軸)。**β31/32 起動クラッシュ騒動 → β33 緊急ロールバック → 撤回** (autoUpdater「後で」仮説と推定)。同時期に**開発リポを Public 化 + force push** (GitHub Actions Free 枠枯渇のため) |
| β34 | 05-12 | E 系 (太字独立軸 / 外部 PDF viewer vector)。**CI 案 B-2 適用** (β=Win 単独、stable=3 OS) |
| β35〜β43 | 05-13 | F/G/H/I/J 系 大量 polish: 吹き出し枠ぴったり化、日付スタンプ年月のみ、配置ゴースト統一、FAX 経路対応 |
| β44 | 05-13 | ウインドウ bounds/maximized 永続化 (`userData/window-state.json`) |
| β45 | 05-13 | 削除ダイアログ視覚位置 + サムネ右クリック削除 |
| β46〜β50 | 05-13〜14 | **印刷プロパティ完全反映** (DEVMODE duplex/tray/color 抽出 + SetPrinter level 9 + 印刷中クローズ確認 + zombie 自動 kill) |
| β51 | 05-14 | **クラッシュ診断ロガー** (`userData/crash.log`、stable 前撤去予定) |
| β52〜β53 | 05-14 | FAX 誤検出修正 + Apeos C2360 ハング解消 (byte-copy も Sumatra 経路統一) |
| β54〜β63 | 05-14 | **印刷品質改善の長い試行錯誤**: 案 M (Win32 GDI) / 案 N (PostScript raw) / 案 N' (PCL) / ζ (font embed) すべて C2360 ドライバ構造的制約に阻まれ撤回 |
| β64〜β70 | 05-14 | **C アプローチ採用**: PDF Reader CLI 委譲 (Adobe Reader DC / Acrobat Pro / Foxit / PDF-XChange の三段カスケード)。β70 で印刷エンジン選択 UI + Acrobat Pro ウィンドウ強制 hide |
| **β71** | 05-14〜15 | **B2 renderer.js モジュール分離完結 (8631→4472 行 / -48.2%) + B3 タブ別ウインドウ完成 (5 経路)** |
| **β72** | 05-15 | **案 D 印刷経路再々設計** (Adobe `/p` 直接 → FAX freeze 根治) + 案 X (Win32_PrintJob 監視で Pro DC 自動 close) |
| **β73** | 05-15 | テキスト太字化バグ修正 (bold OFF 時 strokeText skip) + Adobe spawn 並列化 (~1 秒短縮) |
| **β74** | 05-15 | **globalShortcut crash 根治** (β51 来の PDF 開閉繰り返しクラッシュ) + テキスト系 overlay の single=選択 / double=編集 分離 |
| **β75** | 05-15 | D&D 診断ログ仕込み (β47 J5 zombie-kill 仮説の crash.log 待ち) |
| **β76** | 05-15 | クリップボード画像 paste / 明朝-serif hairline 補強 / 混在サイズ fit-width 中央寄せ + Ctrl+3 / 分割サムネ非 A4 バッジ |
| **β77** | 05-15 | **外部 PDF D&D 挿入位置を視覚位置で確定** (afterKey + display_order 直接指定。並び替え後の青線ドロップで「数ページ手前にズレる」根治) |
| **β78** | 05-16 | **外部 PDF 挿入の OOM + 応答停止解消** (image_blob 300 → 96 dpi、`setImmediate` yield、進捗 IPC + busy modal の N/M 表示) |

#### β.N リリース手順

1. ローカルで修正コミット（`feat:` `fix:` プレフィックス、論理単位ごと）
2. `package.json` + `package-lock.json` の `version` を `2.0.0-beta.N` (N+1) に bump
3. `git commit -m "chore(release): bump to 2.0.0-beta.N — <要旨>"`
4. `git push origin main`
5. `git tag -a v2.0.0-beta.N -m "<要旨>"`
6. `git push origin v2.0.0-beta.N` → CI release workflow が起動
7. `gh run list --workflow=release.yml --limit 1` で run id 確認
8. 約 5 分で installer が完走 (β タグは Win のみ = 案 B-2)
9. `gh release view v2.0.0-beta.N --repo windom21-cpu/k-pdf3-releases` で installer 確認
10. 配布フォルダ更新 (新規テスター用):
    ```bash
    rm -rf ~/デスクトップ/K-PDF3-beta<N-1>
    mkdir -p ~/デスクトップ/K-PDF3-beta<N>
    cd ~/デスクトップ/K-PDF3-beta<N>
    gh release download v2.0.0-beta.N --repo windom21-cpu/k-pdf3-releases
    ```

**β5 以降はテスター手動入れ替え不要** (autoUpdater が新版を検出して 1 クリック更新、β7+ は完全 silent)。Google Drive 共有は新規テスター用初回 installer のみ。

#### CI で過去引っかかった点（再発防止メモ）

- **macOS / Linux**: electron-builder はタグ push を検知すると暗黙の publish を試みて `GH_TOKEN` を要求し失敗する。`package.json` の `build:linux/win/mac` には `--publish=never`、CI 専用の `publish:linux/win/mac` には `--publish=always` を分離済。
- **Windows**: `build/icon.ico` は 256x256 以上が必須。`scripts/build-icon.mjs` は 512×512 PNG (`build/icon.png`) から自動変換する方針 (ico はコピーしない)。
- **β5**: `k-pdf3-releases` の初回コミットが無い状態で 422 (Repository is empty)、かつ `releaseType: release` で draft 作成 → autoUpdater から見えない。対策: (a) README を 1 commit で初期化、(b) `releaseType: prerelease` に変更 (stable v2.0.0 リリース時は戻す or 削除)。
- **`.github/workflows/release.yml` の編集 push**: PAT に `workflow` scope 必須。classic PAT に追加で解決。
- **β7**: 自動アップデートで `Next > Install` ウィザード → `oneClick: true` に切替 (silent install、`%LocalAppData%\Programs\K-PDF3\` 固定)。
- **β12 で踏んだ matrix race**: matrix の最速 job が 201 success、遅延 job が `422 tag_name already_exists`。β タグは **案 B-2 (Win 単独)** で構造的に解消、stable v2.0.0 リリース時は手動シーケンシャル trigger または `needs:` 化で対応。

#### β 期間中のバグレポート受け取り方

- ユーザーが GitHub Issues / 直接連絡で報告
- 軽微なら次の β.N に同梱（即修正→ tag push 30 分で installer 更新）
- 重大（業務凍結級）なら git revert + 緊急 β でロールバック

#### β 卒業の目安

業務並走で 1〜2 週間使って重大バグなし、かつ K-PDF2 v0.27.0 の代替が成立する確信が出れば、β を卒業して stable に進む (annotation proxy / qpdf sanitize / 「後で」恒久対応 / 診断ロガー撤去)。

---

## 7. 実装済み機能カタログ

### 7.1 ドキュメント (`docs/`)

- `docs/architecture.md` — レイヤ図と依存ルール
- `docs/glossary.md` — 用語定義
- `docs/adr/0001..0016.md` — 重要な設計判断 (詳細は §15.3 ADR 状況)

### 7.2 ユーザーから見える機能 (現状サマリ)

#### ファイル系

| 機能 | 操作 |
|---|---|
| PDF を開く | toolbar「開く」/ ファイル > 開く / 最近のファイル / PDF を画面に D&D / OS から関連付け起動 (singleInstance) |
| カスタム ファイル選択 | OS ダイアログを使わず Win95 風自前ブラウザ。Open / Save / Folder の 3 モード共有 |
| 上書き保存 | Ctrl+S / toolbar「上書き」(workspace flush + 元 PDF を rasterized で上書き、Word 流) |
| 名前を付けて保存 | Ctrl+Shift+S / toolbar「保存」/ ファイル > 名前を付けて保存 (Save As 後 workspace 自動切替) |
| 範囲書き出し | ファイル > 範囲指定で書き出し |
| 分割保存 | toolbar「分割保存」→ サムネビュー + 区切りクリック + 各パート命名 + 日付プレフィックス |
| 印刷 | Ctrl+P / toolbar「印刷」→ **案 D**: Adobe / Foxit / PDF-XChange のネイティブダイアログ直接起動。Reader 不在環境は K-PDF3 自前ダイアログ + Sumatra/Chromium silent fallback |
| 複数ページ→単一 PDF 保存 | サムネ複数選択 → 右クリック「N ページを PDF として保存…」 (連続=`p3-5` / 非連続=`Npages`) |
| 単ページ PDF 保存 | サムネ右クリック「このページを PDF として保存…」 (§17.2 の D&D 代替) |
| 閉じる時警告 | 未保存 (overlay / ページ削除 / 挿入) があれば確認 |

#### 編集系

| 機能 | 操作 |
|---|---|
| テキスト追加 | toolbar「テキスト」→ 1 クリック配置 → 自動編集モード (IME + フォント/サイズ/色 + 改行 + 編集中横拡張) |
| 印影・テキスト・画像スタンプ | toolbar「印影」/「スタンプ」→ palette popup から選択 → 配置。スタンプは **全 PDF 共通** (`stamps.db`) |
| スタンプ管理 | ツール > スタンプ管理。日付 / テキスト / 画像の 4 種 register dialog + 編集 (upsert) + 削除 + フォント設定 (全角/半角別 stack) |
| 日付スタンプ | `-8.-5.-9` / `-8．-5．-9` (全角ピリオド) / `令和-8年-5月-9日` / **`-8 -5 -9` (字間調整 distribute-3)** の 4 形式 |
| 真の墨消し | toolbar「墨消し」→ ドラッグで範囲指定 (黒 / 白 切替) |
| マーカー | toolbar「マーカー」→ 横方向ドラッグ (4 色、opacity 0.3) |
| 吹き出し | toolbar「吹き出し」→ ドラッグでクリック=矢印先端、リリース=テキストアンカー (矢じり + 折返し対応 + 矢印先端ハンドル) |
| ページ番号フッター | toolbar ボタン + 位置/形式/開始番号/サイズダイアログ |
| overlay 操作 | drag で移動、四隅で resize、**シングルクリック=選択 / ダブルクリック=編集** (β74)、右クリックメニュー (コピー / 貼り付け / 削除) |
| Undo/Redo | Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / 編集 menu (`CompositeCommand` で多重削除・整列も 1 unit) |
| 複数選択 | Ctrl/Cmd+click = toggle、Shift+click = reading-order range、`#align-bar` (2+ 選択時、左/上/右/下 整列) |
| クリップボード | Ctrl+C/V + 右クリックメニュー。**OS 画像 paste** (β76): Ctrl+V / 右クリック「貼り付け」で PNG/JPEG/WebP を image stamp として挿入 |
| ページ削除 | サムネ複数選択 + Delete (pending workflow → Ctrl+S で flush) |
| ページ挿入 | サムネ間「+」hover → クリックでダイアログ (白紙 / テキスト付き、72pt 表示) |
| 外部 PDF 挿入 | サムネ間 gap に外部 PDF を D&D → image-backed synthetic page (inserted_pages.image_blob、144 dpi raster + INSERT) |
| サムネ D&D 並び替え | pages + inserted_pages 両方に `display_order`、reorderAllPages IPC、複数選択一括移動 (相対順序保持) |
| ページ回転 | toolbar ↺/↻ + サムネ右クリック menu (split / sidebar / viewer の優先順、`visiblePageNow` 二分探索 race-free) |

#### 表示・ナビ系

| 機能 | 操作 |
|---|---|
| ページ表示 | スクロール、PageUp/PageDown、Ctrl+G、ステータス「N / total」 |
| 拡大縮小 | Ctrl+= / Ctrl+- / Ctrl+0 / fit-window / **Ctrl+3 = 幅をウィンドウに合わせる** (β76) / toolbar zoom dropdown / Ctrl+ホイール |
| 混在サイズ PDF | fit-width で現在ページを viewport 中央寄せ (β76 `recenterCurrentPageHorizontally`) |
| 表示解像度切替 | ツール > 表示解像度: 標準 / 高 / 最高 (HiDPI canvas oversample) |
| サムネイル | サイドバー「サムネイル」タブ + IntersectionObserver lazy。非 A4 バッジ表示 (split-view も β76) |
| しおり | サイドバー「しおり」タブ / F4。階層 + drag-reorder + Tab で indent/outdent / 双クリックリネーム / 自動取込 |
| サイドバー開閉 | F4 / 左端の縦ハンドル / メニュー、幅は localStorage 永続化 |
| 検索 (Ctrl+F) | toolbar 右端 → ページ単位ヒットを順次ジャンプ (mupdf `Page.search()`) |
| ページポップアップ | toolbar「別窓」→ 現ページのスナップショット PNG を frameless BrowserWindow に表示 (📌 always-on-top、Esc 閉) |

#### タブ・ウインドウ系

| 機能 | 操作 |
|---|---|
| タブ | Ctrl+T (新規) / Ctrl+W (閉) / +/× ボタン / dirty マーク / 複数 dirty タブの一括確認 / ドラッグ並び替え |
| **タブ別ウインドウ** (β71、B3) | 5 経路: タブ右クリック「別ウインドウへ移動」/ ツールバー「別窓化」/ ファイル > 別ウインドウで開く… / drag tearout (タブを bar 外へ) / drag dock-back (別窓のタブを本窓のバーへ)。子ウインドウは Chrome 風 last-tab-out で自動 close |
| 自前タイトルバー | 98.css 青いバー、frame:false で OS chrome なし。最小化/最大化/閉じる + double-click 最大化 + ドラッグ |
| タイトル動的反映 | 開いてる PDF のファイル名 + dirty マーク |
| ウインドウ位置永続化 | `userData/window-state.json` (β44) |
| 自動アップデート (β5+) | 起動 3 秒後に `autoUpdater.checkForUpdates()` → 98 風 confirm「ダウンロードしますか?」→ busy modal 進捗 → 「再起動して適用?」。ヘルプ > 更新を確認...で手動チェック |

#### UI 補助

| 機能 | 操作 |
|---|---|
| ホバーヒント | toolbar / メニューの項目 → 左下ステータス |
| 砂時計カーソル | 書き出し / 印刷 / 描画中、`body.is-busy` |
| バージョン情報 | ヘルプ > バージョン情報 → 自前モーダル (Electron / Node / Platform、リロード / 開発者ツール ボタンも兼ねる) |
| クラッシュログ表示 | ヘルプ > クラッシュログを開く (β51〜、stable 前撤去予定) |

### 7.3 設計上の決まりごと

- **ProjectStore は renderer 側に常駐**。main は SQLite I/O だけ (M3-1 確定)
- **kpdf3 は userData に集中保管** (`~/.config/K-PDF3/workspaces/`)。fingerprint 索引 (`index.db`) で PDF と紐付け (ADR-0007)
- **スタンプ preset は全 PDF 共通** (`<userData>/stamps.db`、β3 移行)。初回 workspace 開時に旧 workspace 内 preset を global へ自動マイグレート
- **Save = workspace state** (Ctrl+S、kpdf3 + 元 PDF 上書き)。**Save As = export + workspace 自動切替** (Ctrl+Shift+S)
- **ディスク上の PDF は普通の名前** (`契約書.pdf`)。kpdf3 はユーザーから見えない (ADR-0007)
- **Win95 風 UI** (98.css vendored、frame:false)。toolbar 押下状態 + ツールメニュー ✓ で同期 (ADR-0006)
- **ページ削除は pending workflow**、Ctrl+S で flush。**ページ挿入は即時 DB 反映** (`workspaceMutated` フラグで dirty)
- **synthetic ページのレンダは renderer 側 canvas で完結**。main は触らない
- **ハイブリッド PDF 組立** (β4〜、`assembleHybridPdf`): 編集なしページは元 PDF を vector 維持で copyPages、編集ありは元 vector + 600dpi overlay PNG、synthetic / 回転は full-rasterize JPEG (β8 で回転も embedPdf で vector 維持化)。`EXPORT_ZOOM = 900/72` (β31〜)
- **印刷経路** (案 D、β72〜): K-PDF3 印刷ボタン → temp PDF 生成 → Adobe `/p` → ネイティブダイアログ → ユーザ印刷確定 → Win32_PrintJob 監視 → 新規ジョブ検出 → 3 秒バッファ → `taskkill /F /T`。Reader 不在は Sumatra/Chromium fallback

### 7.4 テスト

| テスト | 結果 | 環境 |
|---|---|---|
| `coord.test.mjs` | 83 pass | plain node |
| `page-registry.test.mjs` | 48 pass | plain node |
| `project-store.test.mjs` | 59 pass | plain node |
| `history.test.mjs` | 45 pass | plain node |
| `m1-exit-criteria.mjs` | 51 pass | Electron runner |
| `m3-overlay-persistence.mjs` | 56 pass | Electron runner |
| `render.test.mjs` | 11 pass | plain node |
| `render-service.test.mjs` | 27 pass | plain node |
| **合計** | **380/380 pass** | |

```bash
npm test                 # 全テスト
npm run test:coord       # 個別実行
npm run test:m1          # m1 + m3-overlay-persistence (electron-runner 経由)
```

2026-05-10 以降の追加機能 (ページ削除 / 挿入 / Save As / 検索 / スタンプ管理 / 画像スタンプ / 編集可能しおり / callout / タブ別ウインドウ) は手動確認のみ。Electron runner で round-trip テスト追加すべき (低優先)。

---

## 8. 次にやること（次セッション着手前ガイド）

### 8.1 起動・確認

```bash
cd ~/デスクトップ/k-pdf3
git fetch --all --tags --force
git pull --ff-only origin main
git log --oneline | head -20       # 最新は β76
npm test                           # 380/380 pass
npm run dev                        # electronmon (推奨、自動 reload)
# または npm start                 # 単発起動
```

### 8.2 短期の優先順

#### 🔴 着手検討が必要なオープン項目

1. **D&D「開かない」根因確定 → β77 修正** (進行中) — crash.log 集計後、最有力仮説 (J5 zombie-kill) を裏付けて修正。修正候補は冒頭「現状サマリ」参照
2. **C3 annotation read-only proxy** (実装) — Adobe で押した annotation を viewer 表示。マーカーアイコン + ツールチップ案で確定済
3. **qpdf sanitize** (実装) — secure export pipeline (metadata strip / xref rebuild)。`extraResources` 同梱で各 OS バイナリ spawn
4. **「後で」仮説の恒久対応** — autoUpdater UX 改修 (「後で」撤去 or キャンセル時の差分 cleanup)
5. **サムネ D&D で別ウインドウへ選択ページ挿入** — B3-γ activeTabDrag の page 版、`addInsertedPdfPages` の `pageIndices?` 拡張。~150 行/半日 (D&D 修正後)

#### 🟡 確認待ち項目（実機テスター側）

- **β71 B3 タブ別ウインドウ**: 5 経路の業務での体感。tearout / dock-back 中に画面の見え方や残留ウインドウがおかしくないか
- **β72-β76 印刷経路 + 編集機能**: 案 D で Adobe ダイアログの体感、太字化バグ解消、クリップボード paste、明朝の濃さ、混在サイズの中央寄せ
- **β14/β15 4K DPI**: プリンタプロパティダイアログ + NSIS installer のシャープさ

#### 🟠 繰越項目 (β 卒業前の検討候補)

- **CI release matrix race の根治** (stable 時) — pre-create release を別 job で先行 / sequential build の選択
- **既存マーカーの opacity 移行** — β15 で default 0.3 化、既存 0.5 はそのまま。一斉に淡くしたい場合 migration スクリプト
- **画像スタンプ vector 化** — 印刷時の bbox raster 制約 (β62) を vector で置き換える研究 (現状は受容)
- **IPAex 同梱** — 配布先での字形差異が問題化したら検討
- **dock-back 視覚フィードバック** — 現状 cross-window drop は無告知 dock。target tab-bar のハイライト追加余地

#### v2.0.0 stable に向けた残作業

- annotation read-only proxy (実装)
- qpdf sanitize (実装)
- 「後で」仮説の恒久対応 (実装)
- 業務並走 1〜2 週間で重大バグなしの確認
- **クラッシュ診断ロガー撤去** (β51 + β75 D&D 診断ログ): `crashLogPath()` / `logCrash()` / `print-route` 等のログ呼び出し / `kpdf3:open-crash-log` IPC / preload `openCrashLog` / index.html の `data-action="open-crash-log"` / `actionOpenCrashLog` / `drop-*` / `gap-drop-file` / `os-open-received` / `j5-zombie-kill-*` / `second-instance-*` / `kpdf3:log-diag` IPC
- CI release matrix race 対応 (stable タグの 3 OS build を捌く)
- (任意) Mac 署名 / 公証 secrets、Win コードサイン

### 8.3 詰まったら確認するポイント

- §4.4 — renderer モジュール構成 (B2 完結後の責務分担)
- `docs/adr/` 全部 — 設計判断の根拠
- `git log --oneline` — どの commit で何をしたか
- `test/electron-runner.cjs` — Electron 内テスト実行の枠組み
- `src/main/main.js` — IPC surface 全体像 (B3 で per-window state)
- `src/renderer/renderer.js` — B2 で 4472 行に圧縮済、中央 orchestrator

### 8.4 ユーザーへの確認タイミング

- ADR 起草後 → 反映前
- 大物機能の UI 提案 → 実装前
- CI 緑後 → アーティファクトのインストール確認
- stable リリース前 → 全機能の動作確認 + 業務移行の準備

### 8.5 やってはいけないこと

- pdf.js 再導入（mupdf に統一）
- React / Vue / Svelte の導入（自前 Pub/Sub 維持）
- ProjectStore を main に戻す（renderer 側で確定）
- 直結 print（落ちる、案 D で解決済の枠組みを崩さない）
- ProjectStore に同期書き込み（dirty workflow を維持）
- ページ削除を即時 DB 反映に戻す（pendingDeletedPages の意義）
- HANDOVER.md を黙って大幅編集（明示依頼時のみ）
- destructive 操作 (force push / reset --hard) をユーザー承認なしで実行

---

## 9. データモデル

### 9.1 SQLite schema

詳細は `schema/schema.sql`。要点：

| table | 主な役割 |
|---|---|
| `metadata` | key/value（schema_version, created_at, source_fingerprint, ...） |
| `source_pdf` | 元 PDF を bit-identical で BLOB 保管（1 行のみ） |
| `pages` | 各ページの mediabox / cropbox / rotation / userRotation / is_deleted / display_order |
| `inserted_pages` | 挿入ページ (negative pageNo 同定、image_blob 対応) |
| `inserted_source_pdfs` | 外部 PDF 挿入の source 保持 (SHA-256 dedup) |
| `overlays` | overlay object（canonical 座標、type / properties JSON） |
| `overlays_spatial` | R*Tree spatial index（hit-test 高速化） |
| `assets` | 画像 asset（hash dedup） |
| `bookmarks` | しおり (id + title + pageNo + parentId + sortOrder) |
| `exports` | 監査ログ (BLOB は ADR-0008 で廃止、メタのみ) |
| `history` | undo/redo + 監査ログ（command pattern） |
| `settings` | viewport / zoom 等 UI state |
| `overlay_fts` | FTS5 全文検索 |

**全 PDF 共通の `<userData>/stamps.db`** (β3〜): `assets` + `stamp_presets` テーブル。

### 9.2 canonical coordinate（ADR-0003）

- 単位：**PDF point (72dpi)**
- origin：**top-left**
- rotation：**rotation 適用後のユーザー視点**（紙アナロジー）
- 基準矩形：**cropbox**

overlay object はこの座標系のみを保持。PDF native 座標は知らない。変換は `domain/coord.js` 経由でのみ行う。

### 9.3 overlay object spec

```typescript
type OverlayType = 'text' | 'stamp' | 'image' | 'redaction' | 'line' | 'rect' | 'signature' | 'page_number';

interface Overlay {
  id: string;          // UUID v4
  pageNo: number;      // 1-based (synthetic は negative)
  type: OverlayType;
  x: number; y: number; w: number; h: number;  // canonical bbox (top-left origin)
  zOrder: number;
  properties: object;  // type-specific (text content, font, color, ...)
  assetId?: string;    // for image-based overlays
  createdAt: string;
  updatedAt: string;
}
```

主要 type の `properties`:

```typescript
// text (+ kind='callout' で吹き出し、+ rect type)
{ text: string, fontSize: number, fontId: string, color: string,
  bold?: boolean, lineHeight?: number,
  arrowDx?: number, arrowDy?: number,  // callout のみ
}

// stamp
{ kind: 'date' | 'image' | 'text-frame', text?: string, color?: string,
  frame?: 'circle' | 'rect' | 'none', fontSize?: number, dateFormat?: string }

// redaction
{ color: 'black' | 'white', mode: 'draft' | 'applied' }

// line (+ kind='marker')
{ color: string, opacity?: number }
```

---

## 10. ファイル構成

```
k-pdf3/
├── package.json                          # v2.0.0-beta.76
├── package-lock.json
├── README.md
├── ROADMAP.md
├── HANDOVER.md
├── .gitignore
│
├── docs/
│   ├── architecture.md
│   ├── glossary.md
│   └── adr/
│       └── 0001..0016-*.md
│
├── schema/
│   └── schema.sql
│
├── src/
│   ├── domain/
│   │   ├── coord.js
│   │   ├── workspace.js
│   │   ├── project-store.js
│   │   ├── page-registry.js
│   │   ├── history.js
│   │   └── commands.js
│   ├── backend/
│   │   ├── sqlite-store.js
│   │   ├── mupdf-pdf-info.js
│   │   ├── mupdf-layout.js
│   │   └── mupdf-render.js
│   ├── main/
│   │   ├── main.js                       # 大物、IPC surface
│   │   ├── render-service.js
│   │   ├── workspace-registry.js
│   │   ├── updater.js
│   │   ├── global-stamp-store.js
│   │   ├── printer-properties-win.js
│   │   └── preload.cjs
│   └── renderer/
│       ├── index.html
│       ├── renderer.js                   # 4472 行 (中央 orchestrator)
│       ├── viewer.js                     # 1770 行
│       ├── exporter.js                   # 953 行
│       ├── menu-bar.js
│       ├── fonts.js
│       ├── page-popup.html / page-popup.js
│       ├── style.css
│       ├── busy-modal.js
│       ├── dialogs.js
│       ├── file-browser.js
│       ├── overlay-edit.js
│       ├── overlay-selection.js
│       ├── overlay-placement.js
│       ├── stamp-helpers.js
│       ├── stamp-presets.js
│       ├── stamp-dialogs.js
│       ├── bookmark-pane.js
│       ├── print-flow.js
│       ├── tab-manager.js
│       └── vendor/98.css + ms_sans_serif*.woff
│
├── test/
│   ├── coord.test.mjs / page-registry.test.mjs / project-store.test.mjs / history.test.mjs
│   ├── render.test.mjs / render-service.test.mjs
│   ├── m1-exit-criteria.mjs / m3-overlay-persistence.mjs
│   └── electron-runner.cjs
│
├── vendor/
│   └── sumatrapdf/SumatraPDF.exe         # Win 印刷 fallback (Reader 不在時)
│
├── build/
│   ├── icon.png / icon.ico (auto-generated)
│   └── installer.nsh                     # DPI manifest inject
│
├── scripts/
│   └── build-icon.mjs                    # 512×512 PNG → ico 変換
│
├── .github/workflows/
│   ├── ci.yml                            # npm test
│   └── release.yml                       # 案 B-2: β=Win / stable=3 OS
│
├── fonts/                                # IPAex 同梱予定 (M6)
└── node_modules/                         # gitignore
```

---

## 11. 開発環境

### 11.1 必須環境

- Linux ネイティブ（kernel 6.17.0-generic、Ubuntu 24.04 系）
- Node.js v22.22.2（nvm 経由）
- npm
- gh CLI（GitHub 操作）
- git
- `build-essential`（Electron native module rebuild 用）

### 11.2 セットアップ

```bash
# Node 環境
. ~/.nvm/nvm.sh
nvm use 22.22.2

# プロジェクト
cd ~/デスクトップ/k-pdf3
npm install
npm run postinstall   # better-sqlite3 を Electron ABI で rebuild
```

### 11.3 起動・ビルド

```bash
npm start                # Electron 起動（--no-sandbox 付き）
npm run dev              # electronmon 経由（自動 reload／restart、推奨）
npm test                 # 全テスト（380/380 pass）
npm run build:linux      # 配布バイナリ (publish=never)
npm run build:win
npm run build:mac
npm run publish:win      # CI 専用 (publish=always)
```

### 11.4 動作確認の入口

- **architecture が壊れていないか**: `npm test` (380/380)
- **mupdf 経路確認**: `npm run test:render` / `test:render-service`
- **Electron 起動確認**: `npm run dev`、PDF 開いて編集・保存・書き出し・印刷を一巡
- **手動 sanity check**: PDF を開き、テキスト/印影/墨消し配置 → 保存 → 閉じる → 再オープンで復元、Ctrl+E 書き出し、Ctrl+P 印刷、F4 しおり、分割保存、タブ別ウインドウ tearout/dock-back まで一巡

### 11.5 fontconfig 警告

K-PDF2 と同じく、起動時に fontconfig 警告が出る場合があるが機能影響なし。

---

## 12. リポジトリ・配布

### 12.1 GitHub

- **開発リポ**: [windom21-cpu/k-pdf3](https://github.com/windom21-cpu/k-pdf3) (**Public** に変更、2026-05-12 後半)
  - デフォルトブランチ: `main` / GitHub アカウント: windom21-cpu
  - ソースコード一式 + HANDOVER + ADR + CI workflow
  - **Public 化の経緯**: β12〜β32 の連続リリースで GitHub Actions Free 枠 (Private リポ 2,000 分/月) を使い切り → Public 化で Actions 完全無料に。AGPL (mupdf.js) 観点でも installer は既に公衆配布されていたため、source 公開要件を厳密に満たす方向に。HANDOVER.md の個人メアド記載は `git filter-branch` で全 commit/tag から抹消済 (詳細はメモリ `project_kpdf3_repo_public_force_push`)
- **公開リリース feed リポ**: [windom21-cpu/k-pdf3-releases](https://github.com/windom21-cpu/k-pdf3-releases) (**Public**、β5 で新設)
  - 中身はビルド済 installer + `latest*.yml` + `*.blockmap` のみ
  - autoUpdater (`electron-updater`) がここを feed として参照、未認証で読み取り可能
  - 開発リポ → CI (`release.yml`) → fine-grained PAT `RELEASES_REPO_TOKEN` (Contents=Write, Metadata=Read、k-pdf3-releases のみ) で `electron-builder --publish=always` → 自動 push
  - 手動 push 禁止 (CI のみが書き込む)
- **PAT 管理**: 開発リポ Settings → Secrets → Actions に `RELEASES_REPO_TOKEN` を登録、期限 1 year
- **CI 案 B-2** (β34〜、`release.yml`): β タグ (`v*-beta.*`) は **Windows のみ** build、stable タグ (`v[0-9]+.[0-9]+.[0-9]+`) で **3 OS 全部**。β iteration を 10分→5分に短縮、β 配布での matrix race が構造的に消滅。**stable タグでの race リスクは残る** ので stable 時は手動シーケンシャル trigger or `needs:` 化

### 12.2 旧アプリ（業務継続用）

- リポジトリ: [windom21-cpu/k-pdf2](https://github.com/windom21-cpu/k-pdf2)
- 状態: **v0.27.0 で凍結**、hotfix なし
- K-PDF3 β 卒業後、徐々に業務移行

### 12.3 配布計画

- **v2.0.0-beta.1〜β4**: Google Drive 経由でテスターに手動配布 (β5 以前は autoUpdater 無し)
- **v2.0.0-beta.5+**: autoUpdater 経由で自動配布。新規テスター初回のみ Google Drive または k-pdf3-releases の直リンクから installer DL、以降は起動時にダイアログから 1 クリック更新 (β7+ は完全 silent)
- **v2.0.0 stable**: M6 完了時。`releaseType: prerelease` → `release` に切替 (または field 削除) が必要
- 配布フォーマット: Win NSIS (oneClick silent install) + portable / Mac DMG (x64 + arm64) / Linux AppImage + deb

---

## 13. K-PDF2 から継承するもの・捨てるもの

### 13.1 概念として継承

- レトロ UI（98.css + MS UI Gothic）の方向性
- 紙アナロジーの座標系
- IPAex 明朝同梱 (K-PDF2 では未同梱、K-PDF3 では M6 で同梱予定)
- CrashNumberingSerif/Gothic（日付スタンプ用、K-PDF3 では同梱済）
- 真の墨消し（300dpi ラスタ化）
- ページ単位の回転
- しおりの PDF /Outlines 出力
- PDF 分割保存（カットマーカー）
- タブ・detach window (B3 で完成)
- IME 対応 (DOM contentEditable 維持)

### 13.2 完全破棄

- `edits.json` 添付方式 (K-PDF3 では SQLite に置換)
- `pdf.js` (K-PDF3 では mupdf.js に統一)
- `pdf-lib` を保存処理に使う設計 (utility に降格)
- `html2canvas-pro` (v0.27.1 で導入したが完全不要)
- `@pdf-lib/fontkit` (mupdf.js が代替)
- v0.27.1 working tree のすべて
- DOM ベース overlay 描画 (Canvas + DOM hybrid に移行)

### 13.3 K-PDF2 からのコード移植は禁止

K-PDF3 はゼロから設計しているため、K-PDF2 の app.js (約 3,800 行) を「参考にして書き直す」のは避ける。代わりに：

- 機能要件は K-PDF2 の HANDOVER.md (旧) から拾う
- 実装は K-PDF3 architecture に沿って **新規に書き起こす**
- K-PDF2 の関数名・データ構造に縛られない

K-PDF2 のソースが必要な時は `~/デスクトップ/k-pdf2/` を参照 (gitignore 外、ローカルにある)。

---

## 14. AI セッション交代時の注意

### 14.1 着手手順（毎回）

1. このファイル（HANDOVER.md）を §0 → §1 → §2 → §3 → §6 → §8 → §17 の順で読む
2. `docs/adr/` 配下を全部読む（重要設計判断の根拠）
3. `docs/glossary.md` で用語確認
4. `git log --oneline | head -20` で最新コミット確認
5. `npm test` で既存テストが pass しているか確認 (380/380)
6. ROADMAP.md で現在のマイルストーンを確認

### 14.2 architecture-first の維持

- 機能追加の前に「これは architecture を破らないか」を確認
- 破る場合は **新たな ADR を起草してユーザー確認** → 承認後に着手
- 「動けば良い」ではなく「設計通りか」を優先

### 14.3 設計違反を見つけたら

- 直近で書かれたコードに architecture 違反があれば、修正提案を上げる
- 黙って修正するのではなく、ユーザーに「この箇所が依存ルールに違反しています、修正案として X を提案します」と提示

### 14.4 ADR を新設するタイミング

以下のとき、必ず ADR を新設してから実装着手：

- レイヤ構造に影響する変更
- 新しい外部ライブラリの追加
- 保存形式・schema の変更
- 座標系・unit の変更
- 大規模な refactor
- backend 抽象化の変更

ADR ファイル名：`docs/adr/00NN-{slug}.md`、連番。

### 14.5 やってはいけないこと

- HANDOVER.md を黙って大幅編集（明示依頼時のみ）
- ユーザーに無断で `git push --force` / `git reset --hard` 等の destructive 操作
- K-PDF2 から大量コード移植
- pdf.js / html2canvas / React 等の再導入
- pixel 一致を CSS 微調整で誤魔化す

---

## 15. 既知の懸念・残課題

### 15.1 現在の制約・運用上の注意

- **Electron 版数を一時固定** (ADR-0004): better-sqlite3 12.9.0 が Electron 42 の V8 と非互換のため、`electron@^38.8.6` にピン留め中。解除条件は ADR-0004 §解除条件
- **Electron 38 の高セベリティ脆弱性 4 件** (offscreen UAF / clipboard クラッシュ / window.open スコープ): ローカル限定法律実務アプリのため実害低、ただし v2.0.0 stable リリース前に再評価
- **直結 print が落ちる**: OS 印刷ダイアログを `webContents.print({silent:false})` で出すと、ユーザーが dialog を閉じた瞬間に Electron の PDF プラグイン teardown が crash する。**β72 案 D で構造的に解決** (Adobe `/p` でネイティブダイアログを使う = Electron 経路を完全に避ける)
- **空の `fonts/` ディレクトリ**: IPAex は M6 で同梱予定
- **userData 集中保管の副作用**: kpdf3 が `~/.config/K-PDF3/workspaces/` に置かれる (ADR-0007)。machine 間移植は手動コピーが必要。M6 で「workspace export package」UI 検討余地あり
- **書き出しはラスタライズ + ハイブリッド組立**: 編集なしページは元 PDF を vector 維持で copyPages、編集ありは元 vector + 600dpi overlay PNG、回転は embedPdf + drawPage で vector 維持 (β8)

### 15.2 将来の判断ポイント

- **IPAex 明朝の同梱方法** (M6): fonts/ 配下に置く方針は確定。テキスト層 flatten export が要件化したら本格実装
- **qpdf の同梱方法** (M6): sanitize 層が必要になったら electron-builder の `extraResources` で各 OS バイナリ同梱
- **annotation read-only proxy** (M6): /AP がない annotation の表示方針 (マーカーアイコン + ツールチップ案で確定済み)
- **userData の workspace を別 PC へ持ち運ぶ UI** (M6): 現状は手動コピー、export package (zip) で集約する案
- **asset DB 共有 by SHA-256 dedup** (M5 / M6): source_pdf BLOB の重複削減

### 15.3 ADR 状況

| ADR | 内容 | 状態 |
|---|---|---|
| 0001 | workspace 保存形式 = SQLite | ✅ |
| 0002 | mupdf layout engine 採用 | ✅ |
| 0003 | canonical coordinate (PDF point 72dpi / top-left / 紙アナロジー) | ✅ |
| 0004 | Electron `^38.8.6` 一時固定 (better-sqlite3 互換) | ✅ |
| 0005 | Electron 内テスト runner (`test/electron-runner.cjs`) | ✅ |
| 0006 | PDF-first UX + 98.css vendored | ✅ |
| 0007 | userData/workspaces 集中保管 + fingerprint 索引 | ✅ |
| 0008 | exports BLOB 廃止、Smart Save As | ✅ |
| 0009 | ページ削除 (is_deleted + pending workflow) | ✅ |
| 0010 | ページ挿入 (inserted_pages + 負 pageNo + synthetic) | ✅ |
| 0011 | Save As workspace 切替 (Word 流) | ✅ |
| 0012 | HiDPI render quality (DPR 連動 oversample) | ✅ |
| 0013 | 自前タイトルバー + ファイルダイアログ (frame:false) | ✅ |
| 0014 | 編集可能しおり (workspace bookmarks + /Outlines write-back) | ✅ |
| 0015 | タブ + multi-window (案 B: renderer 主体タブ管理 + main per-window active 維持、Phase 1-7 で実装、B3 で別ウインドウ D&D 完成) | ✅ |
| 0016 | stamp templates MVP (ADR-0019 へ吸収予定) | ✅ |
| 0017 | image stamps / asset library | ⏳ 起草待ち (実装は MVP 済) |
| 0018 | asset DB / source_pdf BLOB 共有 | ⏳ 容量肥大が現実化したら起草 |
| 0019 | stamp preset management (全角/半角フォント別 + image PDF プレ押印) | 🚧 起草中 (実装は完了) |

### 15.4 architecture decision 待ち（未確定）

- 共通 asset library の DB 配置: アプリ全体で 1 つの SQLite ファイル (`~/.config/K-PDF3/assets.db`) に保存する方針はユーザー承認済。実装は M6
- パスワード保護 PDF 対応: 将来検討
- ブランディング: アプリ表示名は K-PDF2 のまま維持 (リポジトリ名のみ k-pdf3)

### 15.5 リファクタ候補

- **S6 (split-view + sidebar-thumbs 抽出)**: B2 残置責務。緊急性なし
- **`workspaceMutated` フラグは hacky**: 挿入も pending workflow に統合する方が綺麗 (temp pageNo 採番 + Ctrl+S で flush)。ただし削除と並列管理になり複雑度増、現状の hack で実用上は十分
- **テストカバレッジ不足**: 2026-05-10 以降の追加機能 (ページ削除 / 挿入 / Save As / 検索 / スタンプ管理 / 画像スタンプ / 編集可能しおり / callout / タブ別ウインドウ) は手動確認のみ。Electron runner で round-trip テストを追加すべき

---

## 16. 引き継ぎ運用

### 16.1 HANDOVER.md 更新ルール

- **明示的に依頼された時のみ大幅更新**
- マイルストーン完了時は §6.3 の状態欄と §7（実装済み機能）を更新
- 新しい ADR を起草したら §4.5 / §15.3 に反映

### 16.2 バージョンバンプ運用

- マイルストーン完了ごとに pre-release タグ (例: `v2.0.0-alpha.M2`)
- M5 完了で `v2.0.0-beta.1`
- M6 完了で `v2.0.0`
- 影響箇所:
  1. `package.json` の `version`
  2. `package-lock.json` の `version`
  3. About ダイアログ表示は package.json から動的取得

### 16.3 コミット運用

- メッセージ規約: Conventional Commits (feat / fix / chore / docs / refactor / test / diag)
- マイルストーン完了は `feat(MN): ...` のプレフィックス
- 重要な commit には Co-Authored-By を残す
- destructive 操作 (force push / reset --hard) は **ユーザーの明示同意なしに行わない**

### 16.4 Pull Request

- 個人 + スタッフ規模なので main 直接コミット OK
- 大規模変更 (新マイルストーン) は feature ブランチ + PR が推奨
- マージ前に `npm test` 必須

---

## 17. ユーザー要望タスクリスト

§17.1-17.9 / §17.11-17.16 は完了済 (詳細は git log / commit message)。未完了は **§17.2 (D&D OUT)** と **§17.4 ライブ同期版 (B3 で代替可能)** のみ。

### 完了済タスク (要点のみ)

| # | 要望 | 完了 |
|---|---|---|
| 17.1 | 警告ダイアログの独自モーダル化 | ✅ 2026-05-10 |
| 17.3 | サムネ間に外部 PDF を D&D 挿入 | ✅ 2026-05-10 (image-backed synthetic) |
| 17.4 (prelim) | 別ウインドウでページ分離表示 (スナップショット型 popup) | ✅ 2026-05-11 β2 (📌 always-on-top) |
| 17.5 | スタンプ管理実装 (M6 大物) | ✅ 2026-05-10/11 (日付4種 / テキスト / 画像 / フォント設定 / 全 PDF 共通 stamps.db / 画像スタンプ色 tint) |
| 17.6 | マーカー機能 | ✅ 2026-05-10 (4 色 + opacity 0.3 + thumb 反映) |
| 17.7 | 吹き出しテキスト | ✅ 2026-05-10 (rect/callout + 折返し + 矢印先端ハンドル) |
| 17.8 | テキスト入力時のカーソル / 配置位置 | ✅ 2026-05-10 (I-beam + 垂直中心一致) |
| 17.9 | テキストのフォント指定 | ✅ 2026-05-10 (明朝/ゴシック/Serif/Sans、デフォルト明朝、localStorage 永続) |
| 17.10 | タブのウインドウ外 D&D | ✅ 2026-05-15 β71 (B3、5 経路) |
| 17.11 | 回転機能 | ✅ 2026-05-10 (toolbar + サムネ右クリック + 挿入ページも対応 + overlay 紙メタファ追従) |
| 17.12 | フォントサイズ調整 | ✅ 2026-05-10 (8/10/12/14/18/24/36 プリセット) |
| 17.13 | 墨消し白 | ✅ 2026-05-10 (黒/白 select、localStorage 永続) |
| 17.14 | しおり追加・編集 (互換性維持) | ✅ 2026-05-10/11/β3 (workspace bookmarks + 階層 + drag-reorder + 自動取込 + /Outlines write-back UTF-16BE 再帰) |
| 17.15 | 自動アップデート組込み | ✅ β5 (electron-updater + 98 風 confirm/busy + 公開 feed リポ) |
| 17.16 | β3→β4 テスター指摘 14 件 | ✅ β4-β8 (詳細は §6.4 表) |

### 未完了

#### 17.2 サムネ → アプリ外への D&D で当該ページを名前付き保存 🚧 MVP 完了

サイドバーまたは分割保存のサムネを、デスクトップ等に D&D したら、そのページだけを抽出して新規 PDF として保存。

**現状**: サムネ右クリック → 「このページを PDF として保存…」/ 「N ページを PDF として保存…」 で代替済。純粋な D&D OUT は Electron `startDrag` の sync 問題があり別セッションで検討。

#### 17.4 別ウインドウでページ分離表示 (ライブ同期版) 🚧 代替可能

β2 で MVP 完了のスナップショット型 popup (`actionOpenPagePopup`) は「特定 1 ページだけを軽量に並べたい」用途で残置。**ライブ同期版が必要なら B3 (β71) の「タブを別ウインドウへ分離」で代替可能**。

#### サムネ D&D で別ウインドウへ選択ページ挿入 (新規、設計済・未着手)

A ウインドウのサムネ複数選択 → B のサイドバー or 分割画面 gap にドロップ → 選択ページだけ B に synthetic page として挿入。B3-γ `activeTabDrag` の page 版を main に新設、`addInsertedPdfPages` を `pageIndices?: number[]` 対応に拡張。~150 行/半日。詳細は auto-memory `[[thumb-cross-window-insert]]`。

---

## 18. ユーザー要件・嗜好（メモリ情報）

### 18.1 最重要要件

- **「レトロなアプリの再現を重要視」** (98 風)
- ローカル完結 (個人情報を扱うため、クラウド送信 NG)
- 配布範囲: 自分中心 + スタッフ数名 (Public リポになったが、業務的に隠す価値のあるノウハウ無し)

### 18.2 UI / フォント

- UI フォント: **MS UI Gothic** (2026-05-10 で確定、Kosugi は不採用)
- PDF 出力フォント: **IPAex 明朝** (M6 で同梱必須)
- 日付スタンプ用: **CrashNumberingSerif** (PSY/OPS Freeware、同梱)
- 文字レンダ: AA off、`font-render-hinting=none`、`disable-font-subpixel-positioning` で pixel-grid 寄せ

### 18.3 業務想定

- 法律実務 (回転日付印書式 `-8.-5.-7`、真の墨消し、再編集可能保存)
- 提出版の真正性確保 (workspace 内に export 履歴メタ保管)
- iPad 双方向ワークフローは **諦める** (§13.2)

### 18.4 ユーザー属性（再掲、§3.1 とリンク）

- 法律実務家、プログラミングは素人
- 業務で K-PDF2 v0.27.0 を継続利用中
- 全面作り直しの 6〜10 週間業務凍結を許容

---

## 付録 A：用語クイックリファレンス

| 用語 | 意味 | 詳細 |
|---|---|---|
| workspace | `.kpdf3` 単一 SQLite ファイル | docs/glossary.md |
| project | 1 workspace = 1 project | docs/glossary.md |
| canonical coordinate | PDF point 72dpi / top-left / 紙アナロジー | docs/adr/0003 |
| overlay object | text/stamp/image 等の編集対象 | §9.3 |
| source PDF | 編集の出発点となる元 PDF (immutable) | docs/glossary.md |
| synthetic page | 挿入された白紙 / テキスト / 外部 PDF page、negative pageNo | ADR-0010 |
| export | workspace → flatten PDF | docs/glossary.md |
| ハイブリッド組立 | source / overlay / full / external の per-page 戦略 | §7.3 |
| 案 D 印刷 | Adobe `/p` でネイティブダイアログ直接起動 (β72) | §7.3 |
| 案 X | Win32_PrintJob 監視で Pro DC を auto-kill (β72) | §6.4 |
| secure export | metadata strip 等を施した export (M6 残務) | §15.2 |
| revision id | export ごとに発行される ID | docs/glossary.md |
| dirty | workspace 未保存 (overlay / 削除 / 挿入) | docs/glossary.md |
| unexported | 最後の export 以降に変更あり | docs/glossary.md |
| safe mode | source PDF mismatch 時の停止モード | docs/glossary.md |

---

## 付録 B：困った時のチェックリスト

### 「機能が増えていくほど構造が乱れている気がする」

→ **§2 を再読**。3-layer 分離が破られていないか確認。違反箇所を ADR で議論。

### 「位置がずれる」「pixel 一致しない」

→ **§2.5 禁止事項に該当しないか**。CSS 微調整で誤魔化していないか。layout engine が viewer / pdf 両方で同じか確認。

### 「複雑な実装になりそう」

→ **§2.1 architecture-first 原則**。簡単な構造で書けないか再考。ADR で議論。

### 「ユーザーへの確認が必要かわからない」

→ **§3 ユーザー協働方針**。判断材料を整理して提示し、選択を仰ぐ。決め打ちしない。

### 「セッションが進まない / コードベースが大きすぎる」

→ **§14 AI セッション交代時の注意**。着手前のチェックリストを実行。renderer.js は §4.4 のモジュール構成表で責務を辿る。

---

以上。質問があれば過去の git log (`git log --oneline`)、`docs/adr/`、`docs/glossary.md`、ユーザーのメモリディレクトリ (`~/.claude/projects/-home-sk--------k-pdf3/memory/`) も参照しつつ進めてください。

新しいセッションでは、まず以下を実行してから着手すること：

```bash
cd ~/デスクトップ/k-pdf3
git fetch --all --tags --force
git pull --ff-only origin main
git log --oneline | head -20
npm test
```
