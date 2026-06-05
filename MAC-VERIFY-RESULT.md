# Mac 実機検証 結果 (事務所 M1) — qpdf 同梱の最終確認

> 実施: 2026-06-05 / 実施環境: macOS **26.5** (BuildVersion 25F71) / Apple Silicon M1
> 対象ビルド: `v2.0.0-beta.148` をローカルビルド (`npm run build:mac`, `--publish=never`)
> 手順書: `MAC-VERIFY-M1.md` / 背景: `QPDF-MAC-TODO.md` §7 #186-189
> **タグ/CI/publish は一切行っていない (β テスターに影響なし)**

## 総合判定: ✅ **PASS** (Mac qpdf 同梱は実機で正常動作。stable 残務 #5 実質クローズ)

---

## 手順7 成功条件チェック

- [x] **手順3**: `K-PDF3.app/Contents/Resources/qpdf/{bin,lib}` が揃っている
  - `bin/qpdf` (`-rwxr-xr-x`, 56,656 B) + `lib/` に `libqpdf.30.dylib` / `libjpeg.8.dylib` / `libcrypto.3.dylib`
  - 同梱版単体 (clean env) で `qpdf version 12.3.2` 起動
  - `otool -L` → `@executable_path/../lib/...` + `/usr/lib/*` のみ。homebrew/local 依存ゼロ
- [x] **手順4**: アプリ GUI 経由のセキュア書き出しで識別メタが全除去
  - 出力 `/Info` = `/ModDate` のみ (値=sanitize 時刻に上書き)。**Author/Title/Subject/Creator/Producer/CreationDate → 全除去**、XMP `/Metadata` → 無し
  - = Electron (41.7.1) から同梱 qpdf を spawn できている (#188-189 完了)
- [x] **手順5**: quarantine 付き (ダウンロード配布相当) でも qpdf が起動
  - `xattr -rw com.apple.quarantine` を .app に付与 → Finder「右クリック→開く」で承認 → 編集ありセキュア書き出し成功
  - 同梱 `bin/qpdf` は quarantine フラグが**残ったまま**でも実行成功 = **ad-hoc 署名により親アプリ承認後は子プロセス qpdf が Gatekeeper に弾かれない** (#186-187 完了)
- [x] **findQpdfBinary が同梱版を使用**: 手順3 で Resources 配下に在ることを確認済 → packaged app は `process.resourcesPath/qpdf/bin/qpdf` を最優先で解決 (system brew に落ちない)
- [ ] **手順6 (任意)**: dmg からインストールして /Applications 起動 — 未実施。手順5 で quarantine シナリオを疑似再現済のため省略可

### 追加の機械検証 (アプリ本体と同一モジュール `sanitizePdfBytes` を直接実行)
- pdf-lib で Author/Title/Producer/Subject/Creator/CreationDate 入り PDF を生成 → 同梱 qpdf で sanitize → **識別メタ全除去** を qpdf `--json` で確認 (PASS)。手順4 GUI 検証と二重に裏取り済

---

## ⚠️→✅ 検証中に判明した既存バグ → 本セッションで修正済み

### byte-copy 経路でセキュアチェックが無視されていた (全 OS 共通の既存バグ)

**【修正前】未編集の PDF を「名前を付けて保存」(セキュア ON) してもメタデータが除去されなかった。**

- 原因: `renderer.js:4102` `const isCopy = overlayCount === 0 && !hasDeletions && !hasInsertions;`
  → overlay/削除/挿入が一切無いと `kpdf3.copySourcePdf()` で元バイト列をそのままコピーし、qpdf を 1 度も呼んでいなかった
- 実害シナリオ: 受領 PDF (個人情報メタ入り) を**無編集のまま**セキュア保存すると、メタが残った PDF が出力される。ユーザーは「セキュアにした」つもりなのに除去されていなかった
- Win/Linux でも同じ挙動。Mac 検証で初めて表面化。検証手順書 `MAC-VERIFY-M1.md` 手順4 自体もこの罠にかかっていた (1 文字編集して再検証し PASS を取得していた)

**【修正 = 案A 採用】byte-copy 経路でも secureExport=ON なら qpdf を通す:**
- `kpdf3:copy-source-pdf` ハンドラ (main.js) に `secureExport` を追加。ON なら元バイトを `sanitizePdfBytes` に通してから書き込み (**ベクター品質は維持、Info/XMP のみ除去**)。export-pdf-rasterized と同じ `qpdfMissing` 方針 (未検出なら raw + 警告、sanitize エラーは throw)
- `preload.cjs` `copySourcePdf(savePath, opts)` / `renderer.js` で `{ secureExport }` を伝搬。旧シグネチャ後方互換あり
- docstring (renderer.js) の「Ignored on the byte-copy path」を実態に合わせ訂正
- **実機検証**: 同テストPDFを**無編集のまま**セキュア保存 → 出力が別バイト列 (945→898B) になり、Author/Title/Subject/Creator/Producer/CreationDate が全除去・XMP 無しを確認 (修正前は byte-identical でメタ残存)
- `npm test` 415/415 pass

---

## うまくいかなかった時用に共有予定だった情報 (今回は不要 = 全 PASS)
- 画面エラー: なし
- qpdf 依存解決 `otool -L`: homebrew 依存ゼロを確認済 (上記手順3)
