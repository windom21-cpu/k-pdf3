// Generic Win95-style file browser (open / save / folder modes).
//
// Replaces native file pickers (showOpenDialog / showSaveDialog) so the
// dialog matches the rest of the app's 98.css framing and so we can
// route Windows shortcut (.lnk) resolution through main's
// list-directory IPC. See ADR-0013.
//
// External entry point: `showFileBrowser({mode, title, ...})` returns
// a Promise resolving to the selected path (or null when cancelled).

import { customConfirm } from "./dialogs.js";

const { kpdf3 } = window;

const wsStatus = document.getElementById("ws-status");

const openDialog = document.getElementById("open-dialog");
const openTitleText = document.getElementById("open-title-text");
const openQuickSel = document.getElementById("open-quick");
const openUpBtn = document.getElementById("open-up");
const openCurrentPathEl = document.getElementById("open-current-path");
const openFileList = document.getElementById("open-file-list");
const openFilenameInput = document.getElementById("open-filename");
const openFilenameRow = document.getElementById("open-row-filename");
const openFilterSel = document.getElementById("open-filter");
const openFilterRow = document.getElementById("open-row-filter");
const openConfirmBtn = document.getElementById("open-confirm");
const openCancelBtn = document.getElementById("open-cancel");
const openTitlebarCloseBtn = document.getElementById("open-titlebar-close");
const openSecureExportRow = document.getElementById("open-row-secure-export");
const openSecureExportCheckbox = document.getElementById("open-secure-export");

const fileBrowserState = {
  mode: "open", // "open" | "save" | "folder"
  currentPath: null,
  parentPath: null,
  entries: [],
  selectedName: null,
  defaultPaths: null,
  resolve: null, // Promise resolver for the current invocation
  // When true (set per-invocation by showFileBrowser), save mode shows a
  // "セキュア書き出し" checkbox row and resolves to { path, secureExport }
  // instead of just a path string.
  secureExportToggle: false,
};

function isPdfName(name) {
  return /\.pdf$/i.test(name);
}
function isImageName(name) {
  return /\.(png|jpe?g)$/i.test(name);
}

function classifyEntry(entry) {
  if (entry.isParent) return "open-entry open-entry-parent is-folder";
  if (entry.isDir) return "open-entry is-folder";
  if (isPdfName(entry.name)) return "open-entry is-pdf";
  if (isImageName(entry.name)) return "open-entry is-image";
  return "open-entry is-other";
}

function shouldShowEntry(entry) {
  if (entry.isParent || entry.isDir) return true;
  if (fileBrowserState.mode === "folder") return false; // hide files in folder mode
  const filter = openFilterSel.value;
  if (filter === "all") return true;
  if (filter === "image") return isImageName(entry.name);
  return isPdfName(entry.name);
}

function renderFileBrowserList() {
  openFileList.innerHTML = "";
  fileBrowserState.selectedName = null;
  if (fileBrowserState.mode !== "save") openFilenameInput.value = "";
  const visible = fileBrowserState.entries.filter(shouldShowEntry);
  if (visible.length === 0) {
    const li = document.createElement("li");
    li.className = "open-entry-empty";
    li.textContent = "(このフォルダには表示できる項目がありません)";
    openFileList.appendChild(li);
    return;
  }
  for (const entry of visible) {
    const li = document.createElement("li");
    li.className = classifyEntry(entry);
    li.dataset.name = entry.name;
    li.dataset.isDir = entry.isDir ? "1" : "0";
    li.dataset.isParent = entry.isParent ? "1" : "0";
    const nameEl = document.createElement("span");
    nameEl.className = "open-entry-name";
    nameEl.textContent = entry.isParent ? ".. (上のフォルダ)" : entry.name;
    li.appendChild(nameEl);
    li.addEventListener("click", () => selectFileEntry(entry, li));
    li.addEventListener("dblclick", () => activateFileEntry(entry));
    openFileList.appendChild(li);
  }
}

function selectFileEntry(entry, liEl) {
  for (const li of openFileList.querySelectorAll(".open-entry.selected")) {
    li.classList.remove("selected");
  }
  if (liEl) liEl.classList.add("selected");
  fileBrowserState.selectedName = entry.isParent ? null : entry.name;
  if (!entry.isDir && !entry.isParent) {
    openFilenameInput.value = entry.name;
  }
}

function activateFileEntry(entry) {
  if (entry.isParent) {
    if (fileBrowserState.parentPath) loadFileBrowserDir(fileBrowserState.parentPath);
    return;
  }
  if (entry.isDir) {
    // Windows .lnk shortcut to folder: targetPath holds the resolved
    // destination (set in main's list-directory handler). Navigate
    // there instead of trying to descend into the .lnk path itself.
    const dest = entry.targetPath
      || joinPath(fileBrowserState.currentPath, entry.name);
    loadFileBrowserDir(dest);
    return;
  }
  if (fileBrowserState.mode === "open") {
    const filter = openFilterSel.value;
    const accept =
      filter === "all" ||
      (filter === "image" && isImageName(entry.name)) ||
      (filter === "pdf" && isPdfName(entry.name));
    if (accept) {
      fileBrowserConfirm(joinPath(fileBrowserState.currentPath, entry.name));
    }
  } else if (fileBrowserState.mode === "save") {
    handleFileBrowserConfirm();
  }
}

function joinPath(dir, name) {
  if (!dir) return name;
  if (dir.endsWith("/") || dir.endsWith("\\")) return dir + name;
  return dir + (dir.includes("\\") && !dir.includes("/") ? "\\" : "/") + name;
}

async function loadFileBrowserDir(targetPath) {
  const result = await kpdf3.listDirectory(targetPath);
  fileBrowserState.currentPath = result.path;
  fileBrowserState.parentPath = result.parent;
  const entries = result.error ? [] : [...result.entries];
  if (result.parent) {
    entries.unshift({ name: "..", isParent: true, isDir: true });
  }
  fileBrowserState.entries = entries;
  openCurrentPathEl.textContent = result.path;
  openCurrentPathEl.title = result.path;
  openUpBtn.disabled = !result.parent;
  if (result.error) {
    openFileList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "open-entry-error";
    li.textContent = `エラー: ${result.error}`;
    openFileList.appendChild(li);
  } else {
    renderFileBrowserList();
  }
  syncQuickSelector();
}

function syncQuickSelector() {
  if (!fileBrowserState.defaultPaths) return;
  const cur = fileBrowserState.currentPath;
  const match = [...openQuickSel.options].find((o) => o.value === cur);
  openQuickSel.value = match ? cur : "";
}

async function populateQuickSelector() {
  if (!fileBrowserState.defaultPaths) {
    fileBrowserState.defaultPaths = await kpdf3.getDefaultPaths();
  }
  const dp = fileBrowserState.defaultPaths;
  const opts = [
    { value: "", label: "(現在のフォルダ)" },
    { value: dp.home, label: `ホーム  ${dp.home ?? ""}` },
    { value: dp.desktop, label: `デスクトップ  ${dp.desktop ?? ""}` },
    { value: dp.documents, label: `ドキュメント  ${dp.documents ?? ""}` },
    { value: dp.downloads, label: `ダウンロード  ${dp.downloads ?? ""}` },
  ];
  openQuickSel.innerHTML = "";
  for (const o of opts) {
    if (o.value === null) continue;
    const opt = document.createElement("option");
    opt.value = o.value ?? "";
    opt.textContent = o.label;
    openQuickSel.appendChild(opt);
  }
}

function fileBrowserCancel() {
  openDialog.hidden = true;
  if (fileBrowserState.resolve) {
    const r = fileBrowserState.resolve;
    fileBrowserState.resolve = null;
    r(null);
  }
}

function fileBrowserConfirm(value) {
  if (fileBrowserState.currentPath) {
    localStorage.setItem("kpdf3.lastBrowseDir", fileBrowserState.currentPath);
  }
  // Persist the user's secure-export choice across invocations.
  if (fileBrowserState.secureExportToggle && openSecureExportCheckbox) {
    localStorage.setItem("kpdf3.secureExport", openSecureExportCheckbox.checked ? "1" : "0");
  }
  openDialog.hidden = true;
  if (fileBrowserState.resolve) {
    const r = fileBrowserState.resolve;
    fileBrowserState.resolve = null;
    r(value);
  }
}

async function handleFileBrowserConfirm() {
  const mode = fileBrowserState.mode;
  if (mode === "folder") {
    if (fileBrowserState.currentPath) {
      fileBrowserConfirm(fileBrowserState.currentPath);
    }
    return;
  }

  const filename = openFilenameInput.value.trim();
  if (!filename) {
    if (mode === "open" && fileBrowserState.selectedName) {
      fileBrowserConfirm(
        joinPath(fileBrowserState.currentPath, fileBrowserState.selectedName),
      );
    }
    return;
  }
  const isAbsolute = /^([a-zA-Z]:[/\\]|[/\\])/.test(filename);
  let target = isAbsolute ? filename : joinPath(fileBrowserState.currentPath, filename);

  if (mode === "save") {
    // Auto-append .pdf if missing
    if (!/\.[a-zA-Z0-9]+$/.test(target)) target += ".pdf";
    if (await kpdf3.fileExists(target)) {
      const ok = await customConfirm({
        title: "上書きの確認",
        message: `${target}\nは既に存在します。上書きしますか？`,
        okLabel: "上書き",
      });
      if (!ok) return;
    }
    if (fileBrowserState.secureExportToggle) {
      fileBrowserConfirm({
        path: target,
        secureExport: !!openSecureExportCheckbox?.checked,
      });
    } else {
      fileBrowserConfirm(target);
    }
    return;
  }

  // open mode — accept whichever extension the active filter allows.
  const filter = openFilterSel.value;
  const ok =
    filter === "all" ||
    (filter === "image" && isImageName(target)) ||
    (filter === "pdf" && isPdfName(target));
  if (!ok) {
    wsStatus.textContent = filter === "image" ? "画像 (PNG/JPEG) を選択してください" : "PDF ファイルを選択してください";
    return;
  }
  fileBrowserConfirm(target);
}

/**
 * Show the file browser. Returns a Promise resolving to:
 *   - open mode  : selected file's full path (or null if cancelled)
 *   - save mode  : full save path (or null)
 *   - folder mode: selected folder path (or null)
 */
export async function showFileBrowser({
  mode = "open",
  title,
  initialName = "",
  defaultDir = null,
  filterDefault = "pdf",
  confirmLabel,
  secureExportToggle = false,
} = {}) {
  fileBrowserState.mode = mode;
  fileBrowserState.secureExportToggle = !!secureExportToggle && mode === "save";
  if (openSecureExportRow) {
    openSecureExportRow.hidden = !fileBrowserState.secureExportToggle;
  }
  // Default checked when the row first appears; persist across invocations
  // via localStorage so a tester who switched it off stays off.
  if (fileBrowserState.secureExportToggle && openSecureExportCheckbox) {
    const stored = localStorage.getItem("kpdf3.secureExport");
    openSecureExportCheckbox.checked = stored == null ? true : stored === "1";
  }
  await populateQuickSelector();

  // Resolve initial directory
  const stored = localStorage.getItem("kpdf3.lastBrowseDir");
  const initial =
    defaultDir ||
    stored ||
    fileBrowserState.defaultPaths?.home ||
    "";

  // UI configuration based on mode
  if (mode === "folder") {
    openTitleText.textContent = title || "フォルダの選択";
    openFilenameRow.hidden = true;
    openFilterRow.hidden = true;
    openConfirmBtn.textContent = confirmLabel || "このフォルダを選択";
  } else if (mode === "save") {
    openTitleText.textContent = title || "名前を付けて保存";
    openFilenameRow.hidden = false;
    openFilterRow.hidden = false;
    openFilterSel.value = filterDefault;
    openFilenameInput.value = initialName;
    openConfirmBtn.textContent = confirmLabel || "保存";
  } else {
    openTitleText.textContent = title || "PDF を開く";
    openFilenameRow.hidden = false;
    openFilterRow.hidden = false;
    openFilterSel.value = filterDefault;
    openFilenameInput.value = "";
    openConfirmBtn.textContent = confirmLabel || "開く";
  }

  await loadFileBrowserDir(initial);
  openDialog.hidden = false;
  if (mode === "save") {
    // Pre-select base name (stem) so the user can immediately type to replace
    openFilenameInput.focus();
    const stem = initialName.replace(/\.[^.]+$/, "");
    openFilenameInput.setSelectionRange(0, stem.length);
  } else {
    openFilenameInput.focus();
  }

  return new Promise((resolve) => {
    fileBrowserState.resolve = resolve;
  });
}

openConfirmBtn.addEventListener("click", handleFileBrowserConfirm);
openCancelBtn.addEventListener("click", fileBrowserCancel);
openTitlebarCloseBtn.addEventListener("click", fileBrowserCancel);
openDialog.addEventListener("click", (e) => {
  if (e.target === openDialog) fileBrowserCancel();
});
openUpBtn.addEventListener("click", () => {
  if (fileBrowserState.parentPath) loadFileBrowserDir(fileBrowserState.parentPath);
});
openQuickSel.addEventListener("change", () => {
  if (openQuickSel.value) loadFileBrowserDir(openQuickSel.value);
});
openFilterSel.addEventListener("change", renderFileBrowserList);
openFilenameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    handleFileBrowserConfirm();
  } else if (e.key === "Escape") {
    e.preventDefault();
    fileBrowserCancel();
  }
});
openDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    fileBrowserCancel();
  }
});
