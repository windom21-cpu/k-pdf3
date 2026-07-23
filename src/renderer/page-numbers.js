// ＋ページ番号 (bulk page-number overlays) — S6 リファクタ (REVIEW-2026-07 #8)
// その5で renderer.js から抽出。ロジックは移動のみで不変。
//
//   openPageNumbersDialog / closePageNumbersDialog — ダイアログ開閉
//   applyPageNumbers — 全可視ページのフッターに text overlay を一括追加
//   β.119 プリセット永続化 (localStorage) / β.116 実測幅ベースの配置 /
//   β.120-121 太字 + enforceHairline
//
// State (isOpen, projectStore, history, pendingDeletedPages) は renderer.js
// が所有し、initPageNumbers の getter 注入で参照する (§4.4 パターン 1)。

import { AddOverlayCommand } from "../domain/commands.js";
import { getTextFontStack } from "./fonts.js";
import { measureTextOverlaySize } from "./overlay-edit.js";
import { currentTextFontId } from "./overlay-placement.js";

const { kpdf3 } = window;
const $ = (id) => document.getElementById(id);
const wsStatus = $("ws-status");

let _isOpen = () => false;
let _projectStore = () => null;
let _history = () => null;
let _pendingDeletedPages = () => new Set();

export function initPageNumbers({ isOpen, projectStore, history, pendingDeletedPages }) {
  _isOpen = isOpen;
  _projectStore = projectStore;
  _history = history;
  _pendingDeletedPages = pendingDeletedPages;
}

// ---- ＋ページ番号: bulk add page-number text overlays ------------------
//
// One-shot operation that drops a small text overlay at the footer of
// every non-deleted page. Each overlay is a regular `text` overlay so
// the user can drag / resize / delete individual ones afterwards. The
// whole insertion is a single Undo step (history.execute on a batch
// of AddOverlayCommands inside one history transaction is overkill —
// for now we push them as individual commands and merge later if the
// undo experience demands it).

const pageNumDialog = () => $("page-numbers-dialog");

// β.119: ページ番号ダイアログのプリセット永続化。前回入力した
// position / format / start / fontSize / font を localStorage に
// 保存し、次回ダイアログを開いた時に各 select / input を復元する。
// fontSize は number input、他は select 値。値が select の有効
// option (or system フォントとして追加された値) と一致しない場合は
// 何もせず HTML 既定値のままにする。
const PAGE_NUMBERS_LS = {
  position: "kpdf3.pageNumbers.position",
  format:   "kpdf3.pageNumbers.format",
  start:    "kpdf3.pageNumbers.start",
  fontSize: "kpdf3.pageNumbers.fontSize",
  font:     "kpdf3.pageNumbers.font",
  bold:     "kpdf3.pageNumbers.bold",
};

function _restorePageNumbersPresets() {
  const setSel = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    const v = localStorage.getItem(key);
    if (v == null) return;
    // option リストに該当があれば設定 (system フォントは page-numbers-font に
    // 動的追加されているはずなので、await tick 後の呼出で hit する)。
    if (el.tagName === "SELECT") {
      if (Array.from(el.options).some((o) => o.value === v)) el.value = v;
    } else {
      el.value = v;
    }
  };
  setSel("page-numbers-position", PAGE_NUMBERS_LS.position);
  setSel("page-numbers-format",   PAGE_NUMBERS_LS.format);
  setSel("page-numbers-start",    PAGE_NUMBERS_LS.start);
  setSel("page-numbers-fontsize", PAGE_NUMBERS_LS.fontSize);
  setSel("page-numbers-font",     PAGE_NUMBERS_LS.font);
  // β.120: 太字チェックの復元 (checkbox は value ではなく checked を見る)。
  const boldEl = document.getElementById("page-numbers-bold");
  if (boldEl) {
    const v = localStorage.getItem(PAGE_NUMBERS_LS.bold);
    if (v != null) boldEl.checked = v === "1";
  }
}

function _savePageNumbersPresets() {
  const save = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    const v = String(el.value ?? "");
    if (v) {
      try { localStorage.setItem(key, v); } catch { /* ignore */ }
    }
  };
  save("page-numbers-position", PAGE_NUMBERS_LS.position);
  save("page-numbers-format",   PAGE_NUMBERS_LS.format);
  save("page-numbers-start",    PAGE_NUMBERS_LS.start);
  save("page-numbers-fontsize", PAGE_NUMBERS_LS.fontSize);
  save("page-numbers-font",     PAGE_NUMBERS_LS.font);
  // β.120: 太字チェック (checkbox は checked を 1/0 で保存)。
  const boldEl = document.getElementById("page-numbers-bold");
  if (boldEl) {
    try {
      localStorage.setItem(PAGE_NUMBERS_LS.bold, boldEl.checked ? "1" : "0");
    } catch { /* ignore */ }
  }
}

function openPageNumbersDialog() {
  if (!_isOpen()) return;
  _restorePageNumbersPresets();
  pageNumDialog().hidden = false;
}
function closePageNumbersDialog() {
  pageNumDialog().hidden = true;
}

/** Format a single page number per the chosen template. */
function formatPageNumber(format, n, total) {
  switch (format) {
    case "-N-":  return `- ${n} -`;
    case "p.N":  return `p.${n}`;
    case "N/T":  return `${n} / ${total}`;
    case "N":
    default:     return String(n);
  }
}

async function applyPageNumbers() {
  const position = $("page-numbers-position").value;
  const format   = $("page-numbers-format").value;
  const start    = Math.max(1, Number($("page-numbers-start").value) || 1);
  const fontSize = Math.max(6, Math.min(36, Number($("page-numbers-fontsize").value) || 11));
  // β.116: フォントを page-numbers-font select から取得 (preset + system フォント)
  const fontId = $("page-numbers-font")?.value || currentTextFontId();
  // β.120 → β.121: 太字デフォを OFF に変更。代わりに太字 OFF のとき
  // properties.enforceHairline = true を埋め込んで、exporter で β.76 の
  // hairline 補強 (0.02×fontSize) をフォントに依らず適用させる。これで
  // 「細字 (=見た目細い)」のまま「印刷時は濃く出る」両立が可能。
  const boldOn = $("page-numbers-bold")?.checked ?? false;
  const allPages = await kpdf3.getPages();
  const visible  = allPages.filter((p) => !_pendingDeletedPages().has(p.pageNo));
  if (visible.length === 0) {
    wsStatus.textContent = "ページがありません";
    closePageNumbersDialog();
    return;
  }
  // Footer y = paper height − margin. Margin held to ~24pt so the
  // number sits inside the bottom margin without pushing into body.
  const FOOTER_MARGIN = 24;

  let added = 0;
  for (let i = 0; i < visible.length; i++) {
    const row  = visible[i];
    const cw   = row.cropW ?? row.width ?? 595;
    const ch   = row.cropH ?? row.height ?? 842;
    const userRot = (((row.userRotation ?? 0) % 360) + 360) % 360;
    const swap = userRot === 90 || userRot === 270;
    // Canonical (post-rotation) page extents.
    const pageW = swap ? ch : cw;
    const pageH = swap ? cw : ch;
    const text = formatPageNumber(format, start + i, visible.length);
    // β.116: 旧 W = max(60, fontSize*8) では「中央」配置時にテキストが
    // ボックス左寄せのため視覚的に左寄りになっていた (ユーザー報告)。
    // measureTextOverlaySize で実テキスト幅を測定 → ボックス幅をそれに
    // 合わせると、テキスト自体が中央に座る。
    // β.117 hotfix: β.116 で measureTextOverlaySize を object 引数で呼んで
    // いた (実際は positional: (text, fontSize, fontFamily, currentW))。
    // 第 1 引数 text に object が入って split で TypeError → ループ abort
    // → 「配置」ボタン無反応の原因。getTextFontStack で CSS family を
    // 生成して positional に渡し、measure 失敗時は固定 W で fallback。
    let W;
    let H;
    try {
      const fontFamily = getTextFontStack(fontId, { digitsHanko: false });
      const measured = measureTextOverlaySize(text, fontSize, fontFamily, 0);
      // β.120: 太字 ON で overstroke ぶんわずかに横に広がる可能性があるため
      // measured.w + 太字補正で余裕を持たせる (1pt 程度の overstroke 想定)。
      const pad = boldOn ? 6 : 4;
      W = Math.max(20, Math.ceil(measured.w) + pad);
      H = Math.max(fontSize, Math.ceil(measured.h));
    } catch (err) {
      console.warn("[applyPageNumbers] measureTextOverlaySize failed, using fixed W:", err);
      W = Math.max(60, fontSize * 8);
      H = Math.max(fontSize, Math.round(fontSize * 1.4));
    }
    // x by alignment; y from bottom.
    let x;
    if (position === "left")        x = 36;
    else if (position === "right")  x = pageW - 36 - W;
    else                            x = (pageW - W) / 2;
    const y = pageH - FOOTER_MARGIN - H;
    const cmd = new AddOverlayCommand(_projectStore(), {
      pageNo: row.pageNo,
      type: "text",
      x, y, w: W, h: H, zOrder: 0,
      properties: {
        text,
        fontSize,
        color: "#000000",
        fontId,
        digitsHanko: false, // ページ番号は数字主体なので hanko は OFF (= 明示)
        bold: boldOn,
        // β.121: 太字 OFF のときだけ enforceHairline を立てて、exporter で
        // β.76 の hairline 補強をフォント非依存に適用させる。太字 ON のとき
        // は β.73 overstroke が効くので enforceHairline 不要。
        enforceHairline: !boldOn,
        rotation: 0,
      },
    });
    _history().execute(cmd);
    added += 1;
  }
  wsStatus.textContent = `${added} ページにページ番号を追加`;
  // β.119: プリセットとして次回開く時に復元できるよう localStorage に保存。
  _savePageNumbersPresets();
  closePageNumbersDialog();
}

$("btn-page-numbers")?.addEventListener("click", openPageNumbersDialog);
$("page-numbers-ok")?.addEventListener("click", () => { void applyPageNumbers(); });
$("page-numbers-cancel")?.addEventListener("click", closePageNumbersDialog);
pageNumDialog()?.addEventListener("click", (e) => {
  if (e.target === pageNumDialog()) closePageNumbersDialog();
});
