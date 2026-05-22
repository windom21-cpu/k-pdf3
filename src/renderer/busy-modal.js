// 98-styled modal busy indicator with progress bar.
//
// Used for long operations (export / print / page deletion / etc.)
// where the user might otherwise think the app froze. Optional
// `onCancel` callback wires the footer button — the caller is
// responsible for actually aborting the work via its own cleanup.
//
// β.129: the footer button's label / in-progress message are
// customizable (cancelLabel / cancelBusyMessage) and can be
// reconfigured mid-modal via setBusyCancel — so the same modal can
// switch from a「中止」abort button into an explicit「送信完了」
// confirmation. FAX 経路は印刷完了を自動検出できる信号が構造的に
// 無いため、Adobe 起動後はこの明示確認モードを使う。

const busyModal = document.getElementById("busy-modal");
const busyTitle = document.getElementById("busy-title");
const busyMessage = document.getElementById("busy-message");
const busyProgressBar = document.getElementById("busy-progress-bar");
const busyCancelBtn = document.getElementById("busy-cancel");

let _busyCancelHandler = null;
let _busyCancelBusyMessage = "中止しています...";

/**
 * Configure (or hide) the footer button. Shared by showBusy and
 * setBusyCancel so the button can be set up or reconfigured later.
 *
 * @param {{onCancel?:Function, cancelLabel?:string, cancelBusyMessage?:string}} opts
 */
function _applyCancelOpts(opts) {
  if (typeof opts.onCancel === "function") {
    _busyCancelHandler = opts.onCancel;
    _busyCancelBusyMessage = opts.cancelBusyMessage || "中止しています...";
    busyCancelBtn.textContent = opts.cancelLabel || "中止";
    busyCancelBtn.hidden = false;
    busyCancelBtn.disabled = false;
  } else {
    _busyCancelHandler = null;
    busyCancelBtn.hidden = true;
  }
}

export function showBusy(title, message, percent = 0, opts = {}) {
  busyTitle.textContent = title;
  busyMessage.textContent = message;
  busyProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  _applyCancelOpts(opts);
  busyModal.hidden = false;
  document.body.classList.add("is-busy");
}

export function updateBusy(message, percent) {
  if (typeof message === "string") busyMessage.textContent = message;
  if (typeof percent === "number") {
    busyProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
}

/**
 * β.129: Reconfigure just the footer button on an already-shown
 * modal — e.g. switch a「中止」abort button into a「送信完了」
 * confirmation once the abortable phase is over. Pass no onCancel
 * to hide the button.
 *
 * @param {{onCancel?:Function, cancelLabel?:string, cancelBusyMessage?:string}} opts
 */
export function setBusyCancel(opts = {}) {
  _applyCancelOpts(opts);
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
  busyMessage.textContent = _busyCancelBusyMessage;
  try {
    _busyCancelHandler();
  } catch (err) {
    console.error("[busy-cancel] handler threw:", err);
  } finally {
    _busyCancelHandler = null;
  }
});
