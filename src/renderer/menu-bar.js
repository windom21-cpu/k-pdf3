// Win95-style menu bar (ADR-0006).
//
// Wires top-level menu items to dropdowns positioned below them. Behaviour:
//   - click a menu name to toggle its dropdown
//   - hover-switch between menus while any is open (classic Win95)
//   - click outside / Escape / click an item closes
//   - items with data-action trigger callbacks; .disabled items are inert

export class MenuBar {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.menuBar         the .menu-bar root
   * @param {Record<string, HTMLElement>} opts.dropdowns   id -> .menu-dropdown element
   * @param {Record<string, () => void | Promise<void>>} opts.actions   action name -> handler
   */
  constructor({ menuBar, dropdowns, actions }) {
    this.menuBar = menuBar;
    this.dropdowns = dropdowns;
    this.actions = actions;
    /** @type {HTMLElement | null} currently open menu-bar item */
    this.openItem = null;
    this._wire();
  }

  _wire() {
    for (const item of this.menuBar.querySelectorAll(".menu-bar-item")) {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.openItem === item) this._closeAll();
        else this._open(item);
      });
      item.addEventListener("mouseenter", () => {
        if (this.openItem) this._open(item);
      });
    }

    for (const dropdown of Object.values(this.dropdowns)) {
      for (const mi of dropdown.querySelectorAll(".menu-item")) {
        mi.addEventListener("click", (e) => {
          e.stopPropagation();
          if (mi.classList.contains("disabled")) return;
          const action = mi.dataset.action;
          this._closeAll();
          if (action && this.actions[action]) {
            // Defer so close-state is reflected first
            queueMicrotask(() => {
              try {
                const r = this.actions[action]();
                if (r && typeof r.then === "function") {
                  r.catch((err) => console.error(`[menu] action ${action} failed:`, err));
                }
              } catch (err) {
                console.error(`[menu] action ${action} failed:`, err);
              }
            });
          }
        });
      }
    }

    document.addEventListener("click", () => this._closeAll());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this._closeAll();
    });
  }

  /** @param {HTMLElement} item */
  _open(item) {
    this._closeAll();
    item.classList.add("active");
    const menuKey = item.dataset.menu;
    const dropdown = this.dropdowns[menuKey];
    if (!dropdown) return;
    const rect = item.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom}px`;
    dropdown.hidden = false;
    this.openItem = item;
  }

  _closeAll() {
    for (const dd of Object.values(this.dropdowns)) dd.hidden = true;
    for (const item of this.menuBar.querySelectorAll(".menu-bar-item")) {
      item.classList.remove("active");
    }
    this.openItem = null;
  }

  /**
   * Update enabled / disabled state of items by data-action.
   * @param {Record<string, boolean>} state action -> enabled?
   */
  setEnabled(state) {
    for (const dd of Object.values(this.dropdowns)) {
      for (const mi of dd.querySelectorAll(".menu-item[data-action]")) {
        const action = mi.dataset.action;
        if (action in state) {
          mi.classList.toggle("disabled", !state[action]);
        }
      }
    }
  }
}
