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

import { PageRegistry } from "../domain/page-registry.js";

const ZOOM = 1.5;
const GAP = 8; // px between pages (CSS pixel)
const ROOT_MARGIN = "200px 0px"; // prefetch threshold

export class Viewer {
  /**
   * @param {HTMLElement} container scrollable host element (overflow-y: auto)
   * @param {object} [opts]
   * @param {import("../domain/project-store.js").ProjectStore} [opts.projectStore]
   * @param {(pageNo: number, x: number, y: number, evt: PointerEvent) => void} [opts.onPagePointerDown]
   * @param {(overlayId: string) => void} [opts.onOverlayClick]
   * @param {(overlayId: string, newText: string) => void} [opts.onTextEditCommit]
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.projectStore = opts.projectStore ?? null;
    this.onPagePointerDown = opts.onPagePointerDown ?? null;
    this.onOverlayClick = opts.onOverlayClick ?? null;
    this.onTextEditCommit = opts.onTextEditCommit ?? null;
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
    if (this.projectStore) {
      this._subscribeStore();
    }
  }

  /**
   * Page space (canonical PDF point) ↔ pixel scale used by the viewer.
   * Currently fixed; the View > zoom menu (M3-7) will make it dynamic.
   */
  get zoom() {
    return ZOOM;
  }

  /**
   * Load a workspace's pages into the viewer.
   * @param {Array<{pageNo:number, cropW:number, cropH:number, rotation:number, userRotation?:number}>} pages
   */
  load(pages) {
    this.unload();
    if (pages.length === 0) return;

    this.registry = new PageRegistry(pages);
    this.layout = this.registry.layout({ zoom: ZOOM, gap: GAP });
    this._buildPageDoms();
    this._setupObserver();
    // Reset scroll to top
    this.container.scrollTop = 0;
  }

  /** Tear down DOM + observers; safe to call multiple times. */
  unload() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.container.innerHTML = "";
    this.pageEls.clear();
    this.canvasEls.clear();
    this.pendingRenders.clear();
    this.registry = null;
    this.layout = null;
  }

  dispose() {
    this.unload();
    if (this._unsubscribeStore) {
      this._unsubscribeStore();
      this._unsubscribeStore = null;
    }
  }

  setEditMode(on) {
    this.container.classList.toggle("edit-mode", !!on);
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
      const pageNo = i + 1;
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
   */
  _handlePagePointerDown(pageNo, div, evt) {
    if (!this.onPagePointerDown) return;
    const rect = div.getBoundingClientRect();
    const x = (evt.clientX - rect.left) / this.zoom;
    const y = (evt.clientY - rect.top) / this.zoom;
    this.onPagePointerDown(pageNo, x, y, evt);
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
      el.style.color = props.color ?? "#000000";
      el.addEventListener("click", (e) => {
        // Don't fall through to .viewer-page (which would create a new
        // overlay in placement mode).
        e.stopPropagation();
        if (this.onOverlayClick) this.onOverlayClick(ov.id);
      });
      return el;
    }

    // Other overlay types render as a simple frame for M3-3. M3-6 (stamp)
    // / M3-7 (image) will fill them in.
    el.textContent = ov.type;
    el.style.color = "#444";
    return el;
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
    if (!ov || ov.type !== "text") return;
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
      const result = await window.kpdf3.renderPage(pageNo, { zoom: ZOOM });
      // Bail if the viewer was unloaded while we were waiting
      const div = this.pageEls.get(pageNo);
      if (!div) return;

      const pixels =
        result.pixels instanceof Uint8ClampedArray
          ? result.pixels
          : new Uint8ClampedArray(result.pixels.buffer ?? result.pixels);
      const imageData = new ImageData(pixels, result.width, result.height);

      const canvas = document.createElement("canvas");
      canvas.width = result.width;
      canvas.height = result.height;
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      canvas.getContext("2d").putImageData(imageData, 0, 0);

      div.replaceChildren(canvas);
      this.canvasEls.set(pageNo, canvas);
    } catch (err) {
      console.error(`[viewer] render page ${pageNo} failed:`, err);
      const div = this.pageEls.get(pageNo);
      if (div) {
        const failNote = document.createElement("span");
        failNote.className = "page-placeholder page-error";
        failNote.textContent = `page ${pageNo}: render failed`;
        div.replaceChildren(failNote);
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
