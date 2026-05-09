// Concrete commands for ProjectStore mutations (M3-2).
//
// Each command captures enough state to undo itself. Identity (id +
// createdAt) is preserved across redo so observers don't see a "different
// overlay" each time.
//
// Pure domain logic; no DOM / IPC / SQLite knowledge.

/** @typedef {import("./project-store.js").ProjectStore} ProjectStore */
/** @typedef {import("./project-store.js").Overlay} Overlay */
/** @typedef {import("./project-store.js").OverlayInput} OverlayInput */
/** @typedef {import("./project-store.js").OverlayPatch} OverlayPatch */

export class AddOverlayCommand {
  /**
   * @param {ProjectStore} store
   * @param {OverlayInput} input
   */
  constructor(store, input) {
    this.store = store;
    this.input = input;
    /** @type {Overlay | null} captured snapshot for redo */
    this._snapshot = null;
  }

  do() {
    if (this._snapshot) {
      this.store.restoreOverlay(this._snapshot);
    } else {
      this._snapshot = this.store.add(this.input);
    }
  }

  undo() {
    if (this._snapshot) {
      this.store.remove(this._snapshot.id);
    }
  }

  describe() {
    return `Add ${this.input.type ?? "overlay"}`;
  }
}

export class UpdateOverlayCommand {
  /**
   * @param {ProjectStore} store
   * @param {string} id
   * @param {OverlayPatch} patch
   */
  constructor(store, id, patch) {
    this.store = store;
    this.id = id;
    this.patch = patch;
    /** @type {Overlay | null} */
    this._before = null;
    /** @type {Overlay | null} */
    this._after = null;
  }

  do() {
    if (this._after) {
      this.store.restoreOverlay(this._after);
      return;
    }
    const before = this.store.get(this.id);
    if (!before) return;
    this._before = { ...before, properties: { ...before.properties } };
    const after = this.store.update(this.id, this.patch);
    this._after = after ? { ...after, properties: { ...after.properties } } : null;
  }

  undo() {
    if (this._before) this.store.restoreOverlay(this._before);
  }

  describe() {
    return `Edit overlay`;
  }
}

export class RemoveOverlayCommand {
  /**
   * @param {ProjectStore} store
   * @param {string} id
   */
  constructor(store, id) {
    this.store = store;
    this.id = id;
    /** @type {Overlay | null} */
    this._snapshot = null;
  }

  do() {
    if (this._snapshot) {
      this.store.remove(this._snapshot.id);
      return;
    }
    const ov = this.store.get(this.id);
    if (!ov) return;
    this._snapshot = { ...ov, properties: { ...ov.properties } };
    this.store.remove(this.id);
  }

  undo() {
    if (this._snapshot) this.store.restoreOverlay(this._snapshot);
  }

  describe() {
    return `Remove overlay`;
  }
}
