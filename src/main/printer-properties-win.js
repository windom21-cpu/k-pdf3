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
const DM_IN_PROMPT = 4;

// DPI_AWARENESS_CONTEXT_SYSTEM_AWARE is defined as ((HANDLE)-2). Pass
// as int64 so koffi puts the raw bit pattern into the parameter slot,
// rather than passing the address of a JS BigInt.
const DPI_AWARENESS_CONTEXT_SYSTEM_AWARE = -2n;

let _native = null;
let _nativeAttempted = false;

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
      ClosePrinter: winspool.func(
        "__stdcall",
        "ClosePrinter",
        "bool",
        ["int64"],
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

    const ret = native.DocumentPropertiesW(
      parentHwnd,
      hPrinter,
      deviceName,
      null,
      null,
      DM_IN_PROMPT,
    );
    // ret values:
    //   IDOK     (1) → user clicked OK
    //   IDCANCEL (2) → user clicked Cancel
    //   < 0          → error
    if (ret < 0) throw new Error(`DocumentProperties returned ${ret}`);
    return { ok: true };
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
