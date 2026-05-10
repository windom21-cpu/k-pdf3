# K-pdf3 Favicon (Variation D3)

白地 × 赤い筆記体K（Great Vibes）+ 右下の小さな「3」と赤い罫線。

## ファイル
- `favicon.ico` — マルチサイズ ICO (16/32/48)
- `favicon.svg` — ベクター原本。フォントの輪郭を path 化済み（フォント未ロード環境でも崩れない）
- `favicon-16.png` 〜 `favicon-512.png` — 各種ラスター

## HTML への埋め込み

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/favicon-180.png">
<link rel="manifest" href="/site.webmanifest">
```

## site.webmanifest 例

```json
{
  "name": "K-pdf3",
  "short_name": "K-pdf3",
  "icons": [
    { "src": "/favicon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/favicon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "theme_color": "#D90E1A",
  "background_color": "#ffffff",
  "display": "standalone"
}
```

## 注意
- 筆記体 K は 16/32px だと細部が潰れます。タブのファビコンとしては「赤い文字」が認識の手がかりになりますが、視認性重視なら別案（A:Archivo Black など）の併用も検討を。
