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
   * @param {Record<string, HTMLElement>} [opts.submenus]  submenu key -> .menu-submenu container
   * @param {Record<string, () => Promise<Array<{label:string,title?:string,action:()=>any}>>>} [opts.populators]
   *        submenu key -> populator producing items on demand (called every open)
   */
  constructor({ menuBar, dropdowns, actions, submenus = {}, populators = {} }) {
    this.menuBar = menuBar;
    this.dropdowns = dropdowns;
    this.actions = actions;
    this.submenus = submenus;
    this.populators = populators;
    /** @type {HTMLElement | null} currently open menu-bar item */
    this.openItem = null;
    /** @type {string | null} currently open submenu key */
    this.openSubmenuKey = null;
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
        const subKey = mi.dataset.submenu;
        if (subKey) {
          mi.addEventListener("mouseenter", () => {
            if (mi.classList.contains("disabled")) {
              this._closeSubmenus();
              return;
            }
            this._openSubmenu(mi, subKey);
          });
          mi.addEventListener("click", (e) => {
            e.stopPropagation();
            if (mi.classList.contains("disabled")) return;
            if (this.openSubmenuKey !== subKey) this._openSubmenu(mi, subKey);
          });
          continue;
        }
        mi.addEventListener("mouseenter", () => this._closeSubmenus());
        mi.addEventListener("click", (e) => {
          e.stopPropagation();
          if (mi.classList.contains("disabled")) return;
          const action = mi.dataset.action;
          this._closeAll();
          if (action && this.actions[action]) {
            this._invokeAction(action, this.actions[action]);
          }
        });
      }
    }

    document.addEventListener("click", () => this._closeAll());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this._closeAll();
    });
  }

  _invokeAction(label, fn) {
    // Defer so close-state is reflected first
    queueMicrotask(() => {
      try {
        const r = fn();
        if (r && typeof r.then === "function") {
          r.catch((err) => console.error(`[menu] action ${label} failed:`, err));
        }
      } catch (err) {
        console.error(`[menu] action ${label} failed:`, err);
      }
    });
  }

  /**
   * Populate and show a submenu anchored to the right of its trigger item.
   * @param {HTMLElement} trigger  the parent .menu-item[data-submenu]
   * @param {string} key           submenu key (matches submenus / populators)
   */
  async _openSubmenu(trigger, key) {
    const sub = this.submenus[key];
    if (!sub) return;
    if (this.openSubmenuKey === key) return;
    this._closeSubmenus();
    trigger.classList.add("submenu-open");

    const populator = this.populators[key];
    sub.innerHTML = "";
    if (populator) {
      try {
        const items = await populator();
        if (!items || items.length === 0) {
          const empty = document.createElement("div");
          empty.className = "menu-item disabled";
          empty.textContent = "(履歴なし)";
          sub.appendChild(empty);
        } else {
          for (const it of items) {
            const mi = document.createElement("div");
            mi.className = "menu-item";
            mi.textContent = it.label;
            if (it.title) mi.title = it.title;
            mi.addEventListener("click", (e) => {
              e.stopPropagation();
              this._closeAll();
              this._invokeAction(`submenu:${key}`, it.action);
            });
            sub.appendChild(mi);
          }
        }
      } catch (err) {
        sub.innerHTML = "";
        const errItem = document.createElement("div");
        errItem.className = "menu-item disabled";
        errItem.textContent = "(読み込みエラー)";
        sub.appendChild(errItem);
        console.error(`[menu] submenu ${key} populator failed:`, err);
      }
    }

    const rect = trigger.getBoundingClientRect();
    // Anchor to the right edge of the trigger, overlap by 2px so the
    // beveled borders read as one continuous Win95 cascade.
    sub.style.left = `${rect.right - 2}px`;
    sub.style.top = `${rect.top - 2}px`;
    sub.hidden = false;
    this.openSubmenuKey = key;
  }

  _closeSubmenus() {
    for (const sub of Object.values(this.submenus)) sub.hidden = true;
    for (const dd of Object.values(this.dropdowns)) {
      for (const t of dd.querySelectorAll(".menu-item.submenu-open")) {
        t.classList.remove("submenu-open");
      }
    }
    this.openSubmenuKey = null;
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
    this._closeSubmenus();
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

  /**
   * Update checkmark state of items by data-action (toggle-style menu items).
   * @param {Record<string, boolean>} state action -> checked?
   */
  setChecked(state) {
    for (const dd of Object.values(this.dropdowns)) {
      for (const mi of dd.querySelectorAll(".menu-item[data-action]")) {
        const action = mi.dataset.action;
        if (action in state) {
          mi.classList.toggle("checked", !!state[action]);
        }
      }
    }
  }
}
