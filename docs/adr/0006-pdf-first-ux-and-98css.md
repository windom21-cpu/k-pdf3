# ADR-0006: PDF-first UX と 98.css による Win95 風テーマ採用

- 日付: 2026-05-09
- ステータス: 採用
- 関連: HANDOVER §1.3（3-layer 分離）、§17.1（レトロ UI 重視）、§13.1（98.css 方向性）

## Context

M2 step 4b で初の実用 viewer が動いたところで、ユーザーから 2 つのフィードバックを受けた：

1. **「最初に K-PDF3 ファイルを呼び出す仕様はわかりにくすぎる」**
2. **「新規＋PDF 取込というボタンの説明もわかりにくい。普通に『開く』でよい」**
3. **「テスト中も UI が違いすぎる。98.css の Win95 UI 再現にこだわりたい」**

これまでの UX は 3-layer 分離の内部実装をそのまま UI に出していた：

```
[新規 workspace を作成 + PDF 取込]   ← workspace 概念がユーザーに露出
[既存 workspace を開く]              ← .kpdf3 を直接選ばせる
[閉じる]
```

法律実務家のユーザーにとって日常的に触るのは PDF であり、`.kpdf3` は内部実装である。アーキテクチャ的に workspace が編集の真実源であることと、ユーザーが workspace ファイルを認識・操作することは別問題。

加えて、placeholder UI が素の HTML 要素のままで、レトロ UI へのこだわりが反映されていなかった。

## Decision

### 1. UX を「PDF が主、.kpdf3 は隣接 sidecar」に変更

主操作を **「開く」** ひとつに集約：

```
[開く]            ← PDF ファイルを選択
[閉じる]
```

「開く」の挙動：

1. PDF ファイル選択ダイアログを表示（拡張子フィルタ：pdf / 大文字 PDF / All Files）
2. 選択された PDF パス `/path/foo.pdf` に対し、隣接 `/path/foo.kpdf3` を計算
3. 隣接 `.kpdf3` が **存在する** → `Workspace.open()` で開く（fingerprint 等の整合性チェックは既存の verifyWorkspace + M3 以降の "safe mode" に委ねる）
4. 隣接 `.kpdf3` が **存在しない** → `Workspace.create() + importPdfFromFile()`（自動的に裏で）
5. どちらの場合も viewer に pages をロードしてレンダリング

ユーザーから見えるファイルは PDF のみ。`.kpdf3` の存在・命名規約・概念は UI に一切出さない。

### 2. 98.css を vendored asset として同梱し Win95 風テーマを適用

- 98.css v0.1.21（MIT ライセンス）をプロジェクト内の `src/renderer/vendor/` に **vendored copy** として配置
  - ユーザー指定の参照元 `/home/sk/デスクトップ/dtt-mini/98.css` をコピー
  - npm package は uninstall（同 lib のソースを 2 箇所に持たない）
  - bitmap font ファイル（`ms_sans_serif*.woff/woff2`）も同フォルダに配置（CSS の `url()` 参照を解決）
- `index.html` で `<link rel="stylesheet" href="./vendor/98.css">`
- 主要クラス：`.title-bar` / `.title-bar-text` / `.title-bar-controls` / `button`（自動）/ `.status-bar` / `.status-bar-field`
- カスタム `style.css` は 98.css の上に **viewer 領域・ページ配置・retro grey 背景** だけを足す薄いレイヤーに留める

vendored を選んだ理由（`npm install` ではなく）：
- electron-builder で配布バイナリを作る際、明示的な assets 同梱パスが固定されて取り回しやすい（`extraResources` 周りで悩まない）
- ユーザーが他プロジェクト（dtt-mini）と共有したい固定版数があり、npm の semver 範囲よりも literal copy のほうが意図に合う
- フォント `.woff/.woff2` も同じフォルダに置くことで CSS の相対 URL が確実に resolved

### 3. 内部 API は維持

- `Workspace.open()` / `Workspace.create()` / `kpdf3:open-workspace` / `kpdf3:create-workspace` / `kpdf3:import-pdf` / `kpdf3:pick-workspace-save` / `kpdf3:pick-workspace-open` は **削除しない**
  - 自動テスト（`m1-exit-criteria.mjs`）が直接使う
  - 将来の advanced UI（検索結果から workspace 直接ジャンプ等）で使う可能性
- 新規 IPC `kpdf3:open-pdf-file(pdfPath)` を追加。main 側で隣接 `.kpdf3` 解決ロジックを持つ
- preload は `openPdfFile(path)` だけを表に出す。`createWorkspace` / `openWorkspace` は preload からは **削除**（renderer から呼ばれなくなるので）

## Why この選択肢か

### 検討した options

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. PDF-first（採用）** | ✅ | ユーザー指摘と整合、§17.1 の「素人前提」と整合、§1.3 の 3-layer 分離は UX とは別問題 |
| B. workspace-first 維持 | ❌ | ユーザー明示で却下されたフロー |
| C. 両方残す（advanced toggle） | ❌ | UI 表面積の増加、混乱を解消しない |
| D. .kpdf3 と PDF を別々に管理（separate） | ❌ | ファイル管理コストがユーザーに乗る、ペアの整合性が壊れやすい |

### 整合する原則

- **§17.1 法律実務家、プログラミング素人**: 覚える概念を最小化
- **§3.1 趣旨優先**: 字義的には HANDOVER に書いてあった "workspace を開く UI" だが、フィードバックの趣旨は「日常的ファイル＝PDF を入口に」
- **§13.1 レトロ UI 方向性**: 98.css 採用は前から方向性として書かれている
- **§14.4**: 新規ライブラリ追加（98.css）と UX 大規模変更で ADR 必須 → 本 ADR がそれ

## Consequences

### 受け入れる trade-off

#### 1. PDF と .kpdf3 のペアリング前提

ユーザーが PDF を別ディレクトリに移動・リネームすると `.kpdf3` がはぐれる。

- M2 時点では：はぐれた状態で PDF を開くと隣接 `.kpdf3` が見つからず新規作成扱い → 過去の編集状態を失う
- M5 で **safe mode** 機能（HANDOVER §15.4 の glossary）として、`.kpdf3` 内に保存された source PDF fingerprint と現在の PDF を照合し、不一致なら警告を出す
- 移動・リネームの自動追従は M6 以降で再検討（「最近開いた PDF」履歴 + path 補正案）

ユーザーへの周知：M5 リリースノートに「PDF と `.kpdf3` はペアで動く。両方を一緒にコピー / 移動してください」と明記。

#### 2. 98.css のクラスベース DOM 構造への依存

98.css は HTML クラス命名規約（`.window` `.title-bar` 等）に依存する。これは外部仕様への結合だが：

- 98.css は安定したシンプルなライブラリ（MIT、依存ゼロ、CSS のみ）
- ロックインリスクは低い（剥がす時は CSS を自前で再現すれば良い）

#### 3. 既存のビルド成果物との非互換

これまで作った `.kpdf3` ファイルは引き続き有効（`Workspace.open` の挙動は不変）。ただし「.kpdf3 を直接開く UI」が消えるので、既存の workspace を開きたい場合は：

- 同じディレクトリにある PDF を開く → 自動的に隣接 `.kpdf3` を読み込む
- 一致 PDF が無い場合は手動で同じディレクトリに置く必要あり

これは M2 時点では問題ない（M1 / M2 中の `.kpdf3` は smoke test 由来の一時ファイルのみ、ユーザー実データはまだ無い）。

#### 4. テスト境界

`m1-exit-criteria.mjs` は `Workspace.open` を直接使うため、本変更で影響なし。`openPdfFile` フローを E2E でテストする場合は M5 CI 以降に検討。

### 解除条件

本 ADR は積極的に解除する想定なし。将来 UX を変更する場合は新しい ADR を起草。

## 影響範囲

- `package.json`: `98.css` 依存追加
- `src/main/main.js`: `kpdf3:open-pdf-file` IPC 追加 + 隣接 `.kpdf3` 解決ロジック
- `src/main/preload.cjs`: `openPdfFile` 露出、`createWorkspace` / `openWorkspace` の preload 露出を削除
- `src/renderer/renderer.js`: `btn-new` / `btn-open` を統合した `btn-open` 一本に
- `src/renderer/index.html`: 98.css link、`.window` / `.title-bar` 等のクラス適用、ボタン整理
- `src/renderer/style.css`: 98.css の上に薄く乗せるレイヤーに整理

## 検証

- `npm test`: 既存テストは不変（279 assertion）
- `npm start`: 「開く」だけで PDF が viewer に表示されること（手動）
- 同じ PDF を再度「開く」: 1 回目で作成された `.kpdf3` が再利用されること（手動、`ls` で確認）
- 98.css 適用：タイトルバー・ボタン・viewer 領域が Win95 風に見えること（手動）
