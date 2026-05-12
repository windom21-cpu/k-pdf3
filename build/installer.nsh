; ============================================================
; K-PDF3 NSIS installer customisation
;
; Make the installer .exe itself DPI-aware so the brief progress UI
; doesn't bitmap-stretch on 4K monitors — first-impression UX. The
; installed K-PDF3.exe gets its own DPI awareness from Electron's
; embedded manifest; this file only affects the installer wrapper.
;
; Compile-time directives must run before NSIS emits the executable
; header, which is why we hook into electron-builder's customHeader
; macro (called by the bundled installer.nsi template ahead of
; `OutFile`). The directives themselves:
;
;   ManifestDPIAware true
;       legacy <dpiAware>true/PM</dpiAware> tag (Win7+ compat).
;
;   ManifestDPIAwareness "PerMonitorV2,PerMonitor"
;       modern <dpiAwareness> tag (Win10 1703+ for V2, earlier fallback).
;
; Both are available in NSIS 3.0+ / 3.07+ respectively; the NSIS fork
; bundled with electron-builder 26.x covers both.
; ============================================================

!macro customHeader
  ManifestDPIAware true
  ManifestDPIAwareness "PerMonitorV2,PerMonitor"
!macroend

; ============================================================
; customInit — runs early on installer start.
;
; Detect & remove legacy per-machine install (β6 and earlier).
;
; Pre-β7 builds shipped with `perMachine: true` and landed in
; `C:\Program Files\K-PDF3\`. β7+ switched to `oneClick: true` +
; `perMachine: false`, installing to `%LocalAppData%\Programs\k-pdf3\`.
; Both installs share the same appId, so the per-user installer
; here does NOT touch the legacy per-machine entry — but the legacy
; installer's all-users Start-menu shortcut and `.pdf` "Open with"
; registration keep pointing at the obsolete exe. Testers reported
; "毎回 β6 に戻る": launching from the all-users shortcut runs the
; old install regardless of how new the per-user install is, and
; the old install's own autoUpdater (or a fresh download) drops a
; new per-user install side-by-side without removing β6.
;
; The legacy uninstaller is itself elevated (placed by an admin
; install), so ExecShellWait is used to trigger the UAC prompt. If
; the user declines UAC the install of this new build continues
; anyway — only the duplicate remains.
; ============================================================
!macro customInit
  IfFileExists "$PROGRAMFILES64\K-PDF3\Uninstall K-PDF3.exe" customLegacyRemove customLegacyDone
  customLegacyRemove:
    DetailPrint "Removing legacy per-machine install at $PROGRAMFILES64\K-PDF3 ..."
    ExecShellWait "" '"$PROGRAMFILES64\K-PDF3\Uninstall K-PDF3.exe"' "/allusers /S" SW_HIDE
  customLegacyDone:
!macroend
