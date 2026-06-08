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
// β.111: 任意 checkbox 行。"白黒で上書き" のような副次オプションを
// 確定ダイアログに 1 つだけ載せる用途。複数 checkbox は範囲外。
const confirmCheckboxRow = document.getElementById("confirm-checkbox-row");
const confirmCheckboxEl = document.getElementById("confirm-checkbox");
const confirmCheckboxLabel = document.getElementById("confirm-checkbox-label");

/** @type {((value: any) => void) | null} */
let confirmDialogResolve = null;
/** β.111: checkbox オプションが指定された呼出のみ resolve を {ok, checked}
 *  にする。未指定なら boolean を返して既存 callsite を全部維持。 */
let confirmReturnsObject = false;
/** localStorage key for the current invocation's checkbox (or null). */
let confirmCheckboxStorageKey = null;

/**
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.message]
 * @param {string} [opts.okLabel]
 * @param {string|null} [opts.cancelLabel]  null → hide cancel
 * @param {object} [opts.checkbox]          β.111 副次オプション
 * @param {string}  opts.checkbox.label
 * @param {boolean} [opts.checkbox.defaultChecked=false]
 * @param {string}  [opts.checkbox.storageKey] localStorage で永続化
 */
export function customConfirm({
  title = "確認",
  message,
  okLabel = "OK",
  cancelLabel = "キャンセル",
  checkbox = null,
} = {}) {
  confirmTitle.textContent = title;
  confirmMessageEl.textContent = message ?? "";
  confirmOkBtn.textContent = okLabel;
  // cancelLabel === null hides the cancel button — useful for purely-
  // informational warnings where OK is the only choice.
  if (cancelLabel === null) {
    confirmCancelBtn.hidden = true;
  } else {
    confirmCancelBtn.hidden = false;
    confirmCancelBtn.textContent = cancelLabel;
  }
  // β.111: checkbox 行のセットアップ。指定なしなら hidden + 既存と同じ
  // boolean resolve に戻す。
  confirmReturnsObject = !!checkbox;
  confirmCheckboxStorageKey = null;
  if (checkbox) {
    confirmCheckboxRow.hidden = false;
    confirmCheckboxLabel.textContent = checkbox.label ?? "";
    let initial = !!checkbox.defaultChecked;
    if (checkbox.storageKey) {
      confirmCheckboxStorageKey = checkbox.storageKey;
      const stored = localStorage.getItem(checkbox.storageKey);
      if (stored != null) initial = stored === "1";
    }
    confirmCheckboxEl.checked = initial;
  } else {
    confirmCheckboxRow.hidden = true;
    confirmCheckboxEl.checked = false;
  }
  confirmDialog.hidden = false;
  setTimeout(() => confirmOkBtn.focus(), 0);
  return new Promise((resolve) => {
    confirmDialogResolve = resolve;
  });
}

function settleConfirm(value) {
  confirmDialog.hidden = true;
  // β.111: checkbox の値を永続化 (用意されていれば)。
  if (confirmCheckboxStorageKey && confirmCheckboxEl) {
    try {
      localStorage.setItem(
        confirmCheckboxStorageKey,
        confirmCheckboxEl.checked ? "1" : "0",
      );
    } catch { /* ignore */ }
  }
  if (confirmDialogResolve) {
    const payload = confirmReturnsObject
      ? { ok: !!value, checked: !!confirmCheckboxEl?.checked }
      : value;
    confirmDialogResolve(payload);
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

// ---------------------------------------------------------------------------
// Password prompt (パスワード保護 PDF を開く時)。
//
// Returns Promise<string | null>. OK / Enter (入力あり) → 入力文字列、
// Esc / 背景クリック / キャンセル → null。settle 時に input.value を必ず
// 空にして、パスワードを DOM に残さない。
// ---------------------------------------------------------------------------

const passwordDialog = document.getElementById("password-dialog");
const passwordMessageEl = document.getElementById("password-message");
const passwordErrorEl = document.getElementById("password-error");
const passwordInputEl = document.getElementById("password-input");
const passwordOkBtn = document.getElementById("password-ok");
const passwordCancelBtn = document.getElementById("password-cancel");

/** @type {((value: string | null) => void) | null} */
let passwordResolve = null;

/**
 * @param {object} [opts]
 * @param {string}  [opts.fileName]  ダイアログ本文に出すファイル名
 * @param {boolean} [opts.wrong]     直前の入力が誤りだった (再入力)
 * @returns {Promise<string | null>}
 */
export function customPasswordPrompt({ fileName = "", wrong = false } = {}) {
  passwordMessageEl.textContent = fileName
    ? `「${fileName}」はパスワードで保護されています。開くにはパスワードを入力してください。`
    : "この PDF はパスワードで保護されています。開くにはパスワードを入力してください。";
  passwordErrorEl.hidden = !wrong;
  if (wrong) passwordErrorEl.textContent = "パスワードが違います。もう一度入力してください。";
  passwordInputEl.value = "";
  passwordDialog.hidden = false;
  setTimeout(() => passwordInputEl.focus(), 0);
  return new Promise((resolve) => {
    passwordResolve = resolve;
  });
}

function settlePassword(value) {
  passwordDialog.hidden = true;
  // パスワードを DOM に残さない。
  passwordInputEl.value = "";
  if (passwordResolve) {
    passwordResolve(value);
    passwordResolve = null;
  }
}

passwordOkBtn.addEventListener("click", () => {
  const v = passwordInputEl.value;
  if (v) settlePassword(v);
});
passwordCancelBtn.addEventListener("click", () => settlePassword(null));
passwordDialog.addEventListener("click", (e) => {
  if (e.target === passwordDialog) settlePassword(null);
});
passwordDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    settlePassword(null);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const v = passwordInputEl.value;
    if (v) settlePassword(v);
  }
});
