// Standalone renderer for a single-page popup (BrowserWindow with
// frame:false). Receives the rendered page PNG + metadata via the
// kpdf3:popup-data IPC, paints it into the <img>, and wires up close
// (Esc / X button) + always-on-top toggle.

const { kpdf3 } = window;

const titleEl = document.getElementById("popup-title");
const imageEl = document.getElementById("popup-image");
const closeBtn = document.getElementById("popup-close");
const pinBtn = document.getElementById("popup-pin");

let alwaysOnTop = false;

kpdf3.onPopupData?.((data) => {
  if (!data) return;
  const label = data.fileName ?? "";
  const visualLabel =
    typeof data.visualPos === "number" && typeof data.totalPages === "number"
      ? `${data.visualPos} / ${data.totalPages}`
      : `p.${data.pageNo ?? ""}`;
  titleEl.textContent = `${label} — ${visualLabel}`;
  document.title = `${label} — ${visualLabel}`;
  if (data.pngDataUrl) imageEl.src = data.pngDataUrl;
  // Resize the window to the image's natural aspect, capped at the
  // current screen so a poster-sized export doesn't fly off-screen.
  if (typeof data.width === "number" && typeof data.height === "number") {
    kpdf3.resizePopupToFit?.({ width: data.width, height: data.height });
  }
});

closeBtn?.addEventListener("click", () => {
  kpdf3.windowClose();
});

pinBtn?.addEventListener("click", async () => {
  alwaysOnTop = !alwaysOnTop;
  pinBtn.classList.toggle("is-active", alwaysOnTop);
  await kpdf3.toggleAlwaysOnTop?.(alwaysOnTop);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    kpdf3.windowClose();
  }
});
