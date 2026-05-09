# K-PDF3

法律実務向け PDF Workspace（K-PDF2 の全面再設計版、v2.0.0）

## 概要

K-PDF3 は「PDF を編集する」のではなく「PDF を背景にした workspace を編集する」アプリです。

- **workspace**（`.kpdf3` 単一ファイル / SQLite）= 編集の真実源
- **PDF** = 配布・閲覧・印刷用の成果物（read-only）
- **annotation** = 外部との通信レイヤ（read-only 表示のみ）

## 設計方針（要点）

| 項目 | 方針 |
|---|---|
| 保存形式 | SQLite 単一ファイル `.kpdf3`（WAL モード） |
| 座標系 | PDF point (72dpi) / top-left origin / 紙アナロジー |
| viewer | DOM（編集中・IME・accessibility）+ Canvas（visual truth）hybrid |
| layout engine | mupdf.js（CJK 対応、自前 text shaping は禁止） |
| export | overlay → draw command → content stream → full rewrite |
| secure export | qpdf 同梱（Apache 2.0） |
| annotation | read-only visual proxy（/AP 優先、なければマーカー表示） |
| 印刷 | export → 一時 PDF → OS 印刷機能 |

詳細は `docs/architecture.md` および `docs/adr/` を参照。

## 経緯

K-PDF2 v0.27.1 で PDF Annotation 書き出しを 4 アプローチ試行 → viewer 間の baseline / appearance 差異により法律実務に必要な位置精度が構造的に達成不可能と判明 → 全面再設計を決定（2026-05-09）。

K-PDF2 v0.27.0 は業務継続用として凍結。

## 開発状態

v2.0.0 開発中（2026-05-09 開始、想定実働 6〜10 週間）。

## ライセンス

UNLICENSED（個人・スタッフ内利用のみ。mupdf.js が AGPL のため、外部公開する場合は要 OSS 化判断）

## 関連

- 旧アプリ：K-PDF2（[windom21-cpu/k-pdf2](https://github.com/windom21-cpu/k-pdf2)）
- 引き継ぎ書：旧 K-PDF2 の `HANDOVER.md` 参照
