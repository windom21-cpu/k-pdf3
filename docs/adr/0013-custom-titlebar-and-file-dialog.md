# ADR-0013: 自前タイトルバー（frame:false）と自前ファイルダイアログ

- 日付: 2026-05-10
- ステータス: 採用
- 関連: ADR-0006（PDF-first UX + 98.css）、HANDOVER §7.6.7 / §7.6.8

## Context

UX 一貫性の問題：

1. **OS ネイティブのタイトルバー**は GNOME / Windows 11 / macOS のモダンスタイル。98 風レトロ UI（ADR-0006）と並ぶと違和感が強い。タイトルバー単独でユーザーから「ここだけ今風で浮いている」と複数回フィードバック
2. **`dialog.showOpenDialog` / `showSaveDialog`（Electron 標準）** は OS の File Picker を呼び出す。GNOME GTK4 dialog / macOS Finder pane / Windows 11 sheet。同じく 98 風 UI の中で違和感が強い
3. ネイティブダイアログは Wayland / fractional scaling 環境で位置・フォーカス周りに小さなバグがあり、`focus` イベントの取りこぼしや透明化されることがあった（Linux + Electron 38）

要件：

- 全ての UI 要素を 98.css スタイルで統一
- HiDPI / fractional scaling で安定動作
- タイトルバーの最小化・最大化・閉じる動作は OS native と同等の挙動
- フォルダ選択・PDF 開く・名前を付けて保存 を全て同じ UI で
- ファイル一覧、移動、quick selector（Home / Desktop / Documents / Downloads）を備える

## Decision

### 1. `frame: false` BrowserWindow

`createMainWindow()` の `new BrowserWindow({ ..., frame: false, ... })` で OS chrome を完全に無効化。代わりに renderer 側で `index.html` の最上部に `<div class="title-bar">` を Win95 風スタイルで描画。

### 2. ドラッグ可能領域 + 操作ボタン

CSS `app-region: drag` でタイトルバーの空白部分は OS にウインドウ移動として扱わせる。ボタン要素のみ `app-region: no-drag`：

- 最小化 (`_`)
- 最大化／復元（toggle、現在の状態に応じて glyph と tooltip が切替）
- 閉じる (`✕`)

各ボタンは preload 経由の IPC を呼ぶ：

```
windowMinimize       → kpdf3:window-minimize
windowMaximizeToggle → kpdf3:window-maximize-toggle
windowClose          → kpdf3:window-close
windowIsMaximized    → kpdf3:window-is-maximized
```

### 3. 最大化状態の同期 — push notification

ユーザーが OS のショートカット（Super+Up 等）で最大化／復元した場合、ボタン自身を押した訳ではないので renderer は知る術がない。main process から push する：

```js
mainWindow.on("maximize",   broadcastMax);
mainWindow.on("unmaximize", broadcastMax);
function broadcastMax() {
  mainWindow.webContents.send("kpdf3:window-state",
    { maximized: mainWindow.isMaximized() });
}
```

renderer は `kpdf3.onWindowState(cb)` で subscribe し、`setMaximizedGlyph(isMax)` で glyph と tooltip を切替。

### 4. 自前ファイルダイアログ — 3 モード

`showFileBrowser({ mode, ... })` 1 関数で全モードを処理：

| mode | 用途 | UI 表示 |
|---|---|---|
| `open` | PDF を開く | フィルタ行表示、ファイル名行表示（任意） |
| `save` | 名前を付けて保存 | フィルタ行表示、ファイル名行表示（必須） |
| `folder` | フォルダ選択 | フィルタ・ファイル名行は hide、確定ボタン「このフォルダを選択」 |

### 5. ファイル一覧の取得 — `kpdf3:list-directory` IPC

main process が Node.js の `readdir({ withFileTypes: true })` + `stat` でディレクトリを列挙：

- 隠しファイル（`.` で始まる）は除外
- フォルダがファイルより上、それぞれ locale-aware (`ja`) ソート
- 各 entry に `{ name, isDir, size, mtimeMs }`

戻り値：`{ path, parent, entries }` または `{ path, parent: null, entries: [], error }`。renderer はこれをそのままリスト UI に流し込む。

### 6. quick selector — `kpdf3:get-default-paths`

Electron の `app.getPath()` で得られる `home / desktop / documents / downloads` を渡す。`<select>` に 4 項目（と「現在の場所」）。選択で即移動。

### 7. 永続化 — `localStorage`

「最後に開いていたディレクトリ」を `kpdf3.lastBrowseDir` に保存。次回起動時に既定ディレクトリとして復元（OS native dialog の `defaultPath` 相当）。

### 8. Save モードの初期ファイル名

`initialName` を input に流し、stem（拡張子除く）を selectionRange で選択。ユーザーがそのまま typing するとリネームになる（Windows / macOS の Save dialog と同じ挙動）。

### 9. その他のキー操作

- Enter で確定（current selection or filename input）
- Esc / 背景クリックでキャンセル
- ↑ ボタンで親ディレクトリ
- 二重クリックでフォルダ移動（open mode の PDF は二重クリックで即 open）

### 10. drop で PDF 開く

タイトルバー / ビューア領域での dragover + drop を listen。`webUtils.getPathForFile(file)`（preload 経由）で path を取得（Electron 32+ で `File.path` が removed）→ `openPdfPath(path)`。

## Why この選択肢か

### タイトルバー側

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. frame:false + 自前 title bar（採用）** | ✅ | UI 完全統一、Wayland バグ回避、push 同期で挙動一致 |
| B. titleBarStyle: 'hidden' | ❌ | macOS 専用機能、cross-platform 一貫性に欠ける |
| C. OS native のまま諦める | ❌ | レトロ UI 一貫性が著しく損なわれる（HANDOVER §18.1）|

### ファイルダイアログ側

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. 自前ファイルダイアログ（採用）** | ✅ | UI 完全統一、Wayland / HiDPI で安定、quick selector / lastBrowseDir 等を自由に追加 |
| B. dialog.showOpenDialog のまま | ❌ | OS chrome、ADR-0006 の 98.css 統一に反する |
| C. dialog を 98 風 webview iframe で wrap | ❌ | 過剰実装、OS のセキュリティモデルと衝突 |

3 モードを 1 関数 `showFileBrowser` に統合した理由：UI コンポーネント（リスト、フィルタ行、ファイル名行）はほぼ共通で、mode フラグで 1〜2 行を hide/show すれば済む。3 関数に分けると `index.html` 上のダイアログ DOM が 3 倍になり保守性が悪化。

## Consequences

### 受け入れる trade-off

#### 1. 自前実装ゆえの再発明コスト

- フォルダ移動・ソート・フィルタの基本は自前
- 隠しファイル切替、新規フォルダ作成、検索 などのリッチ機能は無し（M6 で必要に応じ追加）
- アクセシビリティ（screen reader 経由）は OS native より弱い

#### 2. OS のショートカット非対応

- macOS の `⌘⇧.` で隠しファイル切替、Linux の Ctrl+L でパス入力 は無い
- 実用上はファイル名 input にフルパスを直接入力すれば動く（`isAbsolute` 判定で対応済）

#### 3. タイトルバーで OS 標準のスナップ機能が一部失われる可能性

GNOME 系では super+左/右 でスナップ動作するが、独自タイトルバーのドラッグでは画面端アサイメントが OS native と若干違う。実害は少ない。

#### 4. push 同期の取りこぼしリスク

`kpdf3:window-state` の subscribe が遅延すると、最大化 glyph が一瞬古い状態になる。実害なし。

### 影響範囲

- `src/main/main.js`:
  - `BrowserWindow` の `frame: false`
  - `kpdf3:window-minimize` / `maximize-toggle` / `close` / `is-maximized` IPC
  - `mainWindow.on("maximize" / "unmaximize")` で push
  - `kpdf3:list-directory` / `kpdf3:get-default-paths` / `kpdf3:get-export-defaults` / `kpdf3:file-exists` IPC
- `src/main/preload.cjs`:
  - 上記 IPC の bindings
  - `webUtils.getPathForFile` shim
  - `onWindowState(cb)` で push 受信
- `src/renderer/index.html`:
  - title bar `<div class="title-bar">`
  - file browser dialog `<div id="open-dialog">`
- `src/renderer/style.css`: 98 風タイトルバー / ボタン / リスト / フィルタ行 / ファイル名行
- `src/renderer/renderer.js`:
  - `setMaximizedGlyph(isMax)`、ボタン listener
  - `kpdf3.onWindowState(cb)` 登録
  - `showFileBrowser({mode, ...})` + helper（`loadFileBrowserDir` / `populateQuickSelector` / `selectFileEntry` / `activateFileEntry` / `handleFileBrowserConfirm` / `fileBrowserCancel` / `classifyEntry` / `shouldShowEntry` / `renderFileBrowserList`）

### 解除条件

- アクセシビリティ要件が硬くなったら native dialog を opt-in で残す（環境変数や設定で切替）
- macOS で「ウインドウのトラフィックライト 3 ボタン」を要求されたら titleBarStyle: 'hidden' を併用してネイティブのボタンだけ残し、それ以外を自前で組む構成に切替

## 検証

- 380 テストは継続 pass（UI 系は手動確認）
- 手動：
  - タイトルバーの 3 ボタンがそれぞれ動作、最大化／復元の glyph が同期
  - Super+Up（GNOME）で最大化 → glyph も復元アイコンに変化
  - 「PDF を開く」で自前 dialog が表示、quick selector で Desktop 移動 → 二重クリックで open
  - 「名前を付けて保存」で初期 stem が selected → Backspace で消去 → typing → Enter で保存
  - 「フォルダの選択」モードでファイル行が hide、フィルタ行も hide
  - PDF を window に drop → 開く
  - 直接フルパス入力（save mode）→ 確定で保存
