# ADR-0008: 容量最適化と byte-copy ベースの別名保存

- 日付: 2026-05-09
- ステータス: 採用
- 関連: ADR-0007（workspace 集中保管）、HANDOVER §17.3（bit-identical 履歴保管 — 緩和）

## Context

ADR-0007 動作確認後、ユーザーから 2 つの懸念：

1. **別名保存で原本が degrade する**: 受信 PDF を「開いて → 何もせず別名保存 → 別名版を編集する」という法律実務の典型ワークフロー。現行の Save As (Ctrl+E) は overlay が無くても **常に flatten ラスタライズ版** を出力するので、別名保存した時点で「テキスト選択不可・サイズ膨張」の劣化版になる。
2. **kpdf3 の容量肥大**: 50 MB の PDF を 10 回 Ctrl+S すると `.kpdf3` 内 `exports` table の bit-identical BLOB で **550 MB**。1 PC で多数案件を扱うと数 GB 規模になる。

ユーザー: 「容量に関しては DB を使うことで解消できるものではないか」

## Decision

3 つの変更：

### 1. Smart Save As — overlay 0 件なら byte-copy

別名保存時、project store の overlay 数を見て分岐：

| overlay 数 | 動作 | 出力 |
|---|---|---|
| **0** | source PDF のバイト列を保存先へ **byte-copy** | byte-perfect コピー（テキスト層維持・サイズ維持） |
| **≥ 1** | 従来どおり flatten + mupdf 組み立て | ラスタライズ flatten PDF |

ユーザーから見た挙動：
- 受信 PDF を開いて → 何も触らず Save As → **元と同一バイトの PDF が新パスに出る**（テキスト選択も生きる）
- 編集してから Save As → flatten 版が出る

byte-copy の場合も `recordExport` で監査ログ（hash / timestamp / revisionId）は残す。

### 2. exports table の BLOB 列を廃止

HANDOVER §17.3 の「提出版を bit-identical 履歴保管」を緩和し、kpdf3 内には **メタ情報のみ** 保存：

```sql
-- After ADR-0008
CREATE TABLE exports (
    id            TEXT PRIMARY KEY,
    revision_id   TEXT NOT NULL UNIQUE,
    timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
    output_hash   TEXT NOT NULL,
    output_size   INTEGER NOT NULL,
    note          TEXT,
    is_secure     INTEGER NOT NULL DEFAULT 0
    -- blob BLOB NOT NULL    ← 削除
);
```

容量効果（50 MB の PDF を 10 回保存）: **550 MB → 50 MB**（約 1/10）。

「あの時の現物が必要」になった場合：
- ユーザーの「別名保存運用」で、ディスク上に `契約書_v1_提出.pdf` などが残っている
- その hash と kpdf3 内 `output_hash` の照合で同一性検証可能

### 3. Schema migration

既存 kpdf3（M4-2 期に作成された）には `blob` 列が存在する。`openWorkspace` で idempotent に migrate：

```js
function migrateExportsSchema(db) {
  const cols = db.pragma("table_info(exports)");
  if (cols.some((c) => c.name === "blob")) {
    db.exec("ALTER TABLE exports DROP COLUMN blob");
  }
}
```

better-sqlite3 12.9.0 が同梱する SQLite は 3.51.x で `DROP COLUMN`（3.35+）対応済。

## Why この選択肢か

検討した options：

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. Smart Save As + BLOB 廃止（採用）** | ✅ | ユーザー実ワークフローと整合、容量 1/10、最小実装 |
| B. 別途「PDF をコピー」メニュー追加 | ❌ | UI 表面積増加、Save As の意味が直感に合わなくなる |
| C. exports BLOB は残し、上限 N 件で循環 | ❌ | 部分的解決、容量問題の本質ではない |
| D. exports 全廃（メタも消す） | ❌ | 監査ログ自体は安価で価値が高い、消す理由が無い |

将来課題（ADR-0009 候補）として **共有 asset DB**（`~/.config/K-PDF3/assets.db` で source_pdf を SHA-256 keyed dedup）を分離。同一テンプレ PDF を多案件で使うケースで効くが、現行 ADR-0008 のスコープ外。

## Consequences

### 受け入れる trade-off

#### 1. bit-identical 履歴保管要件の緩和

HANDOVER §17.3 に記載されていた「提出版を `.kpdf3` 内に bit-identical 履歴保管 → 法律実務の真正性要件を満たす」は次のように改訂される：

- kpdf3 内には **メタ情報（hash / size / timestamp / revision_id）のみ**
- bit-identical な現物は **ユーザーの別名保存運用** で確保（ディスク上に複数ファイル名で残る）
- 監査の実効性は output_hash の照合で担保

「絶対 bit-identical を kpdf3 内に残したい」要件が将来再浮上した場合、opt-in 機能として ADR-00xx で復活させる余地は残す（schema を NULLABLE な BLOB 列で再導入するだけ）。

#### 2. 別名保存の意味が文脈依存になる

「Save As」が overlay の有無で挙動を変える（byte-copy / flatten）。技術的には混乱の元になりうるが、ユーザー視点では一貫している（「編集を反映する／しない」が overlay の有無で自然に決まる）。

#### 3. byte-copy 経路では mupdf を通さない

そのまま `fs.writeFileSync(savePath, sourceBytes)` するので、PDF の妥当性は元 PDF に依存（壊れた PDF を取り込んで byte-copy しても壊れたまま）。M4 想定範囲では問題なし。

### 影響範囲

- `schema/schema.sql`: exports.blob 列削除
- `src/backend/sqlite-store.js`: `setExport` から blob 引数を削除、`getExportBlob` 削除、`migrateExportsSchema` 追加（openWorkspace 内呼出）
- `src/domain/workspace.js`: `recordExport` の API 整理（blob は受け取るがメタ計算のみ）、`getExportBlob` 削除
- `src/main/main.js`: `kpdf3:copy-source-pdf` IPC 追加、export-pdf-rasterized は変わらず
- `src/main/preload.cjs`: `copySourcePdf` 露出
- `src/renderer/renderer.js`: `actionExport` を overlay 数で分岐
- `test/m3-overlay-persistence.mjs`: BLOB round-trip 確認を削除、メタ検証は維持
- HANDOVER §17.3 を後日（明示依頼時）改訂

### 解除条件

将来の判断ポイント：

- 「kpdf3 単独でフルバックアップ可能にしたい」要件が出た場合 → 共有 asset DB（ADR-0009 候補）+ exports BLOB 復活を opt-in で。本 ADR は変更不要、新 ADR で上乗せ。

## 検証

- 既存 379 テストのうち、m3-overlay-persistence.mjs の BLOB round-trip 部分を削除（−2 程度の assertion）→ 残りはそのまま pass する見込み
- 手動：
  - 受信 PDF を開く → 編集なし Ctrl+E → 出力 PDF を `cmp` で元と比較 → 一致
  - 編集後 Ctrl+E → flatten 版が出る
  - 既存（blob 列ありの）kpdf3 を開く → 自動 migrate → blob 列消える
