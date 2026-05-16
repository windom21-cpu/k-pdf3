// K-PDF3 preload. CommonJS for contextBridge stability across Electron versions.
//
// Exposes a minimal, typed surface to the renderer. No direct Node access.
//
// PDF-first UX (ADR-0006): the renderer only sees `openPdfFile` and
// `closeWorkspace`. Sidecar `.kpdf3` resolution happens in main.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("kpdf3", {
  // file dialog
  pickPdf:            ()        => ipcRenderer.invoke("kpdf3:pick-pdf"),
  listDirectory:      (path)    => ipcRenderer.invoke("kpdf3:list-directory", path),
  getDefaultPaths:    ()        => ipcRenderer.invoke("kpdf3:get-default-paths"),
  getExportDefaults:  ()        => ipcRenderer.invoke("kpdf3:get-export-defaults"),
  fileExists:         (p)       => ipcRenderer.invoke("kpdf3:file-exists", p),
  // workspace lifecycle (PDF-first)
  openPdfFile:        (pdfPath, tabId) => ipcRenderer.invoke("kpdf3:open-pdf-file", pdfPath, tabId ?? null),
  closeWorkspace:     ()        => ipcRenderer.invoke("kpdf3:close-workspace"),
  switchTab:          (tabId)   => ipcRenderer.invoke("kpdf3:switch-tab", tabId),
  closeTab:           (tabId)   => ipcRenderer.invoke("kpdf3:close-tab", tabId),
  detachTab:          (payload) => ipcRenderer.invoke("kpdf3:detach-tab", payload),
  onBootstrapDetachedTab: (cb)  => ipcRenderer.on("kpdf3:bootstrap-detached-tab", (_, d) => cb(d)),
  reportTabBarRect:   (rect)    => ipcRenderer.invoke("kpdf3:report-tab-bar-rect", rect),
  onAdoptDockedTab:   (cb)      => ipcRenderer.on("kpdf3:adopt-docked-tab", (_, d) => cb(d)),
  tabDragStart:       (payload) => ipcRenderer.invoke("kpdf3:tab-drag-start", payload),
  tabDragEnd:         ()        => ipcRenderer.invoke("kpdf3:tab-drag-end"),
  tabBarDrop:         ()        => ipcRenderer.invoke("kpdf3:tab-bar-drop"),
  onTabWasDockedAway: (cb)      => ipcRenderer.on("kpdf3:tab-was-docked-away", (_, id) => cb(id)),
  openInNewWindow:    (pdfPath) => ipcRenderer.invoke("kpdf3:open-in-new-window", pdfPath),
  saveOverlays:       (ovs)     => ipcRenderer.invoke("kpdf3:save-overlays", ovs),
  pickExportPdf:      ()        => ipcRenderer.invoke("kpdf3:pick-export-pdf"),
  pickExportFolder:   ()        => ipcRenderer.invoke("kpdf3:pick-export-folder"),
  exportPdfRasterized: (payload) => ipcRenderer.invoke("kpdf3:export-pdf-rasterized", payload),
  copySourcePdf:      (savePath) => ipcRenderer.invoke("kpdf3:copy-source-pdf", savePath),
  listPrinters:       ()         => ipcRenderer.invoke("kpdf3:list-printers"),
  listPrintEngines:   ()         => ipcRenderer.invoke("kpdf3:list-print-engines"),
  hasPdfReader:       ()         => ipcRenderer.invoke("kpdf3:has-pdf-reader"),
  printViaReaderDialog: (payload) => ipcRenderer.invoke("kpdf3:print-via-reader-dialog", payload),
  printPdfSilent:     (payload)  => ipcRenderer.invoke("kpdf3:print-pdf-silent", payload),
  cancelPrint:        ()         => ipcRenderer.invoke("kpdf3:cancel-print"),
  // queries
  getSourceMeta:      ()        => ipcRenderer.invoke("kpdf3:get-source-meta"),
  getPages:           ()        => ipcRenderer.invoke("kpdf3:get-pages"),
  getOutline:         ()        => ipcRenderer.invoke("kpdf3:get-outline"),
  listBookmarks:      ()        => ipcRenderer.invoke("kpdf3:list-bookmarks"),
  addBookmark:        (opts)    => ipcRenderer.invoke("kpdf3:add-bookmark", opts),
  renameBookmark:     (opts)    => ipcRenderer.invoke("kpdf3:rename-bookmark", opts),
  removeBookmark:     (opts)    => ipcRenderer.invoke("kpdf3:remove-bookmark", opts),
  moveBookmark:       (opts)    => ipcRenderer.invoke("kpdf3:move-bookmark", opts),
  listAssets:         ()        => ipcRenderer.invoke("kpdf3:list-assets"),
  addAsset:           (opts)    => ipcRenderer.invoke("kpdf3:add-asset", opts),
  addAssetFromFile:   (opts)    => ipcRenderer.invoke("kpdf3:add-asset-from-file", opts),
  getAsset:           (id)      => ipcRenderer.invoke("kpdf3:get-asset", id),
  removeAsset:        (id)      => ipcRenderer.invoke("kpdf3:remove-asset", id),
  listStampPresets:   ()        => ipcRenderer.invoke("kpdf3:list-stamp-presets"),
  addStampPreset:     (p)       => ipcRenderer.invoke("kpdf3:add-stamp-preset", p),
  removeStampPreset:  (id)      => ipcRenderer.invoke("kpdf3:remove-stamp-preset", id),
  listRecentPdfs:     ()        => ipcRenderer.invoke("kpdf3:list-recent-pdfs"),
  getAppInfo:         ()        => ipcRenderer.invoke("kpdf3:get-app-info"),
  // viewer rendering
  renderPage:         (pageNo, opts = {}) => ipcRenderer.invoke("kpdf3:render-page", pageNo, opts),
  // window controls (frame: false custom title bar)
  windowMinimize:     ()        => ipcRenderer.invoke("kpdf3:window-minimize"),
  windowMaximizeToggle: ()      => ipcRenderer.invoke("kpdf3:window-maximize-toggle"),
  windowClose:        ()        => ipcRenderer.invoke("kpdf3:window-close"),
  windowIsMaximized:  ()        => ipcRenderer.invoke("kpdf3:window-is-maximized"),
  onWindowState:      (cb)      => ipcRenderer.on("kpdf3:window-state", (_, s) => cb(s)),
  toggleDevTools:     ()        => ipcRenderer.invoke("kpdf3:toggle-devtools"),
  // Page popup (single-page comparison window, §17.4 prelim)
  openPagePopup:      (data)    => ipcRenderer.invoke("kpdf3:open-page-popup", data),
  onPopupData:        (cb)      => ipcRenderer.on("kpdf3:popup-data", (_, d) => cb(d)),
  toggleAlwaysOnTop:  (on)      => ipcRenderer.invoke("kpdf3:toggle-always-on-top", on),
  resizePopupToFit:   (opts)    => ipcRenderer.invoke("kpdf3:resize-popup-to-fit", opts),
  onReloadRequest:    (cb)      => ipcRenderer.on("kpdf3:reload-request", () => cb()),
  // OS-driven PDF open: fires when the user double-clicks a .pdf in
  // their file manager (or chose K-PDF3 via "Open with…"). Main passes
  // the absolute path; renderer routes into openPdfSmart.
  onOpenPdfByOS:      (cb)      => ipcRenderer.on("kpdf3:open-pdf-by-os", (_, p) => cb(p)),
  // Drag&drop helper — Electron 32+ removed File.path from the renderer,
  // so dropped files now need webUtils.getPathForFile() (preload-only).
  getPathForFile:     (file)    => webUtils.getPathForFile(file),
  // β75 diag: renderer から fire-and-forget で crash.log に追記。
  // D&D で「開かない」現象の追跡に使う (drop event 発火 / path 解決 /
  // openPdfSmart 結果 / OS-open 受領)。本番でも常時 ON でよい程度に軽量。
  logDiag:            (label, data) => ipcRenderer.send("kpdf3:log-diag", label, data),
  // Open the OS-native printer properties dialog for a given printer.
  printerProperties:  (name)    => ipcRenderer.invoke("kpdf3:printer-properties", name),
  searchPdf:          (q)       => ipcRenderer.invoke("kpdf3:search-pdf", q),
  // Auto-update (§17.15). The renderer drives the UX (98 風 dialogs +
  // busy modal); main only forwards electron-updater's events and
  // performs the actual download/install on request.
  updaterCheck:           ()    => ipcRenderer.invoke("kpdf3:updater-check"),
  updaterDownload:        ()    => ipcRenderer.invoke("kpdf3:updater-download"),
  updaterInstall:         ()    => ipcRenderer.invoke("kpdf3:updater-install"),
  openCrashLog:           ()    => ipcRenderer.invoke("kpdf3:open-crash-log"),
  onUpdaterChecking:        (cb) => ipcRenderer.on("kpdf3:updater-checking",           ()      => cb()),
  onUpdaterUpdateAvailable: (cb) => ipcRenderer.on("kpdf3:updater-update-available",   (_, d)  => cb(d)),
  onUpdaterNotAvailable:    (cb) => ipcRenderer.on("kpdf3:updater-not-available",      ()      => cb()),
  onUpdaterDownloadProgress:(cb) => ipcRenderer.on("kpdf3:updater-download-progress",  (_, d)  => cb(d)),
  onUpdaterUpdateDownloaded:(cb) => ipcRenderer.on("kpdf3:updater-update-downloaded",  (_, d)  => cb(d)),
  onUpdaterError:           (cb) => ipcRenderer.on("kpdf3:updater-error",              (_, d)  => cb(d)),
  setPageDeleted:     (n, d)    => ipcRenderer.invoke("kpdf3:set-page-deleted", n, d),
  setPageRotation:    (n, r)    => ipcRenderer.invoke("kpdf3:set-page-rotation", n, r),
  reorderPages:       (orderedPageNos) => ipcRenderer.invoke("kpdf3:reorder-pages", orderedPageNos),
  reorderAllPages:    (orderedKeys) => ipcRenderer.invoke("kpdf3:reorder-all-pages", orderedKeys),
  addInsertedPage:    (opts)    => ipcRenderer.invoke("kpdf3:add-inserted-page", opts),
  addInsertedPdfPages:(opts)    => ipcRenderer.invoke("kpdf3:add-inserted-pdf-pages", opts),
  // β.79: cross-window thumb D&D — source 側の dragstart で payload を main に置き、
  // target 側の sidebar drop で同 payload を消費して synthetic page 挿入。
  pageDragStart:      (payload) => ipcRenderer.invoke("kpdf3:page-drag-start", payload),
  pageDragEnd:        ()        => ipcRenderer.invoke("kpdf3:page-drag-end"),
  pageBarDrop:        (payload) => ipcRenderer.invoke("kpdf3:page-bar-drop", payload),
  onInsertPdfProgress:(cb)      => {
    const h = (_, d) => cb(d);
    ipcRenderer.on("kpdf3:insert-pdf-progress", h);
    return () => ipcRenderer.removeListener("kpdf3:insert-pdf-progress", h);
  },
  getInsertedPageImage:(id)     => ipcRenderer.invoke("kpdf3:get-inserted-page-image", id),
  getInsertedSourcePdf:(id)     => ipcRenderer.invoke("kpdf3:get-inserted-source-pdf", id),
  renderInsertedSourcePage:(opts) => ipcRenderer.invoke("kpdf3:render-inserted-source-page", opts),
  removeInsertedPage: (n)       => ipcRenderer.invoke("kpdf3:remove-inserted-page", n),
});
