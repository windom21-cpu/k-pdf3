# qpdf — macOS バンドル（配置済 / arm64 専用）

**現状：配置済（2026-06-05）。** Apple Silicon (arm64) 実機の Homebrew qpdf 12.3.2 を
依存 dylib ごと自己完結化して同梱しています。

```
bin/qpdf                実行バイナリ (arm64、@executable_path/../lib を参照、ad-hoc 署名済)
lib/libqpdf.30.dylib    本体ライブラリ
lib/libjpeg.8.dylib     依存 (jpeg-turbo)
lib/libcrypto.3.dylib   依存 (OpenSSL crypto)
```

- 自己完結性: `otool -L` の全出力に `/opt/homebrew`・`/usr/local` 依存ゼロ（OS 同梱の
  `libSystem` / `libc++` / `libz` のみ）。`env -i bin/qpdf --version` が 12.3.2 を返すことを確認済。
- アーキ: **arm64 単独**（universal2 ではない）。配布先は Apple Silicon のみ・Intel 機なしの方針による。
- 出所・バージョン・ライセンス・SHA256 は [`NOTICE.txt`](./NOTICE.txt) を参照。

> 詳細手順・チェックリストはリポジトリ直下の [`QPDF-MAC-TODO.md`](../../../QPDF-MAC-TODO.md) を参照。
> 将来 Intel Mac 対応が必要になったら x64 を Rosetta Homebrew で用意し `lipo -create` で universal 化する。
