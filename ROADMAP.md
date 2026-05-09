# K-PDF3 開発ロードマップ

総工数想定: 実働 6〜10 週間（断続的に進める前提で 2〜3 ヶ月）。
着手日: 2026-05-09。

## 全体像

```
M1 Foundation → M2 Core → M3 Editing UI → M4 Export → M5 Feature Migration → M6 Polish
   (Week 1-2)   (Week 3-4)  (Week 5-6)     (Week 7-8)   (Week 9-10)             (Week 11+)
```

各マイルストーンは **Exit criteria（達成基準）** を定義し、満たしてから次へ進む。

---

## M1: Foundation （Week 1-2）

**目的**: 設計を固め、空の workspace を作って再オープンできる状態まで。

- [x] mupdf.js layout API spike（spike 成功、API 確認済）
- [ ] Architecture document（`docs/architecture.md`）
- [ ] ADR-0001: workspace SQLite 採用
- [ ] ADR-0002: mupdf.js layout engine 採用
- [ ] ADR-0003: canonical coordinate（PDF point 72dpi / top-left / 紙アナロジー）
- [ ] Glossary（`docs/glossary.md`）
- [ ] SQLite schema DDL（`schema/schema.sql`）
- [ ] Project setup（Electron + better-sqlite3 + mupdf.js + electron-rebuild）
- [ ] Canonical coordinate transform module + unit tests
- [ ] PDF import path（source PDF を BLOB 保存、page metrics 抽出）
- [ ] Workspace open/close path（SQLite open / WAL setup / integrity check）

**Exit criteria**: 
- `.kpdf3` を新規作成 → source PDF を取り込み → クローズ → 再オープンで page count / mediabox が一致

---

## M2: Core （Week 3-4）

**目的**: PDF を画面に表示できる。virtualization と layout engine が動く。

- [ ] Object model（overlay store: text / stamp / image / redaction / line / rect）
- [ ] SQLite persistence layer（CRUD with transaction）
- [ ] Pub/Sub store（自前、small + dirty region tracking）
- [ ] Page registry / virtualization layer
- [ ] Viewer renderer skeleton（Canvas 描画 + DOM chrome）
- [ ] mupdf-based layout engine（CJK 対応、Font / Text wrapper）
- [ ] Page rendering（mupdf.js → Pixmap → Canvas）

**Exit criteria**:
- 400 ページ PDF を開いて virtualization で滑らかにスクロールできる
- 任意のページに jump して数 ms で表示

---

## M3: Editing UI （Week 5-6）

**目的**: テキスト・スタンプを置いて保存・再オープンできる。

- [ ] Text overlay editor（DOM textarea + Canvas commit の hybrid）
- [ ] IME 対応（DOM 側で完全制御）
- [ ] Stamp overlay（画像・日付印）
- [ ] Selection / hit-test（spatial index = SQLite R*Tree）
- [ ] Undo/Redo（command pattern + history table）
- [ ] Drag move / resize（transient update + commit）
- [ ] Ctrl+S workspace save flow
- [ ] Close-warning UX（dirty / unexported 2 段階）
- [ ] Asset library（global、IndexedDB ではなく アプリ専用 SQLite）

**Exit criteria**:
- テキスト入力 → 保存 → 再開で位置・内容が正確に復元
- IME（日本語入力）が完全に機能
- 100 操作の Undo/Redo が高速

---

## M4: Export & Secure Export （Week 7-8）

**目的**: workspace から flatten PDF を出力できる。法律実務の真正性要件を満たす。

- [ ] Export pipeline（overlay → draw command → content stream → full rewrite）
- [ ] IPAex 明朝 を `fonts/` 同梱 + font subset embedding
- [ ] qpdf integration（sanitize、metadata strip、xref rebuild、Apache 2.0）
- [ ] Export snapshot history（BLOB 保管、revision id 発行）
- [ ] PDF metadata に revision id 埋め込み
- [ ] Ctrl+E export flow + 確認ダイアログ
- [ ] Source PDF fingerprint check（page count + mediabox MVP）
- [ ] Safe mode（mismatch 時に overlay lock / export 禁止）

**Exit criteria**:
- workspace から出した PDF を Adobe / Preview / Chrome で開いて全要素が見える
- export 履歴から「2026-04-15 提出版」を bit-identical 復元できる
- 真正性検証（hash 比較）が通る

---

## M5: Feature Migration （Week 9-10）

**目的**: K-PDF2 の主要機能を新アーキ上で再実装。配布バイナリを作る。

- [ ] Tab management（workspace layer、複数 project 同時編集）
- [ ] Bookmarks（PDF /Outlines export 含む）
- [ ] Print pipeline（export → temp PDF → OS 印刷機能）
- [ ] Split save（カットマーカー UI + multi-document export）
- [ ] True redaction（300dpi raster + secure export 統合）
- [ ] Page numbering（canonical 座標で再実装）
- [ ] Page rotation（紙アナロジー継承、object は rotation unaware）
- [ ] OS native dialog（open/save/save-as）
- [ ] File association（`.kpdf3` 拡張子）
- [ ] CI cross-build（Win/Mac/Linux、GitHub Actions）
- [ ] **v2.0.0-beta.1 release**

**Exit criteria**:
- K-PDF2 v0.27.0 で日常業務に使う機能がすべて動く
- 業務切り替えが可能になる

---

## M6: Polish （Week 11+、optional）

**目的**: 仕上げと正式リリース。

- [ ] Annotation read-only proxy（/AP 描画優先、なしならマーカー）
- [ ] 98.css UI integration / レトロ感調整（Kosugi 同梱継続）
- [ ] Unified search（PDF text layer + overlay text via FTS5）
- [ ] Golden image regression test corpus
- [ ] HANDOVER.md（K-PDF3 版）正式書き起こし
- [ ] About ダイアログ / ライセンス表記（mupdf AGPL / qpdf Apache / IPAex / Kosugi 等）
- [ ] **v2.0.0 stable release**

---

## 業務継続用の運用

- K-PDF2 v0.27.0 を凍結利用（hotfix なし）
- v0.27.1 の working tree は完全破棄
- K-PDF3 v2.0.0-beta.1（M5 完了時）以降、徐々に業務移行

## マイルストーン進行ルール

- 各 M の **Exit criteria を満たすまで次へ進まない**
- 着手前に該当する ADR / glossary 項目を整備
- M5 完了で beta release、M6 完了で stable release
- ユーザー確認は M2 / M3 / M4 / M5 完了時に実施
