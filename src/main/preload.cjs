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
  openPdfFile:        (pdfPath) => ipcRenderer.invoke("kpdf3:open-pdf-file", pdfPath),
  closeWorkspace:     ()        => ipcRenderer.invoke("kpdf3:close-workspace"),
  saveOverlays:       (ovs)     => ipcRenderer.invoke("kpdf3:save-overlays", ovs),
  pickExportPdf:      ()        => ipcRenderer.invoke("kpdf3:pick-export-pdf"),
  pickExportFolder:   ()        => ipcRenderer.invoke("kpdf3:pick-export-folder"),
  exportPdfRasterized: (payload) => ipcRenderer.invoke("kpdf3:export-pdf-rasterized", payload),
  copySourcePdf:      (savePath) => ipcRenderer.invoke("kpdf3:copy-source-pdf", savePath),
  listPrinters:       ()         => ipcRenderer.invoke("kpdf3:list-printers"),
  printPdfSilent:     (payload)  => ipcRenderer.invoke("kpdf3:print-pdf-silent", payload),
  // queries
  getSourceMeta:      ()        => ipcRenderer.invoke("kpdf3:get-source-meta"),
  getPages:           ()        => ipcRenderer.invoke("kpdf3:get-pages"),
  getOutline:         ()        => ipcRenderer.invoke("kpdf3:get-outline"),
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
  // Drag&drop helper — Electron 32+ removed File.path from the renderer,
  // so dropped files now need webUtils.getPathForFile() (preload-only).
  getPathForFile:     (file)    => webUtils.getPathForFile(file),
  // Open the OS-native printer properties dialog for a given printer.
  printerProperties:  (name)    => ipcRenderer.invoke("kpdf3:printer-properties", name),
  searchPdf:          (q)       => ipcRenderer.invoke("kpdf3:search-pdf", q),
  setPageDeleted:     (n, d)    => ipcRenderer.invoke("kpdf3:set-page-deleted", n, d),
  setPageRotation:    (n, r)    => ipcRenderer.invoke("kpdf3:set-page-rotation", n, r),
  addInsertedPage:    (opts)    => ipcRenderer.invoke("kpdf3:add-inserted-page", opts),
  removeInsertedPage: (n)       => ipcRenderer.invoke("kpdf3:remove-inserted-page", n),
});
