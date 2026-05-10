// Post-processes a flatten PDF (produced by mupdf) to inject a flat
// /Outlines tree built from workspace bookmarks. mupdf-js exposes only
// outline reading on the JS side; pdf-lib lets us add outlines via its
// low-level context API.
//
// MVP scope (§17.14 / ADR-0014 follow-up):
//   - flat list only (no nested children)
//   - each entry → /Fit destination on its target page
//   - bookmarks whose pageNo isn't present in the output are dropped
//
// pageOrder: array of pageNo in the order they appear in the output
// PDF (matches workspace.getPages() returning visible pages, which is
// what was passed to mupdf at assembly time).

import { PDFDocument, PDFName, PDFString, PDFArray } from "pdf-lib";

/**
 * @param {Uint8Array | Buffer} pdfBytes
 * @param {Array<{title:string, pageNo:number}>} bookmarks
 * @param {number[]} pageOrder       pageNo of each output page in order
 * @returns {Promise<Uint8Array>}    new PDF bytes with /Outlines added
 */
export async function addFlatOutlinesToPdf(pdfBytes, bookmarks, pageOrder) {
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
    return pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  }
  const indexByPageNo = new Map();
  pageOrder.forEach((pageNo, i) => indexByPageNo.set(pageNo, i));
  const items = bookmarks
    .map((b) => ({ ...b, pdfIdx: indexByPageNo.get(b.pageNo) }))
    .filter((b) => typeof b.pdfIdx === "number" && b.pdfIdx >= 0);
  if (items.length === 0) {
    return pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  }

  const buf = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  const pdf = await PDFDocument.load(buf);
  const pages = pdf.getPages();
  const ctx = pdf.context;

  // Reserve an indirect ref for each outline item up-front so we can
  // wire up Prev / Next / Parent without forward references.
  const itemRefs = items.map(() => ctx.register(ctx.obj({})));
  const rootRef = ctx.register(ctx.obj({}));

  for (let i = 0; i < items.length; i++) {
    const b = items[i];
    const pageRef = pages[b.pdfIdx].ref;
    const dest = PDFArray.withContext(ctx);
    dest.push(pageRef);
    dest.push(PDFName.of("Fit"));
    const dict = ctx.obj({
      Title: PDFString.of(b.title ?? ""),
      Parent: rootRef,
    });
    dict.set(PDFName.of("Dest"), dest);
    if (i > 0) dict.set(PDFName.of("Prev"), itemRefs[i - 1]);
    if (i < items.length - 1) dict.set(PDFName.of("Next"), itemRefs[i + 1]);
    ctx.assign(itemRefs[i], dict);
  }

  const rootDict = ctx.obj({
    Type: PDFName.of("Outlines"),
    Count: items.length,
  });
  rootDict.set(PDFName.of("First"), itemRefs[0]);
  rootDict.set(PDFName.of("Last"), itemRefs[items.length - 1]);
  ctx.assign(rootRef, rootDict);

  pdf.catalog.set(PDFName.of("Outlines"), rootRef);

  return await pdf.save();
}
