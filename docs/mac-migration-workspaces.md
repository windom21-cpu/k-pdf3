# Mac 版への workspace 資産引き継ぎ — 検討結果と実装 (2026-07-08)

Mac 正式リリース時に、Windows 機の workspace 資産（編集内容 overlay・「編集に戻す」の
編集可能マスター・`.kpdf3` / `.source.pdf`）を Mac 機へ引き継げるかの検討記録。
結論と、その場で実装した可搬性 fallback 2 箇所をまとめる。

## 結論

**引き継ぎ可能。** データ形式は全て OS 非依存で、障害は「絶対パスの埋め込み 2 箇所」
だけだった → 両方に fallback を実装済み（本ドキュメントと同コミット）。
これにより Mac 移行に限らず **PC 買い替え・Windows 再セットアップ・userData 移動全般**
に耐える。

## 前提の整理

- 編集資産の実体は **ローカル** の Electron userData にある:
  - Windows: `C:\Users\<user>\AppData\Roaming\K-PDF3\`（`workspaces/` + `index.db` + `stamps.db`）
  - Mac: `~/Library/Application Support/K-PDF3/`
- **X ドライブ（Dropbox）には載っていない**（ADR-0007 でアプリ専用領域に隔離する設計。
  だからこそ REVIEW-2026-07 #2 で robocopy バックアップ運用を開始した）。
  X 上の PDF 自体は Mac からそのまま見える。
- workspace との紐付けは PDF バイト列の SHA-256 fingerprint なので、
  **X のパスが OS で変わっても照合は壊れない**。

## OS 非依存で最初から互換なもの

| 資産 | 形式 | 備考 |
|---|---|---|
| `.kpdf3` 本体 | SQLite 単一ファイル | overlay・ページメタ・元 PDF blob（200MB 以下）・挿入 PDF blob（`inserted_source_pdfs`）を内包 |
| fingerprint 照合 | SHA-256 | パス非依存 |
| 「編集に戻す」系譜 (ADR-0026) | metadata の workspaceId のみ | 開くたび `workspacePathFor(id)` で現 userData から導出 = パス非依存 |
| stamps.db | SQLite | 全 PDF 共通スタンプ資産 |
| ワークスペースの整理 (ADR-0027) | ディレクトリ走査 (`readdirSync`) | registry の stale パスに依存しない |

## 障害だった 2 箇所と実装した fallback

### (1) `index.db` の `workspace_path`（最大の罠）

- 登録時の絶対パス（`C:\Users\...\workspaces\xxx.kpdf3`）をそのまま保持し、
  open 経路が `existsSync(existing.workspacePath)`（`main.js:1494`）で直接検査していた。
- 移行先ではパス不成立 → **新規 workspace が作られ「編集が全部消えた」ように見える**
  （ファイルは残るが紐付かない）。
- **fallback**: `workspace-registry.js` `findWorkspaceByFingerprint` — 保存パスが
  存在しないときだけ `workspacePathFor(workspace_id)`（現 workspacesDir から導出）を試し、
  実体があれば行を自己修復（UPDATE）。正常系は分岐に入らず不変。

### (2) `.kpdf3` 内の `source_pdf.external_path`（200MB 超サイドカー、β.134）

- import 時の絶対パスを保持し、`getSourceBytes` が verbatim に読んでいた
  （`workspace.js`）。移行先では大部 PDF の workspace が「ソース欠落」になる。
- **fallback**: 保存パスが存在しないときだけ「現在の `.kpdf3` の隣の
  `<workspace>.source.pdf`」（importPdfBytes / sidecar-sweep / cleanup 共通の命名規約）
  を読む。DB は書き換えない読み取り専用 fallback。正常系・blob 経路は不変。

テスト: `test/workspace-portability.test.mjs` 9 件（electron-runner、正常系回帰含む）。

## 引っ越し手順（一方向コピー）

1. 両機でアプリを**正常終了**させる（WAL checkpoint 済みの状態にする。
   `-wal`/`-shm` が残っていても本体と一緒にコピーすれば可）。
2. Windows の `%APPDATA%\K-PDF3\` から `workspaces/`（サイドカー
   `*.kpdf3.source.pdf` 含む）+ `index.db` + `stamps.db` を
   Mac の `~/Library/Application Support/K-PDF3/` へコピー。
   毎日 02:00 の robocopy ミラー（`docs/backup/`）をコピー元にしてもよい
   （アプリ終了後の整合スナップショット）。
3. Mac 側で X 上の PDF を開く → fingerprint 照合 + fallback で既存 workspace に接続、
   registry は開くたびに自己修復される。

### 引き継がれない（が実害軽微な）もの

- 「最近開いたファイル」— `source_pdf_path` が Windows パスのままなので
  メニューからは開けない。開き直せば `touchWorkspace` で更新される。
- セッション復元（開いていたタブ）— Windows パス前提。Mac で開き直す。

## やらないこと（非推奨と判断）

- **workspaces フォルダを Dropbox に置いて共有**: SQLite (WAL) と同期ソフトの組合せは
  破損リスク（本体と `-wal`/`-shm` の不整合コピー）。同一 workspace の同時オープンを
  防ぐ仕組みも無く、`index.db` は 1 台 1 個の前提。
- **Windows / Mac の常時並行運用（双方向同期)**: 同期設計を含む別の大物（ADR 案件）。
  現実的な形は「一方向の引っ越し」または「Mac はサブ機、必要な案件だけ都度コピー」。

## Mac 版の機能差（引き継ぎとは別問題、§15.6 参照）

閲覧・編集・書き出しは動くが、印刷（Adobe `/p` 案 D）・FAX・Office 挿入は
Windows 専用実装のまま。

### FAX の追加調査 (2026-07-08) — 従来認識の訂正

- HANDOVER §15.6 は「FAX は最難関（Mac から複合機 FAX に到達できるか自体が不明）」と
  していたが、**FUJIFILM は Apeos C2360 向けに Mac 用ダイレクトファクスドライバ
  （FF Direct Fax Driver）を現役提供している**。対応 OS は macOS 11 Big Sur〜
  **macOS Tahoe 26**（最新 OS 追従が継続、K-PDF3 Mac 版の最低要件 macOS 26 と整合）。
- Apple が廃止したのは OS 標準のモデム FAX であって、複合機メーカーの
  「印刷ジョブとして複合機へ送り複合機が FAX 発信する」方式のドライバは別物。
- **手動運用なら開発ゼロで今すぐ可能**: K-PDF3 で書き出した PDF を任意のアプリの
  プリントメニューから FAX キューに送り、ドライバのダイアログで宛先入力。
  Adobe Reader は不要（Mac 版 Adobe に `/p` 相当の CLI が無い点も変わらない =
  「Mac に Adobe を入れても K-PDF3 の FAX ボタンは動かない」は従来どおり）。
- K-PDF3 への組み込みは別実装（ドライバダイアログ仕様依存）だが、
  「FAX キューが CUPS から見える」という §15.6 最難関の前提はクリアと判明。
- ⚠️ 運用注意: Windows 版は誤送信事故歴から「宛先を記憶させない」を徹底している。
  Mac ドライバのアドレス帳・履歴機能も**オフにする運用を最初に確認**すること。
  K-PDF3 の「送信完了」確認モーダル相当の安全装置は手動運用には無い。
- 出典:
  - [Apeos C2360 ダウンロード（富士フイルムBI）](https://www.fujifilm.com/fb/download/apeos/c2360)
  - [ダイレクトファクスを送信したい（Mac）: Apeos C2360 / C2060](https://www.fujifilm.com/fb/support/mf/apeos_c2360/contents/apeos_c2360_6322.html)
  - [Mac OS 用ダイレクトファクスドライバー（対応機種一覧）](https://www.fujifilm.com/fb/ja/support/multifunction-printers/color/download-00016)
