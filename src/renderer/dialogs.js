// 98-style replacement for window.confirm().
//
// Returns a Promise<boolean>. Esc / background-click / cancel button → false.
// Enter / OK button → true.
//
// Used wherever window.confirm() would be the natural fit (Save As
// overwrite, page deletion, dirty discard, ...). 98.css framing + the
// app's custom title bar means the native confirm doesn't match the
// rest of the UI; this dialog uses the same styling as #open-dialog etc.

const confirmDialog = document.getElementById("confirm-dialog");
const confirmTitle = document.getElementById("confirm-title");
const confirmMessageEl = document.getElementById("confirm-message");
const confirmOkBtn = document.getElementById("confirm-ok");
const confirmCancelBtn = document.getElementById("confirm-cancel");

/** @type {((value: boolean) => void) | null} */
let confirmDialogResolve = null;

export function customConfirm({
  title = "確認",
  message,
  okLabel = "OK",
  cancelLabel = "キャンセル",
} = {}) {
  confirmTitle.textContent = title;
  confirmMessageEl.textContent = message ?? "";
  confirmOkBtn.textContent = okLabel;
  confirmCancelBtn.textContent = cancelLabel;
  confirmDialog.hidden = false;
  setTimeout(() => confirmOkBtn.focus(), 0);
  return new Promise((resolve) => {
    confirmDialogResolve = resolve;
  });
}

function settleConfirm(value) {
  confirmDialog.hidden = true;
  if (confirmDialogResolve) {
    confirmDialogResolve(value);
    confirmDialogResolve = null;
  }
}

confirmOkBtn.addEventListener("click", () => settleConfirm(true));
confirmCancelBtn.addEventListener("click", () => settleConfirm(false));
confirmDialog.addEventListener("click", (e) => {
  if (e.target === confirmDialog) settleConfirm(false);
});
confirmDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    settleConfirm(false);
  } else if (e.key === "Enter") {
    e.preventDefault();
    settleConfirm(true);
  }
});
