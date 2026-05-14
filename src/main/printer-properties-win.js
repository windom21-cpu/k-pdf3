// DPI-aware printer properties dialog on Windows.
//
// The legacy `rundll32.exe printui.dll,PrintUIEntry /e /n` path produces
// a blurry / oversized driver UI on 4K monitors because the rundll32
// child process is started PerMonitorV2-aware (inherited from K-PDF3),
// and legacy driver UIs that aren't DPI-aware get bitmap-stretched.
//
// Adobe's approach is to call DocumentPropertiesW directly *in-process*
// while temporarily switching the calling thread to System DPI awareness
// — Windows then applies GDI-based scaling to the driver UI, which is
// noticeably sharper than the rundll32 path's bitmap stretch.
//
// We do the same via koffi FFI. If koffi fails to load (e.g. on a
// platform where the prebuilt native binary is missing) or any of the
// Win32 calls fail, we silently fall back to the rundll32 path so the
// "Properties" button never goes dead.

import { spawn } from "child_process";

// DocumentProperties fMode values (printer.h).
const DM_OUT_BUFFER = 2;
const DM_IN_PROMPT = 4;

// DocumentProperties return values (IDOK=1 is implicit — anything
// that isn't IDCANCEL or negative is OK).
const IDCANCEL = 2;

// DEVMODEW offsets (public-portion layout is stable across drivers
// because dmDriverExtra holds any private data appended *after*).
// See <wingdi.h> typedef _devicemodeW.
//
//   dmDeviceName:    WCHAR[32]  -> 64 bytes at offset 0
//   dmSpecVersion:   WORD       -> offset 64
//   dmDriverVersion: WORD       -> offset 66
//   dmSize:          WORD       -> offset 68
//   dmDriverExtra:   WORD       -> offset 70
//   dmFields:        DWORD      -> offset 72   (bitmask of valid fields)
//   dmOrientation:   short      -> offset 76   (only if DM_ORIENTATION)
//   dmPaperSize:     short      -> offset 78
//   dmPaperLength:   short      -> offset 80
//   dmPaperWidth:    short      -> offset 82
//   dmScale:         short      -> offset 84
//   dmCopies:        short      -> offset 86   (only if DM_COPIES)
//   dmDefaultSource: short      -> offset 88   (tray; only if DM_DEFAULTSOURCE)
//   dmPrintQuality:  short      -> offset 90
//   dmColor:         short      -> offset 92   (only if DM_COLOR)
//   dmDuplex:        short      -> offset 94   (only if DM_DUPLEX)
const DEVMODE_DM_FIELDS_OFFSET         = 72;
const DEVMODE_DM_ORIENTATION_OFFSET    = 76;
const DEVMODE_DM_COPIES_OFFSET         = 86;
const DEVMODE_DM_DEFAULTSOURCE_OFFSET  = 88;
const DEVMODE_DM_COLOR_OFFSET          = 92;
const DEVMODE_DM_DUPLEX_OFFSET         = 94;
const DM_ORIENTATION_FLAG    = 0x00000001;
const DM_COPIES_FLAG         = 0x00000100;
const DM_DEFAULTSOURCE_FLAG  = 0x00000200;
const DM_COLOR_FLAG          = 0x00000800;
const DM_DUPLEX_FLAG         = 0x00001000;
const DMORIENT_LANDSCAPE  = 2;
// dmDuplex values
const DMDUP_SIMPLEX    = 1;
const DMDUP_VERTICAL   = 2; // 長辺綴じ (long-edge binding)
const DMDUP_HORIZONTAL = 3; // 短辺綴じ (short-edge binding)
// dmColor values
const DMCOLOR_MONOCHROME = 1;
const DMCOLOR_COLOR      = 2;

// DPI_AWARENESS_CONTEXT_SYSTEM_AWARE is defined as ((HANDLE)-2). Pass
// as int64 so koffi puts the raw bit pattern into the parameter slot,
// rather than passing the address of a JS BigInt.
const DPI_AWARENESS_CONTEXT_SYSTEM_AWARE = -2n;

let _native = null;
let _nativeAttempted = false;

// β48 J4b: Cache the full DEVMODE buffer (public part + driver-private
// dmDriverExtra bytes) returned by the most recent IDOK on the driver
// properties dialog, keyed by deviceName. The driver-private bytes
// hold things like tray selection on FUJIFILM-class drivers that
// otherwise leave the public dmDefaultSource field at a stale default.
// Cleared per-key when the user reopens プロパティ for that printer
// and clicks Cancel, so a previous OK doesn't leak forever.
const _userDevmodeCache = new Map();

// β49 J4c: in-flight token across an apply/restore window. Tracked so
// the app-shutdown hook in main can run an emergency synchronous
// restore if the user closes the window while a print job is still
// spawning (process.exit doesn't wait for in-flight Promises, so the
// finally clause in print-pdf-silent would otherwise be skipped and
// the per-user printer DEVMODE would leak into the next app's print).
let _inflightDevmodeToken = null;

// β54: in-flight token for the "default printer temporary swap" used
// by the FAX path (silent:false で OS 印刷ダイアログを開かざるを得ない
// が、Chromium は deviceName を honor しないのでダイアログ既定が
// OS 既定プリンタに引き戻されてしまう問題を回避する用)。同じく
// shutdown hook で sync 復元できるよう module 変数で持つ。
let _inflightDefaultPrinterToken = null;

async function tryLoadNative() {
  if (_nativeAttempted) return _native;
  _nativeAttempted = true;
  if (process.platform !== "win32") return null;
  try {
    const koffiMod = await import("koffi");
    const koffi = koffiMod.default ?? koffiMod;
    const user32 = koffi.load("user32.dll");
    const winspool = koffi.load("winspool.drv");
    // HWND / HANDLE / DPI_AWARENESS_CONTEXT are all pointer-sized
    // opaque handles. Declaring them as int64 (not void *) lets us
    // pass raw bit-pattern values (BigInt) without koffi interpreting
    // "buffer" as "address of buffer".
    _native = {
      koffi,
      SetThreadDpiAwarenessContext: user32.func(
        "__stdcall",
        "SetThreadDpiAwarenessContext",
        "int64",
        ["int64"],
      ),
      OpenPrinterW: winspool.func(
        "__stdcall",
        "OpenPrinterW",
        "bool",
        ["str16", koffi.out(koffi.pointer("int64")), "void *"],
      ),
      DocumentPropertiesW: winspool.func(
        "__stdcall",
        "DocumentPropertiesW",
        "long",
        ["int64", "int64", "str16", "void *", "void *", "uint32"],
      ),
      // β48 J4b: SetPrinter level 9 lets us push the user's modified
      // DEVMODE (including the driver-private extension bytes where
      // FUJIFILM Apeos / Xerox class drivers store tray selection) as
      // the per-user default. Sumatra then picks it up via its own
      // GetPrinter call. Adobe Reader uses the same approach.
      GetPrinterW: winspool.func(
        "__stdcall",
        "GetPrinterW",
        "bool",
        ["int64", "uint32", "void *", "uint32", koffi.out(koffi.pointer("uint32"))],
      ),
      SetPrinterW: winspool.func(
        "__stdcall",
        "SetPrinterW",
        "bool",
        ["int64", "uint32", "void *", "uint32"],
      ),
      ClosePrinter: winspool.func(
        "__stdcall",
        "ClosePrinter",
        "bool",
        ["int64"],
      ),
      // β54: 規定プリンタの読み書き。FAX 経路で Chromium OS 印刷
      // ダイアログを開く直前に FAX を一時的に規定にし、Windows の
      // 印刷ダイアログがそれを既定として選んだ状態で開くようにする。
      // GetDefaultPrinterW(pszBuffer, pcchBuffer): pcchBuffer は in/out
      // で、in は buffer に渡したサイズ(WCHAR数)、out は必要文字数
      // (または書き込まれた文字数)。koffi の out/inout pointer 型は
      // バージョン差があるので両方とも void * で受け、4 byte の
      // Buffer (DWORD) を呼び出し側で確保して manually 読み書き
      // する。DEVMODEW を Buffer で扱っているのと同じ流儀。
      GetDefaultPrinterW: winspool.func(
        "__stdcall",
        "GetDefaultPrinterW",
        "bool",
        ["void *", "void *"],
      ),
      SetDefaultPrinterW: winspool.func(
        "__stdcall",
        "SetDefaultPrinterW",
        "bool",
        ["str16"],
      ),
    };
  } catch (err) {
    console.warn(
      "[printer-props] koffi unavailable, falling back to rundll32:",
      err?.message ?? err,
    );
    _native = null;
  }
  return _native;
}

/** Open the printer driver's preferences dialog with crisper DPI
 *  rendering. parentHwndBuf is the Buffer returned by
 *  BrowserWindow.getNativeWindowHandle(); pass null to use no owner. */
export async function openPrinterPropertiesNative(deviceName, parentHwndBuf) {
  const native = await tryLoadNative();
  if (!native) return openPrinterPropertiesFallback(deviceName);

  // The HWND comes as a Buffer whose 8 bytes ARE the HWND value (not
  // a pointer to it). Read out as int64 so DocumentPropertiesW gets
  // the right handle.
  let parentHwnd = 0n;
  if (parentHwndBuf && parentHwndBuf.length >= 8) {
    try {
      parentHwnd = parentHwndBuf.readBigInt64LE(0);
    } catch { /* keep 0n = no owner */ }
  }

  let prevDpiCtx = null;
  let hPrinter = 0n;
  try {
    // SetThreadDpiAwarenessContext was added in Win10 1607. If it
    // throws on older Windows we still try DocumentProperties — the
    // dialog just won't get the System-aware DPI treatment.
    try {
      prevDpiCtx = native.SetThreadDpiAwarenessContext(
        DPI_AWARENESS_CONTEXT_SYSTEM_AWARE,
      );
    } catch {
      prevDpiCtx = null;
    }

    const out = [0n];
    const opened = native.OpenPrinterW(deviceName, out, null);
    if (!opened) {
      throw new Error(`OpenPrinter("${deviceName}") returned false`);
    }
    hPrinter = out[0];
    if (!hPrinter) {
      throw new Error("OpenPrinter returned NULL handle");
    }

    // First call with fMode=0 + null buffers returns the size in bytes
    // needed for the DEVMODEW output buffer (driver-private extension
    // data is included via dmDriverExtra). Then we allocate that buffer
    // and call again with DM_IN_PROMPT|DM_OUT_BUFFER to both display
    // the driver UI and capture the user's modified DEVMODE.
    //
    // Without DM_OUT_BUFFER, "プロパティ→枚数を5に→OK" is shown by the
    // driver UI but the modified DEVMODE is dropped on the floor, so
    // the next print job reverts to the renderer's default (1 copy).
    // β15 testers reproduced this with FUJIFILM Apeos C2360.
    const sizeNeeded = native.DocumentPropertiesW(
      0n,
      hPrinter,
      deviceName,
      null,
      null,
      0,
    );
    if (sizeNeeded < 0) {
      throw new Error(`DocumentProperties size query returned ${sizeNeeded}`);
    }
    const devmodeOut = Buffer.alloc(sizeNeeded);

    const ret = native.DocumentPropertiesW(
      parentHwnd,
      hPrinter,
      deviceName,
      devmodeOut,
      null,
      DM_IN_PROMPT | DM_OUT_BUFFER,
    );
    // ret values:
    //   IDOK     (1) → user clicked OK
    //   IDCANCEL (2) → user clicked Cancel
    //   < 0          → error
    if (ret < 0) throw new Error(`DocumentProperties returned ${ret}`);
    if (ret === IDCANCEL) {
      // Don't wipe cached DEVMODE on Cancel — the user might have
      // OK'd earlier, then later peeked at プロパティ and cancelled.
      // Last successful OK still wins.
      return { ok: true, cancelled: true };
    }

    // β48 J4b: cache the FULL DEVMODE buffer (public + driver-private
    // dmDriverExtra) so the print path can push it as per-user default
    // via SetPrinter level 9. This is the only way to forward tray /
    // option presets that the driver stores in its private extension.
    _userDevmodeCache.set(deviceName, Buffer.from(devmodeOut));

    // IDOK — parse DEVMODE for the fields we propagate to the renderer.
    // β46 J3: also extract duplex / tray (dmDefaultSource) / color so
    // they reach the Sumatra -print-settings path. Without these the
    // user's プロパティ settings were silently lost between the dialog
    // and the actual spool call.
    const result = { ok: true, cancelled: false };
    const dmFields = devmodeOut.readUInt32LE(DEVMODE_DM_FIELDS_OFFSET);
    if (dmFields & DM_COPIES_FLAG) {
      const copies = devmodeOut.readInt16LE(DEVMODE_DM_COPIES_OFFSET);
      if (copies > 0) result.copies = copies;
    }
    if (dmFields & DM_ORIENTATION_FLAG) {
      const orient = devmodeOut.readInt16LE(DEVMODE_DM_ORIENTATION_OFFSET);
      result.landscape = (orient === DMORIENT_LANDSCAPE);
    }
    // β47 J4: dmFields flag gates were too strict — when the user had
    // already set tray/duplex/color via Windows control panel as the
    // printer's persistent default, the driver returns the current
    // value at the offset but DOES NOT set the corresponding "modified"
    // flag in dmFields (the user didn't touch it in our dialog session).
    // Read the values unconditionally and gate on value validity instead;
    // we want to forward whatever the driver shows as the active choice
    // to Sumatra, even if it came from a previous OK / system default.
    const duplex = devmodeOut.readInt16LE(DEVMODE_DM_DUPLEX_OFFSET);
    if (duplex === DMDUP_SIMPLEX) result.duplex = "simplex";
    else if (duplex === DMDUP_VERTICAL) result.duplex = "long-edge";
    else if (duplex === DMDUP_HORIZONTAL) result.duplex = "short-edge";
    const bin = devmodeOut.readInt16LE(DEVMODE_DM_DEFAULTSOURCE_OFFSET);
    if (bin > 0) result.bin = bin;
    const color = devmodeOut.readInt16LE(DEVMODE_DM_COLOR_OFFSET);
    if (color === DMCOLOR_MONOCHROME) result.color = "mono";
    else if (color === DMCOLOR_COLOR) result.color = "color";
    // dmFields kept around in case we want to log / surface a "this
    // was modified" hint in the future. (Currently unused.)
    void dmFields;
    return result;
  } catch (err) {
    console.warn(
      "[printer-props] native call failed, falling back to rundll32:",
      err?.message ?? err,
    );
    return openPrinterPropertiesFallback(deviceName);
  } finally {
    if (hPrinter) {
      try { native.ClosePrinter(hPrinter); } catch { /* ignore */ }
    }
    if (prevDpiCtx !== null && prevDpiCtx !== 0n) {
      try {
        native.SetThreadDpiAwarenessContext(prevDpiCtx);
      } catch { /* ignore */ }
    }
  }
}

/**
 * β56: 案 M (printer-print-win.js) 用に、最後に IDOK で取得した
 * DEVMODE buffer (driver-private bytes 込み) を読み出す。GDI 経路は
 * CreateDC(deviceName, devmodeBuffer) で直接渡すので SetPrinter level 9
 * 経由よりも一段直接的に DEVMODE を活かせる。
 *
 * 戻り値: 該当 device の DEVMODE buffer。未キャッシュなら null。
 * (Buffer は内部のコピーをそのまま返すため、呼出側は読み取り専用と
 *  して扱う。書き換えると cache が破壊される)
 */
export function getCachedUserDevmode(deviceName) {
  return _userDevmodeCache.get(deviceName) ?? null;
}

/**
 * β48 J4b: push the most recently captured user DEVMODE to the printer
 * as per-user default (SetPrinter level 9). Returns a token containing
 * the previous per-user state so the caller can restore on cleanup.
 * Returns null if there's no cached DEVMODE for this device, native
 * binding unavailable, or the call failed — caller falls back to
 * running the print job without DEVMODE override.
 */
export async function applyUserPrinterDevmode(deviceName) {
  const native = await tryLoadNative();
  if (!native) return null;
  const devmodeBuf = _userDevmodeCache.get(deviceName);
  if (!devmodeBuf) return null;

  let hPrinter = 0n;
  try {
    const out = [0n];
    if (!native.OpenPrinterW(deviceName, out, null)) {
      throw new Error("OpenPrinterW failed");
    }
    hPrinter = out[0];
    if (!hPrinter) throw new Error("OpenPrinter returned NULL handle");

    // Size query for level 9 (GetPrinter returns false + sets cbNeeded
    // when buffer too small — for the size query we pass null + 0).
    const neededRef = [0];
    native.GetPrinterW(hPrinter, 9, null, 0, neededRef);
    const cbNeeded = neededRef[0];
    let savedOriginal = null;
    if (cbNeeded > 0) {
      const orig = Buffer.alloc(cbNeeded);
      const got = native.GetPrinterW(hPrinter, 9, orig, cbNeeded, neededRef);
      if (got) savedOriginal = orig;
    }

    // PRINTER_INFO_9 = { LPDEVMODE pDevMode; } — 8 bytes on 64-bit.
    // Write the address of our cached DEVMODE into that field.
    const info9 = Buffer.alloc(8);
    info9.writeBigInt64LE(native.koffi.address(devmodeBuf), 0);
    const ok = native.SetPrinterW(hPrinter, 9, info9, 0);
    if (!ok) throw new Error("SetPrinterW level 9 failed");

    const token = { deviceName, savedOriginal, devmodeBuf };
    _inflightDevmodeToken = token;
    return token;
  } catch (err) {
    console.warn(
      "[printer-props] applyUserPrinterDevmode failed:",
      err?.message ?? err,
    );
    return null;
  } finally {
    if (hPrinter) {
      try { native.ClosePrinter(hPrinter); } catch { /* ignore */ }
    }
  }
}

/** Restore the per-user DEVMODE saved by applyUserPrinterDevmode.
 *  Safe to call with a null token (no-op) so the caller can pair
 *  apply/restore without checking. */
export async function restoreUserPrinterDevmode(token) {
  if (!token) return;
  const native = await tryLoadNative();
  if (!native) return;
  _restoreSyncImpl(token, native);
}

/** Synchronous emergency restore for app-shutdown hooks. Skips the
 *  async tryLoadNative — relies on _native being already initialized
 *  (which it is, since apply was called before to set the in-flight
 *  token). Called from main's before-quit hook. */
export function restoreInflightDevmodeSync() {
  const token = _inflightDevmodeToken;
  if (!token || !_native) return;
  _restoreSyncImpl(token, _native);
}

function _restoreSyncImpl(token, native) {
  // savedOriginal is the level-9 buffer GetPrinter populated — its
  // PRINTER_INFO_9 header has pDevMode pointing at a DEVMODE struct
  // inside the same buffer, so passing it back to SetPrinter restores
  // the previous per-user default verbatim.
  if (!token.savedOriginal) {
    _inflightDevmodeToken = null;
    return;
  }
  let hPrinter = 0n;
  try {
    const out = [0n];
    if (!native.OpenPrinterW(token.deviceName, out, null)) {
      _inflightDevmodeToken = null;
      return;
    }
    hPrinter = out[0];
    if (!hPrinter) {
      _inflightDevmodeToken = null;
      return;
    }
    native.SetPrinterW(hPrinter, 9, token.savedOriginal, 0);
  } catch (err) {
    console.warn(
      "[printer-props] restore failed:",
      err?.message ?? err,
    );
  } finally {
    if (hPrinter) {
      try { native.ClosePrinter(hPrinter); } catch { /* ignore */ }
    }
    _inflightDevmodeToken = null;
  }
}

/**
 * β54: FAX 印刷経路で OS 印刷ダイアログを開く直前に Windows の規定
 * プリンタを一時的に FAX デバイスに差し替える。Electron の
 * webContents.print({silent:false, deviceName}) は silent:false 時に
 * deviceName を honor しないため、OS ダイアログは Windows 規定プリンタ
 * (= 通常使うプリンタ) を選んだ状態で開いてしまい、ユーザは K-PDF3 の
 * ダイアログで FAX を選んだ直後にもう一度 OS ダイアログで FAX を選び
 * 直す煩を強いられる。SetDefaultPrinter で短時間だけ規定を差し替え、
 * 印刷キックの完了後 (success/fail 問わず) に元に戻す。
 *
 * 返値: 復元用 token、または何もできなかった時 null。token を握って
 * いる側は完了で restoreDefaultPrinter を必ず呼ぶこと。restore は
 * before-quit でも sync で呼べるよう、同時に module 変数の
 * _inflightDefaultPrinterToken にも書く。
 */
export async function applyFaxAsDefaultPrinter(deviceName) {
  const native = await tryLoadNative();
  if (!native) return null;
  if (typeof deviceName !== "string" || deviceName.length === 0) return null;

  let prevDefault = null;
  try {
    // GetDefaultPrinter: 1回目は cchBuffer=0 + buf=null で必要文字数を
    // 問い合わせ、2回目で実取得。Windows のお約束。pcchBuffer は in/out
    // の DWORD pointer。Buffer 4 byte を直接渡して LE で読み書きする。
    const cchBuf = Buffer.alloc(4);
    cchBuf.writeUInt32LE(0, 0);
    native.GetDefaultPrinterW(null, cchBuf);
    const cch = cchBuf.readUInt32LE(0);
    if (cch > 0) {
      // UTF-16: WCHAR (2 bytes) × (文字数 + 終端 NUL)
      const buf = Buffer.alloc(cch * 2);
      cchBuf.writeUInt32LE(cch, 0);
      const got = native.GetDefaultPrinterW(buf, cchBuf);
      if (got) {
        // 末尾 NUL を除いて UTF-16LE デコード
        const cchOut = cchBuf.readUInt32LE(0);
        const byteLen = Math.max(0, (cchOut - 1) * 2);
        prevDefault = buf.toString("utf16le", 0, byteLen);
      }
    }
  } catch (err) {
    console.warn(
      "[printer-props] GetDefaultPrinter failed:",
      err?.message ?? err,
    );
    // 取得失敗時は復元用情報がないので null を保持。SetDefault は
    // 実行するが復元はベストエフォートになる (next reboot や手動
    // 操作で OS 既定が直る)。
  }

  try {
    const ok = native.SetDefaultPrinterW(deviceName);
    if (!ok) {
      // ACCESS_DENIED や printer not found 等。元規定は変えていないので
      // 復元不要。token も発行しない。
      return null;
    }
  } catch (err) {
    console.warn(
      "[printer-props] SetDefaultPrinter failed:",
      err?.message ?? err,
    );
    return null;
  }

  const token = { prevDefault };
  _inflightDefaultPrinterToken = token;
  return token;
}

/** apply の対で呼ぶ。null token は no-op。restore に失敗しても通常
 *  運用に支障はない (規定プリンタが FAX のままになるだけで、次回の
 *  ユーザの印刷では K-PDF3 ダイアログから選び直せる) ので throw しない。 */
export async function restoreDefaultPrinter(token) {
  if (!token) return;
  const native = await tryLoadNative();
  if (!native) return;
  _restoreDefaultPrinterSyncImpl(token, native);
}

/** Synchronous emergency restore (before-quit hook 等)。
 *  apply 経由で _native は既にロード済の前提。 */
export function restoreInflightDefaultPrinterSync() {
  const token = _inflightDefaultPrinterToken;
  if (!token || !_native) return;
  _restoreDefaultPrinterSyncImpl(token, _native);
}

function _restoreDefaultPrinterSyncImpl(token, native) {
  try {
    if (typeof token.prevDefault === "string" && token.prevDefault.length > 0) {
      native.SetDefaultPrinterW(token.prevDefault);
    }
    // prevDefault が null (取得に失敗していた) の時は復元できない。
    // SetDefaultPrinterW(null) は「最初に見つかったプリンタを既定に」
    // という挙動 (printers 列挙順依存) になり危険なので呼ばない。
  } catch (err) {
    console.warn(
      "[printer-props] restoreDefaultPrinter failed:",
      err?.message ?? err,
    );
  } finally {
    _inflightDefaultPrinterToken = null;
  }
}

/** rundll32 → printui.dll path. Used directly on failure of the
 *  native path, and as the entry point on non-Windows platforms (the
 *  caller branches on process.platform before reaching this file). */
export function openPrinterPropertiesFallback(deviceName) {
  return new Promise((resolve) => {
    try {
      const child = spawn(
        "rundll32.exe",
        ["printui.dll,PrintUIEntry", "/e", "/n", deviceName],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      resolve({ ok: true });
    } catch (err) {
      resolve({ ok: false, error: err?.message ?? String(err) });
    }
  });
}
