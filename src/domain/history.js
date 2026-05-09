// Command-pattern undo/redo stack (M3-2).
//
// Pure domain logic. A "command" is anything with `do()` and `undo()`
// methods (and an optional `describe()` for menu labels). HistoryStack
// only orchestrates push/pop and does not know about ProjectStore.
//
// The actual command implementations for overlay add / update / remove
// live in `commands.js`.

/**
 * @typedef {object} Command
 * @property {() => void} do
 * @property {() => void} undo
 * @property {() => string} [describe]
 */

const DEFAULT_LIMIT = 200;

export class HistoryStack {
  /**
   * @param {object} [opts]
   * @param {number} [opts.limit=200]   max entries kept on the undo stack
   */
  constructor(opts = {}) {
    /** @type {Command[]} */
    this._undo = [];
    /** @type {Command[]} */
    this._redo = [];
    this._limit = opts.limit ?? DEFAULT_LIMIT;
    /** @type {Set<() => void>} */
    this._listeners = new Set();
  }

  /**
   * Execute a command and record it for undo. Discards any redo state
   * (linear history; new edits invalidate the redo branch).
   *
   * @param {Command} cmd
   */
  execute(cmd) {
    cmd.do();
    this._undo.push(cmd);
    this._redo.length = 0;
    while (this._undo.length > this._limit) this._undo.shift();
    this._notify();
  }

  /** @returns {boolean} */
  canUndo() {
    return this._undo.length > 0;
  }

  /** @returns {boolean} */
  canRedo() {
    return this._redo.length > 0;
  }

  /**
   * Undo the most recent command. Returns the command (or null) so callers
   * can show "undid: …" feedback.
   *
   * @returns {Command | null}
   */
  undo() {
    const cmd = this._undo.pop();
    if (!cmd) return null;
    cmd.undo();
    this._redo.push(cmd);
    this._notify();
    return cmd;
  }

  /**
   * Redo the most recently undone command.
   * @returns {Command | null}
   */
  redo() {
    const cmd = this._redo.pop();
    if (!cmd) return null;
    cmd.do();
    this._undo.push(cmd);
    this._notify();
    return cmd;
  }

  /** Drop both stacks (used on workspace close / reset). */
  clear() {
    if (this._undo.length === 0 && this._redo.length === 0) return;
    this._undo.length = 0;
    this._redo.length = 0;
    this._notify();
  }

  /**
   * Subscribe to stack-state changes. Useful for menu enabled state /
   * dirty indicators.
   *
   * @param {() => void} listener
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {() => void} unsubscribe
   */
  subscribe(listener, opts = {}) {
    this._listeners.add(listener);
    const unsub = () => this._listeners.delete(listener);
    if (opts.signal) {
      if (opts.signal.aborted) unsub();
      else opts.signal.addEventListener("abort", unsub, { once: true });
    }
    return unsub;
  }

  _notify() {
    for (const l of this._listeners) {
      try {
        l();
      } catch (err) {
        console.error("[HistoryStack] listener threw:", err);
      }
    }
  }
}
