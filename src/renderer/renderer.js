// K-PDF3 renderer (M1 skeleton).
// M2 で virtualized viewer に置き換える。

const { kpdf3 } = window;

const $ = (id) => document.getElementById(id);
const wsInfo = $("ws-info");
const pagesInfo = $("pages-info");
const btnNew = $("btn-new");
const btnOpen = $("btn-open");
const btnClose = $("btn-close");

let workspaceOpen = false;

function setOpen(open) {
  workspaceOpen = open;
  btnNew.disabled = open;
  btnOpen.disabled = open;
  btnClose.disabled = !open;
}

async function refreshInfo() {
  if (!workspaceOpen) {
    wsInfo.textContent = "(no workspace)";
    pagesInfo.textContent = "(no pages)";
    return;
  }
  const meta = await kpdf3.getSourceMeta();
  wsInfo.textContent = meta ? JSON.stringify(meta, null, 2) : "(no source PDF imported)";
  const pages = await kpdf3.getPages();
  pagesInfo.textContent = pages.length === 0
    ? "(no pages)"
    : pages.map((p) =>
        `page ${p.pageNo}: media=${p.mediaW}x${p.mediaH} crop=${p.cropW}x${p.cropH} rotate=${p.rotation}`
      ).join("\n");
}

btnNew.addEventListener("click", async () => {
  const wsPath = await kpdf3.pickWorkspaceSave();
  if (!wsPath) return;
  const pdfPath = await kpdf3.pickPdf();
  if (!pdfPath) return;
  await kpdf3.openWorkspace(wsPath);
  await kpdf3.importPdf(pdfPath);
  setOpen(true);
  await refreshInfo();
});

btnOpen.addEventListener("click", async () => {
  const wsPath = await kpdf3.pickWorkspaceOpen();
  if (!wsPath) return;
  await kpdf3.openWorkspace(wsPath);
  setOpen(true);
  await refreshInfo();
});

btnClose.addEventListener("click", async () => {
  await kpdf3.closeWorkspace();
  setOpen(false);
  await refreshInfo();
});

(async () => {
  const info = await kpdf3.getAppInfo();
  document.getElementById("appinfo").textContent =
    `app v${info.appVersion}  /  Electron ${info.electronVersion}  /  Node ${info.nodeVersion}  /  ${info.platform}`;
})();
