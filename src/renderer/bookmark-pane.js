// Bookmarks sidebar (M5-5).
//
// Owns the workspace-side bookmark CRUD (+/-/←/→ buttons, double-click
// rename, right-click context menu), HTML5 drag/drop reordering with
// a 3-zone drop band (before / into / after), Tab / Shift+Tab indent /
// outdent, and the "auto-import source PDF /Outlines into workspace"
// flow used on first PDF open.
//
// Per-tab state (selectedBookmarkId / bookmarkSource /
// workspaceBookmarksCache) is owned here but exposed via
// getBookmarkSnapshot / setBookmarkSnapshot / clearBookmarkState so
// renderer.js's saveActiveTabSnapshot / applyTab / closeTab can keep
// the per-tab scratch slots aligned.
//
// Public API:
//   initBookmarkPane({...})
//   refreshBookmarks()         — repopulate after open / mutation
//   actionImportOutlines()     — flatten source PDF /Outlines into ws
//   getBookmarkSnapshot()      — for saveActiveTabSnapshot
//   setBookmarkSnapshot(snap)  — for applyTab
//   clearBookmarkState()       — for setOpen(false) / closeTab

const { kpdf3 } = window;
const $ = (id) => document.getElementById(id);

let _viewer = null;
let _wsStatus = null;
let _isOpen = () => false;
let _showRangePrompt = async () => null;

const bookmarkTree = $("bookmark-tree");
const ctxBookmark = $("ctx-bookmark");

// Selected bookmark id (workspace-side bookmarks only). null when the
// list is showing read-only /Outlines from the source PDF.
let selectedBookmarkId = null;
let bookmarkSource = "outline"; // "outline" | "workspace"
// Flat list cached so indent / outdent can compute the new parent /
// sibling without an extra round-trip to the DB.
let workspaceBookmarksCache = [];

export function initBookmarkPane({ viewer, wsStatus, isOpen, showRangePrompt }) {
  _viewer = viewer;
  _wsStatus = wsStatus;
  _isOpen = isOpen;
  _showRangePrompt = showRangePrompt;
}

export function getBookmarkSnapshot() {
  return {
    selectedBookmarkId,
    bookmarkSource,
    workspaceBookmarksCache,
  };
}

export function setBookmarkSnapshot(snap) {
  selectedBookmarkId = snap.selectedBookmarkId;
  bookmarkSource = snap.bookmarkSource;
  workspaceBookmarksCache = snap.workspaceBookmarksCache;
}

export function clearBookmarkState() {
  selectedBookmarkId = null;
  bookmarkSource = "outline";
  workspaceBookmarksCache = [];
}

/** β.94: タブ切替時に呼ばれ、bookmark DOM を即時クリアする。
 *  refreshBookmarks は viewer 再構築の async chain で fire-and-forget 呼出し
 *  されるため、その間 DOM には前タブのしおりが残り、refreshBookmarks の
 *  innerHTML="" が走るまで「前タブのしおりが残ったまま新タブのしおりが
 *  追加される」レース条件で並行表示されるケースがあった。
 *  applyStateFromTab で同期的にこの関数を呼ぶことで、新タブ環境に入る
 *  瞬間に DOM が空に保証される。 */
export function clearBookmarkDom() {
  bookmarkTree.innerHTML = "";
  const sourceLabel = $("bookmark-source-label");
  if (sourceLabel) sourceLabel.textContent = "";
}

export async function refreshBookmarks() {
  bookmarkTree.innerHTML = "";
  refreshBookmarkToolbarState();
  if (!_isOpen()) {
    selectedBookmarkId = null;
    workspaceBookmarksCache = [];
    return;
  }
  // Workspace bookmarks override the source PDF /Outlines once any
  // exist. Empty workspace list → show /Outlines (read-only).
  const ws = await kpdf3.listBookmarks();
  const sourceLabel = $("bookmark-source-label");
  if (Array.isArray(ws) && ws.length > 0) {
    bookmarkSource = "workspace";
    workspaceBookmarksCache = ws;
    if (sourceLabel) sourceLabel.textContent = "";
    const tree = buildBookmarkTree(ws);
    for (const node of tree) {
      bookmarkTree.appendChild(createWorkspaceBookmarkNode(node));
    }
    // Selection may now refer to a still-existing id; if not, drop it.
    if (selectedBookmarkId && !ws.some((b) => b.id === selectedBookmarkId)) {
      selectedBookmarkId = null;
    }
    if (selectedBookmarkId) selectBookmark(selectedBookmarkId);
    refreshBookmarkToolbarState();
    return;
  }
  bookmarkSource = "outline";
  workspaceBookmarksCache = [];
  selectedBookmarkId = null;
  if (sourceLabel) sourceLabel.textContent = "(元 PDF / 編集不可)";
  const outline = await kpdf3.getOutline();
  if (!outline || outline.length === 0) {
    const li = document.createElement("li");
    li.className = "bookmark-empty";
    li.textContent = "(しおりがありません)";
    bookmarkTree.appendChild(li);
    refreshBookmarkToolbarState();
    return;
  }
  for (const item of outline) {
    bookmarkTree.appendChild(createBookmarkNode(item));
  }
  refreshBookmarkToolbarState();
}

/** Group flat workspace bookmarks (already sorted by sortOrder) into a
 *  tree by parentId. Orphans (parentId pointing nowhere) are promoted
 *  to top level so they remain visible / editable. */
function buildBookmarkTree(flat) {
  const byId = new Map();
  for (const b of flat) byId.set(b.id, { ...b, children: [] });
  const top = [];
  for (const b of flat) {
    const node = byId.get(b.id);
    const parent = b.parentId && byId.get(b.parentId);
    if (parent) parent.children.push(node);
    else top.push(node);
  }
  return top;
}

function createBookmarkNode(item) {
  const li = document.createElement("li");
  li.className = "bookmark-item";
  li.textContent = item.title || "(無題)";
  if (typeof item.pageNo === "number" && item.pageNo > 0) {
    li.dataset.pageNo = String(item.pageNo);
    li.title = `${item.title} (p.${item.pageNo})`;
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      _viewer.scrollToPage(item.pageNo);
    });
  } else {
    li.style.color = "#666";
  }
  if (Array.isArray(item.children) && item.children.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "bookmark-children";
    for (const child of item.children) {
      ul.appendChild(createBookmarkNode(child));
    }
    li.appendChild(ul);
  }
  return li;
}

/** Workspace-side bookmarks: clickable + selectable + double-click rename
 *  + draggable for reorder/reparent. Walks `node.children` recursively. */
function createWorkspaceBookmarkNode(node) {
  const li = document.createElement("li");
  li.className = "bookmark-item is-workspace";
  li.dataset.bookmarkId = node.id;
  li.dataset.pageNo = String(node.pageNo);
  li.title = `${node.title} (p.${node.pageNo})`;
  li.tabIndex = 0;
  li.draggable = true;
  const label = document.createElement("span");
  label.className = "bookmark-label";
  label.textContent = node.title || "(無題)";
  li.appendChild(label);
  const pageTag = document.createElement("span");
  pageTag.className = "bookmark-page-tag";
  pageTag.textContent = node.pageNo > 0 ? `p.${node.pageNo}` : "挿入";
  li.appendChild(pageTag);
  li.addEventListener("click", (e) => {
    e.stopPropagation();
    selectBookmark(node.id);
    if (typeof node.pageNo === "number") _viewer.scrollToPage(node.pageNo);
  });
  li.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startInlineRenameBookmark(li, node);
  });
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectBookmark(node.id);
    showBookmarkContextMenu(li, node, e.clientX, e.clientY);
  });
  attachBookmarkDnd(li, node);

  if (Array.isArray(node.children) && node.children.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "bookmark-children";
    for (const child of node.children) {
      ul.appendChild(createWorkspaceBookmarkNode(child));
    }
    li.appendChild(ul);
  }
  return li;
}

/** HTML5 drag handlers on a bookmark <li>. Computes the drop intent
 *  (drop-before / drop-into / drop-after) from cursor Y within the row,
 *  then asks main to move the dragged bookmark. */
function attachBookmarkDnd(li, node) {
  const MIME = "application/x-kpdf3-bookmark-id";
  li.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(MIME, node.id);
    // text/plain fallback so the OS doesn't treat it as a no-op.
    e.dataTransfer.setData("text/plain", node.title || node.id);
    li.classList.add("is-dragging");
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("is-dragging");
    clearBookmarkDropIndicators();
  });
  li.addEventListener("dragover", (e) => {
    if (!hasBookmarkPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const draggedId = e.dataTransfer?.getData(MIME) || dragInFlightId;
    if (draggedId === node.id || isAncestorOf(draggedId, node.id)) {
      // Disallow dropping a node onto itself or a descendant.
      clearBookmarkDropIndicators();
      return;
    }
    const zone = bookmarkDropZone(li, e.clientY);
    setBookmarkDropIndicator(li, zone);
  });
  li.addEventListener("dragleave", (e) => {
    // Only clear if we left this row entirely (relatedTarget outside it).
    if (!li.contains(e.relatedTarget)) {
      li.classList.remove("drop-before", "drop-into", "drop-after");
    }
  });
  li.addEventListener("drop", async (e) => {
    if (!hasBookmarkPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const draggedId = e.dataTransfer.getData(MIME);
    clearBookmarkDropIndicators();
    if (!draggedId || draggedId === node.id) return;
    if (isAncestorOf(draggedId, node.id)) return;
    const zone = bookmarkDropZone(li, e.clientY);
    const target = workspaceBookmarksCache.find((b) => b.id === node.id);
    if (!target) return;
    let parentId, beforeId;
    if (zone === "into") {
      parentId = node.id;
      beforeId = null;
    } else if (zone === "before") {
      parentId = target.parentId ?? null;
      beforeId = node.id;
    } else { // after
      parentId = target.parentId ?? null;
      beforeId = nextSiblingId(target);
    }
    try {
      await kpdf3.moveBookmark({ id: draggedId, parentId, beforeId });
      selectedBookmarkId = draggedId;
      await refreshBookmarks();
    } catch (err) {
      console.error("[bookmark] move failed", err);
      _wsStatus.textContent = `しおり移動失敗: ${err.message ?? err}`;
    }
  });
}

let dragInFlightId = null; // fallback when dataTransfer is read-only mid-drag

function hasBookmarkPayload(dt) {
  if (!dt) return false;
  return Array.from(dt.types || []).includes("application/x-kpdf3-bookmark-id");
}

function bookmarkDropZone(li, clientY) {
  const r = li.getBoundingClientRect();
  // Use the row band only (children sub-list is excluded).
  const rowBottom = r.top + Math.min(r.height, 24);
  const y = clientY;
  const band = (rowBottom - r.top) / 3;
  if (y < r.top + band) return "before";
  if (y < r.top + band * 2) return "into";
  return "after";
}

function setBookmarkDropIndicator(li, zone) {
  clearBookmarkDropIndicators();
  if (zone === "before") li.classList.add("drop-before");
  else if (zone === "into") li.classList.add("drop-into");
  else if (zone === "after") li.classList.add("drop-after");
}

function clearBookmarkDropIndicators() {
  for (const el of bookmarkTree.querySelectorAll(".drop-before, .drop-into, .drop-after")) {
    el.classList.remove("drop-before", "drop-into", "drop-after");
  }
}

/** True if `ancestorId` is an ancestor of `descendantId` in the cached
 *  flat list. Cheap O(depth) walk via parentId. */
function isAncestorOf(ancestorId, descendantId) {
  if (!ancestorId || !descendantId) return false;
  let cur = workspaceBookmarksCache.find((b) => b.id === descendantId);
  while (cur && cur.parentId) {
    if (cur.parentId === ancestorId) return true;
    cur = workspaceBookmarksCache.find((b) => b.id === cur.parentId);
  }
  return false;
}

/** Find the next sibling id (same parent) of `b` in the cached list,
 *  or null if `b` is the last sibling. */
function nextSiblingId(b) {
  const siblings = workspaceBookmarksCache
    .filter((x) => (x.parentId ?? null) === (b.parentId ?? null))
    .sort((a, c) => a.sortOrder - c.sortOrder);
  const idx = siblings.findIndex((x) => x.id === b.id);
  if (idx < 0 || idx === siblings.length - 1) return null;
  return siblings[idx + 1].id;
}

function selectBookmark(id) {
  selectedBookmarkId = id;
  for (const el of bookmarkTree.querySelectorAll(".bookmark-item.is-workspace")) {
    el.classList.toggle("is-selected", el.dataset.bookmarkId === id);
  }
  refreshBookmarkToolbarState();
}

function refreshBookmarkToolbarState() {
  const addBtn = $("bookmark-add");
  const rmBtn = $("bookmark-remove");
  const indentBtn = $("bookmark-indent");
  const outdentBtn = $("bookmark-outdent");
  if (addBtn) addBtn.disabled = !_isOpen();
  if (rmBtn) rmBtn.disabled = !_isOpen() || !selectedBookmarkId || bookmarkSource !== "workspace";
  // Import is now triggered automatically on first open (openPdfPath).
  const sel = selectedBookmarkId
    ? workspaceBookmarksCache.find((b) => b.id === selectedBookmarkId)
    : null;
  if (indentBtn) {
    indentBtn.disabled = !sel || !canIndentBookmark(sel);
  }
  if (outdentBtn) {
    outdentBtn.disabled = !sel || !canOutdentBookmark(sel);
  }
}

function canIndentBookmark(b) {
  // Indent = move under the previous sibling (which must exist).
  return !!previousSiblingId(b);
}

function canOutdentBookmark(b) {
  // Outdent = promote to grandparent. Only valid when current parent
  // exists (otherwise we're already at top level).
  return !!b.parentId;
}

function previousSiblingId(b) {
  const siblings = workspaceBookmarksCache
    .filter((x) => (x.parentId ?? null) === (b.parentId ?? null))
    .sort((a, c) => a.sortOrder - c.sortOrder);
  const idx = siblings.findIndex((x) => x.id === b.id);
  if (idx <= 0) return null;
  return siblings[idx - 1].id;
}

async function actionIndentBookmark() {
  const sel = selectedBookmarkId
    ? workspaceBookmarksCache.find((b) => b.id === selectedBookmarkId)
    : null;
  if (!sel) return;
  const prevId = previousSiblingId(sel);
  if (!prevId) return;
  try {
    await kpdf3.moveBookmark({ id: sel.id, parentId: prevId, beforeId: null });
    await refreshBookmarks();
  } catch (err) {
    console.error("[bookmark] indent failed", err);
  }
}

async function actionOutdentBookmark() {
  const sel = selectedBookmarkId
    ? workspaceBookmarksCache.find((b) => b.id === selectedBookmarkId)
    : null;
  if (!sel || !sel.parentId) return;
  const parent = workspaceBookmarksCache.find((b) => b.id === sel.parentId);
  if (!parent) return;
  // Place after parent (= before parent's next sibling).
  const beforeId = nextSiblingId(parent);
  try {
    await kpdf3.moveBookmark({
      id: sel.id,
      parentId: parent.parentId ?? null,
      beforeId,
    });
    await refreshBookmarks();
  } catch (err) {
    console.error("[bookmark] outdent failed", err);
  }
}

function startInlineRenameBookmark(li, b) {
  const label = li.querySelector(".bookmark-label");
  if (!label) return;
  const input = document.createElement("input");
  input.type = "text";
  input.value = b.title;
  input.className = "bookmark-rename-input";
  label.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim() || b.title;
    if (commit && next !== b.title) {
      try {
        await kpdf3.renameBookmark({ id: b.id, title: next });
      } catch (err) {
        console.error("[bookmark] rename failed", err);
      }
    }
    await refreshBookmarks();
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
}

async function actionAddBookmark() {
  if (!_isOpen()) return;
  const pageNo = _viewer.currentPage;
  if (!pageNo) return;
  const fallback = `ページ ${pageNo > 0 ? pageNo : "挿入"}`;
  const entered = await _showRangePrompt({
    title: "しおりを追加",
    message: `ページ ${pageNo > 0 ? pageNo : "挿入"} のしおり名を入力（空欄で「${fallback}」）`,
    value: "",
  });
  if (entered === null) return; // user cancelled
  const id = (crypto?.randomUUID?.() ?? `bm-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const title = entered.trim() || fallback;
  try {
    await kpdf3.addBookmark({ id, title, pageNo });
    await refreshBookmarks();
    selectBookmark(id);
  } catch (err) {
    console.error("[bookmark] add failed", err);
    _wsStatus.textContent = `しおり追加失敗: ${err.message ?? err}`;
  }
}

async function actionRemoveBookmark() {
  if (!selectedBookmarkId) return;
  try {
    await kpdf3.removeBookmark({ id: selectedBookmarkId });
    selectedBookmarkId = null;
    await refreshBookmarks();
  } catch (err) {
    console.error("[bookmark] remove failed", err);
  }
}

$("bookmark-add")?.addEventListener("click", actionAddBookmark);
$("bookmark-remove")?.addEventListener("click", actionRemoveBookmark);
$("bookmark-indent")?.addEventListener("click", actionIndentBookmark);
$("bookmark-outdent")?.addEventListener("click", actionOutdentBookmark);

// ---- Bookmark right-click context menu --------------------------------

// Cache the <li> + node so 名前を変更 can run startInlineRenameBookmark
// without re-traversing the DOM (the right-clicked <li> may be the one
// inside a nested children <ul>).
let _bookmarkCtxTarget = null;
function showBookmarkContextMenu(li, node, x, y) {
  if (!ctxBookmark) return;
  _bookmarkCtxTarget = { li, node };
  ctxBookmark.style.left = `${x}px`;
  ctxBookmark.style.top = `${y}px`;
  ctxBookmark.hidden = false;
}
function hideBookmarkContextMenu() {
  if (!ctxBookmark) return;
  ctxBookmark.hidden = true;
  _bookmarkCtxTarget = null;
}
function dispatchBookmarkCtx(target) {
  const ctx = _bookmarkCtxTarget;
  hideBookmarkContextMenu();
  if (!(target instanceof HTMLElement) || !ctx) return;
  const action = target.dataset.ctx;
  if (action === "rename") {
    // Defer to next frame so the pointerdown/up/click sequence on the
    // menu item fully settles before we create the rename <input>.
    // Otherwise a trailing focus shift (or other listener triggered by
    // the same click) can race against input.focus() and the blur path
    // fires finish() before the user types anything.
    requestAnimationFrame(() => startInlineRenameBookmark(ctx.li, ctx.node));
  } else if (action === "delete") {
    actionRemoveBookmark();
  }
}
ctxBookmark?.addEventListener("pointerdown", (e) => {
  // preventDefault stops the browser's native mousedown→focus shift that
  // would otherwise steal focus from the rename <input> that
  // startInlineRenameBookmark creates synchronously inside dispatchBookmarkCtx.
  // Without this the input loses focus immediately, its blur listener
  // fires finish(commit=true) with an unchanged value, and the rename
  // silently no-ops — looking like "右クリック→名前を変更が効かない".
  e.preventDefault();
  e.stopPropagation();
  let el = e.target;
  while (el && el !== ctxBookmark && !(el.dataset && el.dataset.ctx)) {
    el = el.parentElement;
  }
  if (el && el !== ctxBookmark) dispatchBookmarkCtx(el);
});
ctxBookmark?.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("pointerdown", (ev) => {
  if (!ctxBookmark || ctxBookmark.hidden) return;
  if (ev.target instanceof Node && ctxBookmark.contains(ev.target)) return;
  hideBookmarkContextMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideBookmarkContextMenu();
});

// Tab / Shift+Tab when focus is inside the bookmark sidebar.
bookmarkTree?.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  if (bookmarkSource !== "workspace" || !selectedBookmarkId) return;
  e.preventDefault();
  if (e.shiftKey) actionOutdentBookmark();
  else actionIndentBookmark();
});

/** Flatten the source-PDF /Outlines tree into workspace bookmarks so the
 *  user can edit / extend them. The tree is walked depth-first; titles
 *  for nodes without a target page get suffixed "(章)" so they stay
 *  visible but skip navigation. Subsequent calls are guarded by the
 *  toolbar disabled state when workspace bookmarks already exist. */
export async function actionImportOutlines() {
  if (!_isOpen()) return;
  const outline = await kpdf3.getOutline();
  if (!Array.isArray(outline) || outline.length === 0) {
    _wsStatus.textContent = "取り込めるしおりがありません";
    return;
  }
  // Depth-first walk that preserves the source PDF's hierarchy. Nodes
  // without a pageNo of their own inherit the parent's (or 1 if absent)
  // so they're still navigable.
  let added = 0;
  const walk = async (nodes, fallbackPage, parentId) => {
    for (const n of nodes) {
      const pageNo = typeof n.pageNo === "number" && n.pageNo > 0 ? n.pageNo : fallbackPage;
      const id =
        crypto?.randomUUID?.() ?? `bm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await kpdf3.addBookmark({
        id,
        title: n.title || "(無題)",
        pageNo,
        parentId,
      });
      added += 1;
      if (Array.isArray(n.children) && n.children.length > 0) {
        await walk(n.children, pageNo, id);
      }
    }
  };
  try {
    await walk(outline, 1, null);
    await refreshBookmarks();
    _wsStatus.textContent = `${added} 件のしおりを取り込みました`;
  } catch (err) {
    console.error("[bookmark] import failed", err);
    _wsStatus.textContent = `取り込み失敗: ${err.message ?? err}`;
  }
}
