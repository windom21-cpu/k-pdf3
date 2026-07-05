# K-PDF3 開発引き継ぎ書

最終更新: 2026-07-06
現在のバージョン: **v2.0.12-beta.4 (2026-07-06 リリース、β トライアル配信中)**。直前の stable は **v2.0.11 (2026-06-30)**。β.1〜β.150 の業務並走を経て 2026-06-05 に v2.0.0 stable へ卒業 (Win+Mac+Linux 3 OS 配布)。**ADR-0026「戻せる確定保存」(beta.1) と ADR-0027「ワークスペースの整理」(beta.2) を実装したため、現在は `releaseType=prerelease` に戻して β トライアル中** (ADR-0027 は実機確認済み、ADR-0026 は業務での往復動作を運用確認 → 不具合なければ stable v2.0.12 へ昇格。beta.3=パスワード平文化警告 / beta.4=byte-copy ゲート一本化は実運用の中で確認する扱い)。**⚠️ stable へ昇格する時は `package.json` `build.publish.releaseType` を `prerelease`→`release`、`version` を `2.0.12-beta.4`→`2.0.12` に戻す** (β タグ `v*-beta.*` は CI で Windows のみビルド、stable タグは 3 OS)。**基本は stable 運用** (重大バグは patch 2.0.x、新機能/大物は ADR 起草後 → β トライアル → 昇格)。**Mac/Linux を Windows 同等 (印刷/FAX/Office/署名) にするには追加開発が要る (§15.6)**。
stable 後の patch / β (要約。full 詳細は git log / `CHANGELOG-history.md`):
- **v2.0.12-beta.4** = **byte-copy ゲートを純関数 `byteCopyEligible` (exporter.js) に一本化** (REVIEW-2026-07 #4。実装 `94f0b44`・配信 `f331ee9`、2026-07-06)。v2.0.7 (userRotation) / v2.0.11 (並び替え) と同型の「workspace 専用編集を byte-copy が素通しする」バグを型ごと封じる対応で、総当たりテーブルの作成過程で**同型バグ 2 件を発見し同時修正**: (a) **印刷 2 経路 (`actionPrintViaReader` / legacy) とも「末尾ページ削除」を見落とし** — 末尾削除は歯抜けを作らないので自然順チェックを素通り、可視ページ基準の allPagesSelected でも捕まらない (export 経路だけ meta.pageCount 比較で捕捉していた)。削除したはずの最終ページが印刷される実バグ。(b) **legacy 印刷経路 (Reader 不在 fallback) に v2.0.11 の並び替え手当てが未適用** (v2.0.11 の「既存チェックで弾くため無変更」判断は並び順でなく昇順選択しか見ていなかった)。ゲート判定 = forceMono / overlay / 部分選択 / pending 削除 / 自然順 (並び替え・挿入・中間削除) / userRotation / **ソースページ数比較 (末尾削除)**。3 呼出箇所 (`actionExportToPath` / `actionPrintViaReader` / legacy 印刷) 全て共通ゲートに差し替え。`test/byte-copy-gate.test.mjs` 20 件 (編集種別×可否テーブル + 末尾削除 mupdf e2e) を npm test に組込み、**ミューテーション検証 4/4** (各チェックを故意に外すと fail)。**運用ルール: 新しい workspace 専用変換 (元バイトに焼かれない編集) を足すときは `byteCopyEligible` に条件 1 つ + テーブルに 1 行をセットで** (§8.5 への追記は #7 で)。
- **v2.0.12-beta.3** = **パスワード PDF 平文化の警告** (REVIEW-2026-07 #3 MVP。実装 `f6fb811`・配信 `8fbc844`、2026-07-06)。実ユーザーパスワードを入力して復号した PDF を開いた直後に、98 風モーダル (OK のみ) で「保存・書き出しするとパスワード保護の無い PDF が作成される (Dropbox 同期先にも置かれる)」旨を警告。権限制限のみ/空パスワード PDF (プロンプトなしで開くもの) は対象外、「次から表示しない」は付けない (案件ごとに意識すべき情報。復号ゲートは毎オープンで走るため再オープンでも再入力→警告が毎回出る)。全 open 経路は `openPdfPath` (renderer.js) に集約されているので修正 1 箇所。**将来の再暗号化オプションの布石**として、復号を伴う取込時に workspace metadata `source_was_encrypted="1"` を記録 (`Workspace.markSourceWasEncrypted()`/`sourceWasEncrypted()`、パスワード自体は保存しない。既存 workspace も再オープンで後追い記録)。`test/source-encrypted-flag.test.mjs` 5 件を electron-runner に追加。実機確認は**実運用の中で確認する扱いでクローズ** (ユーザー判断 2026-07-06)。
- **v2.0.12-beta.2** = **ADR-0027「workspace 保持ポリシー + 手動お掃除 (ワークスペースの整理)」を実装** (実装 `bd73372`・配信 `796f585`、2026-07-05)。workspaces フォルダの無制限膨張 (実測 7.4GB / 1,808 個 / 35 個/日) を止める手動整理機能: ツール → **「ワークスペースの整理…」** → read-only スキャン → 候補プレビュー (件数/容量/一覧) → 確認 → **ごみ箱移動 + `index.db` 行同時削除**。判定 = predecessor (編集可能マスター、lineage fixpoint で多段保護) と開いているタブは無条件保持 / 「開いただけ」(overlay・削除・挿入・回転・並び替え・しおり全部ゼロ) は即候補 / 編集ありは最終アクセス (registry `updated_at` と mtime の新しい方) から N ヶ月超で候補 (N=3/6/12、既定 3)。実装: `src/main/workspace-cleanup.js` (判定コア、Electron 非依存) + IPC 2 本 (`workspace-cleanup-scan/execute`、execute 側で id 形式/open 中/存在を再検証) + 98 風ダイアログ (`workspace-cleanup-dialog.js`)。テスト 31 件 (編集種別×判定テーブル + fixpoint + 実ファイル e2e) を `electron-runner` に追加 (better-sqlite3 ABI 都合、ADR-0005) → 計 462 pass。**実機確認済み (2026-07-05)**: スキャン→1,338 件/2.9GB 移動→既存案件が開く→確定版「編集に戻す」生存→ごみ箱に .kpdf3→再スキャン 0、全て OK。**発見: 候補の大半は「開いただけ」** (レビュー時の「62 個」は 200KB 代理指標の誤り — workspace は元 PDF を丸ごと含むため開いただけでも大きい)。あわせて同日、**workspaces のアプリ外バックアップ運用を開始** (`docs/backup/` の robocopy /MIR バッチ + 手順書、タスクスケジューラ毎日 02:00 + 電源 ON 追いつき実行、復元リハーサル確認済み — 編集可能マスターは Dropbox に乗らないため PC 故障対策、REVIEW #2)。
- **v2.0.12-beta.1** = **ADR-0026「戻せる確定保存 (編集可能マスター / Model Y)」を実装** (commit `7b9b822`、β トライアル配信中)。下書き/確定の二律背反 (下書き=Dropbox 等で見えない / 確定=後から編集不可) を、**確定を破壊的でなくす**ことで解決: 確定＝①ディスクにフラット版を書き出す (Dropbox/Adobe で見える) ②その時点の編集可能状態を「編集可能マスター」として温存 (workspace lineage で紐づけ)、→ ツールバー **「編集に戻す」**/ファイルメニュー「編集可能な状態に戻す」で復元。**発見=確定は元々「編集可能 workspace (pristine source + overlays)」を作っては孤児化して捨てていた** (`sidecar-sweep` は `.kpdf3` 本体を消さない) ので、**捨てずに `predecessor` で紐づけるだけ＝容量増ほぼゼロ・保存コア (fingerprint 同定) 無改変**。ADR が想定した source dedup はマスター (元 PDF) と確定版 (焼き込み画像) が別物なので不要だった。実装: `workspace.js` に `workspaceId`/`setPredecessor`/`getPredecessor` (metadata 保持=`.kpdf3` と一緒に移動、パス非依存で Dropbox 移動に強い)、`main.js` の open-pdf-file に `linkPredecessorFromActive` opt (確定 reopen 時に直前 workspace を predecessor 記録。byte-copy=編集なしは fingerprint 不変で同一再利用=不要) + `restore-editable-master`/`get-editable-master-info` IPC + open 戻り値 `hasEditableMaster`/`masterMissing`、`renderer.js` に「編集に戻す」ボタン (`btn-restore-master`)・確定ダイアログ文言改訂 (「画像化=不可逆」→「ファイルに反映＋あとで戻せる」)・確定版を開いた時ヒント/lineage 切れ明示、`sidecar-sweep.js` に将来の孤児掃除で predecessor を消さない注記。**外部改変で fingerprint 変=lineage 切れは「編集可能版が見つかりません」と明示** (黙って編集不能版にしない)。**MVP スコープ=上書き確定のみ** (名前を付けて確定は元タブが編集可能なまま残るので lineage 見送り)。**過去世代ロールバック・孤児 workspace 掃除は ADR 通り将来 opt-in**。`test/m3-overlay-persistence.mjs` に predecessor が close→reopen で保たれる検証 5 件追加、`npm test` 全 **420 pass**。**実機確認待ち** (§8.2 先頭): テキスト確定→Dropbox 反映→「編集に戻す」で再編集、戻す→再編集→再確定の往復でマスター一意、挿入/回転/削除/並び替え込みで崩れない、「編集に戻す」が Undo と紛らわしくないか。UI 決定 (ユーザー承認 2026-07-01): 戻す導線=ツールバーボタンも追加 / 文言=「反映＋後で戻せる」。memory [[project_reversible_flatten_save_adr0026]]
- **v2.0.11** = 左サムネのページ並び替えが、上書き/別名保存・Adobe 印刷の **byte-copy 経路で元 PDF に焼かれず**、他アプリ (k-evi 等) で開くと元の順序に戻る不具合を修正。並び替えは `display_order` を書き換える **workspace 専用変換で元バイトに非ベイク** (userRotation と同型)。byte-copy 判定 `isCopy` が overlay/削除/挿入/回転は見ていたが **並び替えを見ておらず**、並び替えのみだと `isCopy=true`→`copySourcePdf` が元順序のままコピーしていた (K-PDF3 自身は DB の display_order を読むので正しく見え発見が遅れた=v2.0.7 userRotation 漏れと同構造)。修正は純関数 `pagesInNaturalSourceOrder(pages)` を `exporter.js` に新設し、**自然順 (1..N・synthetic 無し) でなければ byte-copy 禁止**→再合成経路 (`composePagesForExport`→`assembleHybridPdf`、未編集ページは `strategy="source"` で copyPages = ベクター/文字/画質維持・順序だけ焼く)。保存 (`actionExportToPath`) と Adobe 印刷 (`actionPrintViaReader`) の 2 経路に適用、legacy 印刷は既存 `allPagesSelected.every(n===i+1)` で既に弾くため無変更、**回転ベイク (`rotate-place.js`)/下敷きには非干渉**。`test/page-reorder-export.test.mjs` 追加 (ゲート単体 5 + mupdf で並び替え後の色順が PDF バイトに焼かれる end-to-end 1)、`npm test` 全 pass。**実機確認待ち**: 中間/末尾/複数移動の並び替え→上書き保存→他アプリで順序反映
- **v2.0.10** = サムネイルからページ削除後に選択が常に先頭ページへ戻る UX 不具合を修正 (`deleteSelectedPages`。従来は選択 set をクリア → `refreshViewer` の `viewer.load` がビューアを先頭に巻き戻し → `onPageChange` が先頭で発火 → `highlightCurrentThumb` が p.1 に `is-current` 付与、が正体。修正は削除適用前に最先頭削除ページの表示位置 0-based を記録し、`refreshViewer` 後にその位置へ繰り上がったページ=末尾削除なら新末尾を選択 + サイドバー文脈なら `viewer.scrollToPage`。registry の `count`/`pageNoAtPos`/`posOfPageNo` のみ使用、全 OS で挙動共通=win32 依存なし。`renderer.js` UI 層のため自動テスト対象外、実機で中間削除→隣選択 / 末尾削除→末尾選択を確認要)
- **v2.0.9** = 印刷ダイアログ調整中に Adobe が勝手に閉じて印刷が進まない事象を構造対策 (案D 監視ループの Path B `doc-closed` 早期発火。armed 後マーカー消失の 1 tick で無条件 kill 確定していたのを、消失 3 tick 連続のデバウンス + バッファ後の再確認に変更。調整中のタイトル一過性揺れで誤 kill しない / 本当に閉じれば β.138 の自動 close は維持=回帰なし。win32 専用で実機確認要。memory [[project_print_adobe_cleanup_history]])
- **v2.0.8** = 回転 (userRotation) のみページの上書き保存 (Ctrl+S) が no-op で他ビューア/紙に回転が反映されない不具合修正 (真因は v2.0.7 の一段手前: `rotatePageBy` が `markWorkspaceMutated` を呼ばず dirty を立てないため、回転のみページは `actionSave` 冒頭の dirty ガードで early-return し `actionExportToPath` に到達していなかった。別名書き出しはゲート無しで v2.0.7 修正済だった。修正は `rotatePageBy` に `markWorkspaceMutated()` 1 行=全回転経路をカバー + ダーティ表示も点灯。memory [[project_rotation_only_bytecopy_bug]])
- **v2.0.7** = 回転 (userRotation) のみページが byte-copy で書き出し/全ページ印刷時に回転落ちする不具合修正 (`isCopy` 判定 3 か所に rotation チェック追加、回転ページのみ `_placeRotatedSourcePage` でベクター維持ベイク。memory [[project_rotation_only_bytecopy_bug]])
- **v2.0.6** = 下敷き印刷の上下さかさま対策 (真因は Adobe「向き=自動」誤判定、自動補正せず赤枠警告+必須チェックで「縦」を毎回確認させる運用。memory [[project_underlay_print_180flip_adobe]])
- **v2.0.5** = 更新後 PDF 復元の検証用テストリリース (コード変更なし)
- **v2.0.4** = 更新後 PDF 復元のバグ修正 (最後の窓を閉じる瞬間に session.json を空[]で潰す根因)。復元は v2.0.4 以降の更新から実働
- **v2.0.3** = 分割ビューの白紙ページを k-bunkatu 風に刷新 + 分割UI整列 + 更新後 PDF 復元の初版
- **v2.0.1 / v2.0.2** = パスワード保護 PDF 対応 (qpdf `--decrypt`) + その白紙バグ修正 (詳細 §15.4)
以下は v2.0.0 stable の経緯: **🎉 v2.0.0 stable (2026-06-05 リリース、β 卒業 = M6 完了)**。β.1 (2026-05-10)〜β.150 の業務並走を経て stable へ。**Win + Mac + Linux の 3 OS 配布** (Win=nsis / Mac=dmg arm64 / Linux=AppImage+deb)、`draft:false prerelease:false` の正式リリース。3 OS CI 初実走が一発成功 (build-windows → build-macos+linux 並列、`needs:build-windows` で 422 race 回避)。**stable 残務は全クローズ** (#5 qpdf 3OS 同梱 / #6 クラッシュ診断ロガー撤去 / annotation proxy / qpdf sanitize / 真の墨消し / 「後で」恒久対応 / CI race / 巨大 PDF サイドカー)。最終 2 β: **β.149 = クラッシュ診断ロガー一式撤去 (判断A=uncaughtException の握りつぶし no-op ハンドラは残置・ログのみ撤去 / 判断B=「クラッシュログを開く」メニュー撤去、正味 −480 行) + byte-copy secure-export 修正** / **β.150 = 業務並走 UX 2 件 (スタンプ配置中の OS 十字カーソル非表示+ゴースト中心点 / 画像スタンプを印刷・書き出しでも縦横比保持=exporter を viewer の object-fit:contain に一致)**。リリース設定を stable 化: `package.json` `build.publish.releaseType` を `prerelease`→`release`、version `2.0.0-beta.150`→`2.0.0`。**⚠️ 次に β を切るなら `releaseType` を `prerelease` に戻すこと** (現状は full release で出る)。**業務でフル運用が実証済なのは Windows のみ。Mac/Linux は配布物が起動し中核 (閲覧/編集/セキュア書き出し) は動くが、印刷/FAX が Windows 専用実装 → Mac/Linux 同等化の作業見積りは §15.6 を参照**。β.145 で Electron 38(EOL)→41.7.1 化 + hardening (CSP / window.open・遷移制限) + CI Node24 SHA 固定。β 期間の全経緯は §6.4 の表。
リポジトリ: 開発リポ [windom21-cpu/k-pdf3](https://github.com/windom21-cpu/k-pdf3) (Public) / 配布フィード [windom21-cpu/k-pdf3-releases](https://github.com/windom21-cpu/k-pdf3-releases) (Public)

このドキュメントは、K-PDF3 の開発を引き継ぐ次の AI アシスタント（または別環境の自分）が会話履歴なしで作業継続できるよう書かれている。**着手前に §0 → §1 → §2 → §3 → §6 → §8 → §17 の順で必ず読むこと**。

> クローン同期メモ: 2026-05-12 に開発リポを Public 化する際 `git filter-branch` で全 commit/tag を rewrite + force push 済。同期済の環境では追加対応不要。古いクローンの場合のみ `git fetch --all --tags --force && git reset --hard origin/main` で再同期。

---

## 現状サマリ (1 分で把握)

**フェーズ**: **stable 運用中 — 現在 v2.0.11 (2026-06-30)**。β.1〜β.150 → 2026-06-05 に v2.0.0 stable、以降 patch を v2.0.11 まで。**Windows で業務フル運用が実証済** (Mac/Linux は中核は動くが印刷/FAX が Windows 専用実装、§15.6)。**stable 残務は全クローズ済** — クラッシュ診断ロガーは β.149 で撤去済 (`logCrash`/`crashLogPath`/`print-tick` 等は src から消滅、残るは comment 1 件のみ。**§8.2 #3 と末尾の撤去 TODO リストは履歴**=既に適用済)。**現在のオープン項目は §8 の実機確認待ちが中心** (直近 patch の実機検証: v2.0.8 回転のみ上書き保存 / v2.0.9 印刷ダイアログ調整中の Adobe 早期 close / v2.0.10 サムネ削除後の選択位置 / v2.0.11 サムネ並び替えの保存・他アプリ反映)。**調査中の重大候補: A3 横向き PDF の通常印刷が天地さかさま (180°)** — 事務所複合機でテスト依頼中、方針未確定 (§8.2 先頭参照)。**実装済・β トライアル中の新機能: 戻せる確定保存 (ADR-0026, v2.0.12-beta.1)** — 下書き/確定の二律背反 (下書き=他アプリで見えない / 確定=後から編集不可) を確定の可逆化で解決。2026-07-01 に ADR 確定・実装 (commit `7b9b822`) → β 配信し、自分の業務で実機の往復動作を運用確認中 (不具合なければ stable v2.0.12 へ昇格)。詳細は冒頭の patch 一覧 v2.0.12-beta.1 / §8.2 先頭 / `docs/adr/0026`。**2026-07-05 に全体レビューを実施し、対応タスク 11 件 (workspace 膨張 / バックアップ / Electron 41 EOL ほか) を `REVIEW-2026-07-TODO.md` に起票** (§8.2 参照)。**8 件完了 (2026-07-05〜06)** — #10 ゴミログ削除 / #6 依存 exact 固定 / #5 Electron 41 EOL 方針 = (a) 一時容認で決定 (ADR-0004 追記) / #11 PAT 失効 2027-05-11 確認 + リマインド / **#1 workspace お掃除 (ADR-0027 → v2.0.12-beta.2 で実装・実機確認済み)** / **#2 workspaces バックアップ運用開始** (`docs/backup/`) / **#3 パスワード平文化警告 (beta.3)** / **#4 byte-copy ゲート一本化 + 総当たりテスト (beta.4、印刷の末尾ページ削除落ち 2 件を同時修正)**。残りは全て待ち条件付き: #9 (β 所感待ち)・#7 (stable 昇格時)・#8 (次の大物前)。β.1〜β.150 の経緯詳細は `CHANGELOG-history.md` (2026-06-22 に本書から退避) と §6.4 のポインタを参照。

> **β71〜β147 の詳細変更ログ + β 卒業ロードマップ (2026-05-25 確定) は `CHANGELOG-history.md` へ退避 (2026-06-22 整理)。** 製品は stable v2.0.10 で β は履歴。設計の現役根拠は §2 (設計思想・禁止事項) / §15 (既知懸念) / `docs/adr/` / memory を参照。印刷・Adobe・FAX・render・D&D の試行錯誤経緯を追うときは `CHANGELOG-history.md` を grep (memory [[feedback_handover_first_before_judgment]])。

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
- `REVIEW-2026-07-TODO.md` — **2026-07-05 全体レビューの対応タスク集** (目的・根拠・手順は全てそちらに集約、本書は §8.2 のポインタのみ)
- `CHANGELOG-history.md` — **2026-06-22 に本書から分離した履歴の保管庫**。完了 β (β.1〜β.150) の詳細変更ログ・§6.4 β 全表・各 patch の full 詳細・§8 完了済リストを保持。**HANDOVER.md = 現役の正 / これ = 経緯 (いつ何をなぜ)**。印刷・Adobe・FAX・render・D&D 等の試行錯誤の経緯を追うときは両方 grep する

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
| Electron | 41.7.1 | デスクトップアプリ化（2026-06-03 に 38→41 へ更新、ADR-0004 §更新。exact 固定） |
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
| qpdf | 12.3.2 (Win+Mac+Linux 同梱) | Apache 2.0 | secure export sanitize |

### 5.3 同梱バイナリ

| 項目 | ライセンス | 配置 | 役割 |
|---|---|---|---|
| SumatraPDF.exe | GPLv3 (spawn なので link 制約なし) | `vendor/sumatrapdf/` | Win 印刷 fallback (Reader 不在時) |
| qpdf 12.3.2 msvc64 + DLL 群 | Apache-2.0 | `vendor/qpdf/win/` | β.84 secure export (`--remove-info --remove-metadata`)。spawn なので link 制約なし。Linux=`vendor/qpdf/linux/` (公式 portable, 2026-06-03)、Mac=`vendor/qpdf/mac/` (M1 自己完結バンドル, 2026-06-05) で 3 OS 同梱完了 |

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
| ✅ **M5** | tag: `v2.0.0-beta.104` (配布中) | K-PDF2 主要機能 + α (タブ並列編集 / タブ別ウインドウ / 自動アップデート / 印刷 (案 D) / しおり / スタンプ / 画像スタンプ / 検索 / 範囲書出 / 分割保存 / クロス窓ページ挿入 / 申請書テンプレ + 後付け編集 + Tab 順手動編集 / **PDF→画像書き出し + 範囲画像** (β.97) / **オートシェイプ 9 種 + 45° 回転** (β.100-104)) |
| 🚧 **M6 (大半完了)** | β に同梱 | UI ポリッシュ + 機能投入済 (自前タイトルバー / カスタムファイルダイアログ / 印刷プレビュー / 98 風アップデート / マーカー / 墨消し白 / 吹き出し / 編集可能しおり (階層 + drag-reorder) / フォント設定 / ページ番号フッター / B2 モジュール分離 / B3 タブ別ウインドウ / 案 D 印刷 / 4K DPI 対応)。**残**: annotation read-only proxy / qpdf sanitize / Wayland ショートカット / 「後で」恒久対応 / 診断ロガー撤去 |

### 6.4 β テストフロー（β.1〜β.150 → 2026-06-05 v2.0.0 stable へ卒業）

> β.1〜β.150 の全 β 表 (日付 + 内容) は `CHANGELOG-history.md` へ退避 (2026-06-22 整理)。要点: SumatraPDF 同梱で印刷フリーズ根治 (β4) → autoUpdater (β5) → ハイブリッド PDF 組立 (β4/β8) → B2 モジュール分離 + B3 タブ別ウインドウ (β71) → 印刷を案 D = Adobe `/p` に再設計 (β72) → 申請書テンプレ/下敷き印刷 (β80) → secure export/qpdf/真の墨消し (β84-85) → 巨大 PDF サイドカー (β134) → 回転 PDF 印刷天地修正 (β142) → Electron 41 化 + hardening (β145) → ツールバーアイコン化 (β146)。

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
| パスワード保護 PDF を開く (v2.0.1/2.0.2) | 暗号化 PDF を開くと自動判定。権限制限のみ/空ユーザーパスワードはそのまま開く。ユーザーパスワード必須なら入力モーダル → qpdf `--decrypt` で復号 → 復号版をワークスペースに保存 (再オープンは再入力不要)。詳細 §15.4 / ADR-0025 候補 |
| カスタム ファイル選択 | OS ダイアログを使わず Win95 風自前ブラウザ。Open / Save / Folder の 3 モード共有 |
| 上書き保存 | Ctrl+S / toolbar「上書き」(workspace flush + 元 PDF を rasterized で上書き、Word 流) |
| 名前を付けて保存 | Ctrl+Shift+S / toolbar「保存」/ ファイル > 名前を付けて保存 (Save As 後 workspace 自動切替) |
| 範囲書き出し | ファイル > 範囲指定で書き出し |
| 画像として保存 (β97) | ファイル > 画像として保存… → PNG/JPEG、96/150/300/600/900 dpi、全/現/`1-3,5,7-10` 範囲、白黒モード。単一ページは 1 ファイル、複数はフォルダ + 連番 (`<base>_p001.png`) |
| 範囲画像保存 (β97) | toolbar「範囲画像」 / ファイル > 選んだ範囲を画像で保存… → 領域選択モード突入 → ドラッグで矩形指定 → 1 ファイル保存 |
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
| オートシェイプ (β100-104) | toolbar「図形」→ shape palette popup から 9 種 (直線 / 矢印 / 双方矢印 / ブロック矢印 / 双方ブロック / 四角 / 角丸四角 / 楕円 / 楕円+×) を選択 → ドラッグで配置 (常に右向き)。配置後 popup の ↺↻ ボタンで 45° 単位回転 (`length`/`crossSize` 不変、bbox AABB 派生)。線色 5 色、太さ 4 段、中空 / 塗りつぶし切替 |
| overlay 操作 | drag で移動、四隅で resize、**シングルクリック=選択 / ダブルクリック=編集** (β74)、右クリックメニュー (コピー / 貼り付け / 削除) |
| Undo/Redo | Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / 編集 menu (`CompositeCommand` で多重削除・整列も 1 unit) |
| 複数選択 | Ctrl/Cmd+click = toggle、Shift+click = reading-order range、`#align-bar` (2+ 選択時、左/上/右/下 整列) |
| クリップボード | Ctrl+C/V + 右クリックメニュー。**OS 画像 paste** (β76): Ctrl+V / 右クリック「貼り付け」で PNG/JPEG/WebP を image stamp として挿入 |
| ページ削除 | サムネ複数選択 + Delete (pending workflow → Ctrl+S で flush) |
| ページ挿入 | サムネ間「+」hover → クリックでダイアログ (白紙 / テキスト付き、72pt 表示) |
| 外部 PDF 挿入 | サムネ間 gap に外部 PDF を D&D → image-backed synthetic page (inserted_pages.image_blob、144 dpi raster + INSERT) |
| クロス窓ページ挿入 (β79) | A 窓のサムネ (sidebar / split-view) を選択 → B 窓の +gap / サムネ / split-view にドロップ → 選択ページを B 窓に synthetic page として挿入 (COPY 動作、A 窓不変、回転 + 多選択 + image-only synth 対応) |
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
| `m3-overlay-persistence.mjs` | 71 pass | Electron runner |
| `render.test.mjs` | 11 pass | plain node |
| `render-service.test.mjs` | 27 pass | plain node |
| `rotation-overlay.test.mjs` | 5 pass | plain node (`node --test`) |
| `sidecar-sweep.test.mjs` (β.147) | 15 pass | plain node |
| **合計** | **415/415 pass** | |

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
git log --oneline | head -20       # 最新は β147
npm test                           # 415/415 pass
npm run dev                        # electronmon (推奨、自動 reload。Wayland では reload が効かない時あり、その場合 dev を完全 kill + 再起動)
# または npm start                 # 単発起動
```

### 8.2 短期の優先順

#### 🆕 β トライアル中: ADR-0026 戻せる確定保存 (v2.0.12-beta.1) の実機確認 — 2026-07-01

**実装済で β 配信中** (commit `7b9b822`、詳細は冒頭 patch 一覧 v2.0.12-beta.1 / `docs/adr/0026`。**現行配信は v2.0.12-beta.4 = パスワード平文化警告 (beta.3) + byte-copy ゲート一本化 (beta.4) を追加同梱、2026-07-06**)。ユーザーが自分の業務でしばらく運用して不具合を洗い出す方針。**次セッションでは実機フィードバックの反映が最有力タスク** (出れば β.5 で対応 → 同手順 = `releaseType=prerelease` のまま version を上げてタグ `v2.0.12-beta.N` を push、CI が Windows のみビルドし autoUpdater で降る)。なお項目 (1)(2) のうち「編集に戻す」の生存自体は ADR-0027 の掃除検証 (2026-07-05) で実機確認済み。実機で見る項目: (1) テキスト追加→**確定保存**→Dropbox/Adobe で反映→ツールバー**「編集に戻す」**でまた動かせる (2) 戻す→再編集→再確定→また戻せる (マスターは常に最新で一意) (3) 挿入/回転/削除/並び替えを含む状態でも往復して構造が崩れない (4) 「編集に戻す」が Undo (元に戻す) と紛らわしくないか・文言/配置の使い勝手 (5) 確定ダイアログの新文言。**不具合なく安定したら stable v2.0.12 へ昇格** (`releaseType` を `release`、`version` を `2.0.12`、ADR-0026 ステータスを「実装済」へ、stable タグは 3 OS ビルド)。**MVP スコープ外 (将来 opt-in)**: 名前を付けて確定の lineage / 過去世代ロールバック (Model X) / 孤児 workspace 掃除。

#### 🆕 全体レビュー対応シリーズ (2026-07-05 起票) — 詳細・手順は `REVIEW-2026-07-TODO.md` に集約

開発一段落を機に全体レビューを実施し、対応タスク 11 件を専用文書 **`REVIEW-2026-07-TODO.md`** に起票 (本書には二重記載しない)。**進捗 (2026-07-06): 8 件完了** — ✅ #10 ゴミログ削除 / ✅ #6 依存 exact 固定 / ✅ #5 Electron 41 EOL = (a) 一時容認 + 監視継続 (ADR-0004 §更新 2026-07-05) / ✅ #11 PAT 失効 2027-05-11・リマインド routine 設定 / ✅ 🔴 #1 workspace 膨張 → **ADR-0027 + v2.0.12-beta.2「ワークスペースの整理」で解決・実機確認済み (2.9GB 回収)** / ✅ #2 バックアップ → `docs/backup/` バッチ + スケジューラ運用開始・復元リハ済 / ✅ #3 パスワード平文化警告 → **v2.0.12-beta.3 配信済・実運用で確認** / ✅ #4 byte-copy ゲート総当たり → **`byteCopyEligible` 一本化 + テスト 20 件、印刷の末尾ページ削除落ち 2 件を同時修正、v2.0.12-beta.4 配信済** (冒頭 patch 一覧参照)。**残りは全て待ち条件付き**: #9 確定版ステータス可視化 (β 所感待ち)・#7 HANDOVER 乖離修正 + ADR 0017〜0025 起草 (stable 昇格時)・#8 renderer.js S6 リファクタ (次の大物前)。**着手順・各項目の目的/根拠/手順/完了条件は同文書の「推奨着手順」表と完了記録表に従う** (同文書は随時更新可、本書は従来通り明示依頼時のみ)。

#### 🔴 最優先・調査中: A3 横向き PDF の通常印刷が天地さかさま (180°) — 2026-06-30

A3 横向き PDF を Adobe `/p` で通常印刷すると **180° 上下逆さま** (打ち出した紙を 180° 回すと一致)、A4 縦は正常。**切り分け済**: K-PDF3 が生成する PDF ページ自体は**プレビュー通り正立** (横向き MediaBox・overlay も正しい=生成バグではない)。**原因の最有力仮説=印刷経路の「回転の二重がけ」**: 横向きページは回転が要るため、Adobe「向き=自動」とドライバ(プリセット)の「横」が**両方 90° 回し合計 180°** になる。縦向き (A4) は回転不要なので失敗しようがない=正常。**下敷きの 180° (v2.0.6) とは別機構**: あちらは「ほぼ白紙ページで Adobe が天地を判定できない」content ambiguity、こちらは横向きの回転二重がけ (どちらも結果は 180°)。**v2.0.6 で実証済の制約**: Adobe `/p` 経路の向きは K-PDF3 から確実に制御できない (✗白埋め込み誘導 / ✗DEVMODE 向き強制=silent 経路専用 / ✗180°先回り=Adobe 仕様変更でサイレント故障)。**事務所複合機でテスト依頼中** (2026-06-30〜): Adobe 縦/横/自動 × プリセット横/縦 の組合せで「回す担当を 1 つに」すれば正立するか確認。結果次第で方針確定 — **②二重回転なら**横向きページだけ印刷経路 (`actionPrintViaReader`) で回転を 1 回に固定して自動でプレビュー通りに、**①Adobe 自動の誤判定なら**下敷き同様の向き警告運用。**いずれも回転ベイク (`rotate-place.js`)・下敷き修正には非干渉で対応する方針** (ユーザー要望「治った所は絶対に触らない」)。詳細な切り分け会話は 2026-06-30 セッション。**画像焼付保存しても直らない** (天地は文字層でなくページの横長形状で決まる、保存ファイル自体は正立=印刷時の設定重なりの問題) ことも確認済。

1. **β.131 を機能凍結ラインに、bug fix のみで業務並走** — 2026-05-29 時点で β.141 まで進行 (β.134 巨大 PDF / β.135 読込モーダル / β.136 墨消し黒背景 / β.138 印刷モーダル消失 / β.139 installer 関連付け sentinel + portable target 撤去 / β.140 フィードバック 9 件 + 明朝印刷密度 / β.141 明朝印刷密度 4 回打ち + テキスト options bar 表示漏れ修正)、いずれも構造修正。残り ~3 日間で重大バグが追加で出なければ stable へ
2. ✅ **qpdf Mac/Linux バンドル** (stable 残務 #5) — Win 同梱済。**2026-06-03 に Linux 完了** + **2026-06-05 に Mac 完了 (commit `5a52bbb`)**。Mac は事務所 M1 実機で Homebrew qpdf 12.3.2 を `install_name_tool` 手動バンドル (dylibbundler 1.0.5 が病的ループのため) で自己完結化し `vendor/qpdf/mac/{bin,lib}/` に配置 (arm64 専用、`@executable_path/../lib` + ad-hoc 署名、`otool -L` で homebrew 依存ゼロ確認、git 100755)。**コード/ビルド配線は全 OS 完了**。**2026-06-05 に M1 実機 (macOS 26.5) でローカルビルド検証 PASS** (`MAC-VERIFY-RESULT.md` / `MAC-VERIFY-M1.md` 手順3-5): Resources/qpdf/{bin,lib} 配置・単体 12.3.2 起動・`otool -L` 依存ゼロ / GUI セキュア書き出しでメタ全除去 (Electron spawn + extraResources) / quarantine 付き (`xattr` 付与→右クリック開く) でも ad-hoc 署名で子プロセス qpdf 起動。**残務 #5 は実質クローズ** (任意の dmg インストール手順6 は手順5 で代替済)。memory `[[project-qpdf-mac-arm64-pending]]`
3. **クラッシュ診断ロガー一式の撤去** (stable 残務 #6、最後) — β.51-.138 で累積した診断系を撤去。**#2 (qpdf Mac) と現行 β.131-.140 修正の安定確認が完了してから着手** (= 1 週間並走後)。**β.131-.146 は 2026-06-01 の安定確認窓を過ぎ、β.146 まで実機 OK で安定確認はほぼ満たした**。**2026-06-05 に #2 qpdf Mac 実機検証も PASS したので、残るゲートは実質この #6 のみ → stable タグを切る直前に撤去**。撤去対象に β.133 `open-pdf-stage` / `open-pdf-renderer-error` + β.137-138 `print-tick` も含める。**前倒しは NG** (Mac ビルド待ちの間に印刷/Adobe 系が再発しても診断データが取れなくなるため、安全網は最後まで残す)
4. **β.132 autoUpdater 修正の実機検証** — β.133→β.139 で実際の update を経験して順調 (ラベル「閉じる」/ 「次回起動時にもう一度」/ autoInstallOnAppQuit など機能している)。残課題: β.138 タグで GitHub Actions webhook 取りこぼし 1 件、`git push :tag` → 再 push で復旧。β.139 は webhook 取りこぼしなく 1 発で起動 (2m10s 完走)
5. **β.139 installer 修正の実機検証** — テスター環境で autoUpdater 経由 β.139 受け入れ後、(a) 次の β タグ受信時に「規定アプリがリセットされました」通知が出ないか、(b)「プログラムから開く」の K-PDF3 が 1 つだけ表示されるか (旧 ProgID `K-PDF3.pdf` 残骸の自動掃除確認)、(c) ユーザ手動で「PDF を Adobe で開く」に既定を戻した状態が以降の β 更新で維持されるか。**過去に portable 版を実行した PC は version 名付き Applications 残骸が customInstall で自動掃除できないため、必要なら PowerShell 手順 or アンインストール再インストールで個別掃除**
6. **β.131 Save As タブ表示 + paste aspect の実機検証** — Save As でリネーム保存 → タブラベルが新ファイル名に。クリップボード paste 画像 → 四隅ハンドルで縦横比を保ったまま変形
7. **β.134 巨大 PDF サイドカーの実機継続観察** — 200MB 超 PDF を反復 open / 切替 / 印刷 / 書き出しで問題ないか。~~orphan サイドカー掃除~~ ✅ **β.147 で実装** (force 上書き時の発生源封鎖 + 起動時に「兄弟 `.kpdf3` 無しの `*.kpdf3.source.pdf`」を best-effort 回収)。**空 `.kpdf3` 累積の掃除は引き続き未着手** (overlay 作業を持つため保持ポリシーが要る。stable 前に方針検討の余地、ただし低優先)
8. **β.136 墨消し書き出しの実機検証** — 透過背景 PDF を墨消し → セキュア書き出し / 通常書き出し / 印刷で「枠の外側が黒くならず白のまま」を確認
9. **β.138 印刷送信中モーダルの実機継続観察** — 様々な印刷経路 (LAN / USB / FAX 以外) で `reason: doc-closed` 自動 close が安定して効くか、別ウィンドウフォーカス時に title 取得が崩れないか
10. **BIOS 起動失敗の別原因切り分け** — 2026-05-26 ユーザー報告のうち「BIOS から OS 起動に至らずフリーズ」は K-PDF3 が干渉できる経路が構造的に無いため、別原因 (Windows Update / ドライバ / hiberfil.sys 不整合 / CMOS 電池 / SSD 劣化) を疑うべき。β.139 後も継続するか観察 → 続けばハードウェア / OS 側の問題が確定的
11. **下敷き印刷の精度キャリブレーション** (β.80 で本体実装済) — 用紙送り誤差で X/Y 数 mm ズレる可能性。実機テストでズレ量を測定 → 必要なら (a) プリンタ別 X/Y オフセット (b) 倍率補正 (c) トレイ別 (d) 申請書別キャリブ を段階追加
12. **印刷後 temp PDF が K-PDF3 に再オープンされる副次現象** (β.95 ログで発見) — 実害は軽微だが余計動作。低優先
13. **β.96 Adobe 残留拡張 kill の実機検証 → 必要なら exe whitelist 調整** — 次回 Adobe 残留が再発したら crash.log の `pdfreader-cleanup` 内 `adobeRelatedAtCleanup` を共有してもらう (現状は `Acro|Adobe Acrobat|AdobeAcrobat|adcef|acrobat` パターンで拾い)

#### ✅ 直近で根治済 (旧オープン項目)

> 完了済みの根治項目一覧は `CHANGELOG-history.md` へ退避 (2026-06-22 整理)。要点のみ: D&D「開かない」zombie 自己復旧=β90 / FAX 縮小=β92・宛先記憶=β93 / タブ切替しおり混在=β94 / Adobe 残留=β95-96-116-118-126 + FAX は β129 明示確認モーダル / Save As タブ表示・paste aspect=β131 / 「後で」恒久対応・CI 3OS race=β132 / 巨大 PDF=β134 / 墨消し黒背景=β136 / 印刷モーダル消失=β138 / 規定アプリ暴れ・2重表示=β139 / 業務 FB 9 件・明朝印刷密度=β140-141 / 回転オーバーレイ天地=β142 / 吹き出し後付け書式=β143。

#### 🟡 確認待ち項目（実機テスター側）

- **β71 B3 タブ別ウインドウ**: 5 経路の業務での体感。tearout / dock-back 中に画面の見え方や残留ウインドウがおかしくないか
- **β72-β76 印刷経路 + 編集機能**: 案 D で Adobe ダイアログの体感、太字化バグ解消、クリップボード paste、明朝の濃さ、混在サイズの中央寄せ
- **β79 クロス窓ページ挿入**: 多窓並列で他の案件のページを引き込む業務シナリオでの体感、回転 + 多選択 + 分割画面ドロップが期待通りか
- **β80〜β82 申請書テンプレ + 下敷き印刷**: 業務で実際の申請書 (公的書類等) を雛形化して下敷き印刷した時の精度・操作性。β82 後付け編集の操作感 (選択 → options bar 自動表示で値変更) と Tab 順手動編集 (番号バッジ / 縦リスト popup でのドラッグ並べ替え、行クリック → 本文 pulse highlight) が業務で使い物になるか。丸囲み click 配置 → 楕円変形が直感的か
- **β83 annotation read-only proxy**: Adobe で付箋 / ハイライト / 取消線 / 押印 (Stamp) を付けた PDF を開いて、種別ごとに視覚分岐 (黄付箋 T / 緑下線 / 赤取消等) が業務で「これは外部 annotation」と即判別できるか、ホバーで内容と作成者の tooltip が出るか
- **β84/β85/β86 セキュア書き出し + 真の墨消し**:
  - 通常書き出しを「セキュア」チェック ON のまま実行 → 出力 PDF を Adobe で開いて「文書のプロパティ」を確認、Author/Title/Subject/Producer/CreationDate/ModDate が全部空 (or qpdf 12.3.2) になっているか
  - しおりが書き出し後も残っているか
  - 範囲書き出し / 右クリック「N ページを PDF として保存」もチェックボックス出るか (β.86 で可視化されたチェックボックスが業務で気付きやすい配置になっているか)
  - 墨消しを置いたページで Adobe テキスト選択 / 検索 / 抽出ができないことを確認 (β.85 真の墨消し)
- **β85 ステ ンプ管理 ▲▼ + テキストスタンプ細字 + D&D 挿入後 scroll + palette 縦スクロール**: 業務での操作感
- **β87 画像スタンプ濃度 ramp**: カラー印影 (赤・青等) 1 つ登録で押印 / 印刷が白黒版と同等の濃さか。中間グレーが濃くなりすぎていないか。閾値 (LO=0.5/HI=0.85) を調整したい場面があるか
- **β88-β93 白黒モード + FAX 経路**: (a) 白黒トグル ON で overlay 色が黒になるか (マーカーは除外、redaction "white" は維持)、(b) FAX ボタン左クリック → Adobe ダイアログが FAX 選択済で開くか、(c) Adobe で「実際のサイズ」を 1 回選んで以降記憶されるか、(d) 宛先記憶が消えているか、(e) ページサイズ混在 PDF で 3 択ダイアログが期待通り動くか
- **β94 タブ切替**: Tab A でしおりクリック後 Tab B 切替 → Tab B が前回位置 / 先頭で開く + Tab A のしおり混在無し
- **β95-β96 印刷後 Adobe 自動 close**: 印刷後 Adobe が画面から消えるか。消えない場合は crash.log の `pdfreader-cleanup` 内 `adobeRelatedAtCleanup` を共有
- **β14/β15 4K DPI**: プリンタプロパティダイアログ + NSIS installer のシャープさ
- **β140 フィードバック 9 件**: (a) ② システムフォント (例: メイリオ) 選択 + 半角数字独立軸チェックで半角数字だけ印鑑風になるか、(b) ③ システムフォント選択 → 再起動で復元されるか、(c) ④ 配置済みテキスト枠を選択 → ツールバーの font/size/color/太字/数字独立軸を変更で即反映、複数選択時は同種一括反映、(d) ⑤ テキスト枠コピー → 別位置の空き右クリックで「貼り付け」が出てクリック位置に paste、(e) ⑥ ページ A コピー → ページ B 空き click → Ctrl+V でページ B に paste、(f) ⑦+⑧ 別名保存で元タブ残存 + 元タブ編集で dirty 警告継続発火、(g) ⑨ 範囲・単ページ書き出し後に新タブで書き出し PDF 自動表示
- **β140 MS 明朝印刷密度**: MS 明朝 + 太字 OFF で書き出し or 印刷 → 紙でドット感が解消されているか / 太く感じないか。万一足りなければ `paintGlyphRun` の `fillText` を 3 回打ちに増やす余地あり (`exporter.js:158`)
- **β142 回転 PDF の印刷天地 (最重要・実害再発防止)**: `/Rotate` 付き元 PDF (スキャン申請書 / 裁判所謄写) または手動で180°/90°/270°回転したページに記入値を入れて → (a) **下敷き印刷**で天地が正しく出るか (今回の実害シナリオ)、(b) 通常印刷・PDF 書き出しでも天地・左右が正しいか、(c) 記入値の位置が画面表示と一致するか (切り落とし・ズレ無し)、(d) `/Rotate=0` の通常フォームが従来通り変化なしか (回帰無し)。全 4 回転を mupdf レンダリングで自動検証済だが、実機の Adobe 印刷ダイアログ「実際のサイズ」経由で最終確認したい
- **β143 吹き出しの後付け書式変更 + 枠はみ出し**: (a) 配置済み吹き出しをクリック → text オプションバー (フォント/サイズ/色/太字/数字 hanko) が自動表示され、変更で即反映されるか、(b) 複数の吹き出し (or 吹き出し + テキスト枠) を選択 → 一括で書式変更できるか、(c) **吹き出しの枠を本文より小さくドラッグ → 本文が収まる最小サイズに自動で戻るか (はみ出さない)**、(d) フォント/サイズを大きくすると枠が本文に合わせて自動拡大するか、(e) **サムネ・印刷・書き出しで本文が枠からはみ出さないか (今回の主目的、入力画面と一致)**、(f) 既存ドキュメントの吹き出し (β.143 以前に配置) が極端に小さくリサイズされていた場合は一度選択 or リサイズし直すと是正される (旧データは触れるまで旧寸法のまま)
- **β144 直線マーカー + テキスト連続入力**: (a) マーカーモードの options bar に `種類` (範囲/直線) と `太さ` が出るか、(b) **種類=直線で横にドラッグ → 一定の太さの帯が水平にまっすぐ引けるか (縦にブレても水平を保つ)**、(c) 太さ 細/中/太 で帯の厚みが変わるか、(d) 種類=範囲で従来どおり矩形マーカーが引けるか (回帰なし)、(e) 種類/色/太さが再起動後も復元されるか、(f) **印刷・書き出しで直線マーカーが黄のまま (白黒モードでも黒く塗り潰されない) か**、(g) **テキストモードで枠を置く → 入力 → Esc/Ctrl+Enter で確定 → もう一度クリックで次の枠が置ける (ボタンを押し直さず連続配置)**、(h) 編集を空き領域クリックで終えたとき、その同じクリックで余計な空枠が落ちないか (二重配置なし)、(i) テキストモードを抜けるのは「テキスト」ボタン再押下 / 別モード / 編集していない状態の Esc
- **β145 (Electron 41 化の Windows 初配布・要重点確認)**: (a) アプリが起動し PDF を開ける・編集できる (better-sqlite3 41 ABI 正常)、(b) **別窓 (ページポップアップ) が開き、ページ縦横比にフィットしてリサイズされる** (ESM `require` 回帰の修正確認、β.144 までは Electron 38)、(c) 印刷 (Adobe `/p`) / FAX / 下敷き印刷が従来どおり動く、(d) **画像スタンプ (クリップボード貼り付け) が Windows ネイティブで表示される** (WSLg では検証できなかった経路)、(e) 一般操作で白画面・崩れ・落ちが無い (CSP/hardening が正常機能を阻害しない)。**何か壊れたら hardening は CSP コミット `6c6b004` のみ revert 可、Electron は ADR-0004 §更新の手順で 38 へ戻せる**
- **β146 ツールバー アイコン化 + 動的退避**: (a) PDF を開いた状態でツールバーの各アイコンが意図どおりか・**ホバーで用途解説 (title) が出るか**、(b) **ウインドウ幅を狭めると、ボタンが折り返さず高さ一定のまま、表示倍率→検索→回転→… の順で右端「»」に入っていくか**、(c) 「»」を開いて中の **表示倍率の変更・検索入力・回転** が機能するか、(d) 幅を広げると退避項目がツールバーに戻るか、(e) **どの幅でもアイコンと枠がズレない**か (縮小由来のズレ解消確認)、(f) 白黒トグル ON でアイコンが白に反転して見えるか、(g) △ (下敷き印刷/ページ番号/別窓/別窓化) が「»」の静的ゾーンから従来どおり起動するか・メニューバー経由も無事か。**Wayland 実機でのウインドウリサイズ追従** (ResizeObserver) を特に確認したい (β.146 はアップデート配信でユーザー実機確認済・OK)
- **β147 orphan サイドカー掃除**: 主に内部整理 (新 UI なし)。確認するなら (a) 200MB 超 PDF を開いて編集→保存後、`userData/workspaces/` に `*.kpdf3.source.pdf` が `.kpdf3` 無しで残っていないか、(b) 巨大 PDF ワークスペースを通常利用していて、起動時掃除で**生きているワークスペースのソースが誤って消えていない**か (兄弟 `.kpdf3` がある限り保持される設計)。実害が出る経路ではないので低優先
- **v2.0.10 サムネ削除後の選択位置**: 左サイドバーのサムネで (a) 中間ページ (例 3/10 ページ目) を削除 → 選択と表示が**元 4 ページ目=今の 3 ページ目**へ移り、先頭に戻らないか、(b) **末尾ページを削除 → 新しい末尾**が選択されるか、(c) 複数選択削除 → 最も先頭側の削除位置に繰り上がったページが選択されるか、(d) 全ページ削除で空表示になり例外が出ないか、(e) 挿入(白紙)ページを混在させた状態でも表示位置ベースで正しく繰り上がるか。分割保存ビュー側は選択復元のみ (メインビューアはスクロールしない) なので、分割の選択ハイライトが残ることも併せて確認
- **v2.0.11 サムネ並び替えの保存・他アプリ反映**: 左サムネでページ順を入れ替え (中間移動 / 末尾へ移動 / 複数選択ブロック移動) → **上書き保存 (確定保存)** → **k-evi など他アプリで開いて並び替えが反映されているか** (これが報告された不具合の本丸)。加えて (a) 別名保存でも同様か、(b) Adobe で印刷しても並び替え順で出るか、(c) 並び替え+他編集 (テキスト/印影/削除/挿入/回転) 併用時も従来どおり正しいか (回帰なし)、(d) 並び替え無しの未編集 PDF は従来どおり byte-copy で高速・ベクター維持か。**未編集ページのベクター/文字層が維持されている**ことも確認 (再合成経路でも `strategy="source"` で copyPages するため画質劣化しない想定)

#### 🟠 繰越項目 (β 卒業前の検討候補)

- **既存マーカーの opacity 移行** — β15 で default 0.3 化、既存 0.5 はそのまま。一斉に淡くしたい場合 migration スクリプト
- **画像スタンプ vector 化** — 印刷時の bbox raster 制約 (β62) を vector で置き換える研究 (現状は受容)
- **IPAex 同梱** — 配布先での字形差異が問題化したら検討
- **dock-back 視覚フィードバック** — 現状 cross-window drop は無告知 dock。target tab-bar のハイライト追加余地
- **font-fallback の Mac 対応** (β.113 で Win + Linux のみ実装) — `pickFontFile` に macOS の OS native CJK font path (`/System/Library/Fonts/...`) を追加。Mac ビルド配布開始のタイミングで対応

#### v2.0.0 stable に向けた残作業 (β 卒業ロードマップ)

**機能実装** (✅ 完了済 — 詳細は `CHANGELOG-history.md`): annotation read-only proxy=β83 / qpdf sanitize (3 OS 同梱)=β84 + Linux β145 + Mac 2026-06-05 / 真の墨消し=β85 / D&D zombie 自己復旧=β90 / FAX 100% native scale=β92-93 / Save As・paste aspect=β131 / 「後で」恒久対応・CI race=β132 / 巨大 PDF サイドカー=β134 / 墨消し黒背景=β136 / 印刷モーダル=β138 / installer 関連付け=β139 / 業務 FB + 明朝印刷=β140-141 / 回転オーバーレイ天地=β142 / 吹き出し書式・枠=β143 / orphan サイドカー掃除=β147。

**残作業** (stable タグ前の TODO):
- ~~orphan `.source.pdf` サイドカー掃除~~ ✅ **β.147** (force 上書き時の発生源封鎖 + 起動時 best-effort 回収、`sidecar-sweep.js`。空 `.kpdf3` 掃除は別途・低優先)
- ✅ **qpdf Mac/Linux バンドル** (stable 残務 #5) — **Linux 完了 (2026-06-03)** + **Mac 完了 (2026-06-05、commit `5a52bbb`)**。Linux: 公式 portable v12.3.2 を `vendor/qpdf/linux/` に同梱 (SHA256 検証・実機起動確認)、`findQpdfBinary` を win=flat / mac・linux=bin+lib 対応、`package.json` mac/linux `extraResources` 設定。**Mac: M1 実機で Homebrew qpdf 12.3.2 を自己完結バンドル**して `vendor/qpdf/mac/{bin,lib}/` に配置 (arm64 専用、universal2/Rosetta/lipo 不要)。`dylibbundler` 1.0.5 が病的ループに陥ったため `install_name_tool` で手動バンドル (依存は閉じグラフ 3 個 = libqpdf.30 / libjpeg.8 / libcrypto.3、参照を `@executable_path/../lib` に固定 + ad-hoc 署名)。`otool -L` で homebrew/local 依存ゼロ・`env -i` で 12.3.2 起動・実 PDF で Info 除去を確認、git mode 100755、`NOTICE.txt`/`README.md` 整備。**⚠️ 最低 OS = macOS 26.0** (bundle は Tahoe bottle 由来で全ファイル minos=26.0、26 未満は dyld 起動拒否。配布先全台 26+ を 2026-06-05 ユーザー確認済。26 未満対応が必要なら低 deployment target で作り直し)。**実機確認 ✅ 完了 (2026-06-05、M1 macOS 26.5)**: ローカルビルド (`npm run build:mac`, publish なし) → Resources/qpdf/{bin,lib} 配置・単体 12.3.2 起動・依存ゼロ / GUI セキュア書き出しでメタ全除去 (Electron spawn + extraResources) / `xattr` で quarantine 付与 (配布相当) → 右クリック開く後も ad-hoc 署名で子プロセス qpdf 起動。`MAC-VERIFY-RESULT.md` 参照。**検証中に byte-copy 経路 (未編集 PDF セキュア保存) で qpdf を迂回しメタが残る全 OS 共通バグを発見・同日修正** (commit `1927e64`、`copy-source-pdf` に secureExport 追加、未タグ)
- 🔴 **クラッシュ診断ロガー撤去** (stable 残務 #6、最後): `crashLogPath()` / `logCrash()` / `kpdf3:log-diag` IPC / preload `openCrashLog` / index.html の `data-action="open-crash-log"` / `actionOpenCrashLog` / `drop-*` / `gap-drop-file` / `os-open-received` / `j5-zombie-kill-*` / `second-instance-*` / `primary-window-closed` / `pdfreader-cleanup` の `survivors`/`survivorsExtra`/`killDetails`/`newPidsByExe`/`preExistingPidsByExe`/`adobeRelatedAtCleanup`/`extraKilled` / `pdfreader-process-closed` / `pdfreader-jobs-drained` / `print-cancel-by-user` / `pdfreader-followup-snapshot` / `font-fallback-callback` / **`open-pdf-stage`** / **`open-pdf-renderer-error`** / **`print-tick`**。**他残務の安定確認後に適用**
- 🟡 **業務並走 1 週間で重大バグなしの確認** (2026-05-25〜06-01 目安、Day 1 = 05-26 で β.134/.135/.136/.138/.139 を投入済、残 ~5 日間)
- 🟢 Mac 署名/公証は不要 (ダイレクト dmg 配布 + 初回「右クリック→開く」案内で運用、memory `[[feedback-mac-signing-not-needed]]`)。Win コードサインも未署名で OK

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
type OverlayType = 'text' | 'stamp' | 'image' | 'redaction' | 'line' | 'rect' | 'signature' | 'page_number' | 'form_field' | 'shape';

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

// shape (β.100-104 オートシェイプ)
{ kind: 'line' | 'arrow' | 'double-arrow'
       | 'block-arrow' | 'double-block-arrow'
       | 'rect' | 'rounded-rect' | 'ellipse' | 'ellipse-x',
  strokeColor: string,             // "#000000" 等
  strokeWidth: number,             // pt (1/2/3/5 等)
  fillColor?: string,              // null = 中空、設定で塗りつぶし
  // directional shape (line/arrow/block-arrow 系) のみ:
  arrowDir?: 'right' | 'down-right' | 'down' | 'down-left'
           | 'left'  | 'up-left'   | 'up'   | 'up-right',
  length?: number,                 // 矢印の長さ (pt、方向不変)
  crossSize?: number,              // 軸に直交する方向の大きさ (pt、方向不変)
  thickness?: number,              // block-arrow shaft 太さ比 (0..1、def 0.5)
  // rounded-rect のみ:
  cornerRadius?: number,           // pt (def 8)
}

// form_field (β.80 申請書テンプレ)
{ fieldKind: 'text' | 'check' | 'circle' | 'radio',
  value?: string,
  // fieldKind === 'text': fontFace / fontSize / color / alignH / alignV
  // fieldKind === 'check'/'radio': checkStyle, radioGroupId (radio のみ)
  // fieldKind === 'circle': strokeWidth / color
  tabOrder?: number,               // β.82 explicit Tab 順
}
```

---

## 10. ファイル構成

```
k-pdf3/
├── package.json                          # v2.0.0-beta.104
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
│   │   ├── mupdf-render.js
│   │   ├── mupdf-annotations.js          # β.83 C3 annotation proxy 抽出
│   │   └── pdf-outlines.js
│   ├── main/
│   │   ├── main.js                       # 大物、IPC surface
│   │   ├── render-service.js
│   │   ├── workspace-registry.js
│   │   ├── updater.js
│   │   ├── global-stamp-store.js
│   │   ├── printer-properties-win.js
│   │   ├── qpdf-sanitize.js              # β.84 secure export wrapper
│   │   ├── pdf-reader-finder.js
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
│   ├── sumatrapdf/SumatraPDF.exe         # Win 印刷 fallback (Reader 不在時)
│   └── qpdf/win/                         # β.84 secure export (qpdf 12.3.2 msvc64 + DLL 群)
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
npm test                 # 全テスト（415/415 pass）
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
- **PAT 管理**: 開発リポ Settings → Secrets → Actions に `RELEASES_REPO_TOKEN` を登録、期限 1 year。**現 token の失効日 = 2027-05-11** (2026-07-05 確認)。失効 1 ヶ月前 (2027-04-11) に claude.ai routine `trig_012m8K2K27rp2hzN6iwruAyo` が開発リポへ GitHub Issue を自動起票してリマインドする。更新手順: 新 fine-grained token 発行 (k-pdf3-releases のみ、Contents=Write / Metadata=Read) → 開発リポ Secrets の `RELEASES_REPO_TOKEN` 差し替え → 次回タグ push で publish 成功を確認
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

- **Electron 版数の固定** (ADR-0004 + 2026-06-03 §更新): **2026-06-03 に Electron 38.8.6 → `41.7.1` (exact) へ更新**。Electron 38 が 2026-03-10 で EOL となりパッチ供給が止まったため、固定継続が「アップグレード起因の脆弱性を避ける」本来目的に反する状態となったため前進。ブロッカーだった better-sqlite3 が **12.10.0** で Electron 39/40/41 prebuild を全 OS 提供したのが解決の鍵 (mupdf は wasm で ABI 非依存)。**Electron 42 はまだ不可** (better-sqlite3 が 42 対応を取り下げ済 PR #1470、upstream issue #1474/#1475 オープン)。41 のサポートは **〜2026-08-25**、それまでに 42 が通れば再度上げる。
- **Electron 脆弱性 (旧: 38 の高セベリティ 4 件)**: ~~offscreen UAF / clipboard クラッシュ / window.open スコープ~~ → **Electron 41 化 (2026-06-03) で 4 件とも解消済**。現役サポート版でパッチ供給あり。併せて hardening を投入: 全 webContents で `setWindowOpenHandler` deny + `will-navigate`/`will-redirect` のリモート遷移拒否 (`src/main/main.js`)、index.html / page-popup.html に CSP メタ (`script-src 'self'`)。**CSP は実機 WSLg スモークで合格 (2026-06-03)**: 画面フル描画 / 画像スタンプ blob: 表示 / 別窓描画、CSP 違反ゼロを確認 (CSP は Chromium が OS 非依存で適用するため WSLg 検証で代表可。問題時は CSP コミット `6c6b004` のみ revert 可)。**同スモークで Electron 41 の ESM 回帰 1 件を発見・修正**: ESM 化済 `main.js` の `kpdf3:resize-popup-to-fit` が `require("electron").screen` を呼び Node 24 の厳格 ESM で `require is not defined` → 別窓のページ追従リサイズが失敗していたのを、import 済 `screen` に置換 (`af224ad`)。
- **CI / 依存監視整備 (2026-06-03)**: (a) GitHub Actions ランナーの Node 20 ランタイム撤去 (2026-06-16 で Node24 強制 / 09-16 削除) に追従し、`actions/checkout`・`actions/setup-node` を Node24 対応の最新メジャーへ更新し **commit SHA で固定** (checkout v6.0.3 / setup-node v6.4.0。tag 再ポイント攻撃 [tj-actions/changed-files CVE-2025-30066] 対策、release は `package-manager-cache:false` で no-cache 維持)。アプリのビルド Node は `node-version:22.22.2` 固定のまま不変。(b) **Electron 42 化を月次自動監視する claude.ai routine を作成** (`trig_014hyr1dE1yVZZWf23J1PRZN`、毎月1日 09:05 JST。`gh api` で better-sqlite3 の electron-v146 prebuild + issue #1474/#1475 を判定し、揃えば 42 化 PR を自動準備・マージはしない)。GitHub は `/web-setup` で接続済、テスト実行で動作確認済。
- **直結 print が落ちる**: OS 印刷ダイアログを `webContents.print({silent:false})` で出すと、ユーザーが dialog を閉じた瞬間に Electron の PDF プラグイン teardown が crash する。**β72 案 D で構造的に解決** (Adobe `/p` でネイティブダイアログを使う = Electron 経路を完全に避ける)
- **空の `fonts/` ディレクトリ**: IPAex は M6 で同梱予定
- **userData 集中保管の副作用**: kpdf3 が `~/.config/K-PDF3/workspaces/` に置かれる (ADR-0007)。machine 間移植は手動コピーが必要。M6 で「workspace export package」UI 検討余地あり
- **書き出しはラスタライズ + ハイブリッド組立**: 編集なしページは元 PDF を vector 維持で copyPages、編集ありは元 vector + 600dpi overlay PNG、回転は embedPdf + drawPage で vector 維持 (β8)
- ~~**外部 PDF 挿入 synth の viewer プレビューが image_blob fallback で動作している**~~ **(β.80 commit a1678ce で根治済)**: β34〜β79 全期間、`kpdf3:render-inserted-source-page` (vector 経路) が存在しない `Workspace.listInsertedPages` を呼んで常に throw → viewer の try/catch が握り潰し image_blob fallback に縮退していたバグ。`Workspace` に sqlite-store の関数を thin wrap する method を追加して復活

### 15.2 将来の判断ポイント

- **IPAex 明朝の同梱方法** (M6): fonts/ 配下に置く方針は確定。テキスト層 flatten export が要件化したら本格実装
- ~~**qpdf の同梱方法** (M6)~~ ✅ **3 OS 同梱完了** — Win (β.84 `vendor/qpdf/win/`) / Linux (β.145 公式 portable v12.3.2) / Mac (2026-06-05 M1 で自己完結バンドル `vendor/qpdf/mac/{bin,lib}/`、arm64 専用・最低 OS 26.0)。全経路 `--remove-info --remove-metadata`
- ~~**annotation read-only proxy** (M6)~~ ✅ β.83 で実装 (種別ごとアイコン分岐 + native title tooltip)
- **userData の workspace を別 PC へ持ち運ぶ UI** (M6): 現状は手動コピー、export package (zip) で集約する案。**アプリ外の定期バックアップは 2026-07-05 に運用開始済み** (`docs/backup/backup-workspaces.bat` + `BACKUP.md`、robocopy /MIR で X:\K-system\K-PDF3-backup へ、タスクスケジューラ毎日 02:00 + 電源 ON 追いつき、復元はフォルダ書き戻しだけ=fingerprint 索引がパス非依存、REVIEW-2026-07 #2)
- **asset DB 共有 by SHA-256 dedup** (M5 / M6): source_pdf BLOB の重複削減

### 15.3 ADR 状況

| ADR | 内容 | 状態 |
|---|---|---|
| 0001 | workspace 保存形式 = SQLite | ✅ |
| 0002 | mupdf layout engine 採用 | ✅ |
| 0003 | canonical coordinate (PDF point 72dpi / top-left / 紙アナロジー) | ✅ |
| 0004 | Electron 版固定 → **2026-06-03 に 41.7.1 へ更新** (better-sqlite3 12.10.0 で 41 prebuild 提供・38 EOL 脱却、§更新節) | ✅ |
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
| 0020 | 申請書テンプレ機能 (form_field 4 サブタイプ + 記入モード + 下敷き印刷 + システムフォント + 後付け編集) | ⏳ 起草待ち (実装は β.80/β.81 で完了) |
| 0021 | annotation read-only proxy (mupdf 経由抽出 + 15 種別 viewer 表示) | ⏳ 起草待ち (実装は β.83 で完了) |
| 0022 | secure export / qpdf sanitize (--remove-info --remove-metadata、書き出しダイアログにチェックボックス) | ⏳ 起草待ち (実装は β.84 で完了、Windows のみ同梱) |
| 0023 | image export (PDF→PNG/JPEG + 範囲画像、`composePageImage` / `composeRegionImage`、main 側 `save-image-file(s)` IPC) | ⏳ 起草待ち (実装は β.97 で完了) |
| 0024 | autoshape overlay type "shape" (9 kind + 8 方向 + length/crossSize モデル、中心基準描画 + ctx.rotate、bbox AABB 派生、↻↺ ボタン UI) | ⏳ 起草待ち (実装は β.100-104 で完了) |
| 0025 | パスワード保護 PDF 復号 (import 境界で qpdf `--decrypt`、空パスワード先行→必要時のみ 98 風プロンプト、復号版をワークスペースに保存、`pdfIsEncrypted` 検出 + 既存ワークスペース self-heal) | ⏳ 起草待ち (実装は v2.0.1/2.0.2 で完了。起草時は平文化警告 + `source_was_encrypted` フラグ (v2.0.12-beta.3、REVIEW #3) と将来の再暗号化方針も含める) |
| 0026 | 戻せる確定保存 (確定を可逆化。フラット版をディスク書出 + 編集可能マスターを温存 →「編集可能な状態に戻す」で復元。単一マスター型 Model Y、workspace lineage 紐づけ) | ✅ 実装済 (v2.0.12-beta.1、commit `7b9b822`)・β トライアル中 (stable 昇格待ち) |
| 0027 | workspace 保持ポリシー + 手動お掃除「ワークスペースの整理」(手動のみ / predecessor・開タブ無条件保持 / 開いただけ即候補 / 編集あり N ヶ月・既定 3 / ごみ箱 + index.db 同時削除) | ✅ 実装済 (v2.0.12-beta.2、ADR `3f83f6f`・実装 `bd73372`)・実機確認済 (2026-07-05) |

### 15.4 architecture decision 待ち（未確定）

- 共通 asset library の DB 配置: アプリ全体で 1 つの SQLite ファイル (`~/.config/K-PDF3/assets.db`) に保存する方針はユーザー承認済。実装は M6
- ~~パスワード保護 PDF 対応: 将来検討~~ ✅ **v2.0.1/2.0.2 で実装** (ADR-0025 候補)。開く経路 (`kpdf3:open-pdf-file`) で `pdfIsEncrypted(pdfBytes)` 判定 → qpdf `--decrypt` を **パスワード stdin 経由** で実行。空パスワードを先に試し、権限制限のみ/空ユーザーパスワードの PDF はプロンプトなしで復号、実ユーザーパスワードが要るときだけ 98 風入力モーダル (`customPasswordPrompt`, `dialogs.js`)。復号版をワークスペースに保存するので下流 (閲覧/編集/書き出し/印刷) は不変。ワークスペースは**元 (暗号化) ファイルの fingerprint** で索引するので再オープン時も同一 workspace が再利用され編集は保持される (**ただし復号ゲートは毎オープンで on-disk の暗号化バイトに走るため、実ユーザーパスワード PDF は再オープンごとに再入力が必要** — 2026-07-06 コード確認。旧記述「再入力不要」は誤り)。**残課題/スコープ外**: (a) 書き出し/保存はパスワードを外した PDF になる (再暗号化は未実装) — **v2.0.12-beta.3 (REVIEW #3) で開いた直後の警告を実装済**。実ユーザーパスワード入力時のみ 98 風モーダルで「保存・書き出しで保護が外れる」と毎回警告し、workspace metadata に `source_was_encrypted` を記録 (パスワードは保存しない、将来の再暗号化オプションの判定用)、(b) 外部 PDF の D&D ページ挿入経路は未対応 (`kpdf3:import-pdf` / insert 系は復号ゲート未通過)、(c) `pdfIsEncrypted` は毎オープンで mupdf openDocument を 1 回追加で走らせる (lazy parse なので軽微)
- ブランディング: アプリ表示名は K-PDF2 のまま維持 (リポジトリ名のみ k-pdf3)
- **戻せる確定保存 (ADR-0026、実装済 v2.0.12-beta.1・β トライアル中 — 以下は設計当時の記述)**: 下書き/確定の二律背反 (下書き=Dropbox/他アプリで編集が見えない / 確定=画像化で後から編集不可) を、確定の可逆化で解決。確定はフラット版をディスクへ書き出しつつ、その時点の編集可能状態を『編集可能マスター』として温存し「編集可能な状態に戻す」で復元する。**単一マスター型 (Model Y)** = ドキュメント 1 つにつきマスター 1 つ、過去世代ロールバックは Dropbox 上のフラット PDF (版名) に委ねる (ADR-0008 思想)。同一性は **workspace lineage** (焼き込み workspace に predecessor、パス非依存で Dropbox 移動に強い、外部改変で切れたら「編集可能版が見つかりません」と明示)。容量は元 PDF バイト共有 (dedup) で overlay 差分のみ=据え置き (保持ポリシー N 不要)。保存モードは下書き/確定の 2 つのまま・新ボタンなし、「戻す」は別の復元アクション、確定ダイアログ文言を「動かせなくなります」→「あとで戻せます」に改訂。qpdf メタ除去はディスクのフラット版のみ、内部マスターは編集可能を維持。既存の印刷/回転/下敷き/byte-copy ゲートには非干渉 (新経路の追加)。**次は実装細部** (predecessor スキーマ配置 / 巨大 PDF external sidecar の source 共有 refcount / 戻す導線 / マスター一意性 / 下書き併用の状態遷移)。前提: 描画は `workspace.getSourceBytes()` 内部コピー (`main.js:1424`)・fingerprint 索引 (ADR-0007)・確定は現状も旧 workspace を孤児化して残すだけ。memory `[[project_reversible_flatten_save_adr0026]]`

### 15.5 リファクタ候補

- **S6 (split-view + sidebar-thumbs 抽出)**: B2 残置責務。緊急性なし
- **`workspaceMutated` フラグは hacky**: 挿入も pending workflow に統合する方が綺麗 (temp pageNo 採番 + Ctrl+S で flush)。ただし削除と並列管理になり複雑度増、現状の hack で実用上は十分
- **テストカバレッジ不足**: 2026-05-10 以降の追加機能 (ページ削除 / 挿入 / Save As / 検索 / スタンプ管理 / 画像スタンプ / 編集可能しおり / callout / タブ別ウインドウ) は手動確認のみ。Electron runner で round-trip テストを追加すべき

### 15.6 Mac/Linux を Windows 同等にするには（後学メモ、2026-06-06）

> v2.0.0 stable は 3 OS で配布できる（インストーラが起動し、中核機能は動く）が、**業務でフル運用が実証済なのは Windows のみ**。Mac/Linux で「Win 機同等」に使うには追加開発が要る。2026-06-06 にユーザーから「後学のために」必要作業とハードルの整理を依頼され、コードを確認した上でまとめたもの。**Acrobat を Mac/Linux に入れても解決しない**（後述①）点が要旨。

#### 何が Windows 専用か（OS 依存は「外界とやり取りする層」に集中）

中核（mupdf レンダリング / overlay 編集 / qpdf sanitize / PDF 組み立て）は OS 非依存。Windows 専用なのは:

1. **印刷エンジン** — Sumatra (`vendor/sumatradpf`, Win exe) / Adobe `/p` / Chromium silent fallback。`process.platform==="win32"` ガード (`main.js` `printPdfViaReaderDialog` 周辺)
2. **PDF Reader 検出** (`src/main/pdf-reader-finder.js`) — `C:\Program Files\Adobe\...\Acrobat.exe` 等の **Windows パス/exe のみ** 探索。Mac の `/Applications/Adobe Acrobat.app` は見ない → **Mac に Acrobat を入れても呼ばれない**
3. **印刷キュー監視 / 自動クローズ** — Win32_PrintJob (PowerShell `Get-CimInstance`) / Adobe MainWindowTitle (PowerShell `Get-Process`) / `taskkill`。すべて win32 専用 (`snapshotPrintJobs` / `snapshotAdobeTitles` / `killNewPdfReaderProcesses`)
4. **印刷設定の反映** — 用紙/トレイ/両面/カラー = Windows DEVMODE (`src/main/printer-properties-win.js`)
5. **FAX 送信** — FUJIFILM 等の driver-private DEVMODE 処理 (`applyCleanFaxDevmode` / 宛先 0 埋め)
6. **Office 挿入** (β.130 `file-to-pdf.js`) — Word/Excel を **COM 自動化** (PowerShell) で PDF 化 → Windows + Office インストール前提
7. **フォント** — システムフォント列挙 (Win=PowerShell InstalledFontCollection / Linux=fc-list / **Mac=未対応**)、CJK fallback (`mupdf-font-fallback.js` は **Win+Linux のみ、Mac 未実装**、β.113)
8. **インストーラ/関連付け** — NSIS + `customInstall` sentinel (Win)。Mac=Info.plist、Linux=.desktop で別機構

非 win32 では上記をスキップし `silentPrintPdf` (Chromium `webContents.print()`) にフォールバック → 印刷自体は可だが低精度・FAX 不可・β.91 の縮小懸念。

#### 必要な作業（機能別）

- **印刷（最大の山）**: Mac/Linux 共通の **CUPS** を直接使うのが筋。`lp`/`lpr` で組み立て済み PDF を直送（CUPS は PDF をネイティブ処理 = むしろ Adobe 経由より素直に高品質になり得る）。用紙/両面/トレイは CUPS オプション (`-o media=A4 -o sides=... -o InputSlot=...`) に対応付け = **プリンタの PPD 依存** → PPD を読む層 (DEVMODE 層の作り直し) が要る。**嬉しい副作用**: 外部アプリ (Adobe) 起動→監視→kill の機構 (案 X / taskkill / タイトル監視) が**丸ごと不要**になり構造が単純化、ジョブ状態は `lpstat` で取れる
- **FAX（最難関）**: 複合機 FAX が CUPS キューとして見えれば `lp` に宛先番号をオプションで渡す形だが、**宛先の渡し方はメーカー/ドライバ完全依存**で汎用解が無い可能性 (Windows の FUJIFILM 個別対応と同質の作り込み)
- **Office 挿入**: COM が無いので **LibreOffice headless** (`soffice --headless --convert-to pdf`) に置換。ただし同梱は +300MB (過去に却下)、ユーザー別途インストールかの二択
- **フォント (Mac)**: `pickFontFile` に Mac の CJK パス (ヒラギノ `/System/Library/Fonts/...`) 追加 = 小。システムフォント列挙は `system_profiler SPFontsDataType` 等 = 小
- **配布/インストール**: Mac=**署名 + 公証**(Apple Developer $99/年 + 証明書 + 毎リリース公証、**未署名だと Mac の autoUpdater も効かない**)、最低 OS 26.0 の見直し。Linux=AppImage の **`--no-sandbox` ラッパ or user namespaces**（2026-06-05 実機で素の起動が SUID サンドボックスで FATAL を確認、`--no-sandbox --ozone-platform-hint=x11` で正常起動）、.desktop 関連付け、Wayland のショートカット不発 ([[project_kpdf3_shortcut_unresolved]])

#### ハードル

1. **実機テスト必須** — 印刷バグは実プリンタ×実ドライバ×実 OS でしか出ない。Windows の印刷経路は β.54〜.138（案 M/N/N'/ζ/C/D/X の約3週間）かかった。CUPS は Windows ドライバより統一的なので短縮見込みだが、各 OS で実機サイクルは要る
2. **FAX は別格** — 機種依存で汎用解が無い恐れ。「その複合機で本当に必要か」を見極めてから着手
3. **Mac 署名/公証は恒常コスト** — 一度きりでなく毎リリース。これ無しでは Mac autoUpdater も動かない
4. **Office 変換のジレンマ** — 機能パリティ(LibreOffice +300MB)と配布サイズのトレードオフ
5. **分岐の保守コスト** — `process.platform` 分岐と OS 別経路が増える（3-layer 分離で印刷は main 側に閉じてはいる）
6. **人的リソース** — Windows 版は専属テスター1名+約1ヶ月。Mac/Linux 同等化は特に印刷でプラットフォームごとに相応の工数

#### 現実的な進め方（段階）

- **Step 1（軽・効果大）**: Mac/Linux の印刷を Chromium 印刷 → **CUPS 直送 (`lp`) + 用紙サイズ指定**に置換（「普通に正しく印刷」+ Adobe 監視の複雑さ不要）。Mac の CJK フォント追加も併せて
- **Step 2（中）**: 印刷設定 (両面/トレイ) の PPD 対応、システムフォント列挙 (Mac)、関連付け・ランチャ整備
- **Step 3（重・要判断）**: FAX、Office 挿入 (LibreOffice)、Mac 署名/公証 ← **その OS の利用者が実際に必要とするかで取捨選択**

要点: **印刷の土台 (CUPS) は意外と素直で、むしろ Windows より単純になり得る。重いのは FAX・Office・Mac 署名という周辺の特殊事情**。どの OS を本気で使うか（誰が使うか）を先に決めると範囲が絞れる。現状の業務主力は Windows。

---

## 16. 引き継ぎ運用

### 16.1 HANDOVER.md 更新ルール

- **明示的に依頼された時のみ大幅更新**
- マイルストーン完了時は §6.3 の状態欄と §7（実装済み機能）を更新
- 新しい ADR を起草したら §4.5 / §15.3 に反映
- **履歴の退避先 (2026-06-22 整理)**: 肥大化対策 (本書が 264KB に達し Read 上限超) として、完了 β の詳細変更ログ・§6.4 β.1〜β.150 全表・各 patch の full 詳細・§8 の完了済リストを `CHANGELOG-history.md` へ分離した。**役割分担: `HANDOVER.md` = 現役の正 (現状サマリ / 設計思想・禁止事項 / オープン項目 / ユーザー要件)、`CHANGELOG-history.md` = 経緯の保管庫 (いつ何をなぜ)**。本書の各ポインタ (現状サマリ / §6.4 / §8) から該当章を案内している。再び肥大したら、完了・確定したものを同様に archive へ移し、本書は要約 + ポインタに保つ。印刷 / Adobe / FAX / render の試行錯誤を追うときは両ファイルを grep ([[feedback_handover_first_before_judgment]])。

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

§17.1-17.9 / §17.11-17.17 は完了済 (詳細は git log / commit message)。未完了は **§17.2 (D&D OUT)** と **§17.4 ライブ同期版 (B3 で代替可能)** のみ。

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
| 17.17 | サムネ D&D で別ウインドウへ選択ページ挿入 | ✅ β79 (B3-γ activeTabDrag のページ版、4 ドロップ経路 + COPY 動作 + 多選択 + 回転 + image-only synth 対応) |
| 17.18 | 申請書テンプレ機能 (フォーム枠 + 記入モード + 下敷き印刷) | ✅ β80/β81 (form_field 4 サブタイプ + popup + Tab nav + 下敷き印刷 + システムフォント + 後付け編集 + Shift+Enter 改行 + 上下左右揃え) |
| 17.20 | 申請書テンプレ UX 強化 (B-5 後付け編集 + B-6 Tab 順手動編集) | ✅ β82 (選択で options bar 自動切替 + 現在値 populate + 4 サブタイプ後付け対応 / tabOrder プロパティ + 番号バッジドラッグ + 別 popup 縦リスト + pulse highlight) |
| 17.19 | overlay の multi-select コピー/ペースト + 幅/高さ揃え | ✅ β80 (_overlayClipboard を Array 化、align-bar に「幅揃え」「高さ揃え」追加) |
| C3   | annotation read-only proxy (M6) | ✅ β83 (mupdf 経由 15 種別抽出 + 種別ごとアイコン分岐 + native title tooltip) |
| —    | qpdf sanitize / セキュア書き出し (M6) | ✅ β84 (qpdf 12.3.2 同梱 + --remove-info --remove-metadata + 書き出しダイアログにチェックボックス、デフォ ON) |
| —    | 真の墨消し (M6) | ✅ β.85 (redaction overlay があるページを 900dpi raster で焼き、ソース vector text 層を消去。書き出し / 印刷の全 8 経路) |
| —    | β.84 配布フィードバック 6 件まとめ改善 | ✅ β.85 (真の墨消し / stamp palette 横スクロール禁止 / text stamp 細字 / D&D 挿入後 scroll / stamp 並び順 ▲▼ / Adobe 残留診断) |
| —    | セキュア書き出しチェックボックスが見えない (β.84 来 hotfix) | ✅ β.86 (98.css 非互換 HTML を `<input><label>` 並列に修正 + 区切り線 + bold) |
| —    | カラー画像スタンプが薄くて 2 重登録を強いられる | ✅ β.87 (lum→alpha を閾値 ramp に変更、1 登録で押印 / 印刷の濃度担保) |
| —    | PDF を画像として保存 (PNG/JPEG)、PDF 内の一部を選択して画像として保存 | ✅ β.97 (`composePageImage` / `composeRegionImage`、解像度 5 段階、白黒モード、連番出力) |
| —    | 分割保存 part 名 textbox で Backspace 効かない | ✅ β.99 (`_isTextInputTarget` で textbox 入力時は browser default に逃がす) |
| —    | オートシェイプ的な図形 (直線・矢印・ブロック矢印・楕円 + 拡張で四角・角丸・×・双方・斜め) | ✅ β.100-104 (新 overlay type `shape` + 9 kind + 8 方向 + length/crossSize で太さ・長さ不変の 45° 回転、↻↺ ボタン UI) |
| —    | 上書き / Save As 後、開いているタブが新ファイル名に切り替わるように | ✅ β.131 (post-save 経路で `tab.activeSourcePdfPath` / `activeSourceName` を更新、タブラベル + タイトル + detach-to-window snapshot がすべて新ファイル基準に) |
| —    | クリップボードペースト画像の拡大縮小で縦横比を維持 | ✅ β.131 (`aspectLocked` プロパティ + 主軸方式 resize、palette 画像スタンプは従来通り自由) |

### 未完了

#### 17.2 サムネ → アプリ外への D&D で当該ページを名前付き保存 🚧 MVP 完了

サイドバーまたは分割保存のサムネを、デスクトップ等に D&D したら、そのページだけを抽出して新規 PDF として保存。

**現状**: サムネ右クリック → 「このページを PDF として保存…」/ 「N ページを PDF として保存…」 で代替済。純粋な D&D OUT は Electron `startDrag` の sync 問題があり別セッションで検討。

#### 17.4 別ウインドウでページ分離表示 (ライブ同期版) 🚧 代替可能

β2 で MVP 完了のスナップショット型 popup (`actionOpenPagePopup`) は「特定 1 ページだけを軽量に並べたい」用途で残置。**ライブ同期版が必要なら B3 (β71) の「タブを別ウインドウへ分離」で代替可能**。

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
