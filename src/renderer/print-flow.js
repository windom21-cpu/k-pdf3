// Print preview dialog (Adobe simplified) + actionPrint pipeline.
//
// Owns the print dialog (printer / engine select, copies, range,
// orientation, sizing, preview canvas with prev/next), the
// プロパティ button → DocumentPropertiesW round-trip that captures
// driver-side DEVMODE choices (duplex / tray / color), the
// 「印刷エンジン」 cache + localStorage round-trip (β70), and
// actionPrint — the click handler wired to the toolbar 印刷 button
// and the File menu item.
//
// The print dialog flow itself is internal: showPrintDialog returns a
// Promise that actionPrint awaits. Range / size / orientation changes
// re-render the preview via composeSinglePageCanvas. preselected page
// sets (split-view multi-selection or 2+ sidebar selection) seed the
// custom-range input so the user doesn't retype.
//
// External state reached via getter callbacks (init): projectStore,
// isOpen, splitThumbSelection, sidebarThumbSelection, isSplitMode.
// viewer / wsStatus / fetchVisiblePages are stable refs / fns passed once.

import { composePagesForExport, composeSinglePageCanvas } from "./exporter.js";
import { renderSyntheticPagePixels } from "./viewer.js";
import { showBusy, updateBusy, hideBusy, setBusyCancel } from "./busy-modal.js";
import { customConfirm } from "./dialogs.js";

const { kpdf3 } = window;
const $ = (id) => document.getElementById(id);

let _projectStore = () => null;
let _viewer = null;
let _wsStatus = null;
let _isOpen = () => false;
let _splitThumbSelection = () => ({ pageNos: new Set() });
let _sidebarThumbSelection = () => ({ pageNos: new Set() });
let _isSplitMode = () => false;
let _fetchVisiblePages = async () => [];
// Phase 1: 白黒印刷モード getter。ツールバートグルの状態を読み取り、
// composePagesForExport に monoOverlays として渡す。書き出し経路では
// 使わない (印刷のみ適用、Phase 1 スコープ)。
let _isMonoPrintMode = () => false;

export function initPrintFlow({
  projectStore,
  viewer,
  wsStatus,
  isOpen,
  splitThumbSelection,
  sidebarThumbSelection,
  isSplitMode,
  fetchVisiblePages,
  isMonoPrintMode,
}) {
  _projectStore = projectStore;
  _viewer = viewer;
  _wsStatus = wsStatus;
  _isOpen = isOpen;
  _splitThumbSelection = splitThumbSelection;
  _sidebarThumbSelection = sidebarThumbSelection;
  _isSplitMode = isSplitMode;
  _fetchVisiblePages = fetchVisiblePages;
  if (typeof isMonoPrintMode === "function") _isMonoPrintMode = isMonoPrintMode;
}

const printDialog = $("print-dialog");
const printPrinterSelect = $("print-printer");
const printEngineSelect = $("print-engine");

// β70: 印刷エンジン候補を IPC で取得し select を populate する。
// localStorage で前回選択値を覚える。ダイアログ初回表示時に 1 回だけ
// 走らせ、以降は cache を再利用 (起動毎に再フェッチでも構わない軽量
// 処理だが、毎ダイアログ表示で IPC を打つ必要は無い)。
let _printEngineCache = null;
async function ensurePrintEnginesPopulated() {
  if (_printEngineCache) return;
  try {
    const engines = await kpdf3.listPrintEngines();
    _printEngineCache = Array.isArray(engines) ? engines : [];
  } catch (err) {
    console.warn("[print] listPrintEngines failed:", err);
    _printEngineCache = [];
  }
  printEngineSelect.innerHTML = "";
  for (const e of _printEngineCache) {
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = e.displayName + (e.recommended ? " (推奨)" : "");
    printEngineSelect.appendChild(opt);
  }
  // 永続化された選択を復元、なければ recommended
  let saved = null;
  try { saved = localStorage.getItem("kpdf3.printEngine"); }
  catch { /* private mode etc — ignore */ }
  const validSaved = saved && _printEngineCache.some((e) => e.id === saved);
  if (validSaved) {
    printEngineSelect.value = saved;
  } else if (_printEngineCache.length > 0) {
    printEngineSelect.value = _printEngineCache[0].id;
  }
}
printEngineSelect?.addEventListener("change", () => {
  try { localStorage.setItem("kpdf3.printEngine", printEngineSelect.value); }
  catch { /* ignore */ }
});

const printPropertiesBtn = $("print-properties");
const printCopiesInput = $("print-copies");
const printRangeAll = $("print-range-all");
const printRangeCurrent = $("print-range-current");
const printRangeCustom = $("print-range-custom");
const printRangeInput = $("print-range-input");
const printSizeActual = $("print-size-actual");
const printSizeFit = $("print-size-fit");
const printOrientPortrait = $("print-orient-portrait");
const printOrientLandscape = $("print-orient-landscape");
const printPreviewCanvas = $("print-preview-canvas");
const printPreviewCounter = $("print-preview-counter");
const printPreviewPrev = $("print-preview-prev");
const printPreviewNext = $("print-preview-next");
const printConfirmBtn = $("print-confirm");
const printCancelBtn = $("print-cancel");
const printTitlebarCloseBtn = $("print-titlebar-close");

const PREVIEW_ZOOM = 0.6; // matches a comfortable preview tile size
const printState = {
  pages: [],          // pages array from kpdf3.getPages()
  printers: [],
  resolve: null,      // Promise resolver
  previewIndex: 0,    // 0-based index into the *visible* page list
  visiblePageNos: [], // page numbers selected by current range
  renderToken: 0,     // monotonic — bail outdated renders
  // β46 J3: latest DEVMODE extras captured from the driver properties
  // dialog (DocumentPropertiesW). Plumbed through to Sumatra so tray /
  // duplex / color the user picked actually take effect. Reset when
  // the user opens the print dialog so a previous session's choices
  // don't leak; the user reopens プロパティ to set them again.
  driverDuplex: null,  // "simplex" | "long-edge" | "short-edge" | null
  driverBin: null,     // numeric tray id (dmDefaultSource) | null
  driverColor: null,   // "mono" | "color" | null
};

/**
 * Compress a list of positive integers (1-indexed visual positions) into
 * the shortest "1-3, 5, 8-10" style range string accepted by the print
 * dialog's custom-range input. Returns "" for empty/invalid input.
 */
function compressPageList(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return "";
  const sorted = [...new Set(positions)]
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const ranges = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(", ");
}

function showPrintDialog(printers, pages, currentPageNo, preselected = null) {
  printState.pages = pages;
  printState.printers = printers;
  // β46 J3: clear stale driver DEVMODE picks so they don't leak from
  // a previous print session. The user re-opens プロパティ to set them.
  printState.driverDuplex = null;
  printState.driverBin = null;
  printState.driverColor = null;

  // β70: 印刷エンジン select を populate (初回 IPC で取得)。
  ensurePrintEnginesPopulated();

  // Populate printer select
  printPrinterSelect.innerHTML = "";
  if (printers.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(プリンタが見つかりません)";
    printPrinterSelect.appendChild(opt);
    printConfirmBtn.disabled = true;
    printPropertiesBtn.disabled = true;
  } else {
    printConfirmBtn.disabled = false;
    printPropertiesBtn.disabled = false;
    // Remember the printer the user picked last time (localStorage).
    // Falls back to the OS default when no remembered choice exists
    // or the remembered printer is no longer connected. β15 testers
    // asked for "最後に選んだプリンタを覚えておいてほしい".
    let remembered = null;
    try { remembered = localStorage.getItem("kpdf3.lastPrinter"); }
    catch { /* private mode etc. — ignore */ }
    const rememberedExists = remembered
      && printers.some((p) => p.name === remembered);
    for (const p of printers) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.displayName ?? p.name;
      const matchRemembered = rememberedExists && p.name === remembered;
      const matchDefault = !rememberedExists && p.isDefault;
      if (matchRemembered || matchDefault) opt.selected = true;
      printPrinterSelect.appendChild(opt);
    }
  }

  printCopiesInput.value = "1";
  printSizeActual.checked = true;
  printOrientPortrait.checked = true;

  // When the caller hands in a pre-selected page set (e.g. split-view
  // multi-selection at 印刷 time), seed the custom-range input with
  // those pages and switch to "カスタム" so the user doesn't have to
  // retype the selection. Otherwise default to "すべて".
  //
  // preselected is in pageNo space (positive for source pages, negative
  // for inserted/synthetic pages). The range input shows 1-indexed
  // visual positions, so translate each pageNo to its position in the
  // current visible `pages` array. Pages whose pageNo isn't found are
  // silently dropped (workspace edits since selection time could have
  // removed them).
  const pageNoToPos = new Map(pages.map((p, i) => [p.pageNo, i + 1]));
  const positions = Array.isArray(preselected)
    ? preselected.map((pn) => pageNoToPos.get(pn)).filter((p) => p != null)
    : [];
  const compressed = compressPageList(positions);
  if (compressed) {
    printRangeCustom.checked = true;
    printRangeInput.value = compressed;
  } else {
    printRangeAll.checked = true;
    printRangeInput.value = `1-${pages.length}`;
  }

  // Initial preview = current page (or 1)
  recomputeVisiblePages();
  const idx = printState.visiblePageNos.indexOf(currentPageNo);
  printState.previewIndex = idx >= 0 ? idx : 0;
  refreshPreview();

  printDialog.hidden = false;
  return new Promise((resolve) => {
    printState.resolve = resolve;
  });
}

function recomputeVisiblePages() {
  const total = printState.pages.length;
  if (printRangeCurrent.checked) {
    const cur = _viewer.currentPage || 1;
    printState.visiblePageNos = [cur];
  } else if (printRangeCustom.checked) {
    // parsePageList returns 1-indexed visual positions; translate to the
    // underlying pageNo values so downstream code (preview lookup,
    // filteredPages filter in actionPrint) can match against p.pageNo
    // uniformly. Without this translation, workspaces with inserted
    // (synthetic, negative pageNo) pages or reordered pages would
    // silently lose pages from the print job because p.pageNo wouldn't
    // equal its visual position.
    const parsed = parsePageList(printRangeInput.value, total);
    printState.visiblePageNos = parsed
      .map((pos) => printState.pages[pos - 1]?.pageNo)
      .filter((n) => n !== undefined && n !== null);
  } else {
    printState.visiblePageNos = printState.pages.map((p) => p.pageNo);
  }
  if (printState.previewIndex >= printState.visiblePageNos.length) {
    printState.previewIndex = Math.max(0, printState.visiblePageNos.length - 1);
  }
}

/**
 * Parse "1-3, 5, 7-10" into a sorted unique array of page numbers.
 */
function parsePageList(input, total) {
  const out = new Set();
  for (const part of String(input).split(",")) {
    const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) continue;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 1 || end > total || start > end) continue;
    for (let i = start; i <= end; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

async function refreshPreview() {
  const visible = printState.visiblePageNos;
  if (visible.length === 0) {
    printPreviewCounter.textContent = "— / —";
    const ctx = printPreviewCanvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, printPreviewCanvas.width, printPreviewCanvas.height);
    printPreviewPrev.disabled = true;
    printPreviewNext.disabled = true;
    return;
  }
  const pageNo = visible[printState.previewIndex];
  printPreviewCounter.textContent = `${printState.previewIndex + 1} / ${visible.length}（p.${pageNo}）`;
  printPreviewPrev.disabled = printState.previewIndex <= 0;
  printPreviewNext.disabled = printState.previewIndex >= visible.length - 1;

  const pageRow = printState.pages.find((p) => p.pageNo === pageNo);
  if (!pageRow) return;

  const myToken = ++printState.renderToken;
  try {
    const sourceCanvas = await composeSinglePageCanvas(
      pageRow,
      kpdf3.renderPage,
      _projectStore(),
      PREVIEW_ZOOM,
      renderSyntheticPagePixels,
    );
    if (myToken !== printState.renderToken) return; // stale
    // Apply orientation: rotate canvas if landscape selected
    const landscape = printOrientLandscape.checked;
    const dest = printPreviewCanvas;
    if (landscape) {
      dest.width = sourceCanvas.height;
      dest.height = sourceCanvas.width;
      const ctx = dest.getContext("2d");
      ctx.save();
      ctx.translate(dest.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(sourceCanvas, 0, 0);
      ctx.restore();
    } else {
      dest.width = sourceCanvas.width;
      dest.height = sourceCanvas.height;
      const ctx = dest.getContext("2d");
      ctx.drawImage(sourceCanvas, 0, 0);
    }
  } catch (err) {
    console.error("[print-preview] render failed", err);
  }
}

function settlePrintDialog(value) {
  printDialog.hidden = true;
  if (printState.resolve) {
    const r = printState.resolve;
    printState.resolve = null;
    r(value);
  }
}

printConfirmBtn.addEventListener("click", () => {
  const range = currentPrintRange();
  if (!range || range.length === 0) {
    _wsStatus.textContent = "印刷範囲が無効です";
    return;
  }
  const deviceName = printPrinterSelect.value;
  // Persist the picked printer so the next print dialog opens with
  // it pre-selected. localStorage is renderer-local; if it throws
  // (private mode / quota), the print still proceeds.
  if (deviceName) {
    try { localStorage.setItem("kpdf3.lastPrinter", deviceName); }
    catch { /* ignore */ }
  }
  settlePrintDialog({
    deviceName,
    copies: Math.max(1, Number(printCopiesInput.value) || 1),
    pageNos: range,
    sizing: printSizeFit.checked ? "fit" : "actual",
    landscape: printOrientLandscape.checked,
  });
});
printCancelBtn.addEventListener("click", () => settlePrintDialog(null));
printTitlebarCloseBtn.addEventListener("click", () => settlePrintDialog(null));
printDialog.addEventListener("click", (e) => {
  if (e.target === printDialog) settlePrintDialog(null);
});

function currentPrintRange() {
  recomputeVisiblePages();
  return printState.visiblePageNos;
}

// Wire range / size / orientation changes to refresh the preview
for (const el of [printRangeAll, printRangeCurrent, printRangeCustom]) {
  el.addEventListener("change", () => {
    recomputeVisiblePages();
    refreshPreview();
  });
}
printRangeInput.addEventListener("input", () => {
  printRangeCustom.checked = true;
  recomputeVisiblePages();
  refreshPreview();
});
for (const el of [printOrientPortrait, printOrientLandscape, printSizeFit, printSizeActual]) {
  el.addEventListener("change", refreshPreview);
}

printPreviewPrev.addEventListener("click", () => {
  if (printState.previewIndex > 0) {
    printState.previewIndex--;
    refreshPreview();
  }
});
printPreviewNext.addEventListener("click", () => {
  if (printState.previewIndex < printState.visiblePageNos.length - 1) {
    printState.previewIndex++;
    refreshPreview();
  }
});

printPropertiesBtn.addEventListener("click", async () => {
  const name = printPrinterSelect.value;
  if (!name) return;
  const r = await kpdf3.printerProperties(name);
  if (r && r.ok === false) {
    _wsStatus.textContent = `プロパティ表示失敗: ${r.error ?? "unknown"}`;
    return;
  }
  // The DocumentPropertiesW DEVMODE that the user modified in the
  // driver dialog is read back in main and returned here. Propagate
  // copies / orientation to the print dialog inputs so the next
  // 「印刷」 actually uses those values — β15 testers reported that
  // changing "枚数=5" in the driver dialog had no effect because the
  // renderer dialog still held copies=1 (the default).
  if (r && !r.cancelled) {
    if (typeof r.copies === "number" && r.copies > 0) {
      printCopiesInput.value = String(r.copies);
    }
    if (typeof r.landscape === "boolean") {
      if (r.landscape) printOrientLandscape.checked = true;
      else printOrientPortrait.checked = true;
      refreshPreview();
    }
    // β46 J3: capture duplex / tray / color from the driver DEVMODE
    // and stash on printState. Forwarded to main in actionPrint so
    // Sumatra's -print-settings reflects what the user picked.
    printState.driverDuplex = typeof r.duplex === "string" ? r.duplex : null;
    printState.driverBin = Number.isInteger(r.bin) && r.bin > 0 ? r.bin : null;
    printState.driverColor = typeof r.color === "string" ? r.color : null;
  }
});

/**
 * β72 (案 D): PDF Reader (Adobe / Foxit / PDF-XChange) が検出された場合の
 * 印刷経路。K-PDF3 自前ダイアログを skip して直接 Reader の印刷ダイアログ
 * を開く。プリンタ・部数・FAX 送信先などはユーザが Reader 側で設定する。
 *
 * 範囲はサイドバー / split-view 選択をそのまま filteredPages に反映して
 * temp PDF を生成 → Reader はその PDF を「全ページ」のつもりで開く。
 */
async function actionPrintViaReader(pages, preselected, preselectedSource, opts = {}) {
  // Phase 2: FAX 送信ボタンの「Adobe 経由」 escape hatch から呼ばれた
  // ときは forceMono=true で monoOverlays を強制 ON にする。通常の印刷
  // ボタン経路はトグルの状態に従う。
  const forceMono = !!opts.forceMono;
  const labelPrefix = opts.labelPrefix ?? "印刷";
  const filteredPages = preselected
    ? pages.filter((p) => preselected.includes(p.pageNo))
    : pages;
  if (filteredPages.length === 0) {
    _wsStatus.textContent = `${labelPrefix}対象ページがありません`;
    return;
  }
  const projectStore = _projectStore();
  const overlayCount = projectStore.count();
  const allPagesSelected = filteredPages.length === pages.length;
  // FAX 経路では byte-copy は使わない (mono 化のため必ず再合成が必要)
  const isCopy = !forceMono && overlayCount === 0 && allPagesSelected;

  // β.118: 中止ボタンを表示する (旧コメント: 「Adobe ダイアログを × で
  // 閉じれば中止」だったが、Adobe が hand-off で固まる / 印刷ダイアログが
  // 出ない事象が報告された。ユーザーが busy modal から逃げ出せるよう
  // cancelPrint で Adobe launcher を kill して resolve させる)。
  showBusy(`${labelPrefix}準備`, "ページを描画中...", 0, {
    onCancel: () => {
      try { kpdf3.cancelPrint?.(); } catch { /* ignore */ }
      hideBusy();
      _wsStatus.textContent = "印刷を中止しました";
    },
  });
  let composed = null;
  try {
    if (!isCopy) {
      composed = await composePagesForExport({
        pages: filteredPages,
        projectStore,
        renderPage: kpdf3.renderPage,
        renderSyntheticPage: renderSyntheticPagePixels,
        rasterRedactionPages: true,
        // Phase 1: 白黒印刷モードが ON のとき overlay の色を黒に projection
        // する (マーカーは除外)。Adobe `/p` 経路でも事前 raster に焼き込ま
        // れた overlay は黒になるので、ドライバ側の color → gray 変換に
        // 頼らずカラー印影が薄くなる事故を回避できる。
        // Phase 2: forceMono=true (FAX 経路) ではトグル状態に関わらず ON。
        monoOverlays: forceMono || _isMonoPrintMode(),
        onProgress: ({ done, total }) => {
          updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
        },
      });
    }
    updateBusy("PDF Reader を起動しています...", 90);
    const result = await kpdf3.printViaReaderDialog({
      source: isCopy ? "byte-copy" : "rasterized",
      pages: composed,
    });
    hideBusy();
    const summary = preselectedSource
      ? `${filteredPages.length} ページ (${preselectedSource === "split" ? "分割画面選択" : "サイドバー選択"})`
      : `${filteredPages.length} ページ`;
    const reasonText =
      result.reason === "job-detected" ? "印刷ジョブ投入を検出"
      : result.reason === "reader-closed" ? "Reader を終了"
      : result.reason === "timeout" ? "タイムアウト"
      : "完了";
    _wsStatus.textContent = `${labelPrefix}経路: ${result.engine} (${reasonText}) — ${summary}`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] print failed:", err);
    _wsStatus.textContent = `${labelPrefix}失敗: ${err.message ?? err}`;
  }
}

export async function actionPrint() {
  if (!_isOpen()) return;
  const pages = await _fetchVisiblePages();
  if (pages.length === 0) return;

  // Split-view or sidebar selection seeds the print range so the user
  // doesn't have to retype it. Mirrors the same pattern used by rotate
  // (see resolveRotationTargets) and the sidebar's right-click
  // 「選択した N ページを PDF として保存」 path.
  //
  // Selection precedence:
  //   1. split-view selection (any size, explicit batch intent)
  //   2. sidebar selection of 2+ pages — single-page sidebar selection
  //      is often a navigation side-effect (clicking a thumb both
  //      selects AND scrolls), so we ignore size===1 to avoid surprising
  //      the user with "今見ているページだけを印刷" when they wanted all.
  let preselected = null;
  let preselectedSource = null;
  const splitSel = _splitThumbSelection();
  const sidebarSel = _sidebarThumbSelection();
  if (splitSel.pageNos.size > 0) {
    preselected = [...splitSel.pageNos];
    preselectedSource = "split";
  } else if (sidebarSel.pageNos.size >= 2) {
    preselected = [...sidebarSel.pageNos];
    preselectedSource = "sidebar";
  }
  console.log(
    "[print] preselect:",
    preselectedSource ?? "none",
    "splitSize=", splitSel.pageNos.size,
    "sidebarSize=", sidebarSel.pageNos.size,
    "isSplitMode=", _isSplitMode(),
    "preselected=", preselected,
  );
  if (preselected && preselected.length > 0) {
    _wsStatus.textContent = preselectedSource === "split"
      ? `分割画面で選択した ${preselected.length} ページを印刷範囲に設定しました`
      : `選択した ${preselected.length} ページを印刷範囲に設定しました`;
  }

  // β72 (案 D): Adobe / Foxit / PDF-XChange が入っていれば Reader の
  // 印刷ダイアログを直接開く経路に分岐。K-PDF3 自前ダイアログは Reader
  // 不在環境用の fallback として残す。
  let hasReader = false;
  try {
    hasReader = await kpdf3.hasPdfReader();
  } catch (err) {
    console.warn("[print] hasPdfReader failed, fall back to legacy dialog:", err);
  }
  if (hasReader) {
    return actionPrintViaReader(pages, preselected, preselectedSource);
  }

  showBusy("プリンタ情報を取得中...", "プリンタ一覧を読み込んでいます...", 50);
  let printers;
  try {
    printers = await kpdf3.listPrinters();
  } finally {
    hideBusy();
  }

  const currentPageNo = _viewer.currentPage || 1;
  const choice = await showPrintDialog(printers, pages, currentPageNo, preselected);
  if (!choice) {
    _wsStatus.textContent = "印刷をキャンセルしました";
    return;
  }

  // Decide pipeline: byte-copy only when no overlays AND printing all pages.
  const projectStore = _projectStore();
  const overlayCount = projectStore.count();
  const allPagesSelected =
    choice.pageNos.length === pages.length &&
    choice.pageNos.every((n, i) => n === i + 1);
  const isCopy = overlayCount === 0 && allPagesSelected;

  // 中止ボタンを有効化。spawn 中の SumatraPDF や silent print の途中で
  // 「もう待たない」をユーザに渡せる。fire-and-forget: handler 内で
  // hideBusy + cancelPrint IPC を呼ぶ。
  let printCancelled = false;
  showBusy("印刷準備", "ページを描画中...", 0, {
    onCancel: () => {
      printCancelled = true;
      kpdf3.cancelPrint?.();
      hideBusy();
      _wsStatus.textContent = "印刷を中止しました";
    },
  });
  let composed = null;
  try {
    if (!isCopy) {
      const filteredPages = pages.filter((p) =>
        choice.pageNos.includes(p.pageNo),
      );
      composed = await composePagesForExport({
        pages: filteredPages,
        projectStore,
        renderPage: kpdf3.renderPage,
        renderSyntheticPage: renderSyntheticPagePixels,
        rasterRedactionPages: true,
        // Phase 1: legacy 印刷経路 (Sumatra silent) でも白黒モード適用
        monoOverlays: _isMonoPrintMode(),
        onProgress: ({ done, total }) => {
          updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
        },
      });
    }
    if (printCancelled) return;
    // Heuristic: name に fax 系文字列が混じっていればドライバ UI が
    // 出る可能性が高いので、待ち画面でその旨を予告する (main 側は同じ
    // 検出ロジックで silent を外す)。
    const looksLikeFax = /fax/i.test(choice.deviceName)
      || /ファックス|ファクス|ﾌｧｯｸｽ|ﾌｧｸｽ/.test(choice.deviceName);
    if (looksLikeFax) {
      updateBusy(`${choice.deviceName} に送信中... ドライバの送信先入力ダイアログをご確認ください`, 90);
    } else {
      updateBusy(`${choice.deviceName} に送信中...`, 90);
    }
    await kpdf3.printPdfSilent({
      source: isCopy ? "byte-copy" : "rasterized",
      pages: composed,
      deviceName: choice.deviceName,
      copies: choice.copies,
      landscape: choice.landscape,
      // β46 J3: driver-side picks (duplex / tray / color) captured from
      // DocumentPropertiesW. Main forwards to Sumatra's -print-settings
      // so the user's プロパティ choices actually take effect.
      duplex: printState.driverDuplex,
      bin: printState.driverBin,
      color: printState.driverColor,
      // β70: ユーザ選択 or 永続化された印刷エンジン (空文字なら main の
      // 自動検出に任せる)
      engineOverride: printEngineSelect?.value || null,
    });
    if (printCancelled) return;
    hideBusy();
    _wsStatus.textContent = `印刷を ${choice.deviceName} に送信しました（${choice.copies} 部 / ${choice.pageNos.length} ページ）`;
  } catch (err) {
    hideBusy();
    if (printCancelled) return;
    console.error("[renderer] print failed:", err);
    _wsStatus.textContent = `印刷失敗: ${err.message ?? err}`;
  }
}

/**
 * β.80 下敷き印刷 (申請書テンプレ用)。
 *
 *   1. 注意ダイアログで「白紙の申請書をトレイにセット + Adobe で
 *      『実際のサイズ』選択」を案内
 *   2. 全ページを overlay-only strategy で composePagesForExport
 *      (背景 PDF は出力しない、空白ページ + overlay PNG のみ)
 *   3. 既存 print-via-reader-dialog で Adobe ダイアログを起動
 *
 * 物理紙の不動文字に重ね印刷する用途。Adobe ダイアログの「実際の
 * サイズ」を CLI で強制する手段はないため (検証済)、ユーザーへの
 * 注意書きで担保する。sidebar/split 選択時はその範囲のみ印刷する
 * のは通常の actionPrint と同じ。
 *
 * Reader 不在環境 (Sumatra / Chromium のみ) はメッセージで断る。
 */
export async function actionPrintOverlayOnly() {
  if (!_isOpen()) return;
  const pages = await _fetchVisiblePages();
  if (pages.length === 0) return;

  // 1. 事前注意ダイアログ。 \n は .confirm-message の pre-line で
  //    そのまま改行表示される。
  const proceed = await customConfirm({
    title: "下敷き印刷",
    message:
      "プリンタトレイに白紙の申請書をセットしてください。\n\n" +
      "Adobe の印刷ダイアログで以下を確認してください:\n" +
      "  ・「実際のサイズ」を選択\n" +
      "  ・「ページの拡大/縮小」は OFF\n\n" +
      "用紙の不動文字の上に、入力した内容だけを重ね印刷します。\n\n" +
      "印刷を開始しますか?",
    okLabel: "印刷",
    cancelLabel: "キャンセル",
  });
  if (!proceed) {
    _wsStatus.textContent = "下敷き印刷をキャンセルしました";
    return;
  }

  let hasReader = false;
  try {
    hasReader = await kpdf3.hasPdfReader();
  } catch (err) {
    console.warn("[print-overlay-only] hasPdfReader failed:", err);
  }
  if (!hasReader) {
    _wsStatus.textContent =
      "下敷き印刷は Adobe / Foxit / PDF-XChange の印刷ダイアログ経由のみ対応です";
    return;
  }

  // 通常 actionPrint と同じ preselected ロジック (split / sidebar 選択)
  let preselected = null;
  let preselectedSource = null;
  const splitSel = _splitThumbSelection();
  const sidebarSel = _sidebarThumbSelection();
  if (splitSel.pageNos.size > 0) {
    preselected = [...splitSel.pageNos];
    preselectedSource = "split";
  } else if (sidebarSel.pageNos.size >= 2) {
    preselected = [...sidebarSel.pageNos];
    preselectedSource = "sidebar";
  }
  const filteredPages = preselected
    ? pages.filter((p) => preselected.includes(p.pageNo))
    : pages;
  if (filteredPages.length === 0) {
    _wsStatus.textContent = "印刷対象ページがありません";
    return;
  }

  const projectStore = _projectStore();
  // β.118: 中止ボタンを表示 (Adobe ダイアログが出ない事象救済)。
  showBusy("下敷き印刷", "ページを描画中...", 0, {
    onCancel: () => {
      try { kpdf3.cancelPrint?.(); } catch { /* ignore */ }
      hideBusy();
      _wsStatus.textContent = "下敷き印刷を中止しました";
    },
  });
  try {
    const composed = await composePagesForExport({
      pages: filteredPages,
      projectStore,
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
      overlayOnly: true,
      rasterRedactionPages: true,
      // Phase 1: 下敷き印刷 (overlay-only) でも白黒モードに従う。下敷き印刷
      // は overlay だけを物理紙に乗せる経路なので、カラー印影が薄くなる
      // 問題と完全に同じシナリオが該当する。
      monoOverlays: _isMonoPrintMode(),
      onProgress: ({ done, total }) => {
        updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
      },
    });
    updateBusy("PDF Reader を起動しています...", 90);
    const result = await kpdf3.printViaReaderDialog({
      source: "rasterized",
      pages: composed,
    });
    hideBusy();
    const summary = preselectedSource
      ? `${filteredPages.length} ページ (${preselectedSource === "split" ? "分割画面選択" : "サイドバー選択"})`
      : `${filteredPages.length} ページ`;
    const reasonText =
      result.reason === "job-detected" ? "印刷ジョブ投入を検出"
      : result.reason === "reader-closed" ? "Reader を終了"
      : result.reason === "timeout" ? "タイムアウト"
      : "完了";
    _wsStatus.textContent = `下敷き印刷: ${result.engine} (${reasonText}) — ${summary}`;
  } catch (err) {
    hideBusy();
    console.error("[print-overlay-only] failed:", err);
    _wsStatus.textContent = `下敷き印刷失敗: ${err.message ?? err}`;
  }
}

// =====================================================================
// Phase 2: FAX 送信ボタン
//
// FAX 専用ボタンを Adobe 経路から切り離し、(1) 既定 FAX プリンタへ直送、
// (2) 白黒モード強制、(3) ページサイズ混在検出 + ミニダイアログ で 3 択
// を出す。FAX プリンタは localStorage で永続化、初回 / 変更時のみ picker。
//
// 経路:
//   - left-click  → _actionFaxSendAuto: 単一サイズなら streamlined、混在
//                   なら _faxMixedDialog で A4 統一/Adobe/取消 を出す
//   - 右クリック "Adobe 経由" → _actionFaxSendViaAdobe: Adobe `/p` 経由
//                   (案 D の actionPrintViaReader を forceMono=true で呼ぶ)
//   - 右クリック "FAX プリンタを変更…" → _faxSetupDialog を再表示
// =====================================================================

const LS_FAX_PRINTER = "kpdf3.faxPrinter";

/** main 側の isFaxDevice と同じパターンで FAX 系プリンタ名を判定。 */
function _isFaxNameLike(name) {
  if (!name) return false;
  if (/(?:^|[\s_\-()/\\:])fax(?:$|[\s_\-()/\\:])/i.test(name)) return true;
  return /ファックス|ファクス|ﾌｧｯｸｽ|ﾌｧｸｽ/.test(name);
}

function _getRememberedFaxPrinter() {
  try { return localStorage.getItem(LS_FAX_PRINTER) || null; }
  catch { return null; }
}
function _rememberFaxPrinter(name) {
  try { localStorage.setItem(LS_FAX_PRINTER, name); } catch { /* ignore */ }
}

/** ページサイズ混在検出。canonical (post-rotation) 寸法で比較し、半端
 *  な誤差を吸収するため 1pt 以内の差は同一視する。 */
function _detectPageSizeMix(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return { mixed: false, sizes: [] };
  const sizes = [];
  for (const p of pages) {
    const rot = (((p.rotation ?? 0) + (p.userRotation ?? 0)) % 360 + 360) % 360;
    const w = rot === 90 || rot === 270 ? p.cropH : p.cropW;
    const h = rot === 90 || rot === 270 ? p.cropW : p.cropH;
    const found = sizes.find((s) => Math.abs(s.w - w) <= 1 && Math.abs(s.h - h) <= 1);
    if (!found) sizes.push({ w, h, count: 1 });
    else found.count += 1;
  }
  return { mixed: sizes.length > 1, sizes };
}

/** mm 換算で「A4 相当」「A3 相当」のラベルを返す (体感ラベル化)。 */
function _labelForPageSize(w, h) {
  const W = Math.min(w, h), H = Math.max(w, h);
  const mmW = W / 72 * 25.4, mmH = H / 72 * 25.4;
  // tolerance 6mm: ユーザの裁断 PDF 等での誤差吸収
  const near = (a, b) => Math.abs(a - b) <= 6;
  if (near(mmW, 210) && near(mmH, 297)) return "A4";
  if (near(mmW, 297) && near(mmH, 420)) return "A3";
  if (near(mmW, 148) && near(mmH, 210)) return "A5";
  if (near(mmW, 182) && near(mmH, 257)) return "B5";
  if (near(mmW, 257) && near(mmH, 364)) return "B4";
  if (near(mmW, 216) && near(mmH, 279)) return "Letter";
  return `${Math.round(mmW)}×${Math.round(mmH)}mm`;
}

/** FAX 系プリンタ一覧を取得して [{name, displayName}] 配列で返す。 */
async function _fetchFaxPrinters() {
  try {
    const all = await kpdf3.listPrinters();
    return Array.isArray(all)
      ? all.filter((p) => _isFaxNameLike(p.name) || _isFaxNameLike(p.displayName))
      : [];
  } catch (err) {
    console.warn("[fax] listPrinters failed:", err);
    return [];
  }
}

const faxSetupDialog = $("fax-setup-dialog");
const faxSetupSelect = $("fax-setup-printer-select");
const faxSetupHint = $("fax-setup-hint");
const faxSetupOk = $("fax-setup-ok");
const faxSetupCancel = $("fax-setup-cancel");

/** FAX プリンタ picker を表示。OK で device name を resolve、cancel/Esc で null。
 *  printers が空のときは fallback として全プリンタを出し、注意 hint を変える。 */
function _showFaxSetupDialog(faxPrinters, allPrinters = null) {
  return new Promise((resolve) => {
    faxSetupSelect.innerHTML = "";
    const list = faxPrinters.length > 0 ? faxPrinters : (allPrinters ?? []);
    if (list.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(プリンタが見つかりません)";
      faxSetupSelect.appendChild(opt);
      faxSetupOk.disabled = true;
    } else {
      faxSetupOk.disabled = false;
      const remembered = _getRememberedFaxPrinter();
      for (const p of list) {
        const opt = document.createElement("option");
        opt.value = p.name;
        opt.textContent = p.displayName ?? p.name;
        if (p.name === remembered) opt.selected = true;
        faxSetupSelect.appendChild(opt);
      }
    }
    if (faxSetupHint) {
      faxSetupHint.textContent = faxPrinters.length > 0
        ? "※ fax / ファックス / ファクス を含むプリンタを表示しています。"
        : "※ FAX 系プリンタが見つかりませんでした。全プリンタから選択できます。";
    }
    faxSetupDialog.hidden = false;
    setTimeout(() => faxSetupOk.focus(), 0);

    const cleanup = () => {
      faxSetupDialog.hidden = true;
      faxSetupOk.removeEventListener("click", onOk);
      faxSetupCancel.removeEventListener("click", onCancel);
      faxSetupDialog.removeEventListener("click", onBgClick);
      document.removeEventListener("keydown", onKey, true);
    };
    const onOk = () => {
      const v = faxSetupSelect.value || null;
      cleanup();
      resolve(v);
    };
    const onCancel = () => { cleanup(); resolve(null); };
    const onBgClick = (e) => { if (e.target === faxSetupDialog) onCancel(); };
    const onKey = (e) => {
      if (faxSetupDialog.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter") { e.preventDefault(); onOk(); }
    };
    faxSetupOk.addEventListener("click", onOk);
    faxSetupCancel.addEventListener("click", onCancel);
    faxSetupDialog.addEventListener("click", onBgClick);
    document.addEventListener("keydown", onKey, true);
  });
}

const faxMixedDialog = $("fax-mixed-dialog");
const faxMixedMessage = $("fax-mixed-message");
const faxMixedA4 = $("fax-mixed-a4");
const faxMixedAdobe = $("fax-mixed-adobe");
const faxMixedCancel = $("fax-mixed-cancel");

/** ページサイズ混在ダイアログ。"a4" | "adobe" | "cancel" を resolve。 */
function _showFaxMixedDialog(mix) {
  return new Promise((resolve) => {
    const labels = mix.sizes
      .map((s) => `${_labelForPageSize(s.w, s.h)} × ${s.count}p`)
      .join(" / ");
    faxMixedMessage.textContent = `送信対象に複数のページサイズが混在しています (${labels})。`;
    faxMixedDialog.hidden = false;
    setTimeout(() => faxMixedA4.focus(), 0);

    const cleanup = (v) => {
      faxMixedDialog.hidden = true;
      faxMixedA4.removeEventListener("click", on_a4);
      faxMixedAdobe.removeEventListener("click", on_adobe);
      faxMixedCancel.removeEventListener("click", on_cancel);
      faxMixedDialog.removeEventListener("click", on_bg);
      document.removeEventListener("keydown", on_key, true);
      resolve(v);
    };
    const on_a4 = () => cleanup("a4");
    const on_adobe = () => cleanup("adobe");
    const on_cancel = () => cleanup("cancel");
    const on_bg = (e) => { if (e.target === faxMixedDialog) on_cancel(); };
    const on_key = (e) => {
      if (faxMixedDialog.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); on_cancel(); }
    };
    faxMixedA4.addEventListener("click", on_a4);
    faxMixedAdobe.addEventListener("click", on_adobe);
    faxMixedCancel.addEventListener("click", on_cancel);
    faxMixedDialog.addEventListener("click", on_bg);
    document.addEventListener("keydown", on_key, true);
  });
}

/** Split / sidebar 選択をプリ選択として読み出す (actionPrint と同じロジック)。 */
function _gatherPreselection() {
  const splitSel = _splitThumbSelection();
  const sidebarSel = _sidebarThumbSelection();
  if (splitSel.pageNos.size > 0) {
    return { preselected: [...splitSel.pageNos], preselectedSource: "split" };
  }
  if (sidebarSel.pageNos.size >= 2) {
    return { preselected: [...sidebarSel.pageNos], preselectedSource: "sidebar" };
  }
  return { preselected: null, preselectedSource: null };
}

/** FAX 送信メイン。
 *  @param {{via?:"auto"|"adobe"}} opts via="auto" で streamlined (混在検出
 *    時は内部でミニダイアログを出して分岐)、"adobe" で Adobe `/p` 経路 (FAX
 *    印刷ボタン右クリックの escape hatch)。
 */
export async function actionFaxSend(opts = {}) {
  if (!_isOpen()) return;
  const via = opts.via === "adobe" ? "adobe" : "auto";
  const pages = await _fetchVisiblePages();
  if (pages.length === 0) return;
  const { preselected, preselectedSource } = _gatherPreselection();

  if (via === "adobe") {
    // Adobe 経由 escape hatch: actionPrintViaReader を forceMono=true で
    // 呼ぶ。ユーザは Adobe ダイアログで FAX プリンタを手動選択する。
    return actionPrintViaReader(pages, preselected, preselectedSource, {
      forceMono: true,
      labelPrefix: "FAX 送信",
    });
  }

  // auto 経路 — ページサイズ混在検出
  const filteredPages = preselected
    ? pages.filter((p) => preselected.includes(p.pageNo))
    : pages;
  const mix = _detectPageSizeMix(filteredPages);
  let forceFitA4 = false;
  if (mix.mixed) {
    const choice = await _showFaxMixedDialog(mix);
    if (choice === "cancel") {
      _wsStatus.textContent = "FAX 送信をキャンセルしました";
      return;
    }
    if (choice === "adobe") {
      return actionPrintViaReader(pages, preselected, preselectedSource, {
        forceMono: true,
        labelPrefix: "FAX 送信",
      });
    }
    // choice === "a4" → drop through; Sumatra/Chromium 側で fit/paper hint
    forceFitA4 = true;
  }

  // FAX プリンタ取得 (記憶済 or 初回 picker)
  let faxDevice = _getRememberedFaxPrinter();
  let faxPrinters = null;
  if (faxDevice) {
    // 記憶済の名前が現在の接続プリンタに存在するか念のため確認
    try {
      const all = await kpdf3.listPrinters();
      const exists = Array.isArray(all) && all.some((p) => p.name === faxDevice);
      if (!exists) faxDevice = null; // 接続が外れた等 — picker を出し直す
    } catch { /* ignore — try with remembered */ }
  }
  if (!faxDevice) {
    let allPrinters;
    try { allPrinters = await kpdf3.listPrinters(); } catch { allPrinters = []; }
    faxPrinters = Array.isArray(allPrinters)
      ? allPrinters.filter((p) => _isFaxNameLike(p.name) || _isFaxNameLike(p.displayName))
      : [];
    // β.89 hotfix: FAX 系プリンタが見つからない場合は silently 全プリンタ
    // への fallback をしない (通常プリンタを誤って「FAX 送信」してしまう
    // 事故を構造防止)。FAX が無い環境では通常の「印刷」+ 「白黒」トグル
    // を案内する。
    if (faxPrinters.length === 0) {
      await customConfirm({
        title: "FAX 送信",
        message:
          allPrinters.length === 0
            ? "プリンタが見つかりません。OS のプリンタ設定をご確認ください。"
            : "FAX 系プリンタ (名前に「FAX」「ファックス」「ファクス」を含む) が見つかりません。\n\nFAX 印字がない場合は通常の「印刷」ボタン + 「白黒」トグルを使用してください。",
        cancelLabel: null,
      });
      return;
    }
    faxDevice = await _showFaxSetupDialog(faxPrinters, null);
    if (!faxDevice) {
      _wsStatus.textContent = "FAX 送信をキャンセルしました";
      return;
    }
    _rememberFaxPrinter(faxDevice);
  }
  // β.89 hotfix: 記憶済 / 選択直後の faxDevice が実は FAX 名でないケース
  // を最終チェック (旧 β.88 で alllPrinters fallback から非 FAX を記憶した
  // 痕跡を一掃する保険)。
  if (!_isFaxNameLike(faxDevice)) {
    const proceed = await customConfirm({
      title: "FAX 送信 — 注意",
      message: `選択されたプリンタ「${faxDevice}」は FAX 系の名前ではありません。\n\n本当にこのプリンタに白黒で送信しますか? (キャンセル推奨。「FAX プリンタを変更…」から FAX 系プリンタを選び直してください)`,
      okLabel: "続行",
      cancelLabel: "キャンセル",
    });
    if (!proceed) {
      _wsStatus.textContent = "FAX 送信をキャンセルしました";
      return;
    }
  }

  // β.92: 描画 + 送信 — Adobe `/p` 経路 + OS 既定プリンタを FAX に一時切替。
  //
  // β.91 までは streamlined FAX = Chromium silent print 直送だったが、
  // Chromium の webContents.print() は PDFium 内部で常に fit-to-paper を
  // 適用しており、API 経由 (margins/pageSize/scaleFactor) では抑止できな
  // いことが判明 (A4 PDF が 5-10% 縮小されて送信される問題)。
  //
  // 解決として Adobe `/p` 経路に切替え + 既定プリンタを FAX に一時設定する
  // ことで「Adobe ダイアログが FAX 選択済の状態で開く」体験を作る。Adobe
  // のスケール設定 (実際のサイズ / ページサイズに合わせる) はユーザが
  // 1 度「実際のサイズ」を選べば記憶されるので、以降は手数ほぼ同等。
  // 副次効果として Adobe の vector レンダラを使うので明朝の hairline 品質
  // も保たれる (β.88 Phase 3 が達成しようとした目的を別経路で実現)。
  // β.118: 描画フェーズの中止ボタン。
  // β.129: FAX 経路は Adobe `/p` 起動後、印刷完了を自動検出する信号が
  //   構造的に存在しない — FUJIFILM 等の FAX ドライバは Win32_PrintJob に
  //   可視ジョブを出さず (案 X / Path A が盲目)、Adobe も FAX 送信後に
  //   document を閉じないため Path B も遷移しない。そのため Adobe 起動後は
  //   busy modal を「送信完了」の明示確認モーダルへ切り替え、ユーザーの
  //   明示操作で Adobe を閉じる (自動検出に依存しない)。
  showBusy("FAX 送信", `送信先 ${faxDevice} — ページを描画中...`, 0, {
    onCancel: () => {
      try { kpdf3.cancelPrint?.(); } catch { /* ignore */ }
      hideBusy();
      _wsStatus.textContent = "FAX 送信を中止しました";
    },
  });
  let composed = null;
  try {
    composed = await composePagesForExport({
      pages: filteredPages,
      projectStore: _projectStore(),
      renderPage: kpdf3.renderPage,
      renderSyntheticPage: renderSyntheticPagePixels,
      rasterRedactionPages: true,
      monoOverlays: true,
      onProgress: ({ done, total }) => {
        updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
      },
    });
    // β.129: 描画完了 → ここから先は Adobe / FAX ドライバでの送信操作
    // フェーズ。自動完了検出が効かないので modal を明示確認に切り替える。
    updateBusy(
      "Adobe と FAX ドライバの画面で送信操作を完了してください。"
      + "送信が終わったら下の「送信完了」ボタンを押してください。",
      100,
    );
    setBusyCancel({
      cancelLabel: "送信完了",
      cancelBusyMessage: "Adobe を終了しています...",
      onCancel: () => {
        // 押下 = kpdf3.cancelPrint() で Adobe を終了 → main の
        // finish('reader-closed') が走り await が解決する。hideBusy /
        // status 更新は await 解決側に集約 (二重更新を防ぐ)。
        try { kpdf3.cancelPrint?.(); } catch { /* ignore */ }
      },
    });
    const result = await kpdf3.printViaReaderDialog({
      source: "rasterized",
      pages: composed,
      defaultPrinterHint: faxDevice,
    });
    hideBusy();
    const reasonText =
      result.reason === "job-detected" ? "印刷ジョブ投入を検出"
      : result.reason === "doc-closed" ? "Adobe の文書クローズを検出"
      : result.reason === "reader-closed" ? "送信ダイアログを閉じました"
      : result.reason === "timeout" ? "タイムアウト"
      : "完了";
    _wsStatus.textContent =
      `FAX 送信: ${faxDevice} (${reasonText}) — ${filteredPages.length} ページ${forceFitA4 ? " (A4 統一)" : ""}`;
  } catch (err) {
    hideBusy();
    console.error("[fax] send failed:", err);
    _wsStatus.textContent = `FAX 送信失敗: ${err.message ?? err}`;
  }
}

/** 右クリック「FAX プリンタを変更…」用 — picker を強制再表示し、記憶を
 *  上書きする。送信は走らせない。 */
export async function actionFaxChangePrinter() {
  let allPrinters;
  try { allPrinters = await kpdf3.listPrinters(); } catch { allPrinters = []; }
  const faxPrinters = Array.isArray(allPrinters)
    ? allPrinters.filter((p) => _isFaxNameLike(p.name) || _isFaxNameLike(p.displayName))
    : [];
  // β.89 hotfix: 通常プリンタへの誤送信を防ぐため、FAX 系名以外は picker
  // に出さない方針。FAX 系が 0 件のときは「FAX 系プリンタを追加してくだ
  // さい」案内で中止 (allPrinters fallback は廃止)。
  if (faxPrinters.length === 0) {
    await customConfirm({
      title: "FAX プリンタを変更",
      message:
        allPrinters.length === 0
          ? "プリンタが見つかりません。OS のプリンタ設定をご確認ください。"
          : "FAX 系プリンタ (名前に「FAX」「ファックス」「ファクス」を含む) が見つかりません。OS 側で FAX ドライバを追加してから再度お試しください。",
      cancelLabel: null,
    });
    return;
  }
  const picked = await _showFaxSetupDialog(faxPrinters, null);
  if (picked) {
    _rememberFaxPrinter(picked);
    _wsStatus.textContent = `FAX プリンタを ${picked} に変更しました`;
  }
}
