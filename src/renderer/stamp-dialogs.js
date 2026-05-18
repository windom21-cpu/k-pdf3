// Stamp manager + register dialogs (date / text / image), font-defaults
// dialog, generic preview painter, and the 試し置き (trial placement)
// flow that lets the user pin a draft of an image stamp onto the live
// PDF while editing the register dialog.
//
// Manager / register dialogs and trial placement are kept in one module
// because the image register dialog and the trial flow share state
// bidirectionally — the image dialog drives the trial bitmap + dims,
// the trial commits dialog look changes back to the dialog inputs, and
// the close paths cross-fire (closeStampRegisterImage tears down trial
// state; commit-from-trial restores the dialog).
//
// Public API:
//   initStampDialogs({...})   — wire renderer-owned state in
//   openStampManagerDialog()  — entry from menu / palette mgr buttons
//   placeStampTrial(pageNo, x, y, pageEl) — dispatched by handlePagePointerDown
//   clearStampTrial()         — refreshViewer drops the pinned trial pre-rebuild
//   reattachStampTrial()      — applyZoom rebuilds page DOMs and re-pins trial
//   isStampTrialPlacing()     — stamp-presets reads to suppress its ghost cursor

import {
  STAMP_FONT_STACKS,
  STAMP_FONT_LABELS,
  getStampFontDefaults,
  setStampFontDefaults,
  getStampFontStack,
} from "./fonts.js";
import { customConfirm } from "./dialogs.js";
import { showFileBrowser } from "./file-browser.js";
import {
  setupHiDPICanvas,
  canvasLogicalSize,
  tintCanvasInPlace,
  drawStampMixedText,
  renderDateText,
} from "./stamp-helpers.js";
import {
  setActiveStampPreset,
  refreshStampPresetCacheAndSelect,
  iterStampPresets,
  getStampPresetCount,
  hideStampGhost,
} from "./stamp-presets.js";

const { kpdf3 } = window;
const $ = (id) => document.getElementById(id);

let _viewer = null;
let _viewerContainer = null;
let _wsStatus = null;
let _isOpen = () => false;
let _setPlacementMode = () => {};

export function initStampDialogs({
  viewer,
  viewerContainer,
  wsStatus,
  isOpen,
  setPlacementMode,
}) {
  _viewer = viewer;
  _viewerContainer = viewerContainer;
  _wsStatus = wsStatus;
  _isOpen = isOpen;
  _setPlacementMode = setPlacementMode;
}

// ---- Stamp manager dialog ---------------------------------------------

const stampMgrDialog = $("stamp-manager-dialog");
const stampMgrList = $("stamp-mgr-list");

export function openStampManagerDialog() {
  if (!_isOpen()) return;
  populateStampMgrList();
  stampMgrDialog.hidden = false;
}
function closeStampManagerDialog() { stampMgrDialog.hidden = true; }

$("stamp-mgr-close")?.addEventListener("click", closeStampManagerDialog);
stampMgrDialog?.addEventListener("click", (e) => {
  if (e.target === stampMgrDialog) closeStampManagerDialog();
});
$("stamp-mgr-date")?.addEventListener("click", () => openStampRegisterDate());
$("stamp-mgr-text")?.addEventListener("click", () => openStampRegisterText());
$("stamp-mgr-image")?.addEventListener("click", () => openStampRegisterImage());
$("stamp-mgr-font")?.addEventListener("click", () => openStampFontDialog());

async function populateStampMgrList() {
  stampMgrList.innerHTML = "";
  await refreshStampPresetCacheAndSelect();
  if (getStampPresetCount() === 0) {
    const li = document.createElement("li");
    li.className = "stamp-mgr-list-empty";
    li.textContent = "(まだ登録されていません)";
    stampMgrList.appendChild(li);
    return;
  }
  // β.85: 並び順変更用に id 配列を確定。▲ ▼ で隣と入れ替えて
  // setStampPresetsOrder に流し、再描画。
  const orderedIds = [];
  for (const p of iterStampPresets()) orderedIds.push(p.id);
  const presets = [...iterStampPresets()];
  const last = presets.length - 1;

  const moveTo = async (from, to) => {
    if (to < 0 || to > last) return;
    const [moved] = orderedIds.splice(from, 1);
    orderedIds.splice(to, 0, moved);
    await kpdf3.setStampPresetsOrder(orderedIds);
    await populateStampMgrList();
  };

  for (let i = 0; i < presets.length; i++) {
    const p = presets[i];
    const li = document.createElement("li");
    const lab = document.createElement("span");
    lab.className = "stamp-mgr-label";
    const kindLabel = p.kind === "date" ? "日付" : p.kind === "text" ? "文字" : "画像";
    lab.textContent = `${kindLabel}: ${p.label}`;
    li.appendChild(lab);

    const upBtn = document.createElement("button");
    upBtn.textContent = "▲";
    upBtn.title = "上へ移動";
    upBtn.disabled = i === 0;
    upBtn.addEventListener("click", () => moveTo(i, i - 1));
    li.appendChild(upBtn);

    const downBtn = document.createElement("button");
    downBtn.textContent = "▼";
    downBtn.title = "下へ移動";
    downBtn.disabled = i === last;
    downBtn.addEventListener("click", () => moveTo(i, i + 1));
    li.appendChild(downBtn);

    const useBtn = document.createElement("button");
    useBtn.textContent = "使う";
    useBtn.addEventListener("click", () => {
      setActiveStampPreset(p.id);
      _setPlacementMode("stamp");
      closeStampManagerDialog();
    });
    li.appendChild(useBtn);
    const editBtn = document.createElement("button");
    editBtn.textContent = "編集";
    editBtn.addEventListener("click", () => {
      closeStampManagerDialog();
      openStampRegisterForEdit(p);
    });
    li.appendChild(editBtn);
    const delBtn = document.createElement("button");
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", async () => {
      const ok = await customConfirm({
        title: "スタンプ削除",
        message: `「${p.label}」を削除しますか？`,
        okLabel: "削除",
      });
      if (!ok) return;
      await kpdf3.removeStampPreset(p.id);
      await populateStampMgrList();
    });
    li.appendChild(delBtn);
    stampMgrList.appendChild(li);
  }
}

// ---- スタンプ用フォント設定 dialog (ADR-0019 後半 MVP) ------------------

const stampFontDialog = $("stamp-font-dialog");
const stampFontFullSel = $("stamp-font-full");
const stampFontHalfSel = $("stamp-font-half");
const stampFontPreview = $("stamp-font-preview");

function populateStampFontSelects() {
  if (!stampFontFullSel || !stampFontHalfSel) return;
  for (const sel of [stampFontFullSel, stampFontHalfSel]) {
    sel.innerHTML = "";
    for (const id of Object.keys(STAMP_FONT_STACKS)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = STAMP_FONT_LABELS[id] ?? id;
      sel.appendChild(opt);
    }
  }
}
export function openStampFontDialog() {
  populateStampFontSelects();
  const cur = getStampFontDefaults();
  stampFontFullSel.value = cur.full;
  stampFontHalfSel.value = cur.half;
  paintStampFontPreview();
  stampFontDialog.hidden = false;
}
function closeStampFontDialog() { stampFontDialog.hidden = true; }
function paintStampFontPreview() {
  if (!stampFontPreview) return;
  const ctx = stampFontPreview.getContext("2d");
  const W = stampFontPreview.width;
  const H = stampFontPreview.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#cccccc";
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  const fullStack = getStampFontStack(stampFontFullSel.value);
  const halfStack = getStampFontStack(stampFontHalfSel.value);
  const sample = "令和8年5月10日";
  drawStampMixedText(ctx, sample, W / 2, H / 2, 22, "#cc0000", fullStack, halfStack);
}
stampFontFullSel?.addEventListener("change", paintStampFontPreview);
stampFontHalfSel?.addEventListener("change", paintStampFontPreview);
$("stamp-font-cancel")?.addEventListener("click", closeStampFontDialog);
stampFontDialog?.addEventListener("click", (e) => {
  if (e.target === stampFontDialog) closeStampFontDialog();
});
$("stamp-font-ok")?.addEventListener("click", () => {
  setStampFontDefaults({
    full: stampFontFullSel.value,
    half: stampFontHalfSel.value,
  });
  closeStampFontDialog();
  // Re-render the viewer so existing stamp overlays pick up the new
  // font defaults immediately. exporter & ghost preview re-read on
  // next call so they don't need explicit invalidation.
  if (_viewer) _viewer.refreshAllOverlays?.();
});

// ---- Generic stamp preview painter (used by all 3 register dialogs) ----

function paintStampPreview(canvas, props) {
  const ctx = canvas.getContext("2d");
  const { W, H } = canvasLogicalSize(canvas);
  ctx.clearRect(0, 0, W, H);
  // Centered; preview canvas is small so we draw at a fixed scale.
  const pad = 4;
  const innerW = W - pad * 2;
  const innerH = H - pad * 2;
  // White paper backdrop.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#cccccc";
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  // Stamp content
  ctx.save();
  if (props.kind === "image" && props.bitmap) {
    // Fit image preserving aspect ratio.
    const bw = props.bitmap.width, bh = props.bitmap.height;
    const scale = Math.min(innerW / bw, innerH / bh);
    const w = bw * scale, h = bh * scale;
    const dx = (W - w) / 2, dy = (H - h) / 2;
    if (props.color) {
      // Draw a tinted preview by composing onto an offscreen canvas
      // (luminance → alpha + RGB ← color), then copying the result.
      const off = document.createElement("canvas");
      off.width = bw;
      off.height = bh;
      const octx = off.getContext("2d");
      octx.drawImage(props.bitmap, 0, 0);
      tintCanvasInPlace(octx, props.color);
      ctx.drawImage(off, dx, dy, w, h);
    } else {
      ctx.drawImage(props.bitmap, dx, dy, w, h);
    }
    if (props.frame === "rect") {
      ctx.strokeStyle = props.color || "#000000";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(dx, dy, w, h);
    } else if (props.frame === "circle") {
      ctx.beginPath();
      ctx.ellipse(W / 2, H / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.strokeStyle = props.color || "#000000";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  // Text-bearing preview (date / text)
  ctx.fillStyle = props.color;
  ctx.strokeStyle = props.color;
  ctx.lineWidth = 1.5;
  ctx.font = `bold ${props.fontSize}px "MS UI Gothic", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const text = props.text ?? "";
  const metrics = ctx.measureText(text);
  const textW = metrics.width;
  const boxW = props.frame === "circle"
    ? Math.max(textW + 16, props.fontSize * 2.4)
    : Math.max(textW + 16, props.fontSize * 1.5);
  const boxH = props.frame === "circle"
    ? boxW
    : Math.max(props.fontSize + 12, props.fontSize * 1.6);
  const fitScale = Math.min(innerW / boxW, innerH / boxH, 1);
  const w = boxW * fitScale, h = boxH * fitScale;
  const cx = W / 2, cy = H / 2;
  if (props.frame === "circle") {
    ctx.beginPath();
    ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (props.frame === "rect") {
    ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
  }
  // distribute-2 / distribute-3: tokens at box edges, matching the
  // actual placed stamp's space-between layout (viewer.js / exporter.js).
  // Without this the preview shows a centred single text line that
  // doesn't reflect how the stamp will actually print on a preprinted
  // 「  年  月  日」form.
  if (props.spacingMode === "distribute-2" || props.spacingMode === "distribute-3") {
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 1) {
      ctx.fillText(tokens[0], cx, cy);
    } else {
      const left = cx - w / 2 + 4 * fitScale;
      const right = cx + w / 2 - 4 * fitScale;
      for (let i = 0; i < tokens.length; i++) {
        let tx, align;
        if (i === 0) { tx = left; align = "left"; }
        else if (i === tokens.length - 1) { tx = right; align = "right"; }
        else { tx = left + ((right - left) * i) / (tokens.length - 1); align = "center"; }
        ctx.textAlign = align;
        ctx.fillText(tokens[i], tx, cy);
      }
    }
  } else {
    ctx.fillText(text, cx, cy);
  }
  ctx.restore();
}

// ---- 日付スタンプ register dialog --------------------------------------

const stampRegDateDialog = $("stamp-register-date");
const stampRegDateColor = $("stamp-reg-date-color");
const stampRegDateFrame = $("stamp-reg-date-frame");
const stampRegDateLabel = $("stamp-reg-date-label");
const stampRegDateFontSize = $("stamp-reg-date-fontsize");
const stampRegDatePreview = $("stamp-reg-date-preview");
if (stampRegDatePreview) setupHiDPICanvas(stampRegDatePreview, 180, 60);
// id of the preset currently being edited (vs. created); null on create.
let _editingPresetId = null;

function openStampRegisterDate(prefill = null) {
  _editingPresetId = prefill?.id ?? null;
  const fmt = prefill?.text ?? "date-numeric-dash";
  const radio = document.querySelector(`input[name="stamp-date-format"][value="${fmt}"]`);
  if (radio) radio.checked = true;
  else document.querySelector('input[name="stamp-date-format"][value="date-numeric-dash"]').checked = true;
  stampRegDateColor.value = prefill?.color ?? "#cc0000";
  stampRegDateFrame.checked = prefill ? prefill.frame !== "none" : true;
  stampRegDateLabel.value = prefill?.label ?? "";
  if (stampRegDateFontSize) {
    stampRegDateFontSize.value = String(prefill?.fontSize ?? 14);
  }
  stampRegDateDialog.hidden = false;
  paintStampRegDatePreview();
}

/** Open the matching register dialog for an existing preset, prefilled
 *  with its current values. Used by the スタンプ管理 list's 編集 btn. */
function openStampRegisterForEdit(p) {
  if (p.kind === "date") openStampRegisterDate(p);
  else if (p.kind === "text") openStampRegisterText(p);
  else if (p.kind === "image") openStampRegisterImage(p);
}
function closeStampRegisterDate() { stampRegDateDialog.hidden = true; }
function getDateRegFormatKey() {
  const r = document.querySelector('input[name="stamp-date-format"]:checked');
  return r?.value ?? "date-numeric-dash";
}
function paintStampRegDatePreview() {
  const formatKey = getDateRegFormatKey();
  const fs = Math.max(6, Math.min(72, Number(stampRegDateFontSize?.value) || 14));
  let spacingMode;
  if (formatKey === "date-numeric-spaced") spacingMode = "distribute-3";
  else if (formatKey === "date-numeric-spaced-2") spacingMode = "distribute-2";
  paintStampPreview(stampRegDatePreview, {
    text: renderDateText(formatKey),
    color: stampRegDateColor.value,
    frame: stampRegDateFrame.checked ? "rect" : "none",
    fontSize: fs,
    spacingMode,
  });
}
stampRegDateDialog?.addEventListener("change", paintStampRegDatePreview);
stampRegDateDialog?.addEventListener("input", paintStampRegDatePreview);
$("stamp-reg-date-cancel")?.addEventListener("click", closeStampRegisterDate);
stampRegDateDialog?.addEventListener("click", (e) => {
  if (e.target === stampRegDateDialog) closeStampRegisterDate();
});
$("stamp-reg-date-ok")?.addEventListener("click", async () => {
  const formatKey = getDateRegFormatKey();
  const formatLabels = {
    "date-numeric-dash": "-8.-5.-9",
    "date-numeric-fw": "-8．-5．-9",
    "date-kanji-dash": "令和-8年-5月-9日",
    "date-numeric-spaced": "-8 -5 -9 (字間調整)",
    "date-numeric-spaced-2": "-8 -5 (年月のみ・字間調整)",
  };
  const label = stampRegDateLabel.value.trim() || formatLabels[formatKey] || "日付";
  const fontSize = Math.max(6, Math.min(72, Number(stampRegDateFontSize?.value) || 14));
  // distribute-3 / distribute-2 need a width that matches the dialog's
  // preview — the previous fixed-90pt default put the leftmost/right-
  // most token way out at the box edges, well wider than the centred
  // preview. Measure the natural rendered width at the actual font /
  // size so the placed stamp matches the preview by default. Users
  // can still drag-resize the box wider afterwards — distribute spreads
  // the tokens evenly across the new width to fit preprinted
  //「  年  月  日」forms.
  let finalWidth;
  if (formatKey === "date-numeric-spaced" || formatKey === "date-numeric-spaced-2") {
    const probe = document.createElement("canvas");
    const ctx = probe.getContext("2d");
    const { half } = getStampFontDefaults();
    ctx.font = `bold ${fontSize}px ${getStampFontStack(half)}`;
    const m = ctx.measureText(renderDateText(formatKey));
    finalWidth = Math.max(20, Math.ceil(m.width + 6));
  } else {
    // Box width scales with fontSize so a 24pt date doesn't overflow
    // a 14pt-sized box. Base widths were tuned for fontSize 14.
    const baseWidth = formatKey === "date-kanji-dash" ? 140 : 105;
    finalWidth = Math.round(baseWidth * (fontSize / 14));
  }
  await kpdf3.addStampPreset({
    id: _editingPresetId, // null on create, existing id on edit (upsert)
    kind: "date",
    label,
    color: stampRegDateColor.value,
    frame: stampRegDateFrame.checked ? "rect" : "none",
    fontSize,
    text: formatKey, // store the format spec, render the date at placement
    width: finalWidth,
    height: Math.round(40 * (fontSize / 14)),
  });
  _editingPresetId = null;
  closeStampRegisterDate();
  await populateStampMgrList();
  // Reopen manager so the user sees the updated entry without a 2-step
  // (otherwise they'd have to re-open the menu).
  openStampManagerDialog();
});

// ---- テキストスタンプ register dialog ----------------------------------

const stampRegTextDialog = $("stamp-register-text");
const stampRegTextText = $("stamp-reg-text-text");
const stampRegTextFontSize = $("stamp-reg-text-fontsize");
const stampRegTextColor = $("stamp-reg-text-color");
const stampRegTextFrame = $("stamp-reg-text-frame");
const stampRegTextLabel = $("stamp-reg-text-label");
const stampRegTextPreview = $("stamp-reg-text-preview");
if (stampRegTextPreview) setupHiDPICanvas(stampRegTextPreview, 180, 60);

function openStampRegisterText(prefill = null) {
  _editingPresetId = prefill?.id ?? null;
  stampRegTextText.value = prefill?.text ?? "";
  stampRegTextFontSize.value = String(prefill?.fontSize ?? 14);
  stampRegTextColor.value = prefill?.color ?? "#cc0000";
  stampRegTextFrame.checked = prefill ? prefill.frame !== "none" : true;
  stampRegTextLabel.value = prefill?.label ?? "";
  stampRegTextDialog.hidden = false;
  paintStampRegTextPreview();
  setTimeout(() => stampRegTextText.focus(), 0);
}
function closeStampRegisterText() { stampRegTextDialog.hidden = true; }
function paintStampRegTextPreview() {
  paintStampPreview(stampRegTextPreview, {
    text: stampRegTextText.value || "テキスト",
    color: stampRegTextColor.value,
    frame: stampRegTextFrame.checked ? "rect" : "none",
    fontSize: Number(stampRegTextFontSize.value) || 14,
  });
}
stampRegTextDialog?.addEventListener("input", paintStampRegTextPreview);
stampRegTextDialog?.addEventListener("change", paintStampRegTextPreview);
$("stamp-reg-text-cancel")?.addEventListener("click", closeStampRegisterText);
stampRegTextDialog?.addEventListener("click", (e) => {
  if (e.target === stampRegTextDialog) closeStampRegisterText();
});
$("stamp-reg-text-ok")?.addEventListener("click", async () => {
  const text = stampRegTextText.value.trim();
  if (!text) {
    _wsStatus.textContent = "テキストを入力してください";
    return;
  }
  const fontSize = Math.max(6, Math.min(72, Number(stampRegTextFontSize.value) || 14));
  await kpdf3.addStampPreset({
    id: _editingPresetId,
    kind: "text",
    label: stampRegTextLabel.value.trim() || text,
    color: stampRegTextColor.value,
    frame: stampRegTextFrame.checked ? "rect" : "none",
    fontSize,
    text,
    // Generous default — text overlay can be resized after placement.
    width: Math.max(60, text.length * fontSize * 0.85),
    height: Math.max(20, fontSize * 1.6),
  });
  _editingPresetId = null;
  closeStampRegisterText();
  await populateStampMgrList();
  openStampManagerDialog();
});

// ---- 画像スタンプ register dialog --------------------------------------

const stampRegImageDialog = $("stamp-register-image");
const stampRegImagePickBtn = $("stamp-reg-image-pick");
const stampRegImageName = $("stamp-reg-image-name");
const stampRegImageW = $("stamp-reg-image-w");
const stampRegImageH = $("stamp-reg-image-h");
const stampRegImageFrame = $("stamp-reg-image-frame");
const stampRegImageColor = $("stamp-reg-image-color");
const stampRegImageLabel = $("stamp-reg-image-label");
const stampRegImagePreview = $("stamp-reg-image-preview");
if (stampRegImagePreview) setupHiDPICanvas(stampRegImagePreview, 180, 120);
const stampRegImageOk = $("stamp-reg-image-ok");
const stampRegImageTrialBtn = $("stamp-reg-image-trial");
let _stampRegImageState = null; // { path, mime, bitmap, naturalW, naturalH, label }
// Trial-stamp placement state (§17.5 "できれば"). _stampTrial is the
// pinned preview canvas + its canonical (x, y, w, h, params) snapshot,
// or null when nothing is pinned. _stampTrialPlacing is true while the
// user has hit "PDF に試し置き" and is hunting for a click position.
let _stampTrial = null;
let _stampTrialPlacing = false;
let _stampTrialCursorEl = null;

/** Public read for stamp-presets — its ghost suppresses itself while
 *  the trial cursor is hunting for a click. */
export function isStampTrialPlacing() {
  return _stampTrialPlacing;
}

async function openStampRegisterImage(prefill = null) {
  // Snapshot the manager dialog visibility ONCE per register-flow entry
  // so the user lands back where they were on 登録 / キャンセル —
  // 試し置き / やり直す cycles inside the flow don't re-snapshot.
  // (β30: was previously captured inside enterStampTrialPlacement, but
  // re-entering placement via 「試し置きをやり直す」 lost the original
  // manager state.)
  _stampTrialPrevDialogState = {
    manager: stampMgrDialog && !stampMgrDialog.hidden,
  };
  if (stampMgrDialog) stampMgrDialog.hidden = true;
  _editingPresetId = prefill?.id ?? null;
  _stampRegImageState = null;
  stampRegImageName.textContent = "(未選択)";
  stampRegImageW.value = String(prefill?.width ?? 80);
  stampRegImageH.value = String(prefill?.height ?? 80);
  stampRegImageFrame.checked = prefill ? prefill.frame !== "none" : false;
  // Tint color: "bg-transparent" is the recommended default for new
  // image stamps — most users want the source image's white background
  // dropped to alpha so the stamp blends with paper, regardless of
  // pixel color. β4 introduced this default; somewhere between then
  // and β28 a refactor set the JS value to "" (which the <select>
  // resolves to 「そのまま（無加工）」), overriding the HTML's own
  // `selected` attribute. Restore the bg-transparent default for new
  // registrations; existing presets are loaded verbatim via prefill.color.
  if (stampRegImageColor) {
    stampRegImageColor.value = prefill?.color ?? "bg-transparent";
  }
  stampRegImageLabel.value = prefill?.label ?? "";
  stampRegImageOk.disabled = !prefill?.assetId;
  if (stampRegImageTrialBtn) {
    stampRegImageTrialBtn.disabled = !prefill?.assetId;
    stampRegImageTrialBtn.textContent = "PDF に試し置き";
  }
  // If editing, fetch the existing asset bitmap for the preview.
  if (prefill?.assetId) {
    try {
      const data = await kpdf3.getAsset(prefill.assetId);
      if (data?.blob) {
        const u8 = data.blob instanceof Uint8Array
          ? data.blob
          : new Uint8Array(data.blob.buffer ?? data.blob);
        const blob = new Blob([u8], { type: data.mime || "image/png" });
        const bitmap = await createImageBitmap(blob);
        _stampRegImageState = {
          assetId: prefill.assetId,
          mime: data.mime,
          bitmap,
          naturalW: bitmap.width,
          naturalH: bitmap.height,
          label: data.label ?? "",
        };
        stampRegImageName.textContent = data.label ?? "(登録済み画像)";
      }
    } catch (err) {
      console.error("[stamp-img] prefill load failed", err);
    }
  }
  paintStampRegImagePreview();
  stampRegImageDialog.hidden = false;
}
function closeStampRegisterImage() {
  clearStampTrial();
  cancelStampTrialPlacement();
  stampRegImageDialog.hidden = true;
  // β30: restore the stamp manager dialog if it had been open before
  // the register flow started. Manager is hidden during the entire
  // register session (including 試し置き / やり直す cycles); this is
  // the natural moment to put the user back where they came from.
  if (_stampTrialPrevDialogState?.manager && stampMgrDialog) {
    stampMgrDialog.hidden = false;
  }
  _stampTrialPrevDialogState = null;
}
function paintStampRegImagePreview() {
  paintStampPreview(stampRegImagePreview, {
    kind: "image",
    bitmap: _stampRegImageState?.bitmap,
    color: stampRegImageColor?.value || "",
    frame: stampRegImageFrame.checked ? "rect" : "none",
  });
}
stampRegImagePickBtn?.addEventListener("click", async () => {
  // Guard against re-entry — β3 testers reported the button feels
  // unresponsive when they click it twice while the file browser is
  // still loading, since two parallel addAssetFromFile round-trips end
  // up racing for the dialog state.
  if (stampRegImagePickBtn.disabled) return;
  stampRegImagePickBtn.disabled = true;
  const originalLabel = stampRegImagePickBtn.textContent;
  const path = await showFileBrowser({
    mode: "open",
    title: "印影画像を選択",
    filterDefault: "image",
  });
  if (!path) {
    stampRegImagePickBtn.disabled = false;
    stampRegImagePickBtn.textContent = originalLabel;
    return;
  }
  // Visible "loading" state — large stamp images (印影 scans 2400×2400
  // are common) take a few hundred ms to read + decode + dedupe, and
  // without feedback the user clicks the button again thinking it
  // didn't register the first click.
  stampRegImagePickBtn.textContent = "読み込み中…";
  stampRegImageName.textContent = "読み込み中…";
  // Read the bytes via the existing addAssetFromFile infrastructure —
  // here we just need to preview, not commit yet. Re-use the asset
  // pipeline by registering tentatively, then if user cancels we leave
  // the asset orphaned (cheap, dedup keeps a single copy of identical
  // images). Could be optimised in a follow-up.
  try {
    const r = await kpdf3.addAssetFromFile({ path });
    const data = await kpdf3.getAsset(r.id);
    if (!data?.blob) throw new Error("asset blob unavailable");
    const u8 = data.blob instanceof Uint8Array
      ? data.blob
      : new Uint8Array(data.blob.buffer ?? data.blob);
    const blob = new Blob([u8], { type: data.mime || "image/png" });
    const bitmap = await createImageBitmap(blob);
    _stampRegImageState = {
      assetId: r.id,
      mime: r.mime,
      bitmap,
      naturalW: bitmap.width,
      naturalH: bitmap.height,
      label: data.label ?? "",
    };
    stampRegImageName.textContent = path.split(/[\\/]/).pop();
    if (!stampRegImageLabel.value) stampRegImageLabel.value = _stampRegImageState.label;
    // Default width = 80 pt; height computed from aspect ratio.
    const w = Number(stampRegImageW.value) || 80;
    const h = Math.round((w * bitmap.height) / bitmap.width);
    stampRegImageH.value = String(h);
    stampRegImageOk.disabled = false;
    if (stampRegImageTrialBtn) stampRegImageTrialBtn.disabled = false;
    paintStampRegImagePreview();
  } catch (err) {
    console.error("[stamp-img] preview failed", err);
    _wsStatus.textContent = `画像読み込み失敗: ${err.message ?? err}`;
    stampRegImageName.textContent = "(失敗)";
  } finally {
    stampRegImagePickBtn.disabled = false;
    stampRegImagePickBtn.textContent = originalLabel;
  }
});
stampRegImageW?.addEventListener("input", () => {
  if (!_stampRegImageState) return;
  const w = Number(stampRegImageW.value) || 0;
  const h = Math.round((w * _stampRegImageState.naturalH) / _stampRegImageState.naturalW);
  stampRegImageH.value = String(h);
  updateStampTrialAppearance();
});
stampRegImageFrame?.addEventListener("change", () => {
  paintStampRegImagePreview();
  updateStampTrialAppearance();
});
stampRegImageColor?.addEventListener("change", () => {
  paintStampRegImagePreview();
  updateStampTrialAppearance();
});
$("stamp-reg-image-cancel")?.addEventListener("click", closeStampRegisterImage);
stampRegImageDialog?.addEventListener("click", (e) => {
  if (e.target === stampRegImageDialog) closeStampRegisterImage();
});
stampRegImageOk?.addEventListener("click", async () => {
  if (!_stampRegImageState) return;
  const w = Math.max(10, Math.min(400, Number(stampRegImageW.value) || 80));
  const h = Math.max(10, Math.min(400, Number(stampRegImageH.value) || 80));
  await kpdf3.addStampPreset({
    id: _editingPresetId,
    kind: "image",
    label: stampRegImageLabel.value.trim() || _stampRegImageState.label || "image",
    color: stampRegImageColor?.value || "",
    frame: stampRegImageFrame.checked ? "rect" : "none",
    fontSize: 14,
    assetId: _stampRegImageState.assetId,
    width: w,
    height: h,
  });
  _editingPresetId = null;
  closeStampRegisterImage();
  await populateStampMgrList();
  openStampManagerDialog();
});

// (Old "image stamp via toolbar select" pathway removed — the スタンプ
// 管理 → 画像スタンプ register dialog is now the sole entry point.)

// ---- 画像スタンプ register dialog: PDF プレ押印 (§17.5 "できれば") ---------
//
// Lets the user pin a transparent preview of the draft image stamp onto
// the actual PDF page from the register dialog, so they can see whether
// the configured (w, h, color, frame) really fits next to the content
// before committing to register the preset. The pinned preview is a
// canvas attached to viewer.pageEls.get(pageNo) — it is NOT a
// projectStore overlay (no undo entry, no export side-effect).

/** Snapshot the dialog's current form state as a flat trial-params object.
 *  Returns null if no image is loaded yet. */
function getStampTrialParams() {
  if (!_stampRegImageState?.bitmap) return null;
  return {
    bitmap: _stampRegImageState.bitmap,
    width: Math.max(10, Math.min(400, Number(stampRegImageW.value) || 80)),
    height: Math.max(10, Math.min(400, Number(stampRegImageH.value) || 80)),
    color: stampRegImageColor?.value || "",
    frame: stampRegImageFrame?.checked ? "rect" : "none",
  };
}

/** Paint the trial bitmap (with tint + frame) onto `canvas` at its full
 *  CSS size — transparent backdrop, no padding, no paper backdrop.
 *  paintStampPreview's dialog-preview behaviour (white paper + grey
 *  border + 4px padding) is wrong for the on-page trial, so this is a
 *  dedicated variant. */
function paintStampTrialCanvas(canvas, params) {
  const ctx = canvas.getContext("2d");
  const { W, H } = canvasLogicalSize(canvas);
  ctx.clearRect(0, 0, W, H);
  if (!params?.bitmap) return;
  const bw = params.bitmap.width;
  const bh = params.bitmap.height;
  // Box w/h is wired to the bitmap aspect ratio in the dialog input
  // logic, so this normally fills the canvas. Use min-scale anyway so a
  // user-forced mismatch letterboxes cleanly instead of stretching.
  const scale = Math.min(W / bw, H / bh);
  const w = bw * scale;
  const h = bh * scale;
  const dx = (W - w) / 2;
  const dy = (H - h) / 2;
  if (params.color) {
    const off = document.createElement("canvas");
    off.width = bw;
    off.height = bh;
    const octx = off.getContext("2d");
    octx.drawImage(params.bitmap, 0, 0);
    tintCanvasInPlace(octx, params.color);
    ctx.drawImage(off, dx, dy, w, h);
  } else {
    ctx.drawImage(params.bitmap, dx, dy, w, h);
  }
  if (params.frame === "rect") {
    ctx.strokeStyle =
      params.color && /^#?[0-9a-fA-F]{6}$/.test(String(params.color))
        ? params.color
        : "#000000";
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, dy + 0.5, w - 1, h - 1);
  }
}

function ensureStampTrialCursor() {
  if (_stampTrialCursorEl) return _stampTrialCursorEl;
  const el = document.createElement("canvas");
  el.className = "stamp-trial-cursor";
  el.hidden = true;
  document.body.appendChild(el);
  _stampTrialCursorEl = el;
  return el;
}

function paintStampTrialCursor(params) {
  const el = ensureStampTrialCursor();
  const z = _viewer.zoom;
  setupHiDPICanvas(el, params.width * z, params.height * z);
  paintStampTrialCanvas(el, params);
}

function onTrialCursorMove(e) {
  if (!_stampTrialPlacing || !_stampTrialCursorEl) return;
  const params = getStampTrialParams();
  if (!params) return;
  const z = _viewer.zoom;
  const w = params.width * z;
  const h = params.height * z;
  _stampTrialCursorEl.style.left = `${e.clientX - w / 2}px`;
  _stampTrialCursorEl.style.top = `${e.clientY - h / 2}px`;
  _stampTrialCursorEl.hidden = false;
}

function onTrialCursorLeave() {
  if (_stampTrialCursorEl) _stampTrialCursorEl.hidden = true;
}

// Capture-phase so this Esc wins over the global keydown handler (which
// would clear selection / placementMode and ignore our trial state).
function onTrialKeydown(e) {
  if (!_stampTrialPlacing) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    e.preventDefault();
    cancelStampTrialPlacement();
  }
}

// Remember which stamp-related dialogs were open when 試し置き started
// so we can restore the prior dialog stack on exit. β15 testers
// reported that after pressing 試し置き the stamp manager (which had
// been open behind the register dialog) remained visible and blocked
// clicks on the PDF.
let _stampTrialPrevDialogState = null;

function enterStampTrialPlacement() {
  const params = getStampTrialParams();
  if (!params) {
    _wsStatus.textContent = "先に画像を選択してください";
    return;
  }
  if (!_isOpen()) {
    _wsStatus.textContent = "PDF を開いてから試し置きしてください";
    return;
  }
  _stampTrialPlacing = true;
  // Hide the register dialog so the user can target the PDF. Manager
  // is already hidden by openStampRegisterImage; the snapshot taken
  // there survives through 試し置き / やり直す cycles.
  if (stampRegImageDialog) stampRegImageDialog.hidden = true;
  // Hide the stamp-placement ghost too if we're entering trial from
  // inside placementMode === "stamp" — without this the trial cursor
  // and the placement ghost both follow the pointer, showing two
  // different stamp previews at once (β28 tester report).
  hideStampGhost();
  paintStampTrialCursor(params);
  _viewerContainer.addEventListener("mousemove", onTrialCursorMove);
  _viewerContainer.addEventListener("mouseleave", onTrialCursorLeave);
  window.addEventListener("keydown", onTrialKeydown, true);
  _wsStatus.textContent = "PDF をクリックして試し位置を指定 / Esc で取消";
}

function cancelStampTrialPlacement() {
  if (!_stampTrialPlacing) return;
  _stampTrialPlacing = false;
  if (_stampTrialCursorEl) _stampTrialCursorEl.hidden = true;
  _viewerContainer.removeEventListener("mousemove", onTrialCursorMove);
  _viewerContainer.removeEventListener("mouseleave", onTrialCursorLeave);
  window.removeEventListener("keydown", onTrialKeydown, true);
  // Esc-from-cursor case: re-show the register dialog (no has-trial
  // because nothing was pinned). Manager stays hidden until the
  // register flow itself ends — that's closeStampRegisterImage's job.
  if (stampRegImageDialog) stampRegImageDialog.hidden = false;
  _wsStatus.textContent = "";
}

export function placeStampTrial(pageNo, canonicalX, canonicalY, pageEl) {
  clearStampTrial();
  const params = getStampTrialParams();
  if (!params || !pageEl) {
    cancelStampTrialPlacement();
    return;
  }
  // Center the trial on the click — matches placeStamp's UX.
  const x = canonicalX - params.width / 2;
  const y = canonicalY - params.height / 2;
  const z = _viewer.zoom;
  const wrap = buildStampTrialWrap(x, y, params, z);
  pageEl.appendChild(wrap);
  _stampTrial = { pageNo, x, y, wrap, canvas: wrap.firstElementChild, params };
  if (stampRegImageTrialBtn) stampRegImageTrialBtn.textContent = "試し置きをやり直す";
  // Trial is now interactive (corner handles for resize + body drag for
  // move). Restore the register dialog into "has-trial" mode — pinned
  // to top-right with a transparent backdrop — so the user can keep
  // adjusting size visually while still having quick access to color /
  // 枠 / 登録. The stamp manager (if it had been open behind the
  // register dialog) stays hidden until 登録 / キャンセル closes the
  // register flow.
  _stampTrialPlacing = false;
  if (_stampTrialCursorEl) _stampTrialCursorEl.hidden = true;
  _viewerContainer.removeEventListener("mousemove", onTrialCursorMove);
  _viewerContainer.removeEventListener("mouseleave", onTrialCursorLeave);
  window.removeEventListener("keydown", onTrialKeydown, true);
  if (stampRegImageDialog) stampRegImageDialog.hidden = false;
  setStampRegHasTrial(true);
  _wsStatus.textContent =
    "角をドラッグでサイズ調整 / 中央をドラッグで移動 / 「登録」で確定";
}

/** Build the DOM structure for a pinned trial: wrap div + canvas +
 *  4 corner resize handles + drag-to-move on the wrap body. */
function buildStampTrialWrap(x, y, params, z) {
  const wrap = document.createElement("div");
  wrap.className = "stamp-trial-wrap";
  wrap.style.position = "absolute";
  wrap.style.left = `${x * z}px`;
  wrap.style.top = `${y * z}px`;
  wrap.style.width = `${params.width * z}px`;
  wrap.style.height = `${params.height * z}px`;

  const canvas = document.createElement("canvas");
  canvas.className = "stamp-trial-overlay";
  setupHiDPICanvas(canvas, params.width * z, params.height * z);
  paintStampTrialCanvas(canvas, params);
  wrap.appendChild(canvas);

  for (const corner of ["nw", "ne", "sw", "se"]) {
    const handle = document.createElement("div");
    handle.className = `stamp-trial-handle stamp-trial-handle-${corner}`;
    handle.dataset.corner = corner;
    wrap.appendChild(handle);
    attachStampTrialResize(handle, corner);
  }
  attachStampTrialDrag(wrap);
  return wrap;
}

/** Live-mutate _stampTrial's position + size and reflect everything
 *  (canvas pixel buffer, CSS box, dialog inputs) in one place. */
function applyTrialGeometry(newX, newY, newW, newH) {
  if (!_stampTrial) return;
  const z = _viewer.zoom;
  _stampTrial.x = newX;
  _stampTrial.y = newY;
  _stampTrial.params = { ..._stampTrial.params, width: newW, height: newH };
  _stampTrial.wrap.style.left = `${newX * z}px`;
  _stampTrial.wrap.style.top = `${newY * z}px`;
  _stampTrial.wrap.style.width = `${newW * z}px`;
  _stampTrial.wrap.style.height = `${newH * z}px`;
  setupHiDPICanvas(_stampTrial.canvas, newW * z, newH * z);
  paintStampTrialCanvas(_stampTrial.canvas, _stampTrial.params);
  // Sync the dialog's W/H so 「登録」 commits the dragged dimensions
  // and the user can switch between mouse + keyboard adjustment.
  if (stampRegImageW) stampRegImageW.value = String(Math.round(newW));
  if (stampRegImageH) stampRegImageH.value = String(Math.round(newH));
}

/** Pointer handlers for a corner handle. The opposite corner of the
 *  wrap stays anchored; the dragged corner follows the mouse;
 *  aspect ratio is preserved (image stamps don't stretch). */
function attachStampTrialResize(handle, corner) {
  let pointerId = null;
  let anchor = null;
  let aspectR = 1;
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !_stampTrial) return;
    e.preventDefault();
    e.stopPropagation();
    pointerId = e.pointerId;
    try { handle.setPointerCapture(pointerId); } catch { /* ignore */ }
    const { x, y, params } = _stampTrial;
    const w = params.width;
    const h = params.height;
    aspectR = w > 0 && h > 0 ? w / h : 1;
    anchor = ({
      nw: { x: x + w, y: y + h }, // anchored at SE
      ne: { x: x,     y: y + h }, // anchored at SW
      sw: { x: x + w, y: y     }, // anchored at NE
      se: { x: x,     y: y     }, // anchored at NW
    })[corner];
  });
  handle.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId || !_stampTrial || !anchor) return;
    const z = _viewer.zoom;
    const pageEl = _stampTrial.wrap?.parentNode;
    if (!pageEl) return;
    const rect = pageEl.getBoundingClientRect();
    const mouseCx = (e.clientX - rect.left) / z;
    const mouseCy = (e.clientY - rect.top) / z;
    let newW = Math.abs(mouseCx - anchor.x);
    let newH = Math.abs(mouseCy - anchor.y);
    // Honor aspect ratio: pick the dim that makes the box larger so the
    // pointer never falls inside the box during a drag-out gesture.
    if (newW / aspectR > newH) newH = newW / aspectR;
    else newW = newH * aspectR;
    newW = Math.max(10, newW);
    newH = Math.max(10, newW / aspectR);
    let newX;
    let newY;
    if (corner === "nw") { newX = anchor.x - newW; newY = anchor.y - newH; }
    else if (corner === "ne") { newX = anchor.x;       newY = anchor.y - newH; }
    else if (corner === "sw") { newX = anchor.x - newW; newY = anchor.y; }
    else /* se */            { newX = anchor.x;       newY = anchor.y; }
    applyTrialGeometry(newX, newY, newW, newH);
  });
  const end = (e) => {
    if (e.pointerId !== pointerId) return;
    try { handle.releasePointerCapture(pointerId); } catch { /* ignore */ }
    pointerId = null;
    anchor = null;
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

/** Pointer handlers on the wrap body — drag the trial to move it.
 *  Handles inside the wrap stopPropagation, so this fires only on the
 *  canvas/outline area. */
function attachStampTrialDrag(wrap) {
  let pointerId = null;
  let startMouseX = 0;
  let startMouseY = 0;
  let startX = 0;
  let startY = 0;
  wrap.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !_stampTrial) return;
    if (e.target instanceof HTMLElement
        && e.target.classList.contains("stamp-trial-handle")) return;
    e.preventDefault();
    e.stopPropagation();
    pointerId = e.pointerId;
    try { wrap.setPointerCapture(pointerId); } catch { /* ignore */ }
    startMouseX = e.clientX;
    startMouseY = e.clientY;
    startX = _stampTrial.x;
    startY = _stampTrial.y;
  });
  wrap.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId || !_stampTrial) return;
    const z = _viewer.zoom;
    const dx = (e.clientX - startMouseX) / z;
    const dy = (e.clientY - startMouseY) / z;
    applyTrialGeometry(
      startX + dx,
      startY + dy,
      _stampTrial.params.width,
      _stampTrial.params.height,
    );
  });
  const end = (e) => {
    if (e.pointerId !== pointerId) return;
    try { wrap.releasePointerCapture(pointerId); } catch { /* ignore */ }
    pointerId = null;
  };
  wrap.addEventListener("pointerup", end);
  wrap.addEventListener("pointercancel", end);
}

/** Toggle the "has-trial" CSS class on the register dialog. The class
 *  re-styles the modal so it sits in the top-right corner and lets
 *  clicks through to the PDF underneath while a trial is pinned. */
function setStampRegHasTrial(has) {
  if (!stampRegImageDialog) return;
  stampRegImageDialog.classList.toggle("has-trial", !!has);
}

/** Re-paint the pinned trial in place when the user tweaks w / color /
 *  frame from the dialog inputs. Cheap; runs on every input change.
 *  Resize keeps the trial centered on its current center (so dialog
 *  edits feel symmetric, unlike corner-handle drag which uses the
 *  opposite corner as the anchor). */
function updateStampTrialAppearance() {
  if (!_stampTrial) return;
  const params = getStampTrialParams();
  if (!params) return;
  const oldW = _stampTrial.params.width;
  const oldH = _stampTrial.params.height;
  const cx = _stampTrial.x + oldW / 2;
  const cy = _stampTrial.y + oldH / 2;
  const newX = cx - params.width / 2;
  const newY = cy - params.height / 2;
  // Refresh color / frame in the stored params before geometry update
  // so the repaint inside applyTrialGeometry uses the latest look.
  _stampTrial.params = { ..._stampTrial.params, color: params.color, frame: params.frame };
  applyTrialGeometry(newX, newY, params.width, params.height);
}

/** Tear down the pinned trial (DOM wrap + state) and drop the
 *  register dialog's has-trial CSS class so the next register-without-
 *  trial session opens centered. Doesn't touch the manager / snapshot —
 *  closeStampRegisterImage owns that at register-flow exit. Safe to
 *  call when nothing is pinned. */
export function clearStampTrial() {
  if (_stampTrial?.wrap?.parentNode) {
    _stampTrial.wrap.parentNode.removeChild(_stampTrial.wrap);
  } else if (_stampTrial?.canvas?.parentNode) {
    // Legacy structure fallback (pre-β30 builds with no wrap).
    _stampTrial.canvas.parentNode.removeChild(_stampTrial.canvas);
  }
  _stampTrial = null;
  setStampRegHasTrial(false);
  if (stampRegImageTrialBtn) stampRegImageTrialBtn.textContent = "PDF に試し置き";
}

/** Re-create the pinned trial inside the current page DOM after a
 *  viewer.setZoom rebuild has replaced the page elements. Mirrors
 *  placeStampTrial's DOM build but uses the existing _stampTrial
 *  state for position / size. */
export function reattachStampTrial() {
  if (!_stampTrial) return;
  const pageEl = _viewer.pageEls?.get(_stampTrial.pageNo);
  if (!pageEl) {
    // Page no longer exists in the new layout — drop the trial.
    _stampTrial = null;
    setStampRegHasTrial(false);
    if (stampRegImageTrialBtn) stampRegImageTrialBtn.textContent = "PDF に試し置き";
    return;
  }
  const z = _viewer.zoom;
  const wrap = buildStampTrialWrap(
    _stampTrial.x,
    _stampTrial.y,
    _stampTrial.params,
    z,
  );
  pageEl.appendChild(wrap);
  _stampTrial.wrap = wrap;
  _stampTrial.canvas = wrap.firstElementChild;
}

stampRegImageTrialBtn?.addEventListener("click", () => {
  // The button is dual-purpose: first press → placement mode. While a
  // trial is already pinned the label reads "やり直す" and a press
  // clears the existing pin and re-enters placement.
  clearStampTrial();
  enterStampTrialPlacement();
});
