# ADR-0015: タブ実装（multi-workspace）— 設計編

- 日付: 2026-05-10
- ステータス: 提案（実装着手前。次セッションで本実装）
- 関連: HANDOVER §8.3、§17.4（別ウインドウ表示はタブ実装の上に乗る）、§17.10（タブ D&D）、ADR-0007（workspace 集中保管）

## Context

K-PDF3 の現状は **1 ウインドウ = 1 PDF**：

- main process に `activeWorkspace` / `activeDoc` / `activeSourcePdfPath` がモジュール変数で 1 つだけ
- renderer に `projectStore` / `history` / `viewer` / `pendingDeletedPages` / `workspaceMutated` / `activeSourceName` などのモジュール変数も 1 つだけ
- ファイル > 開く で別 PDF を開くと **既存ファイルが閉じる**

法律実務では「複数 PDF を同時に開いて見比べたい / overlay を相互参照したい」が頻出するので、**タブで複数 workspace を並列に持つ** ことが M5 正式 exit の主要要件（§8.2 F-16）。

別ウインドウ表示（§17.4）も「タブを切り離して別ウインドウに」という構図で実現するため、タブ実装が前提になる。

## Decision

### 1. タブ単位の状態セット

renderer の現 module-level state を `TabState` 構造体にまとめる：

```js
type TabState = {
  id: string;                   // UUID
  workspaceId: string;          // main 側で使う識別子（ADR-0007 fingerprint または別キー）
  sourcePdfPath: string;        // ディスク上のパス（タイトル表示用）
  sourceName: string;           // basename
  projectStore: ProjectStore;
  history: HistoryStack;
  pendingDeletedPages: Set<number>;
  workspaceMutated: boolean;
  thumbCache: Map<number, HTMLCanvasElement>;
  splitState: { ... };
  scrollPosition: number;       // タブ切替時に復元
  zoomMode: "fixed" | "fit-width" | "fit-page";
  zoom: number;
  placementMode: string;
  // ... etc
};

const tabs: Map<string, TabState> = new Map();
let activeTabId: string | null = null;
```

**最小限の侵襲**で済むように：
- viewer は **単一インスタンス**を使い回し、タブ切替時に `viewer.unload()` + `viewer.load(activeTab.pages)`
- projectStore / history はタブごと別インスタンス（subscription も切替時に張り替え）
- thumbCache / splitState もタブごと

### 2. main 側の対応

#### 案 A: `activeWorkspace` を Map 化、IPC が workspaceId を引数に取る

```js
const workspaces = new Map<string, { ws: Workspace, doc: PDFDocument, pages: PageRow[] }>();

ipcMain.handle("kpdf3:render-page", (_, workspaceId, pageNo, opts) => {
  const w = workspaces.get(workspaceId);
  ...
});
```

利点：完全に独立、並列で safe
欠点：全 IPC が workspaceId 引数を持つ大改修

#### 案 B: main 側で「フォーカス中のタブ」を 1 つ記憶、renderer は switch-tab IPC で通知

```js
ipcMain.handle("kpdf3:switch-tab", (_, tabId) => {
  // 内部で activeWorkspace / activeDoc を切替
});
// 既存 IPC は activeWorkspace を見るので変更ゼロ
```

利点：IPC API 変更なし
欠点：本当に並列にレンダリング走るとき干渉（例：タブ A の thumb 描画中にタブ B に切替 + 描画リクエスト）。ただし renderer 側で **1 タブずつ** にする運用なら問題なし

**推奨：案 B から始める**。renderer 側で並列リクエストを抑制するのは元々現状そう動いている（_ensureRendered の pendingRenders）。ファイル数が少ない（同時 2-5 タブ）なら案 B で十分。並列レンダリングが本当に必要になったら案 A への移行は後付け可能。

### 3. タブバー UI

`title-bar` と `menu-bar` の間に新しい行：

```html
<div class="tab-bar">
  <div class="tab-item is-active" data-tab-id="...">
    <span class="tab-title">001.pdf</span>
    <span class="tab-dirty-mark">●</span>  <!-- isDirty 時 -->
    <button class="tab-close">×</button>
  </div>
  <div class="tab-item" data-tab-id="...">...</div>
  <button class="tab-add">+</button>
</div>
```

98.css 風の四角タブ + 区切り線 + クリックで切替。

### 4. 新規タブ動作

ファイル > 開く / Ctrl+O：

- 現状：`actionOpen` → `confirmDiscardIfDirty` → `openPdfPath`（既存ワークスペースを閉じる）
- 新仕様：常に **新タブで開く**。ユーザーが「ここに追加」したいなら + ボタンで新タブ → 開く、現在のタブで再度開きたいなら「ファイル > このタブで開き直す」（別メニュー項目）

ドロップで PDF を開く動作も同じ（新タブで開く）。

### 5. タブ切替

`switchToTab(tabId)`:
1. 現タブの `viewer.scrollPosition` を保存
2. `viewer.unload()`
3. activeTabId = tabId
4. main に `kpdf3:switch-tab` を送信
5. `viewer.load(activeTab.pages)`
6. projectStore の subscriber を再 wire（古い subscriber を unsubscribe）
7. zoom / placementMode 復元
8. scrollPosition 復元

各 `refresh*` 関数（refreshViewer, refreshBookmarks, rebuildThumbs, ...）は **常に活性タブの状態を見る**。

### 6. dirty 警告 — タブ単位 + ウインドウ閉じ時一括

- タブの × ボタン押下 → `confirmDiscardIfDirty(tab)` でそのタブだけ確認
- ウインドウ閉じ時 → 全 dirty タブを集めて「**3 つのタブに未保存の変更があります。すべて破棄しますか？**」のような一括確認

### 7. タブの外部 D&D（§17.10）— タブ実装後の追加

タブ要素の dragstart で「タブ自体」を drag。drop:
- 同じウインドウのタブバーの別位置 → タブ並び替え
- ウインドウの**外**へ drop → 切り離して新ウインドウ（main process がタブの state を新 BrowserWindow に転送）
- 別ウインドウのタブバーへ drop → 合流

これはタブ実装の主要部が安定してから着手する続編。

### 8. 別ウインドウ表示（§17.4）— タブ実装の自然な発展

「このタブを別ウインドウで開く」コマンド = タブ切り離しと等価。タブ D&D が実装されればコマンド経由でも実行可能。

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **案 B (main は 1 active、renderer がタブ管理)** | ✅ | IPC API 変更最小、現実装からの移行が漸進的、十分な並列度 |
| 案 A (main も Map 化、IPC に workspaceId) | ⏳ 後付け | 真の並列が要件化したら検討 |
| C. タブを諦めてウインドウを増やす | ❌ | OS のタスクバーが汚れる、ユーザー操作も煩雑 |
| D. タブ風 UI だが内部は単一 workspace（state 切替で擬似多重） | ❌ | タブと言いつつ open 1 つは混乱の元、せっかくの編集状態を失う |

## Consequences

### 受け入れる trade-off

#### 1. renderer.js の更なる肥大

現在 3700+ 行、タブ実装でさらに 500-800 行程度追加見込み。**実装着手前に renderer.js のモジュール分離リファクタが必要**（§15.6 候補）：

- file-browser.js / print-preview.js / search.js / sidebar-thumbs.js / split-save.js / insert-dialog.js / bookmark-pane.js / stamp-presets.js / callout-mode.js / marker-mode.js / etc.

このリファクタを ADR-0015 実装の **前段** に組み込む。

#### 2. メモリ消費

3-5 タブ × 50 MB PDF = 150-250 MB の renderer メモリ + main 側 mupdf も同様。viewport は単一 viewer なので canvas は 1 タブ分。実用上 OK の見込み。

#### 3. グローバル状態の依存箇所が多い

`pendingDeletedPages` / `workspaceMutated` / `activeSourceName` 等が renderer 全体に散らばっている。リファクタ + TabState 化が必要。「ガンガン」session ではなく腰を据えた設計セッションが望ましい。

### 影響範囲（推定）

- `src/main/main.js`: `activeWorkspace` 制御に switchTab を加える（Map 化はしない）
- `src/main/preload.cjs`: `kpdf3:switch-tab` / `close-tab` IPC bindings
- `src/renderer/index.html`: タブバー DOM
- `src/renderer/style.css`: タブバー 98 風スタイル
- `src/renderer/renderer.js`: TabState 構造化、各 refresh / action 関数のタブ awareness
- 新規 `src/renderer/tab-bar.js`: タブバー専用ロジック

### 解除条件 / 後続

- **真の並列レンダリング** が要件化したら案 A への移行（main の Map 化 + IPC に workspaceId）
- **タブの永続化**（ウインドウ閉じ → 再開で復元）はさらなる ADR 候補

## 検証

実装後の手動確認チェックリスト：

- [ ] ファイル > 開く で新タブが追加される
- [ ] タブクリックで viewer / sidebar / split-save / overlay 編集モードが切替
- [ ] 各タブで独立に dirty フラグが立つ
- [ ] タブの × ボタンで dirty 確認ダイアログ
- [ ] ウインドウ閉じ時に複数 dirty タブを集約確認
- [ ] Ctrl+W (実装するなら) で active タブを閉じる
- [ ] Ctrl+Tab (実装するなら) で次のタブへ切替
- [ ] タブごとの zoom / placementMode / scrollPosition が独立
- [ ] サムネ / split / 検索 / 印刷 / export が活性タブの内容で動く

## 着手前のリファクタ（前提条件）

ADR-0015 本実装の前に **必ず** やる：

1. `src/renderer/renderer.js` を 8-10 個のモジュールに分割
2. 「現在の active state」を表す const / let を 1 ヶ所に集約
3. `refreshViewer` / `refreshBookmarks` / `rebuildThumbs` 等を「state を引数で受ける」純関数に近づける

このリファクタが終わってからタブ化に着手すると衝突が圧倒的に少ない。先にタブをやろうとすると 80% 詰む。
