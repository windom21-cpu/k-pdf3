# SumatraPDF (bundled binary)

K-PDF3 ships SumatraPDF as a separate executable to handle silent
printing on Windows. The bundled `SumatraPDF.exe` is invoked via
`spawn(...)` only — it is not linked into K-PDF3's binary.

## Bundled version

- **Version**: 3.6.1 (64-bit, portable)
- **Source**: <https://github.com/sumatrapdfreader/sumatrapdf>
- **Download**: <https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.zip>
- **SHA-256**: `719f689b34f47be8ca105ce8484948474dafde0e106bab599e4a89326070c3d0`
- **License**: GPLv3 — see `COPYING`

## Why

K-PDF3's rasterized print output (PNG `/XObject` PDFs from mupdf) stalls
Chromium's silent print pipeline on certain hardware drivers (β3 testing
reproduced ~55-second `webContents.print` hangs on a FUJIFILM Apeos C2360
via wireless). SumatraPDF parses the PDF with its own engine and sends
the print job directly via WinSpool, which avoids that incompatibility.

See `src/main/main.js → sumatraPrintPdf()` for the call site.

## Updating

1. Download the latest portable .zip from the URL above.
2. Replace `SumatraPDF.exe` here with the new binary.
3. Update version + SHA-256 in this file.
4. Re-run β tests on the FUJIFILM (or any wireless multifunction) to
   confirm the new version still accepts our PDFs and respects
   `-print-to` / `-print-settings`.
