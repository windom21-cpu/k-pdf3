# ADR-0022: セキュア書き出し — qpdf によるメタデータ sanitize

- 日付: 2026-07-10
- ステータス: **実装済（遡及起草 — REVIEW-2026-07 #7。実装は β.84〜、qpdf 3 OS 同梱済）**
- 関連: ADR-0008（byte-copy ベースの別名保存 — 本 ADR の sanitize は byte-copy 経路にもゲートが要る）、ADR-0025（パスワード PDF 復号 — 同じ qpdf バイナリを `--decrypt` で共用）、ADR-0026（戻せる確定 — sanitize はディスクのフラット版のみ、内部マスターは非対象）、HANDOVER §6.4（β.84/β.85/β.86）・§8.2（qpdf 3 OS バンドル）

## Context

### 法律実務での提出物からの内部情報漏えいリスク

K-PDF3 の主用途は、受信 PDF に編集を加えて **裁判所・相手方代理人・行政庁へ提出する PDF を作る**こと。ところが PDF は見た目に現れない内部情報を運ぶ：

1. **Info 辞書**（Author / Title / Subject / Keywords / Creator / Producer / CreationDate / ModDate）— 作成者名（PC のログイン名等）、元ファイル名や事件名を含む Title、作成日時。相手方に「いつ・誰が・何というファイル名で作ったか」が渡る。
2. **XMP `/Metadata` ストリーム** — 文書レベルの XMP にも同種の情報が重複して残る。
3. **incremental save の履歴** — PDF は追記保存でき、追記版には**過去の版（先行ドラフト）のオブジェクトが丸ごと残留**しうる。
4. **墨消し下のテキスト** — 黒塗り overlay を重ねただけでは、Adobe でテキスト選択・検索・抽出すると**下の文字が取れる**（構造的リーク）。

Adobe Acrobat には「非表示情報を検査」があるが、事務所の運用は K-PDF3 で完結させたい。提出版を作る書き出しの瞬間に、アプリ側で確実に消す仕組みが必要だった。

## Decision

**外部バイナリ qpdf（12.3.2、Apache-2.0）を同梱して spawn し、書き出し直前の PDF バイト列を sanitize する**（β.84、2026-05-17）。書き出しダイアログに「セキュア書き出し」チェックボックスを置き、ユーザーが制御できるようにする。

### 1. 何を消すか（`src/main/qpdf-sanitize.js` の実引数から）

qpdf を `--warning-exit-0 --remove-info --remove-metadata in.pdf out.pdf` で実行：

| 対象 | 手段 | 効果 |
|---|---|---|
| Info 辞書全体（Author / Title / Subject / Keywords / Creator / Producer / CreationDate / ModDate） | `--remove-info` | ユーザー特定フィールドが 1 つも残らない |
| 文書レベル XMP `/Metadata` ストリーム | `--remove-metadata` | XMP 側の重複情報も除去 |
| incremental save 履歴 | qpdf が xref をゼロから再構築 + 全オブジェクト renumber | 追記に残った先行ドラフトを消滅させる |

### 2. 何を消さないか

- **しおり（/Outlines）は保持**。qpdf が落とすのはカタログの `/Metadata` と trailer の `/Info` だけで、ページツリー + outlines ツリーは無傷（業務でしおり付き提出物を作るため必須要件）。
- **ページ内容（ベクター・テキスト層）は不変**。sanitize は画質・検索性を劣化させない。
- object-stream / linearization の変換は**意図的に使わない**（バイナリ署名が変わり、スキャンワークフローの古い Acrobat が警告を出す事例があるため）。

### 3. 墨消し下の文字（β.85「真の墨消し」）

sanitize だけでは 4. のリークは消えない。redaction overlay を含むページは `rasterRedactionPages: true` で strategy="full" に強制し、**ソース PDF の vector text 層ごと 900dpi ラスタに焼く** → テキスト抽出が構造的に不可能になる。書き出し 4 経路 + 分割保存 + 印刷 3 経路の全 8 callsite に適用。なお現行実装ではこの格上げは**再合成経路で常時有効**（チェックボックスに依存しない — `renderer.js:4196` ほか）。チェックボックスのラベルは β.85 で「個人情報・編集履歴・墨消し下の文字を消去」に拡張した。

### 4. UI: チェックボックス（既定 ON・選択を永続化）

- save モードのカスタムファイルダイアログ（名前を付けて保存 / 範囲書き出し / 選択ページを PDF 保存）に表示（`file-browser.js` `secureExportToggle`、`index.html` `#open-secure-export`）。
- **既定は ON**（初回は checked）。OFF にした選択は `localStorage("kpdf3.secureExport")` で記憶され、次回以降も維持される。※「opt-in（既定 OFF）」ではない — 提出物作成が主用途なので消す側を既定にした（β.84 changelog「デフォ ON」）。
- β.84 当初は 98.css 非互換の `<label><input></label>` 入れ子で **input 自体が描画されず気付かれなかった** → β.86 で `<input><label>` 並列構造 + 区切り線 + bold に修正（配布フィードバック起点の hotfix）。
- 分割保存（folder picker 経由）には secure UI 未提供（HANDOVER §17 #17、白黒のみ提供）。

### 5. バイナリの解決順序と 3 OS 同梱

`findQpdfBinary()`: ① `process.resourcesPath/qpdf/`（electron-builder `extraResources`）→ ② `vendor/qpdf/{win,mac,linux}/`（開発時）→ ③ PATH（system qpdf）→ 全滅なら null。

| OS | 配置 | 経緯 |
|---|---|---|
| Win | `vendor/qpdf/win/` flat（qpdf.exe + DLL 同階層、8.2 MB） | β.84 (2026-05-17) |
| Linux | `vendor/qpdf/linux/bin+lib`（公式 portable、SHA256 検証） | 2026-06-03 / β.145 |
| Mac | `vendor/qpdf/mac/bin+lib`（arm64、M1 実機で Homebrew 版を `install_name_tool` 手動バンドル + ad-hoc 署名） | 2026-06-05 (commit `5a52bbb`) |

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. qpdf 外部バイナリを spawn（採用）** | ✅ | `--remove-info/--remove-metadata` は目的専用オプションで消し漏れリスクが最小。**xref 完全再構築 = incremental 履歴の消滅**が副作用でなく仕様として得られる。ベクター無劣化。Apache-2.0 + spawn なのでリンク制約なし。ADR-0025 の `--decrypt` にも同じバイナリを共用 |
| B. pdf-lib で Info キーを自前削除 | ❌ | Info の各キーを消せても **XMP ストリームと incremental 履歴が残る**。全オブジェクト再書き出しを自前で正しくやるのは実質 qpdf の再実装。pdf-lib は壊れかけ PDF に厳格で失敗しやすい（HANDOVER §15 の flate 事例） |
| C. mupdf の再保存で代替 | ❌ | 同梱済みで追加バイナリ不要という利点はあるが、Info/XMP の**選択的除去**は API が目的用でなく、何が残るかの保証を自前検証で積む必要がある。sanitize の正しさを枯れた専用ツールに委ねる方が法的説明責任に向く |
| D. 常時 sanitize（チェックボックス無し） | ❌ | 未編集 PDF の保存まで**常にバイト列が変わる**（ADR-0008 の byte-perfect コピーが成立しなくなる）。原本性を保ったコピーが要る場面・メタを意図的に残す内部文書のため、ユーザー制御を残し既定 ON とした |

**外部バイナリ同梱の判断**: spawn 方式は N-API バインディング（better-sqlite3 で苦労済み）と違い Electron/ABI 更新に無縁で、SumatraPDF 同梱（β.4）で確立済みのパターン。tmp ファイル経由の入出力（`kpdf3-qpdf-in/out-<uuid>.pdf`、finally で unlink）で完結する。

## Consequences

1. **byte-copy 迂回バグの教訓 — 「速い経路」にも全ゲートが要る**。未編集 PDF の保存は ADR-0008 の byte-copy（`kpdf3:copy-source-pdf`）で qpdf を一度も通らず、**セキュア ON でも Info/XMP が残る全 OS 共通バグ**が Mac 実機検証（2026-06-05）で表面化 → 同日 commit `1927e64` で copy-source-pdf ハンドラに `secureExport` を追加し、`getSourceBytes()` を sanitize してから書くよう修正（β.149 収録）。v2.0.7 の「回転のみページが byte-copy されて回転が消える」と同型で、byte-copy 適格判定はその後 `byteCopyEligible`（`exporter.js`、REVIEW-2026-07 #4）に集約された。**新しい書き出し経路を足すときは sanitize ゲートの通過を必ず確認すること。**
2. **qpdf 未検出時は「警告して非セキュアで続行」**。main は raw のまま書いて `qpdfMissing: true` を返し、renderer が書き出し後に post-hoc ダイアログ（「個人情報の消去をスキップして通常の書き出しを行いました」）で明示する（3 call site）。一方 **sanitize 実行エラーは throw = 書き出し自体を失敗**させる（「セキュアでない出力に気付かない」事故の回避、β.84 設計）。監査上は `exports.is_secure`（ADR-0008 スキーマ）に実際に sanitize されたかが記録される。
3. **Mac は最低 macOS 26.0**。バンドルが Tahoe bottle 由来で全ファイル minos=26.0（26 未満は dyld が起動拒否）。配布先全台 26+ を 2026-06-05 に確認済み。26 未満対応が要るなら低 deployment target で作り直し。
4. **セキュア ON では未編集コピーも bit-identical でなくなる**（実測 945→898B）。原本と同一バイトのコピーが要る場面はチェックを外す運用。
5. ADR-0026 の「戻せる確定」とは非干渉：sanitize はディスクのフラット版のみに適用、内部の編集可能マスターはメタ保持のまま。
6. 自動テストは無い（qpdf は spawn 依存のため）。検証は synthetic PDF の手動確認（β.84）+ 3 OS 実機（Mac は `MAC-VERIFY-RESULT.md` / `MAC-VERIFY-M1.md`、Adobe「文書のプロパティ」で全フィールド空 + しおり保持 + 墨消しページの抽出不能を確認）。

## 実装ポインタ

- `src/main/qpdf-sanitize.js` — `findQpdfBinary()`（resourcesPath → vendor → PATH）/ `sanitizePdfBytes()`（tmp 経由 spawn）/ `decryptPdfBytes()`（ADR-0025 共用）
- `src/main/main.js` — IPC `kpdf3:export-pdf-rasterized`（再合成経路、payload.secureExport）/ `kpdf3:copy-source-pdf`（byte-copy 経路、commit `1927e64` で secureExport 追加）
- `src/main/preload.cjs` — `exportPdfRasterized(payload)` / `copySourcePdf(savePath, opts)`
- `src/renderer/file-browser.js` — `secureExportToggle`、既定 ON + `localStorage("kpdf3.secureExport")` 永続化、resolve は `{ path, secureExport }`
- `src/renderer/index.html` — `#open-row-secure-export` / `#open-secure-export`（β.86 の並列構造）
- `src/renderer/renderer.js` — `actionExport` / `actionExportRange` / `actionSavePagesAsPdf`（チェック提供 3 経路）、`actionExportToPath`（isCopy 分岐と両経路への secureExport 伝搬、`qpdfMissing` 警告）
- `src/renderer/exporter.js` / `print-flow.js` — `rasterRedactionPages: true`（β.85 真の墨消し、全 8 callsite）+ `byteCopyEligible`
- `vendor/qpdf/{win,mac,linux}/` + `package.json` `build.{win,mac,linux}.extraResources`（→ `resources/qpdf/`）
