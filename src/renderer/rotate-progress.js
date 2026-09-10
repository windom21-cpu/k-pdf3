// ページ回転の処理中インジケーター用の純関数 (DOM 非依存、node --test 可)。
//
// なぜ: 大部 PDF の回転は main 側 `set-page-rotation` が PDF 全体を再読込
// するため数秒〜十数秒無反応に見え、ユーザーが「フリーズ」と判断して回転
// ボタンを押し直す → 押した回数分 (180° / 270°) 積み上がる、という報告
// (2026-09-10)。rotatePageBy 本体 (完成領域) は触らず、呼び出し側の busy
// モーダルに「いまどの段階か / 何ページ目か / 経過秒」を出して、動いている
// ことが分かるようにする。%・文言の組み立てだけをここに置く。
//
// 段階 (stage):
//   commit  — rotatePageBy 呼出中、viewer の再構築イベント未着
//             (= main で DB 更新 + PDF 再読込中。大きなファイルほど長い)
//   rebuild — viewer が kpdf3:pages-rebuilt を発火した後 (画面・サムネ更新中)
//   revert  — 「中止して元に戻す」後、処理済みページを逆回転している

export const ROTATE_STAGE = Object.freeze({
  COMMIT: "commit",
  REBUILD: "rebuild",
  REVERT: "revert",
});

/** 1 ページ内の進み具合 (0..1)。commit の間は 0.1、rebuild に入ったら 0.7。 */
const STAGE_FRACTION = Object.freeze({
  [ROTATE_STAGE.COMMIT]: 0.1,
  [ROTATE_STAGE.REBUILD]: 0.7,
});

/** 経過秒がこれ以上なら「大きな PDF は時間がかかる」補足を足す。 */
export const SLOW_HINT_AFTER_SEC = 5;

/**
 * 進捗 % (0..100 の整数)。
 * @param {{done:number, total:number, stage?:string, reverted?:number, revertTotal?:number}} s
 *   done        = 完了したページ数 (成功・skip 問わず)
 *   total       = 対象ページ数 (>= 1)
 *   stage       = 現在のページの段階 (省略時 commit)
 *   reverted    = revert 段階で戻し終えたページ数
 *   revertTotal = revert 対象ページ数
 */
export function rotateProgressPercent(s) {
  const total = Math.max(1, s.total | 0);
  if (s.stage === ROTATE_STAGE.REVERT) {
    const rt = Math.max(1, s.revertTotal | 0);
    return clampPct(((s.reverted | 0) / rt) * 100);
  }
  const done = Math.max(0, Math.min(total, s.done | 0));
  if (done >= total) return 100;
  const frac = STAGE_FRACTION[s.stage ?? ROTATE_STAGE.COMMIT] ?? STAGE_FRACTION.commit;
  return clampPct(((done + frac) / total) * 100);
}

function clampPct(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * busy モーダルの本文。1 行で読める長さに収める。
 * @param {{
 *   pageNo?: number, done: number, total: number, stage?: string,
 *   elapsedSec?: number, cancelled?: boolean, reverted?: number, revertTotal?: number,
 * }} s
 */
export function formatRotateMessage(s) {
  const total = Math.max(1, s.total | 0);
  const elapsed = Math.max(0, s.elapsedSec | 0);
  const tail = ` — 経過 ${elapsed} 秒`;

  if (s.stage === ROTATE_STAGE.REVERT) {
    const rt = Math.max(1, s.revertTotal | 0);
    return `元に戻しています... (${s.reverted | 0}/${rt})${tail}`;
  }
  if (s.cancelled) {
    return `中止しています — 処理中のページが終わり次第、元に戻します...${tail}`;
  }
  const idx = Math.min(total, (s.done | 0) + 1);
  const count = total > 1 ? ` (${idx}/${total} ページ目)` : "";
  const page = Number.isFinite(s.pageNo) && s.pageNo ? `p.${s.pageNo} ` : "";
  if (s.stage === ROTATE_STAGE.REBUILD) {
    return `${page}画面とサムネイルを更新しています...${count}${tail}`;
  }
  let msg = `${page}回転を PDF に記録しています...${count}${tail}`;
  if (elapsed >= SLOW_HINT_AFTER_SEC) {
    msg += "。大きな PDF は再読込に時間がかかります (秒数が進んでいればフリーズではありません)";
  }
  return msg;
}
