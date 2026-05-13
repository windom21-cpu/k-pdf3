// 98-styled modal busy indicator with progress bar.
//
// Used for long operations (export / print / page deletion / etc.)
// where the user might otherwise think the app froze. Optional
// `onCancel` callback wires the 「中止」 button — the caller is
// responsible for actually aborting the work via its own cleanup.

const busyModal = document.getElementById("busy-modal");
const busyTitle = document.getElementById("busy-title");
const busyMessage = document.getElementById("busy-message");
const busyProgressBar = document.getElementById("busy-progress-bar");
const busyCancelBtn = document.getElementById("busy-cancel");

let _busyCancelHandler = null;

export function showBusy(title, message, percent = 0, opts = {}) {
  busyTitle.textContent = title;
  busyMessage.textContent = message;
  busyProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (typeof opts.onCancel === "function") {
    _busyCancelHandler = opts.onCancel;
    busyCancelBtn.hidden = false;
    busyCancelBtn.disabled = false;
  } else {
    _busyCancelHandler = null;
    busyCancelBtn.hidden = true;
  }
  busyModal.hidden = false;
  document.body.classList.add("is-busy");
}

export function updateBusy(message, percent) {
  if (typeof message === "string") busyMessage.textContent = message;
  if (typeof percent === "number") {
    busyProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
}

export function hideBusy() {
  busyModal.hidden = true;
  busyCancelBtn.hidden = true;
  _busyCancelHandler = null;
  document.body.classList.remove("is-busy");
}

busyCancelBtn.addEventListener("click", () => {
  if (!_busyCancelHandler) return;
  // Disable to prevent double-click; busy modal stays open until the
  // handler finishes its own cleanup (which usually calls hideBusy).
  busyCancelBtn.disabled = true;
  busyMessage.textContent = "中止しています...";
  try {
    _busyCancelHandler();
  } catch (err) {
    console.error("[busy-cancel] handler threw:", err);
  } finally {
    _busyCancelHandler = null;
  }
});
