// 保存フロー (上書き/確定/別名共通パイプライン + ADR-0026 戻せる確定) —
// S6 リファクタ (REVIEW-2026-07 #8) で renderer.js から抽出。ロジックは
// 移動のみで不変。
//
//   actionSave              — Ctrl+S / 保存ボタン (確定 or 下書きの選択)
//   actionExportToPath      — 書き出し共通経路 (byte-copy ゲート込み)
//   actionRestoreEditableMaster / refreshRestoreMasterUI — ADR-0026
//   isPdfOutOfSync          — 上書きボタン活性判定 (refreshMenuState が使用)
//
// State (isOpen, projectStore, workspaceMutated, ...) は renderer.js が
// 所有し、initSaveFlow の getter/setter 注入で参照する (§4.4 パターン 1)。
// menuBar は renderer.js 側で後から生成されるため setMenuEnabled callback
// 経由 (early boot 中の呼び出しは従来どおり catch で握る)。

import {
  composePagesForExport,
  byteCopyEligible,
} from "./exporter.js";
import { renderSyntheticPagePixels } from "./viewer.js";
import { showBusy, updateBusy, hideBusy } from "./busy-modal.js";
import { customConfirm } from "./dialogs.js";
import {
  getActiveTab,
  getActiveTabId,
  newTabAndOpen,
  renderTabBar,
} from "./tab-manager.js";

const { kpdf3 } = window;
const wsStatus = document.getElementById("ws-status");
const btnRestoreMaster = document.getElementById("btn-restore-master");
const docStateField = document.getElementById("doc-state");

let _isOpen = () => false;
let _projectStore = () => null;
let _history = () => null;
let _pendingDeletedPages = () => new Set();
let _workspaceMutated = () => false;
let _setWorkspaceMutated = () => {};
let _activeSourceName = () => null;
let _thumbSelection = () => ({ pageNos: new Set(), anchor: null });
let _isWorkspaceDirty = () => false;
let _fetchVisiblePages = async () => [];
let _refreshDirtyIndicator = () => {};
let _refreshMenuState = () => {};
let _refreshViewer = async () => {};
let _setMenuEnabled = () => {};

export function initSaveFlow({
  isOpen,
  projectStore,
  history,
  pendingDeletedPages,
  workspaceMutated,
  setWorkspaceMutated,
  activeSourceName,
  thumbSelection,
  isWorkspaceDirty,
  fetchVisiblePages,
  refreshDirtyIndicator,
  refreshMenuState,
  refreshViewer,
  setMenuEnabled,
}) {
  _isOpen = isOpen;
  _projectStore = projectStore;
  _history = history;
  _pendingDeletedPages = pendingDeletedPages;
  _workspaceMutated = workspaceMutated;
  _setWorkspaceMutated = setWorkspaceMutated;
  _activeSourceName = activeSourceName;
  _thumbSelection = thumbSelection;
  _isWorkspaceDirty = isWorkspaceDirty;
  _fetchVisiblePages = fetchVisiblePages;
  _refreshDirtyIndicator = refreshDirtyIndicator;
  _refreshMenuState = refreshMenuState;
  _refreshViewer = refreshViewer;
  _setMenuEnabled = setMenuEnabled;
}

/**
 * Out-of-sync detection: the current workspace shows content the source
 * PDF on disk doesn't reflect (overlays, pending or persisted insertions,
 * pending deletions, or any other workspace mutation since the last
 * write-back). When true, the 上書き button is enabled even after the
 * workspace itself is "clean" (no in-memory pending edits) so the user
 * can flatten back into the source PDF.
 */
export function isPdfOutOfSync() {
  if (!_isOpen()) return false;
  if (_projectStore().count() > 0) return true;
  if (_pendingDeletedPages().size > 0) return true;
  if (_workspaceMutated()) return true;
  return false;
}

export async function actionSave() {
  if (!_isOpen()) return;
  // No-op when nothing has changed AND source PDF already matches workspace.
  if (!_isWorkspaceDirty() && !isPdfOutOfSync()) return;
  // Snapshot the "had pre-save mutations" signal — useful below to decide
  // whether the source PDF still needs flattening even after we cleared
  // workspaceMutated.
  const hadMutations = _workspaceMutated();
  // Step 1: flush workspace state (overlays + deletions) so the kpdf3
  // captures everything before we touch the on-disk PDF. Cheap (~50ms).
  try {
    const projectStore = _projectStore();
    const pendingDeletedPages = _pendingDeletedPages();
    const overlaySnapshot = projectStore.snapshot();
    if (projectStore.isDirty()) {
      await kpdf3.saveOverlays(overlaySnapshot);
      projectStore.markClean();
    }
    let deletedCount = 0;
    if (pendingDeletedPages.size > 0) {
      for (const n of pendingDeletedPages) {
        await kpdf3.setPageDeleted(n, true);
      }
      deletedCount = pendingDeletedPages.size;
      pendingDeletedPages.clear();
    }
    _setWorkspaceMutated(false);
    _refreshDirtyIndicator();
    _refreshMenuState();
    // Step 2: if the source PDF doesn't yet reflect the workspace's
    // overlay / page state, confirm + write back. Word Ctrl+S semantics
    // — commit edits to the file the user opened. (Source-PDF path
    // lives on the TabState, NOT as a module-level alias, so resolve
    // it via getActiveTab().)
    const tab = getActiveTab();
    const sourcePath = tab?.activeSourcePdfPath ?? null;
    const hasEditsToCommit =
      sourcePath
      && (overlaySnapshot.length > 0
        || deletedCount > 0
        || hadMutations
        || projectStore.count() > 0);
    if (hasEditsToCommit) {
      // Ask the user how to save. "確定" = flatten + overwrite source PDF
      // (destructive, overlays bake into the image); "下書き" = keep the
      // edits live (workspace-only save, source PDF untouched). Wording
      // avoids the internal "workspace" term and uses the 下書き／確定
      // distinction that legal practitioners already use day-to-day.
      // β.111: 「白黒で上書き」チェックを確定ダイアログに追加。
      // ツールバーの「白黒」トグル (印刷専用) とは別状態で永続化。
      // ADR-0026: 確定は破壊的操作ではなくなった (編集可能マスターを温存)。
      // 「画像化=もう戻せない」という不安を煽らず、①ファイルに反映されて
      // Dropbox/Adobe で見える ②あとで『編集可能な状態に戻す』で戻せる、を
      // 前向きに伝える文言に改訂。
      const result = await customConfirm({
        title: "保存方法を選んでください",
        message:
          `「${_activeSourceName() || "(無名)"}」を保存します。\n\n`
          + `「確定保存」を選ぶと、文字や印影がファイルに焼き込まれ、\n`
          + `Dropbox や Adobe でも見えるようになります。\n`
          + `あとで『編集可能な状態に戻す』で、この時点の編集内容に\n`
          + `戻して直せます。`,
        okLabel: "確定保存\nファイルに反映",
        cancelLabel: "下書き保存\n編集可能として保存",
        checkbox: {
          label: "白黒で上書き（カラースタンプ等を黒化して保存）",
          storageKey: "kpdf3.saveMono",
        },
      });
      if (result.ok) {
        await actionExportToPath(sourcePath, {
          verb: "上書き保存",
          monoExport: result.checked,
        });
        return;
      }
      // User picked 下書き — reinforce the choice in the status bar so
      // they know the source PDF was left alone.
      wsStatus.textContent =
        "下書きとして保存しました（元 PDF は変更されていません）";
      return;
    }
    const parts = [];
    if (overlaySnapshot.length > 0) parts.push(`${overlaySnapshot.length} overlays`);
    if (deletedCount > 0) parts.push(`${deletedCount} pages 削除`);
    wsStatus.textContent =
      parts.length > 0 ? `保存しました (${parts.join(", ")})` : "保存しました";
  } catch (err) {
    console.error("[renderer] save failed:", err);
    wsStatus.textContent = `保存失敗: ${err.message ?? err}`;
  }
}

/**
 * Shared "export rasterized (or byte-copy) PDF to the given path, then
 * re-anchor the active tab onto that file" pipeline. Used by both
 * actionExport (Save As — user-chosen path) and actionSave (上書き保存
 * — path === activeSourcePdfPath). Mirrors Word's Save / Save As
 * semantics: after the operation, the user is editing the file they
 * just wrote to.
 *
 * @param {string} savePath - absolute target PDF path
 * @param {{ verb?: string, secureExport?: boolean }} [opts]
 *   - verb: status-message verb (default "書き出し")
 *   - secureExport: run the output through qpdf to strip metadata + rebuild
 *     xref. Applies on BOTH paths — the assembled-export path and the
 *     byte-copy path (unedited source): on the copy path main sanitizes the
 *     source bytes before writing, preserving vectors while removing Info/XMP.
 */
export async function actionExportToPath(
  savePath,
  { verb: verbOverride, secureExport = false, monoExport = false } = {},
) {
  if (!_isOpen()) return;
  const pages = await _fetchVisiblePages();
  if (pages.length === 0) return;
  const projectStore = _projectStore();
  const pendingDeletedPages = _pendingDeletedPages();
  const overlayCount = projectStore.count();
  const meta = await kpdf3.getSourceMeta();
  // byte-copy 可否は共通ゲート byteCopyEligible (exporter.js) に集約
  // (REVIEW-2026-07 #4)。overlay / 削除 (中間=歯抜け・末尾=ページ数比較) /
  // 挿入 / userRotation / 並び替え — いずれか 1 つでもあれば再合成経路へ。
  const isCopy = byteCopyEligible({
    pages,
    overlayCount,
    sourcePageCount: meta?.pageCount ?? null,
    pendingDeleteCount: pendingDeletedPages.size,
  });
  const verb = verbOverride ?? (isCopy ? "コピー" : "書き出し");
  showBusy(`${verb}準備`, "ページを描画しています...", 0);
  try {
    let result;
    if (isCopy) {
      // overlay/削除/挿入が無いので元バイトを流用するが、secureExport=ON の
      // ときは main 側で qpdf を通して Info/XMP を除去する (ベクター維持)。
      updateBusy(secureExport ? "元 PDF をコピー + メタ除去中..." : "元 PDF をコピー中...", 50);
      result = await kpdf3.copySourcePdf(savePath, { secureExport });
    } else {
      const composed = await composePagesForExport({
        pages,
        projectStore,
        renderPage: kpdf3.renderPage,
        renderSyntheticPage: renderSyntheticPagePixels,
        rasterRedactionPages: true,
        monoOverlays: !!monoExport,
        vectorTextProbe: kpdf3.vectorTextProbe, // v2.0.13 ベクターテキスト層
        onProgress: ({ done, total }) => {
          updateBusy(`${done} / ${total} ページを描画中...`, (done / total) * 80);
        },
      });
      updateBusy("PDF を組み立て中...", 90);
      result = await kpdf3.exportPdfRasterized({
        savePath,
        pages: composed,
        secureExport,
      });
    }
    updateBusy("新しいファイルに切り替え中...", 95);
    // 別名保存 (= 元タブの sourcePath と異なるパス) の場合、元タブの
    // workspace / dirty 追跡を破壊しないために新タブで開く。元タブはその
    // まま残るので「元データの編集はまだ未保存」アラートも従来どおり出る。
    // 上書き保存 (同パス) は現タブを更新する従来経路を維持。
    const preTab = getActiveTab();
    const isSaveAs = !!preTab && preTab.activeSourcePdfPath !== savePath;
    // ADR-0026: 確定 overwrite (再合成=フラット化) のとき、いま編集していた
    // workspace を「編集可能マスター」として温存し、開き直す新フラット
    // workspace に predecessor として紐づける。byte-copy (isCopy=編集なし)
    // は fingerprint 不変で同一 workspace を再利用するので紐づけ不要。
    let flattenedMasterAvailable = false;
    try {
      if (isSaveAs) {
        // 新タブで保存先 PDF を開く。元タブの projectStore / workspaceMutated /
        // pendingDeletedPages は触らない。
        await newTabAndOpen(savePath);
      } else {
        const opened = await kpdf3.openPdfFile(
          savePath,
          getActiveTabId(),
          isCopy ? null : { linkPredecessorFromActive: true },
        );
        flattenedMasterAvailable = !!opened.hasEditableMaster;
        projectStore.reset(opened.overlays ?? []);
        pendingDeletedPages.clear();
        _setWorkspaceMutated(false);
        const thumbSelection = _thumbSelection();
        thumbSelection.pageNos.clear();
        thumbSelection.anchor = null;
        _history().clear();
        // 上書き保存 (= 同パス) なので tab.activeSourcePdfPath は不変だが
        // 念のため明示更新 (race / 旧状態防止)。
        const tab = getActiveTab();
        if (tab) {
          tab.activeSourcePdfPath = savePath;
          tab.activeSourceName = savePath.split(/[\\/]/).pop() ?? "";
        }
        await _refreshViewer();
      }
    } catch (switchErr) {
      console.error("[renderer] post-save workspace switch failed:", switchErr);
    }
    hideBusy();
    wsStatus.textContent = flattenedMasterAvailable
      ? `${verb}しました — あとで［編集に戻す］で編集内容に戻せます`
      : `${verb}しました（rev ${result.revisionId.slice(0, 8)}）`;
    // ADR-0026: 確定でフラット化したら「編集に戻す」ボタン/メニューを点灯。
    void refreshRestoreMasterUI();
    if (secureExport && result?.qpdfMissing) {
      // User asked for sanitize but the qpdf binary wasn't found. Warn
      // post-hoc so they know the file went out un-scrubbed.
      await customConfirm({
        title: "セキュア書き出し: qpdf 未検出",
        message:
          "qpdf バイナリが見つからなかったため、個人情報の消去をスキップして\n"
          + "通常の書き出しを行いました。\n\n"
          + "通常版がパッケージから外れている可能性があります。",
        okLabel: "閉じる",
        cancelLabel: null,
      });
    }
  } catch (err) {
    hideBusy();
    console.error(`[renderer] ${verb} failed:`, err);
    wsStatus.textContent = `${verb}失敗: ${err.message ?? err}`;
  }
}

/**
 * ADR-0026「戻せる確定」— swap the active (flattened / 確定版) tab back onto
 * its editable master so overlays become movable/editable again. The on-disk
 * flat PDF is left untouched; the tab stays anchored to it so a re-確定
 * overwrites the same file and re-links a fresh master.
 */
export async function actionRestoreEditableMaster() {
  if (!_isOpen()) return;
  let res;
  try {
    res = await kpdf3.restoreEditableMaster(getActiveTabId());
  } catch (err) {
    console.error("[renderer] restore-editable-master failed:", err);
    wsStatus.textContent = `編集可能な状態に戻せませんでした: ${err.message ?? err}`;
    return;
  }
  if (!res || !res.ok) {
    await customConfirm({
      title: "編集可能な状態に戻せません",
      message: res?.reason === "missing"
        ? "この確定版の元になった編集可能な状態が、この PC に見つかりませんでした。\n"
          + "（別の PC で確定した、またはアプリ内データが削除された可能性があります）\n\n"
          + "ディスク上のファイルはそのまま開けます。"
        : "このファイルには、戻せる編集可能な状態がありません。",
      okLabel: "閉じる",
      cancelLabel: null,
    });
    return;
  }
  // Rebind live state onto the restored master (mirrors openPdfPath).
  _projectStore().reset(res.overlays ?? []);
  _pendingDeletedPages().clear();
  _setWorkspaceMutated(false);
  const thumbSelection = _thumbSelection();
  thumbSelection.pageNos.clear();
  thumbSelection.anchor = null;
  _history().clear();
  const tab = getActiveTab();
  if (tab && res.pdfPath) {
    tab.activeSourcePdfPath = res.pdfPath;
    tab.activeSourceName = res.pdfPath.split(/[\\/]/).pop() ?? "";
  }
  await _refreshViewer();
  renderTabBar();
  _refreshDirtyIndicator();
  _refreshMenuState();
  void refreshRestoreMasterUI();
  wsStatus.textContent =
    "編集可能な状態に戻しました — テキスト・印影などをまた動かせます";
}

/**
 * ADR-0026: enable / disable the「編集に戻す」toolbar button + File-menu item
 * for the active tab. Called on every viewer refresh (covers open, tab switch,
 * restore, 確定) so a tab switch to a 確定版 lights the affordance without an
 * open-pdf-file round-trip. Async (queries main) but fire-and-forget safe.
 */
export async function refreshRestoreMasterUI() {
  let hasMaster = false;
  let masterMissing = false;
  try {
    if (_isOpen()) {
      const info = await kpdf3.getEditableMasterInfo();
      hasMaster = !!info?.hasEditableMaster;
      masterMissing = !!info?.masterMissing;
    }
  } catch { /* best-effort — leave disabled on error */ }
  if (btnRestoreMaster) btnRestoreMaster.disabled = !hasMaster;
  try { _setMenuEnabled({ "restore-editable-master": hasMaster }); }
  catch { /* menuBar not ready during early boot */ }
  refreshDocStateField(hasMaster, masterMissing);
}

/**
 * REVIEW-2026-07 #9: 確定版 / 下書きのステータスバー常時表示。開いた
 * 瞬間の案内 (wsStatus) は次の操作メッセージで流れてしまうため、タブを
 * 多数開く業務でも「今どちらを触っているか」を固定フィールドで示す。
 * 表示のみの追加で保存コアには触らない。
 */
function refreshDocStateField(hasMaster, masterMissing) {
  if (!docStateField) return;
  if (!_isOpen()) {
    docStateField.hidden = true;
    return;
  }
  docStateField.hidden = false;
  if (hasMaster) {
    docStateField.textContent = "確定版〔戻せます〕";
    docStateField.title =
      "このファイルは確定保存された確定版です。［編集に戻す］でテキスト等をまた動かせます";
  } else if (masterMissing) {
    docStateField.textContent = "確定版〔編集用データなし〕";
    docStateField.title =
      "確定版ですが、編集可能な状態がこの PC に見つかりません（別の PC で確定した可能性があります）";
  } else {
    docStateField.textContent = "下書き";
    docStateField.title =
      "編集中の状態です。他のアプリにも内容を反映するには上書き保存（確定）します";
  }
}
