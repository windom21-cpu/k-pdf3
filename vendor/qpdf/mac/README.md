# qpdf — macOS バンドル (要・実機ビルド)

**現状：未配置。** macOS 用 qpdf バイナリは**ここに置く必要があります**が、qpdf 公式は
macOS のプリビルドを配布していないため（Windows / Linux のみ）、**実機 Mac で用意**する
必要があります。WSL/Linux からは生成できません。

`package.json` の `build.mac.extraResources` は `vendor/qpdf/mac → qpdf` を指しており、
`src/main/qpdf-sanitize.js` は **`<resources>/qpdf/bin/qpdf`**（RUNPATH/install_name で
`lib/` を解決）を探します。Linux と同じ **`bin/` + `lib/`** レイアウトに揃えてください。

> ⚠️ これが未配置のまま **stable（3 OS）タグをビルドすると、mac 版は qpdf が見つからず
> セキュア書き出し（メタデータ除去）が失敗します**。β は Windows のみビルドなので当面影響なし。

## 期待する最終レイアウト
```
vendor/qpdf/mac/
  bin/qpdf                 # 実行バイナリ (実行権限必須)
  lib/libqpdf.30.dylib     # 本体 + 依存 dylib 一式
  lib/lib*.dylib           # gnutls / nettle / jpeg などの依存
  NOTICE.txt               # 出所・SHA・ライセンス (Linux 版に倣う)
```

## 手順（Homebrew + dylibbundler の例）
Intel/Apple Silicon それぞれの Mac で（または `lipo` で universal 化して）実施：

```bash
# 1. qpdf と dylibbundler を入れる
brew install qpdf dylibbundler

# 2. 作業ディレクトリを作り、qpdf 本体をコピー
mkdir -p out/bin out/lib
cp "$(brew --prefix qpdf)/bin/qpdf" out/bin/qpdf
chmod +x out/bin/qpdf

# 3. 依存 dylib を out/lib に集め、参照を @executable_path/../lib に書き換え
#    (@executable_path = bin/ なので ../lib = out/lib を指す)
dylibbundler -od -b -x out/bin/qpdf -d out/lib/ -p @executable_path/../lib/

# 4. 自己完結性を確認 (システム dylib パスに依存せず動くか)
out/bin/qpdf --version            # → qpdf version 12.x.x が出れば OK
otool -L out/bin/qpdf             # @executable_path/../lib/ になっているか確認

# 5. out/bin, out/lib を vendor/qpdf/mac/ に配置してコミット
```

## 注意点
- **バージョン**：Windows/Linux 同梱が 12.3.2。brew が別版を入れることがあるので、
  揃えたい場合は `brew install qpdf` のバージョンを確認（多少のズレは可だが NOTICE に明記）。
- **アーキテクチャ**：dmg は x64 と arm64 の両方をビルドします。理想は `lipo -create` で
  universal2 の qpdf + 各 dylib を作ること。片アーキのみ用意する場合、もう一方の dmg では
  qpdf が動かない点に注意（その場合は PATH 上の system qpdf にフォールバックする）。
- **署名/Gatekeeper**：本アプリは未署名配布（初回「右クリック→開く」運用）。同梱バイナリを
  spawn する際 Gatekeeper に阻まれないか、実機の配布形態で要確認。必要なら `xattr -dr
  com.apple.quarantine` 案内 or ad-hoc 署名 (`codesign -s -`) を検討。
- 配置後、`vendor/qpdf/mac/bin/qpdf` の**実行権限**が git に残るよう
  `git update-index --chmod=+x vendor/qpdf/mac/bin/qpdf` を実行すること。
