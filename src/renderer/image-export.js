// 画像書き出し (β.97 の 2 機能) — S6 リファクタ (REVIEW-2026-07 #8) で
// renderer.js から抽出。ロジックは移動のみで不変。
//
//   機能 1: PDF を画像として保存 (actionExportAsImage + ダイアログ)
//   機能 2: 範囲選択して画像保存 (startRegionImageDrag → saveRegionImage)
//
// State (isOpen, projectStore, activeSourceName, ...) は renderer.js が
// 所有し、initImageExport の getter 注入で参照する (§4.4 設計パターン 1)。
// 安定 ID の DOM は直接 getElementById で取得する (同パターン 2)。

import { composePageImage, composeRegionImage } from "./exporter.js";
import { renderSyntheticPagePixels } from "./viewer.js";
import { showBusy, updateBusy, hideBusy } from "./busy-modal.js";
import { showFileBrowser } from "./file-browser.js";

const { kpdf3 } = window;
const $ = (id) => document.getElementById(id);
const wsStatus = $("ws-status");

let _isOpen = () => false;
let _projectStore = () => null;
let _viewer = null;
let _activeSourceName = () => null;
let _fetchVisiblePages = async () => [];
let _parseMultiPageRange = () => null;
let _setPlacementMode = () => {};

export function initImageExport({
  isOpen,
  projectStore,
  viewer,
  activeSourceName,
  fetchVisiblePages,
  parseMultiPageRange,
  setPlacementMode,
}) {
  _isOpen = isOpen;
  _projectStore = projectStore;
  _viewer = viewer;
  _activeSourceName = activeSourceName;
  _fetchVisiblePages = fetchVisiblePages;
  _parseMultiPageRange = parseMultiPageRange;
  _setPlacementMode = setPlacementMode;
}

// ---- β.97 機能 2: 範囲選択して画像保存 -----------------------------------
//
// ツールバー「範囲画像」ボタン or メニュー「選んだ範囲を画像で保存…」で
// placementMode を "region-image" に切替 → ページ上のドラッグで矩形を
// 描く → リリースで mode-options-bar の formato/dpi/mono を反映して
// composeRegionImage → save dialog で 1 枚画像保存。
//
// drag UI は redaction とほぼ同じ実装 (preview rect を div に当てる)。
// commit 時に setPlacementMode("none") で抜ける (繰り返し配置はしない、
// 1 ドラッグ = 1 保存)。

export function startRegionImageDrag(pageNo, startX, startY, downEvt, div) {
  if (!div || !downEvt || typeof div.setPointerCapture !== "function") {
    // Pointer capture not available — abort cleanly, the user can retry.
    _setPlacementMode("none");
    return;
  }
  const pointerId = downEvt.pointerId;
  const z = _viewer.zoom;
  const preview = document.createElement("div");
  preview.className = "region-image-preview";
  preview.style.left = `${startX * z}px`;
  preview.style.top = `${startY * z}px`;
  preview.style.width = "0px";
  preview.style.height = "0px";
  div.appendChild(preview);

  let curX = startX, curY = startY;
  try { div.setPointerCapture(pointerId); } catch { /* ignore */ }

  function onMove(e) {
    if (e.pointerId !== pointerId) return;
    const rect = div.getBoundingClientRect();
    curX = (e.clientX - rect.left) / z;
    curY = (e.clientY - rect.top) / z;
    const left = Math.min(startX, curX);
    const top = Math.min(startY, curY);
    const width = Math.abs(curX - startX);
    const height = Math.abs(curY - startY);
    preview.style.left = `${left * z}px`;
    preview.style.top = `${top * z}px`;
    preview.style.width = `${width * z}px`;
    preview.style.height = `${height * z}px`;
  }
  function cleanup() {
    div.removeEventListener("pointermove", onMove);
    div.removeEventListener("pointerup", onUp);
    div.removeEventListener("pointercancel", onCancel);
    try { div.releasePointerCapture(pointerId); } catch { /* ignore */ }
    preview.remove();
  }
  async function onUp(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
    const left = Math.min(startX, curX);
    const top = Math.min(startY, curY);
    const width = Math.abs(curX - startX);
    const height = Math.abs(curY - startY);
    if (width < 5 || height < 5) {
      wsStatus.textContent = "範囲が小さすぎます — もう一度ドラッグしてください";
      return; // stay in region-image mode for a retry
    }
    _setPlacementMode("none");
    await saveRegionImage(pageNo, { x: left, y: top, w: width, h: height });
  }
  function onCancel(e) {
    if (e.pointerId !== pointerId) return;
    cleanup();
  }
  div.addEventListener("pointermove", onMove);
  div.addEventListener("pointerup", onUp);
  div.addEventListener("pointercancel", onCancel);
}

async function saveRegionImage(pageNo, bbox) {
  // Pull options from the mode-options-bar (these stayed visible while the
  // user dragged) so they don't need to confirm again in a second dialog.
  const fmtSel = $("region-image-format");
  const dpiSel = $("region-image-dpi");
  const monoChk = $("region-image-mono");
  const fmt = (fmtSel?.value === "jpeg") ? "jpeg" : "png";
  const ext = fmt === "jpeg" ? "jpg" : "png";
  const dpi = Number(dpiSel?.value) || 300;
  const mono = !!monoChk?.checked;

  // Find the page row for this pageNo (synthetic / source agnostic).
  const pages = await _fetchVisiblePages();
  const pageRow = pages.find((p) => p.pageNo === pageNo);
  if (!pageRow) {
    wsStatus.textContent = `ページ ${pageNo} が見つかりません`;
    return;
  }

  // File picker
  const baseStem = (_activeSourceName() || "region").replace(/\.[a-zA-Z0-9]+$/, "");
  const defaults = await kpdf3.getExportDefaults();
  const choice = await showFileBrowser({
    mode: "save",
    title: "範囲を画像として保存",
    initialName: `${baseStem}_p${pageNo > 0 ? pageNo : "ins"}.${ext}`,
    defaultDir: defaults.sourceDir,
    defaultExt: `.${ext}`,
    filterDefault: "image",
  });
  if (!choice) return;
  const savePath = typeof choice === "string" ? choice : choice.path;

  const zoom = dpi / 72;
  showBusy("範囲画像書き出し", "選択範囲を描画しています...", 30);
  try {
    const img = await composeRegionImage({
      pageRow,
      renderPage: kpdf3.renderPage,
      projectStore: _projectStore(),
      renderSyntheticPage: renderSyntheticPagePixels,
      zoom,
      format: fmt,
      quality: 0.92,
      monoOverlays: mono,
      bbox,
    });
    updateBusy("ファイルに書き込み中...", 90);
    await kpdf3.saveImageFile({ savePath, bytes: img.bytes });
    hideBusy();
    wsStatus.textContent =
      `範囲画像を保存しました (${img.widthPx}×${img.heightPx}px, ${fmt.toUpperCase()}, ${dpi}dpi → ${savePath})`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] region image export failed:", err);
    wsStatus.textContent = `範囲画像書き出し失敗: ${err.message ?? err}`;
  }
}

// ---- β.97 機能 1: PDF を画像として保存 -----------------------------------
//
// PDF の各ページを PNG / JPEG として書き出す。複数ページの場合はフォルダを
// 1 つ選んで、その中に「<base>_p001.png」「<base>_p002.png」… の連番で
// 出力する。単一ページの場合は普通の save ダイアログで 1 ファイル保存。
//
// 解像度は dpi → zoom 換算 (96/150/300/600/900 dpi)。900dpi は EXPORT_ZOOM と
// 同じで PDF 書き出しの fidelity が出る。300dpi が標準推奨 (送付用・印刷代用)。
// 編集 overlay は常に flatten で焼き込み (画像なので分離保持できない)。

function showImageExportDialog() {
  const dlg = $("image-export-dialog");
  if (!dlg) return Promise.resolve(null);
  const rangeRadios = dlg.querySelectorAll('input[name="image-export-range"]');
  const formatRadios = dlg.querySelectorAll('input[name="image-export-format"]');
  const rangeInput = $("image-export-range-input");
  const dpiSel = $("image-export-dpi");
  const monoChk = $("image-export-mono");
  const baseInput = $("image-export-basename");
  const okBtn = $("image-export-confirm");
  const cancelBtn = $("image-export-cancel");

  // Restore last-used config
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem("kpdf3.imageExportPrefs") || "{}"); }
    catch { return {}; }
  })();
  if (stored.format === "jpeg") {
    const r = dlg.querySelector('input[name="image-export-format"][value="jpeg"]');
    if (r) r.checked = true;
  }
  if (Number.isFinite(stored.dpi)) {
    const opt = [...dpiSel.options].find((o) => Number(o.value) === stored.dpi);
    if (opt) dpiSel.value = opt.value;
  }
  monoChk.checked = !!stored.mono;
  // Default basename from active source (.pdf → "")
  const meta = _activeSourceName() || "export.pdf";
  const defaultBase = String(meta).replace(/\.[a-zA-Z0-9]+$/, "");
  baseInput.value = defaultBase;
  rangeInput.value = "";

  // Reset range to all by default each invocation (user is making a fresh choice)
  for (const r of rangeRadios) r.checked = r.value === "all";
  rangeInput.disabled = true;

  function syncRangeInput() {
    const sel = [...rangeRadios].find((r) => r.checked)?.value || "all";
    rangeInput.disabled = sel !== "custom";
    if (sel === "custom") rangeInput.focus();
  }
  for (const r of rangeRadios) r.addEventListener("change", syncRangeInput);

  dlg.hidden = false;
  baseInput.focus();
  baseInput.select();

  return new Promise((resolve) => {
    function cleanup() {
      for (const r of rangeRadios) r.removeEventListener("change", syncRangeInput);
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dlg.removeEventListener("keydown", onKey);
      dlg.hidden = true;
    }
    function onCancel() {
      cleanup();
      resolve(null);
    }
    function onOk() {
      const rangeKind = [...rangeRadios].find((r) => r.checked)?.value || "all";
      const format = [...formatRadios].find((r) => r.checked)?.value || "png";
      const dpi = Number(dpiSel.value) || 300;
      const mono = !!monoChk.checked;
      const baseName = baseInput.value.trim() || defaultBase || "page";
      const rangeText = rangeInput.value.trim();
      // Persist prefs for next time (range kind is invocation-specific so we skip it)
      try {
        localStorage.setItem("kpdf3.imageExportPrefs", JSON.stringify({
          format, dpi, mono,
        }));
      } catch { /* ignore */ }
      cleanup();
      resolve({ rangeKind, rangeText, format, dpi, mono, baseName });
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter" && e.target !== rangeInput) {
        e.preventDefault(); onOk();
      }
    }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dlg.addEventListener("keydown", onKey);
  });
}

export async function actionExportAsImage() {
  if (!_isOpen()) return;
  const pages = await _fetchVisiblePages();
  if (pages.length === 0) return;
  const total = pages.length;
  const cfg = await showImageExportDialog();
  if (!cfg) return;

  // Decide which page numbers (1-based among visible pages) to write
  let targetIdxs;
  if (cfg.rangeKind === "all") {
    targetIdxs = pages.map((_, i) => i);
  } else if (cfg.rangeKind === "current") {
    const cp = _viewer.currentPage;
    // Map currentPage (pageNo) to its index in `pages` (which is the
    // visible-order list, including synthetic pages).
    const idx = pages.findIndex((p) => p.pageNo === cp);
    if (idx < 0) {
      wsStatus.textContent = "現在のページが見つかりませんでした";
      return;
    }
    targetIdxs = [idx];
  } else {
    const seq = _parseMultiPageRange(cfg.rangeText, total);
    if (!seq) {
      wsStatus.textContent = `無効な範囲: ${cfg.rangeText}`;
      return;
    }
    targetIdxs = seq.map((n) => n - 1);
  }

  const zoom = cfg.dpi / 72;
  const fmt = cfg.format === "jpeg" ? "jpeg" : "png";
  const ext = fmt === "jpeg" ? "jpg" : "png";

  const defaults = await kpdf3.getExportDefaults();
  if (targetIdxs.length === 1) {
    // Single-page → save dialog with one filename.
    const initialName = `${cfg.baseName}.${ext}`;
    const choice = await showFileBrowser({
      mode: "save",
      title: "画像として保存",
      initialName,
      defaultDir: defaults.sourceDir,
      defaultExt: `.${ext}`,
      filterDefault: "image",
    });
    if (!choice) return;
    const savePath = typeof choice === "string" ? choice : choice.path;
    showBusy("画像書き出し", `ページを ${fmt.toUpperCase()} に変換しています...`, 30);
    try {
      const img = await composePageImage({
        pageRow: pages[targetIdxs[0]],
        renderPage: kpdf3.renderPage,
        projectStore: _projectStore(),
        renderSyntheticPage: renderSyntheticPagePixels,
        zoom,
        format: fmt,
        quality: 0.92,
        monoOverlays: cfg.mono,
      });
      updateBusy("ファイルに書き込み中...", 90);
      await kpdf3.saveImageFile({ savePath, bytes: img.bytes });
      hideBusy();
      wsStatus.textContent = `画像書き出し完了 (${fmt.toUpperCase()}, ${cfg.dpi}dpi → ${savePath})`;
    } catch (err) {
      hideBusy();
      console.error("[renderer] image export (single) failed:", err);
      wsStatus.textContent = `画像書き出し失敗: ${err.message ?? err}`;
    }
    return;
  }

  // Multi-page → folder picker, then write N files inside it.
  const folder = await showFileBrowser({
    mode: "folder",
    title: "画像を保存するフォルダ",
    defaultDir: defaults.sourceDir,
    confirmLabel: "このフォルダに保存",
  });
  if (!folder) return;
  const totalN = targetIdxs.length;
  showBusy("画像書き出し", `${totalN} ページを ${fmt.toUpperCase()} に変換しています...`, 0);
  try {
    const files = [];
    for (let i = 0; i < totalN; i++) {
      const idx = targetIdxs[i];
      const img = await composePageImage({
        pageRow: pages[idx],
        renderPage: kpdf3.renderPage,
        projectStore: _projectStore(),
        renderSyntheticPage: renderSyntheticPagePixels,
        zoom,
        format: fmt,
        quality: 0.92,
        monoOverlays: cfg.mono,
      });
      files.push({ seq: i + 1, ext, bytes: img.bytes });
      updateBusy(`${i + 1} / ${totalN} ページを変換中...`, ((i + 1) / totalN) * 90);
    }
    updateBusy("ファイルに書き込み中...", 95);
    const result = await kpdf3.saveImageFiles({
      folder,
      baseName: cfg.baseName,
      files,
    });
    hideBusy();
    wsStatus.textContent =
      `画像書き出し完了 (${result.count} ファイル, ${fmt.toUpperCase()}, ${cfg.dpi}dpi → ${folder})`;
  } catch (err) {
    hideBusy();
    console.error("[renderer] image export (multi) failed:", err);
    wsStatus.textContent = `画像書き出し失敗: ${err.message ?? err}`;
  }
}
