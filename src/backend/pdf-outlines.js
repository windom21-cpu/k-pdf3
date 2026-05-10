// Post-processes a flatten PDF (produced by mupdf) to inject an
// /Outlines tree built from workspace bookmarks. mupdf-js exposes only
// outline reading on the JS side; pdf-lib lets us add outlines via its
// low-level context API.
//
// Scope (§17.14 / ADR-0014, nested children variant):
//   - bookmarks may form a tree via parentId
//   - each entry → /Fit destination on its target page
//   - bookmarks whose pageNo isn't present in the output are pruned but
//     their children are reparented to the bookmark's parent (so they
//     don't disappear silently)
//
// pageOrder: array of pageNo in the order they appear in the output
// PDF (matches workspace.getPages() returning visible pages, which is
// what was passed to mupdf at assembly time).

import { PDFDocument, PDFName, PDFHexString, PDFArray } from "pdf-lib";

/**
 * @param {Uint8Array | Buffer} pdfBytes
 * @param {Array<{id?:string, parentId?:string|null, title:string, pageNo:number, sortOrder?:number}>} bookmarks
 * @param {number[]} pageOrder       pageNo of each output page in order
 * @returns {Promise<Uint8Array>}    new PDF bytes with /Outlines added
 */
export async function addFlatOutlinesToPdf(pdfBytes, bookmarks, pageOrder) {
  const passthrough = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) return passthrough;

  const indexByPageNo = new Map();
  pageOrder.forEach((pageNo, i) => indexByPageNo.set(pageNo, i));

  const tree = buildOutlineTree(bookmarks, indexByPageNo);
  if (tree.length === 0) return passthrough;

  const buf = passthrough;
  const pdf = await PDFDocument.load(buf);
  const pages = pdf.getPages();
  const ctx = pdf.context;

  const rootRef = ctx.register(ctx.obj({}));

  // First walk: assign indirect refs to every node so siblings/parents
  // can wire up before/after each other without forward references.
  const assignRefs = (nodes) => {
    for (const n of nodes) {
      n.ref = ctx.register(ctx.obj({}));
      if (n.children.length) assignRefs(n.children);
    }
  };
  assignRefs(tree);

  // Second walk: emit dictionaries.
  const emit = (nodes, parentRef) => {
    let count = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const pageRef = pages[n.pdfIdx].ref;
      const dest = PDFArray.withContext(ctx);
      dest.push(pageRef);
      dest.push(PDFName.of("Fit"));
      // PDFHexString.fromText encodes as UTF-16BE with BOM — required
      // for CJK / non-ASCII titles to render in Adobe / Preview / Edge.
      const dict = ctx.obj({
        Title: PDFHexString.fromText(n.title ?? ""),
        Parent: parentRef,
      });
      dict.set(PDFName.of("Dest"), dest);
      if (i > 0) dict.set(PDFName.of("Prev"), nodes[i - 1].ref);
      if (i < nodes.length - 1) dict.set(PDFName.of("Next"), nodes[i + 1].ref);
      let descendantCount = 0;
      if (n.children.length) {
        descendantCount = emit(n.children, n.ref);
        dict.set(PDFName.of("First"), n.children[0].ref);
        dict.set(PDFName.of("Last"), n.children[n.children.length - 1].ref);
        // Positive Count = subtree starts open in the viewer.
        dict.set(PDFName.of("Count"), ctx.obj(descendantCount));
      }
      ctx.assign(n.ref, dict);
      count += 1 + descendantCount;
    }
    return count;
  };
  const totalVisible = emit(tree, rootRef);

  const rootDict = ctx.obj({
    Type: PDFName.of("Outlines"),
    Count: totalVisible,
  });
  rootDict.set(PDFName.of("First"), tree[0].ref);
  rootDict.set(PDFName.of("Last"), tree[tree.length - 1].ref);
  ctx.assign(rootRef, rootDict);

  pdf.catalog.set(PDFName.of("Outlines"), rootRef);

  return await pdf.save();
}

/**
 * Build a tree from the flat bookmarks list.
 * - Filters out entries whose pageNo isn't in pageOrder, but promotes
 *   their children up to the missing entry's parent so the hierarchy
 *   doesn't collapse.
 * - Sorts siblings by sortOrder (stable for ties — input order wins).
 */
function buildOutlineTree(bookmarks, indexByPageNo) {
  const byId = new Map();
  for (const b of bookmarks) {
    byId.set(b.id, {
      id: b.id,
      parentId: b.parentId ?? null,
      title: b.title,
      pageNo: b.pageNo,
      sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : 0,
      pdfIdx: indexByPageNo.get(b.pageNo),
      children: [],
    });
  }
  // Effective parent: nearest ancestor that survives the page-prune.
  const effectiveParent = (rawParentId) => {
    let pid = rawParentId;
    while (pid != null) {
      const p = byId.get(pid);
      if (!p) return null;
      if (typeof p.pdfIdx === "number" && p.pdfIdx >= 0) return p;
      pid = p.parentId;
    }
    return null;
  };
  const top = [];
  for (const b of bookmarks) {
    const node = byId.get(b.id);
    if (typeof node.pdfIdx !== "number" || node.pdfIdx < 0) continue;
    const parent = effectiveParent(node.parentId);
    if (parent) parent.children.push(node);
    else top.push(node);
  }
  const sortRec = (arr) => {
    arr.sort((a, b) => a.sortOrder - b.sortOrder);
    for (const n of arr) sortRec(n.children);
  };
  sortRec(top);
  return top;
}
