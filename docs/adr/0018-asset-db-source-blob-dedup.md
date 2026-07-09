# ADR-0018: workspace 間 source_pdf BLOB 共有（共有 asset DB）は採用しない — workspace は自己完結、dedup は workspace 内に限定

- 日付: 2026-07-10
- ステータス: **採用（遡及起草 — REVIEW-2026-07 #7。workspace 間 BLOB 共有は不採用/先送り、workspace 内 dedup は実装済）**
- 関連: ADR-0007（userData workspace 集中保管 + fingerprint 索引）、ADR-0008（exports BLOB 廃止 — 本構想の初出）、ADR-0026（戻せる確定保存 — source dedup 不要の確認）、ADR-0027（手動お掃除 — 容量問題の実際の解）

## Context

各 workspace（`.kpdf3`）は元 PDF を `source_pdf` テーブルに bit-identical な BLOB として丸ごと保持する（ADR-0001/0007、HANDOVER §15.4 の表）。同一のテンプレ PDF を多数の案件で使い回すと、同じバイト列が workspace の数だけ複製される懸念があった。

ADR-0008（2026-05-09）はこれへの対策候補として **共有 asset DB**（`~/.config/K-PDF3/assets.db` に source_pdf を SHA-256 keyed で dedup 保管し、各 workspace は参照だけ持つ）を「将来課題（ADR-0009 候補）」として分離した。以後 HANDOVER §15.2 に「asset DB 共有 by SHA-256 dedup (M5/M6): source_pdf BLOB の重複削減」、§15.3 に「0018 — 容量肥大が現実化したら起草」として留め置かれ、**実装されないまま stable (v2.0.x) に至った**。

その後、容量肥大は実際に現実化した（2026-07-05 実測、ADR-0027）: `userData/workspaces/` 合計 **7.4 GB / 1,819 ファイル**（うち `.kpdf3` 1,808 個 / 6.6 GB）、増加ペース ≒35 個/日。本 ADR はこの帰結を含めて「共有 asset DB を採らなかった判断」を遡及記録する。

## Decision

1. **workspace 間で source_pdf BLOB を共有する asset DB は導入しない（不採用/無期限先送り）**。各 `.kpdf3` は元 PDF を自分の中に丸ごと持つ**自己完結ファイル**であり続ける。
2. **dedup は workspace 内部に限定して実装済**とする:
   - `inserted_source_pdfs`（β31）: 外部 PDF 挿入の元バイト列を SHA-256 keyed で保持。同じ PDF から複数ページ挿入しても 1 行のみ（`sha256 TEXT NOT NULL UNIQUE`）
   - `assets`: 画像 asset（スタンプ画像・印影）を hash dedup
3. **容量問題は BLOB 共有ではなく「保持ポリシー + 手動お掃除」で解決する**（ADR-0027。v2.0.12-beta.2 で実装、実機で 2.9 GB 回収済）。

## Why この選択肢か

| 選択肢 | 採否 | 理由 |
|---|---|---|
| **A. 各 workspace 自己完結 + 掃除（ADR-0027）（採用）** | ✅ | 容量の主犯に届き、可搬性・掃除の安全性を保つ（下記） |
| B. workspace 間共有 asset DB（`assets.db` + 参照） | ❌ | 効果が構造的に小さい上、自己完結性を壊し refcount 管理が必要になる（下記） |
| C. 何もしない | ❌ | 年 40 GB 超ペース（ADR-0027 実測）でディスク逼迫は時間の問題 |

### B の効果が構造的に小さい理由

- **同一 PDF は最初から複製されない**: ADR-0007 の fingerprint 索引により、同じバイト列の PDF はどこにあっても同一 workspace で開かれる。つまり「同一 PDF × 複数 workspace」という dedup の本命ケースは索引が既に潰している。
- **確定保存も dedup の対象にならない**: ADR-0026 設計時に「source dedup で容量据え置き」を検討したが、実装時に**マスター（元 PDF）と確定版（焼き込み画像）はバイト列が別物なので dedup 不要**と判明した（HANDOVER 現状サマリ v2.0.12-beta.1 の記録。旧 workspace を捨てず predecessor で紐づけるだけで容量増ほぼゼロ）。
- **容量の主犯は重複ではなく「編集を持つが二度と開かない」workspace**: 2026-07-05 実測で「開いただけ」（200 KB 未満）は 1,808 個中 62 個のみ。残りは中身の異なる案件 PDF であり、BLOB 共有しても 7.4 GB 問題は解決しない。

### 自己完結 workspace を守る利点（裏取り済）

- **可搬性**: `.kpdf3`（+ β.134 巨大 PDF サイドカー `.source.pdf`）をフォルダごとコピーするだけで PC 移行・復元が完結する。実際に Mac 移行検討（`docs/mac-migration-workspaces.md`）で「データ形式は全て OS 非依存、障害は絶対パス 2 箇所のみ → fallback 実装済」と確認され、バックアップ運用（REVIEW-2026-07 #2、robocopy /MIR ミラー + フォルダ書き戻しで復元）もこの性質に依拠している。共有 asset DB があれば「workspaces/ と assets.db の整合コピー」が常に必要になり、この単純さが失われる。
- **掃除が安全**: ADR-0027 の削除単位は「`.kpdf3` + そのサイドカー」で完結し、他の workspace への影響を考えなくてよい。共有 BLOB があれば「最後の参照が消えたら BLOB も消す」refcount 管理が必須になる（ADR-0026 検討時にも「external sidecar の source 共有 refcount」が実装細部の懸念として挙がっていた）。参照カウントのバグ = 法律実務データの喪失リスクであり、割に合わない。
- **workspace 内 dedup はこの利点を損なわない**: `inserted_source_pdfs` の SHA-256 dedup はファイル内で閉じているため、可搬性・掃除の単位に影響しない。

## Consequences

### 受け入れる trade-off

1. **同一テンプレ PDF を「別名で複数回」開くと BLOB が複製される**: fingerprint 索引は内容同一のときだけ効くので、テンプレを Word で少し変えて出力するたびに新 workspace + 新 BLOB になる。→ 実測上これは容量の主犯ではなく、ADR-0027 の期間ベース掃除で十分回収できる。
2. **ディスク使用量は「元 PDF 合計の約 2 倍」で見積もる**運用を継続する（Dropbox 上の PDF + userData 内の複製。ユーザー承認済の方針）。
3. **将来の再浮上余地**: 掃除運用でもなお逼迫する事態になれば、共有 asset DB を新 ADR で再検討する。その場合も本 ADR の refcount / 可搬性の論点が出発点になる。

### 帰結（実績）

- 2026-07-05 に容量肥大が現実化（7.4 GB / `.kpdf3` 1,808 個）した際、採られた解は BLOB 共有ではなく **ADR-0027「ワークスペースの整理」**（手動のみ / predecessor・開タブ無条件保護 / ごみ箱経由）で、実機で 2.9 GB を回収した。本 ADR の判断（B より A）は実績で裏づけられた。

## 実装ポインタ

- `schema/schema.sql`: `source_pdf`（1 行、bit-identical BLOB + β.134 `external_path`）/ `inserted_source_pdfs`（`sha256 UNIQUE` で dedup）/ `assets`（hash dedup）
- `src/backend/sqlite-store.js`: `getOrCreateInsertedSourcePdf(db, { sha256, pdfBlob, byteSize })` — SHA-256 で get-or-create、`ensureInsertedSourcePdfsTable` / `addAsset`（sha256 hash dedupe）
- `src/main/workspace-cleanup.js`: ADR-0027 の掃除実装（自己完結ゆえに workspace 単位で安全に削除できることの実証）
- `src/main/workspace-registry.js`: fingerprint 索引（同一 PDF の workspace 間複製を未然に防ぐ側の仕組み）
