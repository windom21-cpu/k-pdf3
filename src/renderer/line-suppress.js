// β.114: 薄い罫線の表示時抑制フィルター。
//
// 銀行明細など、Adobe では非表示の極細罫線 (色: #c0-#e8 程度の均一グレー、
// 幅 0.1-0.3pt) が mupdf レンダリングでは anti-aliasing で「薄いセル
// 境界」として可視化される問題への対応 (β.113 ユーザー報告)。
//
// 動作:
//   - 入力 pixmap (RGBA in-place) を走査
//   - 各ピクセルが「薄い無彩色グレー」候補か判定
//     ・ max(R,G,B) - min(R,G,B) <= 4 (= ほぼ無彩色)
//     ・ min(R,G,B) >= LO_GRAY (例: 180) (= 十分に明るい)
//     ・ alpha が十分 (255 近辺)
//   - 「候補ピクセル」が水平 or 垂直に minRun 以上連続している場合に限り
//     白 (255,255,255) に塗り潰す
//   - 文字の anti-aliasing 境界は連続しない (色が階調変化する) ため、
//     minRun=4 以上にしておけば文字輪郭は守られる
//
// 設計:
//   - 純粋関数 (in-place 加工で副作用は引数 pixels のみ)
//   - 副作用は表示時の pixmap のみ。書き出し / 印刷経路の compositePage
//     にはこの関数を一切呼ばない (= オリジナル PDF への波及ゼロ)
//
// 計算量: O(width * height) で 2 pass (水平 + 垂直)。900dpi/4K でも数十 ms。

const DEFAULT_MIN_RUN = 5;     // px。文字輪郭を守る安全閾値
const DEFAULT_LO_GRAY = 180;   // 0-255。これ未満の暗い色は対象外
const DEFAULT_CHROMA = 4;      // max-min。0=完全無彩色、4=ほぼ無彩色

/** 1 ピクセルが「薄グレー罫線候補」か判定。 */
function isCandidatePixel(r, g, b, a, loGray, chroma) {
  if (a < 200) return false;
  if (r < loGray || g < loGray || b < loGray) return false;
  if (r > 250 && g > 250 && b > 250) return false; // 純白に近いものは対象外 (= 既に白)
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx - mn > chroma) return false;
  return true;
}

/**
 * 薄い罫線を白に置換する in-place フィルター。
 *
 * @param {Uint8ClampedArray} pixels  RGBA flat buffer (length = w*h*4)
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @param {number} [opts.minRun=5]    水平/垂直に連続するピクセル数の下限
 * @param {number} [opts.loGray=180]  「薄グレー」と見なす明度下限
 * @param {number} [opts.chroma=4]    R,G,B の最大差 (無彩色度)
 */
export function suppressThinLines(pixels, width, height, opts = {}) {
  const minRun = opts.minRun ?? DEFAULT_MIN_RUN;
  const loGray = opts.loGray ?? DEFAULT_LO_GRAY;
  const chroma = opts.chroma ?? DEFAULT_CHROMA;
  if (!pixels || width <= 0 || height <= 0) return;

  // 候補マスクを 1 byte / pixel で構築 (= 候補なら 1)
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2], a = pixels[p + 3];
      if (isCandidatePixel(r, g, b, a, loGray, chroma)) {
        mask[y * width + x] = 1;
      }
    }
  }

  // 「罫線」として白に置換するピクセルを別マスクに集計 (= 確定マスク)。
  // 水平 / 垂直の片方でも minRun を満たせばその run のピクセル全部に印を付ける。
  const erase = new Uint8Array(width * height);

  // 水平 run
  for (let y = 0; y < height; y++) {
    let runStart = -1;
    for (let x = 0; x <= width; x++) {
      const isCand = x < width && mask[y * width + x] === 1;
      if (isCand) {
        if (runStart < 0) runStart = x;
      } else {
        if (runStart >= 0) {
          const runLen = x - runStart;
          if (runLen >= minRun) {
            for (let k = runStart; k < x; k++) erase[y * width + k] = 1;
          }
          runStart = -1;
        }
      }
    }
  }

  // 垂直 run
  for (let x = 0; x < width; x++) {
    let runStart = -1;
    for (let y = 0; y <= height; y++) {
      const isCand = y < height && mask[y * width + x] === 1;
      if (isCand) {
        if (runStart < 0) runStart = y;
      } else {
        if (runStart >= 0) {
          const runLen = y - runStart;
          if (runLen >= minRun) {
            for (let k = runStart; k < y; k++) erase[k * width + x] = 1;
          }
          runStart = -1;
        }
      }
    }
  }

  // 確定マスクのピクセルだけ白に置換 (alpha は維持)
  for (let i = 0; i < erase.length; i++) {
    if (erase[i]) {
      const p = i * 4;
      pixels[p] = 255;
      pixels[p + 1] = 255;
      pixels[p + 2] = 255;
      // alpha はそのまま (= 既に opaque な背景ピクセルなので変化なし)
    }
  }
}
