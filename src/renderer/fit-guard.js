// fit-width / fit-page の「viewport リサイズで再フィット」判定 (純関数)。
//
// なぜ (2026-09-10 トレースで確定した無限往復):
//   回転で横長になった p.150 の幅にフィット (0.943) → setZoom の比率スクロール
//   で現在ページ判定 (上端 1/3 基準) が縦長の隣ページ p.151 に落ちる → 横
//   スクロールバーが消えて clientHeight が変わり ResizeObserver 発火 → p.151
//   の幅に再フィット (1.334) → p.150 が画面幅を超えて横バー出現 → 高さが
//   変わり再発火 → p.150 に再フィット → … を 0.5 秒周期で繰り返し、1 周ごと
//   に 300 ページの再構築 + 重いページ描画が走って main / renderer とも 100%
//   (「ちかちか + フリーズ」)。幅の狭い (縦長の) ウインドウほど成立しやすい。
//
// 対策:
//   (1) fit-width は zoom が clientWidth にしか依存しないので、幅が変わって
//       いない RO 通知 (横バー出没 = 高さだけ変化) では再フィットしない。
//   (2) fit-page は高さにも依存するため往復し得る。直近のズーム履歴が
//       A → B → A → B と往復していたら、しばらく再フィットを止める。

/** 往復検知に使う履歴の最大長・時間窓 (ms)・停止時間 (ms)。 */
export const FLIP_HISTORY_MAX = 6;
export const FLIP_WINDOW_MS = 3000;
export const FLIP_COOLDOWN_MS = 2000;

/**
 * RO 通知で再フィットすべきか。
 * @param {{mode:string, w:number, h:number, lastW:number, lastH:number}} s
 *   mode = "fit-width" | "fit-page" | その他 (→ false)
 *   w/h  = 今回の clientWidth / clientHeight
 *   lastW/lastH = 前回通知時の値 (初回は -1)
 * @returns {boolean}
 */
export function shouldRefitOnResize(s) {
  const widthChanged = s.w !== s.lastW;
  const heightChanged = s.h !== s.lastH;
  if (s.mode === "fit-width") return widthChanged;
  if (s.mode === "fit-page") return widthChanged || heightChanged;
  return false;
}

/**
 * ズーム履歴が往復 (A,B,A,B…) しているか。
 * @param {Array<{zoom:number, t:number}>} history 古い → 新しい順
 * @param {number} now
 * @returns {boolean} 直近 4 件が FLIP_WINDOW_MS 内で A≠B かつ A,B,A,B なら true
 */
export function isZoomFlipping(history, now) {
  if (!Array.isArray(history) || history.length < 4) return false;
  const recent = history.slice(-4);
  if (now - recent[0].t > FLIP_WINDOW_MS) return false;
  const [a, b, c, d] = recent.map((e) => e.zoom);
  const eq = (x, y) => Math.abs(x - y) < 1e-6;
  return !eq(a, b) && eq(a, c) && eq(b, d);
}

/**
 * 履歴に追加して長さを FLIP_HISTORY_MAX に丸める (新しい配列を返す)。
 * @param {Array<{zoom:number, t:number}>} history
 * @param {number} zoom
 * @param {number} t
 */
export function pushZoomHistory(history, zoom, t) {
  const next = [...(history ?? []), { zoom, t }];
  return next.length > FLIP_HISTORY_MAX ? next.slice(-FLIP_HISTORY_MAX) : next;
}
