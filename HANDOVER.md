# K-PDF3 開発引き継ぎ書

最終更新: 2026-06-04
現在のバージョン: **v2.0.0-beta.146** (autoUpdater 経由で配布中、β 卒業準備フェーズ bug fix 期間)。**β.145 で Electron 38→41 化 + セキュリティ hardening (CSP / window.open・遷移制限) + qpdf Linux 同梱 + CI Node24 SHA 固定 + Electron 41 ESM 回帰修正 を配布** (β.144 までは Electron 38)。**Electron 41 の Windows 実機配布は β.145 が初** (CI test:m1 は windows-latest で Electron 41 起動 pass 済)。**β.146 でツールバーをアイコン化 + 幅が足りない時に表示倍率→検索→…の順で「»」へ動的退避 (小さい/低解像度モニターでツールバーが折り返す問題への対応、業務並走フィードバック)**。
リポジトリ: 開発リポ [windom21-cpu/k-pdf3](https://github.com/windom21-cpu/k-pdf3) (Public) / 配布フィード [windom21-cpu/k-pdf3-releases](https://github.com/windom21-cpu/k-pdf3-releases) (Public)

このドキュメントは、K-PDF3 の開発を引き継ぐ次の AI アシスタント（または別環境の自分）が会話履歴なしで作業継続できるよう書かれている。**着手前に §0 → §1 → §2 → §3 → §6 → §8 → §17 の順で必ず読むこと**。

> クローン同期メモ: 2026-05-12 に開発リポを Public 化する際 `git filter-branch` で全 commit/tag を rewrite + force push 済。同期済の環境では追加対応不要。古いクローンの場合のみ `git fetch --all --tags --force && git reset --hard origin/main` で再同期。

---

## 現状サマリ (1 分で把握)

**フェーズ**: **β 卒業準備 bug fix 期間 (2026-05-25〜06-01 目安、業務並走延長中)**。β.131 機能凍結ライン以降、業務並走で見つかった重大バグを β.133〜β.146 で対応中 (重大バグ修正が主、β.144/.146 は業務並走で明示要望のあった軽微 UX 改善)。並行で stable 残務 (qpdf Mac/Linux 同梱 / 診断ロガー撤去) を仕込み、重大バグなしを確認したら v2.0.0 stable へ。M6 残のうち annotation proxy / qpdf sanitize / 真の墨消しは β.83-.85 で完了、「後で」仮説恒久対応は β.132 で投入、**β.134 で巨大 PDF (712MB 級裁判所謄写) を SQLite BLOB ではなくサイドカーファイル化して開けるように構造修正**、**β.136 で墨消し書き出しの透過 PDF 黒背景バグを修正**、**β.138 で印刷送信中モーダル消失失敗 (Adobe Pro DC 親子分離下の Path B 沈黙) を構造解消**、**β.139 で installer の portable target 撤去 + 関連付け書込を sentinel 付き customInstall macro で初回 install 時のみに限定 (autoUpdater 更新時の「規定アプリリセット」通知 + 「アイコンあり/なし K-PDF3 が 2 つ表示」現象を構造解消)**、**β.140 で 2026-05-27 業務並走フィードバック 9 件 (テキスト UX 6 + 保存 UX 3) + MS 明朝が印刷物で薄くドット化する根本対策 (hairline 経路に fillText 二重描きで AA 縁の濃度のみ上げる、glyph 太さは不変) を投入**、**β.141 で β.140 の追い込み 2 件 — (a) 明朝印刷密度を 2 回打ち → 4 回打ち (AA α 0.75 → 0.9375) に強化して横線のドット感も解消、(b) 配置済みテキスト枠を選択しても options bar が表示されない (β.140 で `refreshModeOptionsBar` に text 選択時の分岐を入れ忘れた配線漏れ) を修正**、**β.142 で回転した元 PDF (/Rotate≠0) の下敷き/通常印刷でオーバーレイ (記入値) だけが天地さかさまに印刷される重大事故を構造解消 (申請書下敷き印刷で実害発生、β4/β5 以来の潜在バグ — `assembleHybridPdf` が userRotation のみ補正しソース /Rotate を無視 + pdf-lib CCW vs PDF/mupdf CW の方向取り違え)**、**β.143 で吹き出しの後付け書式変更 (text 同様にフォント/サイズ/色/太字を選択後に変更) + 吹き出し枠はみ出し (入力画面では収まるのにサムネ/印刷で本文が枠外に漏れる) を構造解消 (採寸と exporter の折返し幅の下限不一致が根因、「枠を本文に合わせて自動拡大」方式で対応)**、**β.144 で業務並走の微調整要望 2 件 — (1) マーカーに「直線」種類を追加 (従来の範囲ドラッグに加え、一定の太さで水平にまっすぐ引く蛍光ペン式。種類/色/太さを options bar で選択・永続化)、(2) テキスト配置を sticky 化して連続入力可能に (1 枠ごとにモードが解除されていたのを維持。編集確定クリックでの二重配置は handlePagePointerDown の編集中ガードで抑止)**、**β.145 で β.144 以降に main へ積んだインフラ/セキュリティ整備を配布 (新機能なし) — Electron 38(EOL)→41 化 (better-sqlite3 12.10.0 で 41 prebuild) + hardening (全 webContents で window.open/リモート遷移拒否 + CSP) + qpdf Linux 同梱 + CI を Node24 対応 actions SHA 固定 + 別窓の ESM `require` 回帰修正。Electron 41 の Windows 実機配布は β.145 が初**、**β.146 でツールバーをアイコン化 (◎ アイコンのみ / ○ アイコン+小ラベル / △ は » 収納) + 全ボタンにホバー用途解説 + 幅あふれ時に表示倍率→検索→回転→… の順で実コントロールを「»」へ ResizeObserver で動的退避 (項目を「縮めない」方式にしたので高さ一定・テキスト縦並び/アイコンずれが起きない)**。

**直近完了 (β71〜β146、2026-05-14〜06-04)**:
- **β71** — B2 renderer.js モジュール分離完結 (8631→4472 行 / -48.2% / 12 モジュール) + B3 タブ別ウインドウ完成 (右クリック / ツールバー / File menu / drag tearout / drag dock-back の 5 経路)
- **β72** — 印刷経路を**案 D に再々設計**: K-PDF3 自前ダイアログを skip して Adobe `/p` でネイティブ印刷ダイアログ直接起動。**FAX freeze バグ根治** (β54-β70 の構造的問題、Adobe `/t` silent flag が driver UI 抑止する仕様 + β70 SW_HIDE 併発が原因)。案 X 印刷キュー監視 (`Win32_PrintJob` PowerShell) で Pro DC を 3 秒バッファ後 auto-kill
- **β73** — テキスト太字化バグ修正 (β34 の 0.03×fontSize overstroke を bold OFF 時 skip)。Adobe spawn の preamble を `Promise.all` で並列化 (~1 秒短縮)
- **β74** — **β51 以来未特定だった「PDF 開閉繰り返しクラッシュ」根治** (2nd-instance の `app.quit()` → `will-quit` → `globalShortcut.unregisterAll()` が `whenReady` 未到達で throw → `app.isReady()` ガード)。テキスト系 overlay の **シングル=選択 / ダブル=編集** 分離
- **β75** — D&D「開かない」報告対応で診断ログ仕込み。**最有力仮説**: β47 J5 の no-PDF-arg + lock 失敗 → `taskkill /F` が生きた 1st instance を誤殺している (2-30 秒間隔の session-start クラスタ多発)
- **β76** — クリップボード画像 paste (Ctrl+V / 右クリック、PNG/JPEG/WebP、max 200pt/8MB) / 明朝-serif の hairline 補強 (bold OFF + mincho/serif 限定 `0.02×fontSize` stroke) / 混在サイズ PDF の fit-width 中央寄せ + Ctrl+3 / 分割サムネに非 A4 バッジ
- **β77** — **外部 PDF D&D 挿入位置を視覚位置で確定**: 並び替えで synth ページが元のスロットアンカーから離れた状態で青線にドロップすると新規ページが「数ページ手前」にズレていた問題を根治。drop 時に gap 直前ページのキー (`afterKey`: source=pageNo / synth=-id / 先頭=0) を main に渡し、`getPages` の `orderKey` から `(lower, upper)` 算出 → ε 等分布で `display_order` 直接書込みに切替。`afterPageNo + order_in_slot` ベースの旧経路は `afterKey` 無し呼出向けに残置 (後方互換)。`addInsertedImagePage` に `displayOrder` 引数追加 (workspace + sqlite-store)
- **β78** — **外部 PDF 挿入の OOM + 応答停止を解消**: 30 MB × 25 ページ級の外部 PDF を青線にドロップすると main が同期で全ページ raster + SQLite BLOB 書込を回し、(1) wasm heap 累積 + ピーク 26 MB pixmap で OOM SIGKILL、(2) イベントループ 20-30 秒占有で OS の「応答がありません」検出が出る、の 2 段不具合があった。修正: (a) `image_blob` 生成 zoom を 300 → 96 dpi に下げ。ピーク pixmap 26 → 2.7 MB、workspace 増分 25 MB → 5 MB、raster 時間 ~7x 短縮。(b) 各ページループ先頭で `setImmediate` yield 1 tick → OS「応答監視」をパス。(c) `kpdf3:insert-pdf-progress` IPC 新設、busy modal で「外部 PDF を取り込み中... (N / M)」+ navy バーが進む。**※** β78 の commit メッセージは「image_blob はフォールバック専用、vector path で鮮明さ担保」と書いたが、これは β.79 で発覚した通り誤認 — `kpdf3:render-inserted-source-page` が β34 以来ずっと throw していて image_blob fallback が常用されていた (詳細は §15.1 / memory `[[kpdf3-inserted-source-vector-bug]]`)
- **β79** — **サムネ→別ウインドウへページ挿入** (cross-window thumb D&D)。B3-γ `activeTabDrag` のページ版を main に新設 (`activePageDrag` + `page-drag-start` / `page-drag-end` / `page-bar-drop` IPC)。サイドバー / 分割画面のサムネを別ウインドウの +gap / サムネ / 分割画面にドロップ → 選択ページを synthetic page (COPY 動作、ソース不変) として挿入。多選択は sidebar 順を維持、userRotation は /Rotate に baking、image-only synth (β78 fallback / 旧 workspace) も 1 ページ PDF にして対応。`kpdf3:add-inserted-pdf-pages` 本体を `_insertPdfBytesIntoWorkspace({workspace, pdfBytes, ...})` に切り出して再利用、`_extractPagesAsPdfBuffer` + `_reopenDocForTab` 新設。**修正したクロス窓特有バグ**: (a) Linux Electron で dragend が drop より先に走る race → `page-drag-end` の clear を 500ms 延期 (snapshot 比較で次の dragstart 来ていれば no-op)、(b) `kpdf3:get-inserted-page-image` / `get-inserted-source-pdf` がグローバル `activeWorkspace` を使っていてクロス窓直後にターゲット renderer の画像取得が失敗 → サムネ白紙化 → `activeForEvent(event)` per-window 化
- **β80** (2026-05-16): **申請書テンプレ機能一式 (ADR-0020 案件、未起草) を Phase A〜E で投入** + β34〜β79 の既存バグ 2 件まとめて修正:
  - **新 overlay 種別 `form_field`** + 4 サブタイプ (text/check/circle/radio)。schema migration + project-store typedef + sqlite-store の CHECK 制約拡張 (Phase A)
  - **ツールバー「フォーム」1 ボタン + popup** (スタンプ palette と同流儀、draggable + 位置永続化)。popup に 4 サブタイプボタン + 「記入モード」トグル
  - **記入モード**: Tab/Shift+Tab で次/前のフィールドへ自動順 (ページ順 → Y 昇順 → X 昇順、6pt ε で行バケット)、Enter は commit + 次へ、Space は focused check/circle/radio をトグル、Esc で記入モード解除。新規 `form-fill.js` モジュール (Phase C)
  - **下敷き印刷**: 「下敷き印刷」ボタン + 注意ダイアログ → 全ページを overlay-only strategy で組み立て → Adobe `/p` 経路。背景 PDF を出さず空白ページ + overlay PNG だけが用紙にのる。assembleHybridPdf に新 strategy 追加、composePagesForExport に `overlayOnly` フラグ (Phase D)
  - **システムフォント選択** (form field 限定): main で `kpdf3:list-system-fonts` (Linux=fc-list / Win=PowerShell + InstalledFontCollection、cache あり)、renderer 起動時に form-text-font select を <optgroup プリセット + システム> で再構築、`getTextFontStack` を system font 名 fallback 対応 (Phase E)
  - **multi-select コピー/ペースト** (Ctrl+C/Ctrl+V、右クリック「コピー」「貼り付け」): `_overlayClipboard` を Array 化、相対位置を維持して +12pt/+12pt で群一括 paste
  - **幅揃え/高さ揃え**: align-bar に「幅揃え」「高さ揃え」ボタン追加。primary (= 最後 click 選択) 基準で揃える (PowerPoint 流)
  - **テキスト枠の上下左右揃え**: form-text に `alignH` (left/center/right) + `alignV` (top/middle/bottom) プロパティ。viewer は flex justify/align で、印刷経路は drawOverlay の手描き計算で対応
  - **既存バグ 2 件根治**:
    1. `kpdf3:render-inserted-source-page` の vector path が β34 以来常に throw (`Workspace.listInsertedPages` が export 漏れ) → thin wrap で復活、image_blob fallback の出番が無くなる
    2. drawOverlay (exporter.js) に form_field 分岐が無く、下敷き印刷で値が一切印字されない状態だった (Phase D で初発見、Phase B-3 commit cf1eff5 の漏れ) → 4 サブタイプの実描画を追加
- **β81** (2026-05-17): β.80 配布直後のユーザー要望に対応する小マイナー
  - 丸囲み: click で真円配置 (旧 drag → click)、options bar に「サイズ」select (14/18/24/32/48pt)、四隅ハンドルで楕円に変形可
  - フォーム枠 (form-text) のフォント/サイズ/色/横/縦 を **後付け変更**: 配置済みのフィールドを選択 (or 編集中) → form-text-* select 変更で即反映。`applyFormTextStyleToEditingOrSelected` を新設
  - 記入モードで **Shift+Enter 改行**: Enter 単独は従来通り「commit + 次へ」、Shift+Enter は browser default に任せて `<br>` 挿入
- **β82** (2026-05-17): 申請書テンプレ UX 強化 (Phase B-5 + B-6)
  - **B-5 後付け編集 UX**: form_field を 1 つ選択した瞬間に options bar が fieldKind 専用パネルへ自動切替 (placement モード入り直し不要)、その枠の現在値で select を populate。値変更で編集中 / 選択中の overlay にライブ反映。β.81 で text 限定だった `applyFormTextStyleToEditingOrSelected` を `applyFormFieldStyleToEditingOrSelected` に拡張し check / circle / radio も後付け編集可。入力中の `document.activeElement` ガードで radio group のテキスト入力中にカーソルが消えない
  - **B-6 Tab 順手動編集**: `form_field.properties.tabOrder` (整数) を採用、`_computeTabOrder` を explicit ↔ auto 合成順 (explicit を昇順で先頭、auto は従来の Y→X で末尾) に変更。フォーム palette に「Tab 順を編集」ボタン追加。モード ON で:
    - 全 form_field の左上に **番号バッジ** (赤チップ、内側 top:0/left:0 配置で page overflow に切られない)。バッジを別フィールドへドラッグで「その位置に挿入 + 全 form_field を 1..N 再採番」(1 CompositeCommand)
    - 別 popup「**Tab 順**」(縦リスト) も同時表示: 各行 = ページ + 種類 + 値プレビュー、行を上下ドラッグで並べ替え (DOM 順から commit)、行クリックで本文 overlay を選択 + 中央スクロール + 1 秒の赤い pulse highlight (次に並べ替える対象が視覚的にわかる)。popup は draggable + 位置永続化 (`kpdf3.tabOrderPopupPos`)
    - 記入モード / placement モードとは排他制御。paste 時は tabOrder を捨てて重複防止
  - 副次: project-store typedef の form_field properties を tabOrder / alignH / alignV / strokeWidth 明文化
- **β83** (2026-05-17): **C3 annotation read-only proxy** (M6 残作業の 1 つ) — Adobe で押した annotation を viewer 上に read-only marker として表示
  - mupdf 経由で source PDF から 15 種別を抽出 (Text/FreeText/Highlight/Underline/Squiggly/StrikeOut/Stamp/Ink/Line/Square/Circle/Polygon/PolyLine/Caret/FileAttachment/Redact)。`/Rect` + `/Contents` + `/T` (author) + `/C` (color) + Highlight 系の `/QuadPoints` + Ink の per-stroke bbox を保持
  - backend: `src/backend/mupdf-annotations.js` (`extractPageAnnotationsFromDoc` / `extractAllAnnotations`)、main: IPC `kpdf3:get-all-annotations` + TabHandle.annotations per-tab メモリキャッシュ (初回呼出で全ページ extract → 以降は再利用)
  - domain/coord.js に `pdfRectToCanonical` (canonicalRectToPdf の逆) を追加。viewer の `_pageBoxMap` で PDF native rect → canonical 変換、zoom 変更で annotation 保持
  - 種別ごとの retro 風スタイル: 付箋 (Text)=黄 "T" / Caret=水色 "^" / FileAttachment=紫 "@" / Highlight=半透明黄 per-quad / Underline=緑線 / Squiggly=赤波線 / StrikeOut=赤取消 / FreeText=青破線枠 + 内容 / Stamp=オレンジ枠 / Square/Circle/Line/Polygon=茶薄枠 / Redact=赤破線 / Ink=灰点線。ホバーで OS native title tooltip (種別 + author + 内容)
  - 印刷経路 (Adobe `/p`) と export 経路は不変 — annotation は workspace に持たない外部読取専用 proxy
- **β84** (2026-05-17): **qpdf sanitize / セキュア書き出し** (M6 残作業の 1 つ) — 法律実務の提出版 PDF 作成用
  - 書き出しダイアログに「セキュア書き出し (個人情報・編集履歴を消去)」チェックボックス追加 (デフォ ON、localStorage 永続化)。actionExport / actionExportRange / actionSavePagesAsPdf の 3 経路で有効
  - qpdf 12.3.2 を spawn (`--remove-info --remove-metadata` + `--warning-exit-0`)。Info dict 全削除 (Author/Title/Subject/Keywords/Creator/Producer/CreationDate/ModDate) + 文書レベル XMP /Metadata 削除 + xref 再構築 + 全オブジェクト renumber。**/Outlines (しおり) は保持される** ので業務で困らない
  - バイナリ同梱: `vendor/qpdf/win/` に qpdf 12.3.2 msvc64 (qpdf.exe + qpdf30.dll + msvc ランタイム DLL 群、8.2 MB)。`package.json build.win.extraResources` で resources/qpdf/ にコピー (Sumatra と同じパターン)。**Linux は 2026-06-03 に公式 portable (v12.3.2, SHA256 検証済) を `vendor/qpdf/linux/` に bin+lib 同梱 (実機で自己完結起動を検証)。Mac は公式プリビルドが無く未配置 (`vendor/qpdf/mac/README.md` に brew+dylibbundler 手順、実機ビルド待ち)**。未配置 OS は PATH 経由で system qpdf を fallback ルックアップ
  - `src/main/qpdf-sanitize.js`: `findQpdfBinary` (extraResources → vendor → PATH の順) + `sanitizePdfBytes` (tmp ファイル経由 spawn)。qpdf 未検出時は `qpdfMissing: true` で response、sanitize エラー時は throw (ユーザが「セキュアでない」と気付かないリスク回避)
  - `customConfirm` の `cancelLabel: null` で取消ボタン非表示対応 (qpdf 未検出時の通知ダイアログ用)
  - file-browser.js: `secureExportToggle: true` で save モードに row 表示、resolve を `{ path, secureExport }` に変更
  - 動作確認: 山田太郎 / Title / Producer 入り synthetic PDF を sanitize → 出力に該当文字列が一切残らないことを確認 (qpdf 12.3.2 on Linux x86_64 にて手動)
- **β85** (2026-05-18): β.84 配布フィードバック 6 件まとめて改善
  - **#3 真の墨消し** (M6 残作業) — redaction overlay を含むページは `strategy=full` に強制し source PDF の vector text 層ごと 900dpi raster に焼く。これまで `strategy=overlay/external` で vector ソースをそのまま copy していたため Adobe で墨消し下のテキストを選択 / 検索 / 抽出できる構造的 leak が残っていた。書き出し 4 経路 + 分割保存 + 印刷 3 経路の全 8 callsite で `rasterRedactionPages: true`。redaction overlay 無しのページは従来通り vector copy で維持 (file size 影響は墨消し置いたページのみ)。**書き出しダイアログのセキュア書き出しラベルを「個人情報・編集履歴・墨消し下の文字を消去」に拡張**
  - **#4 スタンプ palette popup の横スクロール禁止** — `.stamp-palette-popup .stamp-preset-palette` に `overflow-x: hidden`、`.stamp-preset-label` に `text-overflow: ellipsis` + `white-space: nowrap`、`.stamp-preset-btn` に `min-width: 0`。長い preset 名で popup が横に広がらない
  - **#6 テキストスタンプ印刷時の太字解消** — `stampKind === "text"` の経路で `bold` font weight + 0.06×fontSize overstroke を skip (`drawStampMixedTextOnCanvas` 内 `opts.bold !== false` 判定)。date stamp (印影) は従来通り bold 維持。viewer の `el.style.fontWeight` も `stampKind === "text" ? "normal" : "bold"` で WYSIWYG
  - **#2 サムネ間 D&D 挿入後のスクロール位置維持** — 挿入完了時に `viewer.scrollToPage(syntheticPageNos[0])` で挿入ページの先頭まで移動 (これまでは `refreshViewer` 後に先頭ページに戻り「追加した書類がどこに行ったか分からない」UX だった)
  - **#5 スタンプ並び順を後付け変更** — スタンプ管理ダイアログに ▲ ▼ ボタン追加 (先頭/末尾で disabled)。sqlite-store に `setStampPresetsOrder(db, ids)` + IPC `kpdf3:set-stamp-presets-order`。palette popup の並びも自動追従 (`refreshStampPresetCacheAndSelect` 経由で `rebuildStampPalette`)
  - **#1 印刷後 Adobe 残留の診断強化** — `killNewPdfReaderProcesses` を await 化して taskkill exit code を per-PID で記録、500ms 後に再 snapshot して生存プロセスを `survivors` として crash.log に記録。`sp.on("close", ...)` を settled 済でも `logCrash("pdfreader-process-closed", ...)` でタイムスタンプ付き記録に。**`survivors` リストは 500ms 時点のスナップショットなので、後続のユーザー手動 × が「異常なし」と誤判定されない構造** (手動 × が来る前に diagnostic 確定)
- **β86** (2026-05-19): セキュア書き出しチェックボックス可視化 hotfix
  - β.84 で導入したセキュア書き出しチェックボックスが、98.css 非互換の HTML 構造 (`<label><input></label>`) で input 自体が描画されず、ラベル文字だけ見えていた問題を修正。**並列構造 (`<input><label>`) に切替** + 専用 `.open-row-secure` クラスで共通 `.open-row label { min-width: 80px }` の override + `border-top: 1px dotted #808080` の区切り線 + `font-weight: bold` でラベル強調
  - ユーザ報告「気付かなかった」を受けた β.85 配布直後の hotfix
- **β87** (2026-05-19): 画像スタンプの濃度を閾値 ramp で確保
  - 線形 `lum → alpha` 変換だとカラー印影 (赤 lum≈0.32 / 青 lum≈0.27) が alpha 60-70% で薄く印刷される問題があり、ユーザは「カラー画像と白黒画像の 2 重登録」を強いられていた
  - `lum → alpha` 変換を**閾値 ramp** に変更: `lum ≤ 0.5` → factor 1.0 (印影=完全不透明) / `lum ≥ 0.85` → factor 0.0 (紙白=完全透明) / 中間 → 線形 ramp (AA エッジを残す)
  - 3 経路すべてに適用: `stamp-helpers.js` `tintCanvasInPlace` (preview / palette / ghost) / `exporter.js` `getTintedAssetCanvas` (書き出し時) / `viewer.js` `applyTintInPlace` (viewer 表示時)。`bg-transparent` モードと `#rrggbb` tint モード両方をカバー
  - 副作用: 中間グレー (lum 0.5-0.85) はやや濃く印刷される (印刷品質の改善方向)。既存白黒スタンプ (lum=0) は不変。既存のカラー画像スタンプは tint cache 再生成時に自動で濃くなる (再登録不要)
- **β88** (2026-05-19): 白黒印刷モード + FAX 送信ボタン + Phase 3 (rasterAllPagesForFax 900dpi) ← **致命事故あり、β.89 で hotfix**
  - **Phase 1 — 白黒印刷モードトグル**: ツールバーに `btn-mono-print` (sticky toggle、localStorage 永続化)。ON で `composePagesForExport({monoOverlays: true})` を渡し、drawOverlay で overlay 色を `#000000` に projection。対象は text / stamp (画像含む、tint 強制黒) / form_field / callout / 形 / redaction。マーカーは除外、redaction "white" 指定は維持
  - **Phase 2 — FAX 送信専用ボタン**: ツールバーに `btn-fax-send`。左クリック = streamlined silent print 直送 (mono 強制、ページサイズ混在検出ミニダイアログ)、右クリック context menu = Adobe 経由 escape hatch + FAX プリンタ変更。FAX プリンタは localStorage 記憶 (初回 picker)
  - **Phase 3 — FAX 経路の 400dpi pre-raster (明朝保険)** ← 実装ミスで **900dpi** で固定化 (`EXPORT_ZOOM` を流用)。これが致命事故の元
  - **致命事故**: Phase 3 の 900dpi 全ページ raster で PDF サイズが 30-60MB に膨張 → Adobe / Chromium silent の print pipeline が窒息 → printer 側が「データ受信失敗」のフォールバックで **物理印字が黒ベタ** で出る + Chromium 側は `silent-print-failed: Print job canceled`。万一 FAX 送信していれば**相手に黒紙 1 枚が届く実害**だった。ユーザが「物理印字でテスト」して事故を未然に防止
- **β89** (2026-05-19): β.88 致命事故 hotfix
  - **Phase 3 完全削除**: `rasterAllPagesForFax: true` を `actionFaxSend` から削除。明朝保険は後で再設計に回す (低優先、後述の §15.1)。`composePagesForExport` の rasterAllPagesForFax パラメータ定義は残置するが動作には影響しない (デフォ false)
  - **FAX picker の保険を強化**: FAX 系プリンタ (fax/ファックス/ファクス 含む名前) が見つからない場合は silently 全プリンタへ fallback しない (誤って通常プリンタを「FAX 送信」してしまう事故を構造防止)。記憶済 faxDevice が FAX 名でないとき (β.88 で汚染した痕跡対策) は確認ダイアログを出す
  - **送信先を busy modal に明示**: 「送信先: XXX へ送信中...」(誤送信に気付ける UI)
- **β90** (2026-05-19): **β.51 以来追跡中の「一瞬開いてすぐ閉じる」根治** (HANDOVER §8.2 #1 完了)
  - **真の根因が判明**: 「renderer crash で死亡」ではなく「primary `mainWindow` を閉じた + B3 子ウインドウが alive → `window-all-closed` 不発火 → app は alive のまま zombie 状態」が真の機序。`render-process-gone` がログに出ていなかったのは renderer は crash しておらず、 user が X で window を閉じた (または何らかの理由で `mainWindow = null` になった) だけだったから
  - **zombie 化した process が次の PDF launch を受信した時、`second-instance` ハンドラは `mainWindowAlive=false` を検知して paths を pendingOpens に push するだけで何もウインドウを出していなかった** → 新規 PDF launch インスタンスは singleton lock 失敗で `app.quit()` 即終了 → ユーザ視点で「一瞬開いて閉じた」、queue した PDF も永遠に表示されず
  - **修正**: `second-instance` ハンドラで `mainWindowAlive=false` のとき `createMainWindow()` を呼んで新しい primary window を生成 → `createMainWindow` 内の `did-finish-load` → `pendingOpens` 消化で queue された PDF が開く (= 自己復旧)。β.74 で導入した J5 zombie-kill は引き続きセーフティネットとして残置するが、通常のユーザ操作経路では発火しなくなる (= 子ウインドウのとばっちり kill も解消)
  - **副次診断**: primary window の closed イベントで `survivingWindows` (生き残っているウインドウ数) を `primary-window-closed` ログに残す → 今後 zombie 化トリガーの切り分けに使える
- **β91** (2026-05-19): FAX 印刷の縮小事故 hotfix 試行 (効かず)
  - β.89 で streamlined FAX を Chromium silent print 経路に戻したところ、A4 PDF が 5-10% 縮小されて FAX 送信される (= Adobe で言う「ページサイズに合わせる」相当) 事象が判明
  - **試行 1**: `webContents.print()` に `margins: { marginType: "none" }` + composed[0] の widthPt/heightPt から導出した `pageSize` (microns) を追加。Sumatra の `noscale` 相当を狙ったが、Chromium PDFium の内部 fit-to-paper は Electron API では制御できないことが判明 (Electron 既知制約)。**効果なし、ユーザ報告で確認**
  - 当該変更は無害なので残置 (非 FAX silent print でも僅かに改善する可能性)
- **β92** (2026-05-19): **streamlined FAX を Adobe `/p` 経路 + 規定プリンタ一時設定に切替** (縮小事故根治、Phase 2 の経路再設計)
  - `kpdf3:print-via-reader-dialog` に `defaultPrinterHint` パラメータ追加。Win 環境で hint が与えられた時 `applyFaxAsDefaultPrinter` (β.54 で Chromium silent path に導入) を呼んで OS 規定プリンタを一時的に FAX に切替え、Adobe ダイアログが FAX 選択済の状態で開く体験を作る。終了時に `restoreDefaultPrinter` で復元
  - `actionFaxSend` の streamlined path を `kpdf3.printPdfSilent` から `kpdf3.printViaReaderDialog({defaultPrinterHint: faxDevice})` に切替。**ユーザ体験**: 初回 Adobe で「実際のサイズ」を選択 (Adobe が記憶) → 2 回目以降は印刷ボタン 1 クリックで送信。**副次効果**: Adobe vector レンダラで明朝 hairline 品質を担保 (Phase 3 が達成しようとした目的を別経路で実現)
  - **設計的な反省**: β.88 で FAX ボタンを Chromium silent 経路に作った判断 (= Adobe ダイアログ 1 段 skip で streamlined) が誤りで、β.91-92 は本質的に「振り出しに戻る」作業。Adobe `/p` は最初から 100% native scale + 高品質 vector を提供していた
- **β93** (2026-05-19): β.61 `applyCleanFaxDevmode` を Adobe `/p` 経路にも適用 (移植漏れ修正)
  - β.92 で FAX 経路を Adobe `/p` に切替えた際、β.61 で導入した `applyCleanFaxDevmode` (FUJIFILM Apeos C2360 等が driver-private 領域に保存する「最後の宛先」を 0 埋めで初期化する処理) を移植し忘れていた → 過去の宛先が FAX ドライバの送信先入力ダイアログに残るリスク
  - `kpdf3:print-via-reader-dialog` ハンドラで `defaultPrinterHint` が FAX デバイスの時 `applyCleanFaxDevmode` を呼ぶ + finally で `restoreUserPrinterDevmode` で復元。Chromium silent print 経路 (β.61) と完全に同じ処理を Adobe 経路にもミラー
- **β94** (2026-05-19): タブ切替時のしおり混在 + ページジャンプ修正
  - **しおり混在の根因**: `applyStateFromTab` の `setBookmarkSnapshot` はモジュール状態だけ更新し、DOM (`bookmarkTree`) は触らない。refreshBookmarks は `refreshViewer` 内から fire-and-forget で呼ばれ、`innerHTML=""` の clear → `await listBookmarks` → append の async chain。タブ切替中に複数の refreshBookmarks が in-flight になると「前タブのしおり append → 新タブのしおり append」が積み重なる race
  - **ページジャンプの根因**: applyTab の RAF 単発で scrollTop を `tab.scrollPosition` に復元していたが、`refreshViewer` 内の `applyFitWidthNow` / `setAnnotations` 等が layout reflow を起こすと RAF より後で scrollTop が clamp / リセットされる可能性
  - **修正**: `bookmark-pane.js` に `clearBookmarkDom()` を追加 (innerHTML="" を同期実行)。`applyStateFromTab` で `setBookmarkSnapshot` より前に呼ぶ → 新タブ環境に入る瞬間に DOM 空を保証。`applyTab` の scroll 復元を「即時 + RAF + 2RAF」の三段に強化
- **β95** (2026-05-19): 印刷後 Adobe 残留を構造解消 — pre-existing 含めて全 kill
  - **根因 (ログから確定)**: Adobe Acrobat Pro DC 最近版は `/n` (新インスタンス強制) フラグを半ば無視して、既存 Acrobat.exe インスタンスに print 要求をハンドオフする。K-PDF3 spawn の launcher プロセスはハンドオフ後すぐ exit するため、`killNewPdfReaderProcesses` の「new PIDs since spawn」検出が空となり、既存 Adobe を保護したまま放置 → Adobe が画面に残る
  - **ユーザ判断「全部閉じてよい」を受け修正**: `killNewPdfReaderProcesses` の kill 対象を「new PIDs」から「現時点 alive な全 PID」に変更。before-after 差分による絞り込みを廃止 (Acrobat.exe + AcroCEF + AcroBroker + AcroFlattener を pre-existing 含めて全 kill)
  - **副作用**: K-PDF3 から印刷した直後、ユーザが別途開いていた Adobe 窓も巻き添えで閉じる。業務上「K-PDF3 印刷時は Adobe で並行作業しない」前提でユーザ受容
  - **診断強化**: `newPidsByExe` (新規 spawn) と `preExistingPidsByExe` (印刷前から alive) を分けて記録
- **β96** (2026-05-19): Adobe DC 2024+ で固定 exe list が捕捉できない問題を解消
  - β.95 ログで判明: ユーザ環境では `preExistingPidsByExe: {"Acrobat.exe":[], "AcroCEF.exe":[], ...}` 全て空 = `PDF_READER_HELPER_EXES` の固定 4 つ (Acrobat.exe / AcroCEF.exe / AcroBroker.exe / AcroFlattener.exe) どれも tasklist で見つからない。**Adobe DC 2024+ で別 exe 名 (acrobat (64).exe, adcef*.exe 等) に変更された可能性が高い**
  - **修正**: `listAdobeRelatedProcesses()` を新設。tasklist の全 IMAGENAME を `Acro|Adobe Acrobat|AdobeAcrobat|adcef|acrobat` パターンで幅広く列挙 (case-insensitive)。AdobeARM / AdobeCollabSync / AdobeNotificationClient / AdobeIPCBroker / AdobeUpdateService 等の常駐バックグラウンドは whitelist で除外
  - `killNewPdfReaderProcesses` で cleanup 時に `listAdobeRelatedProcesses` も呼び、固定 list で kill しきれなかった PID を taskkill /F /T で追加 kill (`extraKilled` として記録)
  - **診断ログ**: `adobeRelatedAtCleanup` (cleanup 開始時に存在した全 Adobe 系プロセス名 + PID) + `extraKilled` + `survivorsExtra` (kill 後の生存) を追加。次回 Adobe が消えない時、実際の exe 名が判明する
- **β97** (2026-05-19): **PDF を画像として保存 + 範囲選択画像保存** (新機能 1+2)
  - **機能 1**: ファイル > 画像として保存… → 専用ダイアログで 形式 (PNG/JPEG) / 範囲 (全/現/`1-3,5,7-10` 形式) / 解像度 (96/150/300/600/900 dpi) / 白黒モードを選択 → 単一ページは save dialog で 1 ファイル、複数ページはフォルダ選択 → `<base>_p001.png` 連番出力。実装: `exporter.js` に `composePageImage` / `composeRegionImage` を新設 (既存 `composeSinglePageCanvas` を流用、`monoOverlays` 引数追加)、`main.js` に `kpdf3:save-image-file` / `kpdf3:save-image-files` IPC、`renderer.js` に `actionExportAsImage` / `parseMultiPageRange`
  - **機能 2**: ツールバー「範囲画像」+ メニュー「選んだ範囲を画像で保存…」→ `placementMode=region-image` でドラッグ範囲指定 → mupdf render + canvas crop → 1 ファイル保存。`mode-options-bar` で形式 / dpi / 白黒をリアルタイム切替
  - `file-browser.js` に `defaultExt` パラメータ追加 (デフォ ".pdf" で後方互換)。`<label><input></label>` 入れ子構造の HTML を `<input id=...><label for=...>` の並列に書く 98.css 互換ルールを確認 (β.98 で hotfix 確定、β.86 と同じ pattern)
- **β98** (2026-05-19): 画像書き出しダイアログ可視化 hotfix。β.97 で `<label><input></label>` の入れ子で「範囲」「形式」radio が描画されていなかった → β.86 secure export checkbox と同じ修正方針 (並列構造 + `.image-export-row input[type=radio]` で spacing 制御)
- **β99** (2026-05-19): 分割保存の part 名テキストボックスで Backspace が効かない問題を修正。`splitFlow` の keydown ハンドラが Backspace を無条件 preventDefault → input フォーカス時は browser default に逃がす分岐を追加 (`_isTextInputTarget` ヘルパー)。`thumbList` 側にも同じ予防策
- **β100** (2026-05-19): **オートシェイプ機能 (M5+α、業務での「ここを見て」「この範囲」指示用)** — 新 overlay type `'shape'` を導入。最小セット: 直線 / 細線矢印 / 中空ブロック矢印 / 楕円。`drawShape` を `exporter.js` から export して viewer と exporter で共通描画 (viewer 側は child canvas に同関数で描画、zoom 連動)。schema migration `migrateOverlaysAddShape` (β.80 form_field と同パターン、idempotent)。ツールバー「図形」ボタン → shape palette popup (form palette と同じ流儀、位置永続化)。`startShapeDrag` + `_placeShape`。`overlay-placement.js` に shape 系統を統合
- **β101** (2026-05-19): **図形拡張 — 四角・角丸四角・楕円+×・双方矢印・斜め 8 方向対応**。ユーザー要望「中に空白のある矢印などを証拠関係で使う、枠線で縁取られた矢印もほしい」を受けた拡張。kind 追加: `rect` / `rounded-rect` / `ellipse-x` (楕円+×、内接矩形対角線で × 描画、却下・不可・無効マーク代用) / `double-arrow` (細線両端矢印) / `double-block-arrow` (中空ブロック双方矢印、10 頂点ポリゴン)。8 方向 (`right`/`down-right`/`down`/.../`up-right`) サポート (atan2 量子化、`_dragDir8`)
- **β102** (2026-05-19): **placement UX 再設計** — ユーザー報告「斜めブロック矢印が bbox から切れる」「点線四角プレビューだけだと方向が分からない」を受けて、配置はドラッグ方向を読まず常に "right" で固定 → 配置直後に shape を自動選択 (setTimeout で `selectOverlay`) → mode-options-bar の `shape-edit` panel で 8 方向を後付け選択する流れに変更。`updateShapeOverlay` ヘルパーで bbox を「中心固定で 横↔縦は w/h swap、斜めは正方形化」する仕組みを最初に試した (が、太さ・長さが破壊されるので β.104 で再設計)
- **β103** (2026-05-19): **編集を shape palette popup に統合** — β.102 で導入した `shape-edit` options bar が表示されない構造ミス (`placementMode==="shape"` のままだと selection 経路の分岐に届かない) + ユーザー提案「ツールバーから図形選択でポップアップさせたほうがわかりやすい」を受け、配置設定と編集を popup に統合。popup に「向き」select 追加、`onSelectionChanged` で popup を選択 shape の値で populate、popup 値変更で `updateShapeOverlay` 呼出。`mode-options-bar` の `shape-edit` 経路は撤去
- **β104** (2026-05-19): **shape を太さ・長さ不変の 45° 回転モデルに再設計** + **↻↺ ボタン UI**。ユーザー報告「斜めブロック矢印で見切れ」「方向によって太さが変わる」「ドロップダウンは煩雑」を根治。
  - 描画モデル: `properties.length` / `crossSize` を新規導入 (方向不変)、`drawShape` は directional shape を中心 (0,0) 基準で右向きに描画 → `ctx.rotate` で arrowDir に応じた角度に回転。bbox は `shapeDirectionalBbox(dir, length, crossSize)` で `length·|cos θ| + crossSize·|sin θ|` の rotated AABB として正確計算 → 斜めでも切れない
  - 旧 `_shapeEndpoints` / `_blockArrowPolygon` / `_doubleBlockArrowPolygon` / `_drawArrowHead` は撤去、`_drawDirectionalShapeAtOrigin` + 中心基準ポリゴン helper に統合
  - UI: popup の 8 方向 dropdown → 「↺ ⟨向き indicator⟩ ↻」3 要素のボタン UI。`rotateSelectedShape(±1)` で 45° 単位回転、indicator は 8 種 (→↘↓↙←↖↑↗)
  - kind directional ↔ non-directional 切替時の bbox 整合性も処理 (`updateShapeOverlay` 拡張)。旧 shape (β.100-103 で配置済、length/crossSize 無し) は bbox から `max(w,h) / min(w,h)` で互換 fallback
- **β105** (2026-05-20): フォント select の文字化け解消 + テキスト挿入 / スタンプにも system フォント拡張
  - 根因: Win 環境で PowerShell の既定出力エンコ (CP932/UTF-16LE) のまま `toString("utf-8")` で受けていた → 日本語フォント名 (MS UI Gothic / ヒラギノ / 游ゴシック等) が壊れる
  - main.js `_collectSystemFonts` の PowerShell コマンド冒頭で `$OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::OutputEncoding=...` を設定し UTF-8 に強制
  - β.80 で form-text-font 専用だった system フォント append ロジックを `src/renderer/system-fonts.js` に共通化 (renderer.js / stamp-dialogs.js 双方で利用、循環 import 防止)
  - 展開先: テキスト挿入 (#text-font) + スタンプ「フォント設定…」ダイアログの全角 / 半角 select
  - fonts.js: `getStampFontStack` を system font fallback に拡張 (preset 名以外はそのまま CSS family へ)、`setStampFontDefaults` の validation を緩めて任意文字列受け入れ
  - HANDOVER §17 #17「既存 text overlay の system font 選択拡張」を消化
- **β106** (2026-05-20): Adobe 印刷後の cleanup 経路に診断ログ + tasklist hang 防御
  - β.105 までのユーザー報告: `pdfreader-dialog-finish` の後にあるはずの `pdfreader-cleanup` ログが「無い」事象 (= 経路に入って hang したのか、入っていないのか判別不能)
  - `killNewPdfReaderProcesses` 冒頭に `pdfreader-cleanup-start` ログを追加 (経路に入ったか確実に記録)
  - finish() 内の `.catch(() => {})` を `logCrash("pdfreader-cleanup-error", err)` に置換 (fire-and-forget の例外を可視化)
  - `listAdobeRelatedProcesses` / `getProcessPidsByName` に 5 秒 timeout 追加 + `logCrash("...-timeout", ...)` で記録 (cleanup 全体が tasklist hang で止まる事故を構造防御)
- **β107** (2026-05-20): 選択 UX 4 件まとめて投入 (法律実務ユーザー要望)
  - **① 群移動 D&D**: viewer.js の pointerdown/move/up/cancel に group drag ロジック追加。`getSelectedOverlayIds` callback と `onOverlayDragEndGroup` callback を viewer opts に追加し、primary が selection に含まれかつ複数なら他選択 overlay も同じ delta で動く。pointerup で `CompositeCommand` 1 step に commit
  - **② Ctrl+A 全選択**: overlay-selection.js に `selectAllOverlays(ids)` を新設 (set を 1 まとめで構築 → reapplySelectionDom 1 回)。renderer.js keydown で `projectStore.list()` の id 配列を渡す (← β.109 でバグ判明、`snapshot()` に修正)
  - **③ 同種 form_field の一括フォント等変更**: `_buildFormFieldPatch(ov, fk)` で patch 構築を ov 単位に分離、`applyFormFieldStyleToEditingOrSelected` を「同じ fieldKind の selection 全体に同じ patch を ライブ適用」に拡張。`populateFormFieldOptionsBar` / `refreshModeOptionsBar` も multi-select 同種 OK に緩和 (異種混在なら hidden)
  - **④ 矢印キー微移動**: keydown で ArrowUp/Down/Left/Right を捕捉、`nudgeSelectionBy(dx, dy)` で selection 全体を 1pt 単位 (Shift で 10pt) 移動。`CompositeCommand` で 1 keystroke = 1 undo。input/contentEditable フォーカス中は browser default
- **β108** (2026-05-20): 矢印キー clamp を group-aware に (β.107 hotfix)
  - β.107 の `nudgeSelectionBy` は overlay 個別に `Math.max(0, ov.x+dx)` で clamp していたため、Ctrl+A 状態で左矢印連打すると左端 overlay が x=0 で止まり他は移動継続 → 相対位置が崩れる UX バグ
  - 修正: selection 全体の min(x), min(y) を計算し、負方向 delta を `dx' = max(dx, -minX)` で抑制 → 端到達で全体が同期して停止
- **β109** (2026-05-20): `projectStore.list()` を `snapshot()` に修正 (β.107 Ctrl+A の TypeError 根治 + Shift+click range 復活)
  - β.107 の Ctrl+A hander が `projectStore.list()` を呼んでいたが、`ProjectStore` にこのメソッドは存在しない (正しくは `snapshot()`) → 即 TypeError で全選択が動いていなかった (実機検証漏れの私のミス)
  - overlay-selection.js の Shift+click range 経路 (`_overlayIdsInReadingOrderBetween`) も同じバグで、B2 リファクタ (5ff6cfc) 以来ずっと壊れていた事実が判明 → 同時に修正
- **β110** (2026-05-20): 書き出しダイアログに「白黒で書き出す」チェックを追加
  - ユーザー指摘: 「白黒モード」(β.88 ツールバートグル) は印刷ボタン押下時のみ作用し、「PDF として書き出し」した PDF は元カラーが残る → 別アプリ印刷で意味なしの問題
  - file-browser.js に `monoExportToggle` オプションを追加 (secureExportToggle と同パターン)。save mode で secure / mono の両 toggle 状態を payload object に集約、両方 false なら従来の string 戻り値
  - folder mode (分割保存) でも monoExportToggle が立てば object 返却 (secure 側は qpdf 等の複雑性から save mode 限定を維持)
  - 4 経路に `monoOverlays` を伝搬: actionExport / actionExportRange / actionSavePagesAsPdf / 分割保存
- **β111** (2026-05-20): 上書き保存の確定ダイアログに「白黒で上書き」チェックを追加
  - dialogs.js の `customConfirm` に `checkbox: { label, defaultChecked, storageKey }` オプションを追加 (resolve を { ok, checked } に切替、未指定なら従来通り boolean)
  - HTML に `confirm-checkbox-row` を追加 (普段は hidden、checkbox オプション指定時のみ表示)
  - actionSave の確定ダイアログで checkbox: { label: "白黒で上書き...", storageKey: "kpdf3.saveMono" } を渡し、result.checked を `actionExportToPath` に monoExport として伝搬
  - 既存 customConfirm 呼出 (~25 箇所) は全て checkbox 未指定 → 後方互換 OK
- **β112** (2026-05-20): 墨消しを sticky 化 (連続配置)
  - ユーザー要望: 墨消しを連続で行えるよう、1 回置くたびに mode が "none" に戻る挙動を撤廃
  - `startRedactionDrag` 内の `_setPlacementMode("none")` 3 箇所 (fallback / onUp / onCancel) を削除し、marker mode と同じ sticky 動作に揃える (β5 以来の marker パターンを継承)
  - 抜けるには別モードボタン / 同じ墨消しボタン再押下 / Esc キー
- **β113** (2026-05-20): mupdf に OS native CJK font fallback を導入 (Adobe 互換寄せ)
  - ユーザー報告: WEB から DL した PDF を Adobe で開くと MS ゴシック相当だが、K-PDF3 (mupdf) で開くと中華系フォント (NotoSansCJK 系) になる
  - Adobe プロパティ確認で PDF 内の MS-Gothic / Bold が「埋め込みなし」と判明 → Adobe は OS の MS ゴシックで自動代替、mupdf は内部 bundled CJK fallback
  - `src/backend/mupdf-font-fallback.js` を新設、`mupdf.installLoadFontFunction((name, script, bold, italic) => Font|null)` で fallback を登録
  - 判定は script タグ (Han/Hira/Kana/Hang/Bopo/Hrkt/Jpan/Kore/Hans/Hant) **か** font name (MS-Gothic / MS-Mincho / HeiseiKakuGo / YuGothic / Adobe-Japan1 / 小塚 等) の OR (CID font で script タグが薄いケースの保険)
  - bold は callback 引数 + font name の ",Bold" / "Bold" 末尾検出
  - Win: msgothic.ttc / YuGothB.ttc、Linux: NotoSansCJK 系。Mac は将来 (一旦 null で mupdf default に委ねる)
  - フォントは `readFileSync` で 1 度読んで Buffer をキャッシュ + Font オブジェクトも name+path 単位でキャッシュ
  - logFn (= logCrash) を受け取り最初 10 回の callback 発火を `font-fallback-callback` ログに残す (= 実機で効いているか追跡可能)
  - main.js の whenReady より前 (mupdf import 直後) に `registerFontFallback(logCrash)` を実行
  - ユーザー確認結果: 銀行明細 PDF などで日本語フォントが Adobe と同等の MS ゴシック相当に変わって視認性が劇的に改善
- **β114** (2026-05-20): 「罫線抑制」トグル — 薄罫線を画面表示時のみ白化 (書き出し不変、β.113 ユーザー残課題)
  - ユーザー報告: フォント問題は β.113 で解消したが、Adobe では非表示の薄いグレー罫線が mupdf rendering で anti-aliasing により可視化される
  - `src/renderer/line-suppress.js` を新設: 候補ピクセル (`max-min<=chroma`、`min>=loGray`、alpha 十分) を水平/垂直 run で N px 以上連続のみ白に置換。文字輪郭は色階調変化で連続せず守られる
  - viewer.js の renderPage 結果適用直前で pageNo>0 限定で in-place 適用
  - ツールバーに「罫線抑制」トグル追加、デフォ OFF、localStorage 永続化
- **β115** (2026-05-20): 罫線抑制ボタン撤去 (ユーザー判断、メニュー簡素化) — 内部 API は残置
  - 実測 (オリジナル PDF には触れず /tmp 複製で検証): 効果が「ヘッダ背景の薄グレーが白になる」程度で、肝心の細罫線は連続性検出が破れて残る + 文字輪郭への副作用リスク
  - HTML から btn-suppress-lines を削除、renderer.js の state / event listener / disabled 連動を全削除
  - `src/renderer/line-suppress.js` / `viewer.setSuppressLines` は将来「ツール」「詳細設定」経由での再公開に備えて残置 (= 隠し API)
- **β116** (2026-05-20): 3 件まとめて (ページ番号中央寄せ修正 + フォント選択 + Adobe 検出強化)
  - (1) ページ番号「中央」配置のテキストが左寄りに見える問題 — 固定 W = max(60, fontSize*8) で中央配置していたが、テキストは left-align で短い番号がボックス内で左に偏っていた。`measureTextOverlaySize` で実テキスト幅を測って W に反映するよう変更
  - (2) ページ番号にもフォント select 追加 — page-numbers-dialog にフォント行 (preset 4 種 + 「システム」optgroup)。system-fonts.js の共通ロジックを流用、選択値は fontId として overlay properties に保存
  - (3) Adobe 検出パターン拡張 + 詳細診断 — β.115 報告で `acrotray.exe` しか拾えなかった事象に対応:
    * `listAdobeRelatedProcesses` を `{kill, wide}` の 2 配列を返す形に拡張
    * KILL パターン: 中間マッチ許容 + `RdrCEF` / `AcroRd` を追加 — Reader CEF も巻き添え kill 対象に
    * WIDE パターン: Adobe/Acro/Reader を含む全プロセスを診断専用に列挙
    * pdfreader-cleanup ログに `adobeRelatedAtCleanupWide` / `survivorsExtraWide` を追加 → 次回 Adobe 残留時にユーザー環境固有のプロセス名が判明する想定
- **β117** (2026-05-20): ページ番号「配置」ボタン無反応 hotfix + 印刷経路に temp PDF 診断ログ
  - β.116 で `measureTextOverlaySize` を **オブジェクト引数** で呼んでいた (正しくは positional `(text, fontSize, fontFamily, currentW, maxW)`) → 第 1 引数 text に object が入って `text.split()` で TypeError → for ループ abort → 何も配置されず、ダイアログも閉じない (ローカル動作確認漏れの私のミス)
  - positional 呼出に直す + `getTextFontStack(fontId, {digitsHanko: false})` で CSS family を生成 + try-catch で囲み measure 失敗時は固定 W (= 旧 fontSize*8) で fallback
  - `print-via-reader-dialog-start` ログに `tempPath` / `tempBytes` / `tempBytesHuman` を追加 → 016-721 等の切り分けで「この temp PDF を Adobe で直接開いて印刷」テストが可能に
- **β118** (2026-05-20): 印刷 3 改善まとめ
  - **(a) 印刷ジョブ drain 待ち**: ユーザー報告「52 枚印刷で 7 枚目まで出て切れる」に対応。tick で新規ジョブ ID を `submittedJobIds` に蓄積、finish 後の `killNewPdfReaderProcesses` を「submitted ジョブが queue から drain するまで」遅延 (2 秒間隔 polling、最大 5 分)。`pdfreader-jobs-drained` ログに drained / elapsedMs / 残ジョブ ID を記録
  - **(b) 送信中 busy modal の中止ボタン**: ユーザー報告「Adobe が hand-off で hang、kpdf3 の送信中ダイアログが固まる、手動で × 押すしかない」に対応。3 経路 (通常印刷 / 下敷き印刷 / FAX 送信) の showBusy に onCancel を追加し、`kpdf3:cancel-print` IPC を `cancelInFlightPrint()` に拡張 (Sumatra + Adobe + Chromium 全経路で kill)。renderer の await 復帰 → busy modal 解除
  - **(c) NEVER_KILL_PREFIX 拡張**: `Adobe Desktop Service` / `Adobe Genuine Service` / `Adobe Sync` / `AdobeGCClient` / `CCXProcess` / `CCLibrary` / `Creative Cloud` / `CoreSync` を追加 → Adobe CC 常駐サービスを kill しない保証強化 (印刷無関係なため)
- **β119** (2026-05-20): ページ番号ダイアログのプリセット永続化
  - localStorage キー `kpdf3.pageNumbers.{position,format,start,fontSize,font}` を追加
  - openPageNumbersDialog で `_restorePageNumbersPresets` で全フィールド復元、applyPageNumbers で配置完了直後に `_savePageNumbersPresets` で保存
  - system フォント名も option 値として保存可 → 次回も同じ system フォント名で復元 (page-numbers-font の append タイミングと整合)
- **β120** (2026-05-20): ページ番号ダイアログに太字オプション追加 (印刷時のかすれ解消…直後にユーザー嗜好で β.121 で再調整)
  - β.116/.117 で `bold: false` 固定にしていたため、印刷時に薄く出るユーザー報告
  - 「太字」チェック追加 (デフォ ON)、prop `bold` に反映 → β.73 の overstroke が効いて印刷濃く
  - プリセット永続化 (β.119) にも `kpdf3.pageNumbers.bold` を追加
- **β121** (2026-05-20): ページ番号は「細字デフォ」+ enforceHairline で印刷時のみ濃く
  - ユーザー指摘: 「ページ数が太字はいや。細字の場合も濃くして」
  - 太字デフォを OFF に戻し、ページ番号 overlay に新 property `enforceHairline: true` を埋め込み (太字 OFF のときだけ)
  - exporter.js の text 経路で `_hairline = !props.bold && (!!props.enforceHairline || _needsHairlineStroke(fontId))` に拡張 → ページ番号は太字 OFF + Gothic/Sans でも β.76 の hairline 補強 (0.02×fontSize) が効く
  - 副作用評価: enforceHairline はページ番号配置時のみ埋め込むので、テキスト挿入や form_field 等 他の text overlay には影響なし
- **β122** (2026-05-21): 図形 palette 整列 + メニューバー再編 + PDF プロパティダイアログ — 3 件まとめ
  - **(1) 図形 palette popup の 9 ラジオを 3×3 grid 整列**: ユーザー報告「縦方向にがたつき」を解消。`.shape-palette-kinds` を新設して 4 行に分けていた `.shape-palette-row` (3+2+2+2) を 1 つの grid container に統合、`grid-template-columns: repeat(3, 1fr)` で均等 3 列。popup の min/max-width を 300/380 → 340/400 に拡張 (6 文字ラベル「双方ブロック」「ブロック矢印」が 1 列に収まる余裕確保)
  - **(1) 罠**: 98.css は `<input type="radio">` を `opacity: 0; position: fixed` で隠して `label::before` 擬似要素でラジオの絵を描画している (`left: -18px` の absolute 配置)。最初 cell の label に `overflow: hidden + text-overflow: ellipsis` を付けたら ::before が overflow で切り取られて**ラジオが表示されなくなる事故**を踏んだ → 撤去で解決。98.css と grid を組み合わせる時は label に overflow を付けないルールを確立 (file CSS のコメントに明記)
  - **(2) メニューバーに「挿入(I)」追加** + ツールバー全ボタンを必ずどこかのメニューに配置するよう再編。配置モード系 (テキスト/スタンプ/墨消し/マーカー/吹き出し) を「ツール」から「挿入」へ移動、新規追加: 図形/フォーム/ページ番号。「ファイル」に印刷の下に白黒印刷モード/FAX 送信/下敷き印刷/プロパティを追加、「編集」に検索を追加、「表示」に左右回転 ↺/↻/ページを別ウインドウで表示/タブを別ウインドウに分離を追加。「ツール」は表示解像度/スタンプ管理/フォント設定の設定系専用に整理。actions 配線は (a) 既存関数 (actionRotateLeft / actionOpenPagePopup 等) は直接、(b) Toggle button (btnMonoPrint 等) は `$("btn-...")?.click()` で fallback、で簡素化。`refreshMenuState` の setEnabled / setChecked に新規アクション追加、MENU_HINTS にステータスバー hint 追加、hint for ループに menu-insert を追加。mono-print click handler に `refreshMenuState()` 追加でメニュー側 checkmark が同期
  - **(3) ファイル > プロパティ ダイアログ新設** (Adobe Acrobat「文書のプロパティ」流のタブ切替)。タブ: 概要 / セキュリティ / フォント / 規格。`src/backend/mupdf-pdf-info.js` に `extractPdfProperties(data)` を追加 — mupdf 経由で metadata (info:Title〜ModDate) + PDF version + ページ数 + ページサイズ集計 + 暗号化 (needsPassword + /Encrypt dict 検査) + フォント一覧を抽出。フォント一覧は全ページの /Resources/Font を巡回、Type0 は /DescendantFonts[0] の FontDescriptor を見る、ユニークキー = baseFont + subtype + encoding + embedded。embedded 判定は FontFile/FontFile2/FontFile3 の存在、subset 判定は `XXXXXX+` prefix 検出
  - **(3) 経路**: main `kpdf3:get-pdf-properties` IPC → active source PDF を `readFile` + `stat` → `extractPdfProperties` → file 情報 (path/size/mtimeMs/birthtimeMs) を付加して返す。preload `getPdfProperties()` bridge。renderer `actionShowProperties` で loading 表示 → IPC fetch → `populatePropertiesDialog` で 4 タブ populate。フォント表は埋め込みあり/なしを青/赤で目立たせる
  - **副次強化**: mono-print toggle 状態を menuBar に setChecked で同期 (上記 (2) の click handler 修正に含む)
- **β123** (2026-05-21): 分割保存サムネのプログレッシブ表示 + 保存ダイアログのボタン 2 行化
  - **分割保存サムネ**: 旧経路は「全サムネ生成 → rebuildSplitUI」の順で、大量ページ PDF だと進捗カウンタしか見えなかった。ユーザー要望「読み込んだものから表示するなど、見た目に待ちの時間を最小化できないか」を受けて 3 改善まとめ:
    - **即時レイアウト**: `rebuildSplitUI(pages)` を先行 → 全ページが placeholder で並ぶ。区切り線操作・パート名入力・サムネ完成を待たずに使える
    - **並列度 3 ワーカープール**: `generateAllThumbnails` を `CONCURRENCY=3` のワーカープールに刷新。mupdf は main 側で serialize されるが canvas 合成・PNG エンコード・IPC ラウンドトリップが並列化されて wall-clock 短縮。完成 1 枚ごとに `onThumbReady` で `swapThumbCanvas` (placeholder → canvas を `replaceWith`、thumb 要素は維持して D&D/コンテキストメニュー handler を温存)
    - **表示中ページ優先**: IntersectionObserver (`rootMargin: "200px 0px"`) で thumb を観察、表示に入ったページを `splitState.thumbPriorityBump(pageNo)` で優先キューに昇格 (スクロールに追従)
    - `refreshSplitView` (ページ追加/削除後の再構築) も同経路へ
  - **保存ダイアログのボタン 2 行化**: `actionSave` の `customConfirm` で `okLabel: "確定保存\n画像として上書き"` / `cancelLabel: "下書き保存\n編集可能として上書き"` (各ボタン内に `\n` で改行)。CSS で `#confirm-ok, #confirm-cancel { white-space: pre; min-width: 140px; padding: 4px 10px; line-height: 1.3; }` (pre は \n のみ改行・単語間で折り返さない)。`#confirm-checkbox-row:not([hidden]) + .range-buttons { margin-top: 14px; }` でチェック行とボタンの間に余白
- **β124** (2026-05-21): 印刷準備の並列化 — Adobe ダイアログ表示までの待ち時間短縮
  - **案A** (`main.js printPdfViaReaderDialog`): 旧は spawn 前に `Promise.all([pids snapshot, snapshotPrintJobs])` で ~1.5s 待ってから Adobe spawn。新は pids snapshot のみ spawn 前 await (新規 Adobe 識別に必須)、`snapshotPrintJobs` は Promise として spawn 前 kick だけして、最初の tick (POLL_MS=1000ms 後) で await。Adobe 起動 (3-5s) に PowerShell 1.5s が完全に隠れる → ダイアログ可視化を **1〜1.5s 短縮**
  - **案B** (`exporter.js composePagesForExport`): シリアル `for` ループを 3 ワーカープール化。`out = new Array(total)` 事前確保で index 書き込み (ページ順序保持)。mupdf は main 側 serialize されるが canvas 合成・PNG/JPEG エンコード・IPC ラウンドトリップが並列。ページ数に比例して短縮 (10 ページ overlay 入りで 0.5〜2s、50 ページなら 2〜10s)
  - composePagesForExport は print 以外に書き出し・分割保存・画像保存からも呼ばれるので、Adobe 印刷以外の経路も同時に高速化
- **β125** (2026-05-21): Adobe cleanup-end 後の追跡 snapshot 診断ログ — 「タスクバーに残る」事象の盲点解消
  - **背景**: β.123 ユーザー報告「印刷キャンセル後 Adobe がタスクバーに残る」のログを分析した結果、cleanup の survivors snapshot は cleanup 完了から 500ms 後の 1 回のみで、それ以降の挙動が観測できない盲点が判明 (β.95→.96→.106→.116→.118 の対策はすべて cleanup 完了時点まで)
  - **追加**: `killNewPdfReaderProcesses` 末尾に fire-and-forget setTimeout 3 本 (+5s/+15s/+30s)、各 tick で `listAdobeRelatedProcesses` を呼んで `pdfreader-followup-snapshot` ログを記録。前回 tick 差分で:
    - `appeared`: 増えた PID (= 外部要因による復活確定)
    - `disappeared`: 消えた PID (= ユーザー手動 kill or 自然 exit)
    - `appearedKillable` / `disappearedKillable`: KILL_PATTERN マッチに絞った差分
  - `setTimeout(...).unref()` で event loop を hold せずアプリ終了をブロックしない (β.106 tasklist hang 防御と同じ慎重さ)
  - **判別が可能だった**: ユーザー指摘「区別はつかないものなの？」に対し、cleanup の `killDetails.exitCode` で per-PID 判別は元から可能 (0 = K-PDF3 が殺した、128 = 他者が先に殺していた)。私が前の分析で活用できていなかっただけ。追跡 snapshot の `appeared`/`disappeared` と組み合わせれば「誰がいつ消したか」がほぼ復元可能
- **β126** (2026-05-21): 案 X 強化 — Adobe 残留の構造対策 (cumulative tracking + MainWindowTitle 変化検出)
  - **根因確定** (β.123-.125 のログ + ユーザー証言から): Win32_PrintJob polling の race。POLL_MS=1000ms + PowerShell ~1.5s = 実効 ~2.5s 間隔、queue 滞在時間 < 2.5s のジョブを取り逃す → tick が "job-detected" 経路に入らない → POST_JOB_BUFFER_MS=3s 後の auto-kill が走らない → Adobe 生存・busy modal 開きっぱなし
  - **同じプリンタでも成否が分かれる**のは queue 滞在時間がジョブごとに揺らぐから。案 X (β.72) 以来の構造的脆弱性、今までは「Adobe × ボタンで閉じる経路」で済んでいて顕在化が遅れていた
  - **対策 (Path A + Path B の二重化)**:
    - **Path A** (案 X cumulative tracking 強化): `everSeenNewJobs` Set に「過去 tick で観測した new job ID」を全て積む → 「次の tick の前に queue から消えた」短命ジョブも救済
    - **Path B** (orthogonal 信号、新規): ユーザー証言「Adobe が印刷後最小化、開くと中身空」= Adobe Pro DC が document tab を閉じる挙動の現れ。`snapshotAdobeTitle(pid)` で MainWindowTitle を polling し、"kpdf3-print" prefix を含む状態 → 含まない状態への遷移を「印刷完了」として検出 → `setTimeout(finish("doc-closed"), POST_JOB_BUFFER_MS)`。queue polling と独立な signal なので Path A が race で取りこぼしても救済
  - POLL_MS / POST_JOB_BUFFER_MS は実績値を維持。Path A/B どちらが先に発火しても settled-guard で安全
  - **設計判断の維持**: Adobe `/p` 案 D (β.72 FAX freeze 構造根治) は維持。β.118 中止ボタンと同じ「既存案 X の上に safety net 追加」方針。Sumatra silent / Chromium silent への逃がしは β54-β70 の試行で構造的に却下済なので絶対に提案しない
  - **検証ポイント**: 次回再現時に `pdfreader-dialog-finish.reason` を確認:
    - `"job-detected"` → Path A (cumulative) が救済した
    - `"doc-closed"` → Path B (title) が救済した
    - `"reader-closed"` → 中止ボタン経由 = まだバグ残り (両 path 不発)
    - `"timeout"` → 5 分タイムアウト経由 = 両 path 不発
  - **初回実機検証**: 通常印刷では Adobe が消えるよう改善 (ユーザー報告)。FAX 経路は未検証 (Adobe が FAX 送信後に document tab を閉じるか挙動次第)、再発したら `reason` + cleanup + followup ログ全部で切り分け
- **β127** (2026-05-22): **最近のファイルをサブメニュー化 (ダイアログ撤去)**
  - **背景**: M5-7 で実装した「最近のファイル...」は busy-modal ベースのダイアログ (`recent-dialog`、最大 10 件、ファイル名 + フルパス + 最終更新時刻のメタ表示) で、開く操作が 2 ステップ (メニュー → ダイアログ → 項目クリック) になっていた。ユーザー要望「ファイルメニューに、最近開いたファイルというような実装はできる？」を受け Win95 流のカスケードサブメニュー化を決定 (案 A 採択、ダイアログは撤去で一本化)
  - **MenuBar 拡張** (`src/renderer/menu-bar.js`): 既存の汎用メニュークラスに `submenus` / `populators` 引数を追加 — `submenus` は key → `.menu-submenu` 要素、`populators` は key → 非同期生成関数 (毎回 hover 時に呼ばれて `{label, title, action}` 配列を返す)。`_openSubmenu` が呼ばれると submenu を `innerHTML=""` クリア → populator 実行 → 各項目を DOM 生成 + click handler で `_closeAll()` + 遅延 action 実行 → trigger 要素の右側に `getBoundingClientRect()` ベースで配置 (left=rect.right-2、top=rect.top-2 で beveled border が Win95 風に連続)。空配列なら "(履歴なし)" disabled、populator throw で "(読み込みエラー)" disabled。`.submenu-open` クラスで親 menu-item の青ハイライトをサブメニュー表示中も維持 (Win95 流)
  - **HTML / CSS** (`src/renderer/index.html` + `src/renderer/style.css`):
    - File menu の `<div class="menu-item" data-action="recent">最近のファイル...</div>` を `<div class="menu-item menu-item-submenu" data-submenu="recent">最近のファイル</div>` に変更
    - 新規 `<div class="menu-dropdown menu-submenu" id="menu-recent" hidden></div>` を追加 (中身は populator が動的生成)
    - `recent-dialog` ブロック (busy-modal の `<div>` + 13 行) を完全撤去
    - CSS: 旧 `.recent-window` / `.recent-list` / `.recent-item*` / `.recent-empty` / `.recent-buttons` 65 行を削除、代わりに `.menu-item-submenu` (右に ▶ 9px、padding-right 22px)、`.menu-item-submenu.submenu-open:not(.disabled)` (青 #000080 hover 色を維持)、`.menu-submenu` (min-width 260px / max-width 480px、`.menu-dropdown` の Win95 chrome を継承) を追加
  - **renderer 配線** (`src/renderer/renderer.js`):
    - `populateRecentSubmenu()` を新設 — `kpdf3.listRecentPdfs()` (workspace-registry の SQLite query、limit 10) を呼んで先頭 9 件を `{label: "1  ファイル名.pdf", title: フルパス, action: () => openPdfSmart(path)}` に変換。`RECENT_SUBMENU_LIMIT=9` は将来の 1-9 access-key 対応を見越した上限
    - `MenuBar` 初期化に `submenus: { recent: $("menu-recent") }` + `populators: { recent: populateRecentSubmenu }` を追加
    - 旧 `actionShowRecent` + `recentDialog`/`recentList`/`recentCancelBtn` 宣言 + `hideRecentDialog` + click handler + actions の `recent: actionShowRecent` 行を全削除 (合計 ~50 行)
    - `MENU_HINTS` の bind ループを `.menu-item[data-action], .menu-item[data-submenu]` に拡張 — `recent` hint「最近開いた PDF の一覧から選びます」を新しいサブメニュー trigger でもステータスバー表示
  - **動作**: File → 「最近のファイル ▶」hover でサブメニュー右展開 → 「`1  hoge.pdf`」「`2  fuga.pdf`」… click で `openPdfSmart` (active タブ空なら active、開いてれば新タブ)。tooltip にフルパス。0 件は "(履歴なし)"
  - **副次**: `openPdfSmart` の JSDoc の "recents dialog" を "recents submenu" に更新
  - **未対応 (将来候補)**: 1-9 数字キーでの直接オープン (現在は label の数字は単なる表示プレフィックス)、ファイル存在しない時の灰色化 + リスト clear ボタン
- **β128** (2026-05-22): **「画像として保存」で白塗り背景の無い PDF が黒背景になる不具合を修正**
  - Excel→PDF など背景に白塗り矩形を持たない PDF は mupdf が透過 RGBA (背景 = RGB(0,0,0)/alpha 0) で返すため、`composePageImage` が合成 canvas をそのまま encode すると JPEG は透過部分が黒く焼き込まれ、PNG も背景透過になっていた
  - `composePageImage` を不透明な白地へ合成してから encode するよう修正。β.97 で `composeRegionImage` の JPEG 経路だけ入っていた白地対策がフルページ経路に漏れていたのが原因。`composeRegionImage` も JPEG 限定だった白地敷きを PNG/JPEG 共通化
- **β129** (2026-05-22): **FAX 送信中モーダルが消えない事象 — Adobe 起動後を「送信完了」明示確認モーダルに**
  - **根因 (β.128 配布後の FAX 再発ログ解析で確定)**: FAX 経路は印刷完了を自動検出する信号が構造的に存在しない。Path A (`Win32_PrintJob` 監視) は FUJIFILM 等の FAX ドライバが可視ジョブを出さず盲目 (67 秒・約 26 回ポーリングで `everSeenNewJobs` 空)。Path B (Adobe MainWindowTitle) は Adobe が `/n` を無視し既存インスタンスへハンドオフするため `sp.pid` に文書 title が出ず不発。両 path 不発 → busy modal が開きっぱなしでユーザーが中止を押すしかなかった (`reason=reader-closed`)
  - **対策**: FAX auto 経路のみ、ページ描画完了 → Adobe 起動の段階で busy modal を「送信完了」明示確認モーダルへ切替。ユーザーが送信操作を終えてボタンを押すと `kpdf3.cancelPrint()` で Adobe を終了し処理を確定。`busy-modal.js` にボタン label / 進行中メッセージを指定する `cancelLabel`/`cancelBusyMessage` + 表示中モーダルを再構成する `setBusyCancel()` を新設
  - 通常印刷 (`actionPrintViaReader`) は Path A が実プリンタで機能するため変更せず。FAX 経路の構造的制約は memory `[[project-fax-busy-modal-explicit]]` に記録
- **β130** (2026-05-22): **挿入対象に画像 / Word / Excel を追加**
  - サムネ間 gap の D&D 挿入は従来 `.pdf` のみ対象だった。新規 `src/main/file-to-pdf.js` で「ファイル → PDF バイト列」変換 → 既存の `_insertPdfBytesIntoWorkspace` 経路に流す設計。挿入後の vector 保持 / 並べ替え / 書き出し / 印刷の plumbing は 100% 再利用
  - **画像** (PNG/JPEG/GIF/BMP/WEBP/TIFF): pdf-lib で A4 1 ページ PDF に内包。JPEG/PNG は直接埋込、その他は mupdf でデコード → PNG 化。アスペクト比保持・中央寄せ、巨大スキャンは縮小・小画像は 150dpi 相当を上限に拡大しすぎない
  - **Word / Excel** (.docx/.doc / .xlsx/.xls): PowerShell + Microsoft Office COM 自動化で PDF 化 (`-EncodedCommand`、パスは環境変数 `KPDF3_IN`/`KPDF3_OUT` 経由で日本語パス対応、90 秒 timeout、Office 未導入時は明示エラー)。LibreOffice 同梱は不採用 (約 300MB)
  - **既知の制約**: Excel は印刷範囲未設定だと出力ページ数が不定 (Excel COM の仕様)。JPEG の EXIF 回転は未適用。詳細は memory `[[project-insert-office-image]]`
- **β131** (2026-05-25): **上書き / Save As 後のタブ表示 + クリップボード paste 画像の縦横比保持** — ユーザー要望 2 件まとめ
  - **(1) Save As 後にタブが新ファイル名にならない** — `actionExportToPath` の post-save 経路 (renderer.js:3858-) は `kpdf3.openPdfFile(savePath, ...)` で新ファイルへタブを再アンカーしていたが、`tab.activeSourcePdfPath` / `tab.activeSourceName` を更新する処理が欠落 (`openPdfPath` の通常経路 renderer.js:2654-2658 では更新済)。`document.title` / `appTitleText` は refreshViewer 経由の module-level `activeSourceName` で更新されるが、タブバーラベル (`renderTabBar` が `tab.activeSourceName` を読む) は古いファイル名のまま残っていた。タブ切替 round-trip や detach-to-window snapshot にも古い名前が継承される
  - **(1) 修正**: post-save 経路で `tab.activeSourcePdfPath = savePath` + `tab.activeSourceName = basename(savePath)` の 4 行を追加。Save As (別パス) で効く、上書き保存 (同パス) は実質 no-op
  - **(2) クリップボード paste 画像の resize で縦横比が崩れる** — `viewer.js _attachResizeHandles` の onMove は四隅独立に w/h を計算しており aspect 維持なし。スクショ/写真を paste して拡大縮小すると簡単に歪む
  - **(2) 修正**: `pasteImageBlob` (renderer.js:1128) の properties に `aspectLocked: true` を追加 (palette 由来の画像スタンプには付かない、従来通り自由 resize)。`_attachResizeHandles` の onMove に分岐: aspectLocked のとき、ドラッグ距離の長軸を主軸として採用、反対側コーナーを固定して startRatio (= h/w) を維持しながらリサイズ (Word/Adobe 流)。MIN=5pt clamp も aspect を保ったままリスケール
- **β132** (2026-05-25): **β 卒業準備の第一弾 — 「後で」仮説の恒久対応 + CI release 3-OS race の構造解消**
  - **「後で」仮説対応 (β.31/β.32 起動クラッシュ根因)** — 3 つの論点を潰した:
    - **(a) ラベル「後で」の期待値ズレ**: 「ダウンロード?」キャンセル ラベル「後で」→「閉じる」+ メッセージに「次回起動時にもう一度お聞きします」を明記。ユーザが「後で = 中間状態が作られる」と誤解して何度も触り直す経路を断つ
    - **(b) autoInstallOnAppQuit=false の実バグ**: 旧挙動では「次回起動時に適用」を選んでも何も起きず、次回起動でまた「ダウンロード?」が出て**同バージョンを二重 DL** → diff 計算で cache 整合性破壊 (仮説の二段目)。`updater.js` で `autoInstallOnAppQuit = true` に変更し「次回起動時に適用」が真に成立 (アプリ終了時に自動 install)。メッセージにも「アプリを閉じた際に自動的に適用されます」を明記
    - **(c) ダウンロード中の中止手段がない**: busy modal に「中止」ボタンを追加 (`showBusy` の `onCancel`)。`CancellationToken` を `downloadUpdate(token)` に渡して保持 → `kpdf3:updater-cancel-download` IPC で `token.cancel()` → electron-updater が `.partial` + blockmap キャッシュを自動掃除 (partial 残留が次回 DL を破壊する根因に直接対処)。Cancellation 由来のエラーは silent (ステータスバー通知のみ)
    - ファイル: `src/main/updater.js` (+62、CancellationToken / cancel IPC / autoInstallOnAppQuit) / `src/main/preload.cjs` (+1、`updaterCancelDownload` API) / `src/renderer/renderer.js` (+44、ラベル変更 + cancel フロー)
  - **CI release 3-OS race 構造解消** — `.github/workflows/release.yml`:
    - 根因: electron-builder の `--publish=always` は GitHub Release API で「無ければ作成、あれば asset 追加」を内部判断するが、3 OS 並列実行だと 3 job が同時に「無い」と判断して create を叩き合い、最初の 1 つ以外が 422 で落ちる (β12/β33 で実際に踏んだ race)
    - 対策: `build-macos` / `build-linux` に `needs: build-windows` を付与。Win が先に release を作成済 → Mac/Linux 側は append 経路だけを走るので create 競合が物理的に起きない。Mac↔Linux 同士は並列なので所要時間は Win + max(Mac, Linux) ≒ 4-6 分程度に収まる。β タグ (Win 単独) には影響なし、引き続き ~2 分で完走
    - 初検証は stable v2.0.0 タグ push 時 (現時点ではまだ走らない)
  - **β 卒業ロードマップ確定**: 機能凍結ライン β.131 + 1 週間並走 → 残務 #5 (qpdf Mac/Linux) / #6 (診断ロガー撤去) を並行で仕込む → 重大バグなしを確認したら v2.0.0 stable へ。配布対象は Win + Mac + Linux 全部 (ユーザー確認)、Mac 署名/公証は不要 (ダイレクト dmg + 初回「右クリック→開く」案内で運用、memory `[[feedback-mac-signing-not-needed]]`)
- **β133** (2026-05-26): **`kpdf3:open-pdf-file` 全ステージ診断ロガー追加** — 「特定 PDF が開けない (window がすぐ閉じる)」事象の切り分け用。`renderer.js:2692` の catch で `console.error` だけだったため真因がログに残らず仕舞だった。main 側 `kpdf3:open-pdf-file` を全体 try/catch で包み、start / read-done / fingerprint-done / workspace-{reopened,migrated,imported} / open-document-done / done / error の各ステージで `logCrash("open-pdf-stage", ...)` を出力 (fileSize / elapsedMs / 専用計測 + error 時 name/code/message/stack 5 行)。renderer 側 `openPdfPath` の catch にも `kpdf3.logDiag("open-pdf-renderer-error")` を追加。**この診断ログだけで β.134 の真因 (better-sqlite3 BLOB bind RangeError) を即特定できた**
- **β134** (2026-05-26): **巨大 PDF (712MB 裁判所謄写) を開けるよう構造修正** — β.133 診断ログで `RangeError: The bound string, buffer, or bigint is too big at setSourcePdf` を確定。原因: `source_pdf.blob` BLOB に PDF 全体を bind しているが、better-sqlite3 / V8 N-API の制約で数百 MB 級は通らない。対策:
  - **schema**: `source_pdf` に `external_path TEXT` カラム追加 (migration: `ALTER TABLE ADD COLUMN`、既存 WS 互換)
  - **threshold**: 200MB (`LARGE_PDF_THRESHOLD_BYTES`、safety margin 込み)
  - **挙動**: 閾値超は workspace ファイルの隣に `<wsPath>.source.pdf` としてサイドカー書出し → `external_path` 格納、`blob` には 0-byte Buffer (NOT NULL 制約維持)。`Workspace.getSourceBytes()` が external 経路を透過読出
  - **mupdf 側**: 712MB Buffer 受領 → Document 作成 OK (壁なし)、155 ページ + メタ抽出 全 2.4 秒
  - 通常サイズ PDF は従来 BLOB 経路で無変更、現実装は呼出側 5 箇所 (`getSourceBytes()` 経由) すべて無改修
- **β135** (2026-05-26): **PDF 読込中の busy modal 表示 (フリーズ誤認防止)** — β.134 で巨大 PDF が開けるようになったが 2〜数秒かかるためフリーズ疑いの懸念。`openPdfPath` を **300ms 遅延 showBusy + finally hideBusy** で包む。通常サイズで一瞬で開ける PDF はタイマー発火前に完了するためフラッシュなし。File menu / + ボタン / D&D / OS ダブルクリック / 最近開いたファイル / second-instance の全経路をカバー (1 箇所改修)
- **β136** (2026-05-26): **墨消し書き出しで透過 PDF 背景が黒く焼かれる不具合修正** — ユーザー報告「セキュア + 白黒で保存したら関係のない白背景が黒くなった、ただし白塗り枠の中は白のまま」。機序:
  - redaction 付きページは `rasterRedactionPages:true` で strategy="full" に強制 (β.85)
  - full は 900dpi raster → JPEG q=0.95 で encode
  - mupdf は `alpha:true` render なのでスキャン系 / Excel→PDF など明示的な白塗り背景の無い PDF は alpha=0 透過で返す
  - `compositePage` が canvas に白下地なしで `putImageData` 直書き → 透過のまま JPEG 化 → 透過部分が黒に焼かれる
  - 対策: canvas を先に白塗り + ページ raster を tmp canvas 経由で drawImage 合成 (`putImageData` は raw 書込で白下地を消すため)、userRot==0 も同経路に統一
  - β.128 が `composePageImage` (画像保存) で行った対策の compositePage 版。影響範囲は "full" 戦略を取る全経路 (書き出し / 分割保存 / 印刷)、通常の白背景 PDF は元々透過ピクセルが無いので可視差分なし
- **β137** (2026-05-26): **印刷送信中モーダル消失失敗の診断ロガー追加** — ユーザー報告「最近印刷しても送信中ダイヤログが消えないことが多くなった」。crash.log から 6 件連続で `submittedJobCount:0 + reason=reader-closed` (= 中止押下) で終わっており Path A (Win32_PrintJob diff) / Path B (Adobe title 変化) どちらも沈黙の疑い。`printViaReaderDialog` の tick に診断ロガー追加 (spPid / currentJobIds / beforeJobIdsLen / everSeenNewJobsSize / docOpenedSeen / adobeTitle / titleHasMarker)。最初 3 tick 無条件 + 以降は title 変化時 / 10 tick 毎 / job 検出時のみ出してノイズ抑制
- **β138** (2026-05-26): **印刷送信中モーダル auto-close の構造解消** — β.137 ログで「30 tick 全 adobeTitleLen:0」確認、Path B の `snapshotAdobeTitle(sp.pid)` が Adobe Pro DC の親子分離構成 (親 Acrobat.exe = window-less / 子 AcroCEF.exe = UI ウィンドウ持ち) で永遠に空文字を返していたのが根因。対策:
  - `snapshotAdobeTitle(pid)` → `snapshotAdobeTitles()` に置換。`Get-Process -Name Acrobat,AcroCEF` で**全プロセスの MainWindowTitle 配列**を返す
  - tick で `titles.some(t => t.includes(marker))` 判定
  - marker を `"kpdf3-print"` (prefix) から `basename(pdfPath, ".pdf")` (UUID 込みのジョブ固有 ID) に変更、前回印刷 Adobe ウィンドウ残留時の false positive も同時解消
  - 実機検証: 2 件とも tickN:2 で `docOpenedSeen:true` armed → tickN:12 で title から marker 消失 → `reason: doc-closed` で 16-18 秒で自動 close 成功
  - 副作用検討: 同時並行印刷は `_activePdfReaderProcess` 単一トラックで構造的に不可、FAX 経路は β.129 明示確認モーダル化済で Path B 不発のまま想定通り、PowerShell enumerate 増分は数 ms 程度
- **CI release webhook 失敗 (β.138 単発事案)**: β.138 タグ push 後 GitHub Actions が workflow run を発火せず (release / test 両方とも未起動)。タグ自体は origin に到達済、main の HEAD も同期済、`actions/workflows` も `state: active`。原因不明の GitHub 側 webhook 取りこぼし。**復旧**: `git push origin :refs/tags/v2.0.0-beta.138` で remote タグ削除 → 同じ commit に再 tag → 再 push で webhook 再発火 → CI 正常起動。今後同じ症状が出たら同手順で復旧可
- **β139** (2026-05-26): **installer 関連付けを sentinel 化 + portable target 撤去** — ユーザー報告 3 件「(a) BIOS から OS 起動失敗、(b) PDF 規定アプリから勝手に外れる、(c) プログラムから開く選択肢にアイコンあり/なしの K-PDF3 が 2 つ表示 (インストール 1 つだけ)」のうち、(b)/(c) を構造解消。(a) は ユーザランドアプリが BIOS レベルに干渉する経路が構造的に無く、複数台で発生していることから別原因 (Windows Update / ドライバ / hiberfil.sys 不整合 / CMOS 電池 / SSD 劣化等) を疑うべきと判断。打ち手:
  - `package.json` の `win.target` から `portable` を削除 (β.7 以降 nsis + portable の両方を release していたが、portable 版を実行すると Windows の Applications リストに別エントリで登録され「2 つ表示」の根因になっていた)
  - `package.json` から `fileAssociations` ブロックを削除し、electron-builder の自動関連付け書込を完全 off。代わりに `build/installer.nsh` に `customInstall` macro を追加し、`HKCU\Software\io.windom21.kpdf3\FileAssociationsRegistered` を sentinel として「初回 install 時のみ ProgID + Applications 登録」する形に変更。autoUpdater 更新時は sentinel を読んで skip するので UserChoice ハッシュが書き換わらず「規定アプリがリセットされました」通知が出なくなる
  - 初回 install 時に旧 ProgID `K-PDF3.pdf` 残骸 (β.138 以前の電子ビルダ自動書込で残っていたもの) も `HKCU\Software\Classes\K-PDF3.pdf` + `HKCU\Software\Classes\.pdf\OpenWithProgids\K-PDF3.pdf` を削除して掃除
  - `customUnInstall` macro でアンインストール時に全部きれいに消す (legacy `K-PDF3.pdf` も含めて idempotent cleanup)
  - 副次: `package-lock.json` の root version が β.132 で止まっていたのを β.139 で揃えた (β.133〜.138 で bump 漏れ)
  - **既存マシン側の残務**: 過去に portable 版を実行した PC は `K-PDF3-2.0.0-beta.xxx.exe` という version 名付きの Applications 残骸が `HKCU\Software\Classes\Applications\` に残る可能性があるが、version 名が未知のため customInstall で自動掃除できない → 手動 PowerShell or 「アンインストール → 再インストール」で個別掃除が必要
- **β140** (2026-05-27): **2026-05-27 業務並走フィードバック 9 件 + MS 明朝印刷の密度補強** — 並走 Day 2 で集めたテキスト UX / 保存 UX のフィードバックを一気に潰し、長年の懸案 (明朝 hairline が紙でドット化して薄く出る) も根本対策。
  - **テキスト UX 6 件**:
    - ② **システムフォント時の半角数字独立軸**: β.80 で getTextFontStack に system font 早期 return を入れたとき opts.digitsHanko を尊重し忘れ → CrashNumberingDigits prepend が無効化されていた。system font 経路にも `if (opts.digitsHanko) return ${TEXT_DIGITS_HANKO_FAMILY}, ${main}` を追加
    - ③ **テキスト入力フォント永続化**: 起動時 localStorage 復元は preset 値だけ成功し、system font 名は option 不在で失敗 → ウィンドウ再起動でリセットされていた。`appendSystemFontsToSelect` 完了後にもう一度復元を試みる二段復元に変更
    - ④ **テキスト後付けフォント変更導線**: form_field の β.107 `applyFormFieldStyleToEditingOrSelected` と同じパターンを通常 text overlay にも展開。新 `applyTextStyleToEditingOrSelected` で「編集中ならその 1 つ / それ以外は selection 全体の text overlay に multi-select 一括反映」。`populateTextToolbar` を `onSelectionChanged` で呼んで toolbar の text-* select に現在値を populate。各 select の change handler を「適用できたら配置モード遷移しない / なければ従来通り text 配置モード入り」に再配線
    - ⑤ **空き領域右クリックに「貼り付け」**: ctx-page (placement モード切替メニュー) に「貼り付け (Ctrl+V)」項目を追加。clipboard 空時は disabled。右クリックした page + 座標を `_pagePasteAnchor` に保存し、`tryPasteFromAnyClipboard` → `pasteOverlayFromClipboard` / `pasteImageBlob` に anchor 引数を伝搬してクリック位置に paste
    - ⑥ **ページ跨ぎコピペの不安定**: viewer に `_lastClickedPage` + `activePage` getter を追加。ページ空きクリック (overlay クリックは除外) でセット、scroll で自動破棄。paste 経路 (Ctrl+V / 右クリック) は `viewer.currentPage` → `viewer.activePage` を参照することで「ペースト先ページを click → Ctrl+V」が直感どおり動く
  - **保存 UX 3 件**:
    - ⑦+⑧ **別名保存で元タブ消失 + dirty 警告消失**: `actionExportToPath` の post-save が「現タブを新ファイルに置換」していたため、(a) 元タブが消える、(b) 元 PDF への dirty 追跡が破壊される、の二重の問題があった。修正: `savePath !== tab.activeSourcePdfPath` (= Save As) の場合 `newTabAndOpen(savePath)` で新タブを生成、元タブの projectStore / workspaceMutated / pendingDeletedPages は無傷で残す → dirty 警告も継続発火。上書き保存 (同パス) は従来経路を維持
    - ⑨ **範囲書き出し / 単ページ書き出し後の表示**: `actionExportRange` / `actionSavePagesAsPdf` 完了時に `newTabAndOpen(savePath)` を追加して書き出した PDF を新タブで開く。元タブの編集状態は維持
  - **MS 明朝の印刷密度補強 (致命課題対応)**:
    - **症状**: MS 明朝 + 太字 OFF で印刷すると顕著にドットが見え、結果として薄くグレーっぽく出る (ユーザー: 「MS明朝は一番良く使うのでかなり致命的」)
    - **根因確定**: β.76 で導入した hairline stroke は `0.02×fontSize` で 12pt なら 0.24pt = 900dpi で約 3px、トナー再現の境界線で乗らずドット化していた。stroke を太くすればドット化は緩和するが「太字にして濃くなるのは根本解決ではない」(ユーザー談) ため線幅を上げる解は却下
    - **打ち手 — 太さではなく密度で調整**: `paintGlyphRun` の hairline モードで `fillText` を 2 回打ち。Canvas 2D の source-over 合成式 `dst = src*α + dst*(1-α)` により AA 縁の alpha だけが `0.5 → 0.75` 相当に上昇 (glyph 中心は元から完全黒なので不変)。結果として **glyph の太さ・形状は β.76 と完全同一、AA 縁の濃度だけが向上** → 紙でのドット化を構造的に解消
    - **副作用評価**: Gothic / sans / system font / 太字 ON は `hairline = false` で従来通り 1 回打ち、変更なし。描画コストは raster がキャッシュされるため無視できる増分。万一足りなければ 3 回打ちで `0.875` 相当まで上げる余地あり
- **β141** (2026-05-29): **β.140 の追い込み 2 件 — 明朝印刷密度の追加強化 + テキスト後付け編集 options bar の表示漏れ修正**
  - **(a) 明朝印刷密度: 2 回打ち → 4 回打ち** — ユーザー報告「払い・縦線は改善したが横線がまだドット感あり、太さは変えずもう少し濃く」。明朝の横線は元から細い (12pt × 900dpi で 1〜2px) ため AA 縁が支配的で α=1.0 中心 pixel がほぼ無く、β.140 の 2 回打ち (AA α 0.5 → 0.75) では浅いトナー再現で残留ドット化していた。`paintGlyphRun` の hairline 分岐を `fillText` 計 4 回 (base 1 + branch 3) に変更、source-over 合成式で AA α 0.5 → **0.9375** まで強化。中心 α=1.0 は何回打っても 1.0 のままなので glyph の太さは完全不変 (これが「太字化しない密度補強」の核)。Gothic / sans / 太字 ON は `hairline=false` で従来通り 1 回打ち、変更なし。`src/renderer/exporter.js:158-172`
  - **(b) 配置済みテキスト枠の options bar が出ない** — ユーザー報告「フォント/サイズ/色を後付け変更する調整バーが表示されない」。原因確定: β.140 で `applyTextStyleToEditingOrSelected` / `populateTextToolbar` / 各 select の change handler の 3 配線は入っていたが、**`refreshModeOptionsBar` (renderer.js:2174) が text 選択時にバーを表示する分岐だけが抜けていた**。β.107 で `form_field` 用に追加した「placementMode=none + 選択あり → 同種選択ならパネル表示」と全く同じパターンを `text` overlay にも追加。multi-select は全部 text のときだけ表示 (異種混在は hide)、`which = "text"` で `data-mode="text"` の既存パネル (フォント / 太字 / 数字 hanko / サイズ / 色) を流用 — text 配置モード中と同じ DOM を再利用。これで「テキスト枠を 1 つ選択 → options bar が自動表示 → select 変更で即反映」が β.140 で意図された動作通りに到達する。`src/renderer/renderer.js:2182-2222`
- **β142** (2026-06-02): **回転した元 PDF の印刷オーバーレイが天地さかさまになる重大事故を構造解消** — ユーザー報告「フォームの下敷き印刷で天地がさかさまに印刷され、重大な事態が生じた」。**β4/β5 以来の潜在バグ**で、`/Rotate≠0` の元 PDF (スキャン系・裁判所謄写等で頻出) に記入値オーバーレイを重ねる全経路 (Adobe 通常印刷 / 下敷き印刷 / 保存・書き出し / 範囲・分割 / FAX・サイレント) で発症していた。
  - **根因 (2 重バグ、mupdf 実レンダリングで全 4 回転を実証)**:
    1. **ソース /Rotate 無視**: `assembleHybridPdf` は `userRotation` だけを補正し、元 PDF 自身の `/Rotate` を無視。`copyPages` (= `/Rotate` 保持) したページに canonical 座標のオーバーレイを *native 座標* のまま `drawImage` していたため、`/Rotate` が後からオーバーレイごと回転 → `/Rotate=180` で overlay だけ180°反転 (= 天地さかさま)、90/270 で90°ズレ。
    2. **回転方向の取り違え (CW/CCW)**: PDF の `/Rotate`・mupdf・ビューア (`viewer.js` の `ctx.rotate`) はいずれも**時計回り (CW)** だが、`_placeRotatedSourcePage` は pdf-lib の `degrees(userRot)` (**反時計回り CCW**) を使用。さらに **pdf-lib の `embedPdf` は元 /Rotate をベイクしない** (90° でも寸法が swap されない) ことが判明。このため userRotation 90/270 もビューア表示と180°ズレる潜在バグがあった (0/180 は CW=CCW で偶然一致していたため未顕在)。
  - **打ち手 — `effRot = sourceRotation + userRotation` を CW でソースにベイク**:
    - `src/main/rotate-place.js` を新設: native コンテンツを CW で canonical (/Rotate=0) ページへ配置する純粋関数 `rotatedSourcePlacement(effRot, W, H)`。`degrees(-effRot)` + CW 平行移動表 (90→(0,W) / 180→(W,H) / 270→(H,0))。本番コードとテストで共有。
    - `assembleHybridPdf`: 各経路 (source / overlay / external) を `effRot` ベースに再配線。effRot≠0 のとき `_placeRotatedSourcePage` でソースをベイクし、`/Rotate=0` の canonical ページにオーバーレイを **bbox 位置に正しく** 描画 (従来は userRot≠0 で bbox を全面に引き伸ばす別バグもあった)。`source` 戦略は overlay 不在なので userRot=0 の verbatim copyPages 高速経路を維持 (どの /Rotate でも正しい)。
    - `src/renderer/exporter.js`: `sourceRotation` を main へ伝搬。`composeOverlayOnlyPage` (下敷き印刷の overlay 合成) の用紙寸法を `effRot` ベースに修正 (90/270 でのオーバーレイ切り落とし解消)。
    - `test/rotation-overlay.test.mjs`: 全 4 回転を mupdf で実レンダリングして「オーバーレイが canonical TOP-LEFT に残る (天地さかさまにならない) + ベイク後ソースが単体描画と一致」を保証する回帰テストを追加 + `npm test` に組込。**`/Rotate=0` の通常フォームは挙動不変 (高速経路維持)、影響は回転ソースのみ**。
    - 注: 全出力は `assembleHybridPdf` に集約されているため 1 箇所の修正で全印刷/書き出し経路を一括是正。`compositePage` (full 戦略) は mupdf + canvas の二段 CW で元から正しかった (回転バグは hybrid copyPages/embed 経路固有)。
- **β143** (2026-06-02): **吹き出しの後付け書式変更 + 枠はみ出しの構造解消** — ユーザー要望 2 件。
  - **(1) 後付け書式変更**: テキスト枠 (β.140/141) と同じ仕組みを callout に横展開。`refreshModeOptionsBar` に「配置済み吹き出し選択 → text オプションバー表示」分岐を追加 (`_isCalloutOverlay` 判定、text と callout の混在選択も一括編集可、異種混在は hide)。`applyTextStyleToEditingOrSelected` を callout 対象に拡張し、フォント/サイズ/色/太字/数字 hanko を反映 (callout は text と同じプロパティ名を共有)。フォント/サイズ変更時は `fitCalloutBox` で枠を本文に合わせて自動拡大。`populateTextToolbar` も callout 選択時に現在値を populate。→ 吹き出しクリック → バー自動表示 → 変更で即反映、が text と同操作感。
  - **(2) 枠はみ出し**: 「入力画面では枠内に収まるのにサムネ/印刷で本文が枠をはみ出す」不具合。**根因**: `overlay-edit.js` の `measureCalloutWrappedHeight` / `measureCalloutSize` の折返し幅が `Math.max(20, w - padX*2)` (下限 20) なのに、`exporter.js` の `wrapCanvasText` は `w - padX*2` (下限なし)。枠を ~30pt 未満に縮めると書き出しだけ細い幅で折返して行数が増え、採寸した枠高さを超過。エディタは `overflow:hidden` で隠れて見えていた。**対応 (ユーザー選択「枠を本文に合わせて自動拡大」)**: 採寸の下限 20 を撤去し exporter と同一の `Math.max(1, w - padX*2)` に統一。`measureCalloutMinWidth` (最大文字幅 + 余白) を新設し、`handleOverlayResizeEnd` で枠を本文より小さくドラッグしても本文が収まる最小幅に自動拡大 (高さは本文にスナップ)。`viewer.js` の callout テキスト横余白をズーム連動化 (`4*z`) して、どのズームでもエディタと書き出しの折返し位置を一致。**構造的にはみ出しが起きず、どんなに枠を小さくしても文字が割れない**。
  - 注: callout 実描画は DOM (canvas measureText) 依存のため node 自動テスト外 (HANDOVER の「2026-05-10 以降の追加機能は手動確認のみ」方針)。採寸と exporter は同一の折返し式を共有することで一致を担保。`npm test` 既存スイートは全 pass。
- **β144** (2026-06-03): **直線マーカー (蛍光ペン式) + テキスト連続入力** — 業務並走の微調整要望 2 件。
  - **(1) 直線マーカー**: 従来のマーカーは範囲ドラッグ (矩形を塗る) のみだったが、「普通の紙に蛍光ペンで直線的に引く」用途に応えて**直線モード**を追加。マーカー options bar に `種類` (範囲/直線) と `太さ` (細10/中14/太20 pt) の select を増設 (`index.html`)。`overlay-placement.js` に `currentMarkerStyle` / `currentMarkerThickness` を新設し、`startMarkerDrag` を分岐 — 直線モードでは縦帯を押下位置に固定 (top = startY − thickness/2、height = thickness) して、カーソルが縦にブレても**完全に水平**を保ったまま横幅だけがドラッグに追従する。マーカー overlay 自体は従来同様 `line/marker` なので印刷・エクスポート・白黒除外 (黄を黒に塗らない) の挙動はそのまま継承 (exporter 無改修)。種類/色/太さは localStorage で永続化 (`renderer.js`、マーカー色と同じ流儀)。
  - **(2) テキスト連続入力 (sticky 化)**: 「1 回入力を完了するたびにテキストボタンが解除される」不満に対応。`placeText` の `_setPlacementMode("none")` を撤去してテキストモードを維持し、次のクリックで続けて配置できるようにした。**副作用対策**: sticky だとインライン編集を確定するためのクリック (空き領域 click → blur 確定) が同じクリックで新規枠を落としてしまうため、`viewer.js` に `isInlineEditing()` を公開し、`handlePagePointerDown` の先頭で**編集中なら配置を抑止**するガードを追加 (クリックは編集の確定だけに使い、次のクリックで配置)。モードを抜けるのは再度「テキスト」ボタン / 別モード選択 / 編集していない状態での Esc。配置済み overlay クリックは従来どおり `stopPropagation` で配置に回らない (選択/編集に直行) ので二重配置は起きない。
  - 注: いずれも DOM/pointer 依存の renderer 機能のため node 自動テスト外 (手動確認のみ方針)。3 ファイル (`overlay-placement.js` / `renderer.js` / `viewer.js`) の `node --check` 構文検査 pass、`npm test` 既存スイートは無改修で全 pass。機能凍結期間中だが、業務並走で明示要望のあった軽微 UX 改善として投入 (新規 overlay 型・スキーマ変更なし)。
- **β145** (2026-06-03): **β.144 以降に main へ積んだインフラ/セキュリティ整備の配布リリース (新機能なし)**。内訳: ① **Electron 38(EOL 2026-03-10)→41.7.1** (exact、ブロッカーだった better-sqlite3 が 12.10.0 で Electron 41 prebuild を提供して解消、npm-audit の 4 件も解消。§15.1 参照)、② **hardening** (全 webContents で `setWindowOpenHandler` deny + `will-navigate`/`will-redirect` のリモート遷移拒否 + index/popup に CSP メタ。CSP は実機 WSLg スモーク合格)、③ **qpdf Linux 同梱** (公式 portable 12.3.2、stable 残務 #5 の Linux 分。Mac は `QPDF-MAC-TODO.md` 参照)、④ **CI を Node24 対応 actions SHA 固定** (checkout v6.0.3 / setup-node v6.4.0)、⑤ **別窓の ESM `require` 回帰修正** (`af224ad`)。Electron 41 の Windows 実機配布は β.145 が初だが、CI test:m1 が windows-latest で Electron 41 起動 pass 済。
- **β146** (2026-06-04): **ツールバーのアイコン化 + 幅あふれの「»」動的退避** — 業務並走フィードバック「小さい/低解像度モニターだとツールバーのボタンが常に折り返し、文字が縦並びになって不格好・使いにくい。大きい高解像度画面なら問題ない」への対応。
  - **(1) アイコン化**: 22 個の文字ボタン (自然幅 ~1700px 必要) を、◎ = アイコンのみ (開く/上書き/印刷/テキスト/吹き出し/スタンプ/マーカー/FAX/回転)、○ = アイコン+小ラベル (保存/白黒/墨消し/フォーム/図形/分割/範囲)、△ = 「»」収納 (下敷き印刷/＋ページ番号/別窓/別窓化) の 3 段に整理。アイコンは 16px モノクロのレトロ調インライン SVG (`.ti`、stroke `#000`、:disabled で灰・白黒トグル ON で白に反転)。**文字が消えるぶん全ボタンに用途解説 `title` を付与** (ホバー表示、ユーザー要望)。
  - **(2) レスポンシブ動的退避**: ツールバー直下の項目を `flex:0 0 auto` + `white-space:nowrap` で**縮ませない**設定に変更 → 幅不足を `scrollWidth > clientWidth` で検知できる。`ResizeObserver` + `requestAnimationFrame` で「全戻し → `ORDER` 配列の先頭 (表示倍率→検索→回転→範囲→分割→図形→フォーム→注釈→ファイル系) から fits() まで順に `»` の動的退避ゾーン `#overflow-dynamic` へ**実要素ごと移動**」を 1 パス実行。**縮めないので文字の縦並び・高さ変化・アイコンと枠のズレ (= 縮小由来) が原理的に起きない** (ユーザー指摘の 2 つ目もこれで同時解消)。実要素移動なので表示倍率 select・検索入力もメニュー内でそのまま機能、配線は全て既存のまま。
  - **配線**: `»` (`btn-overflow`) は menu-bar.js に密結合せず同じ `.menu-dropdown` を流用した最小トグル。△ の 4 つは隠し本体ボタンへ `click()` 委譲 (静的ゾーン)、動的退避ゾーンはその上。検索の `margin-left:auto` (右寄せ) は退避と相性が悪いので撤去し左詰めに統一。`btn-overflow` は常時有効化。
  - **ファイル**: `src/renderer/index.html` (アイコン SVG / `tb-unit` ラップ (表示倍率・回転) / `#overflow-dynamic` / `menu-overflow`)、`style.css` (`.ti` アイコン・縮めない設定・退避ゾーンのメニュー行スタイル)、`renderer.js` (`wireOverflowMenu` IIFE に reflow を統合)。
  - 注: DOM/レイアウト依存の renderer 機能のため node 自動テスト外 (手動確認のみ方針)。`node --check` pass、`npm test` 既存スイートは無改修で全 pass。**実 CSS + 同一退避アルゴリズムの忠実プレビューを headless Chrome で 1280/820/620px の 3 幅レンダリングし、高さ一定・表示→検索→… の順退避・アイコン無ズレを確認済**。

**当面の残課題 / 未解決事項** (優先順):

1. **β.118 印刷ジョブ drain 待ち + busy modal 中止の実機検証** — (a) 大量ページ印刷時に全ページ送信し切るか (`pdfreader-jobs-drained: drained=true` ログ確認)、(b) Adobe が hand-off で固まる事象で busy modal の「中止」ボタンが効くか、(c) DRAIN_TIMEOUT_MS=5min が業務的に適切か
2. **β.116/.118 Adobe 検出パターン拡張の実機検証** — `adobeRelatedAtCleanupWide` で未知の Adobe 関連プロセスが見えた場合の対応。CC 常駐サービス (Adobe Desktop Service / Genuine 等) は NEVER_KILL_PREFIX に追加済、それ以外の取り漏れがあれば共有してもらって反映
3. **β.117 印刷 temp PDF 診断の活用** — 016-721 等の再発時に `print-via-reader-dialog-start` ログの `tempPath` をユーザーが取り出し、Adobe で直接開いて印刷 → K-PDF3 が書き出す PDF 自体の問題か、起動経路の問題かを切り分け
4. **印刷後 temp PDF が K-PDF3 に open される副次現象** (β.95 ログで発見) — Adobe 印刷後に temp PDF が K-PDF3 に「開け」と渡される (second-instance-received → os-open-received)。実害は軽微 (新セッションが一瞬立ち上がる程度) だが余計な動作。Adobe / Windows ファイル関連付けが絡む可能性。**低優先で要調査**
5. **下敷き印刷の精度キャリブレーション** (β.80 で本体実装済、未検証) — 用紙送り誤差で X/Y 数 mm ズレる可能性。実機で「申請書原本を下敷きに、白紙申請書をプリンタにセットして印刷」検証 → ズレ量から (a) プリンタ別 X/Y オフセットだけで十分か (b) 倍率補正 / トレイ別 / 申請書別まで要るかを判断
6. **β.83 annotation proxy の実機検証** — annotation 入り PDF を開いて (a) 種別ごとの見た目、(b) 位置精度 (canonical 変換)、(c) ツールチップ表示、(d) ズーム/回転追従、(e) PDF 切替時の残留無しを確認待ち
7. **β.84/β.85/β.86 セキュア書き出し + 真の墨消しの実機検証** — (a) Adobe で「文書のプロパティ」を見て Author/Producer が消えているか、(b) しおりが保持されているか、(c) 墨消しを置いたページで Adobe テキスト選択 / 検索 / 抽出できないこと、(d) 警告ダイアログが出ないか、(e) β.86 で可視化したチェックボックスが業務的に気付きやすいか
8. **β.87 画像スタンプ濃度 ramp の実機検証** — カラー印影 (赤・青等) 画像を 1 つ登録するだけで押印 / 印刷の濃度が白黒版と同等になるか。閾値 LO=0.5 / HI=0.85 が業務印影をカバーするか
9. **β.94 タブ切替バグの実機検証** — Tab A でしおりクリック後 Tab B に切替 → (a) Tab B が前回位置 (or 先頭) に開くこと、(b) Tab B のしおりパネルに Tab A のしおりが混在しないこと
10. **β.90 zombie 自己復旧の実機検証** — primary window 閉じ + B3 子ウインドウ alive の状態で PDF ダブルクリック → 新 primary window が立ち上がって PDF が開くか
11. **β.97 画像書き出しの実機検証** — (a) 全/現/カスタム範囲のパースが期待通りか、(b) 連番ファイル名の桁数が業務的に合理的か、(c) 300 dpi デフォルトが送付用に適切か、(d) 白黒モードでの overlay 黒変換
12. **β.100-104 オートシェイプの実機検証** — (a) 9 種類が業務想定をカバーするか、(b) ↻↺ ボタンで 45° 回転時に太さ・長さが完全に不変か、(c) 斜め方向で bbox 切れがないか、(d) popup と選択 shape の値同期が直感的か
13. **β.107-109 選択 UX (群移動 / Ctrl+A / 矢印キー / 一括変更) の実機検証** — (a) 複数選択時の D&D 同期移動、(b) Ctrl+A 全選択 + 矢印キーで全体ズラし (β.108 で端到達 clamp 修正済)、(c) 同種 form_field 複数選択時の options bar 一括変更、(d) Shift+click range も β.109 で復活
14. **β.110/.111 書き出し / 上書き保存の白黒オプションの実機検証** — 各書き出しダイアログのチェック + 上書き保存の確定ダイアログでの「白黒で上書き」が業務想定通り効くか
15. **β.113 OS native CJK font fallback の継続実機検証** — 銀行明細以外の未埋め込み CJK フォント PDF でも Adobe 互換の表示になるか。crash.log の `font-fallback-callback` を時々確認して取り漏れフォント名がないか
16. **明朝保険の再設計** (β.88 Phase 3 を 900dpi 過剰実装で撤回した経緯) — β.92 で Adobe `/p` 経路に統一したことで明朝 hairline 品質も担保される (Adobe vector レンダラ使用) → 当面再設計の必要性なし
17. **分割保存にもセキュア書き出し UI** — β.84 / β.110 で通常書き出し系 + 上書き保存 + 分割保存 (mono のみ) に提供済。secure 側は qpdf 等の複雑性から folder picker 系では未提供 (提出版を分割保存で作る業務シナリオが想定されるなら追加検討)
18. ~~「後で」仮説の恒久対応~~ ✅ **β.132 で対応**。`autoInstallOnAppQuit = true` + CancellationToken による partial cache 掃除 + ラベル整理 (「後で」→「閉じる」)。実機検証は autoUpdater 経路で進行中 (β.133→β.138 の更新を実際に経験して順調)
19. ~~CI release matrix race~~ ✅ **β.132 で構造解消**。`needs: build-windows` で 3 OS 並列の create 競合を排除。初検証は stable v2.0.0 タグ時
20. **stable リリース時の cleanup**: β51 で追加したクラッシュ診断ロガー一式 + β75 D&D 診断ログ + β.85 Adobe 残留診断 + β.90 primary-window-closed + β.96 adobeRelated* + β.106 cleanup-start/cleanup-error + β.113 font-fallback-callback + β.116 adobeRelatedAtCleanupWide / survivorsExtraWide + β.117 tempPath/tempBytes + β.118 pdfreader-jobs-drained / print-cancel-by-user + **β.133 open-pdf-stage / open-pdf-renderer-error** + **β.137-138 print-tick** を撤去 (`crashLogPath()` / `logCrash()` / `kpdf3:log-diag` IPC 等)。**他残務の安定確認後、最後に適用**
21. **Wayland ショートカット + renderer auto-reload** — F5 / Ctrl+R / F12 が Ubuntu Wayland で発火しない (β.74 で記録)。dev で electronmon の renderer auto-reload が反映されないケースもあり (完全 kill + 再起動で解消)
22. **既存 workspace の leftover synth (300 dpi image_blob) 削減** (低優先) — β78 以前に挿入された synth は 300 dpi、新規分は 96 dpi。混在は問題ないが storage 圧縮目的で migration を打つなら考慮余地
23. **罫線抑制ツールの再公開検討** (β.114/.115 で導入 → ボタン撤去、内部 API 残置) — 「ツール」or「詳細設定」メニュー経由で必要時にオプトイン公開する案。`src/renderer/line-suppress.js` / `viewer.setSuppressLines` は既に存在
24. **qpdf Mac/Linux バンドル** — **stable 配布対象に Mac/Linux も含めることが 2026-05-25 に確定** (ユーザー判断)。**2026-06-03 に Linux 完了** (公式 portable v12.3.2 を `vendor/qpdf/linux/` に bin+lib 同梱、`qpdf-sanitize.js findQpdfBinary` を win=flat / mac・linux=bin+lib のレイアウト差対応、`package.json` の mac/linux `extraResources` 設定済)。**残るは Mac バイナリのみ** (公式 mac プリビルド無し → `vendor/qpdf/mac/README.md` の brew+dylibbundler 手順で実機ビルドが必要、**stable タグ前に必須**)。なお `extraResources` のコピー + AppImage/dmg 実行確認は stable ビルド時に行う
25. **shape ADR の起草** (β.100-104) — overlay type "shape" 追加 + length/crossSize モデルは ADR 起草対象。ADR-0023 候補
26. **shape の発展余地** (低優先、ユーザー要望次第) — (a) shape にテキスト埋込、(b) 任意角度回転 (現状 45° 単位)、(c) 線種 (dash/dot)、(d) ハンドルで両端を独立に動かす UI
27. **font-fallback の Mac 対応** (β.113 で Win + Linux のみ実装) — macOS の OS native CJK font path (例: `/System/Library/Fonts/...`) を pickFontFile に追加すれば動く。Mac ビルド配布時に対応
28. **β.128 画像保存の黒背景修正の実機検証** — 白塗り背景の無い PDF (Excel→PDF 等) を「画像として保存」(PNG/JPEG 両方) して背景が白く出るか。範囲画像 (`composeRegionImage`) も同様
29. **β.129 FAX 送信中モーダルの実機検証** — FAX 送信時、ページ描画後に「送信完了」ボタン付きモーダルへ切り替わるか → Adobe + FAX ドライバで送信を済ませて「送信完了」を押す → モーダルが閉じるか。両 path (job-detected/doc-closed) が偶発的に効いた場合は自動で閉じる
30. **β.130 画像/Word/Excel 挿入の実機検証** — (a) 画像 D&D → A4 ページ化、(b) Word D&D → 全ページ挿入、(c) Excel D&D（※ 印刷範囲未設定だと出力ページ数が不定）、(d) Office 未導入時の明示エラー。Office COM がハングした場合の WINWORD/EXCEL 残留有無も観察。memory `[[project-insert-office-image]]` 参照
31. ~~巨大 PDF (200MB 超) で workspace 作成失敗~~ ✅ **β.134 で構造解消** (サイドカーファイル + `external_path` カラム)。実機 712MB 謄写 PDF で 2.4 秒 open 確認済。**継続観察**: orphan サイドカー残留 (workspace 削除時の cleanup 未実装 / β.132〜β.133 失敗試行で残った空 .kpdf3 9 件等) — 業務影響なしだが startup スキャン掃除を stable 前に検討余地
32. ~~墨消し書き出しで透過 PDF 背景が黒く焼かれる~~ ✅ **β.136 で構造解消** (`compositePage` に白下地 + drawImage 合成、β.128 同パターン)。実機検証: 「枠の中は白のまま、枠の外側 (透過部分) が全面黒」だったケースで全面白に出る想定
33. ~~印刷送信中モーダルが消えない (Path B 沈黙)~~ ✅ **β.138 で構造解消** (全 Acrobat/AcroCEF process scan + UUID marker)。実機 2 件で 16-18 秒の auto-close 確認 (`reason: doc-closed`)。**Path A の Win32_PrintJob 沈黙はネット印刷 / driver bypass 由来で構造的、Path B が補完するので業務影響なし** — 将来 Path A も復活させたければプリンタ別調査要
34. **β.135 PDF 読込中 busy modal の実機検証** — 通常サイズ PDF (< 300ms 開) でモーダルが flash しないか、巨大 PDF で読込完了時に正しく hide されるか
35. **`open-pdf-stage` / `print-tick` 診断ロガーの可観測性**: β.133 / β.137-138 で追加した詳細ログにより crash.log は 1 セッションあたり 30〜60 行増える可能性。stable cleanup で撤去 (上 20 番) しても β 期間中の業務並走に支障なし
36. **β.139 installer 修正の実機検証** — テスター環境で autoUpdater 経由 β.139 受け入れ後、(a) 次の β タグ受信時に「規定アプリがリセットされました」通知が出ないか、(b)「プログラムから開く」の K-PDF3 が 1 つだけ表示されるか (旧 ProgID `K-PDF3.pdf` 残骸の自動掃除確認)、(c) ユーザ手動で「PDF を Adobe で開く」に既定を戻した状態が以降の β 更新で維持されるか
37. **portable 残骸の個別掃除案内**: 過去に `K-PDF3-2.0.0-beta.xxx.exe` (portable) を実行した PC は customInstall で自動掃除できない → スタッフ環境で「2 つ表示」が β.139 後も残ったら PowerShell 手順 (`Remove-Item HKCU:\Software\Classes\Applications\K-PDF3*.exe -Recurse` 等) で個別対応、または「アンインストール → 再インストール」で一掃
38. **BIOS から OS 起動失敗の別原因切り分け** — ユーザー報告のうち (a) BIOS フリーズは K-PDF3 が干渉できる経路が構造的に無いため別原因 (Windows Update / ドライバ / hiberfil.sys 不整合 / CMOS 電池 / SSD 劣化等) を疑うべき。β.139 後も継続するか観察 → 続けばハードウェア / OS 側の問題が確定的
39. **β.140 / β.141 テキスト UX 改修の実機検証** — β.140 で投入したテキスト系 6 件 + 保存系 3 件 + β.141 の追い込み 2 件をまとめて並走で確認: (a) システムフォント時に「数字 hanko 風」チェックで半角数字だけ切り替わるか、(b) ウィンドウ再起動でも前回選択フォントが残るか (preset / system 両方)、(c) 配置済みテキスト枠を選択すると options bar が自動表示されフォント / サイズ / 色を変更すると即反映されるか (β.141 修正)、(d) 空き領域右クリック「貼り付け」で右クリック座標にちゃんと貼られるか、(e) ページ跨ぎコピペで「ペースト先ページを click → Ctrl+V」が直感どおり動くか、(f) 別名保存で元タブが残り dirty 警告が継続するか、(g) 範囲 / 単ページ書き出し後に新タブで結果 PDF が開くか
40. **β.140 → β.141 明朝印刷密度の実機検証** — `paintGlyphRun` の 4 回打ちで MS 明朝 + 太字 OFF の印刷物において (a) 縦線・払いが β.140 (2 回打ち) 比でさらに濃く乗るか、(b) **横線のドット感が解消されるか (β.140 の残課題、β.141 の主目的)**、(c) glyph 太さが β.139 / β.140 と完全に同一に見えるか (太字化していないか)、(d) 12pt / 14pt / 18pt 等の小〜中サイズで効果が体感できるか、(e) Gothic / sans / 太字 ON は β.139 と同一出力のままか (回帰なし)。万一足りなければ 5 回打ち (AA α 0.96875) まで余地あり、逆に「太く見える」報告が出たら 3 回打ち (0.875) に戻す選択肢も維持

**β.51 以来追跡されてきた「一瞬開いてすぐ閉じる」は β.90 で根治済** (旧 §8.2 #1)。**「印刷後 Adobe 残留」は β.95-96-116-118 と段階的に対策を重ねて構造解消**、β.118 では Adobe CC whitelist 拡張 + 詳細診断ログで「未知の Adobe 関連プロセス」も追跡可能に。**「印刷の途中打ち切り」は β.118 のジョブ drain 待ちで構造解消**、実機検証待ち。**「ページ番号の印刷時かすれ」は β.121 で `enforceHairline` 導入により細字 + Gothic でも 0.02pt の hairline stroke で濃く印刷される**。**β.128 で「画像として保存」の黒背景バグ (白塗り背景の無い PDF) を修正。β.129 で FAX 送信中モーダルを「送信完了」明示確認に変更 — FAX は印刷完了の自動検出信号が構造的に無いため (memory `[[project-fax-busy-modal-explicit]]`)。β.130 で挿入対象に画像/Word/Excel を追加 (Office COM 経由で PDF 化 → 既存挿入経路に流す、memory `[[project-insert-office-image]]`)**。**β.131 で Save As 後のタブ表示が新ファイル名にならない不具合 + クリップボード paste 画像の縦横比保持 (aspectLocked プロパティ + 主軸方式 resize)**。**β.132 で「後で」仮説恒久対応 + CI 3-OS race 構造解消 — β 卒業準備の第一弾**。**β.133 で `kpdf3:open-pdf-file` 全ステージ診断ロガー追加 (即 β.134 の真因特定)。β.134 で巨大 PDF (200MB 超) をサイドカーファイル化して better-sqlite3 BLOB bind RangeError を構造解消 (実機 712MB / 2.4 秒 open 確認)。β.135 で巨大 PDF 読込中の busy modal 表示 (300ms 遅延でフラッシュ抑制)。β.136 で墨消し書き出しの透過 PDF 黒背景バグ (compositePage 白下地未敷きの β.128 横展開漏れ) を構造解消。β.137 で print-tick 診断ロガー追加 (即 β.138 の真因特定)。β.138 で印刷送信中モーダル auto-close 失敗を構造解消 — Adobe Pro DC の親子分離下で sp.pid 限定 title scan が永遠に空文字を返していた根因を、全 Acrobat/AcroCEF process scan + UUID marker で克服 (実機 2 件で 16-18 秒の auto-close 確認)。β.140 で 2026-05-27 業務並走フィードバック 9 件 + MS 明朝の印刷密度補強 — テキスト UX 6 件 (system font の半角数字独立軸 / フォント永続化 / 後付け変更導線 / 空き領域右クリック貼り付け / ページ跨ぎ paste anchor) + 保存 UX 3 件 (Save As で元タブ残存・dirty 継続 / 範囲・単ページ書き出し後の新タブ表示) + 「明朝が印刷でドット化して薄い」根因 (0.02pt × 900dpi ≒ 3px のトナー再現境界) を確定し、線幅を変えず `fillText` 二重描きで AA 縁の濃度のみ上昇させる方向で構造解消。β.141 で追い込み 2 件 — (a) 明朝印刷密度を 4 回打ちに強化 (AA α 0.75 → 0.9375、横線のドット感も解消)、(b) β.140 の text 後付け編集で options bar が出ない配線漏れ (`refreshModeOptionsBar` の text 選択分岐) を修正**。

**β 卒業ロードマップ (2026-05-25 確定、進行状況 2026-05-29)**: β.131 機能凍結ライン + 1 週間業務並走 (〜 2026-06-01 目安) で重大バグなしを確認 → 並行で stable 残務 (qpdf Mac/Linux 同梱 + 診断ロガー撤去) を仕込む → v2.0.0 stable タグ。配布対象は Win + Mac + Linux 全部 (Mac 署名/公証は不要、ダイレクト dmg + 初回「右クリック→開く」案内で運用)。**並走 Day 1 (2026-05-26) で 5 件 + Day 2 (2026-05-27) で 1 件 + Day 4 (2026-05-29) で 1 件 (β.141) の構造修正を投入**: β.134 巨大 PDF / β.135 読込モーダル / β.136 墨消し黒背景 / β.138 印刷モーダル消失 / β.139 installer 関連付け sentinel + portable target 撤去 / β.140 フィードバック 9 件 + 明朝印刷密度 / β.141 明朝印刷密度 4 回打ち + テキスト options bar 表示漏れ修正。いずれも構造修正 (小手先回避なし)、機能追加はなし。残り ~3 日間で追加のバグが出なければ stable へ進む方針継続。

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
| qpdf | 12.3.2 (Win+Linux 同梱 / Mac 実機待ち) | Apache 2.0 | secure export sanitize |

### 5.3 同梱バイナリ

| 項目 | ライセンス | 配置 | 役割 |
|---|---|---|---|
| SumatraPDF.exe | GPLv3 (spawn なので link 制約なし) | `vendor/sumatrapdf/` | Win 印刷 fallback (Reader 不在時) |
| qpdf 12.3.2 msvc64 + DLL 群 | Apache-2.0 | `vendor/qpdf/win/` | β.84 secure export (`--remove-info --remove-metadata`)。spawn なので link 制約なし、Mac/Linux は stable 時に追加 |

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
| **β79** | 05-16 | **サムネ→別ウインドウへページ挿入** (B3-γ activeTabDrag のページ版、4 ドロップ経路 + 多選択 + 回転対応、COPY 動作)。副次的に `get-inserted-page-image` / `get-inserted-source-pdf` の per-window 化 (`activeForEvent`) |
| **β80** | 05-16 | **申請書テンプレ機能一式** (Phase A〜E: form_field 4 サブタイプ + popup + 記入モード Tab nav + 下敷き印刷 + システムフォント) + multi-select コピペ + 幅/高さ揃え + form-text 上下左右揃え + 既存バグ 2 件根治 |
| **β81** | 05-17 | 丸囲み click 配置 + 楕円変形 / form-text 後付け編集 (`applyFormTextStyleToEditingOrSelected`) / 記入モード Shift+Enter 改行 |
| **β82** | 05-17 | **申請書テンプレ UX 強化 (Phase B-5 + B-6)** — 後付け編集 UX (form_field 選択で options bar 自動切替 + 現在値 populate、check/circle/radio も対応) + Tab 順手動編集 (`tabOrder` プロパティ、番号バッジ ドラッグ + 別 popup 縦リスト、pulse highlight) |
| **β83** | 05-17 | **C3 annotation read-only proxy** (M6 残) — mupdf 経由で 15 種別の annotation を抽出して viewer に retro 風 marker 表示 (種別ごとアイコン分岐 + native title tooltip) |
| **β84** | 05-17 | **qpdf sanitize / セキュア書き出し** (M6 残) — qpdf 12.3.2 同梱 + `--remove-info --remove-metadata` で書き出し時に metadata strip。書き出しダイアログにチェックボックス (デフォ ON) |
| **β85** | 05-18 | **β.84 配布フィードバック 6 件まとめ** — #3 真の墨消し (redaction ページを 900dpi raster) / #4 stamp palette 横スクロール禁止 / #6 text stamp 太字解消 / #2 D&D 挿入後 scroll / #5 stamp 並び順 ▲▼ / #1 Adobe 残留診断 (survivors + reader-process-closed タイムスタンプ) |
| **β86** | 05-19 | **セキュア書き出しチェックボックス可視化 hotfix** — β.84 来の `<label><input></label>` で 98.css が描画していなかった問題を `<input><label>` 並列構造に修正 + 区切り線 + bold で UX 強化 |
| **β87** | 05-19 | **画像スタンプ濃度を閾値 ramp** — カラー印影 (赤・青等) が線形 lum→alpha で 60-70% 透過して薄く出る問題を解消。`lum≤0.5→1.0 / lum≥0.85→0.0 / 中間 ramp` で 1 つの登録で押印 / 印刷の濃度担保。3 経路 (preview/exporter/viewer) すべて適用 |
| **β88-β96** | 05-19 | 白黒印刷モード + FAX 経路再設計 (Adobe `/p` + 規定プリンタ一時設定) + zombie 自己復旧 + Adobe 残留構造解消 |
| **β97** | 05-19 | **PDF を画像として保存 + 範囲選択画像保存** — メニュー「画像として保存…」+ ツールバー「範囲画像」。PNG/JPEG、解像度 96/150/300/600/900 dpi、全/現/`1-3,5,7-10` 範囲、白黒モード、連番ファイル出力。`composePageImage` / `composeRegionImage` を `exporter.js` に追加、main に `save-image-file(s)` IPC、`file-browser.js` に `defaultExt` |
| **β98** | 05-19 | 画像書き出しダイアログ可視化 hotfix — `<label><input></label>` 入れ子で radio が描画されない (β.86 と同じ 98.css 非互換) を並列構造に修正 |
| **β99** | 05-19 | 分割保存 part 名 textbox で Backspace が効かない問題を修正。`splitFlow` / `thumbList` keydown ハンドラに `_isTextInputTarget` 分岐を追加 |
| **β100** | 05-19 | **オートシェイプ機能** — 新 overlay type `shape` を投入。直線 / 矢印 / ブロック矢印 / 楕円の 4 種で最小スタート。`drawShape` を exporter から export して viewer / exporter で共通描画。schema migration `migrateOverlaysAddShape`。「図形」ボタン + shape palette popup (form palette と同じ流儀) |
| **β101** | 05-19 | **図形拡張** — 四角 / 角丸四角 / 楕円+× / 双方矢印 / 双方ブロック矢印 を追加 (計 9 kind)。8 方向 (45° 単位、斜め含む) サポート、`_dragDir8` でドラッグ方向量子化 |
| **β102** | 05-19 | 配置 UX 再設計 — placement は常に "right" 固定、配置直後に自動選択。bbox を「中心固定で横↔縦 swap・斜めは正方形化」(β.104 で太さ・長さ不変モデルに更に置換) |
| **β103** | 05-19 | 編集を shape palette popup に統合 — `mode-options-bar` の `shape-edit` 経路は撤去、popup が「配置 defaults + 編集」両用。popup に「向き」select を追加、selection 経路で popup を populate |
| **β104** | 05-19 | **shape を「太さ・長さ不変の 45° 回転」モデルに再設計** — `properties.length` / `crossSize` を新規導入し、bbox は `length × crossSize` の rotated AABB として派生計算。描画は中心 (0,0) 基準で右向きに描いて `ctx.rotate`。斜めでも切れず、方向で太さが変わらない。popup の dir dropdown を「↺ ⟨向き indicator⟩ ↻」ボタン UI に置換、`rotateSelectedShape(±1)` で 45° 単位回転 |
| **β105-β122** | 05-20〜21 | system フォント / 選択 UX (群移動/Ctrl+A/矢印/同種一括) / 白黒書き出し / CJK fallback / 印刷ジョブ drain 待ち / 図形 palette 整列 + 挿入メニュー + PDF プロパティ |
| **β123** | 05-21 | 分割保存サムネのプログレッシブ表示 (即時レイアウト + 並列 3 + 表示中ページ優先 IntersectionObserver) + 保存ダイアログのボタン 2 行化 (white-space: pre) |
| **β124** | 05-21 | 印刷準備の並列化 — `snapshotPrintJobs` を Adobe spawn と並列実行 (~1-1.5s 短縮) + `composePagesForExport` を 3 ワーカープール化 (大ドキュメントほど効く) |
| **β125** | 05-21 | Adobe cleanup-end 後の追跡 snapshot 診断ログ (+5s/+15s/+30s) — 「タスクバーに残る」事象の cleanup 完了以降の挙動を観測可能に |
| **β126** | 05-21 | **Adobe 残留の構造対策** (案 X 強化) — Path A (Win32_PrintJob cumulative tracking で短命ジョブ救済) + Path B (Adobe MainWindowTitle が "kpdf3-print" を含む → 含まない遷移で印刷完了検出、orthogonal 信号)。通常印刷では実機で改善確認 |
| **β127** | 05-22 | 「最近のファイル」を Win95 流カスケードサブメニュー化 (ダイアログ撤去) |
| **β128** | 05-22 | 「画像として保存」で白塗り背景の無い PDF (Excel→PDF 等) が黒背景になる不具合を修正 (白地へ合成してから encode、`composePageImage`/`composeRegionImage`) |
| **β129** | 05-22 | **FAX 送信中モーダルが消えない事象** — FAX は印刷完了の自動検出信号が構造的に無いため、Adobe 起動後を「送信完了」明示確認モーダルに切替 |
| **β130** | 05-22 | **挿入対象に画像 / Word / Excel を追加** — 変換 (画像=pdf-lib で A4 内包 / Office=COM 自動化) → 既存挿入経路に流す。新規 `src/main/file-to-pdf.js` |
| **β131** | 05-25 | Save As 後のタブが新ファイル名にならない不具合 + クリップボード paste 画像の縦横比保持 (aspectLocked プロパティ + 主軸方式 resize) |
| **β132** | 05-25 | **β 卒業準備の第一弾** — 「後で」仮説恒久対応 (autoInstallOnAppQuit=true + CancellationToken + ラベル整理) + CI 3-OS race 構造解消 (Mac/Linux に `needs: build-windows`) |
| **β133** | 05-26 | `kpdf3:open-pdf-file` 全ステージ診断ロガー追加 — 巨大 PDF が開けない事象の切り分け用 (β.134 で即真因特定) |
| **β134** | 05-26 | **巨大 PDF (200MB 超) のサイドカーファイル化** — better-sqlite3 BLOB bind の RangeError を構造回避。`source_pdf.external_path` カラム追加 + `<wsPath>.source.pdf` 隣置き。実機 712MB 謄写 PDF を 2.4 秒で open |
| **β135** | 05-26 | PDF 読込中の busy modal を 300ms 遅延表示 (フリーズ誤認防止)。通常サイズはタイマー発火前に完了して flash しない |
| **β136** | 05-26 | **墨消し書き出しの透過 PDF 黒背景バグを修正** — `compositePage` に白下地敷き + `tmp canvas + drawImage` 合成 (β.128 の `composePageImage` 横展開漏れ)。full 戦略を取る全経路に効く |
| **β137** | 05-26 | 印刷送信中モーダル消失失敗の `print-tick` 診断ロガー追加 — spPid / currentJobIds / adobeTitle / titleHasMarker / docOpenedSeen を tick 毎に出す |
| **β138** | 05-26 | **印刷送信中モーダル auto-close の構造解消** — `snapshotAdobeTitle(sp.pid)` → `snapshotAdobeTitles()` (全 Acrobat/AcroCEF process scan)、marker を `"kpdf3-print"` prefix から UUID 込みの jobs 固有 ID に変更。Pro DC 親子分離 (親 window-less / 子 AcroCEF UI 持ち) で Path B が初めて真に機能 |
| **β139** | 05-26 | **installer 関連付けを sentinel 化 + portable target 撤去** — ユーザー報告「PDF 規定アプリが勝手に外れる」「プログラムから開くに K-PDF3 が 2 つ表示」を構造解消。win.target から portable 削除、fileAssociations を package.json から削除して `build/installer.nsh` の customInstall macro で sentinel 付き 1 回限り登録に変更。autoUpdater 更新で UserChoice ハッシュが書換わらず規定アプリ通知が出なくなる。旧 ProgID `K-PDF3.pdf` 残骸も初回 install で自動掃除 |
| **β140** | 05-27 | **2026-05-27 業務並走フィードバック 9 件 + MS 明朝印刷の密度補強** — テキスト UX 6 件 (system font の半角数字独立軸 / フォント永続化 / 後付け変更導線 / 空き領域右クリック貼り付け / ページ跨ぎ paste anchor) + 保存 UX 3 件 (別名保存で元タブ残存・dirty 継続 / 範囲・単ページ書き出し後に新タブ表示) + **MS 明朝 hairline の密度補強** (`paintGlyphRun` の hairline 経路で fillText 二重描き → AA 縁濃度のみ上昇、glyph 太さ不変)。明朝の「太字 OFF だと印刷でドット化して薄い」根因 = 0.02pt の hairline stroke が 900dpi で約 3px のトナー再現境界線にあったことを確定、線幅を上げず密度のみ上げる方向で構造解消 |
| **β141** | 05-29 | **β.140 の追い込み 2 件** — (a) 明朝印刷密度を 2 回打ち → 4 回打ち (`paintGlyphRun` hairline、AA α 0.75 → 0.9375) に強化し横線のドット感も解消、(b) 配置済みテキスト枠選択で options bar が出ない配線漏れ (`refreshModeOptionsBar` の text 分岐) を修正 |
| **β142** | 06-02 | **回転 PDF の印刷オーバーレイ天地さかさま修正 (重大事故)** — `/Rotate≠0` の元 PDF に記入値を重ねる全経路 (下敷き/通常印刷・書き出し・FAX) で、`assembleHybridPdf` が userRotation のみ補正しソース /Rotate を無視 + pdf-lib CCW vs PDF/mupdf CW の方向取り違えにより overlay だけ天地反転 (180°) / 90・270 ズレ。`effRot = sourceRotation + userRotation` を CW でソースにベイク (`src/main/rotate-place.js` 新設) → `/Rotate=0` canonical ページに overlay を bbox 配置。embedPdf が元 /Rotate を非ベイクと判明。全 4 回転を mupdf 実レンダリングで回帰テスト (`test/rotation-overlay.test.mjs`)。`/Rotate=0` 通常フォームは挙動不変 |
| **β143** | 06-02 | **吹き出しの後付け書式変更 + 枠はみ出し解消** — (1) text (β.140/141) 同様に配置済み吹き出しを選択 → text オプションバーでフォント/サイズ/色/太字を後付け変更 (`refreshModeOptionsBar` / `applyTextStyleToEditingOrSelected` / `populateTextToolbar` を callout 対応、`_isCalloutOverlay`)。(2) 入力画面では収まるのにサムネ/印刷で本文がはみ出す不具合を構造解消 — 採寸 `measureCalloutWrappedHeight` の折返し幅下限 `max(20,…)` が exporter `wrapCanvasText` の `w-padX*2` と不一致で、小さい枠で書き出しだけ行数超過していた。下限撤去で一致 + `measureCalloutMinWidth` で「枠を本文に合わせて自動拡大」(本文より小さくできない)。`viewer.js` の余白をズーム連動化 |
| **β144** | 06-03 | **直線マーカー (蛍光ペン式) + テキスト連続入力** — 業務並走の微調整 2 件。(1) マーカーに `種類` (範囲/直線) + `太さ` select を追加。直線モードは縦帯を押下位置に固定 (top=startY−th/2, height=th) して水平にまっすぐ引く蛍光ペン式。`startMarkerDrag` を分岐、`currentMarkerStyle`/`currentMarkerThickness` 新設、種類/太さを localStorage 永続化。overlay は従来 `line/marker` のまま (exporter 無改修、白黒除外も継承)。(2) `placeText` の `setPlacementMode("none")` 撤去でテキストモードを sticky 化 → 連続配置可。`viewer.isInlineEditing()` を新設し `handlePagePointerDown` 先頭で編集中は配置抑止 (編集確定クリックでの二重配置防止)。3 ファイル renderer 機能のため手動確認のみ、`npm test` 無改修で全 pass |
| **β145** | 06-03 | **β.144 以降の main 変更の配布リリース (新機能なし)** — ① Electron 38(EOL)→41.7.1 (better-sqlite3 12.10.0 で 41 prebuild、advisory 4 件解消) ② hardening (window.open/遷移拒否 + CSP、WSLg スモーク合格) ③ qpdf Linux 同梱 (公式 12.3.2、残務 #5 Linux 分) ④ CI を Node24 対応 actions SHA 固定 (checkout v6.0.3 / setup-node v6.4.0) ⑤ 別窓 ESM require 回帰修正 (af224ad)。Electron 41 Windows 配布は初だが CI test:m1 windows-latest pass 済 |
| **β146** | 06-04 | **ツールバー アイコン化 + 幅あふれの「»」動的退避** — 業務並走 (小さい/低解像度モニターで折り返し→不格好) 対応。(1) 22 ボタンを ◎ アイコンのみ / ○ アイコン+小ラベル / △ は » 収納に整理、16px モノクロ SVG (`.ti`)、全ボタンにホバー用途解説 `title`。(2) 項目を `flex:0 0 auto`+`nowrap` で縮めない設定にし、`ResizeObserver`+rAF で 表示倍率→検索→回転→… の順に実要素を `#overflow-dynamic` へ退避 (高さ一定・アイコン無ズレ)。menu-bar.js 非依存、検索 margin-left:auto 撤去。手動確認のみ、`node --check` pass / `npm test` 既存全 pass / headless 3 幅プレビュー確認済 |

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
| **合計** | **395/395 pass** | |

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
git log --oneline | head -20       # 最新は β140
npm test                           # 395/395 pass
npm run dev                        # electronmon (推奨、自動 reload。Wayland では reload が効かない時あり、その場合 dev を完全 kill + 再起動)
# または npm start                 # 単発起動
```

### 8.2 短期の優先順

#### 🔴 着手検討が必要なオープン項目 (β 卒業準備フェーズ、2026-05-25〜)

1. **β.131 を機能凍結ラインに、bug fix のみで業務並走** — 2026-05-29 時点で β.141 まで進行 (β.134 巨大 PDF / β.135 読込モーダル / β.136 墨消し黒背景 / β.138 印刷モーダル消失 / β.139 installer 関連付け sentinel + portable target 撤去 / β.140 フィードバック 9 件 + 明朝印刷密度 / β.141 明朝印刷密度 4 回打ち + テキスト options bar 表示漏れ修正)、いずれも構造修正。残り ~3 日間で重大バグが追加で出なければ stable へ
2. **qpdf Mac/Linux バンドル** (stable 残務 #5) — Win 同梱済。**2026-06-03 に Linux 完了** (公式 portable v12.3.2 を `vendor/qpdf/linux/` に同梱 + `findQpdfBinary` レイアウト差対応 + `package.json` mac/linux `extraResources` 設定)。**残 = Mac バイナリのみ** (`vendor/qpdf/mac/README.md` の手順で実機ビルド、stable タグ前に必須)
3. **クラッシュ診断ロガー一式の撤去** (stable 残務 #6、最後) — β.51-.138 で累積した診断系を撤去。**#2 (qpdf Mac/Linux) と現行 β.131-.140 修正の安定確認が完了してから着手** (= 1 週間並走後)。撤去対象に β.133 `open-pdf-stage` / `open-pdf-renderer-error` + β.137-138 `print-tick` も含める
4. **β.132 autoUpdater 修正の実機検証** — β.133→β.139 で実際の update を経験して順調 (ラベル「閉じる」/ 「次回起動時にもう一度」/ autoInstallOnAppQuit など機能している)。残課題: β.138 タグで GitHub Actions webhook 取りこぼし 1 件、`git push :tag` → 再 push で復旧。β.139 は webhook 取りこぼしなく 1 発で起動 (2m10s 完走)
5. **β.139 installer 修正の実機検証** — テスター環境で autoUpdater 経由 β.139 受け入れ後、(a) 次の β タグ受信時に「規定アプリがリセットされました」通知が出ないか、(b)「プログラムから開く」の K-PDF3 が 1 つだけ表示されるか (旧 ProgID `K-PDF3.pdf` 残骸の自動掃除確認)、(c) ユーザ手動で「PDF を Adobe で開く」に既定を戻した状態が以降の β 更新で維持されるか。**過去に portable 版を実行した PC は version 名付き Applications 残骸が customInstall で自動掃除できないため、必要なら PowerShell 手順 or アンインストール再インストールで個別掃除**
6. **β.131 Save As タブ表示 + paste aspect の実機検証** — Save As でリネーム保存 → タブラベルが新ファイル名に。クリップボード paste 画像 → 四隅ハンドルで縦横比を保ったまま変形
7. **β.134 巨大 PDF サイドカーの実機継続観察** — 200MB 超 PDF を反復 open / 切替 / 印刷 / 書き出しで問題ないか。orphan サイドカー / 空 .kpdf3 累積の掃除を stable 前に検討
8. **β.136 墨消し書き出しの実機検証** — 透過背景 PDF を墨消し → セキュア書き出し / 通常書き出し / 印刷で「枠の外側が黒くならず白のまま」を確認
9. **β.138 印刷送信中モーダルの実機継続観察** — 様々な印刷経路 (LAN / USB / FAX 以外) で `reason: doc-closed` 自動 close が安定して効くか、別ウィンドウフォーカス時に title 取得が崩れないか
10. **BIOS 起動失敗の別原因切り分け** — 2026-05-26 ユーザー報告のうち「BIOS から OS 起動に至らずフリーズ」は K-PDF3 が干渉できる経路が構造的に無いため、別原因 (Windows Update / ドライバ / hiberfil.sys 不整合 / CMOS 電池 / SSD 劣化) を疑うべき。β.139 後も継続するか観察 → 続けばハードウェア / OS 側の問題が確定的
11. **下敷き印刷の精度キャリブレーション** (β.80 で本体実装済) — 用紙送り誤差で X/Y 数 mm ズレる可能性。実機テストでズレ量を測定 → 必要なら (a) プリンタ別 X/Y オフセット (b) 倍率補正 (c) トレイ別 (d) 申請書別キャリブ を段階追加
12. **印刷後 temp PDF が K-PDF3 に再オープンされる副次現象** (β.95 ログで発見) — 実害は軽微だが余計動作。低優先
13. **β.96 Adobe 残留拡張 kill の実機検証 → 必要なら exe whitelist 調整** — 次回 Adobe 残留が再発したら crash.log の `pdfreader-cleanup` 内 `adobeRelatedAtCleanup` を共有してもらう (現状は `Acro|Adobe Acrobat|AdobeAcrobat|adcef|acrobat` パターンで拾い)

#### ✅ 直近で根治済 (旧オープン項目)

- ~~D&D「開かない」根因確定 → 修正~~ ✅ **β.90 で根治**。`createMainWindow()` 呼出を追加して zombie 自己復旧経路完成
- ~~FAX 経路の縮小事故~~ ✅ **β.92** (Adobe `/p` + 規定プリンタ一時設定)
- ~~FAX 宛先記憶再発~~ ✅ **β.93** (`applyCleanFaxDevmode` Adobe 経路移植)
- ~~タブ切替時のしおり混在 + ページジャンプ~~ ✅ **β.94** (`clearBookmarkDom` + scroll 三段復元)
- ~~印刷後 Adobe 残留~~ → β.95-96-116-118-126 で段階的に構造対策、通常印刷は実機で改善確認 (β.126)。FAX 経路は β.129 で**明示確認モーダル化により実質懸念解消** (memory `[[project-fax-busy-modal-explicit]]`)
- ~~Save As 後のタブ表示が新ファイル名にならない~~ ✅ **β.131** (`tab.activeSourcePdfPath` / `activeSourceName` の post-save 更新を追加)
- ~~クリップボード paste 画像が resize で歪む~~ ✅ **β.131** (`aspectLocked` プロパティ + 主軸方式 resize)
- ~~「後で」仮説の恒久対応~~ ✅ **β.132** (autoInstallOnAppQuit=true + CancellationToken + ラベル整理)
- ~~CI release 3-OS race~~ ✅ **β.132** で構造解消 (Mac/Linux に `needs: build-windows`)、初検証は stable v2.0.0 タグ時
- ~~巨大 PDF (200MB 超) で workspace 作成失敗~~ ✅ **β.134** (`source_pdf.external_path` カラム + サイドカーファイル化、712MB 謄写 PDF 実機 OK)
- ~~墨消し書き出しで透過 PDF 背景が黒く焼かれる~~ ✅ **β.136** (`compositePage` 白下地敷き + drawImage 合成、β.128 横展開漏れの補完)
- ~~印刷送信中モーダル auto-close 失敗 (Path B 沈黙)~~ ✅ **β.138** (`snapshotAdobeTitles()` 全プロセス scan + UUID marker、Pro DC 親子分離下で初めて真に機能)
- ~~PDF 規定アプリが autoUpdater 更新ごとに勝手にリセットされる + 「プログラムから開く」に K-PDF3 が 2 つ表示~~ ✅ **β.139** (portable target 撤去 + fileAssociations 削除 + customInstall macro で sentinel 付き 1 回限り登録 + 旧 ProgID 残骸の初回 install 時自動掃除)
- ~~PDF 規定アプリが autoUpdater 更新ごとに勝手にリセットされる~~ ✅ **β.139** (`fileAssociations` 削除 + customInstall macro で sentinel 付き 1 回限り登録)
- ~~「プログラムから開く」に K-PDF3 が 2 つ表示 (アイコンあり/なし)~~ ✅ **β.139** (portable target 撤去 + 旧 ProgID 残骸の初回 install 時自動掃除)
- ~~システムフォント時の半角数字独立軸が無効~~ ✅ **β.140** (`getTextFontStack` の system font 経路にも `opts.digitsHanko` 適用)
- ~~テキスト入力フォント選択がウィンドウ再起動でリセット~~ ✅ **β.140** (`appendSystemFontsToSelect` 完了後の二段復元)
- ~~配置済みテキスト枠の後付けフォント変更導線がない~~ ✅ **β.140** (`applyTextStyleToEditingOrSelected` + `populateTextToolbar`、form_field 同パターン)
- ~~空き領域右クリックで「貼り付け」が出ない~~ ✅ **β.140** (ctx-page に追加 + click 位置 anchor で paste)
- ~~ページ跨ぎコピペが不安定~~ ✅ **β.140** (`viewer._lastClickedPage` + `activePage` getter)
- ~~別名保存で元タブ消失 + dirty 警告消失~~ ✅ **β.140** (Save As は `newTabAndOpen` 経路、上書きは現タブ更新)
- ~~範囲書き出し / 単ページ書き出し後の表示先がわからない~~ ✅ **β.140** (post-save に `newTabAndOpen(savePath)` 追加)
- ~~MS 明朝が印刷でドット化して薄い~~ ✅ **β.140 → β.141 で追い込み** (`paintGlyphRun` hairline 経路で `fillText` を **4 回打ち**、AA α 0.5 → 0.9375、横線も完全に締まる。中心 α=1.0 不変なので glyph 太さ完全不変)
- ~~β.140 で配置済みテキスト枠を選択しても options bar (フォント/サイズ/色) が出ない~~ ✅ **β.141** (`refreshModeOptionsBar` に text 選択時の `which="text"` 分岐を追加、`form_field` 用 β.107 パターンを横展開)

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
- **β146 ツールバー アイコン化 + 動的退避**: (a) PDF を開いた状態でツールバーの各アイコンが意図どおりか・**ホバーで用途解説 (title) が出るか**、(b) **ウインドウ幅を狭めると、ボタンが折り返さず高さ一定のまま、表示倍率→検索→回転→… の順で右端「»」に入っていくか**、(c) 「»」を開いて中の **表示倍率の変更・検索入力・回転** が機能するか、(d) 幅を広げると退避項目がツールバーに戻るか、(e) **どの幅でもアイコンと枠がズレない**か (縮小由来のズレ解消確認)、(f) 白黒トグル ON でアイコンが白に反転して見えるか、(g) △ (下敷き印刷/ページ番号/別窓/別窓化) が「»」の静的ゾーンから従来どおり起動するか・メニューバー経由も無事か。**Wayland 実機でのウインドウリサイズ追従** (ResizeObserver) を特に確認したい

#### 🟠 繰越項目 (β 卒業前の検討候補)

- **既存マーカーの opacity 移行** — β15 で default 0.3 化、既存 0.5 はそのまま。一斉に淡くしたい場合 migration スクリプト
- **画像スタンプ vector 化** — 印刷時の bbox raster 制約 (β62) を vector で置き換える研究 (現状は受容)
- **IPAex 同梱** — 配布先での字形差異が問題化したら検討
- **dock-back 視覚フィードバック** — 現状 cross-window drop は無告知 dock。target tab-bar のハイライト追加余地
- **font-fallback の Mac 対応** (β.113 で Win + Linux のみ実装) — `pickFontFile` に macOS の OS native CJK font path (`/System/Library/Fonts/...`) を追加。Mac ビルド配布開始のタイミングで対応

#### v2.0.0 stable に向けた残作業 (β 卒業ロードマップ)

**機能実装** (✅ 完了済):
- ~~annotation read-only proxy~~ ✅ β.83
- ~~qpdf sanitize (Win 同梱)~~ ✅ β.84
- ~~真の墨消し~~ ✅ β.85 (redaction ページを 900dpi raster 化)
- ~~D&D「開かない」zombie 自己復旧~~ ✅ β.90
- ~~FAX 経路 100% native scale~~ ✅ β.92 (Adobe `/p` + 規定プリンタ一時設定)
- ~~FAX 宛先記憶解消の Adobe 経路移植~~ ✅ β.93
- ~~タブ切替しおり混在/ページジャンプ~~ ✅ β.94
- ~~印刷後 Adobe 自動 close~~ ✅ β.95-96-116-118-126 (通常印刷)、β.129 (FAX 明示確認モーダルで実質解消)
- ~~Save As 後のタブ表示~~ ✅ β.131
- ~~paste 画像 aspect 保持~~ ✅ β.131
- ~~「後で」仮説の恒久対応~~ ✅ β.132 (autoInstallOnAppQuit=true + CancellationToken + ラベル整理)
- ~~CI release 3-OS race~~ ✅ β.132 (Mac/Linux に `needs: build-windows`)
- ~~巨大 PDF を開けない (BLOB bind RangeError)~~ ✅ β.134 (サイドカーファイル + `external_path` カラム)
- ~~巨大 PDF 読込のフリーズ誤認~~ ✅ β.135 (300ms 遅延 busy modal)
- ~~墨消し書き出しの透過 PDF 黒背景~~ ✅ β.136 (`compositePage` 白下地敷き)
- ~~印刷送信中モーダル auto-close 失敗 (Path B 沈黙)~~ ✅ β.138 (全 Acrobat/AcroCEF process scan + UUID marker)
- ~~PDF 規定アプリの更新ごとの暴れ + 「2 つ表示」~~ ✅ β.139 (portable target 撤去 + customInstall sentinel + 旧 ProgID 残骸掃除)
- ~~2026-05-27 業務並走フィードバック 9 件 (テキスト UX 6 + 保存 UX 3)~~ ✅ β.140
- ~~MS 明朝の印刷ドット化~~ ✅ β.140 → β.141 で追い込み (`paintGlyphRun` hairline 経路で `fillText` を **4 回打ち**まで強化、AA α 0.9375 で横線のドット感も解消、glyph 太さ不変)
- ~~β.140 で配置済みテキスト枠を選択しても options bar が出ない (`refreshModeOptionsBar` の text 分岐漏れ)~~ ✅ β.141 (text 選択時の `which="text"` 分岐を追加、form_field β.107 パターンを横展開)
- ~~回転した元 PDF (/Rotate≠0) の下敷き/通常印刷で記入値オーバーレイが天地さかさま (180°) / 90・270 ズレ~~ ✅ **β.142** (`assembleHybridPdf` を `effRot = sourceRotation + userRotation` ベースに再配線 + CW でソースをベイクする `rotate-place.js` 新設、embedPdf 非ベイク + pdf-lib CCW vs PDF/mupdf CW を是正、全 4 回転 mupdf 回帰テスト)
- ~~吹き出しを配置後にフォント/サイズ/色/太字を変更できない~~ ✅ **β.143** (text の β.140/141 パターンを callout に横展開、選択で text オプションバー表示 + 一括反映)
- ~~吹き出しが入力画面では枠内に収まるのにサムネ/印刷で本文が枠外にはみ出す~~ ✅ **β.143** (採寸の折返し幅下限 `max(20,…)` を撤去し exporter と一致 + `measureCalloutMinWidth` で枠を本文に合わせ自動拡大、余白ズーム連動化)

**残作業** (stable タグ前の TODO):
- 🟡 **qpdf Mac/Linux バンドル** (stable 残務 #5) — **Linux 完了 (2026-06-03)**: 公式 portable v12.3.2 を `vendor/qpdf/linux/` に同梱 (SHA256 検証・実機起動確認)、`findQpdfBinary` を win=flat / mac・linux=bin+lib 対応、`package.json` mac/linux `extraResources` 設定。**残 = 🔴 Mac バイナリ** (公式 mac プリビルド無し → **リポ直下 `QPDF-MAC-TODO.md` の詳細手順** [brew+dylibbundler / `otool -L` 自己完結検証 / universal2 / Gatekeeper / 配置 git chmod / チェックリスト] で実機ビルド、**stable タグ前に必須**) + ⚠️ stable ビルド時に extraResources コピー/AppImage・dmg 実行確認
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
- ~~**qpdf の同梱方法** (M6)~~ ✅ β.84 で Windows 同梱 (`vendor/qpdf/win/` + `--remove-info --remove-metadata`)。Mac/Linux は stable v2.0.0 で追加予定
- ~~**annotation read-only proxy** (M6)~~ ✅ β.83 で実装 (種別ごとアイコン分岐 + native title tooltip)
- **userData の workspace を別 PC へ持ち運ぶ UI** (M6): 現状は手動コピー、export package (zip) で集約する案
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
