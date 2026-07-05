@echo off
setlocal
rem ================================================================
rem K-PDF3 workspaces backup (REVIEW-2026-07 #2)
rem Mirrors %APPDATA%\K-PDF3 editable data to a NAS / external drive.
rem Japanese instructions: see BACKUP.md next to this file.
rem
rem !!! Edit DEST below to your backup destination before first use.
rem ================================================================
set "SRC=%APPDATA%\K-PDF3"
set "DEST=X:\K-system\K-PDF3-backup"
rem Optional: pass the destination as the first argument instead.
if not "%~1"=="" set "DEST=%~1"

rem Refuse to run while K-PDF3 is running: better-sqlite3 runs in WAL
rem mode and copying live -wal/-shm files can produce a corrupt copy.
tasklist /FI "IMAGENAME eq K-PDF3.exe" | find /I "K-PDF3.exe" >nul
if not errorlevel 1 (
  echo [SKIP] K-PDF3 is running. Close it and run this again.
  exit /b 1
)

if not exist "%SRC%\workspaces" (
  echo [ERROR] source not found: %SRC%\workspaces
  exit /b 1
)
if not exist "%DEST%" mkdir "%DEST%"

rem /MIR mirror (deletes files removed on the source side, e.g. after
rem the in-app workspace cleanup), retry 2x, wait 5s, log appended.
robocopy "%SRC%\workspaces" "%DEST%\workspaces" /MIR /R:2 /W:5 /NP /NDL /LOG+:"%DEST%\backup.log"
if errorlevel 8 goto :fail

copy /Y "%SRC%\index.db"  "%DEST%\" >nul
if errorlevel 1 goto :fail
copy /Y "%SRC%\stamps.db" "%DEST%\" >nul
if errorlevel 1 goto :fail

echo [OK] backup finished: %DEST%
exit /b 0

:fail
echo [ERROR] backup failed - see %DEST%\backup.log
exit /b 1
