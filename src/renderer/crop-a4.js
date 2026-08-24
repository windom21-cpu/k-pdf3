// A4 切り取り (ADR-0029) — 非 A4 ページに A4 縦の固定枠を置いて、枠ごとに
// A4 縦 1 ページへ切り出した「別ファイル」を作る UI。
//
//   - 対象 = 文書内の全非 A4 縦ページ (canonical 寸法が A4 縦 ±2pt でない)。
//     A3 横は初期枠 2 つ (左半分/右半分 = ちょうど A4 縦 2 枚)、他は中央 1 枠。
//   - 枠はドラッグ移動のみ (サイズ固定)。ページ端・左右半分位置へスナップ。
//     枠を全部消したページは切り取らず素通し。
//   - プレビューは exporter 側の composeSinglePageCanvas (出力と同じ描画) を
//     使う — 「画面は正しいのに出力だけおかしい」二重実装問題を持ち込まない。
//   - 保存動線は actionSavePagesAsPdf (sidebar-thumbs.js) と同型:
//     保存ダイアログ (セキュア/白黒トグル) → composePagesForExport (全ページ)
//     → exportPdfRasterized({..., cropFrames}) → newTabAndOpen。
//     workspace / 元ファイルには一切触らない。
//
// State (viewer, isOpen, projectStore) は renderer.js が initCropA4 の getter
// 注入で渡す (§4.4 パターン 1 — sidebar-thumbs と同じ)。

import { composePagesForExport, composeSinglePageCanvas } from "./exporter.js";
import { renderSyntheticPagePixels } from "./viewer.js";
import { showBusy, updateBusy, hideBusy } from "./busy-modal.js";
import { customConfirm } from "./dialogs.js";
import { showFileBrowser } from "./file-browser.js";
import { newTabAndOpen } from "./tab-manager.js";
import { detectPaperSize } from "./sidebar-thumbs.js";

const { kpdf3 } = window;
const $ = (id) => document.getElementById(id);
const wsStatus = $("ws-status");

const A4_W = 595.28;
const A4_H = 841.89;
const A3_W = 1190.55; // A3 横の幅 = A4 縦 2 枚ぶん
const SIZE_TOL = 2.0; // detectPaperSize と同じ ±2pt ≈ 0.7mm
const STAGE_MARGIN_PT = 48; // 枠がページ外 (グレー背景) に出られる余地
const SNAP_PT = 8;
const MAX_FRAMES = 8;

let viewer = null;
let _isOpen = () => false;
let _projectStore = () => null;

export function initCropA4({ viewer: viewerRef, isOpen, projectStore }) {
  viewer = viewerRef;
  _isOpen = isOpen;
  _projectStore = projectStore;
}

const dlg = $("crop-a4-dialog");
const stage = $("crop-a4-stage");
const canvas = $("crop-a4-canvas");
const pageLabel = $("crop-a4-pagelabel");
const prevBtn = $("crop-a4-prev");
const nextBtn = $("crop-a4-next");
const addBtn = $("crop-a4-add");
const removeBtn = $("crop-a4-remove");
const confirmBtn = $("crop-a4-confirm");
const cancelBtn = $("crop-a4-cancel");

const state = {
  targets: [], // 非 A4 の page row (表示順)
  idx: 0,
  frames: new Map(), // pageNo -> [{x, y}] canonical top-left 原点 pt
  zoom: 1,
  pageW: 0,
  pageH: 0,
  offX: 0, // ページ左上の stage 内 px 位置
  offY: 0,
  selected: 0,
  renderToken: 0,
};

/** canonical (intrinsic /Rotate + userRotation 適用後) の表示寸法。
 *  print-flow.js の _detectPageSizeMix と同じ規則。 */
function canonicalSize(row) {
  const rot = ((((row.rotation ?? 0) + (row.userRotation ?? 0)) % 360) + 360) % 360;
  const cw = row.cropW ?? row.width ?? 595;
  const ch = row.cropH ?? row.height ?? 842;
  return rot === 90 || rot === 270 ? { w: ch, h: cw } : { w: cw, h: ch };
}

function isA4Portrait(w, h) {
  return Math.abs(w - A4_W) < SIZE_TOL && Math.abs(h - A4_H) < SIZE_TOL;
}

/** 初期枠: A3 横だけ左右 2 枠 (ちょうど A4 縦 2 枚)、他は中央 1 枠
 *  (2026-08-24 ユーザー決定 — B4 横などは 1 枠 + 「枠を追加」)。 */
function defaultFrames(w, h) {
  if (Math.abs(w - A3_W) < SIZE_TOL && Math.abs(h - A4_H) < SIZE_TOL) {
    const y = (h - A4_H) / 2;
    return [{ x: 0, y }, { x: w - A4_W, y }];
  }
  return [{ x: (w - A4_W) / 2, y: (h - A4_H) / 2 }];
}

function sizeLabel(w, h) {
  const name = detectPaperSize(w, h);
  if (name) return `${name} ${w > h ? "横" : "縦"}`;
  const mm = (pt) => Math.round((pt / 72) * 25.4);
  return `${mm(w)}×${mm(h)}mm`;
}

/** 右クリックメニューからの入口。startPageNo が対象ならそこから開始。 */
export async function actionCropToA4(startPageNo) {
  if (!_isOpen()) return;
  const all = viewer._pages ?? [];
  const targets = all.filter((r) => {
    const { w, h } = canonicalSize(r);
    return !isA4Portrait(w, h);
  });
  if (targets.length === 0) {
    await customConfirm({
      title: "A4 サイズに切り取り",
      message: "A4 縦でないページが見つかりませんでした。\nこの機能は非 A4 ページを A4 縦に切り出すためのものです。",
      okLabel: "閉じる",
      cancelLabel: null,
    });
    return;
  }
  state.targets = targets;
  state.frames = new Map();
  // 全対象ページに初期枠を置いてから開く — 巡回せず保存しても
  // 「全非 A4 ページが初期位置で切り取られる」決定的な動作にする。
  for (const r of targets) {
    const { w, h } = canonicalSize(r);
    state.frames.set(r.pageNo, defaultFrames(w, h));
  }
  const startIdx = targets.findIndex((r) => r.pageNo === startPageNo);
  state.idx = startIdx >= 0 ? startIdx : 0;
  dlg.hidden = false;
  await showCurrentPage();
}

async function showCurrentPage() {
  const row = state.targets[state.idx];
  const { w, h } = canonicalSize(row);
  state.pageW = w;
  state.pageH = h;
  state.selected = 0;
  // stage はページと A4 枠の大きい方 + 余白。ダイアログ内に収まる zoom で表示。
  const stW = Math.max(w, A4_W) + STAGE_MARGIN_PT * 2;
  const stH = Math.max(h, A4_H) + STAGE_MARGIN_PT * 2;
  const AVAIL_W = 660;
  const AVAIL_H = 430;
  const zoom = Math.min(AVAIL_W / stW, AVAIL_H / stH);
  state.zoom = zoom;
  stage.style.width = `${Math.round(stW * zoom)}px`;
  stage.style.height = `${Math.round(stH * zoom)}px`;
  state.offX = Math.round(((stW - w) / 2) * zoom);
  state.offY = Math.round(((stH - h) / 2) * zoom);
  canvas.style.left = `${state.offX}px`;
  canvas.style.top = `${state.offY}px`;
  const all = viewer._pages ?? [];
  const visIdx = all.indexOf(row);
  pageLabel.textContent =
    `対象 ${state.idx + 1} / ${state.targets.length} — `
    + `ページ ${visIdx >= 0 ? visIdx + 1 : "?"} (${sizeLabel(w, h)})`;
  prevBtn.disabled = state.idx === 0;
  nextBtn.disabled = state.idx === state.targets.length - 1;
  rebuildFrameEls();
  // プレビューは非同期 render — ページ切替が追い越したら stale 結果を捨てる
  // (print-flow.js の renderToken パターン)。
  const token = ++state.renderToken;
  canvas.width = Math.max(1, Math.round(w * zoom));
  canvas.height = Math.max(1, Math.round(h * zoom));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    const src = await composeSinglePageCanvas(
      row, kpdf3.renderPage, _projectStore(), zoom, renderSyntheticPagePixels,
    );
    if (token !== state.renderToken || dlg.hidden) return;
    canvas.width = src.width;
    canvas.height = src.height;
    canvas.getContext("2d").drawImage(src, 0, 0);
  } catch (err) {
    console.error("[crop-a4] preview render failed:", err);
  }
}

function currentFrames() {
  const row = state.targets[state.idx];
  return row ? (state.frames.get(row.pageNo) ?? []) : [];
}

function rebuildFrameEls() {
  for (const el of stage.querySelectorAll(".crop-a4-frame")) el.remove();
  const frames = currentFrames();
  frames.forEach((f, i) => {
    const el = document.createElement("div");
    el.className = "crop-a4-frame";
    if (i === state.selected) el.classList.add("selected");
    el.dataset.frameIdx = String(i);
    const badge = document.createElement("div");
    badge.className = "crop-a4-frame-badge";
    badge.textContent = String(i + 1);
    el.appendChild(badge);
    positionFrameEl(el, f);
    attachFrameDrag(el);
    stage.appendChild(el);
  });
  removeBtn.disabled = frames.length === 0;
  addBtn.disabled = frames.length >= MAX_FRAMES;
}

function positionFrameEl(el, f) {
  const z = state.zoom;
  el.style.left = `${state.offX + f.x * z}px`;
  el.style.top = `${state.offY + f.y * z}px`;
  el.style.width = `${A4_W * z}px`;
  el.style.height = `${A4_H * z}px`;
}

function selectFrame(idx) {
  state.selected = idx;
  stage.querySelectorAll(".crop-a4-frame").forEach((el) => {
    el.classList.toggle("selected", Number(el.dataset.frameIdx) === idx);
  });
}

function attachFrameDrag(el) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const idx = Number(el.dataset.frameIdx);
    selectFrame(idx);
    const f = currentFrames()[idx];
    if (!f) return;
    const z = state.zoom;
    const startX = f.x;
    const startY = f.y;
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    // 枠が動ける範囲 = stage 全体 (ページ外のグレー背景も可 — A4 未満の
    // ページを余白付きで A4 化する要件)。
    const minX = -state.offX / z;
    const minY = -state.offY / z;
    const maxX = (stage.clientWidth - state.offX) / z - A4_W;
    const maxY = (stage.clientHeight - state.offY) / z - A4_H;
    el.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      let nx = startX + (ev.clientX - startMouseX) / z;
      let ny = startY + (ev.clientY - startMouseY) / z;
      nx = Math.min(Math.max(nx, minX), maxX);
      ny = Math.min(Math.max(ny, minY), maxY);
      // スナップ: ページ左端 / 右端 / 左右中央 (A3 の「右半分」開始位置は
      // w−A4_W ≈ 中央)、上端 / 下端 / 上下中央。
      const xStops = [0, state.pageW - A4_W, (state.pageW - A4_W) / 2, state.pageW / 2];
      const yStops = [0, state.pageH - A4_H, (state.pageH - A4_H) / 2];
      for (const s of xStops) if (Math.abs(nx - s) < SNAP_PT) { nx = s; break; }
      for (const s of yStops) if (Math.abs(ny - s) < SNAP_PT) { ny = s; break; }
      f.x = nx;
      f.y = ny;
      positionFrameEl(el, f);
    };
    const onUp = (ev) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  });
}

function closeDialog() {
  state.renderToken++;
  dlg.hidden = true;
  for (const el of stage.querySelectorAll(".crop-a4-frame")) el.remove();
}

prevBtn.addEventListener("click", async () => {
  if (state.idx > 0) {
    state.idx--;
    await showCurrentPage();
  }
});
nextBtn.addEventListener("click", async () => {
  if (state.idx < state.targets.length - 1) {
    state.idx++;
    await showCurrentPage();
  }
});
addBtn.addEventListener("click", () => {
  const row = state.targets[state.idx];
  if (!row) return;
  const frames = state.frames.get(row.pageNo) ?? [];
  if (frames.length >= MAX_FRAMES) return;
  // 中央から枠数ぶん少しずらして追加 (重なって見えなくならないように)。
  const off = frames.length * 24;
  frames.push({
    x: (state.pageW - A4_W) / 2 + off,
    y: (state.pageH - A4_H) / 2 + off,
  });
  state.frames.set(row.pageNo, frames);
  state.selected = frames.length - 1;
  rebuildFrameEls();
});
removeBtn.addEventListener("click", () => {
  const row = state.targets[state.idx];
  if (!row) return;
  const frames = state.frames.get(row.pageNo) ?? [];
  if (frames.length === 0) return;
  frames.splice(Math.min(state.selected, frames.length - 1), 1);
  state.frames.set(row.pageNo, frames);
  state.selected = 0;
  rebuildFrameEls();
});
cancelBtn.addEventListener("click", closeDialog);

confirmBtn.addEventListener("click", async () => {
  // 枠を出力順 (上→下・左→右。A3 の左右 2 枠は y がほぼ同じなので x 順) に
  // 整列して送る。y は半 A4 単位で丸めて比較 — 手ドラッグの数 pt 差で
  // 左右の順序が入れ替わらないように。
  const cropFrames = {};
  let frameTotal = 0;
  for (const [pageNo, frames] of state.frames) {
    if (!frames.length) continue;
    const sorted = [...frames].sort((a, b) => {
      const rowA = Math.round(a.y / (A4_H / 2));
      const rowB = Math.round(b.y / (A4_H / 2));
      return rowA - rowB || a.x - b.x;
    });
    cropFrames[pageNo] = sorted.map((f) => ({ x: f.x, y: f.y, w: A4_W, h: A4_H }));
    frameTotal += frames.length;
  }
  if (frameTotal === 0) {
    await customConfirm({
      title: "A4 サイズに切り取り",
      message: "枠が 1 つもありません。\n少なくとも 1 ページに枠を置いてください。",
      okLabel: "閉じる",
      cancelLabel: null,
    });
    return;
  }
  closeDialog();
  const all = viewer._pages ?? [];
  const defaults = await kpdf3.getExportDefaults();
  const baseName = (defaults.defaultName || "document").replace(/\.[^.]+$/, "");
  const choice = await showFileBrowser({
    mode: "save",
    title: "A4 サイズに切り取り — 保存先",
    initialName: `${baseName}_A4.pdf`,
    defaultDir: defaults.sourceDir,
    secureExportToggle: true,
    monoExportToggle: true,
  });
  if (!choice) return;
  const { path: savePath, secureExport, monoExport } = choice;
  showBusy("A4 切り取り", `${all.length} ページを書き出し中...`, 0);
  try {
    const composed = await composePagesForExport({
      pages: all,
      projectStore: _projectStore(),
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
      rasterRedactionPages: true,
      monoOverlays: !!monoExport,
      vectorTextProbe: kpdf3.vectorTextProbe,
      onProgress: ({ done, total }) => {
        updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
      },
    });
    updateBusy("A4 枠で切り取り中...", 90);
    const result = await kpdf3.exportPdfRasterized({
      savePath,
      pages: composed,
      secureExport,
      cropFrames,
    });
    hideBusy();
    const outPages = all.length - Object.keys(cropFrames).length + frameTotal;
    wsStatus.textContent =
      `${savePath} に保存しました（A4 切り取り ${frameTotal} 枠 / 全 ${outPages} ページ, `
      + `rev ${(result?.revisionId ?? "").slice(0, 8)}）`;
    if (secureExport && result?.qpdfMissing) {
      await customConfirm({
        title: "セキュア書き出し: qpdf 未検出",
        message:
          "qpdf バイナリが見つからなかったため、個人情報の消去をスキップして\n"
          + "通常の書き出しを行いました。",
        okLabel: "閉じる",
        cancelLabel: null,
      });
    }
    // 切り取り結果を新タブで開いて直接確認できるようにする (元タブは不変)。
    try {
      await newTabAndOpen(savePath);
    } catch (openErr) {
      console.error("[crop-a4] post-save open failed:", openErr);
    }
  } catch (err) {
    hideBusy();
    console.error("[crop-a4] failed", err);
    wsStatus.textContent = `A4 切り取りの保存に失敗: ${err.message ?? err}`;
  }
});
