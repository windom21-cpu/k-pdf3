# ADR-0016: スタンプテンプレート（MVP）— 印 + 日付スタンプ + 色

- 日付: 2026-05-10
- ステータス: 採用（MVP のみ）。フル「スタンプ管理」UI（プリセット保存・編集ダイアログ）は後続 ADR
- 関連: HANDOVER §17.5、§18.3（業務想定 — 回転日付印）

## Context

法律実務でのスタンプ需要：

- **日付印** — 提出日や受領日を頻繁に押す。「令和8年5月9日」表記と短縮 (8.5.9) 表記の 2 つが定着している
- **印影 (印)** — 自分の認印・記名印を画像で押す（将来）
- **テキストスタンプ** — 「写」「副本」「秘」など定型テキスト
- 共通：色（朱・黒・青）、枠（あり / なし、丸 / 角）

§17.5 の正式仕様は「**プリセット保存・編集ダイアログ**」「**画像スタンプ**」「**フォント別指定（全角・英数字を別々に）**」を含むフル UI。これらは：

- スキーマ拡張（assets テーブル連携、stamp_presets テーブル）
- 専用編集ダイアログ
- 画像 D&D / クリップボードからの取り込み

を含み、**ADR・実装ともに 1 セッション以上の規模**。一気に進めるとスコープがぶれて中途半端になる。

そこで本 ADR では **「ガンガン進める」session でも実装可能な subset** を定義し、フル機能は後続 ADR（仮 0017 画像スタンプ / 後続 0019 プリセット管理）に分割する。

## Decision

### 1. スコープ — 3 種類の hardcoded テンプレート + 色 select

toolbar の 印影 ボタン横に 2 つの inline select を追加：

```html
<select id="stamp-template">
  <option value="default">印</option>
  <option value="date-numeric">日付 (8.5.9)</option>
  <option value="date-kanji">日付 (令和8年5月9日)</option>
</select>
<select id="stamp-color">
  <option value="#cc0000">朱</option>
  <option value="#000000">黒</option>
  <option value="#1f4ea1">青</option>
</select>
```

選択 → スタンプモードへ自動切替（redaction-color と同じ UX）→ クリックで配置。

### 2. テンプレート定義（renderer 側、`currentStampPreset()`）

```js
function currentStampPreset() {
  const tmpl = stampTemplateSel?.value || "default";
  const color = stampColorSel?.value || "#cc0000";
  if (tmpl === "date-numeric") {
    const d = new Date();
    const reiwa = d.getFullYear() - 2018;
    const text = `${reiwa}.${d.getMonth() + 1}.${d.getDate()}`;
    return { text, w: 90, h: 40, frame: "rect", fontSize: 13, color };
  }
  if (tmpl === "date-kanji") {
    const d = new Date();
    const reiwa = d.getFullYear() - 2018;
    const text = `令和${reiwa}年${d.getMonth() + 1}月${d.getDate()}日`;
    return { text, w: 130, h: 40, frame: "rect", fontSize: 13, color };
  }
  return { text: "印", w: 60, h: 60, frame: "circle", fontSize: 14, color };
}
```

- **令和年は `year - 2018`**（令和元年 = 2019 年）
- 配置時に `new Date()` を読むので **同じ template で連続クリックすればその日の日付が複数押せる**（年/月/日をまたぐ配置がしたければ template を変えて再配置）
- 日付スタンプは矩形（90×40 / 130×40）、印は円（60×60）

### 3. 色 + 枠の永続化

- `localStorage.setItem("kpdf3.stampTemplate", template)`
- `localStorage.setItem("kpdf3.stampColor", color)`
- 起動時に restore

### 4. ghost preview もテンプレート反映

§17.6 で導入したスタンプ ghost（カーソル追従プレビュー）を `currentStampPreset()` ベースに変更：

- ghost のサイズ・色・テキスト・枠（circle / rect）が選択中テンプレートに連動
- 選択 select を変えた瞬間にプレビュー更新（mousemove で `updateStampGhostSize()` も呼ぶ）

これにより「これから何を押すか」が cursor 上で確認できる。

### 5. スキーマ拡張なし

既存 stamp overlay（type='stamp'）の properties 構造をそのまま使う：
- `kind: 'text-frame'`, `text`, `color`, `frame: 'circle' | 'rect'`, `fontSize`, `rotation`

新しい kind / type 不要。**migration 不要**。

### 6. プリセット保存・編集 UI は後送り

ADR 0019（仮）で扱う：

- プリセット定義テーブル（workspace 単位 or アプリ全体？という議論）
- 編集ダイアログ（テキスト / 色 / 枠 / フォント別指定）
- 画像スタンプは別 ADR-0017（仮、assets 連携）

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. hardcoded テンプレ 3 種 + 色（採用）** | ✅ | 法律実務の 90% カバー、実装 30 分、スキーマ変更ゼロ |
| B. プリセット管理ダイアログ込みフル実装 | ❌ | スコープ ≧ 1 セッション、中途半端なリスク |
| C. 「印影」ボタンを廃止して新「スタンプメニュー」へ移行 | ❌ | 既存ユーザーの toolbar 慣れを破壊、ADR-0006 の Win95 方針と整合しにくい |
| D. 日付スタンプを別 toolbar ボタンとして分離 | ❌ | toolbar 表面積が増える、印 と 日付 は同じ「スタンプ」概念 |

色選択を分けた select にしたのは：「選んだ瞬間にスタンプモードに自動遷移する」UX（redaction-color、text-font と同じパターン）を保つため。

## Consequences

### 受け入れる trade-off

#### 1. ユーザー定義のスタンプができない

「自分の事務所名スタンプ」「特定案件用」のような custom テキストは MVP では作れない。回避策：

- 配置後に inline edit で text を変更（既存機能）
- ただし**毎回手で typing する必要があり**、preset を保存できない

これが業務で苦痛になったタイミングで ADR-0019（プリセット管理）に着手。

#### 2. 画像スタンプ（印影画像）が押せない

法律事務所の認印・記名印は画像で持っているケースが多い。MVP の文字スタンプ「印」は代替表示。assets テーブルとの連携が ADR-0017 で必要。

#### 3. 全角フォントと英数字フォントの分離指定なし

§17.5 では「全角は明朝、英数字は Times」のような独立指定が要件にあるが、本 MVP は全文字同一フォント（fontSize 13、デフォルトの stamp font stack）。これも後続 ADR で。

#### 4. 令和元年 = 2019 年の hardcode

平成→令和の改元は明確だが、将来の改元時に hardcode 変更が必要。元号テーブル化は overengineering なので now 採用しない。次の改元タイミングで micro-ADR 起草。

### 影響範囲

- `src/renderer/index.html`: 印影ボタン横に `#stamp-template` / `#stamp-color` の 2 つの select
- `src/renderer/renderer.js`:
  - `currentStampPreset()` 関数
  - `placeStamp()` を preset ベースに書き換え
  - `updateStampGhostPreset()` で ghost 表示を preset 連動
  - 各 select の change listener + localStorage 永続
  - `setOpen()` で 2 select の disabled 制御

スキーマ・main・preload・viewer・exporter は変更なし（既存 stamp overlay を流用）。

### 解除条件 / 後続 ADR

- **ADR-0017（仮）画像スタンプ** — assets テーブルにバイナリ保存、stamp.kind = 'image' で参照
- **ADR-0019（仮）プリセット管理** — stamp_presets テーブル（id / name / kind / properties JSON）+ 編集ダイアログ + 「テンプレートに保存…」フロー
- **元号テーブル化** — 改元タイミングで micro-ADR

## 検証

- 380 テスト継続 pass
- 手動：
  - PDF 開く → 印影モード → 印が押せる（赤い丸 + 文字「印」）
  - スタンプテンプレを 日付 (8.5.9) に変更 → カーソルが矩形 ghost に変わる → クリックで「7.5.9」が押される（2026-05-10 時点）
  - 色を 黒 に変更 → ghost が黒に → クリックで黒スタンプ
  - リロード後も template / color の選択が復元される
  - 配置後の overlay を inline edit で「秘」など別テキストに編集可能
