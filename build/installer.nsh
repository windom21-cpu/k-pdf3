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

; ============================================================
; customInstall — runs after electron-builder's stock install macros.
;
; β.139 (2026-05-26): file association registration is now a
; one-shot per machine. After the first install writes the ProgID
; and Applications entries, subsequent autoUpdater installs skip
; them entirely so the user's "default app" choice (Adobe / Edge
; / K-PDF3) survives every update.
;
; Background: electron-builder's stock registerFileAssociations
; (driven by the `fileAssociations` block in package.json) used to
; run on every install — including autoUpdater-triggered ones —
; which reset the UserChoice hash and triggered Windows 10/11's
; "defaults were reset" notification. The `fileAssociations`
; block was removed from package.json in β.139 to disable that
; macro; this block handles the registration with a once-only
; sentinel value under HKCU\Software\<appId>.
;
; The block also clears the legacy ProgID name `K-PDF3.pdf` that
; the old `fileAssociations`-driven registration created, so
; testers see exactly one K-PDF3 entry in the "Open with" list
; instead of two side-by-side entries (one with icon, one with
; the OS-default icon).
; ============================================================
!macro customInstall
  ReadRegStr $0 HKCU "Software\io.windom21.kpdf3" "FileAssociationsRegistered"
  StrCmp $0 "" customRegisterAssociations customSkipAssociations

  customRegisterAssociations:
    ; --- Cleanup of pre-β.139 entries that may already exist ---
    DeleteRegKey HKCU "Software\Classes\K-PDF3.pdf"
    DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "K-PDF3.pdf"

    ; --- New ProgID written under the appId namespace ---
    WriteRegStr HKCU "Software\Classes\kpdf3.Document.1" "" "PDF Document"
    WriteRegStr HKCU "Software\Classes\kpdf3.Document.1\DefaultIcon" "" "$INSTDIR\K-PDF3.exe,0"
    WriteRegStr HKCU "Software\Classes\kpdf3.Document.1\shell\open\command" "" '"$INSTDIR\K-PDF3.exe" "%1"'

    ; Add to .pdf OpenWith list — does NOT touch UserChoice, so
    ; the user's default-app pick is preserved.
    WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "kpdf3.Document.1" ""

    ; Applications entry — surface K-PDF3 in the right-click
    ; "Open with > Choose another app" picker.
    WriteRegStr HKCU "Software\Classes\Applications\K-PDF3.exe" "FriendlyAppName" "K-PDF3"
    WriteRegStr HKCU "Software\Classes\Applications\K-PDF3.exe\DefaultIcon" "" "$INSTDIR\K-PDF3.exe,0"
    WriteRegStr HKCU "Software\Classes\Applications\K-PDF3.exe\shell\open\command" "" '"$INSTDIR\K-PDF3.exe" "%1"'
    WriteRegStr HKCU "Software\Classes\Applications\K-PDF3.exe\SupportedTypes" ".pdf" ""

    ; Sentinel — every subsequent autoUpdater install reads this
    ; and skips the block above.
    WriteRegStr HKCU "Software\io.windom21.kpdf3" "FileAssociationsRegistered" "1"

    ; Tell the shell to re-read associations so the new entries
    ; appear immediately in Explorer.
    System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
    Goto customAssociationsDone

  customSkipAssociations:
    ; Sentinel present → updater install, leave associations alone.

  customAssociationsDone:
!macroend

; ============================================================
; customUnInstall — undo everything customInstall wrote so an
; uninstall + reinstall is a clean re-initialisation.
; ============================================================
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\kpdf3.Document.1"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "kpdf3.Document.1"
  DeleteRegKey HKCU "Software\Classes\Applications\K-PDF3.exe"
  DeleteRegValue HKCU "Software\io.windom21.kpdf3" "FileAssociationsRegistered"
  DeleteRegKey /ifempty HKCU "Software\io.windom21.kpdf3"
  ; Legacy pre-β.139 cleanup
  DeleteRegKey HKCU "Software\Classes\K-PDF3.pdf"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "K-PDF3.pdf"
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
