# qpdf — macOS バンドル（未配置・要・実機ビルド）

**現状：未配置。** macOS 用 qpdf バイナリは `vendor/qpdf/mac/bin/qpdf` + `vendor/qpdf/mac/lib/*.dylib`
として**ここに置く必要があります**が、qpdf 公式は macOS プリビルドを配布していないため、
**実機 Mac でのビルド/バンドルが必要**です（WSL/Linux からは作成不可）。

👉 **詳細な手順・チェックリストはリポジトリ直下の [`QPDF-MAC-TODO.md`](../../../QPDF-MAC-TODO.md) を参照してください。**

> ⚠️ 未配置のまま stable（3 OS）タグをビルドすると mac 版のセキュア書き出しが失敗します。
> β タグは Windows のみビルドのため当面は影響なし。
</content>
