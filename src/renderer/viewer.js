// K-PDF3 viewer (M2 step 4b).
//
// Owns the scrollable page list. Each page is an absolutely-positioned div
// inside a relative inner container whose total height matches the layout
// produced by PageRegistry.layout(...). IntersectionObserver triggers
// renders for pages entering the viewport (with a small rootMargin so
// pages render slightly ahead of where the user lands).
//
// All renders go through window.kpdf3.renderPage(pageNo, opts), which
// invokes the main-process render-service.
//
// M2 minimal:
//   - fixed zoom (no zoom UI yet)
//   - no overlay editing (project-store empty)
//   - canvas stays put after a page leaves the viewport (no eviction)
//
// M3+ will add: zoom control, overlay editor surface, canvas eviction LRU.

import { PageRegistry, visiblePageRange } from "../domain/page-registry.js";
import { getTextFontStack } from "./fonts.js";

/**
 * Paint a user-inserted blank/text page into a Uint8ClampedArray suitable
 * for ImageData. The page is white; if `syntheticText` is non-empty we
 * draw it at 72pt (× zoom) starting at a 50pt margin.
 *
 * @param {{pageNo:number, cropW:number, cropH:number, syntheticText?:string}} row
 * @param {number} zoom
 * @returns {{width:number,height:number,channels:4,pixels:Uint8ClampedArray}}
 */
export function renderSyntheticPagePixels(row, zoom) {
  const w = Math.max(1, Math.round((row.cropW || 595) * zoom));
  const h = Math.max(1, Math.round((row.cropH || 842) * zoom));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const text = (row.syntheticText ?? "").trim();
  if (text) {
    ctx.fillStyle = "#000000";
    const fontPx = 72 * zoom;
    ctx.font = `${fontPx}px "MS UI Gothic", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", serif`;
    ctx.textBaseline = "top";
    const margin = 50 * zoom;
    let y = margin;
    for (const line of text.split(/\r?\n/)) {
      ctx.fillText(line, margin, y);
      y += fontPx * 1.2;
      if (y > h - fontPx) break;
    }
  }
  const imgData = ctx.getImageData(0, 0, w, h);
  return {
    width: w,
    height: h,
    channels: 4,
    pixels: imgData.data,
  };
}

const DEFAULT_ZOOM = 1.5;
const GAP = 8; // px between pages (CSS pixel)
const ROOT_MARGIN = "200px 0px"; // prefetch threshold

/** Oversampling factor: render the canvas at this multiple of the CSS size,
 *  then let the browser downscale via `canvas.style.width: 100%`. This buys
 *  sharper text/lines on standard-DPI displays without making pages bigger.
 *  Memory cost is OVERSAMPLE^2 per visible page; virtualization keeps the
 *  working set bounded. The base level is multiplied by the device's
 *  natural DPR (capped at 2×). The user can change the level at runtime
 *  via Viewer.setRenderQuality(level). */
const RENDER_QUALITY_MULTIPLIERS = {
  standard: 1.0,
  high: 2.0,
  max: 3.0,
};
const DEFAULT_RENDER_QUALITY = "high";
function computeOversample(level) {
  const mul = RENDER_QUALITY_MULTIPLIERS[level] ?? RENDER_QUALITY_MULTIPLIERS[DEFAULT_RENDER_QUALITY];
  return Math.min(window.devicePixelRatio || 1, 2) * mul;
}

export class Viewer {
  /**
   * @param {HTMLElement} container scrollable host element (overflow-y: auto)
   * @param {object} [opts]
   * @param {import("../domain/project-store.js").ProjectStore} [opts.projectStore]
   * @param {(pageNo: number, x: number, y: number, evt: PointerEvent) => void} [opts.onPagePointerDown]
   * @param {(overlayId: string) => void} [opts.onOverlayClick]
   * @param {(overlayId: string, newText: string) => void} [opts.onTextEditCommit]
   * @param {(overlayId: string, newX: number, newY: number) => void} [opts.onOverlayDragEnd]
   * @param {(overlayId: string, bbox: { x: number, y: number, w: number, h: number }) => void} [opts.onOverlayResizeEnd]
   * @param {(overlayId: string, clientX: number, clientY: number) => void} [opts.onOverlayContextMenu]
   * @param {(currentPage: number, totalPages: number) => void} [opts.onPageChange]
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.projectStore = opts.projectStore ?? null;
    this.onPagePointerDown = opts.onPagePointerDown ?? null;
    this.onOverlayClick = opts.onOverlayClick ?? null;
    this.onTextEditCommit = opts.onTextEditCommit ?? null;
    this.onOverlayDragEnd = opts.onOverlayDragEnd ?? null;
    this.onOverlayResizeEnd = opts.onOverlayResizeEnd ?? null;
    this.onOverlayContextMenu = opts.onOverlayContextMenu ?? null;
    this.onPageChange = opts.onPageChange ?? null;
    /** @type {number} 1-based; 0 means "no page yet" */
    this._currentPage = 0;
    /** @type {((evt: Event) => void) | null} */
    this._scrollHandler = null;
    /** @type {string | null} id of overlay currently being inline-edited */
    this._editingId = null;
    /** @type {PageRegistry | null} */
    this.registry = null;
    /** @type {ReturnType<PageRegistry['layout']> | null} */
    this.layout = null;
    /** @type {Map<number, HTMLDivElement>} */
    this.pageEls = new Map();
    /** @type {Map<number, HTMLCanvasElement>} */
    this.canvasEls = new Map();
    /** @type {Set<number>} */
    this.pendingRenders = new Set();
    /** @type {IntersectionObserver | null} */
    this.observer = null;
    /** @type {(() => void) | null} */
    this._unsubscribeStore = null;
    /** @type {Array<any> | null} pages last passed to load() — used by setZoom to rebuild */
    this._pages = null;
    this._zoom = DEFAULT_ZOOM;
    this._renderQuality = DEFAULT_RENDER_QUALITY;
    if (this.projectStore) {
      this._subscribeStore();
    }
  }

  /** Page space (canonical PDF point) ↔ pixel scale currently in use. */
  get zoom() {
    return this._zoom;
  }

  /**
   * Change the zoom factor. Re-layouts and re-renders all pages while
   * preserving the user's scroll position relative to the document so
   * they stay near the same content.
   *
   * @param {number} z
   */
  setZoom(z) {
    if (z <= 0 || !Number.isFinite(z)) return;
    if (Math.abs(this._zoom - z) < 1e-6) return;
    if (!this._pages || this._pages.length === 0) {
      this._zoom = z;
      return;
    }
    const oldHeight = Math.max(this.container.scrollHeight, 1);
    const ratio = this.container.scrollTop / oldHeight;
    this._zoom = z;
    // load() rebuilds at the current zoom (which we just updated).
    this.load(this._pages);
    this.container.scrollTop = ratio * Math.max(this.container.scrollHeight, 1);
  }

  get renderQuality() {
    return this._renderQuality;
  }

  /**
   * Change the canvas oversampling level. Drops the existing canvases so
   * visible pages re-render at the new resolution. Layout / scroll position
   * are unaffected (only internal pixel density changes).
   * @param {"standard" | "high" | "max"} level
   */
  setRenderQuality(level) {
    if (!(level in RENDER_QUALITY_MULTIPLIERS)) return;
    if (level === this._renderQuality) return;
    this._renderQuality = level;
    if (!this._pages || this._pages.length === 0) return;
    // Rebuild via load() which clears canvases and re-renders visible pages.
    this.load(this._pages);
  }

  /**
   * Load a workspace's pages into the viewer.
   * @param {Array<{pageNo:number, cropW:number, cropH:number, rotation:number, userRotation?:number}>} pages
   */
  load(pages) {
    this.unload();
    this._pages = pages;
    if (pages.length === 0) {
      this._currentPage = 0;
      if (this.onPageChange) this.onPageChange(0, 0);
      return;
    }

    this.registry = new PageRegistry(pages);
    this.layout = this.registry.layout({ zoom: this._zoom, gap: GAP });
    this._buildPageDoms();
    this._setupObserver();
    this._setupScrollListener();
    // Reset to top by default. setZoom overrides this afterwards to keep
    // the user's scroll position relative to the document.
    this.container.scrollTop = 0;
    this._currentPage = this.registry.pageNoAtPos(0) || 1;
    if (this.onPageChange) this.onPageChange(this._currentPage, pages.length);
  }

  /** Tear down DOM + observers; safe to call multiple times. _pages is
   *  retained so setZoom can rebuild without re-fetching from main. */
  unload() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this._scrollHandler) {
      this.container.removeEventListener("scroll", this._scrollHandler);
      this._scrollHandler = null;
    }
    this.container.innerHTML = "";
    this.pageEls.clear();
    this.canvasEls.clear();
    this.pendingRenders.clear();
    this.registry = null;
    this.layout = null;
  }

  /** Current 1-based page number (best-effort, based on visible-range). */
  get currentPage() {
    return this._currentPage;
  }

  /** Scroll the viewer so `pageNo` is at the top of the viewport. */
  scrollToPage(pageNo) {
    if (!this.layout || !this.registry) return;
    const pos = this.registry.posOfPageNo(pageNo);
    if (pos < 0) return;
    this.container.scrollTop = this.layout.pageTops[pos];
  }

  _setupScrollListener() {
    let scheduled = false;
    this._scrollHandler = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (!this.layout || !this.registry) return;
        const range = visiblePageRange(
          this.layout,
          this.container.scrollTop,
          this.container.clientHeight,
        );
        // range.first is a 1-based POSITION; translate to source-PDF pageNo
        // (sparse-safe after deletions).
        const nextPageNo =
          range.first > 0
            ? this.registry.pageNoAtPos(range.first - 1)
            : this._currentPage;
        if (nextPageNo !== this._currentPage) {
          this._currentPage = nextPageNo;
          if (this.onPageChange) this.onPageChange(nextPageNo, this.registry.count());
        }
      });
    };
    this.container.addEventListener("scroll", this._scrollHandler, {
      passive: true,
    });
  }

  dispose() {
    this.unload();
    if (this._unsubscribeStore) {
      this._unsubscribeStore();
      this._unsubscribeStore = null;
    }
  }

  /**
   * Re-apply text style (font / size / color) to the inline-edit
   * element of the currently-edited overlay, if any. Called by the
   * renderer when the user changes the font / size selects during a
   * live edit. The store has already been updated; this method just
   * keeps the visible DOM in sync (otherwise the viewer's "preserve
   * editing element across store events" logic would freeze the look
   * until the edit commits).
   * @param {{fontId?: string, fontSize?: number, color?: string}} style
   */
  applyEditingTextStyle(style) {
    if (!this._editingId) return;
    const editEl = this.container.querySelector(
      `.overlay[data-overlay-id="${cssEscape(this._editingId)}"]`,
    );
    if (!editEl) return;
    if (typeof style.fontSize === "number") {
      editEl.style.fontSize = `${style.fontSize * this.zoom}px`;
    }
    if (style.fontId) {
      editEl.style.fontFamily = getTextFontStack(style.fontId);
    }
    if (style.color) {
      editEl.style.color = style.color;
    }
  }

  /**
   * Toggle edit-mode classes on the container so CSS can switch the
   * page cursor per placement mode (text → I-beam, stamp/redaction →
   * crosshair).
   * @param {boolean | "none" | "text" | "stamp" | "redaction"} mode
   */
  setEditMode(mode) {
    const isOn = !!mode && mode !== "none";
    const modeStr = typeof mode === "string" ? mode : (isOn ? "edit" : "none");
    this.container.classList.toggle("edit-mode", isOn);
    this.container.classList.toggle("placement-text", modeStr === "text");
    this.container.classList.toggle("placement-stamp", modeStr === "stamp");
    this.container.classList.toggle("placement-redaction", modeStr === "redaction");
  }

  _subscribeStore() {
    if (!this.projectStore) return;
    this._unsubscribeStore = this.projectStore.subscribe((event) => {
      if (event.kind === "reset") {
        for (const pageNo of this.pageEls.keys()) {
          this._renderPageOverlays(pageNo);
        }
      } else if (event.pages) {
        for (const pageNo of event.pages) {
          this._renderPageOverlays(pageNo);
        }
      }
    });
  }

  _buildPageDoms() {
    const inner = document.createElement("div");
    inner.className = "viewer-inner";
    inner.style.position = "relative";
    inner.style.width = `${this.layout.maxWidth}px`;
    inner.style.height = `${this.layout.totalHeight}px`;
    inner.style.margin = "0 auto";

    const N = this.registry.count();
    for (let i = 0; i < N; i++) {
      // pageNo is the source PDF page number (sparse after deletions);
      // the *position* i is what indexes the layout arrays.
      const pageNo = this.registry.pageNoAtPos(i);
      const div = document.createElement("div");
      div.className = "viewer-page";
      div.dataset.pageNo = String(pageNo);
      div.style.position = "absolute";
      div.style.top = `${this.layout.pageTops[i]}px`;
      const left = (this.layout.maxWidth - this.layout.pageWidths[i]) / 2;
      div.style.left = `${left}px`;
      div.style.width = `${this.layout.pageWidths[i]}px`;
      div.style.height = `${this.layout.pageHeights[i]}px`;
      const placeholder = document.createElement("span");
      placeholder.className = "page-placeholder";
      placeholder.textContent = String(pageNo);
      div.appendChild(placeholder);

      div.addEventListener("pointerdown", (e) =>
        this._handlePagePointerDown(pageNo, div, e),
      );

      inner.appendChild(div);
      this.pageEls.set(pageNo, div);
    }

    this.container.appendChild(inner);

    // If overlays were already loaded before the viewer DOM existed, paint them.
    if (this.projectStore) {
      for (const pageNo of this.pageEls.keys()) {
        this._renderPageOverlays(pageNo);
      }
    }
  }

  /**
   * Pointer-down handler bound to each .viewer-page. Translates the click
   * into canonical (PDF point) coordinates and forwards to the host's
   * onPagePointerDown callback. The host decides whether the gesture is
   * meaningful (edit mode etc.) — viewer stays passive.
   *
   * The page <div> element is forwarded as a fifth argument so the host
   * can run a drag-to-define gesture (M5-1 redaction) using
   * setPointerCapture on the page itself.
   */
  _handlePagePointerDown(pageNo, div, evt) {
    if (!this.onPagePointerDown) return;
    const rect = div.getBoundingClientRect();
    const x = (evt.clientX - rect.left) / this.zoom;
    const y = (evt.clientY - rect.top) / this.zoom;
    this.onPagePointerDown(pageNo, x, y, evt, div);
  }

  /**
   * Build (or rebuild) the overlay DOM layer for `pageNo` from the
   * ProjectStore's current state. Called by the store-subscriber on add /
   * update / remove / reset events.
   *
   * If an overlay on this page is currently being inline-edited, its DOM
   * element is preserved so the user's caret / IME composition isn't torn
   * down by a stray store event.
   */
  _renderPageOverlays(pageNo) {
    if (!this.projectStore) return;
    const div = this.pageEls.get(pageNo);
    if (!div) return;
    const existing = div.querySelector(":scope > .overlay-layer");
    /** @type {HTMLElement | null} */
    let preservedEditing = null;
    if (existing) {
      if (this._editingId) {
        const editEl = existing.querySelector(
          `.overlay[data-overlay-id="${cssEscape(this._editingId)}"]`,
        );
        if (editEl?.classList.contains("editing")) {
          preservedEditing = editEl;
          preservedEditing.remove(); // detach so existing.remove() doesn't kill it
        }
      }
      existing.remove();
    }
    const overlays = this.projectStore.getPageOverlays(pageNo);
    if (overlays.length === 0 && !preservedEditing) return;

    const layer = document.createElement("div");
    layer.className = "overlay-layer";

    for (const ov of overlays) {
      if (preservedEditing && ov.id === this._editingId) {
        layer.appendChild(preservedEditing);
        preservedEditing = null;
        continue;
      }
      const el = this._createOverlayElement(ov);
      if (el) layer.appendChild(el);
    }
    if (preservedEditing) layer.appendChild(preservedEditing);
    div.appendChild(layer);
  }

  /**
   * @param {import("../domain/project-store.js").Overlay} ov
   * @returns {HTMLElement | null}
   */
  _createOverlayElement(ov) {
    const z = this.zoom;
    const el = document.createElement("div");
    el.className = `overlay overlay-${ov.type}`;
    el.dataset.overlayId = ov.id;
    el.style.left = `${ov.x * z}px`;
    el.style.top = `${ov.y * z}px`;
    el.style.width = `${ov.w * z}px`;
    el.style.height = `${ov.h * z}px`;

    if (ov.type === "text") {
      const props = ov.properties ?? {};
      el.textContent = props.text ?? "";
      const fontSize = (props.fontSize ?? 12) * z;
      el.style.fontSize = `${fontSize}px`;
      el.style.fontFamily = getTextFontStack(props.fontId);
      el.style.color = props.color ?? "#000000";
      this._attachOverlayPointer(el, ov);
      this._attachResizeHandles(el, ov);
      return el;
    }

    if (ov.type === "stamp") {
      const props = ov.properties ?? {};
      el.textContent = props.text ?? "";
      const color = props.color ?? "#cc0000";
      const fontSize = (props.fontSize ?? 14) * z;
      el.style.color = color;
      el.style.borderColor = color;
      el.style.fontSize = `${fontSize}px`;
      el.style.fontWeight = "bold";
      const frame = props.frame ?? "circle";
      el.classList.add(`overlay-stamp-${frame}`);
      this._attachOverlayPointer(el, ov);
      this._attachResizeHandles(el, ov);
      return el;
    }

    if (ov.type === "redaction") {
      const props = ov.properties ?? {};
      const fill = props.color === "white" ? "#ffffff" : "#000000";
      const mode = props.mode ?? "applied";
      el.style.background = fill;
      // Editing-time visualisation: keep some transparency so the user
      // can confirm what's being covered. Export draws solid black.
      el.style.opacity = mode === "draft" ? "0.55" : "0.85";
      // Override the default dotted outline with a redaction-specific one
      // so it's visually distinct from text/stamp overlays.
      el.classList.add("overlay-redaction-marker");
      this._attachOverlayPointer(el, ov);
      this._attachResizeHandles(el, ov);
      return el;
    }

    // Other overlay types render as a simple frame for M3-3. Image-based
    // stamps land later (asset library lives M3 / M4 per HANDOVER §15.4).
    el.textContent = ov.type;
    el.style.color = "#444";
    return el;
  }

  /**
   * Wire up pointerdown / move / up so a single click triggers edit and a
   * drag (movement past a small threshold) repositions the overlay.
   *
   *   - Capture the pointer on pointerdown so move + up arrive at this
   *     element even if the cursor crosses other DOM.
   *   - Movement under MOVE_THRESHOLD px is still considered a click.
   *   - Drag updates only inline style during the gesture; the
   *     onOverlayDragEnd callback (triggered on pointerup) fires
   *     UpdateOverlayCommand so history holds a single move per gesture.
   *
   * @param {HTMLElement} el
   * @param {import("../domain/project-store.js").Overlay} ov
   */
  _attachOverlayPointer(el, ov) {
    const MOVE_THRESHOLD = 4;
    let drag = null;

    el.addEventListener("pointerdown", (e) => {
      // While in inline edit mode, the contentEditable owns the pointer.
      if (el.classList.contains("editing")) return;
      // Primary button only; ignore right-click etc.
      if (e.button !== 0) return;
      e.stopPropagation();
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: parseFloat(el.style.left),
        startTop: parseFloat(el.style.top),
        moved: false,
      };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* some browsers can throw if capture is already held */
      }
    });

    el.addEventListener("pointermove", (e) => {
      if (!drag || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) {
        return;
      }
      if (!drag.moved) {
        drag.moved = true;
        el.classList.add("dragging");
      }
      el.style.left = `${drag.startLeft + dx}px`;
      el.style.top = `${drag.startTop + dy}px`;
    });

    el.addEventListener("pointerup", (e) => {
      if (!drag || drag.pointerId !== e.pointerId) return;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const wasDrag = drag.moved;
      const finalLeft = parseFloat(el.style.left);
      const finalTop = parseFloat(el.style.top);
      el.classList.remove("dragging");
      drag = null;
      if (!wasDrag) {
        if (this.onOverlayClick) this.onOverlayClick(ov.id);
        return;
      }
      const z = this.zoom;
      const newX = finalLeft / z;
      const newY = finalTop / z;
      if (this.onOverlayDragEnd) this.onOverlayDragEnd(ov.id, newX, newY);
    });

    el.addEventListener("pointercancel", (e) => {
      if (!drag || drag.pointerId !== e.pointerId) return;
      // Pointer was cancelled (OS / scroll / pointer-capture loss).
      // Restore the original position so we don't leave the overlay
      // half-moved without a corresponding history entry.
      el.style.left = `${drag.startLeft}px`;
      el.style.top = `${drag.startTop}px`;
      el.classList.remove("dragging");
      drag = null;
    });

    el.addEventListener("contextmenu", (e) => {
      // Don't intercept right-click while inline-editing — let the host
      // browser show its native spell / paste menu inside the contentEditable.
      if (el.classList.contains("editing")) return;
      if (!this.onOverlayContextMenu) return;
      e.preventDefault();
      e.stopPropagation();
      this.onOverlayContextMenu(ov.id, e.clientX, e.clientY);
    });
  }

  /**
   * Attach 4-corner resize handles to an overlay element. Handles are
   * hidden by default and shown on hover (CSS). pointerdown on a handle
   * captures the pointer, lives-mutates the overlay's inline left/top/
   * width/height, and on pointerup fires onOverlayResizeEnd with the
   * final canonical bbox.
   *
   * Like _attachOverlayPointer, this short-circuits while the overlay
   * is in inline-edit so resize doesn't disturb a contenteditable
   * selection.
   *
   * @param {HTMLElement} el
   * @param {import("../domain/project-store.js").Overlay} ov
   */
  _attachResizeHandles(el, ov) {
    const MIN = 5; // PDF point — anything smaller is impossible to grab
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const handle = document.createElement("div");
      handle.className = `overlay-handle overlay-handle-${corner}`;
      handle.dataset.corner = corner;

      handle.addEventListener("pointerdown", (e) => {
        if (el.classList.contains("editing")) return;
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const z = this.zoom;
        const start = {
          clientX: e.clientX,
          clientY: e.clientY,
          x: parseFloat(el.style.left) / z,
          y: parseFloat(el.style.top) / z,
          w: parseFloat(el.style.width) / z,
          h: parseFloat(el.style.height) / z,
        };
        const pointerId = e.pointerId;
        try {
          handle.setPointerCapture(pointerId);
        } catch {
          /* ignore */
        }
        // Track whether the user actually moved beyond the click threshold;
        // a pure click on a handle (mouse never moved) should fall through
        // to the overlay click handler so the user can still enter edit
        // mode by clicking on a corner that happens to host a handle.
        let moved = false;
        const MOVE_THRESHOLD = 4;

        const onMove = (ev) => {
          if (ev.pointerId !== pointerId) return;
          const dx = (ev.clientX - start.clientX) / z;
          const dy = (ev.clientY - start.clientY) / z;
          if (
            !moved &&
            Math.abs(ev.clientX - start.clientX) < MOVE_THRESHOLD &&
            Math.abs(ev.clientY - start.clientY) < MOVE_THRESHOLD
          ) {
            return;
          }
          if (!moved) {
            moved = true;
            el.classList.add("resizing");
          }
          let { x, y, w, h } = start;
          if (corner.includes("w")) {
            x = start.x + dx;
            w = start.w - dx;
            if (w < MIN) {
              x = start.x + start.w - MIN;
              w = MIN;
            }
          } else if (corner.includes("e")) {
            w = Math.max(start.w + dx, MIN);
          }
          if (corner.includes("n")) {
            y = start.y + dy;
            h = start.h - dy;
            if (h < MIN) {
              y = start.y + start.h - MIN;
              h = MIN;
            }
          } else if (corner.includes("s")) {
            h = Math.max(start.h + dy, MIN);
          }
          el.style.left = `${x * z}px`;
          el.style.top = `${y * z}px`;
          el.style.width = `${w * z}px`;
          el.style.height = `${h * z}px`;
        };

        const onUp = (ev) => {
          if (ev.pointerId !== pointerId) return;
          try {
            handle.releasePointerCapture(pointerId);
          } catch {
            /* ignore */
          }
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onCancel);
          el.classList.remove("resizing");
          if (!moved) {
            // Forward as a plain overlay click — preserves "click on
            // corner enters edit" intent.
            if (this.onOverlayClick) this.onOverlayClick(ov.id);
            return;
          }
          if (!this.onOverlayResizeEnd) return;
          const bbox = {
            x: parseFloat(el.style.left) / z,
            y: parseFloat(el.style.top) / z,
            w: parseFloat(el.style.width) / z,
            h: parseFloat(el.style.height) / z,
          };
          this.onOverlayResizeEnd(ov.id, bbox);
        };

        const onCancel = (ev) => {
          if (ev.pointerId !== pointerId) return;
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onCancel);
          // Restore original
          el.style.left = `${start.x * z}px`;
          el.style.top = `${start.y * z}px`;
          el.style.width = `${start.w * z}px`;
          el.style.height = `${start.h * z}px`;
          el.classList.remove("resizing");
        };

        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onCancel);
      });

      el.appendChild(handle);
    }
  }

  /**
   * Switch a text overlay into inline-edit mode. Behaviour:
   *
   *   - The overlay div becomes contentEditable, takes focus, and selects
   *     all of the existing text.
   *   - IME composition is honoured: the host doesn't see a commit while
   *     `compositionstart…compositionend` is in flight.
   *   - Enter (without Shift) commits, Escape reverts, blur commits — but
   *     a blur that arrives mid-composition is ignored (some IMEs blur the
   *     host briefly when a candidate window opens).
   *   - On commit with a changed value, the `onTextEditCommit(id, text)`
   *     callback fires; the renderer pushes an UpdateOverlayCommand.
   *
   * Idempotent — calling twice on the same id is a no-op.
   *
   * @param {string} id
   */
  enterTextEdit(id) {
    if (this._editingId === id) return;
    if (!this.projectStore) return;
    const ov = this.projectStore.get(id);
    if (!ov) return;
    // Editable types: free text, and stamps that carry text (text-frame
    // kind). Image / signature stamps without text are skipped.
    const isEditable =
      ov.type === "text" ||
      (ov.type === "stamp" && (ov.properties?.kind ?? "text-frame") !== "image");
    if (!isEditable) return;
    const el = this.container.querySelector(
      `.overlay[data-overlay-id="${cssEscape(id)}"]`,
    );
    if (!el) return;

    const before = ov.properties?.text ?? "";

    el.classList.add("editing");
    el.contentEditable = "true";
    el.spellcheck = false;
    el.textContent = before;
    this._editingId = id;

    let isComposing = false;
    let finished = false;

    const finish = (commit) => {
      if (finished) return;
      finished = true;
      el.removeEventListener("compositionstart", onCs);
      el.removeEventListener("compositionend", onCe);
      el.removeEventListener("blur", onBlur);
      el.removeEventListener("keydown", onKey);
      el.contentEditable = "false";
      el.classList.remove("editing");
      this._editingId = null;
      const after = el.textContent ?? "";
      if (!commit) {
        el.textContent = before;
      } else if (after !== before && this.onTextEditCommit) {
        this.onTextEditCommit(id, after);
      } else {
        // Re-render this page so the DOM reflects whatever the store has
        // (in case onTextEditCommit was not provided).
        const pageNo = ov.pageNo;
        if (pageNo) this._renderPageOverlays(pageNo);
      }
    };

    const onCs = () => {
      isComposing = true;
    };
    const onCe = () => {
      isComposing = false;
    };
    const onBlur = () => {
      // Some IMEs blur the host while a candidate window is open; ignore.
      if (isComposing) {
        setTimeout(() => {
          if (!finished) el.focus();
        }, 0);
        return;
      }
      finish(true);
    };
    const onKey = (e) => {
      if (isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };

    el.addEventListener("compositionstart", onCs);
    el.addEventListener("compositionend", onCe);
    el.addEventListener("blur", onBlur);
    el.addEventListener("keydown", onKey);

    // Defer focus + selectAll so the click that brought us here finishes
    // first.
    setTimeout(() => {
      if (finished) return;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }, 0);
  }

  _setupObserver() {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const pageNo = Number(entry.target.dataset.pageNo);
          this._ensureRendered(pageNo);
        }
      },
      { root: this.container, rootMargin: ROOT_MARGIN },
    );
    for (const el of this.pageEls.values()) {
      this.observer.observe(el);
    }
  }

  /**
   * Render `pageNo` if it hasn't been already. Idempotent and concurrent-safe.
   * @param {number} pageNo
   */
  async _ensureRendered(pageNo) {
    if (this.canvasEls.has(pageNo)) return;
    if (this.pendingRenders.has(pageNo)) return;
    this.pendingRenders.add(pageNo);
    try {
      const renderZoom = this._zoom * computeOversample(this._renderQuality);
      let result;
      if (pageNo < 0) {
        // Synthetic page (user-inserted blank/text) — render on the
        // renderer side via canvas. Look up text/dimensions from the
        // page row stashed in this._pages.
        const row = this._pages?.find((p) => p.pageNo === pageNo);
        if (!row) return;
        result = renderSyntheticPagePixels(row, renderZoom);
      } else {
        result = await window.kpdf3.renderPage(pageNo, { zoom: renderZoom });
      }
      // Bail if the viewer was unloaded while we were waiting
      const div = this.pageEls.get(pageNo);
      if (!div) return;

      const pixels =
        result.pixels instanceof Uint8ClampedArray
          ? result.pixels
          : new Uint8ClampedArray(result.pixels.buffer ?? result.pixels);
      const imageData = new ImageData(pixels, result.width, result.height);

      // mupdf renders at the page's intrinsic /Rotate dimensions only;
      // userRotation must be applied here so the canvas matches the
      // page-registry slot (which uses canonical, post-userRotation dims).
      const row = this._pages?.find((p) => p.pageNo === pageNo);
      const userRot = ((row?.userRotation ?? 0) % 360 + 360) % 360;

      const canvas = document.createElement("canvas");
      if (userRot === 90 || userRot === 270) {
        canvas.width = result.height;
        canvas.height = result.width;
      } else {
        canvas.width = result.width;
        canvas.height = result.height;
      }
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      const ctx = canvas.getContext("2d");
      if (userRot === 0) {
        ctx.putImageData(imageData, 0, 0);
      } else {
        // putImageData ignores transforms — bounce through an offscreen
        // canvas that holds the unrotated pixels, then drawImage with the
        // rotation applied around the final canvas's center.
        const tmp = document.createElement("canvas");
        tmp.width = result.width;
        tmp.height = result.height;
        tmp.getContext("2d").putImageData(imageData, 0, 0);
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((userRot * Math.PI) / 180);
        ctx.drawImage(tmp, -result.width / 2, -result.height / 2);
        ctx.restore();
      }

      // Replace ONLY the placeholder; keep the overlay layer if it's
      // already there. Insert the canvas before .overlay-layer so the
      // overlay paints on top.
      const placeholder = div.querySelector(":scope > .page-placeholder");
      if (placeholder) placeholder.remove();
      const overlayLayer = div.querySelector(":scope > .overlay-layer");
      if (overlayLayer) div.insertBefore(canvas, overlayLayer);
      else div.appendChild(canvas);
      this.canvasEls.set(pageNo, canvas);
    } catch (err) {
      console.error(`[viewer] render page ${pageNo} failed:`, err);
      const div = this.pageEls.get(pageNo);
      if (div) {
        const placeholder = div.querySelector(":scope > .page-placeholder");
        const failNote = document.createElement("span");
        failNote.className = "page-placeholder page-error";
        failNote.textContent = `page ${pageNo}: render failed`;
        if (placeholder) placeholder.replaceWith(failNote);
        else div.insertBefore(failNote, div.firstChild);
      }
    } finally {
      this.pendingRenders.delete(pageNo);
    }
  }
}

/**
 * Minimal CSS.escape wrapper for the data-attribute selector.  CSS.escape
 * is available natively in modern browsers including Electron 38; the
 * fallback is just defensive.
 */
function cssEscape(s) {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(s)
    : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
