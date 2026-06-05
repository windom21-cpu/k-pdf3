# qpdf macOS バンドル — やるべきこと（詳細 TODO）

最終更新: 2026-06-05 / 対象: K-PDF3 stable (v2.0.0) リリース前の必須作業
作業環境: **実機 Mac が必須**（WSL / Linux からは作成不可）

> ✅ **2026-06-05 決定 (ユーザー確認済): 配布先 Mac は Apple Silicon (M1 以上) のみ・Intel 機なし。**
> → **arm64 専用ビルドで確定** (universal2 / Rosetta / lipo は不要)。`package.json` の
> `build.mac.target[0].arch` は既に `["arm64"]` に変更済 (2026-06-05)。ビルドは M1 でネイティブに作れる。
> 残作業は「M1 で arm64 qpdf を `vendor/qpdf/mac/{bin,lib}/` に自己完結配置 → 検証 → commit」のみ。

---

## 0. これは何か（背景）

K-PDF3 は「セキュア書き出し（PDF のメタデータ除去 = `--remove-info --remove-metadata`）」に
**qpdf** を使う。配布対象は **Windows / macOS / Linux の 3 OS**。

| OS | qpdf 同梱状況 |
|----|---------------|
| Windows | ✅ 同梱済（`vendor/qpdf/win/`、qpdf 12.3.2 msvc64） |
| Linux | ✅ 同梱済（`vendor/qpdf/linux/`、2026-06-03、公式 portable 12.3.2） |
| **macOS** | ❌ **未対応 ← この TODO の作業** |

**なぜ Mac だけ手作業か**: qpdf 公式リリースは Windows と Linux のプリビルドしか配布しておらず、
**macOS 用バイナリが存在しない**。よって Homebrew 等で入れた qpdf を「自己完結（システムの
dylib に依存しない）」状態に再パッケージして同梱する必要がある。これは Mac 上でしかできない。

---

## 1. すでに出来ていること（コード側の配線）

**残作業は「正しいレイアウトで Mac 用 qpdf を `vendor/qpdf/mac/` に置いてコミットする」だけ**。
コード・ビルド設定は対応済み:

- `src/main/qpdf-sanitize.js` の `findQpdfBinary()` は **mac では `bin/qpdf` を探す**ように対応済
  （win=flat の `qpdf.exe` / mac・linux=`bin/qpdf` + `lib/`）。
  - 配布時: `<resources>/qpdf/bin/qpdf`
  - dev 時: `vendor/qpdf/mac/bin/qpdf`
  - 見つからなければ PATH 上の system qpdf にフォールバック。
- `package.json` の `build.mac.extraResources` に `vendor/qpdf/mac → qpdf` を設定済。
  → **`vendor/qpdf/mac/{bin,lib}/` にバイナリを置けば、ビルド時に自動で `resources/qpdf/{bin,lib}/`
  へコピーされ、アプリが見つける。**

---

## 2. 期待する最終レイアウト

Linux 版（`vendor/qpdf/linux/`）と同じ `bin/` + `lib/` 構造に揃える:

```
vendor/qpdf/mac/
  bin/qpdf                  # 実行バイナリ（実行権限 +x、依存 dylib は @executable_path/../lib を参照）
  lib/libqpdf.30.dylib      # 本体ライブラリ
  lib/lib*.dylib            # 依存（gnutls / nettle / jpeg など、qpdf が動くのに必要な dylib 一式）
  NOTICE.txt                # 出所・バージョン・ライセンス（vendor/qpdf/linux/NOTICE.txt を参考に作成）
```

`findQpdfBinary` が `bin/qpdf` を探すので、必ず `bin/` 配下に置くこと。

---

## 3. 手順（Homebrew + dylibbundler）

### 3-0. 準備
```bash
brew install qpdf dylibbundler
qpdf --version
# → 理想は 12.3.2（Win/Linux と同一バージョン）。多少違ってもOKだが、その場合は
#   NOTICE.txt にバージョンを明記する。
```

### 3-1. バイナリと依存 dylib を集めて自己完結化
```bash
# 作業ディレクトリ（リポ外でよい。例: ~/qpdf-mac-build）
mkdir -p ~/qpdf-mac-build/{bin,lib} && cd ~/qpdf-mac-build

cp "$(brew --prefix qpdf)/bin/qpdf" bin/qpdf
chmod +x bin/qpdf

# 依存 dylib を lib/ に集め、参照を @executable_path/../lib/ に書き換える。
# （@executable_path = 実行バイナリのある bin/ なので、../lib = この lib/ を指す）
dylibbundler -od -b -x bin/qpdf -d lib/ -p @executable_path/../lib/
```

### 3-2. 自己完結性を検証（最重要）
```bash
# qpdf 本体の依存パスを確認
otool -L bin/qpdf
# 各 dylib の依存パスも確認
for f in lib/*.dylib; do echo "== $f =="; otool -L "$f"; done

# 起動確認
bin/qpdf --version        # → qpdf version 12.x.x が出れば OK
```
**合格条件**: `otool -L` の出力に `/opt/homebrew/...` や `/usr/local/...`（= Homebrew の場所）
が **残っていない**こと。`@executable_path/../lib/...` や `@rpath/...`、システム標準
（`/usr/lib/libSystem.B.dylib` 等の OS 同梱 dylib）のみになっていること。
- もし `/opt/homebrew/...` が残っていたら、その dylib は再配置されていない →
  `dylibbundler` を再実行、または `install_name_tool -change <旧> @executable_path/../lib/<名> <対象>`
  で手動修正。

### 3-3. アーキテクチャ（✅ arm64 専用で確定済）
**2026-06-05 決定**: 配布先は Apple Silicon (M1 以上) のみ・Intel 機なし (ユーザー確認済) →
**arm64 専用ビルドで確定**。`package.json` の `build.mac.target[0].arch` は既に `["arm64"]` に変更済。

- **やること: arm64 のみ用意すれば完了**
  M1 Mac で `brew install qpdf` すれば arm64 ネイティブの qpdf が入る。それを `dylibbundler` で
  自己完結化して `vendor/qpdf/mac/{bin,lib}/` に置くだけ。**universal2 / Rosetta / lipo は不要。**
  `lipo -info bin/qpdf` で `arm64` 単独になっていることだけ一応確認しておくとよい。

- ~~universal2 / 片アーキ妥協の判断~~ — Intel ユーザーが居ないため検討不要 (この節の旧手順は破棄)。
  将来 Intel Mac ユーザーが現れたら、x64 を Rosetta Homebrew で用意し `lipo -create` で結合 +
  `arch` を `["universal"]` に戻す、という拡張で対応可能 (今は不要)。

### 3-4. リポジトリに配置してコミット
```bash
cd <リポジトリ直下>   # 例: ~/k-pdf3 もしくは /path/to/k-pdf3-clone

rm -rf vendor/qpdf/mac/bin vendor/qpdf/mac/lib   # 既存があれば掃除
cp -R ~/qpdf-mac-build/bin vendor/qpdf/mac/bin
cp -R ~/qpdf-mac-build/lib vendor/qpdf/mac/lib

# NOTICE.txt を作成（vendor/qpdf/linux/NOTICE.txt を雛形に、出所/バージョン/ライセンスを記載）
#   - qpdf: Apache-2.0
#   - 同梱 dylib（gnutls=LGPL 等）の上流とライセンス

git add vendor/qpdf/mac
git update-index --chmod=+x vendor/qpdf/mac/bin/qpdf   # 実行権限を git に残す（重要）
git ls-files -s vendor/qpdf/mac/bin/qpdf               # → 100755 になっていることを確認
git commit -m "feat(qpdf): macOS バイナリを同梱 (stable 残務 #5 完了)"
git push
```

### 3-5. 署名 / Gatekeeper（未署名配布のため要確認）
K-PDF3 は未署名配布（初回「右クリック→開く」運用、ADR / HANDOVER 参照）。
同梱 qpdf を子プロセス起動する際に Gatekeeper / quarantine で弾かれないか、
**実機で dmg からインストールした配布形態で必ず確認**すること。
- 弾かれる場合の対処候補:
  - ad-hoc 署名（配置前に実施）: `codesign -s - --force vendor/qpdf/mac/bin/qpdf vendor/qpdf/mac/lib/*.dylib`
  - ユーザーに案内: `xattr -dr com.apple.quarantine /Applications/K-PDF3.app`
  - 恒久解決: Developer ID 署名 + notarization（証明書が必要、現状は未導入）

---

## 4. 動作確認（配置後）

1. Mac で `npm install` → `npm start`（または dmg をビルドしてインストール）。
2. PDF を開く → 「保存（名前を付けて保存）」でセキュア書き出し（メタデータ除去 ON）を実行 →
   **エラーなく書き出せるか**。
3. 書き出した PDF のメタデータが除去されているか（`exiftool 出力.pdf` 等で Producer/Metadata を確認）。
4. （任意）`findQpdfBinary()` が同梱 `bin/qpdf` を返しているか（system qpdf に落ちていないか）を確認。

---

## 5. どうしても Mac ビルドが困難な場合の代替

- **system qpdf フォールバック**: 現状 `findQpdfBinary` は PATH の qpdf も探すので、Mac ユーザーに
  `brew install qpdf` を案内すれば動く（ただし「同梱で完結」という配布要件は満たさない）。
- **best-effort 化**: qpdf 不在時にセキュア書き出しをハードエラーにせず
  「メタデータ除去はスキップ」の警告に落とす実装に変える案もある（別途実装依頼が必要）。

---

## 6. ⚠️ 最重要

**この作業が終わるまで stable（3 OS）タグを切らないこと。**
- β タグ（`v*-beta.*`）は **Windows のみビルド**なので、この未対応の影響を受けない（今は安全）。
- stable タグ（`-beta` 無し、例 `v2.0.0`）で初めて macOS がビルドされ、qpdf 不在だと
  **mac 版のセキュア書き出しが失敗**する。

---

## 7. チェックリスト

- [x] `brew install qpdf dylibbundler`（2026-06-05、qpdf 12.3.2 / dylibbundler 1.0.5）
- [x] 依存 dylib を `@executable_path/../lib/` に再配置（dylibbundler が 1.0.5 で病的ループに陥ったため
      `install_name_tool` で手動バンドル。依存は閉じグラフ 3 個 = libqpdf.30 / libjpeg.8 / libcrypto.3）
- [x] `otool -L` で `/opt/homebrew` `/usr/local` 依存ゼロを確認（自己完結。残るは OS 同梱 libSystem/libc++/libz のみ）
- [x] `bin/qpdf --version` 起動確認（`env -i` のクリーン環境でも 12.3.2）
- [x] 配布アーキを arm64 専用に確定 (2026-06-05、`arch: ["arm64"]` 反映済 / universal2 不要)
- [x] `lipo -info bin/qpdf` が `arm64` 単独であることを確認
- [x] `vendor/qpdf/mac/{bin,lib}/` に配置 + `NOTICE.txt` 作成（README.md も配置済へ更新）
- [x] `git update-index --chmod=+x vendor/qpdf/mac/bin/qpdf`（`git ls-files -s` = 100755 確認済）
- [x] qpdf 単体での機能確認: 実 PDF を `--remove-info --remove-metadata` で Info(Author/Producer/Title) 除去を確認
- [x] コミット & push（commit `5a52bbb`）
- [ ] ⚠️ Gatekeeper / quarantine で子プロセス起動が弾かれないか **実機 dmg で確認**（← stable ビルド時。bin/qpdf と
      全 dylib は ad-hoc 署名済なので弾かれない見込みだが、dmg からインストールした配布形態での最終確認が必要）
- [ ] ⚠️ Mac でアプリ起動 → セキュア書き出し成功 + メタデータ除去を **アプリ経由で確認**（← stable ビルド時。
      qpdf 単体は確認済だが Electron からの spawn + extraResources コピー経路は dmg ビルドで確認）
- [x] 完了したら HANDOVER の stable 残務 #5 と `package.json` の arch 設定を最終確認（arch=`["arm64"]` / extraResources OK）
