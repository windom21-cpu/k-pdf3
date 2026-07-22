// 分割保存パネル (split-save) — S6 リファクタ (REVIEW-2026-07 #8) その4で
// renderer.js から抽出。ロジックは移動のみで不変。
//
//   actionSplitSave / setSplitMode — パネルの開閉 (btn-split トグル)
//   splitState — 分割点 / パート名 / サムネキャッシュ (renderer が invalidate に参照)
//   rebuildSplitUI / createThumbElement — パート区切り + サムネ UI
//   generateAllThumbnails / swapThumbCanvas — β.123 プログレッシブサムネ生成
//   refreshSplitView — ページ増減/回転後の再構築 (split mode 中のみ呼ばれる)
//   分割確定 (splitConfirmBtn) — パートごとに composePagesForExport → 保存
//
// State (isOpen, projectStore, fetchVisiblePages, viewer) は renderer.js が
// 所有し、initSplitView の getter 注入で参照する (§4.4 パターン 1)。
// selection / D&D / gap / コンテキストメニューのヘルパーは sidebar-thumbs.js
// から import して共有する (サイドバーサムネと同一機構、S6 その3)。

import { composePagesForExport, compositePage } from "./exporter.js";
import { renderSyntheticPagePixels } from "./viewer.js";
import { showBusy, updateBusy, hideBusy } from "./busy-modal.js";
import { showFileBrowser } from "./file-browser.js";
import {
  splitThumbSelection,
  getOrderedThumbPageNos,
  handleThumbSelectionClick,
  refreshThumbSelectionVisuals,
  attachThumbContextMenu,
  attachThumbDragHandlers,
  makeSplitInsertGap,
  detectPaperSize,
} from "./sidebar-thumbs.js";

const { kpdf3 } = window;
const $ = (id) => document.getElementById(id);
const wsStatus = $("ws-status");
const mainArea = $("main-area");
const splitView = $("split-view");
const btnSplit = $("btn-split");

let viewer = null;
let _isOpen = () => false;
let _projectStore = () => null;
let _fetchVisiblePages = async () => [];

export function initSplitView({
  viewer: viewerRef,
  isOpen,
  projectStore,
  fetchVisiblePages,
}) {
  viewer = viewerRef;
  _isOpen = isOpen;
  _projectStore = projectStore;
  _fetchVisiblePages = fetchVisiblePages;
}

// ---- Split-save panel (M5-6 V2 — inline panel, not a modal) --------
const splitFlow = $("split-flow");
const splitConfirmBtn = $("split-confirm");
const splitCancelBtn = $("split-cancel");
const thumbSizeSlider = $("thumb-size");
const thumbSizeDisplay = $("thumb-size-display");
const datePrefixToggle = $("date-prefix-toggle");
const datePrefixPreview = $("date-prefix-preview");

/** YYMMDD format for filename prefixes (e.g., 2026-05-09 → "260509"). */
function getDateYYMMDD(d = new Date()) {
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// Refresh the preview number in the toggle label every time we enter
// split mode, so a user who left the dialog open across midnight sees
// the new date.
function refreshDatePrefixPreview() {
  if (datePrefixPreview) datePrefixPreview.textContent = getDateYYMMDD();
}

thumbSizeSlider.addEventListener("input", () => {
  const w = thumbSizeSlider.value;
  document.documentElement.style.setProperty("--split-thumb-width", `${w}px`);
  thumbSizeDisplay.textContent = `${w}px`;
});

datePrefixToggle.addEventListener("change", () => {
  const date = getDateYYMMDD();
  const on = datePrefixToggle.checked;
  // Update both the live <input> values and the splitState backing map
  // so a subsequent rebuild keeps the prefix.
  const inputs = splitFlow.querySelectorAll(".split-section-name");
  inputs.forEach((input, idx) => {
    if (on) {
      if (!input.value.startsWith(date)) {
        input.value = date + input.value;
      }
    } else {
      // Strip a leading 6-digit run if it matches today's date, OR if
      // it's any 6-digit prefix the toggle previously added.
      input.value = input.value.replace(/^\d{6}/, "");
    }
    splitState.partNames.set(idx, input.value);
  });
});

/** @type {Set<number>} 0-based page indices: split AFTER index i */
export const splitState = {
  splitAfter: new Set(),
  /** @type {Map<number, string>} part index → user-supplied name */
  partNames: new Map(),
  /** @type {Map<number, HTMLCanvasElement>} pageNo → cached thumbnail canvas */
  thumbCache: new Map(),
};

function computeParts(totalPages, splitAfter) {
  const sortedPoints = [...splitAfter].sort((a, b) => a - b);
  const parts = [];
  let start = 0;
  for (const sp of sortedPoints) {
    parts.push({ start, end: sp });
    start = sp + 1;
  }
  parts.push({ start, end: totalPages - 1 });
  return parts;
}

/**
 * Default value for a part-name input. Empty by user request — the
 * placeholder hints at "name your part". When the date-prefix toggle is
 * on, new sections inherit today's date as their starting value so the
 * UX matches "everything gets the prefix when toggle is on".
 */
function defaultPartName() {
  return datePrefixToggle?.checked ? getDateYYMMDD() : "";
}

async function generateAllThumbnails(pages, onProgress, onThumbReady) {
  // β.123: 並列度 3 のワーカープール + 表示中ページ優先キュー + 1 枚
  // できるごとに onThumbReady を呼ぶプログレッシブ経路に拡張。
  // - onProgress({done,total}): 進捗カウンタ更新用 (任意)
  // - onThumbReady(pageNo, canvas): 1 枚完成ごとに呼ぶ (任意)。
  //   呼び側は placeholder → canvas のスワップ等に使う。
  // 呼び側が `splitState.thumbPriorityBump(pageNo)` を呼ぶと、
  // 該当ジョブが優先キュー側に昇格 (viewport 内のページを先に処理)。
  // isSplitMode が false に落ちたら全ワーカーが次の周回で終了 — split
  // を抜けたあとも mupdf を回し続けないためのキャンセル経路。
  const todo = [];
  for (const row of pages) {
    if (splitState.thumbCache.has(row.pageNo)) {
      // 既キャッシュは即スワップ (再表示経路では placeholder が並んで
      // いるので、これで再開時のチラつきが消える)。
      if (onThumbReady) {
        onThumbReady(row.pageNo, splitState.thumbCache.get(row.pageNo));
      }
      continue;
    }
    todo.push({ pageNo: row.pageNo, row, prio: 0 });
  }
  const total = pages.length;
  let done = total - todo.length;
  if (onProgress) onProgress({ done, total });

  splitState.thumbPriorityBump = (pageNo) => {
    const idx = todo.findIndex((j) => j.pageNo === pageNo && j.prio === 0);
    if (idx >= 0) todo[idx].prio = 1;
  };

  const takeNext = () => {
    const pi = todo.findIndex((j) => j.prio === 1);
    if (pi >= 0) return todo.splice(pi, 1)[0];
    return todo.shift() ?? null;
  };

  const CONCURRENCY = 3;
  const worker = async () => {
    while (true) {
      if (!isSplitMode) return;
      const job = takeNext();
      if (!job) return;
      try {
        let result;
        if (job.row.isSynthetic || job.pageNo < 0) {
          result = await renderSyntheticPagePixels(job.row, 0.25);
        } else {
          result = await kpdf3.renderPage(job.pageNo, { zoom: 0.25 });
        }
        // compositePage handles userRotation + overlays so the split-save
        // thumb matches what the page actually looks like (stamps / marks
        // visible, rotated pages displayed in their rotated orientation).
        const canvas = await compositePage(job.row, result, _projectStore(), 0.25);
        splitState.thumbCache.set(job.pageNo, canvas);
        if (onThumbReady) onThumbReady(job.pageNo, canvas);
      } catch (err) {
        console.error(`[split] thumb ${job.pageNo} failed:`, err);
      }
      done++;
      if (onProgress) onProgress({ done, total });
    }
  };

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
}

/** β.123: できた順に placeholder を canvas に差し替える。
 * createThumbElement が最初に描いた最初の子要素 (placeholder DIV または
 * 既存 CANVAS) を新しい canvas にスワップ。サムネ要素自体は維持するので
 * クリック・D&D・コンテキストメニュー等の handler はそのまま残る。 */
function swapThumbCanvas(pageNo, sourceCanvas) {
  const thumbEl = splitFlow.querySelector(
    `.split-thumb[data-page-no="${pageNo}"]`,
  );
  if (!thumbEl) return;
  const first = thumbEl.firstElementChild;
  if (!first || (first.tagName !== "DIV" && first.tagName !== "CANVAS")) return;
  const c = document.createElement("canvas");
  c.width = sourceCanvas.width;
  c.height = sourceCanvas.height;
  c.getContext("2d").drawImage(sourceCanvas, 0, 0);
  first.replaceWith(c);
}

function rebuildSplitUI(pages) {
  splitFlow.innerHTML = "";
  const parts = computeParts(pages.length, splitState.splitAfter);

  parts.forEach((part, partIdx) => {
    const section = document.createElement("div");
    section.className = "split-section";

    const header = document.createElement("div");
    header.className = "split-section-header";
    const label = document.createElement("label");
    label.textContent = `パート ${partIdx + 1}:`;
    header.appendChild(label);
    const nameInput = document.createElement("input");
    nameInput.className = "split-section-name";
    nameInput.placeholder = `(パート ${partIdx + 1} の名前)`;
    nameInput.value =
      splitState.partNames.get(partIdx) ?? defaultPartName();
    nameInput.addEventListener("input", () => {
      splitState.partNames.set(partIdx, nameInput.value);
    });
    header.appendChild(nameInput);
    const meta = document.createElement("span");
    meta.className = "split-section-meta";
    meta.textContent = `(p.${part.start + 1}–${part.end + 1}, ${
      part.end - part.start + 1
    } ページ)`;
    header.appendChild(meta);
    section.appendChild(header);

    const row = document.createElement("div");
    row.className = "split-thumbs-row";
    // Leading insert gap (always present). Anchored to the nearest
    // preceding source page (for legacy afterPageNo slot semantics) and
    // to the page immediately before the gap (for the β77 visual-
    // position display_order computation).
    {
      let anchor = 0;
      for (let k = part.start - 1; k >= 0; k--) {
        if (!pages[k].isSynthetic) {
          anchor = pages[k].pageNo;
          break;
        }
      }
      const afterKey =
        part.start === 0 ? 0 : pages[part.start - 1].pageNo;
      row.appendChild(makeSplitInsertGap(anchor, null, afterKey));
    }
    for (let i = part.start; i <= part.end; i++) {
      // Visual position passed in 1-indexed across the WHOLE document
      // so split-save labels match the sidebar / page-indicator
      // numbering even when the part doesn't start at page 1.
      // Glue each thumbnail and its trailing +gap into one indivisible
      // cell. flex-wrap can break BETWEEN cells but never inside, so
      // a thumb never gets stranded with its + gap on the next row.
      // (Without this the user reported "２行目以降の左側に＋が来る".)
      const cell = document.createElement("div");
      cell.className = "split-thumb-cell";
      const thumb = createThumbElement(pages[i], i + 1);
      cell.appendChild(thumb);
      let anchor;
      let orderInSlot = null;
      if (pages[i].isSynthetic) {
        anchor = pages[i].syntheticAfterPageNo ?? 0;
        orderInSlot = (pages[i].syntheticOrderInSlot ?? 0) + 1;
      } else {
        anchor = pages[i].pageNo;
      }
      // β77: afterKey = the page right before this gap (positive for
      // source, negative for synth). Drives the visual-position
      // display_order so the drop lands exactly between pages[i] and
      // pages[i+1] regardless of reorder state.
      cell.appendChild(
        makeSplitInsertGap(anchor, orderInSlot, pages[i].pageNo),
      );
      row.appendChild(cell);
      if (i < part.end) {
        // Inner separator — click to split here.
        const sep = document.createElement("div");
        sep.className = "split-inner-sep";
        sep.title = `ここで分割（${i + 1} と ${i + 2} の間）`;
        sep.addEventListener("click", () => {
          splitState.splitAfter.add(i);
          // Reset partNames to defaults when topology changes (simpler than
          // shifting indices).
          splitState.partNames.clear();
          rebuildSplitUI(pages);
        });
        row.appendChild(sep);
      }
    }
    section.appendChild(row);

    if (partIdx < parts.length - 1) {
      // Active split mark between this part and the next — click to merge.
      const mark = document.createElement("div");
      mark.className = "split-active-mark";
      mark.textContent = `— ▼ 分割中（クリックで結合） ▼ —`;
      mark.addEventListener("click", () => {
        splitState.splitAfter.delete(part.end);
        splitState.partNames.clear();
        rebuildSplitUI(pages);
      });
      section.appendChild(mark);
    }

    splitFlow.appendChild(section);
  });
}

function createThumbElement(pageRow, visualPos) {
  const wrap = document.createElement("div");
  wrap.className = "split-thumb";
  wrap.dataset.pageNo = String(pageRow.pageNo);
  wrap.tabIndex = 0;
  const cached = splitState.thumbCache.get(pageRow.pageNo);
  if (cached) {
    const c = document.createElement("canvas");
    c.width = cached.width;
    c.height = cached.height;
    c.getContext("2d").drawImage(cached, 0, 0);
    wrap.appendChild(c);
  } else {
    const placeholder = document.createElement("div");
    placeholder.style.width = "80px";
    placeholder.style.height = "100px";
    placeholder.style.background = "#eee";
    placeholder.style.display = "flex";
    placeholder.style.alignItems = "center";
    placeholder.style.justifyContent = "center";
    placeholder.textContent = typeof visualPos === "number" && visualPos > 0
      ? String(visualPos)
      : String(pageRow.pageNo);
    wrap.appendChild(placeholder);
  }
  const lbl = document.createElement("span");
  lbl.className = "split-thumb-label";
  // Visual page number (1-indexed across the whole document) so it
  // matches the sidebar thumbs + bottom indicator. Synthetic rows
  // get a leading ✎ marker so they're still distinguishable.
  const labelNum = typeof visualPos === "number" && visualPos > 0
    ? String(visualPos)
    : String(pageRow.pageNo);
  lbl.textContent = pageRow.isSynthetic ? `✎ ${labelNum}` : labelNum;
  wrap.appendChild(lbl);
  // Paper-size badge for non-A4 sources (A3/A5/B4/B5/Letter/Legal) —
  // sidebar サムネと同じ規則。分割画面でも混在 PDF を一目で見分けたい。
  const _spCw = pageRow.cropW ?? pageRow.width ?? 595;
  const _spCh = pageRow.cropH ?? pageRow.height ?? 842;
  const _spSizeName = detectPaperSize(_spCw, _spCh);
  if (_spSizeName && _spSizeName !== "A4") {
    const badge = document.createElement("span");
    badge.className = "thumb-size-badge";
    badge.textContent = _spSizeName;
    wrap.appendChild(badge);
  }
  wrap.addEventListener("click", (e) => {
    const ordered = getOrderedThumbPageNos(splitFlow, ".split-thumb[data-page-no]");
    handleThumbSelectionClick(splitThumbSelection, ordered, pageRow.pageNo, e);
    wrap.focus();
  });
  // β15 testers wanted a fast way back to the main viewer from a
  // page they had been examining in the split flow. Double-click
  // closes the split view and scrolls the main viewer to the
  // double-clicked page (mirrors how a sidebar thumb click already
  // scrolls there).
  wrap.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setSplitMode(false);
    if (typeof pageRow.pageNo === "number") {
      viewer.scrollToPage(pageRow.pageNo);
    }
  });
  attachThumbContextMenu(wrap, pageRow.pageNo);
  // Same D&D handler as the sidebar thumbs — a single mechanism for
  // page reordering means split-save view picks up the same display_
  // order machinery, including synthetic-page support.
  attachThumbDragHandlers(wrap, pageRow.pageNo);
  return wrap;
}

let isSplitMode = false;

export function isSplitModeActive() {
  return isSplitMode;
}

export function setSplitMode(on) {
  isSplitMode = !!on;
  mainArea.classList.toggle("split-mode", isSplitMode);
  splitView.hidden = !isSplitMode;
  btnSplit.classList.toggle("toggled", isSplitMode);
  // 分割画面を閉じたら、そこで選択していたページの集合も破棄する。
  // 残しておくと、次に印刷ボタンを押した時に actionPrint の split>0
  // 経路が走って範囲欄に偽の preselect が入る (β53 ユーザ報告)。
  if (!isSplitMode && splitThumbSelection.pageNos.size > 0) {
    splitThumbSelection.pageNos.clear();
    splitThumbSelection.anchor = null;
    refreshThumbSelectionVisuals();
  }
}

export async function actionSplitSave() {
  if (!_isOpen()) return;
  if (isSplitMode) {
    // Toggle off — back to viewer
    setSplitMode(false);
    return;
  }
  const pages = await _fetchVisiblePages();
  if (pages.length === 0) return;

  // Reset state for a fresh split session
  splitState.splitAfter = new Set();
  splitState.partNames = new Map();
  // thumbCache is preserved across sessions (per workspace open)

  // β.123: 即時レイアウト経路。
  // 旧経路は「全ページのサムネ生成 → rebuildSplitUI」の順だったので、
  // 大量ページだとカウンタしか見えず体感的に重かった。新経路では先に
  // rebuildSplitUI を呼んで placeholder で全体のレイアウト (パート
  // 区切り・名前入力・サイズバッジ) を起動直後に出し、サムネは並列 3
  // で順次生成して swapThumbCanvas で差し込む。さらに IntersectionObserver
  // で表示中の thumb を優先キューに昇格させ、見ているところから先に
  // 揃うようにする (スクロール先のサムネもスクロールに追従して昇格)。
  splitFlow.innerHTML = "";
  setSplitMode(true);
  refreshDatePrefixPreview();
  rebuildSplitUI(pages);

  const progressNode = document.createElement("div");
  progressNode.className = "split-progress";
  progressNode.textContent = `サムネイルを準備中... 0 / ${pages.length}`;
  splitFlow.insertBefore(progressNode, splitFlow.firstChild);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const ent of entries) {
        if (!ent.isIntersecting) continue;
        const pn = Number(ent.target.dataset.pageNo);
        if (Number.isFinite(pn) && splitState.thumbPriorityBump) {
          splitState.thumbPriorityBump(pn);
        }
      }
    },
    { root: splitFlow, rootMargin: "200px 0px", threshold: 0.01 },
  );
  for (const el of splitFlow.querySelectorAll(".split-thumb[data-page-no]")) {
    observer.observe(el);
  }

  await generateAllThumbnails(
    pages,
    ({ done, total }) => {
      if (done >= total) {
        progressNode.remove();
      } else {
        progressNode.textContent = `サムネイルを準備中... ${done} / ${total}`;
      }
    },
    (pageNo, canvas) => swapThumbCanvas(pageNo, canvas),
  );

  observer.disconnect();
}

splitCancelBtn.addEventListener("click", () => setSplitMode(false));

splitConfirmBtn.addEventListener("click", async () => {
  const pages = await _fetchVisiblePages();
  const parts = computeParts(pages.length, splitState.splitAfter);
  const defaults = await kpdf3.getExportDefaults();
  const choice = await showFileBrowser({
    mode: "folder",
    title: "分割した PDF を保存するフォルダ",
    defaultDir: defaults.sourceDir,
    monoExportToggle: true,
  });
  if (!choice) return;
  // β.110: monoExportToggle ON のとき choice は object 化されている
  // (folder path + monoExport)。folder picker は他の呼出側 (例: 一般の
  // フォルダ選択) でも使われるので string fallback も維持。
  const folder = typeof choice === "string" ? choice : choice.path;
  const monoExport = typeof choice === "string" ? false : !!choice.monoExport;

  setSplitMode(false);
  showBusy("分割保存", `0 / ${parts.length} パート`, 0);
  try {
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      const rawName = (splitState.partNames.get(p) ?? "").trim();
      const safeName =
        rawName.replace(/[/\\:*?"<>|]/g, "_") || `part${p + 1}`;
      const savePath = `${folder}/${safeName}.pdf`;

      updateBusy(
        `${p + 1} / ${parts.length} パート — ページを描画中...`,
        (p / parts.length) * 100,
      );
      const filteredPages = pages.slice(part.start, part.end + 1);
      const composed = await composePagesForExport({
        pages: filteredPages,
        projectStore: _projectStore(),
        renderPage: kpdf3.renderPage,
        renderSyntheticPage: renderSyntheticPagePixels,
        rasterRedactionPages: true,
        monoOverlays: monoExport,
        vectorTextProbe: kpdf3.vectorTextProbe, // v2.0.13 ベクターテキスト層
        onProgress: ({ done, total }) => {
          const partProgress = done / total;
          updateBusy(
            `${p + 1} / ${parts.length} パート — ${done} / ${total} ページ`,
            ((p + partProgress) / parts.length) * 100,
          );
        },
      });
      await kpdf3.exportPdfRasterized({ savePath, pages: composed });
    }
    hideBusy();
    wsStatus.textContent = `分割保存完了: ${parts.length} パート → ${folder}`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] split-save failed:", err);
    wsStatus.textContent = `分割保存失敗: ${err.message ?? err}`;
  }
});

btnSplit.addEventListener("click", actionSplitSave);

/** Refresh the split-save panel after a workspace-level page change
 *  (insert/delete). Regenerates thumbnails for any new pages and rebuilds
 *  the row layout. Called only while split mode is active. */
export async function refreshSplitView() {
  const pages = await _fetchVisiblePages();
  if (pages.length === 0) return;
  // Drop cache entries for pages that no longer exist (e.g. deleted)
  const livePageNos = new Set(pages.map((p) => p.pageNo));
  for (const cachedPageNo of [...splitState.thumbCache.keys()]) {
    if (!livePageNos.has(cachedPageNo)) {
      splitState.thumbCache.delete(cachedPageNo);
    }
  }
  // β.123: 即時 rebuild → 順次サムネ差し込み (actionSplitSave と同じ
  // プログレッシブ経路)。新規追加ページは placeholder で先に並び、
  // 完成し次第 swapThumbCanvas でその場に canvas が入る。
  rebuildSplitUI(pages);
  await generateAllThumbnails(
    pages,
    null,
    (pageNo, canvas) => swapThumbCanvas(pageNo, canvas),
  );
}
