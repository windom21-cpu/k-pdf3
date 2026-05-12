# K-PDF3 開発引き継ぎ書

最終更新: 2026-05-12（β35 配布中 / β33 撤回 / 開発リポ Public 化済 / CI 案 B-2 適用済） / 現在のバージョン: **v2.0.0-beta.35（β34 で E1 太字独立軸 + E2 外部 PDF viewer vector render を投入、β35 で F1 画質改善 image-rendering + F2 synthetic 1.5x oversample を追加）**

このドキュメントは、K-PDF3 の開発を引き継ぐ次の AI アシスタント（または別環境の自分）が会話履歴なしで作業継続できるよう書かれています。**着手前に §0 → §1 → §2 → §3 → §6 → §8 → §17 の順で必ず読んでください**。

---

## ⚠️ セッション開始時の必須同期手順（2026-05-12 force push 後）

このリポは 2026-05-12 に **HANDOVER.md の git 履歴抹消 + 開発リポ Private→Public 化** のため `git filter-branch` で全 commit/tag を rewrite し、**force push** されています。同日以前のクローンを持つ環境（Ubuntu 本体機など）で **コードを変更する前に必ず** 実行:

```bash
cd ~/デスクトップ/k-pdf3   # 適宜パス調整
git fetch --all --tags --force
git reset --hard origin/main
git status                  # "nothing to commit, working tree clean" と出れば OK
```

これを実行せずに作業すると:
- 変更 push が拒否される（fast-forward でないため）
- もし force push したら、Public 化された clean history が個人メアド入りの旧 history に上書きされる**大事故**

**「引き継ぎを読むだけ」なら read-only で安全**。書く前に必ず同期。

理由詳細: §7.7「2026-05-12 後半」/ §12.1 参照。

---

> **§6.4 / §8 / §17 を β12-β30 配布で更新**。v2.0.0-beta.11 → β12 → ... → β30（2026-05-12 内に 19 連続、後半は試し置き UX の連続対応）。
> - **β12**: β11 残バグ「回転後サイドバーサムネ白紙化」を修正。原因は `rotatePageBy` 冒頭の `invalidateSidebarThumb` が in-flight な renderThumb を OLD `viewer._pages` snapshot で kick し、`clearThumbs()` 後に thumbCache へ stale canvas を書き戻していた race。冒頭 invalidate を削除 + renderThumb 末尾に `itemEl.isConnected` ガードを追加 (detached なら結果を捨てる)。
> - **β13**: 2 件:
>   - スタンプパレットポップアップが drag できない不具合を修正 (`-webkit-app-region: drag` がグローバル `.title-bar` に当たって pointerdown を奪っていた → palette popup のみ `no-drag` 上書き)。
>   - 画像スタンプ register dialog から **PDF にプレ押印** (§17.5)。半透明ゴーストをページにピン留め → 幅/高さ/色/枠変更が live 反映 → 登録前にサイズ感を実機検証可。
> - **β14**: 4K モニタの DPI 対応 2 件:
>   - プリンタプロパティダイアログ (`rundll32 printui.dll`) が legacy DPI コンテキストで bitmap-stretch されていた → `DocumentPropertiesW` API を **koffi 経由で直接コール** + `SetThreadDpiAwarenessContext(SYSTEM_AWARE)` で Adobe 同等のシャープさ。koffi 失敗時は rundll32 に fallback (印刷経路は無修正)。
>   - NSIS installer 本体に `ManifestDPIAware/PerMonitorV2` を inject (build/installer.nsh + customHeader macro)。oneClick の進捗ダイアログのぼやけ解消。
> - **β15**: 大量の UI/UX 改善 + OS 統合:
>   - **吹き出し**: 矢印先端の **ドラッグハンドル** (常時表示、テキスト確定後も位置調整可)、矢印太さ 1.5→1px (枠線と整合)、編集中の **横拡張** (text overlay と同じ max-content + 紙端)、リサイズ高さを wrappedH 固定 (空白下マージン解消)、編集中 × ボタン hide の **子孫セレクタ化** (contentEditable の DOM wrap でも安定)、commit 時のテキスト抽出を subtree 全走査化。
>   - **日付スタンプ字間調整**: baseWidth 固定 90 → `measureText(rendered) + 6pt`。プレビュー位置と一致。
>   - **マーカー**: opacity 0.5→0.3 (下の文字が読みやすく)。新規のみ反映、既存は再配置で更新。
>   - **PDF 関連付け**: `build.fileAssociations` で `.pdf` を Open with 候補に登録 (Win/Mac/Linux)。`requestSingleInstanceLock` + `second-instance` / `open-file` AppleEvent / argv パーサで OS 経由の PDF を `openPdfSmart` に流す (既存タブが空ならそこに、PDF 読込み済みなら新タブ)。
> - **β16**: テスター指摘「β15 入れても毎回 β6 に戻る + 更新枠が出続ける」を修正。原因は **β6 (pre-β7、`perMachine: true` 時代) の per-machine 残存**: `C:\Program Files\K-PDF3\` の β6 と `%LocalAppData%\Programs\k-pdf3\` の β15+ が併存し、全ユーザー側スタートメニュー shortcut + `.pdf` Open with が β6 を指していて毎回 β6 起動 → β15 が per-user に副作用なくインストールされ続けるループ。β16 では `build/installer.nsh` の **`customInit` マクロで `$PROGRAMFILES64\K-PDF3\Uninstall K-PDF3.exe` を検出 → ExecShellWait で `/allusers /S` 経由で UAC 昇格 silent uninstall** を inject (新規 installer 実行時に自動掃除)。ユーザー側の実機は手動で uninstall 済 (silent uninstall via WSL → cmd.exe → PowerShell `Start-Process -Verb RunAs`)。
> - **β17**: 「印刷プロパティで枚数を変えても次の印刷で 1 部に戻る」を修正。`src/main/printer-properties-win.js` の `DocumentPropertiesW` 呼び出しが `pDevModeOutput=null, fMode=DM_IN_PROMPT(4)` だけで、UI 変更後の DEVMODE を破棄していた。size 取得 → 出力バッファ確保 → `DM_IN_PROMPT|DM_OUT_BUFFER(6)` の 2 段呼び出しに変更、IDOK 時に `dmFields` / `dmCopies`(offset 86) / `dmOrientation`(offset 76) を読み取り `{ok, cancelled, copies, landscape}` を返却。レンダラの「プロパティ」ハンドラが `printCopiesInput.value` と `printOrient*.checked` を更新。
> - **β18**: 「上書き保存」確認ダイアログのリフレーミング。ユーザー指摘「画像化されることが分かりにくい / 編集可能保存の動線が見えない」。文言だけ変更（挙動は無変更）：タイトル「保存方法を選んでください」、ボタン「確定として PDF を上書き」/「下書きとして保存（あとで編集できる）」、ステータス「下書きとして保存しました（元 PDF は変更されていません）」。法律実務馴染みの 下書き／確定 フレームに統一。
> - **β19**: しおりパネル UX：右クリックメニュー（名前を変更／削除）+ +/-/←/→ ツールバーの `position: sticky; top: 0`。bookmark pane の `padding-top: 0` で初回スクロール時の 4px ジャンプを防止。新規 `#ctx-bookmark`、`showBookmarkContextMenu` 等を既存の ctxThumb パターンで実装。
> - **β20**: 印刷ダイアログのページ範囲 preselect（分割画面選択を「1-3, 5, 8-10」形式で seed）。`compressPageList()` ヘルパー追加、`showPrintDialog` に `preselected` 第4引数。
> - **β21**: 分割画面の `.split-thumb` ダブルクリックで `setSplitMode(false)` + `viewer.scrollToPage(pageNo)`（分割を閉じてメインビューワーをそのページに）。
> - **β22**: ステータスバーのページ表示を `◀ [n] / total ▶` のインタラクティブ cluster 化（既存の `actionPagePrev/Next/Goto` + `viewer.registry.posOfPageNo/pageNoAtPos` を再利用）。Enter でジャンプ、Esc で破棄、blur で resync。
> - **β23-β24**: β22 で出た「分割画面の preselect が反映されない」報告に対応する 2 連続修正。
>   - β23: `isSplitMode` ゲート撤廃 + サイドバー 2 ページ以上 fallback + DevTools `[print] preselect: ...` ログ + ステータスバー確認メッセージ。
>   - β24: ユーザー提供の DevTools ログから真因判明：選択ページに synthetic 挿入ページ（負の `pageNo`）が含まれて `compressPageList` の `n > 0` フィルタで全部落ちていた。**印刷ダイアログ全体の「視覚位置 vs pageNo」の構造的混同を解消**：`showPrintDialog` で `pageNoToPos` map を作って preselect の pageNo を視覚位置に変換、`recomputeVisiblePages` の custom-range path で逆変換（位置→pageNo）。これで挿入ページや並び替え済 PDF でも印刷が正しく動く。
> - **β25**: テキスト overlay の 2 件:
>   - **C1 折り返し regression**: 確定後に「一行で紙の外まで」伸びるのを修正。`handleTextEditCommit` で page width / overlay.x / userRotation 考慮の canonical maxW を算出 → `measureTextOverlaySize(..., maxW)` で `w = min(maxW, max(currentW, targetW))` に cap。
>   - **C2 印刷で黒が薄い**: `drawOverlay` の text path で `fillText` の前に同色 `strokeText` を `lineWidth = fontSize * 0.03` で重ねて AA fringe を黒塗り。文字の形は保ったまま濃く。
> - **β26**: 2 件:
>   - **C4 プリンタ記憶**: `localStorage['kpdf3.lastPrinter']` で保存・復元。なければ OS default にフォールバック。
>   - **C5 ショートカットフォルダ対応**: main の `kpdf3:list-directory` で `.lnk` を `shell.readShortcutLink()` で解決、ターゲットが dir なら `isDir=true` + `targetPath` を返却。renderer のクリック handler で `targetPath` 優先。
> - **β27**: **C6 ページ右クリックでモード切替**: `#ctx-page` メニュー（テキスト/スタンプ/マーカー/吹き出し/墨消し/解除）、現在のモードは `.checked`（既存の ✓ スタイル）でハイライト。同じモード再クリックで `none` に戻る。`handlePagePointerDown` に `evt.button !== 0` ガード追加で右クリックでの誤配置を防止。
> - **β28**: **C7 スタンプ UX**:
>   - スタンプパレットの auto-select-first-stamp ロジックを削除。初期状態は本当に「未選択」（パレットは highlight なし、ゴースト非表示、未選択でクリックすると「スタンプを選択してください」のステータス）。既存の localStorage 選択は尊重、無効化された時は localStorage key も削除。
>   - 試し置き中にスタンプマネージャーダイアログが裏で居座って PDF クリックをブロックする問題を修正。`enterStampTrialPlacement` で `register/manager` 両ダイアログを snapshot して両方 hide、`cancelStampTrialPlacement` で manager → register の順で復元（register が top に来る）。
> - **β29**: β28 でも残った試し置き周りのテスター指摘 4 件まとめ（C8〜C11）:
>   - **C8**: 画像スタンプの色デフォルトが `bg-transparent` に戻らなかった regression を修正（HTML は `selected` だったが JS で `""` 上書きされていた）。
>   - **C9**: 試し置きの cursor 追従中に stamp placement mode の `stampGhostEl` も同時に追従して「違うスタンプのプレビューも付いてきている」と見えていた。`onViewerMouseMoveForStampGhost` で `_stampTrialPlacing` 時は bail + `enterStampTrialPlacement` 入口で `stampGhostEl.hidden = true`。
>   - **C10**: β28 では localStorage 値が残っている限り「未選択」にならなかった。`setPlacementMode` で `placementMode === "stamp" && mode !== "stamp"` の遷移時に `setActiveStampPreset(null)` で localStorage ごとクリア（モード再エントリで未選択スタート）。
>   - **C11**: 試し置き canvas を dialog で w 変更したとき、左上から右下に伸びていた。`updateStampTrialAppearance` で旧中心点を保ってリサイズするよう変更。
> - **β30**: **C12 試し置き trial の直接操作**：
>   - **角ハンドル 4 つで drag-resize**（アスペクト比固定、対角コーナーを anchor）+ **wrap 中央 drag で移動**。試し置きを Adobe 等の標準UXに揃えた。
>   - 試し置き pin 後、ダイアログは新 `.has-trial` CSS class で **右上隅 + 透明バックドロップ + pointer-events: none** に退避。手動 W/H 入力もマウスドラッグも両対応で、ダイアログが trial を覆わない。
>   - `applyTrialGeometry()` で位置・サイズ・canvas 再描画・dialog input 同期を集約。dialog 入力経路 (`updateStampTrialAppearance`) も同じ helper を経由。
>   - **manager snapshot ロジックを `openStampRegisterImage` 入口に一度きりに整理**（β28 は `enterStampTrialPlacement` 毎に取り直していて、`試し置きをやり直す` で snapshot が壊れていた）。`closeStampRegisterImage` で消費。
>   - 注意：「試し置きにリサイズハンドル」は実は **β13 以降一度も実装されていなかった機能**（git 履歴で確認済み）。ユーザーは Office/Adobe 等の標準UXとの混同で「前にできていた」と認識していた。β30 で初実装。
> - **β31 (D1〜D4 改善)**:
>   - **D1 印刷テキスト解像感**: text overlay / callout / stamp / distribute-3 すべての文字を共通 `paintGlyphRun` ヘルパー化、`strokeText`+`fillText` の overstroke で AA halo を埋める。`lineWidth = fontSize * 0.06`（β25 の 0.03 から強化）。`EXPORT_ZOOM = 600 / 72 → 900 / 72` に引き上げ（PNG 出力解像度 600dpi→900dpi、A4 で 7440×10530px と Canvas 上限内）。
>   - **D2 外部 PDF 挿入の vector 維持**: schema に `inserted_source_pdfs` テーブル新設（SHA-256 dedup）+ `inserted_pages.source_pdf_id` `source_page_index` 列追加（idempotent migration）。書き出し/印刷時に image_blob ではなく **元 PDF を copyPages して vector のまま貼る**（exporter の新 strategy `"external"`、main の assembleHybridPdf に枝追加）。viewer 用 image_blob は 144dpi → 300dpi に引き上げて画面プレビューもシャープに。
>   - **D3 印刷シャープネス**: synthetic 白紙+テキストページ (image なし) を full strategy で JPEG q=0.95 → **PNG に変更**。DCT 圧縮起因のテキストエッジぼやけを解消。
>   - **D4 数字 hanko フォント**: テキスト fontId に `numeric` (CrashNumberingSerif + MS明朝) を追加。
> - **β32 (D4 再設計)**: β31 の `numeric` は CrashNumberingSerif cmap が 0-9 のほか `. , - / + = E Q R T W Y` 等にもグリフを持つため混在テキストで意図しない hanko 字形になる + ゴシック+数字 hanko が表現不能 → **数字 hanko を独立軸チェックボックスに再設計**:
>   - `CrashNumberingDigits` @font-face を新設（同じ TTF を unicode-range `U+0030-0039` で 0-9 限定にする、stamp 用の元 `CrashNumberingSerif` はフル cmap で残置）
>   - toolbar に「数字 hanko 風」チェックボックス追加、主フォント select とは独立
>   - `getTextFontStack(fontId, {digitsHanko})` で stack 先頭に `CrashNumberingDigits` を prepend、半角数字 0-9 だけ hanko、それ以外は主フォント
>   - β31 互換: `fontId='numeric'` は `mincho + digitsHanko=true` に自動解決
> - **β31/β32 配布直後 → 撤回騒動 (2026-05-12 後半)**:
>   - ユーザー Windows 機で β31/β32 が起動直後に落ちる報告 → コード上に明確な起因見つからず → **β33 = β30 baseline へ緊急ロールバック** を一度配布
>   - しかし「**β30 を再 install してから β32 にアップしたら問題なく動く**」とユーザー検証で判明。前回のクラッシュは autoUpdater の差分 install 由来の一時不整合と推定（コード自体は無罪）
>   - **β33 撤回**: 開発リポの v2.0.0-beta.33 タグを削除 + main 上の β33 ロールバックを `git revert` で打ち消し（HEAD = β32 内容 + HANDOVER 履歴クリーン化）。k-pdf3-releases の β33 release はユーザーが GitHub UI から手動削除する手筈
>   - **連続リリースで GitHub Actions Free 枠 (Private リポ 2000 分/月) を使い切ったため**、開発リポを **Private → Public 化**。Public 化前に HANDOVER.md の個人メアド記載を消すため `git filter-branch --index-filter 'git rm --cached --ignore-unmatch HANDOVER.md'` で全 commit/tag から HANDOVER.md を抹消し、メアド削除済みの最新版を新規 1 commit で再追加 → force push
> - **β34 (E1〜E2)**:
>   - **E1 太字を独立軸チェックボックス化**: β31/β32 で text/callout に固定で入れた overstroke (0.06) が「太字すぎる」と指摘 → toolbar に「太字」chk を追加 (デフォルト OFF、localStorage 永続)。**viewer は OFF=素の細い書体 / ON=CSS `-webkit-text-stroke` 0.06**。**exporter は OFF/ON に関係なく overstroke 常時** (OFF=`lineWidth=fontSize*0.03` で β25 ベース、ON=`*0.06`) で **印刷時の AA halo は常に埋める** → 画面では細く・印刷では薄くならないの両立。stamp/日付スタンプ/distribute-3 は印影なので opts なしの default bold 維持。
>   - **E2 外部 PDF 挿入の viewer も vector render**: β31 で書き出し/印刷は元 PDF vector copy 化したが viewer は 300dpi image_blob のままで「Adobe と並べて一見してぼやけて見える」と指摘 → 新 IPC `kpdf3:render-inserted-source-page` を追加 (main 側で `inserted_source_pdfs.pdf_blob` から mupdf doc を開いて zoom 倍率でラスタライズ、`sourcePdfId` をキーにキャッシュ、`activateTab` / `before-quit` で destroy)。viewer の `renderSyntheticPagePixels` で `row.syntheticSourcePdfId != null` なら vector path 優先、失敗時のみ legacy image_blob にフォールバック。viewer は `this._zoom * computeOversample()` を `renderZoom` として渡すため HiDPI 環境でもネイティブ解像度でラスタライズ。
>   - **CI 案 B-2 適用**: 連続リリースで matrix race が再発しかけたのと β テスターが Windows 単独の現状を踏まえ、`release.yml` を分割。**β タグ (`v*-beta.*`) は Windows のみ build、stable タグ (`v[0-9]+.[0-9]+.[0-9]+`、β なし) で初めて 3 OS 全部が動く**。matrix を単一 strategy から 3 つの独立 job (build-windows / build-macos / build-linux) に分割、Mac/Linux に `if: "!contains(github.ref_name, '-beta')"` を付与。Mac/Linux テスター不在のうちは β iteration を高速化 (10 分→5 分)、stable 時のみ全 OS。
> - **β35 (F1〜F2)**: 外部 PDF 挿入で「だいぶ良くなったがまだ若干輪郭がはっきりしない」報告 → 2 段で追加対応:
>   - **F1 image-rendering**: viewer の page canvas (`.viewer-page canvas`, `#viewer-container canvas`) に CSS `image-rendering: -webkit-optimize-contrast` を適用。canvas を CSS で縮小表示する時の bilinear smoothing から Chromium の sharper resampling に切替え、輪郭の眠さを軽減。既存ページにも自然な改善が乗る。
>   - **F2 synthetic 1.5x oversample**: `_ensureRendered` で `row.syntheticSourcePdfId != null` のとき render zoom を `renderZoom * 1.5` にバンプ。mupdf が 1.5 倍の解像度でラスタライズ → CSS 縮小後でも詳細が残る。純粋な白紙/テキスト synthetic は zoom そのまま (renderer canvas で十分鮮明)。
> - **β34/β35 配布フロー**: β34 は publish 時点で 3 OS 揃った状態 (case B-2 適用 commit が β34 push よりわずかに後だった)、β35 は B-2 で **build-windows のみ実行 / build-linux + build-macos は skipped** で正常動作確認。`latest.yml` 経由で autoUpdater は問題なく動く。
> 
> **「後で」仮説 (未確証だが有力)**: ユーザー検証で「β30→β31 で autoUpdater が出した『ダウンロードしますか?』ダイアログで一度『後で』を選んでから別タイミングで再アップした」シナリオを思い出した → これが β31/β32 起動クラッシュの真因の可能性大。「後で」選択時に部分ダウンロード / blockmap キャッシュが中間状態で残り、後続バージョンの取得時に整合性が壊れる仮説。再現性検証は β34 で「最初から『はい』」経路を取って成功 (差分アップで起動)、`%LocalAppData%\K-PDF3-updater\` あたりに残骸ファイルがないかは未確認。**β35 以降での対応案**: (a) autoUpdater UX から「後で」ボタンを撤去、「今ダウンロード／キャンセル (次回起動時に再表示)」のみにする、(b) ダイアログキャンセル時に既存差分ファイルをクリーンアップ。
> 
> **β14 残課題**: 4K 機の実機検証はユーザーが β14/β15 を試用して結果待ち。改善が確認できなければ追加調整。
> 
> **β35 時点での未解決テスター要望 / 残課題**:
> - **C3 Adobe で押したスタンプ (annotation) が viewer で見えない（印刷では出る）**: §15.3 の annotation read-only proxy 該当、新セッション規模。実害は viewer 表示のみで印刷物には出る。
> - **「後で」仮説の検証と恒久対応**: 上記の autoUpdater 経路改修。再現できれば β36+ で対応。
> - **β35 の画質確認**: F1+F2 で外部 PDF 挿入の輪郭がさらにシャープになったかユーザー実機テスト待ち。不足なら次の打ち手 (mupdf AA 設定 / oversample をさらに上げる / 別アプローチ) を検討。
> - **CI release matrix race の根治** (§6.4 末尾参照): β12/β33 で観測した macOS `tag_name already_exists` 422。**β タグでは案 B-2 で構造的に解消 (Win 単独)**、stable タグでの再発リスクは残る。stable リリース時に手動で 1 OS ずつシーケンシャル trigger するか、`needs:` で sequence する手も。
> 
> ⚠️ **次セッション着手時は §8 を読む前にまず §6.4 (β テストフロー) を確認すること**。今は機能追加よりもテスト→バグ修正→β.N 連番でリリースするフェーズ。
> 加えて、過去 4 セッション（2026-05-09 / 05-10 / 05-11 / 05-12）でリライトが並列に積み重なっているので、§7.5 以前を読むときは §7.7 のサマリ表を先に見て新旧を見分けること。
> 
> **HANDOVER 更新ルール**: HANDOVER.md は **ユーザーが明示的に依頼した時だけ** 書き換える。β タグを切る毎に勝手に refresh しない（2026-05-12 にユーザーから明示指摘）。

---

## 0. このドキュメントの読み方

### まず必ず読む（5分）

1. **§1 プロジェクトの全体像** — 何を作っているか、何を作らないか
2. **§2 設計思想と禁止事項** — 絶対に守る制約
3. **§3 ユーザーとの協働方針** — どう振る舞うか
4. **§6 開発ロードマップ** — どこまで来てどこへ向かうか
5. **§8 次にやること** — 次セッションでスムーズに着手するための優先順
6. **§17 ユーザー要望タスクリスト（2026-05-10 セッション分）** — ユーザーが書き出した中期タスク

### 必要に応じて参照する

- §4: アーキテクチャ詳細（実装時の依存ルール）
- §5: 技術スタック
- §7: 実装済み機能（M1 〜 M5 大半）
- §9: データモデル / SQLite schema
- §10: ファイル構成
- §11: 環境セットアップ・動作確認
- §13: K-PDF2 からの継承と破棄
- §14: AI セッション交代時の注意
- §15: 既知の懸念・残課題
- §16: 引き継ぎ運用
- §17: **ユーザー要望タスクリスト（2026-05-10）** — 中期積み残しの具体リスト

### 別ファイルで読む

- `docs/architecture.md` — レイヤ図と依存ルール
- `docs/glossary.md` — 用語定義
- `docs/adr/0001..0016.md` — 重要な設計判断の根拠（0004: Electron ピン留め / 0005: Electron 内テスト runner / 0006: PDF-first UX + 98.css / 0007: workspace を userData に集中・fingerprint 索引 / 0008: 容量最適化と byte-copy 別名保存 / 0009: ページ削除 / 0010: ページ挿入 / 0011: Save As workspace 切替 / 0012: HiDPI render quality / 0013: 自前タイトルバー + ファイルダイアログ / 0014: 編集可能なしおり + /Outlines write-back / 0015: タブ multi-workspace 設計編 / 0016: スタンプテンプレート MVP — 続編 ADR-0019 で吸収予定）
- `schema/schema.sql` — SQLite テーブル定義
- `ROADMAP.md` — マイルストーン一覧

---

## 1. プロジェクトの全体像（1分で把握）

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
│  - フォント: Kosugi 同梱                                    │
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
│  - Print pipeline（export → temp PDF → OS print）           │
└─────────────────────────────────────────────────────────────┘
                  ↓ persistence / IO
┌─────────────────────────────────────────────────────────────┐
│  Persistence Layer                                          │
│  - SQLite（better-sqlite3、WAL モード）                     │
│  - Asset library（アプリ全体で 1 つ）                       │
│  - File I/O（Electron main process）                        │
└─────────────────────────────────────────────────────────────┘
                  ↓ adapters
┌─────────────────────────────────────────────────────────────┐
│  Backend Adapters (isolated)                                │
│  - mupdf.js（WASM、AGPL）— layout / page render / export    │
│  - pdf-lib（utility ops）— metadata / outline 等            │
│  - qpdf（Apache 2.0）— sanitize / xref rebuild              │
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
├── main/         Electron メインプロセス（IPC、native dialog、file I/O）
├── renderer/     Electron レンダラ（UI、viewer、editor）
├── domain/       純 JS / 純粋 logic（store / coordinate / history / overlay model）
├── backend/      mupdf wrapper / qpdf wrapper / pdf-lib wrapper
└── shared/       ipc 型定義 / 共通型（M2 以降で追加）
```

依存方向：
- `renderer/` → `domain/` →（`backend/` を直接呼ばない、render layer 経由）
- `main/` → `domain/`（file I/O、persistence の orchestration）
- `backend/` → 外部 native lib のみ

### 4.4 主要モジュール

| module | 役割 | 状態 |
|---|---|---|
| `domain/coord.js` | canonical ↔ PDF native の transform | ✅ M1 完了 |
| `domain/workspace.js` | workspace の高レベル API | ✅ M1 完了 |
| `domain/project-store.js` | overlay collection + R*Tree インデックス | M2 |
| `domain/history.js` | command pattern undo/redo | M3 |
| `domain/page-registry.js` | virtualization 用 page metrics cache | M2 |
| `backend/mupdf-layout.js` | mupdf.js Font + Text の薄い wrapper | ✅ M1 完了 |
| `backend/mupdf-pdf-info.js` | PDF メタ情報抽出 | ✅ M1 完了 |
| `backend/sqlite-store.js` | better-sqlite3 wrapper、schema migration | ✅ M1 完了 |
| `backend/mupdf-render.js` | page → Pixmap → ImageData 変換 | M2 |
| `backend/qpdf-sanitize.js` | secure export pipeline | M4 |
| `renderer/viewer.js` | Canvas 描画 + DOM editor overlay | M2 |
| `renderer/editor.js` | overlay editing UI | M3 |
| `main/file-io.js` | `.kpdf3` open/save、native dialog | M1 部分実装、本格化は M3 |

---

## 5. 技術スタック

### 5.1 ランタイム

| 項目 | バージョン | 役割 |
|---|---|---|
| Electron | ^38.8.6 | デスクトップアプリ化（ADR-0004 により一時固定） |
| Node.js | 22.22.2 | JavaScript 実行環境 |
| nvm | 0.40.4 | Node バージョン管理 |
| electron-builder | 26.8.1 | クロスビルド配布 |

### 5.2 主要ライブラリ

| 項目 | バージョン | ライセンス | 役割 |
|---|---|---|---|
| **mupdf** | ^1.27.0 | **AGPL-3.0** | layout engine / page render / export |
| **better-sqlite3** | ^12.0.0 | MIT | workspace persistence (.kpdf3) |
| pdf-lib | （M2 以降）| MIT | utility ops（metadata 等） |
| qpdf | （M4 で同梱）| Apache 2.0 | secure export sanitize |

### 5.3 フォント（同梱想定）

| 項目 | ライセンス | 配置 | 役割 |
|---|---|---|---|
| Kosugi-Regular | Apache 2.0 | `fonts/` 同梱予定 | UI フォント（98.css と整合するレトロ感） |
| IPAex 明朝 | IPA フォントライセンス | `fonts/` 同梱予定（M4） | PDF 出力時の日本語 fallback フォント |
| CrashNumberingSerif/Gothic | PSY/OPS Freeware | `fonts/` 同梱予定 | 日付スタンプの数字記号用 |

### 5.4 ライセンス注意点

- **mupdf.js が AGPL** → 個人・スタッフ内利用なら問題なし。**外部公開する場合は K-PDF3 自体を OSS 化する必要**。現時点では Private リポジトリで運用。
- mupdf.js は `backend/` に閉じ込めて、将来の backend swap を可能にする設計。
- qpdf は Apache 2.0 で問題なし。

---

## 6. 開発ロードマップ

### 6.1 全体像

```
M1 Foundation → M2 Core → M3 Editing UI → M4 Export → M5 Feature Migration → M6 Polish
   (Week 1-2)   (Week 3-4)  (Week 5-6)     (Week 7-8)   (Week 9-10)             (Week 11+)
   ✅ DONE      ✅ DONE     ✅ DONE        ✅ DONE      🚧 大半完了              ⏳ 未着手
```

実装速度は想定より速く、2026-05-09 の 1 セッション内で M1 → M5 大半まで進んだ。残り：M5 のタブと CI、それから M6。

着手日：2026-05-09。

### 6.2 マイルストーン進行ルール

- 各 M の **Exit criteria を満たすまで次へ進まない**
- 着手前に該当する ADR / glossary 項目を整備
- M5 完了で **v2.0.0-beta.1 release**（業務移行可能）
- M6 完了で **v2.0.0 stable release**
- ユーザー確認は M2 / M3 / M4 / M5 完了時に実施

### 6.3 各マイルストーン

詳細は `ROADMAP.md` を参照。

| M | 状態 | 主な成果 | Exit criteria |
|---|---|---|---|
| ✅ **M1** | tag: なし | architecture / SQLite / coordinate / mupdf wrapper | `.kpdf3` 作成 → PDF 取込 → 再オープンで page metrics 一致 |
| ✅ **M2** | tag: `v2.0.0-alpha.M2` | object model / virtualization / page render / Win95 chrome (98.css) / PDF-first UX | 400p PDF を滑らかに virtualization スクロール |
| ✅ **M3** | tag: `v2.0.0-alpha.M3` | text/stamp/redaction 編集 / IME / Undo/Redo / Ctrl+S / close 警告 / drag・resize / right-click 削除 / zoom / page navigation | 編集 → 保存 → 再開で正確復元 |
| ✅ **M4** | tag: `v2.0.0-alpha.M4` | export pipeline (rasterized) / Smart Save As (byte-copy) / exports 監査ログ / userData 集中保管 | flatten PDF を Adobe で確認 + revision_id 監査トレイル |
| 🚧 **M5** | tag: **`v2.0.0-beta.11` 配布中** (β1 〜 β11) | **主要機能 + タブ + 並び替え + ページポップアップ + β2-β8 修正パス着地** + **自動アップデート** + **複数選択 + 整列** + **回転ページ vector 維持**（墨消し / ページ移動 / 印刷 / しおり / 分割 / 範囲 / 最近のファイル / 検索 Ctrl+F / 印刷プレビュー / ページ削除 / ページ挿入 / Save As workspace 切替 / タブ・複数 PDF 並列編集 (ADR-0015) / サムネ D&D 並び替え (display_order) / **ページポップアップ (§17.4 prelim)** / β3 で **スタンプ全 PDF 共通化** + タブバーをサイドバー外へ + 11 件の β2 バグ修正 / **β4 で SumatraPDF 同梱印刷 + ハイブリッド PDF 組立 + 元 PDF 上書き + テキスト編集拡張 + 14 件の β3 バグ修正** / **β5 で electron-updater 組込み + 公開リリース feed** / **β6 で テキスト枠複数選択 + 整列 + CompositeCommand (§17.16 #13/#14)** / **β7 で NSIS oneClick silent installer** / **β8 で ハイブリッド PDF を回転ページにも対応 (§15.3 末尾)**）。**残 exit 条件**: β テストでの安定確認 + タブの完全な分離・別ウインドウ化 (§17.10 本実装) + CI Mac/Win 署名 (任意) | K-PDF2 主要機能 + α が新アーキで動く + 業務移行可能 |
| 🚧 **M6 (大半完了)** | tag: 未 (β リリースに同梱) | UI ポリッシュ + 機能投入済（自前タイトルバー / カスタムファイルダイアログ / 印刷プレビュー / hover ヒント / 砂時計 / D&D / サイドバースプリッター / 解像度切替 / MS UI Gothic + AA off / pixel-grid CSS / 回転 + 紙メタファ overlay 追従 / マーカー / 墨消し白 / テキストフォント・サイズ UI / 吹き出し / スタンプ管理 / 画像スタンプ + 回転 / 編集可能しおり / しおり階層 + drag-reorder / 画像スタンプ色 tint / フォント設定ダイアログ（全角/半角別、ADR-0019 後半）/ CrashNumberingSerif 同梱 / 不動文字フィット日付スタンプ (distribute-3) / ＋ページ番号フッター機能 / アプリアイコン (favicon-k3) / タブ + ページ display_order / D&D 並び替え (multi-select 対応) / 開く動作の常時有効化 + 新タブ自動振り分け / サムネラベル視覚位置化 / **ページポップアップ (§17.4 prelim, β2)** / β3 で **タブバーを `#main-content` へ移動** + **HiDPI プレビュー** + **+gap 簡素化** + **しおり自動取込** + **× 即時削除** / **β5 で 98 風アップデートダイアログ** + **ヘルプ＞更新を確認...** / **β6 で 整列ツールバー + 多重 .is-selected ハイライト** / **β7 で silent installer の起動 UX**）。残: タブ分離別ウインドウ本実装 (§17.10) / annotation proxy / qpdf sanitize / renderer.js モジュール分離 / Wayland ショートカット | v2.0.0 stable |

### 6.4 β テストフロー（**現在ここ**）

2026-05-11 以降のフェーズ。新機能着手より、ユーザー（法律実務家本人 + スタッフ）が β を実機で使い込んでフィードバックを集める段階。β2 → β3 で 11 件、β3 → β4 で 14 件のバグ／UX 改善を一括処理済み。**β5-β8 (2026-05-11 内) で残り 3 件 (§17.16 #13/#14/§17.15) + §15.3 末尾を一気に着地**、自動アップデートも実機実証済。

#### 配布済バージョン

- **v2.0.0-beta.1** — 2026-05-10、初回 β。CI 設定で 1 度転倒（GH_TOKEN 不在 + icon.ico サイズ）→ 同タグで rebuild して成功。
- **v2.0.0-beta.2** — 2026-05-10、ページポップアップ機能（§17.4 prelim）追加。実機テストでの「元 PDF と見比べる」用途を満たす。
- **v2.0.0-beta.3** — 2026-05-11、β2 テスター指摘 11 件を一括修正：分割保存の区切り線が見えない致命的バグ修正 / 日付スタンプの × 削除遅延（preservedEditing 残留） / しおり「取込」ボタン廃止＝自動取込化 / PDF 開時にサイドバーをサムネタブで強制表示 / **スタンプ登録を全 PDF 共通化** (`<userData>/stamps.db` 新設、初回開時に旧 workspace 内 preset を自動マイグレート) / タブバーを `#main-content` 内に移し左サイドバー上端を toolbar 直下まで詰め / サムネ間 +gap を簡素化（hover 前は薄い区切り線のみ） / 分割画面で thumb+trailing-gap を `.split-thumb-cell` に包んで wrap 不揃い解消 / スタンプパレット + register dialog プレビューを HiDPI 化 / しおりツールバーボタン高さ 22→9px。
- **v2.0.0-beta.4** — 2026-05-11、β3 テスター指摘 14 件を一括修正：**印刷フリーズ → SumatraPDF 3.6.1 同梱で根本解決** (`vendor/sumatrapdf/`、Win + rasterized は `-print-to` で WinSpool 直叩き、Chromium silent print の 55 秒タイムアウト + 失敗を回避。byte-copy は従来通り Chromium silent print 維持) / `actionPrint` で `renderSyntheticPage` 渡し漏れ修正（「composePagesForExport: synthetic page encountered…」エラー解消）/ **元 PDF 上書き保存** (`actionSave` を Word Ctrl+S 化、workspace 保存 + 確認ダイアログ + 元 PDF を rasterized で上書き) / 印刷準備 busy modal に **中止ボタン** (`kpdf3:cancel-print` IPC + SumatraPDF プロセス kill) / **ハイブリッド PDF 組立** (`assembleHybridPdf` via pdf-lib、編集なしページは元 PDF を vector 維持で copyPages、編集ありページは元 vector + 600dpi overlay PNG、synthetic / 回転ページのみ full-rasterize JPEG。1 ページ A4 で 100MB → 300KB クラスのサイズ削減 + 罫線・文字の vector 鮮明度復活) / **テキスト枠の編集中横拡張** (`display:block + width:max-content + max-width:viewer-page right edge`、確定時は `measureTextOverlaySize` で fit) / **テキスト内改行** (Enter 改行 / Ctrl+Enter 確定 / Esc キャンセル / blur 確定、innerText で取り出し) / **テキスト色 selector** (黒/赤/青/緑/グレー、localStorage 永続、編集中 overlay に live 反映) / **overlay コピペ** (Ctrl+C/V + 右クリックメニュー「コピー / 貼り付け / 削除」、renderer 側 in-memory clipboard、12pt オフセット paste) / **空白クリックで選択解除** (viewer container pointerdown で `.is-selected` 落とす) / **タブ切替時の subscriber 再アタッチ** (β3 以前: `projectStore.subscribe` が boot tab のみに wire され、`applyTab` / `newTabAndOpen` / `closeTab` で alias 再代入後の新 tab で dirty 通知が来ず toolbar 上書きボタンが grey のまま) / **スタンプポップアップ位置記憶** (localStorage `kpdf3.stampPopupPos`) / **画像登録ボタン反応** (クリック即無効化 + 「読み込み中…」表示で二重クリック防止) / **印影背景透過** (color select に `bg-transparent` 追加、luminance → alpha のみで RGB 維持、デフォルト化、viewer + exporter + preview 全経路対応) / **複数ページ選択 → 単一 PDF 保存** (`actionSavePagesAsPdf`、コンテキストメニューラベル動的、p3-5 連続 / Npages 非連続ネーミング) / **サムネへの外部 PDF ドロップ拡張** (`body.file-dragging` で横 gap 8→28px に膨張 + 視覚化、split-view も `refreshSplitView()` 明示呼び出しでドロップ即反映)。

- **v2.0.0-beta.5** — 2026-05-11、**§17.15 自動アップデート組込み**：`electron-updater@6.8.5` (exact 固定、MIT) を `dependencies` に追加。`src/main/updater.js` を新設して `app.whenReady()` 後 3 秒に `autoUpdater.checkForUpdates()` をキック、4 イベント (`update-available` / `download-progress` / `update-downloaded` / `error`) を IPC で renderer へ転送、renderer が 98 風 confirm 「ダウンロードしますか？」 → busy modal 進捗 → 「再起動して適用しますか？」のフローを駆動。**ヘルプメニューに「更新を確認...」項目** (手動チェック)。`app.isPackaged === false` と `--no-update` フラグで dev/no-update スキップ。**配布インフラを刷新**：開発リポは Private のまま、別途 **公開リポ `windom21-cpu/k-pdf3-releases`** を新設、CI (`.github/workflows/release.yml`) を `electron-builder --publish=always` で installer + `latest*.yml` + blockmap を新リポへ直接 push する設計に変更（softprops 廃止）。トークンは fine-grained PAT (`Contents=Write`, `Metadata=Read`、k-pdf3-releases のみ) を `RELEASES_REPO_TOKEN` Secret で渡す。β5 配布時点では `releaseType: release` のままだったため初回は GitHub Release が draft で作られて 422 (Repository empty) を踏み、README を 1 commit + REST API で draft → published に手動 patch して暫定復旧。後続コミット (β6 リリース前) で `releaseType: prerelease` に修正し以降は自動 publish。

- **v2.0.0-beta.6** — 2026-05-11、**§17.16 #13/#14 テキスト枠の複数選択 + 整列**：`selectedOverlayId` 単一を `selectedOverlayIds: Set<string>` に拡張、`selectOverlay(id, mode)` ヘルパー (`mode = "replace" | "toggle" | "range" | "add"`)、`lastClickedOverlayId` anchor。viewer の `onOverlayClick(id, {ctrl, shift, meta, alt})` で修飾キーを通す。Ctrl/Cmd+click = toggle、Shift+click = reading-order range (per-page top→bottom + left→right)。`reapplySelectionDom` を multi 対応（× ボタンは単一選択時のみ）。`CompositeCommand`（`src/domain/commands.js` 新設）で複数 Delete / 整列を 1 undo 単位化。**整列バー** (`#align-bar`、2+ 選択時のみ表示、左/上/右/下 4 ボタン、青っぽい背景で mode-options-bar と判別可) → `alignSelectedOverlays(edge)`：ページごとに min/max を計算して per-page グループ整列、no-op overlay は skip。多重ページ選択にも対応。

- **v2.0.0-beta.7** — 2026-05-11、**NSIS silent installer に切替**：`oneClick: false` (ウィザード型) → `true` (silent install) に変更。`allowToChangeInstallationDirectory` 削除、`runAfterFinish: true` 明示。これで自動アップデートで「Next > Install」を踏まされる UX 課題を解消、再起動して適用 → NSIS が registry の既存パスを upgrade-in-place → アプリ自動再起動の流れがウィザード非表示で完結。トレードオフ：初回インストール時もパス選択 UI が無くなり `%LocalAppData%\Programs\K-PDF3\` (per-user 既定) に固定される。誤ったパスに入る事故も減るので法律実務テスター用途には合致。

- **v2.0.0-beta.8** — 2026-05-11、**ハイブリッド PDF 組立を回転ページにも対応 (§15.3 末尾の繰越分)**：β4 で導入したハイブリッド組立は `userRotation !== 0 || sourceRotation !== 0` のページを full-rasterize JPEG にフォールバックしていたため、回転した法律文書を書き出すと文字・罫線がぼやけ + サイズが 100MB 級に膨らむ問題があった。`exporter.js` で rotation 条件の早期 full fallback を撤去 → payload に `userRotation` フィールドを追加。`main.js` に `_placeRotatedSourcePage()` を新設：pdf-lib の `embedPdf` で source を `PDFEmbeddedPage` 化（source の `/Rotate` は embedded form の bbox 計算で自動吸収）→ 新 canonical 寸法ページに `drawPage` で userRotation だけ追加適用 + translation table で第一象限に収める → 必要なら overlay PNG を canonical 座標で 0,0 に重ねる。回転ページの vector 維持 + サイズ激減 + 文字鮮明、実機検証で回転方向・整合も問題なし。

- **v2.0.0-beta.9** — 2026-05-11、**回転対象ロジック修正 (テスター指摘)**：「分割画面で特定のページを選択して回転させようとすると、選択していない違うページが回転する」報告。原因はトールバー ↺/↻ → `rotateCurrentPage()` → `rotatePageBy(viewer.currentPage)` 固定で、分割画面 (split-view) のサムネ選択を無視していた。`resolveRotationTargets()` を新設して優先順位を 3 段階に: ①splitThumbSelection (任意サイズ) → ②sidebarThumbSelection (任意サイズ) → ③viewer.currentPage。複数選択にも対応 (順次 `rotatePageBy` 呼び出し、rotation は history 経由しない直接 DB 更新のため整合 OK)。

- **v2.0.0-beta.10** — 2026-05-11、**β9 の修正による副作用への再修正**：「サイドバー（縦サムネ）で選択 → 回転ボタン、この時だけ関係ないページが回転する」報告。原因は β9 がサイドバー単一選択も尊重していたが、サイドバーのサムネクリックは「選択 + ジャンプ」の 2 機能を兼ねており、ユーザーがその後メインビューワを別ページにスクロールすると、画面で見ているページではなく古い「選択痕跡」のページが回ってしまっていた。`resolveRotationTargets` のサイドバー条件を `size >= 2` (明示的 Ctrl/Shift 多重選択) のみに絞り、単一選択は無視して viewer.currentPage にフォールバック。

- **v2.0.0-beta.11** — 2026-05-11、**β10 の race condition 修正**：「サイドバーで p6 を触る → メイン p2 までスクロール → 回転で p6 が回転」報告（β10 上で再現）。原因は `viewer.currentPage` が scroll listener (`requestAnimationFrame` デバウンス) で更新されるキャッシュ変数で、ユーザーがスクロール直後にクリックすると更新前の古い値を返す race。viewer に `visiblePageNow()` メソッドを新設し、`container.scrollTop` と layout を二分探索で直接読んでその場で表示中ページを算出することで race を排除。同時に「回転後に当該ページのサイドバーサムネが回転反映されない」も指摘あり、`rotatePageBy` 冒頭で `invalidateSidebarThumb(pageNo)` を明示呼び出し。**β11 で残った rotated thumb 白紙化バグは β12 で完全解消** (下記参照)。

- **v2.0.0-beta.12** — 2026-05-12、**β11 残バグ「回転後サイドバーサムネ白紙化」修正**：原因は `rotatePageBy` 冒頭の `invalidateSidebarThumb` が in-flight な `renderThumb` を OLD `viewer._pages` snapshot で kick し、`clearThumbs()` 後に thumbCache へ stale canvas を書き戻していた race。stale entry のせいで新 observer が `thumbCache.has(pageNo)` で skip し、新 thumb-item が placeholder のまま残っていた。修正 2 点: (a) 冒頭の `invalidateSidebarThumb` を撤去 (refreshViewer → clearThumbs が cache を全クリアするので不要)、(b) `renderThumb` 末尾に `if (!itemEl.isConnected) return;` ガード追加 (rebuildThumbs で detach されたら結果を捨てる)。同種の race は page delete/insert/reorder/zoom でも起こり得たので一般的に効く。

- **v2.0.0-beta.13** — 2026-05-12、**2 件**：
  - **スタンプパレットポップアップが drag できない** 不具合を修正。グローバル `.title-bar` の `-webkit-app-region: drag` (自前フレーム ADR-0013) が pointerdown を OS に奪っていたのが原因。`.stamp-palette-popup .title-bar` のみ `no-drag` 上書き。位置記憶機能 (β4 で追加済) が初めて実機で機能。
  - **画像スタンプ register dialog から PDF にプレ押印** (§17.5 "できれば")。register dialog に「PDF に試し置き」ボタン追加 → ダイアログ一時非表示 → カーソル追従ゴースト → PDF クリックで pin 留め → ダイアログ復帰、ボタン「試し置きをやり直す」化。pin 中は w/h/色/枠の変更が live 反映。OK/Cancel/Esc/背景クリック/refreshViewer (回転等) で安全に消える。projectStore に入らない純粋な視覚プレビュー (undo/export 無影響、青破線アウトラインで preview と分かる)。zoom 時は `reattachStampTrial` で新ページ DOM に再貼付。

- **v2.0.0-beta.14** — 2026-05-12、**4K モニタ DPI 対応 2 件**：
  - **プリンタプロパティダイアログ** が 4K でぼやけ + 大型化 (legacy ドライバ UI が PerMonitorV2-aware の rundll32 配下で bitmap-stretch されていた、Adobe では in-process で適切に DPI 切替している)。修正: `koffi@2.16.2` を依存追加 → `winspool.drv::DocumentPropertiesW` と `user32::SetThreadDpiAwarenessContext` を直接コール → コール直前に SYSTEM_AWARE スレッドコンテキストに切替で Windows が GDI スケーリング → シャープ。koffi 読み込み失敗 / API 失敗時は rundll32 spawn に自動 fallback (印刷経路 SumatraPDF/Chromium silent は無修正)。実装: `src/main/printer-properties-win.js` 新設。
  - **NSIS installer 本体の DPI 対応**: `build/installer.nsh` を新設して `customHeader` macro 内で `ManifestDPIAware true` + `ManifestDPIAwareness "PerMonitorV2,PerMonitor"` を inject → 生成 installer.exe の embedded manifest が PerMonitorV2 宣言を持つ。oneClick の進捗ダイアログ ("第一印象 UX") のぼやけ解消。`build/` は generated 物が多いため `.gitignore` で除外していたので `!build/installer.nsh` で個別 unignore。

- **v2.0.0-beta.15** — 2026-05-12、**UI 改善大量バンドル + OS 統合**:
  - **吹き出し UX**:
    - 矢印先端の **ドラッグハンドル** 追加 (常時表示、テキスト確定後も矢印先端だけ後から動かせる)。`viewer.onCalloutArrowEnd` callback → `UpdateOverlayCommand` で history 1 単位、Ctrl+Z 可。当初 hover ベース表示にしたら「box から外れた瞬間 hover lost で掴めない」報告 → 常時表示に。
    - 矢印太さを SVG `stroke-width="1.5"` → `"1"` に。`.overlay-callout` の `border: 1px solid` と整合。export 系は元から ctx.lineWidth で揃っていた。
    - **編集中の横拡張** を text overlay と同じく適用 (`display:block + width:max-content + max-width:紙端`)。確定前から紙の右端まで伸びる。
    - **リサイズ高さを `wrappedH` 固定** (Math.max(bbox.h, wrappedH) から変更)。幅を縮めて折り返した後、テキスト下に空白が出る問題解消。
    - 編集中 × close-btn hide の CSS 子孫セレクタ化 (`> .overlay-close-btn` → `.overlay-close-btn`)。contentEditable が typing で `<div>` wrap しても安定。
    - commit 時テキスト抽出を `clone.children` → `clone.querySelectorAll(...)` の subtree 全走査に。深くネストされた close-btn / arrow / handle / svg を確実に除去。
  - **日付スタンプ字間調整 (`date-numeric-spaced`)**: baseWidth 固定 90pt → 登録時に半角フォントスタックで `measureText(renderedDate) + 6pt` を実測。プレビューと押下後の位置が一致。リサイズで広げれば従来通り distribute-3 が preprinted 用紙のスロットに合わせ込む。
  - **マーカー**: opacity 0.5→0.3。下の文字が読みやすい淡さに。新規マーカーのみ反映、既存は overlay properties に保存された 0.5 のままなので再配置が必要。
  - **PDF 関連付け**: `build.fileAssociations` で `.pdf` を Open with 候補に登録 (NSIS / Info.plist / .desktop MimeType を electron-builder が三 OS 分組み込み)。`main.js` に `requestSingleInstanceLock` + `second-instance` ハンドラ + macOS `open-file` AppleEvent + argv パーサ + `did-finish-load` での pending flush。renderer は `kpdf3.onOpenPdfByOS` → `openPdfSmart(path)` で「既存タブ空ならそこ、PDF 読込み済みなら新タブ」。

配布フォルダは Google Drive 経由を継続中だが、**β5 以降はテスターが手動入れ替え不要**：起動時に autoUpdater が新版を検出して 98 風ダイアログから 1 クリック更新 (β7 以降は完全 silent)。新規テスター向けの初回 installer のみ Google Drive 共有 (β15 配布フォルダ `~/デスクトップ/K-PDF3-beta15/` または GitHub Release `windom21-cpu/k-pdf3-releases` 直リンク)。

#### β.N リリース手順（次にバグ修正 / 機能追加した時の手順）

1. ローカルで修正コミット（`feat:` `fix:` プレフィックス、論理単位ごと）
2. `package.json` の `version` を `2.0.0-beta.N` (N+1) に bump
3. `git commit -m "chore(release): bump to 2.0.0-beta.N — <要旨>"`
4. `git push origin main`
5. `git tag -a v2.0.0-beta.N -m "<要旨>"`
6. `git push origin v2.0.0-beta.N` → CI release workflow が起動
7. `gh run list --workflow=release.yml --limit 1` で run id 確認
8. 約 5 分で 4 ジョブ（macos / windows / ubuntu の build + publish）完走
9. `gh release view v2.0.0-beta.N` で添付 6 installer 確認
10. 配布フォルダ更新（古い β を削除 → 新タグ download）：
    ```bash
    rm -rf ~/デスクトップ/K-PDF3-beta<N-1>
    mkdir -p ~/デスクトップ/K-PDF3-beta<N>
    cd ~/デスクトップ/K-PDF3-beta<N>
    gh release download v2.0.0-beta.N --repo windom21-cpu/k-pdf3-releases
    ```
    ※ **β5 以降は `--repo windom21-cpu/k-pdf3-releases` (公開リポ) に変更**。古いタグ (β1-β4) を再取得する場合のみ `windom21-cpu/k-pdf3` (Private、softprops 経由で添付されていた)。
11. README.txt も β.N 用に書き換え（β1 → β2 の差分参照）。**β5 以降はテスター手動入れ替え不要**（autoUpdater が新版を検出して 1 クリック更新）なので、Google Drive 共有は新規テスター向け初回 installer のみで十分。

#### CI で過去引っかかった点（再発防止メモ）

- **macOS / Linux**: electron-builder はタグ push を検知すると **暗黙の publish** を試みて `GH_TOKEN` を要求し失敗する。`package.json` の `build:linux/win/mac` には `--publish=never` を必ず付けておく（このリポジトリは付け済み）。**β5 以降は `publish:linux/win/mac` (`--publish=always`) スクリプトを別途追加** し、CI ではこちらを使って k-pdf3-releases へ直接 publish する設計に変更。
- **Windows**: `build/icon.ico` は **256x256 以上が必須**。favicon-k3/favicon.ico は 16/32 のみ → `scripts/build-icon.mjs` は ico をコピーせず、512×512 PNG (`build/icon.png`) から electron-builder に自動変換させる方針。
- 上記 2 点は β1 で同時に踏んだバグ。修正コミット `44ad9b9` 参照。
- **β5 で踏んだ**: 公開リポ `k-pdf3-releases` の初回コミットが無い状態で electron-builder が release を作ろうとして 422 (Repository is empty)、かつ `releaseType: release` (デフォルト) で draft 作成されて autoUpdater から見えない。対策：(a) k-pdf3-releases に README を 1 commit して初期化、(b) `releaseType: prerelease` に変更（β タグの prerelease 自動マーキングも兼ねる、stable v2.0.0 リリース時は `release` または削除に戻す）。
- **β5 → β6 の `git push`**: `.github/workflows/release.yml` を変更したコミットを push する際、認証用 PAT が `workflow` scope を持っていないと GitHub が拒否 (`refusing to allow a Personal Access Token to create or update workflow`)。既存 classic PAT に `workflow` scope を追加することで解決。
- **β5 → β6 への自動更新で `Next > Install` ウィザードが出る件 (NSIS デフォルト挙動)**: β7 で `oneClick: true` に切替えて解消。oneClick=true は初回インストール時もウィザードを出さず silent install + アプリ自動起動。インストール先は per-user 固定 (`%LocalAppData%\Programs\K-PDF3\`)。
- **β12 で踏んだ matrix race**: `.github/workflows/release.yml` の build matrix (ubuntu / macos / windows) が **同時に** k-pdf3-releases へ GitHub Release を作りにいって、最速 job が 201 で成功、遅延した job (β12 は macOS) が `422 Unprocessable Entity / tag_name already_exists` で落ちた。結果は β12 release が Win + Linux アセットだけ publish 済み、mac dmg / arm64 / latest-mac.yml が欠落。Win/Linux テスターは autoUpdater で β12 入手済、Mac テスターは現在いないので実害なし。β13/β14/β15 は race を踏まず全 OS 完走 (タイミング次第で発火する transient bug)。**根治の選択肢**: (a) pre-create release を別 job で先行実行して以降の matrix は publish only、(b) `electron-builder` の retry-on-existing-release オプションがあれば有効化、(c) sequential build (速度コスト大)。優先度は低 (Mac テスター不在のため実害小)、§8.2 繰越項目で別途扱う。

#### β 期間中のバグレポート受け取り方

- ユーザーが GitHub Issues / 直接連絡で報告
- 軽微なら次の β.N に同梱（即修正→ tag push 30 分で installer 更新）
- 重大（業務凍結級）なら git revert + 緊急 β でロールバック

#### β 卒業の目安

業務並走で 1〜2 週間使って重大バグなし、かつ K-PDF2 v0.27.0 の代替が成立する確信が出れば、β を卒業して **§8 のフェーズ 2 (機能完成)** に進む（タブ分離 D&D + annotation proxy + qpdf sanitize → RC1 → stable）。

---

## 7. 実装済み機能（M1 〜 M5 + M6 ポリッシュ大半）

このセクションは現在までの **完了済の機能と内部状態** を要約する（2026-05-10 リライト）。コミット履歴 `git log --oneline` も併せて読むと文脈が掴みやすい。`§7.7` のサマリ表を最初に見ると現状把握が早い。

### 7.1 ドキュメント（docs/）

- `docs/architecture.md`：レイヤ図と依存ルール
- `docs/glossary.md`：用語定義
- `docs/adr/0001-workspace-sqlite.md`：保存形式の選定理由
- `docs/adr/0002-mupdf-layout-engine.md`：layout engine 採用理由
- `docs/adr/0003-canonical-coordinate.md`：座標系の定義
- `docs/adr/0004-electron-version-pin.md`：Electron `^38.8.6` 一時固定（better-sqlite3 互換性）
- `docs/adr/0005-electron-test-runner.md`：SQLite 依存テストを Electron で走らせる軽量 runner
- `docs/adr/0006-pdf-first-ux-and-98css.md`：PDF-first UX + 98.css vendored（dtt-mini からコピー）
- `docs/adr/0007-userdata-workspace-storage.md`：kpdf3 を userData に集中、SHA-256 で索引
- `docs/adr/0008-disk-footprint-and-smart-saveas.md`：exports BLOB 廃止、Smart Save As

### 7.2 実装（src/）

#### domain/（純 JS、状態とロジック）

- `coord.js`：canonical ↔ PDF native transform（rotation 0/90/180/270 + userRotation 対応、matrix 形式 + point 形式）+ multiplyMatrix / inverseMatrix / scaleMatrix
- `workspace.js`：workspace 高レベル API（open/create、source PDF 取込、page メタ、overlay save/load、export 監査ログ、outline 取得）
- `page-registry.js`：canonical 寸法キャッシュ + 縦レイアウト + visiblePageRange（O(log N) binary search）
- `project-store.js`：overlay CRUD + per-page index + Pub/Sub + dirty flag。**renderer 側で生存**
- `history.js`：command-pattern undo/redo stack + listener 通知
- `commands.js`：AddOverlay / UpdateOverlay / RemoveOverlay command（restoreOverlay でアイデンティティ保持）

#### backend/（外部ライブラリラッパー、上位 layer は中身を知らない）

- `mupdf-pdf-info.js`：page metrics 抽出 / fingerprint 計算 / outline 抽出
- `mupdf-layout.js`：layout engine wrapper（shapeLine / measureLine / wrapLines）
- `mupdf-render.js`：page → Pixmap → RGBA bytes（caller が matrix 提供）
- `sqlite-store.js`：better-sqlite3 wrapper（WAL、schema bootstrap、CRUD、ADR-0008 schema migration）

#### main/（Electron main process）

- `main.js`：Electron skeleton + IPC surface
  - workspace lifecycle: open-pdf-file / close-workspace / create-workspace（test 用）
  - viewer: render-page
  - overlay: save-overlays / get-source-meta / get-pages
  - export: export-pdf-rasterized / copy-source-pdf / pick-export-pdf / pick-export-folder
  - print: print-pdf-silent / list-printers（独自ダイアログ + silent print、隠し singleton BrowserWindow）
  - bookmarks: get-outline
  - recent: list-recent-pdfs
- `render-service.js`：page 描画オーケストレーション（mupdf + scaleMatrix、mupdf が rotation を内部処理）
- `workspace-registry.js`：userData/index.db で fingerprint → kpdf3 の索引（ADR-0007）
- `preload.cjs`：renderer に露出する API surface（`window.kpdf3`）

#### renderer/（Electron renderer process）

- `index.html`：title-bar / menu-bar / toolbar / main-area（sidebar + viewer + split-view）/ status-bar
- `style.css`：98.css の上に乗る薄いカスタム層
- `vendor/98.css` + `ms_sans_serif*.woff/woff2`：Win95 風テーマ vendored
- `viewer.js`：Viewer class（PageRegistry レイアウト + IntersectionObserver virtualization + canvas 描画 + overlay レイヤ + drag/resize/click/contextmenu）
- `menu-bar.js`：MenuBar class（クリック / hover / Escape / disabled 制御）
- `renderer.js`：UI orchestration（workspace 開閉、placement modes、edit/save/export/print/split flow、各種ダイアログ）
- `exporter.js`：renderer 側のページ合成（mupdf → Canvas → PNG → main へ）

#### test/

| テスト | 結果 | 実行環境 |
|---|---|---|
| `coord.test.mjs` | **83 pass** | plain `node` |
| `page-registry.test.mjs` | **48 pass** | plain `node` |
| `project-store.test.mjs` | **59 pass** | plain `node` |
| `history.test.mjs` | **45 pass** | plain `node` |
| `m1-exit-criteria.mjs` | **51 pass** | Electron runner |
| `m3-overlay-persistence.mjs` | **56 pass** | Electron runner |
| `render.test.mjs` | **11 pass** | plain `node` |
| `render-service.test.mjs` | **27 pass** | plain `node` |
| **合計** | **380/380 pass** | |

実行方法：
```bash
npm test                 # 全テスト
npm run test:coord       # 個別実行
npm run test:m1          # m1 + m3-overlay-persistence（runner 経由）
# ほか test:page-registry, test:project-store, test:history,
#       test:render, test:render-service
```

### 7.3 ユーザーから見える主要機能（2026-05-10 時点）

#### 7.3.1 ファイル系

| 機能 | 操作 | 由来 |
|---|---|---|
| PDF を開く | toolbar「開く」/ ファイル > 開く / 最近のファイル / **PDF を画面に D&D** | 2026-05-10 でカスタムファイルダイアログ + D&D 追加 |
| カスタム ファイル選択 | OS ダイアログを使わず Win95 風自前ブラウザ。Open / Save / Folder の 3 モード共有 | 2026-05-10 |
| 上書き保存 | Ctrl+S / toolbar「上書き」（kpdf3 内 overlay state + ページ削除） | M3-4 / 2026-05-10 で削除フラグ flush 対応 |
| 名前を付けて保存 (= Save As) | Ctrl+Shift+S / toolbar「保存」/ ファイル > 名前を付けて保存 | M4-1 → 2026-05-10 で Save As 後 workspace 自動切替（Word 流） |
| 範囲書き出し | ファイル > 範囲指定で書き出し | M5-6 |
| 分割保存 | toolbar「分割保存」→ サムネビュー + 区切りクリック + 各パート命名 + 日付プレフィックス | M5-6 V2 |
| 印刷 | Ctrl+P / toolbar「印刷」→ **印刷プレビュー + 設定** → silent print | M5-4 → 2026-05-10 でプレビュー化 |
| 閉じる時警告 | 未保存（overlay / ページ削除）があれば確認 | M3-4 / 2026-05-10 で削除も含む |

#### 7.3.2 編集系

| 機能 | 操作 | 由来 |
|---|---|---|
| テキスト追加 | toolbar「テキスト」/ ツール > テキスト → 1 クリック配置 → 自動編集モード（IME 対応）| M3-3, M3-5 |
| 印影スタンプ | toolbar「印影」/ ツール > 印影 → 1 クリック配置（赤円「印」） | M3-7 |
| 真の墨消し | toolbar「墨消し」/ ツール > 墨消し → ドラッグで範囲指定 | M5-1 |
| マーカー（プレースホルダ）| toolbar「マーカー」/ ツール > マーカー — disabled | 2026-05-10、未実装 |
| overlay 操作 | drag で移動、四隅で resize、右クリックで削除 | M3-6, M5-3 |
| Undo/Redo | Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / 編集 menu | M3-2 |
| **ページ削除** | サイドバーまたは分割保存のサムネ選択 + Delete | 2026-05-10、ペンディング → Ctrl+S で確定 |
| **複数選択** | サムネで Ctrl/Cmd（toggle）/ Shift（範囲）| 2026-05-10、サイドバーと分割保存で独立した選択状態 |
| **ページ挿入** | サムネ間の「＋ 白紙を挿入」hover でクリック → ダイアログ（テキスト任意、72pt 表示）| 2026-05-10、サイドバー / 分割保存 両方対応、即時 DB 永続化 |

#### 7.3.3 表示・ナビ系

| 機能 | 操作 | 由来 |
|---|---|---|
| ページ表示 | スクロール、PageUp/PageDown、Ctrl+G、ステータス「N / total」 | M2 / M5-2 |
| 拡大縮小 | 表示メニュー / Ctrl+= / Ctrl+- / Ctrl+0 / fit / **toolbar の zoom dropdown** / **Ctrl+ホイール** | M3-8 / 2026-05-10 で dropdown + wheel 追加 |
| 表示解像度切替 | ツール > 表示解像度: 標準 / 高 / 最高 | 2026-05-10、HiDPI canvas oversample（標準 1.0 / 高 2.0 / 最高 3.0 × DPR） |
| 回転（プレースホルダ）| toolbar の ↺ / ↻ — disabled | 2026-05-10、未実装 |
| しおり | サイドバー「しおり」タブ / 表示 > しおり / F4 | M5-5 → 2026-05-10 でタブ化 |
| **サムネイル** | サイドバー「サムネイル」タブ（既定）/ クリックでジャンプ / IntersectionObserver lazy | 2026-05-10 |
| サイドバー開閉 | F4 / 左端の縦ハンドル（◀/▶）/ メニュー | 2026-05-10 |
| サイドバー幅変更 | 右端ドラッグで調整、localStorage で永続化 | 2026-05-10 |
| **検索 (Ctrl+F)** | toolbar 右端の検索ボックス + 🔍 ボタン → ページ単位ヒットを順次ジャンプ | 2026-05-10、mupdf Page.search() 経由 |

#### 7.3.4 自前ウインドウシステム

| 機能 | 操作 | 由来 |
|---|---|---|
| 自前タイトルバー | 98.css 青いバー、frame:false で OS chrome なし | 2026-05-10 |
| 最小化 / 最大化 / 閉じる | タイトルバー右端の 3 ボタン、ダブルクリックで最大化 | 2026-05-10 |
| ウインドウドラッグ | タイトルバー全体でドラッグ可能（-webkit-app-region） | 2026-05-10 |
| タイトル動的反映 | 開いてる PDF のファイル名 + dirty マーク。未開時はアプリ名 | 2026-05-10 |

#### 7.3.5 UI 補助

| 機能 | 操作 | 由来 |
|---|---|---|
| ホバーヒント | toolbar / メニュー の項目にカーソル → 左下ステータスにヒント | 2026-05-10 |
| 砂時計カーソル | 書き出し / 印刷 / 描画など長時間処理中、`body.is-busy` で cursor: progress | 2026-05-10 |
| バージョン情報 | ヘルプ > バージョン情報 → 自前モーダル（Electron / Node / Platform 表示）| 2026-05-10 |

### 7.4 dev workflow

`build-essential` インストール済の前提（2026-05-09 sanity check 時点）。

dual-ABI 問題（`npm test` ↔ `npm start` の rebuild 往復）は ADR-0005 で解消。`test:m1` は Electron main process 内に走り、Electron ABI バインディング 1 本で `npm start` も `npm test` も動く。

```bash
npm run postinstall   # 一度だけ：better-sqlite3 を Electron 38 ABI 用 rebuild
npm start             # Electron 起動（--no-sandbox 付き）
npm run dev           # electronmon 経由（ファイル変更で自動 reload／restart）
npm test              # 全テスト（380/380 pass、2026-05-09）
```

### 7.5 設計上の決まりごと（再掲）

- **ProjectStore は renderer 側に常駐**。main は SQLite I/O だけ。M3-1 で確定。
- **kpdf3 は userData に集中保管**（`~/.config/K-PDF3/workspaces/`）。fingerprint 索引 (`index.db`) で PDF と紐付け。ADR-0007。
- **Save = workspace state**（Ctrl+S、kpdf3 への overlay 書込）。**Save As = export + workspace 自動切替**（Ctrl+Shift+S）。ADR-0008 / 2026-05-10 で切替挙動追加。
- **ディスク上の PDF は普通の名前**（`契約書.pdf`）。kpdf3 はユーザーから見えない。ADR-0007。
- **Win95 風 UI（98.css vendored、frame:false）**。テキスト・印影・墨消しなど各モードは toolbar の押下状態 + ツールメニューの ✓ で同期。ADR-0006。
- **ページ削除は workspace state、元 PDF 不変**。Ctrl+S までは renderer 側 pending（本セッションで追加）。
- **ページ挿入も workspace state、元 PDF 不変**。即時 DB 書込 + workspaceMutated dirty フラグ。
- **synthetic ページのレンダは renderer 側 canvas で完結**。main は触らない（canvas API がないため）。

### 7.6 2026-05-10 セッションでの内部変更（重要、新セッションは要把握）

#### 7.6.1 ページ削除（workspace 単位）

- `pages.is_deleted` 列追加（schema migration）
- `Workspace.getPages({includeDeleted})` でフィルタ可能、デフォルトは除外
- `Workspace.setPageDeleted(pageNo, deleted)` 公開
- IPC: `kpdf3:set-page-deleted`
- 削除挙動: Delete キー → `pendingDeletedPages: Set<number>` に登録（renderer state） → Ctrl+S で flush して DB へ
- **viewer / page-registry が "pageNo == position+1" 前提だったのを撤廃**: `PageRegistry.pageNoToPos` Map を導入、`pageNoAtPos(pos)` / `posOfPageNo(pageNo)` API 追加
- `viewer._buildPageDoms` / `scrollToPage` / `_setupScrollListener` / `currentPage` / `actionPagePrev/Next/Goto` 全部 sparse pageNo 対応
- main の `render-page` IPC も `find(p => p.pageNo === pageNo)` で sparse 対応
- main の `activePages` は `getPages({includeDeleted:true})`（render-page resolve 用、削除済も保持）

#### 7.6.2 ページ挿入（白紙 / テキスト付き）

- `inserted_pages` テーブル新設（schema migration）
- 挿入ページは `pageNo = -id`（負の同定子）、`isSynthetic: true` フラグ
- `Workspace.getPages()` が `inserted_pages` をマージして順序付きリストを返す
- IPC: `kpdf3:add-inserted-page` / `kpdf3:remove-inserted-page`
- 即時 DB 永続化（pending workflow ではない、`workspaceMutated` フラグで dirty 反映）
- `viewer.js` に `renderSyntheticPagePixels(row, zoom)` を export — 白背景 + 72pt テキスト（zoom 倍率調整）
- `exporter.js` の `composePagesForExport` / `composeSinglePageCanvas` が `renderSyntheticPage` 引数を受け取り synthetic も対応
- main の `render-page` は `pageNo < 0` を明示的に拒否（renderer 側で描画する設計）

#### 7.6.3 dirty workflow 拡張

- `isWorkspaceDirty()` = `projectStore.isDirty() || pendingDeletedPages.size > 0 || workspaceMutated`
- `workspaceMutated`: 挿入や挿入ページ削除など即時 DB 反映系の操作で立つフラグ
- `actionSave` で全部 flush + `workspaceMutated = false`

#### 7.6.4 Save As workspace 切替（Word 流）

- `actionExport` 成功直後に：
  1. `closeWorkspace()`
  2. `openPdfFile(savePath)` で新ファイルの workspace を取得
  3. `projectStore.reset(opened.overlays ?? [])`、`pendingDeletedPages.clear()`、`workspaceMutated = false`
  4. `refreshViewer()` で UI 全更新
- byte-copy 検出: `overlayCount === 0 && !hasDeletions && !hasInsertions` のみ byte-copy。挿入や削除があれば必ずラスタライズ。
- `kpdf3:get-source-meta` IPC は `meta.fileName` を `activeSourcePdfPath` の basename で上書き。byte-copy で workspace が使い回されてもタイトルバーは新ファイル名を表示。

#### 7.6.5 検索 (Ctrl+F)

- IPC: `kpdf3:search-pdf` — mupdf `Page.search()` でページ単位ヒット数を返す
- 動作: 同じ語で再 Enter → 次のヒットページへ循環ジャンプ（"Find Next"）
- ページ内ハイライトは未対応（M6+ 候補）

#### 7.6.6 印刷プレビュー（Adobe 簡略版）

- 2 ペイン: 左に設定（プリンタ + プロパティ / 部数 / 範囲 / サイズ / 向き）、右にライブプレビュー
- プリンタプロパティ: OS の native ダイアログを spawn（Linux: system-config-printer / Win: rundll32 / Mac: System Preferences）
- プレビューは `composeSinglePageCanvas` 経由、stale token で衝突回避
- 範囲指定 / 横向き / 用紙合わせ などの選択肢

#### 7.6.7 自前ウインドウクロームと HiDPI

- `BrowserWindow({frame:false})`、98.css の青いバーを唯一のタイトルバーに
- IPC: `kpdf3:window-minimize/maximize-toggle/close/is-maximized`、`window-state` イベント
- HiDPI: `Math.min(devicePixelRatio, 2) × {1.0|2.0|3.0}` の oversample。canvas 内部解像度を上げて CSS で縮小表示 → 文字が鮮明
- Chromium フラグ: `font-render-hinting=none` + `disable-font-subpixel-positioning`（pixel-grid スナップを強める）

#### 7.6.8 ファイルダイアログ完全自前化

- `kpdf3:list-directory` / `get-default-paths` / `file-exists`
- `showFileBrowser({mode, title, initialName, defaultDir})` を Promise ベースで提供
- mode: `open` / `save` / `folder` の 3 種、UI 要素を切替えて使い回し
- 保存時に拡張子なしなら `.pdf` 自動付与、上書き確認

#### 7.6.9 D&D で PDF を開く

- `webUtils.getPathForFile(file)` を preload で公開（Electron 32+ で `File.path` 削除に対応）
- `document.addEventListener("drop")` で全画面ドロップ受け付け

### 7.7 セッションごとの増分サマリ

| セッション | 主な追加・変更 |
|---|---|
| M1〜M4 | 基盤 / object model / 編集 / 書出 / Smart Save As |
| M5 大半（〜2026-05-09）| 真の墨消し / 印刷 / しおり / 分割 / 範囲 / 最近のファイル |
| **2026-05-10** | UI 統一（MS UI Gothic / フォント設定 / pixel-grid / hover ヒント / 砂時計）/ frame:false 自前タイトルバー / カスタムファイルダイアログ完全自前化 / 印刷プレビュー（Adobe 簡略版）/ 検索 Ctrl+F / 表示解像度切替 / サイドバータブ + サムネイル + スプリッター / **ページ削除 + 挿入** / Save As workspace 自動切替 / D&D / 多くのプレースホルダ枠（マーカー / 回転 / スタンプ管理 / フォント設定）|
| **2026-05-10 後半** | ADR-0009〜0013 起草 / window.confirm 統一 / I-beam カーソル / **回転 (toolbar + サムネ右クリック + 挿入ページも) / overlay も rotate 追従 / マーカー (line/marker) / 墨消し白 / テキストフォント・サイズ UI** / スタンプ ghost preview / 吹き出し (rect/callout, 矢印 + テキストボックス) / 日付スタンプテンプレ (8.5.9 / 令和8年5月9日) + 色 + ghost プリセット連動 / 編集可能しおり (workspace bookmarks 表+/− + 双クリックリネーム) / サムネに overlay + rotation 反映 / zoom-fit が resize 追従 / 1 ページ全体表示 / overlays.page_no FK 削除 (synthetic 対応) / Wayland xwayland 強制 / **F5/Ctrl+R/F12 効かない (Wayland, 保留)** — バージョン情報ダイアログにリロード / 開発者ツールのフォールバックボタン / **サムネ右クリック → 単ページ PDF 保存** / **insert-gap に外部 PDF drop で image-backed synthetic page (inserted_pages.image_blob)** / renderSyntheticPagePixels async 化 |
| **2026-05-10 終盤** | overlay クリック選択 + Delete / × ボタン / 矢印先端 arrowhead / マーカー矩形ドラッグ化 / **/Outlines export (pdf-lib + UTF-16BE) / しおり取込み**ボタン / **callout 再設計**：矢印線 + テキストボックス（boxサイズ自動 fit + 折り返し時 h 自動 + 回転で arrowDx/Dy 追従 + commit 時に × 文字混入バグ修正 + 余白 padding 共有定数化）/ **スタンプ管理ダイアログ全面実装**（stamp_presets テーブル + 日付/テキスト/画像 register dialog + プレビュー + 編集 (upsert) + 削除）/ **画像スタンプ MVP**（assets テーブル統合、viewer/exporter 描画、回転対応、PNG/JPEG 取込み、SHA-256 dedupe）/ **stamp palette を floating popup に**（sticky mode、ドラッグ可能、連続押印）/ 98.css 規格の input + label 隣接兄弟パターンで Win95 風 checkbox / radio 復活 / 確認ダイアログ z-index 修正（背面に隠れる freeze 風挙動）/ ADR-0014 / 0015 / 0016 起草 / F-18 GitHub Actions CI 骨格（test + release workflow + electron-builder build 設定）|
| **2026-05-11** | **しおり階層 + drag-reorder UI**（schema は parent_id 既設、move-bookmark IPC + UI 整備、pdf-outlines.js が再帰的 /Outlines 出力に対応）/ **画像スタンプ色 tint**（luminance → alpha + RGB ← color、register dialog に色 picker 追加）/ **CrashNumberingSerif 同梱** + フォント設定ダイアログ（ADR-0019 後半）+ 半角既定を numeric stack に変更 / **アプリアイコン同梱**（favicon-k3/, build/icon.{png,ico}, vendor/app-icon.png + 自前タイトルバーにも 16×16 アイコン）/ **＋ページ番号フッター機能**（toolbar ボタン + 位置/形式/開始番号/サイズダイアログ）/ **タブ実装 (ADR-0015 Phase 1-7)** ：TabState + tabs Map<id, TabState> + applyTab、main 側 tabHandles + switch-tab/close-tab IPC、98 風タブバー（ツールバー直下）+ +/× ボタン + dirty マーク + ドラッグ並び替え、Ctrl+T/Ctrl+W、複数 dirty タブの一括確認 / **サムネ D&D 並び替え** ：pages + inserted_pages 両方に display_order 追加、reorderAllPages IPC、merge は positional + slot fallback で freshly-inserted blank も自然な位置 / **multi-select 対応** ：Shift 範囲選択 → 複数ページ一括移動（相対順序保持）/ **不動文字フィット日付スタンプ (distribute-3)** ：4th radio、3 数字を box 幅で等間隔配置、ピリオド非描画、横ドラッグで字間調整 / 日付スタンプの「ハイフン=ゼロ埋め」ロジック修正（10 にハイフンつかない）/ 日付スタンプ per-preset fontSize / **Z 軸 polish bundle**：開く button 常時有効 + 新タブで開く、検索ボックス 🔍 toggle、テキスト常時枠廃止 + 編集枠 1 行高、サムネ回転で aspect-ratio 切替、サムネに非A4 サイズバッジ、分割 1 ページ目縦ずれ修正、ファイル閉鎖後のサムネ残留修正、サムネラベル視覚位置化、ページ表記が視覚位置に、デフォルト fit-width、ドラッグ後ドラッグページにスクロール、青線インジケーターのデバウンス、electronmon hot reload を beforeunload で阻害しないよう dev mode 検出 |
| **2026-05-11 深夜（β リリース）** | **v2.0.0-beta.1 タグ + push** で CI release workflow 起動、初回は 2 箇所で転倒（macOS/Linux: GH_TOKEN 不在、Windows: icon.ico < 256x256）→ 修正コミット `44ad9b9` で `--publish=never` + scripts/build-icon.mjs から ico コピーを廃止 → 同タグで再ビルド成功、6 installer (.exe x2 / .dmg x2 / .AppImage / .deb) が GitHub Release に自動添付。配布フォルダ `~/デスクトップ/K-PDF3-beta1/` 作成 → Google Drive で実機テスト準備。/ **ページポップアップ機能 (§17.4 prelim)** 実装：toolbar 「別窓」ボタン → composeSinglePageCanvas で現ページ + overlays を PNG 化 → 別 BrowserWindow（frame:false、Win95 風 22px チロームバー、📌 always-on-top、Esc/× で閉じる、複数開閉可）に表示。元 PDF / 別ファイルとの見比べ用途。kpdf3:window-close を sender-aware に変更（複数ウインドウ対応）。/ **v2.0.0-beta.2 タグ** で β2 リリース → 配布フォルダを `K-PDF3-beta2/` に更新。 |
| **2026-05-11（β2→β3 修正パス）** | β2 実機テスター指摘 11 件を一括修正して **v2.0.0-beta.3** リリース。配布フォルダを `~/デスクトップ/K-PDF3-beta3/` に差替。/ **分割保存の区切り線が見えない致命バグ**: `.split-inner-sep` を `align-self: stretch` + 破線 gradient で常時可視。/ **× 削除遅延**: `viewer._exitEdit` クロージャを公開 (`exitTextEdit()`)、× クリックで先に edit を中止してから RemoveOverlayCommand → `_renderPageOverlays` の preservedEditing で消去残骸が残らない。/ **しおり「取込」ボタン廃止**: `openPdfPath` 内で `workspace.bookmarks` 空 + `getOutline()` 非空なら自動取込。/ **PDF 開時のサイドバー初期化**: `sidebar.hidden = false` + `switchSidebarTab("thumbs")` を強制。/ **スタンプを全 PDF 共通化**: 新 `src/main/global-stamp-store.js` (`<userData>/stamps.db` の SQLite、`assets` + `stamp_presets` テーブル)、`kpdf3:list/add/remove-stamp-preset` を global ルートに切替、`kpdf3:add-asset-from-file` も global へ、`kpdf3:get-asset` は workspace miss 時 global fallback。初回 workspace 開時に `migrateFromWorkspaceIfEmpty` で旧 workspace 内 preset を global へ自動移行。/ **タブバーをサイドバー外に**: index.html を `<div id="main-content">` で `tab-bar + viewer-container + split-view` を包んで sidebar の右側へ。CSS は `.viewer-container/.split-view` の `order` ルール撤去 + `.main-area.split-mode #viewer-container` に変更。`updateTabBarOffset` は no-op stub に縮小。/ **+gap 簡素化**: `.thumb-insert-gap` の文言を「＋」のみ + デフォルト transparent、行 hover で gray、focus/hover で navy に。/ **分割画面 wrap**: 各 thumb と trailing +gap を `.split-thumb-cell` で flex 包んで分離不能化、wrap が cell 単位でしか起きず縦が揃う。/ **HiDPI プレビュー**: `setupHiDPICanvas(cssW, cssH)` ヘルパ + `canvasLogicalSize()` を導入、palette thumb 84×32 に拡大、register dialog の date/text/image preview も dpr スケール化。/ **しおりボタン縮小**: `.bookmark-toolbar button` height 22→9px / padding 0 4→0 3 / font 11→10 / `display: flex` で中央寄せ。 |
| **2026-05-11（β3→β4 修正パス）** | β3 実機テスター指摘 14 件を一括修正して **v2.0.0-beta.4** リリース。/ **印刷フリーズ → SumatraPDF 同梱で根本解決**：FUJIFILM Apeos C2360 無線複合機で `webContents.print({silent:true})` が 55 秒後に `success:false, errorType:""` で失敗するのを実機ログで切り分け。Adobe 直印刷では同 PDF が即印刷できることを確認。Chromium PDF プラグインが mupdf 生成 PNG XObject PDF を WinSpool に流す経路が壊れていると判断。`vendor/sumatrapdf/SumatraPDF.exe` (3.6.1 portable, GPLv3, spawn として呼ぶので link なし) を package.json `win.extraResources` で同梱、Win + rasterized は `SumatraPDF.exe -print-to "DeviceName" -print-settings "Nx,landscape,noscale" -silent -exit-when-done <pdf>` で直叩き。byte-copy は従来通り Chromium silent print 維持 (軽量 PDF なので動く)。`_activeSumatraProcess` を握って `kpdf3:cancel-print` IPC で kill 可能に。/ **synthetic page エラー修正** (`actionPrint` が `composePagesForExport` に `renderSyntheticPage` を渡し忘れていた、白紙 / 外部 PDF 挿入ページ含む状態で印刷すると throw)。/ **ハイブリッド PDF 組立** (`assembleHybridPdf` 新設 via pdf-lib `copyPages`、戦略は `source` (元 PDF 1:1 コピー、vector 維持) / `overlay` (元 PDF + 600dpi overlay PNG を `drawImage`) / `full` (synthetic / 回転ページは canvas → JPEG q=0.95)。`composePagesForExport` 内で per-page strategy 判定 + 必要なら `composeOverlayOnlyPage` で透過 canvas を作って overlay-only PNG を渡す。1 ページ A4: 144dpi PNG 25MB → 600dpi PNG 100MB → β4 hybrid 300KB、罫線・元文字は vector 鮮明。`EXPORT_ZOOM = 600 / 72` (288dpi 試行 → 600dpi 試行を経た最終値、ただし source 戦略時は zoom 適用なし)。)/ **「上書き」を Word Ctrl+S 化** (`actionSave` に customConfirm + `actionExportToPath(activeSourcePdfPath)` を呼ぶ枝を追加、`isPdfOutOfSync()` で workspace overlay / 削除 / 挿入が source PDF に未反映なら button を enable。旧 `actionExport` は新 helper `actionExportToPath` の薄ラッパに refactor、両者で同じ書き出し + workspace 切替の処理を共有)。/ **印刷中止ボタン** (busy modal に `#busy-cancel` を追加、`showBusy(title, msg, %, {onCancel})` で 中止ハンドラ登録、actionPrint で SumatraPDF kill via `kpdf3.cancelPrint()`)。/ **テキスト枠の編集中横拡張** (`enterTextEdit` で `_editPrevStyle` を退避し `display:block + width:max-content + max-width:viewer-page right edge - 4px` に切替、finish で元に戻す。`viewer-page` クラス名のセレクタ間違いで一度動かなかった指摘あり)。/ **テキスト内改行** (Enter→改行 (preventDefault しない) / Esc→キャンセル / Ctrl+Enter→確定 / blur→確定、テキスト取り出しは `innerText` で `<br>` `<div>` を改行に。`wrapCanvasText` が既に `\n` split 対応していたので exporter 側変更不要)。/ **handleTextEditCommit の auto-fit を text にも拡張** (`measureTextOverlaySize` を新設、最長行 width or 現状 width の大きい方 + 行数×1.2×fontSize で h)。/ **テキスト色 selector** (`#text-color` を mode-options に追加、`localStorage` 永続、`applyFontSizeToEditingOverlay` に color を追加、`viewer.applyEditingTextStyle` の `style.color` 経路を流用)。/ **overlay コピペ** (`_overlayClipboard` module-level + Ctrl+C/V keydown + 右クリックメニュー "コピー / 貼り付け" 追加、`pasteOverlayFromClipboard` で 12pt オフセット paste & 新 overlay を selection に)。/ **空白クリックで選択解除** (`viewerContainer.pointerdown` で `.overlay` 配下でなければ `setSelectedOverlay(null)`)。/ **タブ切替時の subscriber 再アタッチ重要バグ修正** (β3 以前: `projectStore.subscribe((event) => {refreshDirtyIndicator(); refreshMenuState(); ...})` が boot tab のみに wire され、`applyTab` / `newTabAndOpen` / `closeTab` で `projectStore = tab.projectStore` 再代入後の新 tab の store は subscriber 0 → overlay 追加しても dirty 通知が来ず toolbar 上書き button が grey のまま。`attachStoreSubscribers()` helper で unsub + re-subscribe を抽象化し、再代入の全 3 箇所で呼ぶ)。/ **スタンプポップアップ位置記憶** (drop 位置を `localStorage.kpdf3.stampPopupPos` に保存、popup 表示時に MutationObserver で `[hidden]` 解除を検知して clamp 付き restore)。/ **画像登録ボタン反応** (`stampRegImagePickBtn` クリック時に `disabled = true` + `textContent = "読み込み中…"` で二重クリック防止、finally でリセット)。/ **印影背景透過** (`color` フィールドに `bg-transparent` センチネル値を追加、`tintCanvasInPlace` / `viewer.applyTintInPlace` / `exporter.getTintedAssetCanvas` 全 3 経路で luminance → alpha のみ枝を追加、`<select id="stamp-reg-image-color">` のデフォルトを `bg-transparent` に)。/ **複数ページ選択 → 単一 PDF 保存** (`actionSavePagesAsPdf(pageNos[])` 新設、`actionSaveSinglePage` は shim、コンテキストメニューの "save-page" 項目はラベル動的更新 + 選択集合チェックで dispatch、`p3-5` 連続 / `Npages` 非連続のファイル名規約)。/ **サムネへの外部 PDF ドロップ拡張** (`body.file-dragging` クラスを document dragenter/dragleave depth counter + window dragend/mouseup で管理、横 gap height 8 → 28px、縦 gap は alignment 維持のため width 維持で色付けのみ、`attachInsertGapDrop` の drop 完了後に `isSplitMode` なら `refreshSplitView()` 明示呼び出し)。/ **commit**: `feat(β4): bug-fix bundle` + `chore(release): bump to 2.0.0-beta.4`、tag `v2.0.0-beta.4`、push 経由で CI release workflow が 6 installer をビルドして Release に attach。 |
| **2026-05-12 後半（β31〜β33 騒動 + Public 化）** | **β31** で D1〜D4 改善を一括投入: D1 印刷テキスト解像感 (paintGlyphRun 統一 + overstroke 0.06 + EXPORT_ZOOM 900dpi)、D2 外部PDF挿入 vector 維持 (`inserted_source_pdfs` 新設 + SHA-256 dedup + 新 strategy `external`、viewer 用 image_blob 144→300dpi)、D3 synthetic 白紙+テキストページを full strategy で PNG 化、D4 テキスト fontId に `numeric` (CrashNumberingSerif+MS明朝) 追加。/ **β32**: 数字 hanko 単軸選択肢の問題 (CrashNumberingSerif cmap が `.`/`E`/`Q`/`R`/`T`/`W`/`Y` 等にもグリフ + fallback 明朝固定でゴシック+数字 hanko 不能) を解消するため、**数字 hanko を独立軸チェックボックスに再設計**。`CrashNumberingDigits` @font-face を新設 (unicode-range `U+0030-0039` で 0-9 限定、stamp 用の `CrashNumberingSerif` フル cmap は残置)、toolbar に「数字 hanko 風」chk 追加、`getTextFontStack(fontId, {digitsHanko})` で stack 先頭に prepend、互換: `fontId='numeric'` は `mincho + digitsHanko=true` に自動解決。/ **β33 撤回騒動**: ユーザー Win 機で β31/β32 が起動直後にクラッシュの報告 → コード上に原因見つからず → 一度 **β33 = β30 baseline へロールバック** を緊急 publish → ユーザー検証で「**β30 を再 install してから β32 にアップしたら何も問題なく動く**」と判明 (autoUpdater の差分 install 由来の一時不整合と推定、コード自体は無罪)。**β33 タグ削除 + main 上で `git revert` で β33 ロールバック commit を打ち消し** (HEAD=β32 内容 + HANDOVER 履歴クリーン化)、k-pdf3-releases の β33 release はユーザーが GitHub UI 手動削除。/ **GitHub Actions Free 枠 (Private リポ 2000 分/月) を連続リリースで使い切ったため開発リポを Private → Public 化**。**HANDOVER.md の個人メアド削除 + 過去全 commit/tag から HANDOVER.md を `git filter-branch --index-filter 'git rm --cached --ignore-unmatch HANDOVER.md'` で抹消** → メアド削除済み最新版を新規 1 commit で再導入 → force push (`origin main` + 全 tag が rewrite された SHA に差し替わる)。これに伴い Ubuntu 本体機などの旧 history を持つクローンは作業開始前に `git fetch --all --tags --force && git reset --hard origin/main` が必須に。/ **未解決**: β31/β32 起動クラッシュの根本原因究明 (再現したら DevTools / Windows イベントビューア / `%LocalAppData%\K-PDF3\logs\` でログ取得)。 |
| **2026-05-12 末（β34〜β35 + CI 案 B-2 + 「後で」仮説）** | **β34 E1**: テキスト関連の overstroke が太字すぎる指摘 → 「太字」chk を独立軸で追加 (デフォルト OFF、`localStorage` 永続)。`paintGlyphRun(ctx, text, x, y, color, fontSize, opts)` に `opts.bold` 追加、stamp/distribute-3 系の opts なし呼び出しは default `bold:true` で印影感維持。**viewer は OFF=素のフォント / ON=CSS `-webkit-text-stroke ${fs*0.06}px currentColor`**、**exporter は常に overstroke** (OFF=`fontSize*0.03` β25 ベース AA halo 補正、ON=`*0.06` β31 と同太さ) で **画面細く・印刷で薄くならない**を両立。/ **β34 E2**: 外部 PDF 挿入の viewer 表示も vector render 化。新 IPC `kpdf3:render-inserted-source-page` で main 側 mupdf doc を `sourcePdfId` キャッシュしてラスタライズ (タブ切替 + before-quit で destroy)。`renderSyntheticPagePixels` に vector path、失敗時のみ legacy image_blob fallback。`renderZoom = viewer._zoom * computeOversample()` を渡すので HiDPI もシャープ。/ **β34 CI 案 B-2**: `release.yml` を 3 OS matrix → 独立 3 job (build-windows 常時、build-macos / build-linux は `if:!contains(ref_name, '-beta')` で stable のみ) に分割。β iteration を 10分→5分に短縮、stable では 3 OS 同時 build。β34 publish 時はまだ古い matrix の状態だったため 3 OS publish された (case B-2 を適用した commit `5b16361` は β34 タグの後だったが、β35 から正常に B-2 動作確認)。/ **β34 配布結果**: ユーザー検証で **autoUpdater 差分アップ成功 (β32→β34)** = β31/β32 起動クラッシュは autoUpdater 経路の一時不整合と確定的判明、加えてユーザー自己分析で **「直前にダウンロードダイアログで『後で』を選んでいた」と判明** → 「後で」仮説 (中間ダウンロード状態残留 → 後続バージョン取得時に不整合) が主因と推定。「太字」OK、「外部 PDF 画質」だいぶ改善も「まだ若干輪郭がはっきりしない」報告。/ **β35 F1+F2**: 残る画質感を 2 段で改善: F1 = viewer canvas に CSS `image-rendering: -webkit-optimize-contrast` で縮小時 smoothing を Chromium sharper resampling に切替 (既存ページにも自然な改善)、F2 = `_ensureRendered` で `row.syntheticSourcePdfId != null` のとき `renderZoom * 1.5` で mupdf に依頼、CSS 縮小後も詳細残るよう oversample 増。純粋な白紙/テキスト synthetic は不要 (renderer canvas で十分鮮明) なのでバンプ対象外。/ **β35 CI**: B-2 適用後の β タグなので `build-windows` のみ実行、`build-macos`/`build-linux` は `skipped` で正常動作確認。/ **積み残し**: 「後で」仮説の恒久対応 (autoUpdater UX 改修 — ダイアログから「後で」撤去 or キャンセル時の差分ファイルクリーンアップ)、β35 の画質確認待ち、長年の C3 annotation read-only proxy、stable リリース時の matrix race 対応。 |

---

## 8. 次にやること（次セッション着手前ガイド）

### 8.1 起動・確認

```bash
cd ~/デスクトップ/k-pdf3
# Ubuntu 本体機など 2026-05-12 以前のクローンの場合、最初に同期 (必須):
git fetch --all --tags --force
git reset --hard origin/main
# 上記が "Already up to date." or "HEAD is now at <SHA>" を表示すれば OK
git log --oneline | head -30       # 最新は β35 (画質改善 F1+F2) のはず
git status                         # 未 commit な変更がないか確認（無いはず）
npm test                           # 既存テスト pass 確認（380/380）
npm run dev                        # electronmon 起動（推奨、自動 reload）
# または npm start                 # 単発起動
```

**重要**: 2026-05-11/12 セッションで β1 → β35 まで進行。**現在は β テストフェーズ** であり、新機能着手より既存配布版へのバグ修正が優先。フローは **§6.4** を参照。

**開発リポは 2026-05-12 後半に Public 化済み** (`windom21-cpu/k-pdf3` 自体が Public)。配布フィードは引き続き `windom21-cpu/k-pdf3-releases`。CI は **案 B-2** で β タグ=Win のみ・stable タグ=3 OS（§12.1 参照）。

### 8.2 短期の優先順（次セッション着手前ガイド）

#### 🔴 着手検討が必要なオープン項目

1. **β35 画質確認 (F1+F2) の実機検証フィードバック待ち**
   - F1 (`image-rendering: -webkit-optimize-contrast`) + F2 (synthetic external PDF を 1.5x oversample) で「だいぶ改善も輪郭まだ甘い」が解消するか
   - 不足なら次の打ち手: mupdf レンダリング側の AA 設定 / oversample をさらに上げる (e.g. 2.0x) / canvas 描画前に sharpening filter / cropbox 考慮の matrix
2. **「後で」仮説の恒久対応** (autoUpdater UX 改修)
   - β34 配布前にユーザー検証で判明: β30 起動時の autoUpdater ダイアログで **一度「後で」を選んだ直後の起動でクラッシュ** していた可能性。「後で」を選ぶと部分ダウンロード/ blockmap キャッシュが中間状態で残り、後続バージョンの取得時に整合性が壊れる仮説 (確証は未取得、再現テストでは「最初から『はい』」経路で起動成功)
   - 対応案 A: autoUpdater ダイアログから「後で」ボタンを撤去 (renderer.js `kpdf3:updater-update-available` のハンドリングを書き換え、「ダウンロード」「キャンセル (次回起動時に再表示)」のみ)
   - 対応案 B: ダイアログキャンセル時に `%LocalAppData%\K-PDF3-updater\` の差分ファイル類をクリーンアップ
   - どちらも β36 規模で着手可能
3. **C3: Adobe で押したスタンプ (annotation) が viewer 表示されない（印刷では出る）**
   - HANDOVER §15.3 の **annotation read-only proxy** が対象。新セッション規模で別建て
   - アプローチ案：source PDF の `/Annots` を読み取り → /AP appearance stream を canvas にラスタライズして overlay として描画（read-only、編集不可）。/AP 無しの annotation はマーカーアイコン + ツールチップで簡略表示

#### 🟢 完了済み (今セッション以降に振り返らない)

β31〜β35 の主要改善 (D1〜D4 / E1〜E2 / F1〜F2) は配布済み。詳細は §6.4 / §7.7 を参照。

#### 🟡 確認待ち項目（実機テスター側）

- **β16〜β28 全体**: 13 件のテスター指摘修正（S/A1/A2/B1〜B4/C1/C2/C4/C5/C6/C7）を 2026-05-12 にまとめて β.N 連続で配布。実機 autoUpdater で β28 まで降り切ったか、業務での体感に問題ないかを聞き取り中。
- **β14/β15 の 4K DPI 改善**: プリンタプロパティダイアログのシャープさ + NSIS installer の DPI 対応をユーザーが 4K Win 機で実機検証中。改善が見られなければ追加調整（DevTools コンソールに `[printer-props] koffi unavailable` 等の fallback ログが出ているかで原因切り分け）。
- **β16 の β6 残存自動掃除**: 新規テスターが β6 系から段階的にアップグレードしてきた場合、`customInit` が UAC を出して旧 install を消す挙動を実機検証。UAC で No を選んだ場合は β15+ 並走になるので、その時の動作も要確認。
- **β24 の印刷ページ番号変換**: 「視覚位置 ↔ pageNo」の翻訳を入れたので、挿入ページや並び替え済 PDF で印刷したときに想定どおり全ページ出るか実地確認。

#### ✅ β15 後のテスター指摘 13 件は β16-β28 で全件着地

| β | 番号 | 内容 |
|---|---|---|
| β16 | S | per-machine 旧 install 残存（NSIS customInit で自動掃除） |
| β17 | A1 | 印刷プロパティの枚数等が反映されない（DEVMODE 取得） |
| β18 | A2 | 上書き保存ダイアログを 下書き／確定 フレームに |
| β19 | B1 | しおり 右クリック + sticky toolbar |
| β20 | B2 | 分割画面選択 → 印刷ダイアログに preselect |
| β21 | B3 | 分割画面 thumb dblclick で閉じてスクロール |
| β22 | B4 | ステータスバーのページナビ ◀ [n] / total ▶ |
| β23 | B2 改 | preselect の isSplitMode race + sidebar fallback + DevTools log |
| β24 | B2 真因 | 印刷ダイアログ全体の 視覚位置 ↔ pageNo 翻訳統一（synthetic 対応） |
| β25 | C1+C2 | テキスト確定時の折り返し維持 + 印刷でテキスト黒の overstroke |
| β26 | C4+C5 | 最後のプリンタ記憶 + .lnk ショートカットフォルダ対応 |
| β27 | C6 | ページ右クリックで モード切替 トグルメニュー |
| β28 | C7 | スタンプ パレット初期未選択 + 試し置きで管理ダイアログも hide |
| β29 | C8+C9+C10+C11 | bg-transparent default 復元 / placement ghost と trial cursor の二重表示抑止 / localStorage 永続化を打ち消す mode-exit クリア / w 変更時の中心保持リサイズ |
| β30 | C12 | 試し置き trial に **角ハンドル 4 つ + ドラッグ移動** 実装 + ダイアログを右上隅 + 透明バックドロップに退避（git 履歴上は初実装）。manager snapshot を openStampRegisterImage で一度きり取得する整理込み |

#### 🟠 繰越項目（次セッション以降に検討）

**まず `§6.4 β テストフロー` を読む**こと。今は機能追加よりも:

1. ユーザー（実機テスト中）からのバグ報告 → 軽微なら即修正 → β.N+1 連番リリース（β5 以降は autoUpdater 経由でテスターに自動配布）
2. β 期間中の追加要望は §17 タスクリストに登録、stable 前にまとめて取り込み判断
3. β 卒業（重大バグなし、業務並走 1〜2 週間）後にフェーズ 2（機能完成）へ

#### β15 → β16+ で着手検討する繰越項目（2026-05-12 時点）

- **β15 後の新規テスター指摘**（実機テスト次第、最優先）
- **CI release matrix race の根治** — β12 で macOS が `tag_name already_exists` の 422 で落ちた transient bug。β13/β14/β15 では運良く踏まずに完走したが、いつ再発してもおかしくない。対策案: (a) pre-create release を別 job で先行実行 → 以降の matrix は `--publish=never` + `gh release upload` のみ、(b) sequential build (速度コスト大)。中規模、テスター影響は小なので優先度は低
- **annotation read-only proxy** — §15.3 参照。/AP の無い annotation をマーカーアイコン + ツールチップで表示する案。新セッション規模
- **qpdf sanitize** — secure export pipeline（配布版の metadata strip / xref rebuild）。qpdf を `extraResources` で各 OS バイナリ同梱して spawn する想定。新セッション規模
- **renderer.js モジュール分離** — §15.6 参照。7500+ 行に肥大。タブ分離 D&D (§17.10) の前段として必須
- **タブのウインドウ外 D&D / ドック復帰** — §17.10 本実装。renderer.js モジュール分離後の本命機能
- **既存マーカーの opacity 移行** — β15 でデフォルトを 0.3 に下げたが、既存マーカーは作成時の 0.5 が保存されたまま。一斉に淡くしたい場合は migration スクリプトで `properties.opacity = 0.3` を書き直すか、user に再配置を依頼するか。優先度は要望次第

#### Z. 既知のフォローアップ（完了済タスクの後始末）

- **Wayland ショートカット** — F5 / Ctrl+R / F12 が Ubuntu GNOME Wayland で発火しない。renderer keydown / before-input-event / globalShortcut / xwayland 強制 / 標準 Menu 経路、すべて NG。バージョン情報ダイアログのリロード / 開発者ツールボタンで代替可。X11 セッションでの動作確認 + xdg-desktop-portal / KGlobalAccel 経由の調査が次の一手（プロジェクトメモリ `project_kpdf3_shortcut_unresolved.md` 参照）。

#### E. ナビゲーション拡張（中）
13. ✅ **D&D で別 PDF をサムネ間に挿入**（§17.3）— 完了。inserted_pages.image_blob 列で image-backed synthetic page。
14. 🚧 **サムネを外部にドラッグして分離保存**（§17.2）MVP 完了。純粋な D&D OUT は Electron `webContents.startDrag` の sync timing 問題で後送り。
15. ✅ **ページポップアップ (§17.4 prelim)** — 2026-05-11 β2 で先行実装。frame:false 別 BrowserWindow に PNG スナップショット表示、複数開閉 / always-on-top / Esc で閉じる。本実装（タブ分離 D&D の上に乗るライブ同期版）はフェーズ 2 に持ち越し。

#### F. M5 正式 exit（残り）
16. ✅ **タブ実装 (Phase 1-7)** — Phase 1 TabState、2 tabs Map + main IPC、3 タブバー UI、4 ファイル＞開く新タブ動作、5 タブ切替、6 dirty 警告、7 動作確認。並び替え D&D もここに含む。詳細は ADR-0015 + §7.7 「2026-05-11」行。
17. ⏳ **タブの分離・結合 D&D** — タブを ウインドウ外にドラッグ → 別ウインドウ化、別ウインドウから戻す → ドック合流（§17.10）。multi-window registry が必要、Phase 1-7 同等以上のサイズ。**β 卒業後** に着手予定。
18. ✅ **CI クロスビルド** — 完了 (β1/β2 で実証済)。アイコン同梱 (favicon-k3) + Release page 自動添付（softprops）動作中。残: Mac 署名 / 公証 secrets、Win コードサイン（任意、stable 時に検討）。
19. ✅ **v2.0.0-beta.1 / v2.0.0-beta.2 タグ** — 2026-05-11 配布開始。実機テストフェーズ進行中。
20. ⏳ **v2.0.0 stable** — タブ分離 D&D + annotation proxy + qpdf 完成 + RC 検証後。

#### 関連の deferred ADR / 機能拡張

- ✅ **しおりの /Outlines 書き出し** (§17.14) — 完了。pdf-lib + UTF-16BE で他ビューア互換。
- ✅ **しおり nested children + drag-reorder** — 2026-05-11 で完了。+/− に加え ←/→ ボタン + Tab/Shift+Tab + 三段ドロップゾーン D&D。
- ✅ **スタンプ：フォント設定ダイアログ（全角・半角別フォント）** — 2026-05-11 で完了。STAMP_FONT_STACKS + localStorage 既定 + 描画時 run 分割。半角既定は CrashNumberingSerif（同梱）。
- ✅ **画像スタンプ：実 PDF 上でのプレ的押印（§17.5 の "できれば"）** — β13 で完了。register dialog の「PDF に試し置き」ボタンで半透明ゴーストをページにピン留め、w/h/色/枠の変更が live 反映。詳細は §6.4 β13 行。
- ✅ **画像スタンプ：色 tint** — 2026-05-11 で完了。luminance → alpha + RGB ← color。register dialog で色選択（朱/黒/青/そのまま）。
- ✅ **画像アイコン同梱 (favicon-k3)** — 2026-05-11 で完了。BrowserWindow + HTML link + 自前タイトルバー。CI で build/icon.{png,ico} を build:icon prebuild から自動生成。
- ✅ **CrashNumberingSerif 同梱** — 2026-05-11 で完了。@font-face で読み込み、半角既定 stack に組み込み。
- **annotation read-only proxy** — §15.3 参照。新セッション規模。
- **qpdf sanitize** — secure export pipeline、配布版の metadata strip。
- **IPAex 同梱** — 出力 PDF はラスタ化されるので強い必要性はない（書き出す側に何かしらの明朝が入っていれば OK）。配布先での字形差異が問題になった時に着手。
- **renderer.js モジュール分離 (§15.6)** — 5800+ 行に肥大。タブが安定したので別 session で 8-10 ファイルに分割推奨。

### 8.3 推奨実装順序（タブ — M5 正式 exit）

タブは大きい。一気にやらず以下の順序で：

1. **設計判断 → ADR-0015**（仮）起草。タブごと workspace + projectStore + history のセット、IPC は workspaceId 引数で識別、main の `activeWorkspace` を Map 化、など
2. **データモデル**：`renderer.js` の module-level state（projectStore / history / viewer / activeSourceName / pendingDeletedPages / workspaceMutated 等）を `TabState` 構造へ整理。`tabs: Map<tabId, TabState>`
3. **main 側の対応**：activeWorkspace を tabId キーの Map に変更、IPC は workspaceId 引数を取る or 「フォーカス中のタブ」を main で記憶して switch-tab 通知。後者の方が IPC 変更が少ない
4. **タブバー UI**：title-bar と menu-bar の間にタブバー row。タブごと閉じる × ボタン、タブの dirty マーク
5. **新規タブ動作**：ファイル > 開く で新タブ追加
6. **タブ切替**：viewer / sidebar / projectStore / history を切替先タブの状態で再描画
7. **dirty 警告**：タブ単位 + ウインドウ閉じ時に未保存タブ一括確認
8. **タブの外部 D&D**: 切り離して別ウインドウ。マルチウインドウサポートが必要（§17.10）
9. **タブのドック復帰**: 別ウインドウのタブをメインのタブバーへドロップで合流

### 8.4 推奨実装順序（CI）

1. **`.github/workflows/build.yml`** — push / PR で各 OS 上で `npm ci && npm test`
2. **`.github/workflows/release.yml`** — tag push（`v*`）で `npm run build:linux/win/mac`、artifact を Release に upload
3. **electron-builder 設定確認** — `package.json` の `build` block。app icon, productName, appId
4. **secrets** — Win code-sign cert / Mac notarization（後回し可）
5. **テストマトリクス** — Linux / Win / Mac × Node 22.22.2

注：CI で Electron native module rebuild の動作 + sandbox なし起動（headless Linux なら xvfb 必要かも）を要確認。

### 8.5 詰まったら確認するポイント

- `§7.6` — 2026-05-10 で追加された内部変更（ページ削除 / 挿入 / Save As 切替 / 検索 / 印刷プレビュー / 自前ウインドウクローム）
- `docs/adr/` 全部 — 設計判断の根拠
- `git log --oneline` — どの commit で何をしたか
- `test/electron-runner.cjs` — Electron 内テスト実行の枠組み
- `test/m3-overlay-persistence.mjs` — overlay 保存・読込の round-trip 例
- `src/main/main.js` — IPC surface 全体像
- `src/renderer/renderer.js` — 1700 行 → 2400+ 行に肥大。リファクタ推奨（少なくとも file-browser / print-preview / search / sidebar-thumbs / split-save をモジュール分離）

### 8.6 ユーザーへの確認タイミング

- ADR 起草後 → 反映前
- スタンプ管理の UI 提案 → 実装前
- タブ実装後 → 複数 PDF dirty 独立確認
- CI 緑後 → アーティファクトのインストール確認
- v2.0.0-beta.1 タグ前 → 全機能の動作確認 + 業務移行の準備

### 8.7 やってはいけないこと

- pdf.js 再導入（mupdf に統一）
- React / Vue / Svelte の導入（自前 Pub/Sub 維持）
- ProjectStore を main に戻す（renderer 側で確定）
- 直結 print（落ちる）
- ProjectStore に同期書き込み（dirty workflow を維持）
- ページ削除を即時 DB 反映に戻す（pendingDeletedPages の意義）
- HANDOVER.md を黙って大幅編集（明示依頼時のみ）

---

## 9. データモデル

### 9.1 SQLite schema

詳細は `schema/schema.sql`。要点：

| table | 主な役割 |
|---|---|
| `metadata` | key/value（schema_version, created_at, source_fingerprint, ...） |
| `source_pdf` | 元 PDF を bit-identical で BLOB 保管（1 行のみ） |
| `pages` | 各ページの mediabox / cropbox / rotation / userRotation |
| `overlays` | overlay object（canonical 座標、type / properties JSON） |
| `overlays_spatial` | R*Tree spatial index（hit-test 高速化） |
| `assets` | 画像 asset（hash dedup） |
| `bookmarks` | しおり |
| `exports` | 配布版 PDF を BLOB で履歴保管 |
| `history` | undo/redo + 監査ログ（command pattern） |
| `settings` | viewport / zoom 等 UI state |
| `overlay_fts` | FTS5 全文検索 |

### 9.2 canonical coordinate（ADR-0003）

- 単位：**PDF point (72dpi)**
- origin：**top-left**
- rotation：**rotation 適用後のユーザー視点**（紙アナロジー）
- 基準矩形：**cropbox**

overlay object はこの座標系のみを保持。PDF native 座標は知らない。
変換は `domain/coord.js` 経由でのみ行う。

### 9.3 overlay object spec

```typescript
type OverlayType = 'text' | 'stamp' | 'image' | 'redaction' | 'line' | 'rect' | 'signature' | 'page_number';

interface Overlay {
  id: string;          // UUID v4
  pageNo: number;      // 1-based
  type: OverlayType;
  // canonical bbox (top-left origin)
  x: number;
  y: number;
  w: number;
  h: number;
  zOrder: number;
  properties: object;  // type-specific (text content, font, color, ...)
  assetId?: string;    // for image-based overlays
  createdAt: string;
  updatedAt: string;
}
```

`properties` は JSON 列。type によって構造が異なる：

```typescript
// text
{ text: string, fontSize: number, fontId: string, color: string, lineHeight?: number }

// stamp
{ kind: 'date' | 'image' | 'text-frame', text?: string, color?: string,
  frame?: 'circle' | 'rect' | 'none', fontSize?: number }

// redaction
{ color: 'black' | 'white', mode: 'draft' | 'applied' }
```

---

## 10. ファイル構成

```
k-pdf3/
├── package.json                          # v2.0.0、deps: better-sqlite3 + mupdf
├── package-lock.json
├── README.md
├── ROADMAP.md                            # 6 マイルストーン
├── HANDOVER.md                           # このファイル
├── .gitignore
│
├── docs/
│   ├── architecture.md
│   ├── glossary.md
│   └── adr/
│       ├── 0001-workspace-sqlite.md
│       ├── 0002-mupdf-layout-engine.md
│       └── 0003-canonical-coordinate.md
│
├── schema/
│   └── schema.sql                        # SQLite DDL
│
├── spike/
│   └── mupdf-layout.mjs                  # mupdf API 検証 spike（commit 済）
│
├── src/
│   ├── domain/
│   │   ├── coord.js                      # ✅ M1
│   │   └── workspace.js                  # ✅ M1
│   ├── backend/
│   │   ├── sqlite-store.js               # ✅ M1
│   │   ├── mupdf-pdf-info.js             # ✅ M1
│   │   └── mupdf-layout.js               # ✅ M1
│   ├── main/
│   │   ├── main.js                       # ✅ M1 skeleton
│   │   └── preload.cjs                   # ✅ M1 skeleton
│   └── renderer/
│       ├── index.html                    # M1 placeholder
│       ├── renderer.js                   # M1 placeholder
│       └── style.css                     # M1 placeholder
│
├── test/
│   ├── coord.test.mjs                    # ✅ 62/62 pass
│   └── m1-exit-criteria.mjs              # ✅ 51/51 pass
│
├── fonts/                                # 空（M4 で IPAex 同梱、M6 で Kosugi 同梱）
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
- `build-essential`（M2 以降必須、Electron native module rebuild 用）

### 11.2 セットアップ

```bash
# Node 環境
. ~/.nvm/nvm.sh
nvm use 22.22.2

# プロジェクト
cd ~/デスクトップ/k-pdf3
npm install
npm run postinstall   # build-essential が必要
```

### 11.3 起動・ビルド

```bash
npm start                # Electron 起動（--no-sandbox 付き）
npm run dev              # electronmon 経由で起動（自動 reload／restart、推奨）
npm run spike            # mupdf API 検証 spike
npm test                 # 全テスト（380 assertion、2026-05-09 時点）
npm run test:coord       # 座標 unit test（plain node）
npm run test:page-registry
npm run test:project-store
npm run test:history
npm run test:m1          # M1 + M3-1 smoke test（electron-runner 経由、ADR-0005）
npm run test:render      # mupdf-render smoke test
npm run test:render-service
npm run rebuild          # better-sqlite3 を Electron ABI で rebuild（手動、postinstall で代用可）
npm run build            # 配布バイナリ（CI 整備は M5 残務）
npm run build:linux
npm run build:win
npm run build:mac
```

### 11.4 動作確認の入口

- **architecture が壊れていないか**：`npm test` が pass するか（現在 380/380）
- **M1 〜 M3-1 確認**：`npm run test:m1` で 51 + 56 = 107/107 pass
- **mupdf 経路確認**：`npm run test:render` / `test:render-service`
- **Electron 起動確認**：`npm start` または `npm run dev`、PDF 開いて編集・保存・書き出し・印刷を一巡
- **手動 sanity check**：PDF を開き、テキスト/印影/墨消し配置 → 保存 → 閉じる → 再オープンで復元、Ctrl+E 書き出し、Ctrl+P 印刷、F4 しおり、分割保存（toolbar）まで一巡する

### 11.5 fontconfig 警告

K-PDF2 と同じく、起動時に fontconfig 警告が出る場合があるが機能影響なし。

---

## 12. リポジトリ・配布

### 12.1 GitHub

- **開発リポ**：[windom21-cpu/k-pdf3](https://github.com/windom21-cpu/k-pdf3)（**Public** に変更、2026-05-12 後半）
  - デフォルトブランチ：`main`
  - GitHub アカウント：windom21-cpu
  - ソースコード一式 + HANDOVER + ADR + CI workflow
  - **Public 化の経緯 (2026-05-12 後半)**: β12〜β32 の連続リリースで GitHub Actions Free 枠 (Private リポ 2,000 分/月、macOS は 10× 換算なので激しく減る) を使い切り CI 停止。Public 化で Actions 完全無料に。AGPL (mupdf.js) 観点でも installer は既に公衆配布されていたため、Public 化でソース公開要件を厳密に満たす方向に。HANDOVER.md の個人メアド記載は `git filter-branch` で全 commit/tag から抹消済、メアド削除版を新規 1 commit で再導入 (force push)。今後は別 history で進行
  - **業務的に隠す価値のあるノウハウ無し**（汎用 PDF Workspace、法律実務向けは UI レベルのみ）
- **公開リリース feed リポ**：[windom21-cpu/k-pdf3-releases](https://github.com/windom21-cpu/k-pdf3-releases)（**Public**、β5 で新設）
  - 中身はビルド済 installer (`.exe` / `.dmg` / `.AppImage` / `.deb`) + `latest*.yml` + `*.blockmap` のみ
  - autoUpdater (`electron-updater`) がここを feed として参照、未認証で読み取り可能
  - 開発リポ → CI (`release.yml`) → fine-grained PAT `RELEASES_REPO_TOKEN` (Contents=Write, Metadata=Read、k-pdf3-releases のみ) で `electron-builder --publish=always` → こちらへ自動 push
  - 手動 push 禁止（CI のみが書き込む）。古いリリース削除は管理者がブラウザ UI から
- **PAT 管理**: 開発リポ Settings → Secrets → Actions に `RELEASES_REPO_TOKEN` を登録。期限 1 year、切れたら fine-grained PAT を再発行して Secret 更新（手順は β5 セッションログ参照）
- **連続リリース時の注意 (β32 騒動から学んだ教訓)**: β.N タグ push のたびに matrix build (Linux/Win/macOS) が走るため、Private 時代は分数消費が激しかった。**Public 化後は無料**だが、autoUpdater で立て続けに 2 段以上のアップグレードがテスター環境に降りると blockmap 差分 install の不整合で起動できなくなる事故が起き得る (β31→β32 連続適用で観測、β34 検証で「後で」を選んだ後の中間状態が真因の可能性も判明)。テスト→修正→リリースの周期はゆとりを持って、できれば一度ユーザー検証完了を待ってから次のタグを切ること
- **CI 案 B-2 (β34 で適用、`release.yml` で実装)**: β タグ (`v*-beta.*`) は **Windows のみ** build、stable タグ (`v[0-9]+.[0-9]+.[0-9]+`、β 無しの命名) で **3 OS 全部** が動く。実装: 単一 matrix を 3 独立 job (`build-windows` 常時 / `build-macos`, `build-linux` は `if: "!contains(github.ref_name, '-beta')"`) に分割。β iteration を 10分→5分に短縮、β 配布での matrix race (β12/β33 で観測した macOS `tag_name already_exists` 422) が構造的に発生しなくなる。**stable タグでの race リスクは残る**ので stable 時は手動で 1 OS ずつシーケンシャル trigger するか、別の対策を検討

### 12.2 旧アプリ（業務継続用）

- リポジトリ：[windom21-cpu/k-pdf2](https://github.com/windom21-cpu/k-pdf2)
- 状態：**v0.27.0 で凍結**、hotfix なし
- v0.27.1 working tree は完全破棄予定
- K-PDF3 v2.0.0-beta.1（M5 完了時）リリース後、徐々に業務移行

### 12.3 配布計画

- **v2.0.0-beta.1〜β4**：Google Drive 経由でテスターに手動配布（β5 以前は autoUpdater 無し）
- **v2.0.0-beta.5+**：autoUpdater 経由で自動配布。**新規テスター初回のみ** Google Drive または k-pdf3-releases の直リンクから installer をダウンロード、以降は起動時にダイアログから 1 クリック更新（β7+ は完全 silent）
- **v2.0.0 stable**：M6 完了時。`releaseType: prerelease` → `release` に切替（または field 削除）が必要
- 配布フォーマット：Win NSIS (oneClick silent install) + portable / Mac DMG (x64 + arm64) / Linux AppImage + deb
- 配布インフラ：GitHub Releases on **公開リポ k-pdf3-releases**（β5+）+ Google Drive (新規テスター用 / 旧 β1-β4)

### 12.4 リリース運用

```bash
git tag -a v2.0.0-beta.1 -m "..."
git push origin v2.0.0-beta.1     # GitHub Actions で自動ビルド + Release 作成（M5 で構築）
gh release edit v2.0.0-beta.1 --prerelease
```

---

## 13. K-PDF2 から継承するもの・捨てるもの

### 13.1 概念として継承

- レトロ UI（98.css + Kosugi）の方向性
- 紙アナロジーの座標系
- IPAex 明朝同梱（K-PDF2 では未同梱、K-PDF3 では M4 で同梱必須）
- CrashNumberingSerif/Gothic（日付スタンプ用）
- 真の墨消し（300dpi ラスタ化）
- ページ単位の回転（input rotation 記録）
- しおりの PDF /Outlines 出力
- PDF 分割保存（カットマーカー）
- タブ・detach window
- IME 対応の苦労（DOM textarea 維持）

### 13.2 完全破棄

- `edits.json` 添付方式（独自路線、K-PDF3 では SQLite に置換）
- `pdf.js`（K-PDF3 では mupdf.js に統一）
- `pdf-lib` を保存処理に使う設計（utility に降格）
- `html2canvas-pro`（v0.27.1 で導入したが完全不要）
- `@pdf-lib/fontkit`（mupdf.js が代替）
- v0.27.1 working tree のすべて
- DOM ベース overlay 描画（Canvas + DOM hybrid に移行）

### 13.3 K-PDF2 からのコード移植は禁止

K-PDF3 はゼロから設計しているため、K-PDF2 の app.js（約 3,800 行）を「参考にして書き直す」のは避ける。代わりに：

- 機能要件は K-PDF2 の HANDOVER.md（旧）から拾う
- 実装は K-PDF3 architecture に沿って **新規に書き起こす**
- K-PDF2 の関数名・データ構造に縛られない

K-PDF2 のソースが必要な時は `~/デスクトップ/k-pdf2/` を参照（gitignore 外、ローカルにある）。

---

## 14. AI セッション交代時の注意

### 14.1 着手手順（毎回）

1. このファイル（HANDOVER.md）を §0 → §1 → §2 → §3 → §6 → §8 の順で読む
2. `docs/adr/` 配下を全部読む（重要設計判断の根拠）
3. `docs/glossary.md` で用語確認
4. `git log --oneline` で最新コミット確認
5. `npm test` で既存テストが pass しているか確認
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

- **Electron 版数を一時固定**（ADR-0004）：better-sqlite3 12.9.0 が Electron 42 の V8 と非互換のため、`electron@^38.8.6` にピン留め中。解除条件は ADR-0004 §解除条件。
- ~~dual-ABI dev workflow~~：**ADR-0005 で解消**。SQLite 依存テストは `test/electron-runner.cjs` 経由で Electron main process 内に走り、Electron ABI build 1 本で `npm start` / `npm test` どちらも動く。
- **Electron 38 の高セベリティ脆弱性 4 件**（offscreen UAF / clipboard クラッシュ / window.open スコープ）：ローカル限定法律実務アプリのため実害低、ただし v2.0.0-beta.1 リリース前に再評価（ADR-0004）。
- **直結 print が落ちる**：OS 印刷ダイアログを `webContents.print({silent:false})` で出すと、ユーザーが dialog を閉じた瞬間に Electron の PDF プラグイン teardown が crash する（Linux + Electron 38 で再現可能）。M5-4 では **独自 dialog + silent print に切替済**。再挑戦するなら別の方法（lp/lpr の `child_process` 直接 spawn など）。
- **空の `fonts/` ディレクトリ**：Kosugi（M6）/ IPAex（M6 後回し）/ CrashNumbering（M5/M6）の同梱は対応 M で実施。
- **userData 集中保管の副作用**：kpdf3 が `~/.config/K-PDF3/workspaces/` に置かれる（ADR-0007）。machine 間移植は手動コピーが必要。M5 / M6 で「workspace export package」UI 検討余地あり。
- **書き出しはラスタライズ**（144 dpi デフォルト、export 時 0 overlay なら byte-copy で text 層保持）：text 層付き flatten が必要なら IPAex 同梱 + mupdf でテキスト書出し（M6 候補）。
- **タブ未対応**：1 ウィンドウ 1 PDF。M5 残務として実装予定。

### 15.2 M5 残務 / M6 で考慮が必要

- **mupdf.js のメモリ管理**：WASM の memory 制約。400 ページ PDF を全部 Pixmap 化するのは無理 → virtualization で解決済（M2）。
- **mupdf.js destroy() 漏れ**：Page / Document / Pixmap / Buffer / Image は全て `.destroy()` を呼ばないとメモリリーク。実装内で try/finally 徹底中。新規 mupdf API 利用時に同じ規律を守ること。
- **better-sqlite3**：renderer から直接呼ばない（main process のみ）。tab 実装時にも同様、main で集約。
- **Pub/Sub の memory leak**：ProjectStore.subscribe / HistoryStack.subscribe は AbortController 受け取り対応済。M3 / M5 の使用箇所で漏れなし、新規 subscribe 追加時は signal 渡し推奨。
- **renderer-side ProjectStore vs main-side**：M3-1 で renderer 側採用と決定。tab 実装時、ProjectStore を「タブごとにインスタンス」化する設計が自然。
- **資産（asset）DB 共有**：HANDOVER §15.4 で予告した「共通 asset library」は M3 / M4 で議論したが未着手。当面 source_pdf BLOB が個別 kpdf3 に重複保存される（ADR-0008 で exports BLOB は廃止済、source_pdf BLOB は維持）。容量肥大が問題になれば ADR-0018（仮）候補。

### 15.3 将来の判断ポイント

- **タブ実装**（M5 残務）：multi-workspace に向けた main / renderer 状態モデル refactor。ADR-0015（仮）で議論してから着手。
- **CI クロスビルド**（M5 残務）：GitHub Actions matrix、electron-builder、Mac notarization は配布直前。
- **IPA 明朝の同梱方法**（M6 後回し）：fonts/ 配下に置く方針は確定。テキスト層 flatten export が要件化したら本格実装。
- **qpdf の同梱方法**（M6）：sanitize 層が必要になったら electron-builder の `extraResources` で各 OS バイナリ同梱。M5 範囲では未着手。
- **検索機能**（M6+）：FTS5 はあるが UI 未着手。
- **annotation read-only proxy**（M6）：/AP がない annotation の表示方針（マーカーアイコン + ツールチップ案で確定済み）。
- **userData の workspace を別 PC へ持ち運ぶ UI**（M6）：現状は手動コピー。export package（zip）で集約する案あり。
- **asset DB 共有 by SHA-256 dedup**（M5 / M6）：source_pdf BLOB の重複削減。HANDOVER §15.4 で承認済の方針、ADR-0008 §解除条件で言及。
- ✅ **自動アップデート組込み** — β5 で完了。`electron-updater@6.8.5` (exact 固定) + `src/main/updater.js` + 98 風 confirm/busy modal。公開 feed リポ `windom21-cpu/k-pdf3-releases` を新設、CI が `--publish=always` で direct push。詳細は §17.15 ✅ + §6.4 β5 行。
- ✅ **ハイブリッド PDF 組立の回転ページ対応** — β8 で完了。`_placeRotatedSourcePage()` で pdf-lib `embedPdf` + `drawPage` (translation table + degrees(userRot)) → 回転ページも vector 維持、サイズ激減。詳細は §17.16 末尾 + §6.4 β8 行。

### 15.4 architecture decision 待ち（未確定）

- 共通 asset library の DB 配置：アプリ全体で 1 つの SQLite ファイル（`~/.config/K-PDF3/assets.db`）に保存する方針はユーザー承認済。実装は M6。
- パスワード保護 PDF 対応：将来検討（M6 以降）。
- ブランディング：アプリ表示名は K-PDF2 のまま維持（リポジトリ名のみ k-pdf3）。

### 15.5 ADR 状況（2026-05-10 セッション分）

5 本起草済み（2026-05-10）。次セッションで未着手の機能は実装着手前に起草：

- ✅ **ADR-0009 (page deletion)**: workspace-level page hide via `is_deleted` flag、pending workflow、page-registry sparse pageNo 対応
- ✅ **ADR-0010 (page insertion)**: `inserted_pages` テーブル、negative pageNo 同定、synthetic page rendering pipeline (renderer-side canvas)
- ✅ **ADR-0011 (Save As workspace switch)**: Word 流 Save As の semantics、byte-copy 検出ロジック (overlay + deletion + insertion 全部 false 必須)
- ✅ **ADR-0012 (HiDPI render quality)**: `RENDER_QUALITY_MULTIPLIERS` ＋ DPR 連動 oversample
- ✅ **ADR-0013 (custom title bar / file dialog)**: frame:false の決定、自前ファイルブラウザの 3 モード方式
- ✅ **ADR-0014 (editable bookmarks)**: 起草済 (2026-05-10) + 実装済 (2026-05-10 終盤)。workspace bookmarks 優先 + FK 削除 migration + +/−/取込 CRUD UI + export 時の /Outlines write-back (pdf-lib + UTF-16BE)
- 📝 **ADR-0015 (tab / multi-window, 設計編 起草済 2026-05-10)**: 案 B (renderer 主体タブ管理、main は単一 active 維持) を採用。実装前に renderer.js モジュール分離リファクタが必須（§15.6 と統合）。**タブ実装本体は次セッション**。
- ✅ **ADR-0016 (stamp templates MVP)**: 起草済 (2026-05-10)。当初の hardcoded template MVP は ADR-0019 へ吸収（実装は終盤セッションで本格化）
- ⏳ **ADR-0017 (image stamps / asset library, partial impl)**: 画像スタンプの MVP は実装済 (2026-05-10 終盤、assets table + SHA-256 dedupe)。フル ADR の起草は assets 共通化方針も含めて次セッション
- ⏳ **ADR-0018 (asset DB / source_pdf BLOB 共有, future)**: §15.3 容量肥大が現実化したら起草
- 🚧 **ADR-0019 (stamp preset management, partial impl)**: stamp_presets テーブル + 4 種ボタン + register dialog 3 種 + popup palette + 編集 (upsert) は実装済 (2026-05-10 終盤)。全角・半角フォント別指定 (2026-05-11) と印影画像の **PDF プレ的押印** (β13、2026-05-12) も完了。ADR ドキュメント本体の起草はまだ

### 15.6 リファクタ候補

- **`src/renderer/renderer.js` が 4500+ 行（最重要、タブ実装の前提）**: file-browser / print-preview / search / sidebar-thumbs / split-save / insert-dialog / stamp-manager / callout-mode / marker-mode / bookmark-pane / etc. をモジュール分離。ADR-0015 のタブ実装本体に着手する **前段** に必須。現状のグローバル module-level state（projectStore / history / viewer / pendingDeletedPages / workspaceMutated / activeSourceName / placementMode / 各種 *Cache / 各 dialog の state）を `TabState` 構造化して 1 ヶ所に集約する作業と統合できる。
- **`workspaceMutated` フラグはやや hacky**: 挿入も pending workflow に統合する方が綺麗（temp pageNo 採番 + Ctrl+S で flush）。ただし削除と並列管理になり複雑度増、現状の hack で実用上は十分
- **`activeSourceName` の管理場所**: 現在 renderer state、IPC で再取得時に上書き。Save As 切替後は IPC 経由でファイル名を取得するパスに統一する方がよい（部分的にやっているが完全ではない）
- **テストカバレッジ不足**: 2026-05-10 の追加分（ページ削除 / 挿入 / Save As / 検索 / スタンプ管理 / 画像スタンプ / 編集可能しおり / callout / 自動リサイズ）は手動確認のみ。Electron runner で round-trip テストを追加すべき。特にスタンプ管理 + assets 周りは migration 多め

---

## 16. 引き継ぎ運用

### 16.1 HANDOVER.md 更新ルール

- **明示的に依頼された時のみ大幅更新**
- マイルストーン完了時は §6.3 の状態欄と §7（完了したこと）を更新
- 新しい ADR を起草したら §4.4 / §15 に反映

### 16.2 バージョンバンプ運用

- マイルストーン完了ごとに pre-release タグ（例：`v2.0.0-alpha.M2`）
- M5 完了で `v2.0.0-beta.1`
- M6 完了で `v2.0.0`
- 影響箇所：
  1. `package.json` の `version`
  2. `src/main/main.js` 起動時 log
  3. Electron BrowserWindow の title（M3 で設定）
  4. About ダイアログ（M3 以降）

### 16.3 コミット運用

- メッセージ規約：Conventional Commits（feat / fix / chore / docs / refactor / test）
- マイルストーン完了は `feat(MN): ...` のプレフィックス
- 重要な commit には Co-Authored-By を残す
- destructive 操作（force push / reset --hard）は **ユーザーの明示同意なしに行わない**

### 16.4 Pull Request

- 個人＋スタッフ規模なので main 直接コミット OK
- 大規模変更（新マイルストーン）は feature ブランチ + PR が推奨
- マージ前に `npm test` 必須

---

## 17. ユーザー要望タスクリスト（2026-05-10 セッション分）

ユーザーがセッション末尾に書き出した中期タスク。優先度や順序はユーザー判断、ここでは項目だけ詳細化。各項目は §8.2 の番号と対応している。

### 17.1 警告ダイアログの独自モーダル化（UI 統一）✅ 完了 (2026-05-10)

`window.confirm` を使っている残箇所をすべて 98.css 風カスタムモーダル化。既存の `#open-dialog` / `#print-dialog` / `#about-dialog` パターン踏襲。

**該当箇所**: `confirmDiscardIfDirty`、`deleteSelectedPages`、Save As 上書き確認、複数の重複確認系。

### 17.2 サムネ → アプリ外への D&D で当該ページを名前付き保存 🚧 MVP 完了 (2026-05-10): サムネ右クリック→「このページを PDF として保存…」で代替。純粋な D&D OUT は別セッションで（Electron startDrag の sync 問題があり）。

サイドバーまたは分割保存のサムネを、デスクトップ等に D&D したら、そのページだけを抽出して新規 PDF として保存（名前は元PDF名 + ページ番号など）。

**実装メモ**: HTML5 D&D の `dragstart` で `dataTransfer.setData("DownloadURL", ...)` を仕込めば可能。Electron 特有 API も併用が必要かも。

### 17.3 サムネ間に外部 PDF を D&D で挿入 ✅ 完了 (2026-05-10): inserted_pages.image_blob で image-backed synthetic page。insert-gap への drop で 144 dpi raster + INSERT。drop-target ハイライト + busy 表示

サムネ間の挿入位置に外部 PDF ファイルをドロップ → そのページ群を挿入。

**実装メモ**: 既存の挿入機構（synthetic page）の延長ではなく、別の「外部 PDF 取り込み挿入」が必要。または mupdf でページを抽出して synthetic page にラスタライズするか、別 PDF ページを直接 PDF 構造に取り込む（複雑）。MVP として「ラスタライズ後 synthetic」が無難。

### 17.4 別ウインドウでページ分離表示（比較用）✅ MVP 完了 (2026-05-11 β2):

実装メモ:
- toolbar「別窓」ボタン → `actionOpenPagePopup()` → composeSinglePageCanvas で現ページ + overlays を 2x で PNG 化 → main の `kpdf3:open-page-popup` IPC で frameless BrowserWindow を作成 → `kpdf3:popup-data` で payload 送信 → page-popup.js がイメージを表示
- 22px Win95 風タイトルストリップ（drag 領域 + 📌 always-on-top + × close）
- Esc キーで閉じる、複数同時オープン可、各ポップアップは独立した「スナップショット」（編集追従なし）
- 関連ファイル: `src/renderer/page-popup.html` / `src/renderer/page-popup.js` / `src/main/main.js`（kpdf3:open-page-popup / toggle-always-on-top / resize-popup-to-fit + sender-aware window-close）

🚧 残: タブ分離 D&D が完成すれば、ライブ同期版（タブ切り離し → 別ウインドウとして残す）を本実装可能。それまではこの「凍結 PNG スナップショット」型で β業務テスト用途を満たす。

### 17.5 スタンプ管理実装（M6 大物）✅ 完了 (2026-05-10/11):
- スタンプ管理ダイアログ + 4 ボタン（日付 / テキスト / 画像 / **フォント設定**）
- 3 つの register dialog（日付 / テキスト / 画像）— プレビュー canvas、色、枠あり/なし、名前
- 日付 4 形式: `-8.-5.-9`, `-8．-5．-9` (ピリオド全角), `令和-8年-5月-9日`, **`-8 -5 -9` (年月日に揃える / 字間調整、distribute-3 描画)**
- 編集（既存 preset から register dialog 再オープン、upsert で sort_order 維持）+ 削除
- floating popup palette でスタンプボタン押下中ずっと表示、別 preset を選択して連続押印可能、sticky mode
- 画像スタンプ完全対応（assets table + SHA-256 dedupe、viewer/exporter 描画、回転対応）+ **色 tint** (luminance → alpha + RGB ← color)
- stamp_presets テーブル + idempotent migration
- **フォント設定ダイアログ** (ADR-0019 後半): 全角・半角別 stack、localStorage 永続、描画時 run 分割、CrashNumberingSerif 同梱で「数字明朝」既定提供
- **日付スタンプの per-preset fontSize** (登録ダイアログのサイズ入力)。box 寸法は fontSize に比例
- **ハイフン=ゼロ埋め論理** 修正: 1 桁の値だけ `-N`、2 桁以上はそのまま (10 にハイフンつかない)

ツールメニューの「スタンプ管理...」を実装。

**機能**:
- **日付スタンプ**:
  - `-8.-5.-9` 形式 と `令和-8年-5月-9日` 形式（自動切替 or 選択式）
  - フォント別指定: 全角フォントと英数字フォントを別々に設定可能
- **テキストスタンプ**: 自由テキストを入力してスタンプ化
- **画像スタンプ**: 印影画像など
- **共通**:
  - 色選択: 黒 / 白 / 青
  - 枠囲みあり / なし（日付・テキスト）

**設計メモ**: スタンプ定義をプリセットとして保存（workspace 単位 or アプリ全体？）。プリセット選択 → toolbar 押下で配置モード。ADR-0016 候補。

### 17.6 マーカー機能実装（M6 placeholder 既設）✅ 完了 (2026-05-10): type='line' kind='marker' で sticky モード + 4 色 + thumb 反映

ツールメニュー / toolbar の「マーカー」を実装。

- 文字選択ができるかどうかに関わらず、横方向に直線的に引ける（フリーハンド or 直線確定）
- 色選択可能

**実装メモ**: 新 overlay type "marker"。drag で範囲指定 → 太い半透明の線を描画。

### 17.7 吹き出しテキスト実装 ✅ 完了 (2026-05-10 終盤): type='rect' kind='callout'。
- ドラッグでクリック=矢印先端、リリース位置=テキスト末端アンカー
- 三角の矢じり（viewer SVG marker / exporter ctx.fill 三角形）
- テキスト枠: 細い 1px 枠 + 半透明白背景
- 編集確定で text に応じて w/h 自動 fit (canvas measureText)
- リサイズで折り返し時の h 自動上書き（CJK 対応の codepoint 単位 wrap）
- 回転時 arrowDx/Dy も rect 行列で transform（90/180/270 すべて）
- inline edit 中も矢印 SVG / × ボタンを保存して再 attach
- commit 時の textContent から `<svg>` / `.overlay-close-btn` を除外（"×" 混入バグ修正済）
- 余白 padding は CALLOUT_PAD_X/Y / LINE_HEIGHT 定数で renderer / measure 同期
🚧 残: 矢印 tip ドラッグハンドル（properties.arrowDx/Dy 編集 UI）

矢印 + 四角で囲った吹き出しテキストを書ける。

**実装メモ**: 新 overlay type "callout"。テキストボックス + 矢印（始点・終点）。drag で配置、テキスト編集可能。

### 17.8 テキスト入力時のカーソル / 配置位置改善 ✅ 完了 (2026-05-10): I-beam cursor + クリックでボックス垂直中心一致 + 1 行分の高さ

現状: テキストモードでカーソルが `+` 風表示で「文字がここから入力される」イメージが弱い。

**改善**:
- カーソルを `I` ビーム（CSS `cursor: text`）に
- クリック位置を **テキストの左端** に対応させる（現在は中心？要確認）

### 17.9 テキスト入力のフォント指定 ✅ 完了 (2026-05-10): 明朝 / ゴシック / Serif / Sans の 4 種、デフォルト明朝、localStorage 永続、編集中の overlay にも live 反映

テキスト overlay 配置時にフォントを選べる。デフォルト: **MS 明朝**（IPAex 明朝が無ければ system fallback）。

**実装メモ**: text overlay properties に `fontId` 追加（既に schema にあるかも）。toolbar 「テキスト」モード時に右側パネルで選択。

### 17.10 タブのウインドウ外 D&D（タブ実装後）

タブをウインドウ外に D&D → 別ウインドウになる（Chrome / Firefox / Edge 流）。逆に別ウインドウのタブを元タブバーに重ねたら戻る。

**実装メモ**: タブ実装後の追加機能。マルチウインドウ間で workspace state を移動する仕組みが必要（main process が tab レジストリを持つ形）。

### 17.11 回転機能の実装（toolbar placeholder 既設）✅ 完了 (2026-05-10): toolbar ↺ ↻ + サムネ右クリック menu + 挿入ページも対応 + overlay 紙メタファ追従 (rect transform + content rotation) + zoom-fit 再適用

toolbar の ↺ / ↻ を実装。`Workspace.setPageRotation(pageNo, rotation)` 追加 → DB の `pages.user_rotation` を更新 → viewer 再描画。`coord.js` の rotation transform は既に対応済。

### 17.12 テキスト入力フォントサイズ調整 ✅ 完了 (2026-05-10): 8/10/12/14/18/24/36 のプリセット select、編集中も live 反映

デフォルト 12pt。toolbar 「テキスト」モード時にサイズ選択（プリセット 8/10/12/14/18/24/36 など + カスタム入力）。

**実装メモ**: text overlay properties に `fontSize` （既存）。配置時の既定値を変更 + 編集中の overlay にもサイズ変更 UI を出す。

### 17.13 墨消し白を実装 ✅ 完了 (2026-05-10): toolbar 黒/白 select、最後の選択を localStorage に保持、drag preview も色を反映

既存「墨消し」は黒塗りのみ。色プロパティ追加で「黒」「白」を選択可能に。配置時のデフォルトはユーザー選択（最後に使った色を記憶）。

**実装メモ**: redaction overlay properties に `color: 'black' | 'white'` （既に schema にある可能性）。toolbar / context menu で切替。

### 17.14 しおり追加・編集（互換性維持）✅ 完了 (2026-05-10/11/β3):
- workspace bookmarks (id + title + pageNo + parentId + sortOrder) + サイドバー +/−/←/→ + 双クリックリネーム
- export 時に PDF /Outlines として書き出し（pdf-lib 経由 + UTF-16BE/PDFHexString で CJK 文字化け解消、**再帰的 First/Last/Prev/Next/Count で nested children も他ビューア互換**）
- 元 PDF /Outlines を取込 → workspace bookmarks に変換して編集可能化（**取込時に階層保持**）
- **2026-05-11**: nested children + drag-reorder UI 追加。Tab/Shift+Tab で indent/outdent、HTML5 D&D で 三段ドロップゾーン（上=兄弟前、中=子化、下=兄弟後）、moveBookmark IPC で reparent + 兄弟順序変更、循環防止チェックあり
- **β3 (2026-05-11)**: 「取込」ボタン廃止、`openPdfPath` で workspace.bookmarks 空 + outline 非空なら自動取込。ツールバーボタン (+/-/←/→) 高さ 22→9px に縮小

read-only から add / edit / delete に。**互換性**: PDF /Outlines を上書きするのではなく、workspace の `bookmarks` テーブルに保存し export 時に PDF /Outlines として出力。

**実装メモ**: §15.5 の ADR-0014 で詳細起草 → §17.14 で実装。記憶済みの project memory `project_kpdf3_bookmarks_planned.md` も参照。

### 17.15 自動アップデート組込み ⏳ β5+ 候補

β4 時点ではアプリ起動時のアップデートチェックが**未実装**。新バージョン (β5 / stable) を出してもテスターは GitHub Releases から手動で installer をダウンロードして上書きインストールする必要がある。

**現状**：
- electron-builder が副産物として `app-update.yml` を install dir に置いており、`owner: windom21-cpu / repo: k-pdf3 / provider: github` で update feed の指定だけは存在
- しかし `electron-updater` パッケージが依存に入っておらず、`main.js` で `autoUpdater` を呼ぶコードもないので何も走らない

**実装方針**：
1. `npm i electron-updater@<exact>` （ライセンスを再確認、現行は MIT で配布）
2. `main.js` 起動時に `autoUpdater.checkForUpdatesAndNotify()` を呼ぶ（または `--no-update` フラグでスキップできる開発オプションを追加）
3. 「新しいバージョンが利用可能：v2.0.0-beta.N に更新して再起動しますか？」のカスタムダイアログを 98 風で出す（busy-modal の流儀に合わせる）
4. macOS は code-sign が必須（β1 で notarization secrets 未整備のため留保中）。Win / Linux は無署名でも auto-update 動作可
5. テスト：β4 → β4+1 の経路で実機検証

**β5 で着手判断**：テスター負担（毎回 GitHub Release を見にいく）が β 期間で蓄積するなら優先度上げ。stable 移行後は必須機能。

### 17.16 β3 → β4 のテスター指摘（一覧、全件 β4 で対応済）

| # | 指摘 | β4 対応 |
|---|---|---|
| 1 | スタンプポップアップの位置を変更できるように | ✅ 位置を localStorage 永続化 |
| 2 | テキストの色を設定できるように | ✅ mode-options に color select 追加 |
| 3 | 書き出しで PDF 劣化（罫線も文字もぼんやり） | ✅ ハイブリッド組立で vector 維持、サイズも 100MB→300KB クラス |
| 4 | 既存 PDF を上書き保存できない（toolbar 上書きがグレーのまま） | ✅ actionSave を Word Ctrl+S 化、confirm + 元 PDF 上書き |
| 5 | テキスト入力が長くなるとテキスト枠が広がらない | ✅ 編集中 max-content + 紙幅 max-width、確定時 measureTextOverlaySize |
| 6 | テキスト入力中に改行ができるように | ✅ Enter→改行、Ctrl+Enter 確定、innerText で取り出し |
| 7 | 複数ページ選択を 1 つの PDF として書き出し（右クリック保存が単ページのみ） | ✅ actionSavePagesAsPdf、メニューラベル動的 |
| 8 | 外部 PDF をサムネにドロップする領域が狭い | ✅ body.file-dragging で gap 8→28px に膨張 |
| 9 | 分割画面のサムネに外部 PDF をドロップしても追加が見えない | ✅ drop 後 refreshSplitView() 明示呼び出し |
| 10 | 入力したテキスト枠のコピペ | ✅ Ctrl+C/V + 右クリックメニュー |
| 11 | 画像登録時の画像選択ボタンの反応が悪い | ✅ クリック時に即無効化 +「読み込み中…」表示 |
| 12 | 画像登録した画像の背景透過 | ✅ color select に bg-transparent、デフォルト化 |
| 13 | 入力したテキスト枠の複数選択 | ✅ **β6 で完了**：`selectedOverlayIds: Set<string>` 化、Ctrl/Cmd+click toggle、Shift+click reading-order range、`reapplySelectionDom` を多重対応、`CompositeCommand` で多重 Delete 1 undo 単位 |
| 14 | 複数選択テキスト枠の左/上/右/下揃え | ✅ **β6 で完了**：`#align-bar` (2+ 選択時のみ表示、左/上/右/下 4 ボタン)、`alignSelectedOverlays(edge)` でページごとに min/max 計算、`CompositeCommand` で 1 undo 単位 |
| 15 | 印刷準備ダイアログで中止できるボタン | ✅ busy modal に中止ボタン + cancelPrint IPC |
| - | 印刷フリーズ (FUJIFILM 無線複合機) | ✅ SumatraPDF 同梱で Chromium silent print を経由しない経路を新設 |
| - (§17.15) | 自動アップデート | ✅ **β5 で完了**：electron-updater@6.8.5 + 98 風ダイアログ + ヘルプ＞更新を確認... + 公開 feed リポ |
| - (§15.3 末尾) | ハイブリッド PDF の回転ページ対応 | ✅ **β8 で完了**：`_placeRotatedSourcePage()` で embedPdf + drawPage、回転ページも vector 維持 |

**全 14 項目 + 残繰越 3 件、β5-β8 で完了**。次の β は新たなテスター指摘待ち、または §8.2 の繰越項目（annotation proxy / qpdf sanitize / renderer.js モジュール分離 / タブ分離 D&D）への着手。

---

## 18. ユーザー要件・嗜好（メモリ情報）

### 18.1 最重要要件

- **「レトロなアプリの再現を重要視」**（98 風）
- ローカル完結（個人情報を扱うため、クラウド送信 NG）
- 配布範囲：自分中心 + スタッフ数名（一般公開しない、AGPL OSS 化判断は将来）

### 18.2 UI / フォント

- UI フォント：**MS UI Gothic**（2026-05-10 で確定、Kosugi は不採用方針へ）
- PDF 出力フォント：**IPAex 明朝**（M6 で同梱必須）
- 日付スタンプ用：**CrashNumberingSerif**（PSY/OPS Freeware、同梱）
- 文字レンダ: AA off、`font-render-hinting=none`、`disable-font-subpixel-positioning` で pixel-grid 寄せ

### 18.3 業務想定

- 法律実務（回転日付印書式 `-8.-5.-7`、真の墨消し、再編集可能保存）
- 提出版の真正性確保（workspace 内に export 履歴 BLOB 保管）
- iPad 双方向ワークフローは **諦める**（§13.2）

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
| source PDF | 編集の出発点となる元 PDF（immutable） | docs/glossary.md |
| export | workspace → flatten PDF | docs/glossary.md |
| secure export | metadata strip 等を施した export | §15.3 |
| revision id | export ごとに発行される ID | docs/glossary.md |
| dirty | workspace 未保存 | docs/glossary.md |
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

→ **§14 AI セッション交代時の注意**。着手前のチェックリストを実行。

---

以上。質問があれば過去の git log（`git log --oneline`）、`docs/adr/`、`docs/glossary.md`、ユーザーのメモリディレクトリ（`~/.claude/projects/-home-sk--------k-pdf2/memory/`）も参照しつつ進めてください。

新しいセッションでは、まず以下を実行してから着手すること：

```bash
cd ~/デスクトップ/k-pdf3
git log --oneline | head -10
npm test
cat HANDOVER.md | head -100
```
