// ζ Phase 1 (β63): pdf-lib による overlay の vector 描画。
//
// 現状の β62 経路は overlay を canvas でラスタライズして bbox PNG として
// PDF に embed していたが、ドライバが「ページ内に画像 XObject あり →
// 全面 raster fallback」する挙動を引いて、本文 vector が raster 化される
// 問題があった。
//
// 本ファイルでは pdf-lib の drawText を直接呼んで overlay を vector 命令
// として PDF に書き込む。プリンタはこれを vector text として受け取り、
// native DPI でレンダリングする → Adobe Reader 同等の質感。
//
// β63 スコープ: テキスト overlay のみ (rot=0)。他の overlay 種別
// (スタンプ・吹き出し・マーカー・墨消し・画像スタンプ) は引き続き
// β62 の bbox raster 経路で処理する (vectorEligible() で振り分ける)。
//
// β64+ で順次 vector 化予定: stamps → callout → marker/redaction。
// 画像スタンプは元から raster なので β62 raster のまま継続。

import fontkit from "@pdf-lib/fontkit";
import { rgb, degrees } from "pdf-lib";
import { loadSystemJapaneseTtf } from "./font-loader-win.js";

/**
 * pdf-lib PDFDocument に日本語 TTF を embed し、{ mincho, gothic } を返す。
 * - registerFontkit を初回に実行
 * - Win 用 font-loader-win から runtime 読み出した TTF bytes を embedFont
 * - 失敗時 (TTF 未発見・fsType=2 で除外・embedFont エラー) はそのフィールド
 *   が null になる。null フォントのテキストは raster fallback 行きになる
 *   よう、上位 (composePagesForExport) で振り分ける。
 *
 * @param {import("pdf-lib").PDFDocument} pdfDoc
 * @returns {Promise<{mincho: import("pdf-lib").PDFFont|null,
 *                    gothic: import("pdf-lib").PDFFont|null}>}
 */
export async function embedJapaneseFonts(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);

  const result = { mincho: null, gothic: null };
  for (const name of /** @type {const} */ (["mincho", "gothic"])) {
    const found = loadSystemJapaneseTtf(name);
    if (!found) continue;
    try {
      // subset: true で「使用文字だけ」を埋め込み、ファイルサイズを抑える。
      // 法的にも fsType=4 (Preview & Print) の subset 経路は許諾範囲内。
      result[name] = await pdfDoc.embedFont(found.bytes, { subset: true });
    } catch (err) {
      console.warn(
        `[overlay-pdf-draw] embedFont(${name}) failed:`,
        err?.message ?? err,
      );
      // null のまま → 該当フォントの overlay は raster fallback へ
    }
  }
  return result;
}

/** β63 で vector 描画できる overlay 種別の判定。条件を満たさないものは
 *  上位で β62 raster 経路に流す。 */
export function isVectorEligibleOverlay(ov, fonts) {
  if (!ov || ov.type !== "text") return false;
  const props = ov.properties ?? {};
  // rotation 付きテキストは β64 で対応予定。現状 raster fallback。
  const rot = (((props.rotation ?? 0) % 360) + 360) % 360;
  if (rot !== 0) return false;
  // フォント選択: fontId が指す系列の embed が成功している必要あり
  const fontKey = resolveFontKey(props.fontId);
  if (!fonts || !fonts[fontKey]) return false;
  return true;
}

/** props.fontId を mincho/gothic に解決。
 *  - "gothic" → "gothic"
 *  - "mincho" / "numeric" (β31 backward compat) / それ以外 → "mincho"
 *  numeric は β31 で導入された「全フォント mincho + 数字 hanko」のための
 *  内部 ID で、β32 で別軸化されたが backward compat で残置。 */
function resolveFontKey(fontId) {
  if (fontId === "gothic") return "gothic";
  return "mincho";
}

/** "#rrggbb" or "#rgb" を pdf-lib rgb() に変換。 */
function parseHexColor(hex) {
  if (typeof hex !== "string") return rgb(0, 0, 0);
  let s = hex.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length !== 6) return rgb(0, 0, 0);
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return rgb(0, 0, 0);
  }
  return rgb(r, g, b);
}

/**
 * テキスト overlay を pdf-lib drawText で page に描く。
 * canonical (top-left 原点、point 単位) を PDF 座標 (bottom-left 原点)
 * に変換する。
 *
 * 仕様維持:
 * - β25/β34: overstroke (fill + stroke を同色で重ねて print の AA halo
 *   を埋める)。borderColor = color、borderWidth = fontSize * 0.06 (bold)
 *   or 0.03 (non-bold)。
 * - line wrapping は pdf-lib drawText の maxWidth を使用 (内部で word
 *   break + line breaking してくれる)。canvas の wrapCanvasText とは
 *   アルゴリズムが完全一致ではないので、極稀に 1〜2 文字位置差が出る
 *   可能性 (実用上問題なし)。
 * - lineHeight は props.lineHeight × fontSize、未指定なら fontSize × 1.0
 *
 * @param {import("pdf-lib").PDFPage} page
 * @param {object} ov          overlay (type="text")
 * @param {object} opts
 * @param {number} opts.pageHt 該当ページの post-rotation 高さ (point)
 * @param {{mincho: import("pdf-lib").PDFFont|null,
 *          gothic: import("pdf-lib").PDFFont|null}} opts.fonts
 */
export function drawTextOverlayVector(page, ov, opts) {
  const props = ov.properties ?? {};
  const fontKey = resolveFontKey(props.fontId);
  const font = opts.fonts[fontKey];
  if (!font) {
    // Caller should have filtered via isVectorEligibleOverlay first;
    // ここに来るのは bug か race 状態。安全に no-op。
    return;
  }

  const text = String(props.text ?? "");
  if (text.length === 0) return;

  const fontSize = Number(props.fontSize ?? 12);
  if (!(fontSize > 0)) return;

  const color = parseHexColor(props.color ?? "#000000");
  const lineHeightMul = Number.isFinite(props.lineHeight) ? props.lineHeight : 1.0;
  const lineHeight = fontSize * lineHeightMul;

  // β34: 太字 (bold) は独立軸。OFF=細 (overstroke 0.03)、ON=太 (0.06)。
  // 印刷で AA halo が薄く出るのを overstroke で埋める設計。
  const isBold = !!props.bold;
  const strokeWidth = fontSize * (isBold ? 0.06 : 0.03);

  // canonical (top-left) → PDF (bottom-left) 座標変換
  // canonical 上で text 矩形は (ov.x, ov.y, ov.w, ov.h)。
  // テキストは矩形内で TOP 詰め (canvas textBaseline="top")。
  // PDF drawText は baseline 基準の y を取るので:
  //   baseline_y_pdf = pageHt - ov.y - font.ascentAtSize(fontSize)
  // x は左端そのまま。
  const x = Number(ov.x ?? 0);
  const yTop = Number(ov.y ?? 0);
  const w = Number(ov.w ?? 0);
  const ascent = typeof font.ascentAtSize === "function"
    ? font.ascentAtSize(fontSize)
    : fontSize * 0.85; // fallback (ascent ≒ 85% of font size for Japanese)
  const baselineY = opts.pageHt - yTop - ascent;

  page.drawText(text, {
    x,
    y: baselineY,
    size: fontSize,
    font,
    color,
    lineHeight,
    // maxWidth で word-wrap させる。最低 1pt 確保で 0 div 回避。
    maxWidth: Math.max(1, w),
    // overstroke: 同色で stroke を重ねて AA halo を埋める。border 系
    // option は pdf-lib v1.17+ で利用可能。
    borderColor: color,
    borderWidth: strokeWidth,
  });
}

/** デバッグ用: フォント embed 状況を report 形式で返す。 */
export function reportFontsState(fonts) {
  return {
    mincho: !!fonts?.mincho,
    gothic: !!fonts?.gothic,
  };
}

// degrees は将来 rot != 0 対応で使う想定 (β64+)。lint silencer。
void degrees;
