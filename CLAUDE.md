# K-PDF3 — Claude Code 向けプロジェクト規約

法律実務向け PDF Workspace (Electron)。ユーザーは弁護士で、Windows 実機で業務フル運用中。
**経緯・未解決項目・試行錯誤の詳細は `HANDOVER.md` が正**。本書はセッションをまたいで
常に真の「恒久ルール」だけを置く。

## 最初にやること

- **印刷 / Adobe / FAX / render / D&D / 回転まわりの提案・修正の前に、必ず `HANDOVER.md` を grep**。
  この領域は試行錯誤の歴史があり、既に却下された案・治った箇所・未解決の再現待ちが記録されている。
- 「ビルドして」「動かして」系の依頼は、npm script を直接叩く前に `.github/workflows/` を確認。
- `HANDOVER.md` は**ユーザーの明示依頼があるときだけ**更新する（勝手に書き換えない）。

## ビルド・リリース・テスト

- **ビルドはタグ push → GitHub Actions 経由**（Windows runner）。WSL で `npm run build:win` を叩かない。
- リリース手順: fix コミット → `package.json` version bump の `release:` コミット → `git tag vX.Y.Z(-beta.N)` → `git push origin main --tags`。
- β タグ（`-beta` を含む）は **Windows のみ**ビルドされる（macOS/Linux は stable タグのみ）。
- 配布物は別リポジトリ **`windom21-cpu/k-pdf3-releases`** に publish される（autoUpdater feed 込み）。
  `gh release view` は k-pdf3 本体ではなくそちらを見る。
- テストは `npm test`（node --test、mupdf は WASM なので plain node で走る）。タグを切る前にローカルで全通過を確認する。
- パッケージの追加・更新はユーザーの明示指示があるときのみ。バージョンは exact 固定（`^`/`~` 禁止）。

## アーキテクチャ不変条件・落とし穴

- **overlay 描画は二重実装**: 画面 = `src/renderer/viewer.js`（DOM）、出力 = `src/renderer/exporter.js` の
  `drawOverlay`（canvas。印刷・確定/別名保存・サムネ・分割ビュー共通）。
  **「画面は正しいのに出力だけおかしい」WYSIWYG バグは exporter 側の分岐抜けをまず疑う**。
  描画レイアウトを変えるときは必ず両方＋vector text ops（`_textOverlayVectorOps` 等）を同時に直す。
- overlay の座標は **canonical frame**（intrinsic `/Rotate` + userRotation 適用後）で保存される。
  ページ回転時は `rotatePageBy` が枠位置・矢印ベクトル・content rotation (`props.rotation`) を
  projectStore に carry し、viewer / exporter が描画時に `props.rotation` を適用する契約。
- `viewer.js` は grep にバイナリ判定される（文字コード起因）。**検索は `grep -a` を使う**。
- 「治った所は非干渉で直す」（ユーザー明示ルール）: 単一ページ回転・回転ベイク
  (`src/main/rotate-place.js`)・下敷き印刷は実機検証済みの完成領域。修正は既存経路を
  1 バイトも変えない追加分岐で行う。
- byte-copy 最適化（無編集ページの素通し）は userRotation 等の workspace 変更を見落とすと
  「画面では回転済みなのに保存/印刷で落ちる」系の事故になる（v2.0.7 / v2.0.12-beta.4 で既修正。
  ゲートを触るときは総当たりテスト `test/byte-copy-gate.test.mjs` を確認）。

## ユーザー決定事項（NG リスト — 再提案しない）

- **印刷は Adobe `/p` 案 D で確定**。Sumatra silent / Chromium silent への逃がし提案は絶対 NG。
- 印刷で「最後のプリンタを記憶」系は採用しない（FAX 送信先を記憶した事故歴あり。毎回手動選択）。
- 下敷き印刷の 180° 反転は Adobe「向き自動」の誤判定 — white-cover / 180° 先回り / DEVMODE は却下済。
  赤警告＋必須チェックで「縦」を毎回確認させる運用で確定。
- FAX 送信の完了は自動検出できない（Win32_PrintJob 盲目）。「送信完了」明示確認モーダルが正。

## バグ調査の進め方

- 再現不能・状況証拠のみの問題は、**まず合成データで再現を確立してから**コードを触る
  （再現経路を二分してから、が HANDOVER の流儀）。
- 根因が確定できないときは「無言 return に診断ステータス表示を足す」など、
  **診断段階強化 → 次の報告で確定 → 修正**の 2 段構え（Adobe 残留問題 β95→β118 のパターン）。
- 修正したら報告に「実機確認のチェックリスト」（どの経路で・何を見るか）を必ず添える。
  画面／印刷／別名保存／確定保存／サムネ／FAX のどこで直ったかは経路が別なので個別に確認が要る。

## バグ報告の読み方

ユーザーの報告は口語で表現が揺れることがある。**解釈より観察事実を優先して切り分ける**:
「どこで見たか（画面/印刷/保存/サムネ/FAX）」「何が正しくて何がおかしいか」「直前の操作・
単発か一括か」「閉じ直すと直るか」。足りない判別事実は推測せず、確認可能な予測
（「なら○○にも同じ症状が出ているはず」）を添えて特定する。
