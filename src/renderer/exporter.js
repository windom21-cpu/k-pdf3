// Renderer-side export composer (M4-1).
//
// For each page in the workspace:
//   1. ask main to render the source page at EXPORT_ZOOM via the existing
//      kpdf3.renderPage IPC,
//   2. paint the returned RGBA bytes onto a Canvas,
//   3. paint the page's overlays on top using Canvas 2D APIs,
//   4. extract the composed canvas as a PNG byte array.
//
// The collected PNGs (with their canonical PDF-point dimensions) are then
// shipped to main where mupdf assembles them into a flat PDF.
//
// EXPORT_ZOOM is 900 / 72 — exactly 900 dpi (β31 bumped from 600 dpi).
// β30 testers still reported visible AA dots on printed text; doubling
// stroke (β31 A) plus raising the raster density (β31 B) together push
// the AA fringe below the printer's perceivable threshold without
// requiring vector-text assembly. β3 testers had ruled out 144 dpi as
// unusable and 288 dpi as short of Adobe-baseline quality; 600 dpi was
// β4-β30 baseline; 900 dpi keeps PNG buffers within Canvas dimension
// limits (~7440×10530 px for A4) and PNG output stays under a few MB
// per page on text-heavy content.

import { canonicalPageSize } from "../domain/coord.js";
import {
  getTextFontStack,
  getStampFontDefaults,
  getStampFontStack,
  splitStampRuns,
  isMsMinchoFontName,
} from "./fonts.js";

/**
 * In-memory cache: assetId → ImageBitmap. The bitmap survives the
 * Blob it was created from, so it's safe to reuse across multiple
 * compositePage / drawOverlay calls.
 */
const _assetBitmapCache = new Map();
async function getAssetBitmap(assetId) {
  if (_assetBitmapCache.has(assetId)) return _assetBitmapCache.get(assetId);
  const data = await globalThis.kpdf3?.getAsset?.(assetId);
  if (!data?.blob) return null;
  const u8 = data.blob instanceof Uint8Array
    ? data.blob
    : new Uint8Array(data.blob.buffer ?? data.blob);
  const blob = new Blob([u8], { type: data.mime || "image/png" });
  const bitmap = await createImageBitmap(blob);
  _assetBitmapCache.set(assetId, bitmap);
  return bitmap;
}

/** Drop a single asset from the bitmap cache (e.g. when the user
 *  removes / replaces an asset and we want a fresh fetch next time). */
export function invalidateAssetBitmap(assetId) {
  const bm = _assetBitmapCache.get(assetId);
  if (bm) bm.close?.();
  _assetBitmapCache.delete(assetId);
  for (const k of [..._tintedAssetCache.keys()]) {
    if (k.startsWith(`${assetId} `)) _tintedAssetCache.delete(k);
  }
}

/**
 * Cache for color-tinted variants used at export time. The tinted
 * canvas matches the source bitmap's natural size; drawImage scales it
 * to the overlay box exactly like the untinted path. Mirrors the
 * viewer's `_tintedStampUrl` logic but keeps a HTMLCanvasElement
 * (drawImage source) instead of an object URL.
 */
const _tintedAssetCache = new Map();
async function getTintedAssetCanvas(assetId, color) {
  if (!color) return null;
  const key = `${assetId} ${color}`;
  if (_tintedAssetCache.has(key)) return _tintedAssetCache.get(key);
  const bitmap = await getAssetBitmap(assetId);
  if (!bitmap) return null;
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  if (color === "bg-transparent") {
    // β.87: 閾値 ramp (詳細は stamp-helpers.js rampLumToAlpha 参照)。
    // 線形 lum → alpha だとカラー印影が 60-70% 透過で薄く印刷される
    // 問題を解消し、カラー / 白黒の 1 登録で両用できるようにした。
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const factor = lum <= 0.5 ? 1.0 : lum >= 0.85 ? 0.0 : 1 - (lum - 0.5) / 0.35;
      d[i + 3] = Math.round(d[i + 3] * factor);
    }
  } else {
    const [tr, tg, tb] = parseHexColor(color);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const factor = lum <= 0.5 ? 1.0 : lum >= 0.85 ? 0.0 : 1 - (lum - 0.5) / 0.35;
      d[i + 3] = Math.round(d[i + 3] * factor);
      d[i] = tr;
      d[i + 1] = tg;
      d[i + 2] = tb;
    }
  }
  ctx.putImageData(img, 0, 0);
  _tintedAssetCache.set(key, canvas);
  return canvas;
}

/**
 * β31: same-color overstroke + fill for every rasterized glyph run.
 * Canvas 2D fillText anti-aliases edges to subpixel alpha → printer
 * reproduces the halo as gray dots ("ドット感"). A thin stroke under
 * the fill at the same color paints over the halo so the glyph reads
 * as solid color on paper. Caller pre-configures ctx.font /
 * ctx.textBaseline / ctx.textAlign.
 *
 * β34: the rasterised output ALWAYS overstrokes regardless of the
 * on-screen 太字 toggle — printed paper must stay dark whether or not
 * the user wanted the on-screen glyphs to look thin. The toggle only
 * affects the viewer's CSS (-webkit-text-stroke), so:
 *
 *   太字 OFF (default) → viewer: no stroke / exporter: lineWidth 0.03 ×
 *                                   fontSize (β25 baseline, just enough
 *                                   to plug the AA fringe)
 *   太字 ON           → viewer: stroke 0.06×fontSize / exporter: same
 *
 * Text stamp / distribute-3 keep their original bold print weight (opts
 * omitted → bold default true).
 *
 * β41 (I4): date stamps explicitly opt OUT of overstroke (opts.stroke
 * = false) — β31 had unintentionally bolded them along with text
 * overlay, but a date 押印 is not 印影 and the user wants the original
 * pre-β31 weight back. Skipping strokeText entirely (rather than just
 * thinning) matches the original look. The 900dpi raster has enough
 * resolution that fillText's AA halo doesn't reproduce as gray.
 */
function paintGlyphRun(ctx, text, x, y, color, fontSize, opts = {}) {
  const stroke = opts.stroke !== false; // default true (legacy)
  const bold = opts.bold !== false; // default true for stamp / 印影 compat
  const hairline = opts.hairline === true; // β76: 明朝/serif 専用の極細 stroke
  ctx.save();
  ctx.fillStyle = color;
  if (stroke) {
    ctx.strokeStyle = color;
    // Bold: 0.06 (見た目はっきり太字)。Plain: 0.03 (AA halo を覆う最小、
    // β34 値)。Hairline: 0.02 (β76、明朝の hairline AA halo が紙で
    // gray dot になるのを防ぐ。0.03 は「ちょっと太く感じる」と言われる
    // ので 1/3 細くした、太字との中間ではなく非太字の薄い補強)。
    let widthFactor;
    if (bold) widthFactor = 0.06;
    else if (hairline) widthFactor = 0.02;
    else widthFactor = 0.03;
    ctx.lineWidth = fontSize * widthFactor;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeText(text, x, y);
  }
  ctx.fillText(text, x, y);
  // hairline モード (明朝/serif + 太字 OFF) では glyph の太さは変えずに
  // 密度だけ上げて紙でのドット化を解消する。fillText を同じ位置に重ね
  // 描きすると source-over 合成式 `dst = src*α + dst*(1-α)` で AA 縁の
  // alpha だけが段階的に上がり、glyph 中心は元から完全黒なので不変。
  // β.140: 2 回打ち (AA α 0.5 → 0.75) では明朝横線 (元から細く中心 α=1.0
  // 不在) が紙でドット化残留。β.141: 4 回打ちで AA α 0.5 → 0.9375 まで
  // 強化し、横線の見かけ濃度を底上げ。中心 α=1.0 は何回打っても 1.0 の
  // ままなので太さ不変。縦線・払いも更に締まる。
  if (hairline) {
    ctx.fillText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

/** β76: serif/mincho 系フォントは hairline がほそく、900dpi raster でも
 *  AA halo がトナーに乗らず紙で薄く見える。bold OFF + これらのフォント
 *  に限り、極細 overstroke (0.02×fontSize) で補強する。
 *  Gothic / sans は元々ストロークが太いので何もしない (β73 状態を維持)。 */
function _needsHairlineStroke(fontId) {
  // システムフォント名で MS明朝を選んだ場合も preset mincho と同じ字形
  // なので同じ補強を掛ける (ベクター化されない legacy 印刷 / FAX 経路用)。
  return fontId === "mincho" || fontId === "serif" || isMsMinchoFontName(fontId);
}

// ---- v2.0.13 ベクターテキスト層 -----------------------------------------
//
// text / form_field(text) overlay のうち MS 明朝 (fontId/fontFace ===
// "mincho") のものを、900dpi ラスタ PNG ではなく「行 = 1 op」の配置命令
// (vectorTexts) として main へ送り、assembleHybridPdf が MS 明朝サブセット
// 埋め込みの実テキストとして焼く。ラスタ AA テキストは printer の
// ハーフトーン網点化 + 900→600dpi リサンプリングで Word より薄く出る
// ことが実機検証 (spike/print-density-sheet.mjs, 2026-07-06) で確定した
// ため。行分割・整列はこれまで通り canvas 採寸 (wrapCanvasText) で行い、
// 画面 (viewer) と紙の行分割が一致することを最優先する。
//
// フォールバック規則 (= 従来ラスタのまま):
//   - fontId が preset "mincho" でも MS明朝系フォント名でもない (gothic /
//     他のシステムフォント名 等 — Gothic はラスタでも濃く出るので実害
//     なし)。§8.2🟡: フォント一覧から選んだ "MS 明朝"/"MS Mincho" 等は
//     isMsMinchoFontName で preset mincho と同格 (実体が同じ msmincho.ttc
//     subfont0 なので画面と紙の字形・行分割が一致する)。MS P明朝 (字幅
//     違い) や游明朝等 (字形違い) は対象外のままラスタ
//   - digitsHanko ON (CrashNumberingDigits との 2 フォント混植)
//   - MS 明朝にグリフの無い文字を含む (probe の missing 判定)
//   - フォントファイル自体が無い環境 (Mac/Linux → probe available=false)
//   - strategy "full" のページ (墨消し / synthetic / FAX は全面ラスタが仕様)

/** 採寸専用 offscreen ctx (module singleton)。 */
let _vtMeasureCtx = null;
function _vectorMeasureCtx() {
  if (_vtMeasureCtx) return _vtMeasureCtx;
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  _vtMeasureCtx = c.getContext("2d");
  return _vtMeasureCtx;
}

/**
 * canvas textBaseline="top" 描画とベースラインの距離 (px)。
 * フォント理論値ではなく「同じ ctx.font で top / alphabetic 双方の
 * actualBoundingBoxAscent を実測した差」で求める — Chromium が "top" を
 * どのメトリクスで実装していても、canvas 描画と PDF ベースラインが
 * ピクセル一致することを保証する。ctx.font 設定済みで呼ぶこと。
 * 値は ctx.font 文字列だけで決まるのでメモ化する (同一サイズの
 * フィールドが数百ある申請書一式で measureText を毎回走らせない)。
 */
const _baselineOffsetMemo = new Map();
function _baselineOffsetPx(ctx) {
  const key = ctx.font;
  const memo = _baselineOffsetMemo.get(key);
  if (memo !== undefined) return memo;
  const PROBE = "国Ag";
  const prev = ctx.textBaseline;
  ctx.textBaseline = "alphabetic";
  const aAlpha = ctx.measureText(PROBE).actualBoundingBoxAscent;
  ctx.textBaseline = "top";
  const aTop = ctx.measureText(PROBE).actualBoundingBoxAscent;
  ctx.textBaseline = prev;
  const off = aAlpha - aTop;
  _baselineOffsetMemo.set(key, off);
  return off;
}

/**
 * overlay がベクターテキスト候補なら描画テキストを、そうでなければ null。
 * probe の文字列収集と splitVectorTextOverlays の判定を一元化する。
 */
export function vectorTextCandidate(ov) {
  const props = ov?.properties ?? {};
  if (ov?.type === "text") {
    if (props.fontId !== "mincho" && !isMsMinchoFontName(props.fontId)) return null;
    if (props.digitsHanko) return null;
    const text = String(props.text ?? "");
    if (text.trim() === "") return null;
    return text;
  }
  if (ov?.type === "form_field" && (props.fieldKind ?? "text") === "text") {
    // fontFace 欠落は mincho 扱いにしない — drawOverlay/viewer は
    // getTextFontStack(undefined) = default (gothic) で描くので、ここで
    // mincho と見なすと画面 (gothic) と紙 (明朝埋め込み) の字形・行分割
    // が食い違う。overlay-placement は作成時に必ず fontFace を入れるが、
    // 旧データの取りこぼしに備えて strict に判定する。
    // (システムフォント名の MS明朝系は text 側と同じく mincho 同格)
    if (props.fontFace !== "mincho" && !isMsMinchoFontName(props.fontFace)) return null;
    const value = String(props.value ?? "");
    if (value.trim() === "") return null;
    return value;
  }
  return null;
}

/** drawOverlay の text 分岐 (rot 0/90/180/270) と同一レイアウトの op 列。 */
function _textOverlayVectorOps(ctx, ov, zoom, monoOverlays) {
  const props = ov.properties ?? {};
  const x = ov.x * zoom;
  const y = ov.y * zoom;
  const w = ov.w * zoom;
  const h = ov.h * zoom;
  const fontSizePx = (props.fontSize ?? 12) * zoom;
  const color = monoOverlays ? "#000000" : (props.color ?? "#000000");
  ctx.font = `${fontSizePx}px ${getTextFontStack(props.fontId, { digitsHanko: false })}`;
  const baseOff = _baselineOffsetPx(ctx);
  const lineHeightPx = fontSizePx * (props.lineHeight ?? 1);
  const rot = (((props.rotation ?? 0) % 360) + 360) % 360;
  // viewer は .overlay-text { overflow: hidden } で枠外を隠し、ラスタ経路
  // も bbox キャンバス (枠+8pt) で切れる。ベクターも同じ矩形でクリップ
  // しないと「画面に見えない溢れ行が紙にだけ出る」WYSIWYG 破りになる。
  const clip = {
    x: ov.x - 8, y: ov.y - 8, w: ov.w + 16, h: ov.h + 16,
  };
  const ops = [];
  const push = (text, px, py) => {
    if (text.trim() === "") return; // 空行は ink 無し
    ops.push({
      text,
      x: px / zoom,
      y: py / zoom,
      size: props.fontSize ?? 12,
      color,
      bold: !!props.bold,
      rot,
      clip,
    });
  };
  if (rot === 0) {
    const lines = wrapCanvasText(ctx, props.text ?? "", w);
    for (let i = 0; i < lines.length; i++) {
      push(lines[i], x, y + i * lineHeightPx + baseOff);
    }
  } else {
    // drawOverlay と同じ「pre-rotation 幅で wrap → 中心 anchor で回転」。
    // canvas の translate(cx,cy)+rotate(θ) で (lx,ly) に描く操作を、
    // 回転行列で canonical 座標へ展開する (θ は y 下向き系の視覚時計回り)。
    const isVert = rot === 90 || rot === 270;
    const naturalW = isVert ? h : w;
    const naturalH = isVert ? w : h;
    const lines = wrapCanvasText(ctx, props.text ?? "", naturalW);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const th = (rot * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    for (let i = 0; i < lines.length; i++) {
      const lx = -naturalW / 2;
      const ly = -naturalH / 2 + i * lineHeightPx + baseOff;
      push(lines[i], cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
    }
  }
  return ops;
}

/** drawOverlay の form_field(text) 分岐と同一レイアウトの op 列。 */
function _formFieldTextVectorOps(ctx, ov, zoom, monoOverlays) {
  const props = ov.properties ?? {};
  const x = ov.x * zoom;
  const y = ov.y * zoom;
  const w = ov.w * zoom;
  const h = ov.h * zoom;
  const fontSizePx = (props.fontSize ?? 12) * zoom;
  const color = monoOverlays ? "#000000" : (props.color ?? "#000000");
  ctx.font = `${fontSizePx}px ${getTextFontStack(props.fontFace)}`;
  const baseOff = _baselineOffsetPx(ctx);
  const padX = Math.max(1, zoom); // drawOverlay と同じ 1pt 内枠 padding
  const innerW = Math.max(0, w - 2 * padX);
  const value = String(props.value ?? "");
  const lines = value === "" ? [] : wrapCanvasText(ctx, value, innerW);
  if (lines.length === 0) return [];
  const lineHeightPx = fontSizePx * 1.2;
  const totalH = lines.length * lineHeightPx;
  const alignH = props.alignH ?? "left";
  const alignV = props.alignV ?? "middle";
  let baseY;
  if (alignV === "top") baseY = y;
  else if (alignV === "bottom") baseY = y + h - totalH;
  else baseY = y + (h - totalH) / 2;
  // text overlay と同じ理由でフィールド枠+8pt にクリップ (画面 overflow
  // hidden / ラスタ bbox 切りとの WYSIWYG 一致)。
  const clip = {
    x: ov.x - 8, y: ov.y - 8, w: ov.w + 16, h: ov.h + 16,
  };
  const ops = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const lineW = ctx.measureText(lines[i]).width;
    let lineX;
    if (alignH === "right") lineX = x + w - padX - lineW;
    else if (alignH === "center") lineX = x + (w - lineW) / 2;
    else lineX = x + padX;
    ops.push({
      text: lines[i],
      x: lineX / zoom,
      y: (baseY + i * lineHeightPx + baseOff) / zoom,
      size: props.fontSize ?? 12,
      color,
      bold: false,
      rot: 0,
      clip,
    });
  }
  return ops;
}

/** 2 つの overlay 矩形 (canonical pt) が重なるか。 */
function _overlayRectsIntersect(a, b) {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w
    && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/**
 * overlays を「ベクターテキスト op 列」と「従来ラスタで描く残り」に分割。
 *
 * z-order 保全: ラスタ経路は overlays を配列順 (= 重なり順) に 1 枚の
 * PNG へ描くが、ベクターテキストは常に最上層に乗る。そこで「候補より
 * 後に描かれる不透明系 overlay と矩形が重なる」テキストはベクター化
 * せずラスタに残す — 白塗り矩形・画像スタンプ等でテキストを隠す運用
 * (画面ではテキストが見えない) を、紙の上でも必ず維持するため。
 * マーカー (type "line"、半透明ハイライト) は隠す用途ではないので
 * 重なってもベクター化を許す (黒字がマーカーの上に乗る = 可読性は
 * むしろ上がる方向の僅差)。
 *
 * 墨消し保全: 墨消し overlay を 1 つでも持つページはベクター化を全面
 * 禁止する。通常経路は β.85 の strategy="full" 格上げで既にラスタ化
 * されるが、下敷き印刷 (overlay-only) は full 格上げの対象外なので、
 * ここで止めないと「墨消しの上に選択可能なテキスト」が出てしまう。
 *
 * @param {Array<any>} overlays  描画順 (= z 順) の overlay 配列
 * @param {Set<string>} missingSet  MS 明朝にグリフの無い文字 (probe 結果)
 * @param {number} zoom
 * @param {boolean} monoOverlays
 * @returns {{ raster: Array<any>, ops: Array<object> }}
 */
export function splitVectorTextOverlays(overlays, missingSet, zoom, monoOverlays) {
  if (overlays.some((ov) => ov?.type === "redaction")) {
    return { raster: overlays, ops: [] };
  }
  const raster = [];
  const ops = [];
  for (let i = 0; i < overlays.length; i++) {
    const ov = overlays[i];
    const cand = vectorTextCandidate(ov);
    const coveredLater = cand != null && overlays.slice(i + 1).some(
      (later) => later?.type !== "line" && _overlayRectsIntersect(ov, later),
    );
    if (cand != null && !coveredLater && ![...cand].some((ch) => missingSet.has(ch))) {
      // ctx はここで初めて要る (node テストは raster 側判定だけなら DOM 不要)
      const ctx = _vectorMeasureCtx();
      const generated = ov.type === "text"
        ? _textOverlayVectorOps(ctx, ov, zoom, monoOverlays)
        : _formFieldTextVectorOps(ctx, ov, zoom, monoOverlays);
      ops.push(...generated);
      continue; // ink の無い候補 (空白のみ) もラスタに戻す必要はない
    }
    raster.push(ov);
  }
  return { raster, ops };
}

// ---- β.100 / β.104 オートシェイプ helpers ------------------------------
//
// β.104: properties に length / crossSize を保持し、描画は中心 (0,0) を
// 起点に「右向き (= +X 軸方向)」で行ったあと ctx.rotate で arrowDir に
// 応じた角度に回転させる。これにより方向を変えても矢印の太さ・長さが
// 不変、bbox は AABB として派生計算 (length×crossSize の rotated AABB)
// なので斜めでも切れない。
//
// ── shape spec (overlay.properties) ──
//   kind:        "line" | "arrow" | "double-arrow"
//                | "block-arrow" | "double-block-arrow"
//                | "ellipse" | "ellipse-x"
//                | "rect" | "rounded-rect"
//   arrowDir:    8 方向 (kind に line/arrow 系が含まれる時のみ意味あり)
//   length:      矢印の長さ (pt、方向不変)。旧 shape は max(w,h) で互換
//   crossSize:   軸に直交する方向の bbox 大きさ (pt、方向不変)。
//                旧 shape は min(w,h) で互換
//   strokeColor: "#000000" 等
//   strokeWidth: pt (default 2)
//   fillColor:   null (中空) or "#xxxxxx"
//   thickness:   block-arrow の shaft 太さ比率 (0..1, default 0.5)
//   cornerRadius: rounded-rect の半径 (pt, default 8)
const SHAPE_DIR_TO_ANGLE = {
  "right":       0,
  "down-right":  45,
  "down":        90,
  "down-left":   135,
  "left":        180,
  "up-left":     225,
  "up":          270,
  "up-right":    315,
};

/** β.104: directional shape (line/arrow/block-arrow 系) かどうか判定。 */
function _isDirectionalShape(kind) {
  return kind === "line" || kind === "arrow" || kind === "double-arrow"
    || kind === "block-arrow" || kind === "double-block-arrow";
}

/** β.104: arrowDir + length + crossSize から AABB の (w, h) を計算する。
 *  軸並行 (right/down/left/up) では length × crossSize の対応、斜め
 *  方向 (down-right 等) では (length・|cos|+crossSize・|sin|) などで決定。
 *  center 座標は保持される (caller が cx/cy を渡す)。
 *
 *  @returns {{ w:number, h:number }}
 */
export function shapeDirectionalBbox(arrowDir, length, crossSize) {
  const angle = (SHAPE_DIR_TO_ANGLE[arrowDir] ?? 0) * Math.PI / 180;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const w = length * cos + crossSize * sin;
  const h = length * sin + crossSize * cos;
  return { w, h };
}

function _shapeEndpoints(dir, x, y, w, h, strokeWidth) {
  const pad = strokeWidth / 2 + 0.5;
  const cx = x + w / 2, cy = y + h / 2;
  switch (dir) {
    case "left":       return { p1: { x: x + w - pad, y: cy }, p2: { x: x + pad,     y: cy } };
    case "down":       return { p1: { x: cx, y: y + pad },     p2: { x: cx, y: y + h - pad } };
    case "up":         return { p1: { x: cx, y: y + h - pad }, p2: { x: cx, y: y + pad } };
    case "down-right": return { p1: { x: x + pad,     y: y + pad },     p2: { x: x + w - pad, y: y + h - pad } };
    case "down-left":  return { p1: { x: x + w - pad, y: y + pad },     p2: { x: x + pad,     y: y + h - pad } };
    case "up-right":   return { p1: { x: x + pad,     y: y + h - pad }, p2: { x: x + w - pad, y: y + pad } };
    case "up-left":    return { p1: { x: x + w - pad, y: y + h - pad }, p2: { x: x + pad,     y: y + pad } };
    case "right":
    default:           return { p1: { x: x + pad,     y: cy }, p2: { x: x + w - pad, y: cy } };
  }
}

/** ブロック矢印 (片端) の 7 頂点ポリゴン、双方版 (両端) の 10 頂点
 *  ポリゴン。bbox 軸に直交する方向の短辺で shaft 太さを決め、斜め
 *  方向は bbox 短辺で近似する (はみ出し許容)。 */
function _blockArrowShortSide(dir, bboxW, bboxH) {
  if (dir === "right" || dir === "left") return bboxH;
  if (dir === "down"  || dir === "up")   return bboxW;
  return Math.min(bboxW, bboxH); // diagonal
}

function _blockArrowPolygon(p1, p2, bboxW, bboxH, dir, thickness) {
  const shortSide = _blockArrowShortSide(dir, bboxW, bboxH);
  const totalLen = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
  const headWidth = shortSide;
  const shaftWidth = shortSide * thickness;
  const headLen = Math.min(shortSide * 1.0, totalLen * 0.4);
  const ux = (p2.x - p1.x) / totalLen;
  const uy = (p2.y - p1.y) / totalLen;
  const vx = -uy, vy = ux;
  const sh = shaftWidth / 2;
  const hh = headWidth / 2;
  const bx = p2.x - ux * headLen;
  const by = p2.y - uy * headLen;
  return [
    { x: p1.x + vx * sh, y: p1.y + vy * sh },
    { x: bx   + vx * sh, y: by   + vy * sh },
    { x: bx   + vx * hh, y: by   + vy * hh },
    { x: p2.x,           y: p2.y           },
    { x: bx   - vx * hh, y: by   - vy * hh },
    { x: bx   - vx * sh, y: by   - vy * sh },
    { x: p1.x - vx * sh, y: p1.y - vy * sh },
  ];
}

/** 双方ブロック矢印の 10 頂点ポリゴン。両端に head 三角、中央に shaft。 */
function _doubleBlockArrowPolygon(p1, p2, bboxW, bboxH, dir, thickness) {
  const shortSide = _blockArrowShortSide(dir, bboxW, bboxH);
  const totalLen = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
  const headWidth = shortSide;
  const shaftWidth = shortSide * thickness;
  const headLen = Math.min(shortSide * 1.0, totalLen * 0.3);
  const ux = (p2.x - p1.x) / totalLen;
  const uy = (p2.y - p1.y) / totalLen;
  const vx = -uy, vy = ux;
  const sh = shaftWidth / 2;
  const hh = headWidth / 2;
  // head の base 点 (両端から headLen 内側)
  const ax = p1.x + ux * headLen, ay = p1.y + uy * headLen; // p1 側 head 底
  const bx = p2.x - ux * headLen, by = p2.y - uy * headLen; // p2 側 head 底
  return [
    { x: p1.x,            y: p1.y           },             // tip1
    { x: ax + vx * hh,    y: ay + vy * hh   },             // head1 outer +
    { x: ax + vx * sh,    y: ay + vy * sh   },             // shaft start +
    { x: bx + vx * sh,    y: by + vy * sh   },             // shaft end +
    { x: bx + vx * hh,    y: by + vy * hh   },             // head2 outer +
    { x: p2.x,            y: p2.y           },             // tip2
    { x: bx - vx * hh,    y: by - vy * hh   },             // head2 outer -
    { x: bx - vx * sh,    y: by - vy * sh   },             // shaft end -
    { x: ax - vx * sh,    y: ay - vy * sh   },             // shaft start -
    { x: ax - vx * hh,    y: ay - vy * hh   },             // head1 outer -
  ];
}

/** Canvas に塗りつぶし三角矢じり (細矢印 head) を描画。p2 が tip。 */
function _drawArrowHead(ctx, p1, p2, strokeWidth, zoom, color) {
  const ah = Math.max(strokeWidth * 4, 10 * zoom);
  const aw = ah * 0.6;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const vx = -uy, vy = ux;
  const base = { x: p2.x - ux * ah, y: p2.y - uy * ah };
  ctx.beginPath();
  ctx.moveTo(p2.x, p2.y);
  ctx.lineTo(base.x + vx * aw, base.y + vy * aw);
  ctx.lineTo(base.x - vx * aw, base.y - vy * aw);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  return { base, ah };
}

/**
 * Draw an autoshape (line / arrow / block-arrow / ellipse) onto `ctx`.
 * Coordinates are already in pixel space (canonical pt × zoom).
 * Shared between exporter (writes overlay PNG layer) and viewer
 * (canvas inside an overlay-shape div).
 *
 * β.104: directional shape (line / arrow / block-arrow 系) は properties
 * の length / crossSize に従い「中心 (0,0) 基準・右向き」で描き、ctx.
 * rotate で arrowDir に応じた角度へ回転させる。これにより方向を変えても
 * 「同じ太さ・同じ長さ」のまま向きだけ回せる。bbox (ov.w / ov.h) は AABB
 * として正確に派生し、斜めでも切れない。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number,w:number,h:number, properties?: object}} ov
 * @param {number} zoom
 * @param {boolean} monoOverlays
 */
export function drawShape(ctx, ov, zoom, monoOverlays = false) {
  const props = ov.properties ?? {};
  const x = ov.x * zoom, y = ov.y * zoom;
  const w = ov.w * zoom, h = ov.h * zoom;
  const monoize = (c) => (monoOverlays ? "#000000" : c);
  const kind = props.kind ?? "line";
  const strokeColor = monoize(props.strokeColor ?? "#000000");
  const fillColor = props.fillColor ? monoize(props.fillColor) : null;
  const strokeWidth = Math.max(1, (props.strokeWidth ?? 2) * zoom);
  const dir = props.arrowDir ?? "right";
  const thickness = Math.min(0.9, Math.max(0.1, props.thickness ?? 0.5));

  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = "miter";
  ctx.lineCap = "round";
  if (fillColor) ctx.fillStyle = fillColor;

  // β.104: directional shape は length × crossSize で中心基準描画 + 回転
  if (_isDirectionalShape(kind)) {
    // length / crossSize: properties で保持 (旧 shape は w/h からの推測)。
    // 旧 shape の bbox は arrowDir に応じて swap されている可能性がある
    // ので max/min が安全な fallback。
    const lengthPt = props.length ?? Math.max(ov.w, ov.h);
    const crossSizePt = props.crossSize ?? Math.min(ov.w, ov.h);
    const length = lengthPt * zoom;
    const crossSize = crossSizePt * zoom;
    const angleRad = ((SHAPE_DIR_TO_ANGLE[dir] ?? 0) * Math.PI) / 180;
    const cx = x + w / 2, cy = y + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(angleRad);
    _drawDirectionalShapeAtOrigin(
      ctx, kind, length, crossSize, strokeColor, strokeWidth, fillColor, thickness, zoom,
    );
    ctx.restore();
    return;
  }

  // β.101: 矩形・角丸矩形
  if (kind === "rect") {
    const inset = strokeWidth / 2;
    if (fillColor) {
      ctx.fillRect(x + inset, y + inset, Math.max(0, w - strokeWidth), Math.max(0, h - strokeWidth));
    }
    ctx.strokeRect(x + inset, y + inset, Math.max(0, w - strokeWidth), Math.max(0, h - strokeWidth));
    ctx.restore();
    return;
  }
  if (kind === "rounded-rect") {
    const inset = strokeWidth / 2;
    const rPt = props.cornerRadius ?? 8;
    const rx = Math.max(0, Math.min((w - strokeWidth) / 2, (h - strokeWidth) / 2, rPt * zoom));
    const rectX = x + inset, rectY = y + inset;
    const rectW = Math.max(0, w - strokeWidth);
    const rectH = Math.max(0, h - strokeWidth);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(rectX, rectY, rectW, rectH, rx);
    } else {
      // Manual path fallback for older Chromium where roundRect is absent
      const x0 = rectX, y0 = rectY, x1 = rectX + rectW, y1 = rectY + rectH;
      ctx.moveTo(x0 + rx, y0);
      ctx.lineTo(x1 - rx, y0);
      ctx.quadraticCurveTo(x1, y0, x1, y0 + rx);
      ctx.lineTo(x1, y1 - rx);
      ctx.quadraticCurveTo(x1, y1, x1 - rx, y1);
      ctx.lineTo(x0 + rx, y1);
      ctx.quadraticCurveTo(x0, y1, x0, y1 - rx);
      ctx.lineTo(x0, y0 + rx);
      ctx.quadraticCurveTo(x0, y0, x0 + rx, y0);
      ctx.closePath();
    }
    if (fillColor) ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (kind === "ellipse") {
    const rx = Math.max(w / 2 - strokeWidth / 2, 1);
    const ry = Math.max(h / 2 - strokeWidth / 2, 1);
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, rx, ry, 0, 0, Math.PI * 2);
    if (fillColor) ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }

  // β.101: 楕円 + ×
  if (kind === "ellipse-x") {
    const rx = Math.max(w / 2 - strokeWidth / 2, 1);
    const ry = Math.max(h / 2 - strokeWidth / 2, 1);
    const cx = x + w / 2, cy = y + h / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (fillColor) ctx.fill();
    ctx.stroke();
    // × — 内接矩形 (sin45° = √2/2 ≈ 0.707) の対角線を引く
    const k = 0.707;
    const xOff = rx * k;
    const yOff = ry * k;
    ctx.beginPath();
    ctx.moveTo(cx - xOff, cy - yOff);
    ctx.lineTo(cx + xOff, cy + yOff);
    ctx.moveTo(cx + xOff, cy - yOff);
    ctx.lineTo(cx - xOff, cy + yOff);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // directional shape は冒頭で処理済 (length × crossSize + rotate)
  ctx.restore();
}

// ---- β.104 directional shape helpers (中心基準で右向き描画) ----------
//
// すべて (0, 0) を中心、+X 軸方向を「進行方向 / 矢じり方向」、Y 軸を
// crossSize の伸びる方向として描く。caller の drawShape が ctx.rotate
// で実方向に回す。bbox からは独立しているので、回転で「太さ・長さ」
// が一切変わらない。

/** ブロック矢印 (片端) の中心基準 7 頂点ポリゴン。 */
function _blockArrowPolyAtOrigin(length, crossSize, thickness) {
  const headWidth = crossSize;
  const shaftWidth = crossSize * thickness;
  const headLen = Math.min(crossSize * 1.0, length * 0.4);
  const sh = shaftWidth / 2;
  const hh = headWidth / 2;
  const bx = length / 2 - headLen;
  return [
    { x: -length / 2, y:  sh },
    { x:  bx,         y:  sh },
    { x:  bx,         y:  hh },
    { x:  length / 2, y:  0  },
    { x:  bx,         y: -hh },
    { x:  bx,         y: -sh },
    { x: -length / 2, y: -sh },
  ];
}

/** 双方ブロック矢印の中心基準 10 頂点ポリゴン。 */
function _doubleBlockArrowPolyAtOrigin(length, crossSize, thickness) {
  const headWidth = crossSize;
  const shaftWidth = crossSize * thickness;
  const headLen = Math.min(crossSize * 1.0, length * 0.3);
  const sh = shaftWidth / 2;
  const hh = headWidth / 2;
  const ax = -length / 2 + headLen;
  const bx =  length / 2 - headLen;
  return [
    { x: -length / 2, y:  0  },
    { x:  ax,         y:  hh },
    { x:  ax,         y:  sh },
    { x:  bx,         y:  sh },
    { x:  bx,         y:  hh },
    { x:  length / 2, y:  0  },
    { x:  bx,         y: -hh },
    { x:  bx,         y: -sh },
    { x:  ax,         y: -sh },
    { x:  ax,         y: -hh },
  ];
}

/** Directional shape (line / arrow / double-arrow / block-arrow /
 *  double-block-arrow) を中心 (0,0) 基準で右向きに描く。caller が
 *  ctx.rotate で実方向に回す前提。stroke/fill は caller がセット済。 */
function _drawDirectionalShapeAtOrigin(ctx, kind, length, crossSize,
                                       strokeColor, strokeWidth, fillColor, thickness, zoom) {
  if (kind === "line") {
    ctx.beginPath();
    ctx.moveTo(-length / 2, 0);
    ctx.lineTo( length / 2, 0);
    ctx.stroke();
    return;
  }
  if (kind === "arrow") {
    const ah = Math.max(strokeWidth * 4, 10 * zoom);
    const aw = ah * 0.6;
    ctx.beginPath();
    ctx.moveTo(-length / 2, 0);
    ctx.lineTo(length / 2 - ah * 0.85, 0);
    ctx.stroke();
    const baseX = length / 2 - ah;
    ctx.beginPath();
    ctx.moveTo(length / 2, 0);
    ctx.lineTo(baseX,  aw);
    ctx.lineTo(baseX, -aw);
    ctx.closePath();
    ctx.fillStyle = strokeColor;
    ctx.fill();
    return;
  }
  if (kind === "double-arrow") {
    const ah = Math.max(strokeWidth * 4, 10 * zoom);
    const aw = ah * 0.6;
    ctx.beginPath();
    ctx.moveTo(-length / 2 + ah * 0.85, 0);
    ctx.lineTo( length / 2 - ah * 0.85, 0);
    ctx.stroke();
    // right head
    const rBase = length / 2 - ah;
    ctx.beginPath();
    ctx.moveTo(length / 2, 0);
    ctx.lineTo(rBase,  aw);
    ctx.lineTo(rBase, -aw);
    ctx.closePath();
    ctx.fillStyle = strokeColor;
    ctx.fill();
    // left head
    const lBase = -length / 2 + ah;
    ctx.beginPath();
    ctx.moveTo(-length / 2, 0);
    ctx.lineTo(lBase,  aw);
    ctx.lineTo(lBase, -aw);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (kind === "block-arrow") {
    const poly = _blockArrowPolyAtOrigin(length, crossSize, thickness);
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    if (fillColor) ctx.fill();
    ctx.stroke();
    return;
  }
  if (kind === "double-block-arrow") {
    const poly = _doubleBlockArrowPolyAtOrigin(length, crossSize, thickness);
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    if (fillColor) ctx.fill();
    ctx.stroke();
    return;
  }
}

/**
 * Draw stamp text centred on (cx, cy) with per-run fonts. Mirrors
 * `splitStampRuns` so 全角/半角 alternation lines up exactly between
 * the on-screen viewer and the exported canvas (no drift between
 * preview and rasterized output).
 */
/** 不動文字フィット rendering: distribute n tokens across a width-w
 *  band centred at (cx, cy). First token left-anchored, last right-
 *  anchored, middle ones at evenly-spaced midpoints. Tokens are the
 *  digits already split out of the rendered date string — separators
 *  are not drawn (matches preprinted「  年    月    日」forms).
 *  Always a date stamp → no overstroke (β41 I4). */
function drawSpacedTokensOnCanvas(ctx, tokens, cx, cy, width, fontSize, color, halfStack) {
  if (!tokens || tokens.length === 0) return;
  ctx.font = `bold ${fontSize}px ${halfStack}`;
  ctx.textBaseline = "middle";
  const left = cx - width / 2;
  const right = cx + width / 2;
  const glyphOpts = { stroke: false };
  if (tokens.length === 1) {
    ctx.textAlign = "center";
    paintGlyphRun(ctx, tokens[0], cx, cy, color, fontSize, glyphOpts);
    return;
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (i === 0) {
      ctx.textAlign = "left";
      paintGlyphRun(ctx, tok, left, cy, color, fontSize, glyphOpts);
    } else if (i === tokens.length - 1) {
      ctx.textAlign = "right";
      paintGlyphRun(ctx, tok, right, cy, color, fontSize, glyphOpts);
    } else {
      ctx.textAlign = "center";
      const tcx = left + (width * i) / (tokens.length - 1);
      paintGlyphRun(ctx, tok, tcx, cy, color, fontSize, glyphOpts);
    }
  }
}

function drawStampMixedTextOnCanvas(ctx, text, cx, cy, fontSize, color, fullStack, halfStack, opts = {}) {
  const runs = splitStampRuns(text);
  // β.85: opts.bold で font の weight prefix を切替。date stamp / 印影
  // 系は bold で 印影 風の濃さを出すが、テキストスタンプ (認印・備考用)
  // は normal で印刷するようにユーザー要望で変更。bold omitted は legacy
  // compat で true (date stamp 経路はそのまま太字)。
  const useBold = opts.bold !== false;
  const weightPrefix = useBold ? "bold " : "";
  const widths = [];
  let total = 0;
  for (const run of runs) {
    ctx.font = `${weightPrefix}${fontSize}px ${run.cls === "half" ? halfStack : fullStack}`;
    const m = ctx.measureText(run.text);
    widths.push(m.width);
    total += m.width;
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let pen = cx - total / 2;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    ctx.font = `${weightPrefix}${fontSize}px ${run.cls === "half" ? halfStack : fullStack}`;
    paintGlyphRun(ctx, run.text, pen, cy, color, fontSize, opts);
    pen += widths[i];
  }
}

/** Wait until custom @font-face declarations (currently
 *  CrashNumberingSerif) are available to Canvas. document.fonts.ready
 *  resolves after every face declared on the page has either loaded
 *  or failed; for an early-export (e.g. first action after launch) we
 *  also explicitly request the family so the @font-face is triggered
 *  even if no DOM element used it yet. */
let _fontsReadyPromise = null;
async function ensureCustomFontsReady() {
  if (typeof document === "undefined") return; // node-side tests
  if (_fontsReadyPromise) return _fontsReadyPromise;
  _fontsReadyPromise = (async () => {
    try {
      // Force a load attempt — `document.fonts.ready` only awaits
      // already-pending loads, not fonts that haven't been requested yet.
      await document.fonts?.load?.('12px "CrashNumberingSerif"').catch(() => {});
      await document.fonts?.ready;
    } catch {
      // Best effort; fall back to the next font in the stack on failure.
    }
  })();
  return _fontsReadyPromise;
}

function parseHexColor(s) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(s ?? ""));
  if (!m) return [0, 0, 0];
  const v = m[1];
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

export const EXPORT_ZOOM = 900 / 72;

/**
 * True only when `pages` (in display order) are exactly the source PDF's
 * pages 1..N in their natural order, with no synthetic / inserted pages.
 *
 * This is the precondition for the verbatim byte-copy export/print fast
 * path (copy the source PDF bytes as-is). Page REORDER is a workspace-only
 * change — it rewrites `display_order` in the DB but is NOT baked into the
 * source PDF bytes (exactly like userRotation). A byte-copy therefore drops
 * a reorder silently: K-PDF3 still shows the new order (it reads the DB) but
 * other apps that read the raw PDF (k-evi 等) see the original order.
 *
 * v2.0.11: the byte-copy guard checked overlays/deletions/insertions/
 * rotation but NOT reorder, so a reorder-only save/print fell through to
 * byte-copy and lost the new order. Mirrors the v2.0.7 userRotation fix.
 * When this returns false the caller re-assembles via composePagesForExport
 * → assembleHybridPdf, where unedited pages use strategy="source" (vector
 * copyPages in display order) so vectors/text/quality are preserved.
 *
 * @param {Array<{ pageNo:number, isSynthetic?:boolean }>} pages
 * @returns {boolean}
 */
export function pagesInNaturalSourceOrder(pages) {
  return Array.isArray(pages)
    && pages.length > 0
    && pages.every((p, i) => !p?.isSynthetic && p?.pageNo === i + 1);
}

/**
 * The byte-copy gate — single source of truth for "may this export/print
 * reuse the source PDF bytes verbatim?" (REVIEW-2026-07 #4).
 *
 * v2.0.7 (userRotation) / v2.0.8 (dirty flag) / v2.0.11 (reorder) were all
 * the same bug shape: a workspace-only edit (not baked into the source
 * bytes) slipped through one of the three inline gate copies. Centralising
 * the decision here kills the shape: every caller (actionExportToPath,
 * actionPrintViaReader, legacy print dialog) sees every check, and the
 * table-driven test (test/byte-copy-gate.test.mjs) enumerates 編集種別 ×
 * 可否. 新しい workspace 専用変換を足す時は、ここに条件を 1 つ足し、
 * テストのテーブルに 1 行足すこと。
 *
 * `sourcePageCount` (meta.pageCount) closes the trailing-deletion hole:
 * deleting the LAST page leaves the visible pages 1..K in natural order,
 * so only a count comparison against the source bytes can catch it.
 *
 * @param {object} args
 * @param {Array<{ pageNo:number, isSynthetic?:boolean, userRotation?:number }>} args.pages
 *          visible pages in display order (pending deletions already filtered out)
 * @param {number}  [args.overlayCount=0]       projectStore.count()
 * @param {number|null} [args.sourcePageCount]  total pages in the source PDF bytes
 *          (meta.pageCount); null/undefined skips the trailing-deletion check
 * @param {number}  [args.pendingDeleteCount=0] unsaved deletions (export path —
 *          keeps a pending-deleted *inserted* page from resurrecting on the
 *          same-fingerprint workspace reuse after 上書き保存)
 * @param {boolean} [args.allPagesSelected=true] print: user picked every page
 * @param {boolean} [args.forceMono=false]      print/FAX: mono projection needs re-compose
 * @returns {boolean}
 */
export function byteCopyEligible({
  pages,
  overlayCount = 0,
  sourcePageCount = null,
  pendingDeleteCount = 0,
  allPagesSelected = true,
  forceMono = false,
} = {}) {
  if (forceMono) return false;
  if (overlayCount > 0) return false;
  if (!allPagesSelected) return false;
  if (pendingDeleteCount > 0) return false;
  // Reorder / insertion (synthetic) / mid-document deletion (gap) all break
  // the natural 1..K sequence.
  if (!pagesInNaturalSourceOrder(pages)) return false;
  // userRotation is viewer-only — never in the source bytes (v2.0.7).
  if (pages.some((p) => ((((p.userRotation ?? 0) % 360) + 360) % 360) !== 0)) {
    return false;
  }
  // Trailing deletion: 1..K is natural but the source bytes hold more pages.
  if (Number.isInteger(sourcePageCount) && pages.length < sourcePageCount) {
    return false;
  }
  return true;
}

/**
 * @param {object} args
 * @param {Array<any>} args.pages              page rows from workspace.getPages()
 * @param {import("../domain/project-store.js").ProjectStore} args.projectStore
 * @param {(pageNo: number, opts: { zoom: number }) =>
 *           Promise<{ width:number, height:number, channels:3|4, pixels:Uint8ClampedArray | Uint8Array }>} args.renderPage
 *           normally `window.kpdf3.renderPage`
 * @param {(progress: { done: number, total: number }) => void} [args.onProgress]
 * @returns {Promise<Array<{ pageNo:number, png:Uint8Array, widthPt:number, heightPt:number }>>}
 */
export async function composePagesForExport({
  pages,
  projectStore,
  renderPage,
  renderSyntheticPage, // optional: (row, zoom) => {width,height,channels,pixels}
  onProgress,
  // β.80 下敷き印刷: true なら全ページを overlay-only strategy で
  // 組み立てる。背景 PDF は一切 copy せず、空白ページ + overlay PNG
  // だけが main 側で組まれる (物理紙の不動文字に重ね印刷する用途)。
  overlayOnly = false,
  // β.85 真の墨消し: true のとき redaction overlay を持つページは
  // strategy を "full" に強制し、ソース PDF 内の vector text 層ごと
  // 900dpi ラスタに焼く (overlay PNG は本来の通り上に乗る)。これに
  // より「黒い四角の下にテキストが残る」状態を構造的に解消する
  // (β.84 までは strategy=overlay/external で vector ソースをそのまま
  // copy していたため、Adobe で墨消し下を選択・検索すると裏のテキ
  // ストが抜き出せた)。書き出し / 分割保存 / 印刷の全 8 経路で true
  // を渡す方針 (法律実務での安全側デフォルト)。
  rasterRedactionPages = false,
  // Phase 1 (白黒印刷モード): true のとき drawOverlay で overlay の色を
  // 黒 (#000000) に projection する。対象は text / stamp (画像含む) /
  // form_field / callout / redaction (既に黒)。マーカー (line/marker)
  // は対象外で原色を維持する (黒で塗ると下の文字が読めなくなる)。
  // FAX や白黒プリンタでカラー画像スタンプが ramp 後でも薄く出る事故
  // を構造的に防ぐための保険機能。印刷経路のみで true を渡し、書き出
  // しでは false (色情報を残す)。
  monoOverlays = false,
  // Phase 3 (FAX 経路 明朝保険): true のとき overlay-only 以外の全ページ
  // を strategy="full" に格上げし、ソース PDF の vector text 層ごと
  // EXPORT_ZOOM (900dpi) ラスタに焼く。これで Sumatra/Chromium 等の
  // ダウンストリーム engine が PDF text を独自にレンダリングする差が
  // 完全に消え、明朝 hairline が FAX 200dpi で部分的に飛ぶ問題を防げる
  // (raster は K-PDF3 内部の mupdf でコントロール下にあるため、Adobe
  // 経路と同等の品質を担保できる)。書き出し / 通常印刷では false。
  // FAX 送信ボタン (streamlined auto 経路) でのみ true。
  rasterAllPagesForFax = false,
  // v2.0.13 ベクターテキスト層: main の kpdf3:vector-text-probe を渡すと、
  // MS 明朝の text / form_field(text) overlay をラスタ PNG から除外して
  // vectorTexts (行単位の配置命令) として送る。省略 (null) なら従来通り
  // 全 overlay をラスタ描画 (Mac/Linux やテストの既定挙動)。
  vectorTextProbe = null,
}) {
  // Ensure custom @font-face faces (CrashNumberingSerif etc.) are loaded
  // before Canvas tries to use them — Canvas falls back to the next
  // font in the stack if the requested face isn't ready, which would
  // silently swap the date stamp's 半角 face on the very first export
  // after launch.
  await ensureCustomFontsReady();

  // v2.0.13: ベクターテキスト適格性を 1 回の IPC で事前判定する。
  // フォント無し環境 (probe.available=false) / probe 失敗 / 候補ゼロは
  // vectorMissingSet = null のままとなり、以降は完全に従来経路。
  // FAX (rasterAllPagesForFax) は全面ラスタが仕様なので probe 自体を省く。
  let vectorMissingSet = null;
  if (typeof vectorTextProbe === "function" && !rasterAllPagesForFax) {
    // ユニーク文字だけを 1 本の文字列にして送る — 100 ページ級の申請書
    // 一式でも IPC ペイロードは数百字で済む (probe はグリフ有無しか
    // 見ないので全文は不要)。
    const uniqueChars = new Set();
    for (const row of pages) {
      for (const ov of projectStore.getPageOverlays(row.pageNo)) {
        const cand = vectorTextCandidate(ov);
        if (cand != null) for (const ch of cand) uniqueChars.add(ch);
      }
    }
    if (uniqueChars.size > 0) {
      try {
        const probe = await vectorTextProbe([[...uniqueChars].join("")]);
        if (probe?.available) {
          vectorMissingSet = new Set(probe.missing ?? []);
        }
      } catch (err) {
        console.warn("[export] vector-text probe failed — raster fallback:", err);
      }
    }
  }

  const total = pages.length;
  // β.124: ページごとの処理 (overlay 合成 + PNG/JPEG エンコード + 場合に
  // よっては renderPage IPC) を 3 並列ワーカープールで処理。out は事前
  // 確保して index 書き込みするので、完了順が前後しても最終配列の順序は
  // 入力 pages と同一 (main の assembleHybridPdf がページ順依存)。
  // mupdf 自体は main 側で serialize されるが、canvas 合成・PNG/JPEG
  // エンコード・IPC のラウンドトリップが並列化されるので、大ドキュメント
  // (overlay 多数 / full ストラテジ多数) で wall-clock の短縮が出る。
  const out = new Array(total);
  let nextIdx = 0;
  let completed = 0;
  const CONCURRENCY = 3;

  const processOne = async (i) => {
    const row = pages[i];
    const canonical = canonicalPageSize({
      mediaX: 0, mediaY: 0, mediaW: 0, mediaH: 0,
      cropX: 0, cropY: 0,
      cropW: row.cropW, cropH: row.cropH,
      rotation: row.rotation,
      userRotation: row.userRotation ?? 0,
    });

    // ページの overlay 配列 (描画順)。processOne 内は一貫してこの 1 回
    // 取得を使い回す (以前は overlayCount / redaction 判定 / compose で
    // 都度 projectStore を叩き直していた)。
    const pageOvs = projectStore.getPageOverlays(row.pageNo);
    const overlayCount = pageOvs.length;
    const userRot = (((row.userRotation ?? 0) % 360) + 360) % 360;
    const sourceRot = (((row.rotation ?? 0) % 360) + 360) % 360;
    const effectiveRotation = ((sourceRot + userRot) % 360 + 360) % 360;
    const isSynthetic = row.isSynthetic || row.pageNo < 0;
    // β31: synthetic page backed by a stored external PDF (inserted via
    // sidebar/split D&D). When present, we ask main to copyPages the
    // original PDF for crisp vector output instead of rasterising.
    const hasExternalSource =
      isSynthetic
      && row.syntheticSourcePdfId != null
      && row.syntheticSourcePageIndex != null;
    // Hybrid strategy:
    //   - synthetic page backed by external PDF → "external" (copyPages
    //     the stored source PDF, plus overlay PNG if any)
    //   - synthetic page (no source) → "full" (rasterize the renderer-
    //     drawn synthetic content)
    //   - source PDF page with overlays → "overlay" (copy vector source +
    //     draw transparent overlay PNG on top)
    //   - source PDF page with no overlays → "source" (copy verbatim)
    //
    // β5+: rotated pages (userRotation or source /Rotate != 0) also take
    // the hybrid path. main-side assembler uses embedPage + drawPage to
    // place rotated vector content, so we keep crisp text on rotated pages
    // too (β4 fell back to full-rasterize which exploded file size).
    // β.85 真の墨消し: redaction overlay があれば後段で strategy を
    // "full" に格上げするので、ここで先に検出しておく。判定は
    // projectStore から取得 (overlayCount と同じソース)。
    const hasRedactionOverlay =
      rasterRedactionPages
      && pageOvs.some((ov) => ov.type === "redaction");

    let strategy;
    if (overlayOnly) {
      // β.80 下敷き印刷: 背景は一切出力せず、overlay だけを空白ページに
      // 描画する。元 PDF が source / external / synthetic のどれでも、
      // 用紙サイズ (canonical w/h) は変わらないので main 側は一律に
      // 空白ページを作って overlay PNG を貼るだけで済む。overlay が
      // 0 個のページは完全に空白のまま出力される (= 物理紙の不動文字
      // だけが印字結果として残る)。
      strategy = "overlay-only";
    } else if (rasterAllPagesForFax) {
      // Phase 3: FAX 経路では全ページを "full" (900dpi raster) に格上げ。
      // 内部 mupdf でラスタ化することで、Sumatra/Chromium のテキスト
      // レンダリング差を吸収し、明朝 hairline が FAX 200dpi で痩せる
      // 問題を構造的に防ぐ。
      strategy = "full";
    } else if (hasRedactionOverlay) {
      // β.85: redaction を含むページは source / external / overlay の
      // どれでも "full" (900dpi raster) に強制。synthetic は元々 full
      // 経路なのでそのまま。これでソース PDF の vector text 層が
      // ピクセルに焼かれ、墨消し下のテキスト抽出が構造的に不可能になる。
      strategy = "full";
    } else if (hasExternalSource) {
      strategy = "external"; // copyPages from stored external PDF (vector)
    } else if (isSynthetic) {
      strategy = "full"; // no source page to keep — rasterize everything
    } else if (overlayCount > 0) {
      strategy = "overlay"; // copy source vector + draw overlay PNG on top
    } else {
      strategy = "source"; // copy source page as-is, no render needed
    }

    /** @type {Uint8Array | undefined} */
    let imageBytes;
    /** β62: overlay PNG の bbox (canonical coords, point 単位)。null は
     *  「full-page で描画」を意味する (overlay 戦略以外 or 設計上の fallback)。 */
    /** @type {{x:number,y:number,w:number,h:number}|null} */
    let overlayBBox = null;
    // v2.0.13: overlay/external/overlay-only 戦略 (= ラスタ PNG がベクター
    // ページの上に乗る経路) では、MS 明朝 text/form_field を PNG から
    // 除外して vectorTexts へ。full 戦略 (墨消し/synthetic/FAX) は従来通り
    // 全 overlay をページラスタに焼く。
    /** @type {Array<object> | undefined} */
    let vectorTexts;
    let overlaysForRaster = pageOvs;
    if (vectorMissingSet && strategy !== "full" && overlayCount > 0) {
      const split = splitVectorTextOverlays(
        pageOvs, vectorMissingSet, EXPORT_ZOOM, monoOverlays,
      );
      if (split.ops.length > 0) {
        vectorTexts = split.ops;
        overlaysForRaster = split.raster;
      }
    }
    if (strategy === "overlay-only") {
      // β.80: overlay があれば bbox-cropped PNG を生成し、無ければ
      // 完全に空白ページとして main に渡す (imageBytes = undefined)。
      // v2.0.13: 全 overlay がベクター化されたページも PNG 無しで送る
      // (bboxPt=null → 空白ページ + テキスト層のみ)。
      if (overlayCount > 0) {
        const { canvas, bboxPt: bb } = await composeOverlayOnlyPage(
          row, overlaysForRaster, EXPORT_ZOOM, monoOverlays,
        );
        if (bb) {
          imageBytes = await canvasToPng(canvas);
          overlayBBox = bb;
        }
      }
    } else if (strategy === "full") {
      let result;
      if (isSynthetic) {
        if (typeof renderSyntheticPage !== "function") {
          throw new Error("composePagesForExport: synthetic page encountered but no renderSyntheticPage provided");
        }
        result = await renderSyntheticPage(row, EXPORT_ZOOM);
      } else {
        result = await renderPage(row.pageNo, { zoom: EXPORT_ZOOM });
      }
      const canvas = await compositePage(row, result, projectStore, EXPORT_ZOOM, monoOverlays);
      // β31 #3: pick encoding by content type so printed sharpness is
      // maximised for text-heavy pages.
      //   - synthetic white + text page (no underlying image) → PNG
      //     (lossless; DCT halos around glyph edges in JPEG showed up
      //     as faint blur on print).
      //   - legacy image-only inserted page (β30 and earlier, before
      //     the vector "external" path) → JPEG q=0.95 to keep file
      //     size manageable on photo-ish content.
      //   - any other "full" fallback (rotated source page that fell
      //     out of the hybrid path, etc.) → JPEG q=0.95.
      const isPureSyntheticText =
        isSynthetic && !(row.syntheticHasImage);
      imageBytes = isPureSyntheticText
        ? await canvasToPng(canvas)
        : await canvasToJpeg(canvas, 0.95);
    } else if (strategy === "overlay") {
      // β62: bbox-cropped overlay。canvas は overlays の実領域だけ、
      // bboxPt は配置位置を main に渡すための metadata。
      // v2.0.13: ベクター化で残り overlay がゼロになったら PNG 自体を
      // 送らない (bbox=null の 1×1 透過 PNG を full-page stretch すると
      // 複合機ドライバの「画像あり → 全面 raster fallback」を無駄に
      // 誘発しかねないため)。
      const { canvas, bboxPt: bb } = await composeOverlayOnlyPage(
        row, overlaysForRaster, EXPORT_ZOOM, monoOverlays,
      );
      // Overlay layer must be PNG to keep transparency — drawing on top of
      // the copied vector source page would otherwise paint white over it.
      if (bb) {
        imageBytes = await canvasToPng(canvas);
        overlayBBox = bb;
      }
    } else if (strategy === "external" && overlayCount > 0) {
      // External-source pages can also carry overlays drawn by the user
      // (e.g. a stamp pinned onto an inserted page). Author the overlay
      // layer the same way as the "overlay" strategy so main can compose.
      const { canvas, bboxPt: bb } = await composeOverlayOnlyPage(
        row, overlaysForRaster, EXPORT_ZOOM, monoOverlays,
      );
      if (bb) {
        imageBytes = await canvasToPng(canvas);
        overlayBBox = bb;
      }
    }
    // strategy === "source": no image bytes; main copies source page as-is.
    // strategy === "external" with no overlays: no image bytes either.

    out[i] = {
      pageNo: row.pageNo,
      widthPt: canonical.w,   // post-rotation canonical w/h (what user sees)
      heightPt: canonical.h,
      strategy,
      sourceIdx: isSynthetic ? null : (row.pageNo - 1),
      // β31: external-source coordinates carried through to main so it
      // can fetch the stored PDF and copyPages the right page.
      externalSourcePdfId: hasExternalSource ? row.syntheticSourcePdfId : null,
      externalSourcePageIndex: hasExternalSource ? row.syntheticSourcePageIndex : null,
      // userRotation lets the main side place the source page rotated.
      // pdf-lib's embedPdf does NOT bake the source's intrinsic /Rotate
      // (verified), so main combines BOTH into effRot = sourceRotation +
      // userRotation and applies the whole rotation clockwise. Without the
      // source rotation, overlays on a rotated source page print 天地さかさま.
      userRotation: userRot,
      sourceRotation: sourceRot,
      imageBytes,
      // β62: overlay PNG の配置 bbox。canonical coords (top-left origin、PDF
      // point 単位)。null の場合は main 側で「full-page (β61 までの挙動)」
      // にフォールバック。userRot=0 でかつ overlay/external 戦略時のみ
      // セットされる。
      overlayBBox,
      // v2.0.13: MS 明朝 text/form_field の行単位配置命令。main の
      // applyVectorTextLayer が実テキスト (フォント埋め込み) として焼く。
      vectorTexts,
    };
  };

  const worker = async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= total) return;
      await processOne(i);
      completed++;
      if (onProgress) onProgress({ done: completed, total });
    }
  };

  const workers = [];
  for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/**
 * Build an offscreen Canvas with the rendered page + overlays.
 *
 * @param {any} row
 * @param {{ width:number, height:number, channels:3|4, pixels:Uint8ClampedArray | Uint8Array }} renderResult
 * @param {import("../domain/project-store.js").ProjectStore} projectStore
 * @returns {HTMLCanvasElement}
 */
/**
 * Public single-page composer used by the print-preview UI.
 * Renders one page (PDF + overlays) and returns the canvas at `zoom`.
 *
 * @param {{pageNo:number, cropW:number, cropH:number, rotation:number, userRotation?:number}} pageRow
 * @param {(p:number,o:object)=>Promise<{width:number,height:number,channels:3|4,pixels:Uint8ClampedArray|Uint8Array}>} renderPage
 * @param {import("../domain/project-store.js").ProjectStore} projectStore
 * @param {number} zoom
 */
export async function composeSinglePageCanvas(pageRow, renderPage, projectStore, zoom, renderSyntheticPage, monoOverlays = false) {
  await ensureCustomFontsReady();
  let result;
  if (pageRow.isSynthetic || pageRow.pageNo < 0) {
    if (typeof renderSyntheticPage !== "function") {
      throw new Error("composeSinglePageCanvas: synthetic page needs renderSyntheticPage");
    }
    result = await renderSyntheticPage(pageRow, zoom);
  } else {
    result = await renderPage(pageRow.pageNo, { zoom });
  }
  return await compositePage(pageRow, result, projectStore, zoom, monoOverlays);
}

/**
 * β.97 機能 1: PDF を画像として保存
 *
 * Compose a single page (PDF + overlays) at `zoom` and encode it as PNG
 * or JPEG. Returns the encoded bytes plus the canonical page dimensions
 * in points (top-left origin, user rotation applied — i.e. what the
 * viewer shows).
 *
 * Used by actionExportAsImage to fan out across the selected page range
 * and hand the bytes to main for file writes.
 *
 * @param {object} args
 * @param {any} args.pageRow  page row from workspace.getPages()
 * @param {(p:number, o:object) => Promise<any>} args.renderPage
 * @param {import("../domain/project-store.js").ProjectStore} args.projectStore
 * @param {(row:any, zoom:number) => Promise<any>} [args.renderSyntheticPage]
 * @param {number} [args.zoom=EXPORT_ZOOM]  pixels per point
 * @param {"png"|"jpeg"} [args.format="png"]
 * @param {number} [args.quality=0.92]      JPEG quality 0..1
 * @param {boolean} [args.monoOverlays=false]  project overlay colors → black
 * @returns {Promise<{ bytes: Uint8Array, widthPt: number, heightPt: number, mime: string, ext: string }>}
 */
export async function composePageImage({
  pageRow,
  renderPage,
  projectStore,
  renderSyntheticPage,
  zoom = EXPORT_ZOOM,
  format = "png",
  quality = 0.92,
  monoOverlays = false,
}) {
  const composed = await composeSinglePageCanvas(
    pageRow, renderPage, projectStore, zoom, renderSyntheticPage, monoOverlays,
  );
  const widthPt = composed.width / zoom;
  const heightPt = composed.height / zoom;
  // PDF のページは「白い紙」。Excel→PDF など背景に白塗り矩形を持たない
  // PDF は mupdf が透過 RGBA (背景 = RGB(0,0,0)/alpha 0) で返すため、白地を
  // 敷かないと PNG は背景透過、JPEG は透過部分が黒として焼き込まれる。
  // 形式を問わず不透明な白地へ合成する (composeRegionImage と同じ対策)。
  const canvas = document.createElement("canvas");
  canvas.width = composed.width;
  canvas.height = composed.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("composePageImage: 2d context unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(composed, 0, 0);
  if (format === "jpeg" || format === "jpg") {
    const bytes = await canvasToJpeg(canvas, quality);
    return { bytes, widthPt, heightPt, mime: "image/jpeg", ext: "jpg" };
  }
  const bytes = await canvasToPng(canvas);
  return { bytes, widthPt, heightPt, mime: "image/png", ext: "png" };
}

/**
 * β.97 機能 2: 範囲選択して画像保存
 *
 * Compose a single page at `zoom` then crop the result to `bbox`
 * (canonical points, top-left origin) and encode as PNG or JPEG.
 *
 * @param {object} args
 * @param {any} args.pageRow
 * @param {(p:number, o:object) => Promise<any>} args.renderPage
 * @param {import("../domain/project-store.js").ProjectStore} args.projectStore
 * @param {(row:any, zoom:number) => Promise<any>} [args.renderSyntheticPage]
 * @param {number} [args.zoom=EXPORT_ZOOM]
 * @param {"png"|"jpeg"} [args.format="png"]
 * @param {number} [args.quality=0.92]
 * @param {boolean} [args.monoOverlays=false]
 * @param {{x:number,y:number,w:number,h:number}} args.bbox  canonical pt
 * @returns {Promise<{ bytes: Uint8Array, widthPx: number, heightPx: number, mime: string, ext: string }>}
 */
export async function composeRegionImage({
  pageRow,
  renderPage,
  projectStore,
  renderSyntheticPage,
  zoom = EXPORT_ZOOM,
  format = "png",
  quality = 0.92,
  monoOverlays = false,
  bbox,
}) {
  if (!bbox || !(bbox.w > 0) || !(bbox.h > 0)) {
    throw new Error("composeRegionImage: bbox with positive w/h is required");
  }
  const fullCanvas = await composeSinglePageCanvas(
    pageRow, renderPage, projectStore, zoom, renderSyntheticPage, monoOverlays,
  );
  const sx = Math.max(0, Math.round(bbox.x * zoom));
  const sy = Math.max(0, Math.round(bbox.y * zoom));
  const sw = Math.max(1, Math.min(fullCanvas.width - sx, Math.round(bbox.w * zoom)));
  const sh = Math.max(1, Math.min(fullCanvas.height - sy, Math.round(bbox.h * zoom)));
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("composeRegionImage: 2d context unavailable");
  // PDF のページは「白い紙」。背景に白塗り矩形を持たない PDF (Excel→PDF 等)
  // は mupdf が透過 RGBA で返すため、白地を敷かないと JPEG は透過部分が黒く
  // 焼き込まれ、PNG も背景透過になる。形式を問わず不透明な白地へ合成する。
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  if (format === "jpeg" || format === "jpg") {
    const bytes = await canvasToJpeg(out, quality);
    return { bytes, widthPx: sw, heightPx: sh, mime: "image/jpeg", ext: "jpg" };
  }
  const bytes = await canvasToPng(out);
  return { bytes, widthPx: sw, heightPx: sh, mime: "image/png", ext: "png" };
}

/**
 * Render JUST the overlays for a page onto a transparent canvas at the
 * canonical (post-userRotation) page dimensions. Used by the hybrid
 * export path so main can copy the source PDF page verbatim (preserving
 * vector text/lines) and then drop this transparent-bg image on top.
 *
 * Mirrors compositePage's overlay loop without painting the source PDF
 * bitmap underneath.
 *
 * @param {{cropW:number, cropH:number, rotation:number, userRotation?:number, pageNo:number}} row
 * @param {import("../domain/project-store.js").ProjectStore} projectStore
 * @param {number} zoom
 * @returns {HTMLCanvasElement}
 */
/**
 * β62: 戻り値を `{ canvas, bboxPt }` に拡張。bbox は canonical
 * coordinate (post-rotation top-left origin, PDF point 単位) で:
 *   - 全 overlays の union 矩形にマージン (8pt) を足したもの
 *   - ページ境界でクランプ
 *   - overlays 無し時は null
 * canvas は bbox サイズで作成し、ctx を translate して overlays が
 * 正しい相対位置に描かれるようにする。
 *
 * 狙い: 合成 PDF 内のオーバーレイ XObject を「ページ全面」ではなく
 * 「overlays の実領域」に縮小すること。複合機ドライバが「画像がページ
 * 内にあると全面 raster fallback する」挙動を回避し、bbox の外は
 * vector のまま残せる (C2360 で「細い線を太く」がスタンプ非含有ページ
 * のみ効いていた件 β61 ユーザ報告への対策)。userRot=0 のみで効くが、
 * 回転ページは元から少数派なので β62 ではここまで。
 *
 * β63: 第 2 引数を projectStore から「overlays 配列」に変更。caller が
 * 描画対象だけを渡せるようにして、vector 化対象 overlay を canvas から
 * 除外できるようにする (vector は別途 main 側で pdf-lib drawText 経由)。 */
export async function composeOverlayOnlyPage(row, overlays, zoom = EXPORT_ZOOM, monoOverlays = false) {
  // Canonical page size uses the EFFECTIVE rotation (source /Rotate +
  // userRotation), not userRotation alone — overlays are stored in the
  // canonical frame, so the bbox clamp / canvas dims must match the
  // post-effective-rotation page or overlays on a /Rotate=90/270 source get
  // clamped to the wrong axis and misplaced.
  const userRot = (((row.userRotation ?? 0) % 360) + 360) % 360;
  const sourceRot = (((row.rotation ?? 0) % 360) + 360) % 360;
  const effRot = ((sourceRot + userRot) % 360 + 360) % 360;
  const swap = effRot === 90 || effRot === 270;
  const pageW = swap ? row.cropH : row.cropW;
  const pageH = swap ? row.cropW : row.cropH;

  if (!Array.isArray(overlays) || overlays.length === 0) {
    // 互換性のため空 1×1 canvas + bbox=null を返す (caller は bbox null
    // で drawImage 自体を skip する設計)。
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    return { canvas, bboxPt: null };
  }

  // overlay union bbox を canonical (= post-rotation) で求める。
  // 各 overlay 種別ごとに「描画範囲が x/y/w/h より広い」要素を考慮:
  // - **吹き出し (callout)**: 矢印が box 外に伸びる。arrowDx/arrowDy
  //   は box top-left からの相対値 (drawOverlay line 767-768 参照)、
  //   default は (-30, ov.h + 25)。矢印先端 (tipX/tipY) と
  //   arrowhead 三角 (~12pt) を bbox に含める必要あり。β62 で
  //   PAD=8pt しか足していなかったため、デフォルト矢印 (-30pt 左に
  //   30pt 下に伸びる) が canvas 範囲外で消える regression があった
  //   ─ β64-2 で修正。
  // - その他 overlay (text/stamp/marker/redaction): stroke halo
  //   程度の余白で十分なので基本 PAD=8pt のまま。
  const PAD = 8;
  const ARROWHEAD_PAD = 14; // 矢印三角先端の三角片 (h≈12pt) + 余白
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ov of overlays) {
    const x = Number.isFinite(ov.x) ? ov.x : 0;
    const y = Number.isFinite(ov.y) ? ov.y : 0;
    const w = Number.isFinite(ov.w) ? ov.w : 0;
    const h = Number.isFinite(ov.h) ? ov.h : 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
    // 吹き出しの矢印先端を bbox に算入
    if (ov.type === "rect" && ov.properties?.kind === "callout") {
      const ax = x + (Number.isFinite(ov.properties.arrowDx)
        ? ov.properties.arrowDx
        : -30);
      const ay = y + (Number.isFinite(ov.properties.arrowDy)
        ? ov.properties.arrowDy
        : h + 25);
      // 三角片の影響範囲も bbox に含めるため ARROWHEAD_PAD を四方に
      if (ax - ARROWHEAD_PAD < minX) minX = ax - ARROWHEAD_PAD;
      if (ay - ARROWHEAD_PAD < minY) minY = ay - ARROWHEAD_PAD;
      if (ax + ARROWHEAD_PAD > maxX) maxX = ax + ARROWHEAD_PAD;
      if (ay + ARROWHEAD_PAD > maxY) maxY = ay + ARROWHEAD_PAD;
    }
  }
  // クランプ + マージン
  const bx = Math.max(0, minX - PAD);
  const by = Math.max(0, minY - PAD);
  const bxMax = Math.min(pageW, maxX + PAD);
  const byMax = Math.min(pageH, maxY + PAD);
  const bw = Math.max(0, bxMax - bx);
  const bh = Math.max(0, byMax - by);
  if (bw <= 0 || bh <= 0) {
    // overlay が全部ページ外 (data 不整合)。互換 fallback で空 canvas。
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    return { canvas, bboxPt: null };
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bw * zoom));
  canvas.height = Math.max(1, Math.round(bh * zoom));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("composeOverlayOnlyPage: 2d context unavailable");
  // bbox 左上が canvas(0,0) に来るよう translate。各 drawOverlay は
  // canonical 座標を zoom 倍するロジックなので、translate を入れる
  // だけで透過のサブセット描画が成立する。
  ctx.translate(-bx * zoom, -by * zoom);
  for (const ov of overlays) {
    await drawOverlay(ctx, ov, zoom, monoOverlays);
  }
  return {
    canvas,
    bboxPt: { x: bx, y: by, w: bw, h: bh },
  };
}

export async function compositePage(row, renderResult, projectStore, zoom = EXPORT_ZOOM, monoOverlays = false) {
  // mupdf returns the PDF at intrinsic /Rotate dims only — userRotation
  // is applied here so thumbs / export both match the rotated viewer.
  const userRot = (((row.userRotation ?? 0) % 360) + 360) % 360;
  const swap = userRot === 90 || userRot === 270;

  const canvas = document.createElement("canvas");
  canvas.width = swap ? renderResult.height : renderResult.width;
  canvas.height = swap ? renderResult.width : renderResult.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("compositePage: 2d context unavailable");

  // β.136: ページ PDF が背景に白塗り矩形を持たない (スキャン系 / Excel→PDF
  // 等) と mupdf は alpha=0 の透過 RGBA を返す。後段で JPEG q=0.95 化される
  // (full 戦略) と透過部分が黒として焼き込まれ、墨消しした際に「枠の外側
  // (透過部分) が全面黒、枠の中 (白塗り PDF 部分) は白のまま」となる事象を
  // 構造的に解消する。β.128 が composePageImage で行った対策の compositePage
  // 版。白下地を先に敷いて drawImage で page raster をブレンド合成する
  // (putImageData は下地を消す raw 書き込みなので tmp 経由で drawImage に
  // 統一する)。
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pixels =
    renderResult.pixels instanceof Uint8ClampedArray
      ? renderResult.pixels
      : new Uint8ClampedArray(renderResult.pixels.buffer ?? renderResult.pixels);
  let imageData;
  if (renderResult.channels === 4) {
    imageData = new ImageData(pixels, renderResult.width, renderResult.height);
  } else {
    const rgba = new Uint8ClampedArray(renderResult.width * renderResult.height * 4);
    for (let p = 0, q = 0; p < pixels.length; p += 3, q += 4) {
      rgba[q] = pixels[p];
      rgba[q + 1] = pixels[p + 1];
      rgba[q + 2] = pixels[p + 2];
      rgba[q + 3] = 255;
    }
    imageData = new ImageData(rgba, renderResult.width, renderResult.height);
  }
  // β.136: 必ず tmp canvas 経由で drawImage で合成 (putImageData は raw
  // 書き込みで上の白 fill を消すため)。userRot==0 も同経路に統一。
  const tmp = document.createElement("canvas");
  tmp.width = renderResult.width;
  tmp.height = renderResult.height;
  tmp.getContext("2d").putImageData(imageData, 0, 0);
  if (userRot === 0) {
    ctx.drawImage(tmp, 0, 0);
  } else {
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((userRot * Math.PI) / 180);
    ctx.drawImage(tmp, -renderResult.width / 2, -renderResult.height / 2);
    ctx.restore();
  }

  // Overlays in zOrder. ov.x / ov.y are already in the post-userRotation
  // canonical frame, so drawing on the rotated canvas at (x*zoom, y*zoom)
  // lands them where the user expects.
  const overlays = projectStore.getPageOverlays(row.pageNo);
  for (const ov of overlays) {
    await drawOverlay(ctx, ov, zoom, monoOverlays);
  }

  return canvas;
}

/**
 * Paint a single overlay onto the export canvas.
 *
 * For text we use Canvas 2D fillText with a generic CJK-friendly fallback
 * stack. For text-frame stamps we also stroke the configured frame.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {import("../domain/project-store.js").Overlay} ov
 * @param {number} zoom    canonical → pixel scale
 * @param {boolean} [monoOverlays=false] Phase 1: ON のとき色を黒に projection
 *   (マーカーは除外、redaction の "white" 指定も維持)
 */
async function drawOverlay(ctx, ov, zoom, monoOverlays = false) {
  const x = ov.x * zoom;
  const y = ov.y * zoom;
  const w = ov.w * zoom;
  const h = ov.h * zoom;
  const props = ov.properties ?? {};
  // Phase 1: 白黒印刷モード時に各 overlay の color を黒に置換する helper。
  // marker (黄ハイライト) は呼び出し側で完全に skip するので、その他の
  // overlay (text / stamp / form_field / callout / 形 / redaction) のみが
  // この経路に乗る。redaction の "white" 指定は user 意図 (white-out 風)
  // なので維持する (redaction 分岐で別途処理)。
  const monoize = (c) => (monoOverlays ? "#000000" : c);

  if (ov.type === "text") {
    // ⚠ v2.0.13: このレイアウト (wrap 幅 / lineHeight / 回転 anchor) は
    // _textOverlayVectorOps と 1:1 で対応している。ここを変えるときは
    // 必ず両方を同時に直すこと — ズレると「画面/ラスタ」と「ベクター
    // 印字 (明朝)」で行分割・位置が食い違う。
    const fontSize = (props.fontSize ?? 12) * zoom;
    const color = monoize(props.color ?? "#000000");
    ctx.font = `${fontSize}px ${getTextFontStack(props.fontId, {
      digitsHanko: !!props.digitsHanko,
    })}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "start";
    // β15/β31: see paintGlyphRun for why we stroke-then-fill at the
    // same color — plugs the AA halo that prints as gray dots.
    // β34: overstroke is now opt-in via props.bold (default off for
    // text overlay so the glyph is its natural weight).
    // β73: bold OFF のときは stroke 自体を完全に skip。β34 当時は 0.03×
    // fontSize の薄い stroke を残していたが、ユーザ報告で「焼き付け
    // 保存後にやたらに太い」「画面と印刷で字の太さが違う」と判明。
    // 900dpi (EXPORT_ZOOM) では fillText の AA halo が紙で gray dot に
    // ならないことが β41 (日付スタンプ I4) で実証済なので、テキスト
    // overlay も同じ判断で stroke opt-out できる。bold ON のときだけ
    // 0.06×fontSize の overstroke で見た目の太さを増す。
    const text = props.text ?? "";
    const lineHeight = fontSize * (props.lineHeight ?? 1);
    const rot = (((props.rotation ?? 0) % 360) + 360) % 360;
    // β76: 明朝/serif で bold OFF のときだけ極細 stroke で補強。bold ON
    // のときは従来どおり 0.06 stroke。Gothic/sans は β73 状態 (no stroke)。
    // β121: ページ番号など「細字のまま印刷を濃くしたい」用途向けに
    // props.enforceHairline でフォントに依らず hairline 補強を強制する
    // (= 太字 OFF + Gothic でもパリッと出る)。
    const _hairline = !props.bold && (
      !!props.enforceHairline || _needsHairlineStroke(props.fontId)
    );
    const boldOpt = {
      bold: !!props.bold,
      stroke: !!props.bold || _hairline,
      hairline: _hairline,
    };
    if (rot === 0) {
      const lines = wrapCanvasText(ctx, text, w);
      for (let i = 0; i < lines.length; i++) {
        paintGlyphRun(ctx, lines[i], x, y + i * lineHeight, color, fontSize, boldOpt);
      }
    } else {
      // Match the viewer's "rotate the content within the new rect"
      // behaviour: wrap to the PRE-rotation width and paint inside a
      // rotated transform anchored at the new-rect center.
      const isVert = rot === 90 || rot === 270;
      const naturalW = isVert ? h : w;
      const naturalH = isVert ? w : h;
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((rot * Math.PI) / 180);
      const lines = wrapCanvasText(ctx, text, naturalW);
      for (let i = 0; i < lines.length; i++) {
        paintGlyphRun(ctx, lines[i], -naturalW / 2, -naturalH / 2 + i * lineHeight, color, fontSize, boldOpt);
      }
      ctx.restore();
    }
    return;
  }

  if (ov.type === "stamp" && props.kind === "image" && props.assetId) {
    // Image stamp — fetch the asset blob and drawImage. Cached so
    // multiple stamps using the same asset don't re-fetch. Apply
    // userRotation around the box center (paper metaphor). When
    // props.color is set we draw the tinted variant (luminance →
    // alpha + RGB ← color); empty color = image as-is.
    // Phase 1: 白黒印刷モード時は props.color の有無に関わらず強制的に
    // #000000 で tint する (元が tint なし or bg-transparent の画像も
    // 黒シルエットに統一)。これで赤印影・青印影が薄く出る事故を回避。
    try {
      const effectiveTintColor = monoOverlays ? "#000000" : props.color;
      const tinted = effectiveTintColor
        ? await getTintedAssetCanvas(props.assetId, effectiveTintColor)
        : null;
      const src = tinted || (await getAssetBitmap(props.assetId));
      if (src) {
        // 画像スタンプは縦横比を保持して枠 (w×h) 内に収める (= viewer の
        // object-fit:contain と一致)。box が画像と非比例でも歪まず、中央寄せ
        // で letterbox する。これまで w×h に引き伸ばしていたため、画面では
        // contain なのに印刷だけ枠なりに伸びる不整合があった (β.131 で
        // palette 画像スタンプの resize は自由のままにした副作用)。
        const natW = src.width;
        const natH = src.height;
        let dw = w;
        let dh = h;
        if (natW > 0 && natH > 0) {
          const scale = Math.min(w / natW, h / natH);
          dw = natW * scale;
          dh = natH * scale;
        }
        const offX = (w - dw) / 2;
        const offY = (h - dh) / 2;
        const rot = (((props.rotation ?? 0) % 360) + 360) % 360;
        if (rot === 0) {
          ctx.drawImage(src, x + offX, y + offY, dw, dh);
        } else {
          ctx.save();
          ctx.translate(x + w / 2, y + h / 2);
          ctx.rotate((rot * Math.PI) / 180);
          ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
          ctx.restore();
        }
      }
    } catch (err) {
      console.error("[export] image stamp draw failed", err);
    }
    return;
  }

  if (ov.type === "stamp") {
    // Phase 1: text/date スタンプは props.color (デフォ赤 #cc0000) を持つ
    // ので、白黒モードでは黒に projection。frame の枠線も同色なので
    // 一括で黒くなる。
    const color = monoize(props.color ?? "#cc0000");
    const fontSize = (props.fontSize ?? 14) * zoom;
    const frame = props.frame ?? "circle";
    ctx.lineWidth = Math.max(2 * zoom * 0.5, 1.5);
    ctx.strokeStyle = color;
    if (frame === "circle") {
      ctx.beginPath();
      ctx.ellipse(
        x + w / 2,
        y + h / 2,
        Math.max(w / 2 - 1, 1),
        Math.max(h / 2 - 1, 1),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    } else if (frame === "rect") {
      ctx.strokeRect(x + 1, y + 1, Math.max(w - 2, 1), Math.max(h - 2, 1));
    }
    // Per-run fonts (ADR-0019 後半): full-width chars in the user's
    // 全角 stack, half-width in the 半角 stack. Measure runs first so
    // we can place the whole string centred, then draw left-to-right.
    const { full, half } = getStampFontDefaults();
    const fullStack = getStampFontStack(full);
    const halfStack = getStampFontStack(half);
    const rot = (((props.rotation ?? 0) % 360) + 360) % 360;
    // 不動文字フィット: N numbers distributed across the box width;
    // separator characters from the source format are dropped.
    // distribute-2 = year+month only; distribute-3 = year+month+day.
    if (props.spacingMode === "distribute-3" || props.spacingMode === "distribute-2") {
      const tokens = String(props.text ?? "").split(/\s+/).filter(Boolean);
      const drawSpaced = (cx, cy) => {
        drawSpacedTokensOnCanvas(ctx, tokens, cx, cy, w, fontSize, color, halfStack);
      };
      if (rot === 0) drawSpaced(x + w / 2, y + h / 2);
      else {
        ctx.save();
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate((rot * Math.PI) / 180);
        drawSpaced(0, 0);
        ctx.restore();
      }
      ctx.textAlign = "start";
      return;
    }
    // Date stamps (non-distribute formats like -8.-5.-9 / 令和-8年-5月-9日)
    // also skip overstroke — β31 unintentionally bolded them and the user
    // wants 印影 weight only for text stamps. Detection priority:
    //   1. props.stampKind (set on new placements from β41+)
    //   2. props.spacingMode (definitive: distribute-* = always date)
    // Existing date stamps placed before β41 without stampKind will
    // continue to print bold via drawStampMixedTextOnCanvas; user can
    // re-place if needed.
    const isDateStamp = props.stampKind === "date";
    const isTextStamp = props.stampKind === "text";
    // β.85: テキストスタンプ (認印・備考用) は normal weight で印刷。
    // overstroke も skip して β73 のテキスト overlay と同等の細字に揃え
    // る。date stamp は引き続き 印影 (bold + no overstroke)。stampKind
    // 不明 (pre-β41) は legacy 通り bold + overstroke で維持。
    const stampTextOpts = isDateStamp
      ? { stroke: false }
      : isTextStamp
        ? { stroke: false, bold: false }
        : {};
    const drawAt = (cx, cy) => {
      drawStampMixedTextOnCanvas(
        ctx, props.text ?? "", cx, cy, fontSize, color, fullStack, halfStack, stampTextOpts,
      );
    };
    if (rot === 0) {
      drawAt(x + w / 2, y + h / 2);
    } else {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((rot * Math.PI) / 180);
      drawAt(0, 0);
      ctx.restore();
    }
    ctx.textAlign = "start";
    return;
  }

  if (ov.type === "redaction") {
    // True redaction: paint a fully opaque rectangle (default black).
    // The page is already rasterised at this point, so the underlying
    // text layer is gone; this rectangle then covers the matching pixels.
    // Phase 1: redaction の "white" 指定 (white-out 風) は white を維持。
    // 白黒モードで白を黒に塗ると user 意図と逆になるため例外扱い。
    const fill = props.color === "white" ? "#ffffff" : "#000000";
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    return;
  }

  if (ov.type === "rect" && props.kind === "callout") {
    // Callout: white-fill box + outline + arrow line + text inside.
    // Phase 1: 白黒モードで枠線・矢印・本文をすべて黒に projection。
    // 白塗り fill (背景) は元々白なので影響なし。
    const color = monoize(props.color ?? "#000000");
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = Math.max(1.5 * zoom * 0.5, 1);
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);
    // Arrow: arrowDx/Dy are relative to BOX TOP-LEFT (matches viewer).
    const arrowDx = (props.arrowDx ?? -30) * zoom;
    const arrowDy = (props.arrowDy ?? ov.h + 25) * zoom;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const tipX = x + arrowDx;
    const tipY = y + arrowDy;
    let edgeX = cx, edgeY = cy;
    const dx = tipX - cx, dy = tipY - cy;
    if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
      const tx = dx === 0 ? Infinity : (dx > 0 ? (w / 2) / dx : (-w / 2) / dx);
      const ty = dy === 0 ? Infinity : (dy > 0 ? (h / 2) / dy : (-h / 2) / dy);
      const t = Math.min(tx, ty);
      edgeX = cx + dx * t;
      edgeY = cy + dy * t;
    }
    ctx.beginPath();
    ctx.moveTo(edgeX, edgeY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    // Filled triangular arrowhead at the tip, oriented along the line.
    const ah = 6 * zoom;
    const angle = Math.atan2(tipY - edgeY, tipX - edgeX);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - ah * Math.cos(angle - Math.PI / 6),
      tipY - ah * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      tipX - ah * Math.cos(angle + Math.PI / 6),
      tipY - ah * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    // Text inside the box. β31: same overstroke as text overlay.
    // β34: same opt-in bold semantics as text overlay.
    const fontSize = (props.fontSize ?? 12) * zoom;
    ctx.font = `${fontSize}px ${getTextFontStack(props.fontId, {
      digitsHanko: !!props.digitsHanko,
    })}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "start";
    const text = props.text ?? "";
    // Mirror renderer-side layout: horizontal padding 5pt (CALLOUT_PAD_X),
    // vertical 1pt (CALLOUT_PAD_Y_TOP / BOTTOM — border only, no slack)
    // so the flatten output hugs the text the same way the viewer does.
    const padX = 5 * zoom;
    const padY = 1 * zoom;
    const lineHeight = fontSize * (props.lineHeight ?? 1);
    const lines = wrapCanvasText(ctx, text, w - padX * 2);
    // β73: 吹き出し内テキストもテキスト overlay と同じく bold OFF 時の
    // stroke を opt-out (詳細は drawOverlay text 経路の β73 コメント参照)。
    // β76: 明朝/serif のときだけ極細 stroke (テキスト overlay と同じ規則)。
    const _hairline = !props.bold && _needsHairlineStroke(props.fontId);
    const boldOpt = {
      bold: !!props.bold,
      stroke: !!props.bold || _hairline,
      hairline: _hairline,
    };
    for (let i = 0; i < lines.length; i++) {
      paintGlyphRun(ctx, lines[i], x + padX, y + padY + i * lineHeight, color, fontSize, boldOpt);
    }
    return;
  }

  // β.100: オートシェイプ — 直線 / 矢印 / ブロック矢印 / 楕円。
  // bbox + arrowDir ("right"/"left"/"down"/"up") の組合せで描画方向を
  // 表現。fillColor は中空 (枠線のみ) を null で表す。ブロック矢印は
  // 7 頂点ポリゴン (shaft + head 三角)、楕円は bbox 内接、線/矢印は
  // bbox の中央線の両端を始終点に。
  if (ov.type === "shape") {
    drawShape(ctx, ov, zoom, monoOverlays);
    return;
  }

  if (ov.type === "line" && (props.kind ?? "marker") === "marker") {
    // Highlighter marker — semi-transparent fill so the underlying
    // text remains readable through the marker color.
    // Phase 1: マーカーは monoize **しない** (= 白黒モードでも原色維持)。
    // 黄を黒に塗ると下のテキストが完全に塞がれて読めなくなるため、
    // ハイライト機能の意義そのものが壊れる。白黒プリンタ側で淡い灰色
    // にされる挙動に任せる (FAX なら受信側でハーフトーン)。
    const color = props.color ?? "#ffeb3b";
    const opacity = typeof props.opacity === "number" ? props.opacity : 0.3;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    return;
  }

  // β.80 — Form fields (申請書テンプレ用)。4 sub-types share the
  // overlay type 'form_field' and are discriminated by props.fieldKind.
  // 印刷経路では「ガイド枠」は出さず、value がある (= filled な) もの
  // だけ実印字する。text サブタイプは alignH / alignV で揃え制御。
  if (ov.type === "form_field") {
    const fieldKind = props.fieldKind ?? "text";
    // Phase 1: form_field (text/check/circle/radio) の色を黒に projection。
    // デフォは元々 #000000 なので、ユーザがカラー指定したフォーム枠だけ
    // 影響を受ける。
    const color = monoize(props.color ?? "#000000");
    const value = String(props.value ?? "");
    const filled = value !== "" && value !== "off";

    if (fieldKind === "text") {
      // ⚠ v2.0.13: このレイアウト (padX / lineHeight 1.2 / alignH/V) は
      // _formFieldTextVectorOps と 1:1 で対応。変更時は両方同時に。
      const fontSize = (props.fontSize ?? 12) * zoom;
      const fontStack = getTextFontStack(props.fontFace);
      ctx.font = `${fontSize}px ${fontStack}`;
      ctx.fillStyle = color;
      const padX = Math.max(1, zoom);   // 1pt の内枠 padding
      const innerW = Math.max(0, w - 2 * padX);
      const lines = value === "" ? [] : wrapCanvasText(ctx, value, innerW);
      if (lines.length === 0) return;
      const lineHeight = fontSize * 1.2;
      const totalH = lines.length * lineHeight;
      const alignH = props.alignH ?? "left";
      const alignV = props.alignV ?? "middle";

      let baseY;
      if (alignV === "top") baseY = y;
      else if (alignV === "bottom") baseY = y + h - totalH;
      else baseY = y + (h - totalH) / 2;

      ctx.textBaseline = "top";
      for (let i = 0; i < lines.length; i++) {
        const lineW = ctx.measureText(lines[i]).width;
        let lineX;
        if (alignH === "right") lineX = x + w - padX - lineW;
        else if (alignH === "center") lineX = x + (w - lineW) / 2;
        else lineX = x + padX;
        ctx.fillText(lines[i], lineX, baseY + i * lineHeight);
      }
      return;
    }

    if (fieldKind === "check" || fieldKind === "radio") {
      if (!filled) return;
      const checkStyle =
        props.checkStyle ?? (fieldKind === "radio" ? "●" : "✓");
      // 記号サイズは bbox 高さに比例。フォントは sans (記号は CJK 等幅
      // が綺麗に出る) を使う。中央寄せで描く。
      const fontSize = h * 0.9;
      ctx.font = `${fontSize}px ${getTextFontStack("gothic")}`;
      ctx.fillStyle = color;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(checkStyle, x + w / 2, y + h / 2);
      // textAlign / textBaseline はその後の overlay 描画に影響しない
      // よう即時に戻す (drawOverlay は毎 overlay 独立に呼ばれるが、念
      // のため state を normalise しておく)。
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "start";
      return;
    }

    if (fieldKind === "circle") {
      if (!filled) return;
      const strokeWidth = (props.strokeWidth ?? 1.2) * zoom;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeWidth;
      ctx.beginPath();
      const rx = Math.max(0, w / 2 - strokeWidth / 2);
      const ry = Math.max(0, h / 2 - strokeWidth / 2);
      ctx.ellipse(x + w / 2, y + h / 2, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }
    // 不明 fieldKind は何も描画しない (printout で目立つガイド枠は
    // 出さない方針)。
    return;
  }

  // Other types render as a stroked rect placeholder.
  ctx.strokeStyle = "#888";
  ctx.strokeRect(x, y, w, h);
}

/**
 * Character-by-character word wrap that matches the viewer's
 * `white-space: pre-wrap` behaviour for CJK text. Hard-breaks at \n,
 * otherwise greedily fits as many code points as possible per line up
 * to maxWidth (in CSS px). Caller is responsible for setting ctx.font
 * before invoking.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth   px
 * @returns {string[]}
 */
function wrapCanvasText(ctx, text, maxWidth) {
  const out = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const ch of para) {
      const candidate = line + ch;
      const width = ctx.measureText(candidate).width;
      if (line.length > 0 && width > maxWidth) {
        out.push(line);
        line = ch;
      } else {
        line = candidate;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

/**
 * Encode the composed page canvas as PNG. Used for the overlay-only
 * layer (transparent background) in the hybrid pipeline — JPEG can't
 * carry alpha, and we need the source PDF page to show through where
 * the overlay layer is empty.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Uint8Array>}
 */
function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error("canvasToPng: toBlob returned null"));
          return;
        }
        const buf = await blob.arrayBuffer();
        resolve(new Uint8Array(buf));
      },
      "image/png",
    );
  });
}

/**
 * Encode the composed page canvas as JPEG at the given quality. Used for
 * full-page rasterized fallbacks (synthetic / rotated pages where the
 * hybrid path can't preserve vectors). JPEG keeps these single-image
 * pages small while remaining visually acceptable; the truly-quality-
 * critical pages go through the overlay-only path which preserves
 * source-PDF vectors.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} quality 0..1
 * @returns {Promise<Uint8Array>}
 */
function canvasToJpeg(canvas, quality = 0.95) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error("canvasToJpeg: toBlob returned null"));
          return;
        }
        const buf = await blob.arrayBuffer();
        resolve(new Uint8Array(buf));
      },
      "image/jpeg",
      quality,
    );
  });
}
