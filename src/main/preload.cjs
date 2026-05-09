// K-PDF3 preload. CommonJS for contextBridge stability across Electron versions.
//
// Exposes a minimal, typed surface to the renderer. No direct Node access.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kpdf3", {
  // dialogs
  pickWorkspaceSave:  ()        => ipcRenderer.invoke("kpdf3:pick-workspace-save"),
  pickWorkspaceOpen:  ()        => ipcRenderer.invoke("kpdf3:pick-workspace-open"),
  pickPdf:            ()        => ipcRenderer.invoke("kpdf3:pick-pdf"),
  // workspace lifecycle
  openWorkspace:      (path)    => ipcRenderer.invoke("kpdf3:open-workspace", path),
  createWorkspace:    (path)    => ipcRenderer.invoke("kpdf3:create-workspace", path),
  closeWorkspace:     ()        => ipcRenderer.invoke("kpdf3:close-workspace"),
  importPdf:          (pdfPath) => ipcRenderer.invoke("kpdf3:import-pdf", pdfPath),
  getSourceMeta:      ()        => ipcRenderer.invoke("kpdf3:get-source-meta"),
  getPages:           ()        => ipcRenderer.invoke("kpdf3:get-pages"),
  getAppInfo:         ()        => ipcRenderer.invoke("kpdf3:get-app-info"),
  // viewer rendering (M2 step 4)
  renderPage:         (pageNo, opts = {}) => ipcRenderer.invoke("kpdf3:render-page", pageNo, opts),
});
