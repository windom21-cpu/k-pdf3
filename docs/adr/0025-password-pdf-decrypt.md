# ADR-0025: パスワード保護 PDF の import 境界復号（qpdf --decrypt）

- 日付: 2026-07-10
- ステータス: **実装済（遡及起草 — REVIEW-2026-07 #7。実装は v2.0.1/2.0.2 + 平文化警告は v2.0.12-beta.3）**
- 関連: ADR-0007（userData workspace 集中保管 + fingerprint 索引 — 本 ADR の「復号版を workspace に保存」はこの構造の上に成立）、ADR-0022（secure export / qpdf sanitize — β.84 で同梱した qpdf 12.3.2 を本 ADR が復号にも転用）、ADR-0026（確定保存の可逆化 — 保存経路は本 ADR の復号後バイトをそのまま扱う）

## Context

### 法律実務でパスワード PDF は日常的に届く

裁判所・相手方代理人・企業から受け取る PDF にはパスワード保護（ユーザーパスワード）や権限制限（印刷・編集禁止のオーナーパスワードのみ）が珍しくない。v2.0.0 stable 時点の K-PDF3 は暗号化 PDF を扱えず、**毎回 Adobe で開いてパスワードを入れる／保護を外した別ファイルを作る手作業**が必要だった。ユーザー要望を受け、stable 直後の patch v2.0.1 で対応した。

### アーキテクチャ上の前提

1. K-PDF3 の描画・編集・書き出し・印刷は、すべて **workspace 内部に保持した元 PDF のコピー（`workspace.getSourceBytes()`）** から行う（ADR-0007）。ディスク上の実ファイルに触るのは「開く」の瞬間だけ。
2. workspace は **元ファイルのバイト列の SHA-256 fingerprint** で索引される。同じファイルを開き直せば同じ workspace が再利用され、overlay 編集が保持される。
3. secure export（β.84 / ADR-0022 候補）のために **qpdf 12.3.2 を 3 OS 同梱済み**。`--decrypt` は同じバイナリで使える。

### v2.0.1 → v2.0.2 の白紙バグ

v2.0.1 の初版は検出が不十分で、**復号前のビルドで暗号化されたまま取り込まれた既存 workspace** が fingerprint 再利用で復号ゲートを素通りし、開くと白紙になる問題が出た。v2.0.2 で (a) 検出を `/Encrypt` 全般に拡張、(b) 空パスワード先行試行、(c) 既存 workspace の自己修復（self-heal）で解消（実機でパスワード入力→復号→表示を 2026-06-08 に確認）。

## Decision

**復号を「開く」経路（`kpdf3:open-pdf-file`）の import 境界 1 箇所に閉じ込め、復号済みの平文バイトを workspace に保存する。** これにより閲覧・編集・書き出し・印刷など下流の全レイヤは暗号化を一切意識しない（無変更）。この構造判断が本 ADR の核心。

### 1. 検出 — `pdfIsEncrypted`（mupdf）

`mupdf.Document.openDocument` を 1 回開き、`needsPassword()` **または** trailer に `/Encrypt` が存在すれば暗号化と判定（`src/backend/mupdf-pdf-info.js:98`）。後者の拡張（v2.0.2）により、`needsPassword()=false` でも `/Encrypt` を持つ「権限制限のみ」PDF を取りこぼさない。

### 2. 復号 — qpdf `--decrypt`、パスワードは stdin 経由

`decryptPdfBytes()`（`src/main/qpdf-sanitize.js:159`）が qpdf を `--warning-exit-0 --decrypt --password-file=- in out` で spawn する。

- **パスワードは `--password-file=-` で stdin から渡す** — コマンドライン引数に載せない（タスクマネージャ / `ps` に露出しない）。ログ・永続化も一切しない。
- 入出力は tmpdir の一時ファイル（randomUUID 名）で、`finally` で必ず削除。
- 失敗は `.code` で分類: `WRONG_PASSWORD`（→ プロンプト再表示）、`QPDF_MISSING`（→ その旨を通知して開かない）。
- ベクター内容は保持される（ラスタライズしない）。

### 3. 空パスワード先行 → 必要時のみ 98 風プロンプト

ゲート（`src/main/main.js:1460` 付近）はまず**空パスワードで復号を試みる**。権限制限のみ / 空ユーザーパスワードの PDF はここで静かに復号され、**プロンプトなしで開く**。空で失敗（`WRONG_PASSWORD`）したときだけ `{ needsPassword }` sentinel を renderer に返し、98 風入力モーダル `customPasswordPrompt`（`src/renderer/dialogs.js:172`、誤入力時は `wrong` フラグで再表示）でユーザーに聞く。ゲートは tab/active 状態を壊す前に走るので、途中キャンセルしても状態は無傷。

### 4. fingerprint は元（暗号化）ファイルで取る + self-heal

fingerprint は **ディスク上の元ファイル（暗号化バイト）** から計算する（`main.js:1438`）。復号後バイトで取ると再オープン時に別 workspace になってしまうため。同じファイルの再オープンは同一 workspace に解決され、overlay 編集は保持される。再利用分岐では self-heal が走る: `didDecrypt` かつ保存済み source がまだ暗号化されている（= 復号前ビルドの取り込み）場合のみ `importPdfBytes` で平文に置換する（overlay は別キーなので生き残る。healing 済みなら再書込しない）。

### 5. 平文化の告知と将来布石（v2.0.12-beta.3、REVIEW-2026-07 #3）

- **実ユーザーパスワードを入力して復号した場合のみ**、開いた直後に 98 風モーダル（OK のみ）で「保存・書き出しするとパスワード保護の無い PDF が作成される（Dropbox 等の同期先にもそのまま置かれる）」と警告する（`renderer.js` の `openPdfPath` 集約点、修正 1 箇所）。案件ごとに意識すべき情報なので**「次から表示しない」は付けない**（開くたびに出る）。権限制限のみ / 空パスワード PDF はプロンプト自体が出ないので対象外。
- 復号を伴う取り込み時に workspace metadata へ `source_was_encrypted="1"` を記録する（`Workspace.markSourceWasEncrypted()` / `sourceWasEncrypted()`、`src/domain/workspace.js:425`）。**パスワード自体は保存しない。** 将来の「書き出し時に再暗号化」オプションの対象判定に使う布石で、再利用分岐でも走るためフラグ導入前の既存 workspace も次のオープンで後追い記録される。

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. import 境界で 1 回復号し、平文を workspace に保存（採用）** | ✅ | 復号は 1 箇所に閉じ、下流（mupdf 描画 / pdf-lib 組立 / qpdf sanitize / 印刷）は無変更。ADR-0007 の「描画は内部コピーから」に自然に乗る |
| B. 開くたび・使うたびに都度復号（平文を持たない） | ❌ | 全下流レイヤが暗号化対応を要し、パスワードのセッション保持も必要になる。v2.0 系 patch の規模を超える |
| C. mupdf のパスワード付きオープンで直接描画 | ❌ | 描画は通るが pdf-lib（書き出し組立）や byte-copy 経路が暗号化バイトのままでは成立しない。結局どこかで復号が要る |
| （手段）パスワードをコマンドライン引数で渡す | ❌ | プロセス一覧に露出する。`--password-file=-` + stdin で回避 |
| （範囲）再暗号化オプションを MVP に含める | ❌ 将来 | パスワード保存 or 再入力 UI・qpdf `--encrypt` の鍵長/権限設計が必要で patch の域を超える。まず `source_was_encrypted` フラグ + 平文化警告で運用上の安全を確保し、要望が実際に出てから設計する |

## Consequences

### 受け入れる trade-off

1. **保存・書き出し・印刷用 PDF はパスワード保護の無い平文になる**（再暗号化未実装）。Dropbox 同期先にも平文が置かれる。→ v2.0.12-beta.3 の毎回警告でユーザーが案件ごとに認識して受容する運用。
2. **実ユーザーパスワード PDF は再オープンごとに再入力が必要。** workspace は fingerprint 再利用で編集を保持するが、復号ゲートは毎オープンで on-disk の暗号化バイトに対して走るため（2026-07-06 コード確認。HANDOVER 旧記述「再入力不要」は誤りとして同日訂正済み）。パスワードを保存しない方針の直接の帰結として受容。
3. **外部 PDF の D&D ページ挿入経路（`kpdf3:import-pdf` / insert 系）は復号ゲート未通過。** 暗号化 PDF をページ挿入に使うと現状は失敗または不正な取り込みになりうる。対応する場合は同じ `pdfIsEncrypted` + `decryptPdfBytes` を挿入境界に足す（将来）。
4. `pdfIsEncrypted` は毎オープンで mupdf `openDocument` を 1 回追加で走らせる（lazy parse なので軽微）。
5. qpdf バイナリが見つからない環境では暗号化 PDF を開けない（`QPDF_MISSING` を明示）。3 OS 同梱済みなので配布物では実質発生しない。

### 将来（スコープ外の解除条件）

- **再暗号化オプション**: `source_was_encrypted` フラグが対象判定の入口。書き出しダイアログの opt-in + パスワード入力（保存はしない）を想定し、要望が出たら別 ADR で。
- **D&D 挿入経路の復号ゲート**（上記 3）。

## 検証（実施済み）

- 実機（2026-06-08）: 実ユーザーパスワード PDF を開く → プロンプト → 復号 → 表示、までを確認（v2.0.2）
- 権限制限のみ / 空ユーザーパスワード PDF がプロンプトなしで開くこと（空パスワード先行の効き）
- 復号前ビルドで白紙化していた既存 workspace の self-heal は v2.0.2 の修正対象そのもの（overlay は source と別キーで保存されるため置換後も残る — コード保証、`main.js:1500` コメント参照）
- `test/source-encrypted-flag.test.mjs` 5 件（フラグ既定 false / mark で true / 冪等 / close→reopen で永続 / パスワード非保存）が electron-runner で pass
- 平文化警告（v2.0.12-beta.3）は実運用の中で確認する扱いでクローズ（ユーザー判断 2026-07-06）

## 実装ポインタ

- 復号ゲート本体: `src/main/main.js:1441-1476`（検出 / 空パスワード先行 / sentinel 返却）、self-heal `main.js:1497-1508`（再利用分岐）・`1522-1527`（legacy sidecar 移行分岐）、フラグ記録 `main.js:1557-1562`
- qpdf 復号: `src/main/qpdf-sanitize.js:159`（`decryptPdfBytes`、stdin 渡し・一時ファイル掃除・エラー分類）
- 暗号化検出: `src/backend/mupdf-pdf-info.js:98`（`pdfIsEncrypted`）
- renderer 側: `src/renderer/renderer.js:2918` 付近（`needsPassword` ループ + `customPasswordPrompt` + 復号中 busy 表示）、`renderer.js:3002` 付近（平文化警告モーダル）、`src/renderer/dialogs.js:172`（98 風パスワードプロンプト）
- フラグ永続化: `src/domain/workspace.js:425-431`、テスト `test/source-encrypted-flag.test.mjs`（既定 false → mark → 永続の 5 チェック、electron-runner 実行）
- 経緯: v2.0.1（機能投入）→ v2.0.2（白紙バグ修正、2026-06-08 実機確認）→ v2.0.12-beta.3（平文化警告 + フラグ、実装 `f6fb811`・配信 `8fbc844`、2026-07-06）。HANDOVER §15.4 / CHANGELOG-history.md §A
