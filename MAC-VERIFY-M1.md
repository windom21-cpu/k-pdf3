# Mac 実機検証手順 (事務所 M1) — qpdf 同梱の最終確認

> 作成: 2026-06-05 / 対象: stable 残務 #5 の残チェック (`QPDF-MAC-TODO.md` §7 #186-189)
> **この手順は M1 実機が必要。タグ/CI/publish は使わない (= β テスターに一切影響しない)。**
> 所要 15〜30 分。非プログラマ + M1 上の Claude Code で一緒に実施する前提。

---

## 0. これは何 / なぜ今日やるか

qpdf の Mac arm64 バイナリ同梱は **完了済**(commit `5a52bbb`、Windows 側で SHA256/Mach-O/配線を検証済)。
残るのは **「インストールしたアプリから qpdf が実際に動くか」の実機確認だけ**。これは物理 M1 でしか
できない。**M1 がしばらく触れなくなるので、今日ローカルビルドで閉じてしまう。**

> ⚠️ **絶対にやらないこと**: タグを push しない (`v2.0.0` も `v2.0.0-rc.1` も NG)。
> updater が `allowPrerelease = true` のため、タグを切ると **Windows の β テスターに配信されてしまう**。
> 検証は **`--publish=never` のローカルビルドのみ**で行う。

---

## 1. 前提チェック

```bash
sw_vers                              # ProductVersion が 26.0 以上であること(★必須)
node -v                              # 22 系を想定
cd <リポジトリ>                       # commit 5a52bbb を出したクローン
git pull --ff-only origin main
git log --oneline -1                 # b21d7d9 以降であること
```

- ★ **macOS 26.0 未満だと同梱 qpdf が dyld に起動拒否される**(bundle の minos=26.0)。
  M1 が 26 未満なら、その機体はそもそも配布対象外なので検証機として不適 → 26+ の機体で実施。

---

## 2. ローカルビルド(publish しない)

```bash
npm ci
npm run build:mac          # = electron-builder --mac --publish=never
```

- 成果物:
  - `release/mac-arm64/K-PDF3.app`(アンパック済アプリ。これを直接起動してもよい)
  - `release/K-PDF3-2.0.0-beta.147-arm64.dmg`(配布形態の dmg)
- もし native 依存 (`better-sqlite3`) でビルドが失敗したら:
  ```bash
  npm run rebuild            # electron-rebuild -f -w better-sqlite3
  npm run build:mac
  ```

---

## 3. 同梱 qpdf がコピーされたか(ビルド直後に確認)

```bash
ls -l  "release/mac-arm64/K-PDF3.app/Contents/Resources/qpdf/bin/qpdf"
ls -l  "release/mac-arm64/K-PDF3.app/Contents/Resources/qpdf/lib/"
```

- **合格**: `bin/qpdf`(実行権限 `-rwxr-xr-x`)+ `lib/` に
  `libqpdf.30.dylib` / `libjpeg.8.dylib` / `libcrypto.3.dylib` の 3 つが在る。
  → `package.json` の `extraResources` (`vendor/qpdf/mac → qpdf`) が効いている証拠。
- (任意)同梱バイナリ単体の起動確認:
  ```bash
  "release/mac-arm64/K-PDF3.app/Contents/Resources/qpdf/bin/qpdf" --version   # → 12.3.2
  ```

---

## 4. ★本命: アプリ経由のセキュア書き出し

1. `release/mac-arm64/K-PDF3.app` を起動(または手順 6 で dmg をインストールして起動)。
2. 適当な PDF を開く →「**名前を付けて保存**」→ **メタデータ除去(セキュア)を ON** にして保存。
3. **確認 A**: エラーなく書き出せる(= Electron から qpdf を spawn できている)。
4. **確認 B**: 出力 PDF のメタデータが除去されている。
   ```bash
   # exiftool があれば:
   exiftool 出力.pdf | grep -iE "Producer|Author|Title|Creator|Metadata"
   #   → Author/Producer/Title 等が空 になっていれば OK
   # 無ければ: brew install exiftool   または プレビュー/Adobe の「プロパティ」で目視
   ```

> これが通れば `QPDF-MAC-TODO.md` の **#188-189(spawn + extraResources コピー経路)が完了**。

---

## 5. (推奨)Gatekeeper / quarantine 下での確認 — #186-187

ローカルビルドの .app は「ダウンロード」していないので隔離フラグが付かず、Gatekeeper のチェックが
素通りになる。配布(ダウンロード)形態を**疑似再現**して、子プロセス qpdf が弾かれないか確かめる:

```bash
xattr -rw com.apple.quarantine "0081;0;Manual;" "release/mac-arm64/K-PDF3.app"
```

- Finder からダブルクリック → 「開発元を確認できない」等で止まったら **右クリック → 開く** で許可。
- 許可後、**もう一度 手順 4 のセキュア書き出し**を実行 → qpdf が起動して書き出せるか。
- もし qpdf 側が弾かれた/解除したい時:
  ```bash
  xattr -dr com.apple.quarantine "release/mac-arm64/K-PDF3.app"
  ```
- 同梱 bin/qpdf と全 dylib は **ad-hoc 署名済**なので、右クリック開く後は通る見込み。

---

## 6. (任意)dmg からのインストールも試す

より本番に近づけたい場合:
```bash
open "release/K-PDF3-2.0.0-beta.147-arm64.dmg"   # マウント → アプリを /Applications へドラッグ
```
インストールした `/Applications/K-PDF3.app` を「右クリック → 開く」で起動し、手順 4 を再実行。
(dmg 経由だと quarantine が自然に付くので、手順 5 の疑似付与は不要)

---

## 7. 成功条件(これが揃えば Mac 残務は実質クローズ)

- [ ] 手順 3: `Resources/qpdf/{bin,lib}` が揃っている(qpdf 同梱の実証)
- [ ] 手順 4: セキュア書き出しがエラーなく完了 + メタデータが空
- [ ] 手順 5 or 6: quarantine 付き(右クリック開く後)でも qpdf が起動した
- [ ] (任意)`findQpdfBinary` が同梱版を使っている(system の `brew` qpdf に落ちていない)
      → 手順 3 で Resources 配下に在ることが確認できていれば、packaged app は必ずそちらを先に使う

**うまくいかない時に共有してほしいもの**:
- 画面のエラーメッセージ全文
- `Console.app`(コンソール)で K-PDF3 起動〜書き出し時刻のログ
- `otool -L "…/Resources/qpdf/bin/qpdf"` の出力(依存解決の確認)

---

## 8. 注意

- **vendor/qpdf/mac は触らない**(今日は検証だけ)。万一バイナリを作り直す必要が出たら別途相談
  (`QPDF-MAC-TODO.md` §3 の手順がある)。
- **コミット/タグ/push は不要**。`release/` は成果物置き場で gitignore 対象。
- 背景の詳細: `vendor/qpdf/mac/NOTICE.txt`(出所/SHA256/最低OS)、`QPDF-MAC-TODO.md`(全体手順)。
</content>
