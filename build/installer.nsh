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
