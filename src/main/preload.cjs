// K-PDF3 preload. CommonJS for contextBridge stability across Electron versions.
//
// Exposes a minimal, typed surface to the renderer. No direct Node access.
//
// PDF-first UX (ADR-0006): the renderer only sees `openPdfFile` and
// `closeWorkspace`. Sidecar `.kpdf3` resolution happens in main.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kpdf3", {
  // file dialog
  pickPdf:            ()        => ipcRenderer.invoke("kpdf3:pick-pdf"),
  // workspace lifecycle (PDF-first)
  openPdfFile:        (pdfPath) => ipcRenderer.invoke("kpdf3:open-pdf-file", pdfPath),
  closeWorkspace:     ()        => ipcRenderer.invoke("kpdf3:close-workspace"),
  saveOverlays:       (ovs)     => ipcRenderer.invoke("kpdf3:save-overlays", ovs),
  pickExportPdf:      ()        => ipcRenderer.invoke("kpdf3:pick-export-pdf"),
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
});
