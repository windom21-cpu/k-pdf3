# K-PDF3 workspaces バックアップ手順書 (REVIEW-2026-07 #2)

## なぜ必要か

- 「編集可能マスター」(ADR-0026 の戻し先) と全案件の編集データ (overlay 等) は
  **この PC の `%APPDATA%\K-PDF3` にしか存在せず、Dropbox には同期されない**。
- PC 故障・買い替え・userData 消失で、全案件の「編集可能な状態」が失われる
  (Dropbox 上のフラット PDF は残るが、吹き出し等を編集可能なままでは戻せない)。
- 本手順は **アプリ外の robocopy ミラー** で NAS / 外付けに毎晩コピーする Step 1。
  アプリ内バックアップ (export package UI) は将来の Step 2 (HANDOVER §15.2)。

## バックアップ対象

| 対象 | 内容 |
|---|---|
| `%APPDATA%\K-PDF3\workspaces\` | 全 workspace (`.kpdf3` + β.134 サイドカー) |
| `%APPDATA%\K-PDF3\index.db` | fingerprint 索引 (workspace-registry) |
| `%APPDATA%\K-PDF3\stamps.db` | グローバルスタンプテンプレート |

`session.json` / `window-state.json` / `printer-devmode-cache.json` は
消えても困らない UI 状態なので対象外。

## ⚠️ 最重要の注意 — アプリ稼働中にコピーしない

better-sqlite3 は **WAL モード**で動いており、K-PDF3 の稼働中にファイルを
コピーすると (`-wal` / `-shm` を含めても) **不整合なコピーになり得る**。
バッチは起動チェック (`tasklist` で `K-PDF3.exe` を検出したら中止) を内蔵して
いるが、運用上も「**K-PDF3 を閉じてから実行**」を原則とする。夜間の自動実行
なら実用上問題ない。

## 初回セットアップ

1. `backup-workspaces.bat` (このフォルダ) を PC の任意の場所にコピー
   (例: `C:\Users\sk21l\bin\backup-workspaces.bat`)
2. バッチ先頭の `DEST` を実際のバックアップ先に書き換える
   (既定値 `X:\K-system\K-PDF3-backup` は例。NAS / 外付けの実パスに合わせる)
3. 手動で 1 回実行し、`[OK] backup finished` と表示されること・
   バックアップ先に `workspaces\` / `index.db` / `stamps.db` / `backup.log`
   ができていることを確認

## タスクスケジューラ登録 (毎晩 02:00)

管理者でないコマンドプロンプトで:

```bat
schtasks /Create /TN "K-PDF3 backup" /TR "\"C:\Users\sk21l\bin\backup-workspaces.bat\"" /SC DAILY /ST 02:00 /F
```

- K-PDF3 を開いたまま夜を越すとその晩はスキップされる (`[SKIP]` がログに残らず
  終了コード 1)。翌晩に閉じていれば追いつく。
- 削除は `schtasks /Delete /TN "K-PDF3 backup" /F`。

## 復元手順 (PC 故障・買い替え時)

fingerprint 索引は**パス非依存**なので、フォルダを書き戻すだけで新 PC でも
そのまま効く:

1. 新 PC に K-PDF3 をインストールし、**一度起動して終了** (`%APPDATA%\K-PDF3`
   を作らせる)
2. K-PDF3 が終了していることを確認
3. バックアップ先から書き戻す:
   - `workspaces\` → `%APPDATA%\K-PDF3\workspaces\` (丸ごと上書き)
   - `index.db` / `stamps.db` → `%APPDATA%\K-PDF3\` (上書き)
4. K-PDF3 を起動 → 編集していた PDF (Dropbox 上のフラットファイル) を開く →
   overlay が編集可能な状態で復元されていること・確定版で「編集に戻す」が
   効くことを確認

## 動作確認 (完了条件、初回のみ)

1. バッチを手動実行 → `[OK]`
2. バックアップ先の `workspaces` の個数がローカルと一致
3. リハーサル: `%APPDATA%\K-PDF3\workspaces` を別名に退避 → バックアップから
   書き戻し → K-PDF3 で編集済み案件が開ける (overlay が見える) こと
4. 確認後、タスクスケジューラに登録
