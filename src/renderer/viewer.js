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
  /** @param {HTMLElement} container scrollable host element (overflow-y: auto) */
  constructor(container) {
    this.container = container;
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

  _buildPageDoms() {
    const inner = document.createElement("div");
    inner.className = "viewer-inner";
    inner.style.position = "relative";
    inner.style.width = `${this.layout.maxWidth}px`;
    inner.style.height = `${this.layout.totalHeight}px`;
    inner.style.margin = "0 auto";

    const N = this.registry.count();
    for (let i = 0; i < N; i++) {
      const div = document.createElement("div");
      div.className = "viewer-page";
      div.dataset.pageNo = String(i + 1);
      div.style.position = "absolute";
      div.style.top = `${this.layout.pageTops[i]}px`;
      const left = (this.layout.maxWidth - this.layout.pageWidths[i]) / 2;
      div.style.left = `${left}px`;
      div.style.width = `${this.layout.pageWidths[i]}px`;
      div.style.height = `${this.layout.pageHeights[i]}px`;
      const placeholder = document.createElement("span");
      placeholder.className = "page-placeholder";
      placeholder.textContent = String(i + 1);
      div.appendChild(placeholder);
      inner.appendChild(div);
      this.pageEls.set(i + 1, div);
    }

    this.container.appendChild(inner);
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
