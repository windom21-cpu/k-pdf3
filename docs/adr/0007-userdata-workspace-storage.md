# ADR-0007: workspace ファイルを userData に集中、PDF フィンガープリントで索引

- 日付: 2026-05-09
- ステータス: 採用
- 関連: ADR-0006（PDF-first UX）

## Context

ADR-0006 では「ユーザーが直接触るのは PDF。`.kpdf3` は内部実装」と定め、`.kpdf3` を PDF と同じディレクトリに **隣接 sidecar** として置いていた。M3 / M4 動作確認の中で次の問題が表面化：

- **見た目の混乱**：書き出した PDF と元 PDF の名前が紛らわしく、ユーザーが書き出した方をうっかり開き「overlay が無い」と困惑する事故が起きた（v2.0.0-alpha.M4 動作確認時、user フィードバック）。
- **`.kpdf3` の存在自体がノイズ**：法律実務家のディレクトリには本来 PDF だけ並んでいてほしい。`.kpdf3` が並走するとファイル管理が煩雑。
- **書き出し名の修正案 `契約書_書出_20260509-185023.pdf` も「PDF らしさ」を損なう**：相手に送る成果物として名前にアプリ独自マーカーが入っているのは違和感。

ユーザーから提案された方向：
> 「KPDFの方は裏でかってに紐付けて読み込んでくれればいい。タイムスタンプ的なものに ID 的なものを足した単純な数字のファイル名でいい。PDF の方は前と変わらない名前で見た目の互換性を保ってほしい。そもそも kpdf ファイルはファイルとして見えていなくていいのではないか」

## Decision

### 1. workspace ファイルの保管場所を変更

`.kpdf3` をユーザー作業ディレクトリから **アプリ管理の userData ディレクトリ** に移す：

| OS | パス |
|---|---|
| Linux | `~/.config/K-PDF3/workspaces/` |
| macOS | `~/Library/Application Support/K-PDF3/workspaces/` |
| Windows | `%APPDATA%/K-PDF3/workspaces/` |

ファイル名は **`{YYYYMMDD-HHMMSS}_{8 文字 hex}.kpdf3`**（例：`20260509-195030_a3f1b2c4.kpdf3`）。タイムスタンプによる時系列ソート + 8 文字ランダムによる一意性確保。

### 2. PDF と workspace の紐付けは fingerprint 索引

`~/.config/K-PDF3/index.db`（独立 SQLite）に索引テーブルを置く：

```sql
CREATE TABLE pdf_workspaces (
  fingerprint     TEXT PRIMARY KEY,         -- source PDF の SHA-256 hex
  workspace_id    TEXT NOT NULL UNIQUE,
  workspace_path  TEXT NOT NULL,
  source_pdf_path TEXT,                     -- 監査用、最後に開いた PDF の path
  source_pdf_name TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

PDF を開く流れ：

1. PDF バイト列を読み込み、SHA-256 を計算
2. `pdf_workspaces` の fingerprint で索引参照
3. ヒット → 該当 workspace を `Workspace.open()` で開く
4. ミス → 新規 workspace を `userData/workspaces/{id}.kpdf3` に作成、PDF をインポート、索引に登録

### 3. legacy sidecar の自動移行

ADR-0006 期に作られた PDF 隣接 `.kpdf3` ファイルは互換のため自動移行する：

- 索引ミス時に PDF と同じディレクトリの `{base}.kpdf3` を確認
- 存在すれば `userData/workspaces/{id}.kpdf3` へ `renameSync` で移動
- 索引に登録
- ユーザーから見れば「kpdf3 が消えた」だけ

### 4. 書き出しファイル名はソース PDF と同じ名前に戻す

ADR-0006 で `_書出_{timestamp}` マーカーを付けたが、ADR-0007 で撤回：

- `defaultExportName()` の戻り値 → `${sourceBase}.pdf`（マーカー無し）
- ダイアログのデフォルトディレクトリ → ソース PDF と同じディレクトリ
- 同名を選ぶとソース PDF を上書きすることになるので OS ダイアログの「上書きしますか？」確認に委ねる
- ユーザーが意図的に上書きしたい場合（旧版を捨てる前提）も自然に運用できる

成果物 PDF の名前にアプリ独自マーカーが入らない、いわゆる「普通の PDF らしさ」が保たれる。

## Why この選択肢か

検討した options：

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. userData 集中 + fingerprint 索引（採用）** | ✅ | ユーザーから kpdf3 が見えない、PDF 移動・rename に頑健、内容ベース照合 |
| B. PDF 隣接 sidecar（現行）| ❌ | 視覚ノイズ、書き出し PDF との混同事故 |
| C. PDF 内に編集メタデータ埋め込み | ❌ | 「PDF は immutable background」（HANDOVER §2.2）に違反 |
| D. ユーザーが workspace を別のフォルダに置けるオプション | ❌ | 概念露出、PDF-first UX（ADR-0006）の精神と逆行 |

### 整合する原則

- **ADR-0006 PDF-first UX**: 主操作は PDF。kpdf3 を完全に裏に追いやることで一貫性向上
- **HANDOVER §2.2**: PDF は read-only artifact、編集の真実源は workspace。userData に置くことでより明示的
- **HANDOVER §17.1 / §3.1**: 法律実務家、プログラミング素人。覚える概念が PDF だけになる

## Consequences

### 受け入れる trade-off

#### 1. workspace の machine-portability の喪失

PDF を別 PC にコピーして開いても、その PC の index.db には fingerprint が無いので新規空 workspace が作られる。手動で `workspaces/{id}.kpdf3` をコピーすれば移植可能だが、UI からは触れない。

**評価**: 法律実務の主用途（自分の PC で作業 + 完成品 PDF を相手に送る）では持ち運びは不要。PC 移行時は別途ガイド（M5 で記述）。

#### 2. PDF を外部ツールで編集 → fingerprint 変化 → 新規 workspace

Acrobat で源 PDF を直接編集すると SHA-256 が変わるので索引ミス、過去の overlay は孤立する。

**評価**: HANDOVER §2.2「PDF は immutable」が前提。外部編集は K-PDF3 のスコープ外で、孤立 workspace は索引に残るので最悪手動復旧可能。ADR-0006 の M5「safe mode」で警告 UI を追加検討。

#### 3. ユーザーが直接 kpdf3 を弄る抜け道が薄くなる

トラブルシューティングや手動バックアップで kpdf3 をコピーしたい場合、`userData/workspaces/` を OS ファイラで開く必要がある。

**評価**: M5 で「ファイル > workspace フォルダを開く」メニューを追加して救済する余地を残す。

#### 4. 書き出し時の上書き事故リスク

デフォルトでソース PDF と同じ名前・同じディレクトリを提示するので、ユーザーが何も変えずに保存すると元 PDF が flatten 版で上書きされる。OS ダイアログの上書き確認に依存する。

**評価**: ADR-0006 の「PDF が主」観点では OK（ユーザーが「これは更新版だ」と意図して上書きするケース）。ただし誤操作のリスクは残るので、M4-3 で main 側に「source path と save path が一致した場合の確認 dialog」を追加検討。

### 影響範囲

- **新規ファイル**: `src/main/workspace-registry.js`
- **修正**: `src/main/main.js`（open-pdf-file IPC、export dialog defaults、app quit）
- **HANDOVER §15.4** の「asset 管理」に index.db の項目を追加（M4 後に明示依頼で更新）
- **HANDOVER §11**: workspace 保管場所の説明追加

### 解除条件

ADR-0007 の方針は持続的なものとする想定。userData 集中をやめる場合は新 ADR で議論。

## 検証

- 既存テスト 378/378 引き続き pass（domain / backend / コマンドは無影響）
- 手動：
  - 新規 PDF を開く → userData にファイル生成、PDF 隣接にファイル無し
  - 編集 → 閉じる → 同じ PDF を再オープン → overlay 復元
  - 別ディレクトリに PDF をコピー → 同一内容なら同じ workspace で開く
  - PDF 隣接の旧 sidecar が存在 → 開いた瞬間に userData へ移動、PDF 隣接に痕跡無し
