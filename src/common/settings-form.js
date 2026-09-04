/**
 * Builder for the settings form. The same form appears in two places: the panel
 * inside the player (where the track list of the current video is known) and the
 * extension popup (where only the common languages are known).
 *
 * The only difference between them is where the language list comes from, so it
 * is passed in from outside through getLangOptions().
 *
 * A choice is made the way the player makes one: the row shows the current value
 * and opens a submenu listing the alternatives with a tick beside the current
 * one. A native <select> would drop a browser menu over the video, which looks
 * nothing like the rest of the player.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  /** Languages for the popup, where the video's track list is unavailable. */
  DS.COMMON_LANGS = [
    'ru', 'en', 'uk', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'tr',
    'ar', 'zh-Hans', 'ja', 'ko', 'hi', 'kk', 'be', 'nl', 'sv', 'cs', 'he', 'id', 'vi'
  ];

  const TRANSLATORS = [
    { value: 'youtube', label: 'YouTube translation (fast, no limits)' },
    { value: 'google', label: 'Google Translate (free)' },
    { value: 'deepl', label: 'DeepL (free key required, best quality)' },
    { value: 'mymemory', label: 'MyMemory (fallback, small quota)' }
  ];

  const SCHEMA = [
    { section: 'Languages' },
    { key: 'primaryLang', label: 'First', type: 'lang', role: 'primary' },
    { key: 'secondaryLang', label: 'Second', type: 'lang', role: 'secondary' },
    { key: 'translator', label: 'Translator', type: 'select', options: TRANSLATORS },
    { key: 'deeplKey', label: 'DeepL key', type: 'text', placeholder: 'xxxx-xxxx-...:fx',
      when: (s) => s.translator === 'deepl' },

    { section: 'Appearance' },
    { key: 'fontSize', label: 'Size', type: 'range', min: 60, max: 200, step: 5, suffix: '%' },
    { key: 'background', label: 'Backdrop', type: 'range', min: 0, max: 100, step: 5, suffix: '%' },
    { key: 'primaryColor', label: 'First language colour', type: 'color' },
    { key: 'secondaryColor', label: 'Second language colour', type: 'color' },
    { key: 'resetPosition', label: 'Subtitles were dragged', type: 'button', buttonLabel: 'Put back',
      when: (s) => s.captionX != null || s.captionY != null,
      action: () => DS.setSettings({ captionX: null, captionY: null }) },

    { section: 'Behaviour' },
    { key: 'pauseOnHover', label: 'Pause on hover', type: 'bool' }
  ];


  /**
   * A glyph for every row, the way the player's menu carries one.
   *
   * 24x24 like its own, drawn from plain shapes rather than lifted: the column
   * is what matters for the eye, not the artwork.
   */
  const ICONS = {
    enabled: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="5.5" y="9.5" width="13" height="1.8" rx=".9"/><rect x="5.5" y="13" width="8" height="1.8" rx=".9"/>',
    primaryLang: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 9h17M3.5 15h17" stroke="currentColor" stroke-width="1.6" fill="none"/>',
    secondaryLang: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 9h17M3.5 15h17" stroke="currentColor" stroke-width="1.6" fill="none"/>',
    translator: '<rect x="2.5" y="3.5" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="9.5" y="10.5" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 8.5h6M8.5 5.5v6" stroke="currentColor" stroke-width="1.6"/>',
    deeplKey: '<circle cx="7.5" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11.5 12H21M18 12v3.5M15 12v2.5" stroke="currentColor" stroke-width="1.6" fill="none"/>',
    fontSize: '<path d="M2 19 7 5h2l5 14h-2l-1.2-3.5H5.2L4 19H2Zm3.8-5.3h3.4L7.5 8.6 5.8 13.7Z"/><path d="M14.5 19 18 9.5h1.6L23 19h-1.7l-.8-2.4h-3.5L16.2 19h-1.7Zm2.9-3.8h2.6l-1.3-3.8-1.3 3.8Z"/>',
    background: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M20 8v10.5a2 2 0 0 1-2 2H8L20 8Z"/>',
    primaryColor: '<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="4.6"/>',
    secondaryColor: '<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="4.6"/>',
    resetPosition: '<path d="M12 5a7 7 0 1 1-6.6 9.3l1.9-.6A5 5 0 1 0 12 7v2.5L7.8 6.2 12 3v2Z"/>',
    pauseOnHover: '<rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/>'
  };

  DS.rowIcon = function rowIcon(key) {
    const shape = ICONS[key];
    if (!shape) return null;
    const holder = document.createElement('span');
    holder.className = 'ds-icon';
    holder.setAttribute('aria-hidden', 'true');
    holder.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">${shape}</svg>`;
    return holder;
  };

  const isMenu = (item) => item.type === 'lang' || item.type === 'select';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** Flattens the option groups the caller may have used. */
  const flatten = (options) => options.flatMap((o) => (o.group ? o.options : [o]));

  /**
   * @param {HTMLElement} root       where to render
   * @param {object} opts
   * @param {(role:string)=>Array} opts.getLangOptions
   */
  DS.buildSettingsForm = function buildSettingsForm(root, opts) {
    const rows = [];
    let settings = { ...DS.DEFAULTS };

    root.classList.add('ds-form');
    const list = el('div', 'ds-view ds-view--list');
    const submenu = el('div', 'ds-view ds-view--submenu');
    submenu.hidden = true;
    root.appendChild(list);
    root.appendChild(submenu);

    /**
     * Slides one view out while the other comes in, and takes the surface's
     * height with it -- the way the player moves between its own panels.
     *
     * The views only become absolute for the duration: in rest the visible one
     * sits in normal flow, so the panel is exactly as tall as its contents
     * without anyone having to measure it.
     */
    let settle = null;
    function swap(from, to, direction) {
      const back = direction === 'back';
      // A swap started mid-flight leaves the previous one half-applied -- an
      // inline height on the surface and a transform on a view that is about to
      // be reused. Finish it properly first rather than just dropping its timer.
      settle?.();

      const startHeight = root.offsetHeight;
      to.hidden = false;
      root.classList.add('ds-form--animating');
      to.style.transform = `translateX(${back ? '-100%' : '100%'})`;
      const endHeight = to.offsetHeight;

      root.style.height = `${startHeight}px`;
      void root.offsetHeight;               // let the start height take effect
      root.style.height = `${endHeight}px`;
      to.style.transform = 'translateX(0)';
      from.style.transform = `translateX(${back ? '100%' : '-100%'})`;

      const timer = setTimeout(() => settle?.(), 260);
      settle = () => {
        clearTimeout(timer);
        settle = null;
        root.classList.remove('ds-form--animating');
        root.style.height = '';
        from.hidden = true;
        from.style.transform = '';
        to.style.transform = '';
      };
    }

    const optionsFor = (item) =>
      (item.type === 'lang' ? opts.getLangOptions(item.role) : item.options);

    /** What the row shows: the label of the chosen option, or the value itself. */
    function currentLabel(item) {
      const value = settings[item.key];
      const hit = flatten(optionsFor(item)).find((o) => o.value === value);
      if (hit) return hit.label;
      // A language saved earlier that this video has no track for.
      return item.type === 'lang' ? `${DS.languageName(value)} (not on this video)` : String(value ?? '');
    }

    function closeSubmenu({ animate = false } = {}) {
      settle?.();
      if (submenu.hidden) return;
      if (!animate) {
        submenu.hidden = true;
        submenu.textContent = '';
        list.hidden = false;
        return;
      }
      swap(submenu, list, 'back');
    }

    function openSubmenu(entry) {
      const { item } = entry;
      const options = optionsFor(item);
      const value = settings[item.key];
      submenu.textContent = '';

      const header = el('div', 'ds-submenu__header');
      const back = el('button', 'ds-submenu__back');
      back.type = 'button';
      back.setAttribute('aria-label', 'Back');
      back.addEventListener('click', () => closeSubmenu({ animate: true }));
      header.appendChild(back);
      header.appendChild(el('span', 'ds-submenu__title', item.label));
      submenu.appendChild(header);

      const body = el('div', 'ds-submenu__list');
      const choose = (v) => {
        settings[item.key] = v;
        entry.value.textContent = currentLabel(item);
        DS.setSettings({ [item.key]: v });
        applyVisibility();
        closeSubmenu({ animate: true });
      };
      const addOption = (o) => {
        const node = el('div', 'ds-option', o.label);
        node.setAttribute('role', 'menuitemradio');
        node.setAttribute('aria-checked', String(o.value === value));
        node.tabIndex = 0;
        node.addEventListener('click', () => choose(o.value));
        node.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(o.value); }
        });
        body.appendChild(node);
      };

      for (const o of options) {
        if (o.group) {
          body.appendChild(el('div', 'ds-panel__section', o.group));
          o.options.forEach(addOption);
        } else {
          addOption(o);
        }
      }
      // Keep a saved choice reachable even when this video cannot offer it.
      if (value != null && !flatten(options).some((o) => o.value === value)) {
        addOption({ value, label: currentLabel(item) });
      }

      submenu.appendChild(body);
      submenu.scrollTop = 0;
      swap(list, submenu, 'forward');
      back.focus();
    }

    for (const item of SCHEMA) {
      if (item.section) {
        const s = el('div', 'ds-panel__section', item.section);
        list.appendChild(s);
        rows.push({ item, node: s });
        continue;
      }

      const row = el('div', 'ds-row');
      const icon = DS.rowIcon(item.key);
      if (icon) row.appendChild(icon);
      let input;
      let value;

      if (isMenu(item)) {
        row.classList.add('ds-row--menu');
        row.setAttribute('role', 'menuitem');
        row.setAttribute('aria-haspopup', 'true');
        row.tabIndex = 0;
        row.appendChild(el('label', null, item.label));
        value = el('span', 'ds-value');
        row.appendChild(value);
        const entry = { item, node: row, value };
        row.addEventListener('click', () => openSubmenu(entry));
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSubmenu(entry); }
        });
        list.appendChild(row);
        rows.push(entry);
        continue;
      }

      if (item.type === 'bool') {
        const lab = el('label', 'ds-switch');
        input = document.createElement('input');
        input.type = 'checkbox';
        lab.appendChild(input);
        lab.appendChild(el('span', null, item.label));
        row.appendChild(lab);
      } else if (item.type === 'button') {
        row.appendChild(el('label', null, item.label));
        input = document.createElement('button');
        input.type = 'button';
        input.className = 'ds-btn-secondary';
        input.textContent = item.buttonLabel;
        input.addEventListener('click', () => item.action());
        row.appendChild(input);
      } else {
        row.appendChild(el('label', null, item.label));
        if (item.type === 'range') {
          input = document.createElement('input');
          input.type = 'range';
          input.min = item.min;
          input.max = item.max;
          input.step = item.step;
        } else if (item.type === 'color') {
          input = document.createElement('input');
          input.type = 'color';
        } else {
          input = document.createElement('input');
          input.type = 'text';
          if (item.placeholder) input.placeholder = item.placeholder;
        }
        row.appendChild(input);
        if (item.type === 'range') {
          const out = el('span', 'ds-range-value');
          row.appendChild(out);
          input._output = out;
        }
      }

      // A button carries no value: it fires its action and that is all.
      if (item.type !== 'button') {
        const commit = () => {
          const v = item.type === 'bool' ? input.checked
            : item.type === 'range' ? Number(input.value)
              : input.value;
          settings[item.key] = v;
          if (input._output) input._output.textContent = v + (item.suffix || '');
          DS.setSettings({ [item.key]: v });
          applyVisibility();
        };

        // Sliders and colours update live, everything else on change.
        input.addEventListener(item.type === 'range' || item.type === 'color' ? 'input' : 'change', commit);
      }

      list.appendChild(row);
      rows.push({ item, node: row, input });
    }

    function applyVisibility() {
      for (const r of rows) {
        if (r.item.when) r.node.hidden = !r.item.when(settings);
      }
    }

    async function refresh() {
      settings = await DS.getSettings();
      closeSubmenu();
      for (const r of rows) {
        const { item } = r;
        if (isMenu(item)) { r.value.textContent = currentLabel(item); continue; }
        if (!r.input || item.type === 'button') continue;
        const value = settings[item.key];
        if (item.type === 'bool') r.input.checked = !!value;
        else r.input.value = value;
        if (r.input._output) r.input._output.textContent = value + (item.suffix || '');
      }
      applyVisibility();
    }

    // The caller puts its own furniture inside the list view, so that it slides
    // away with the rest when a submenu opens.
    return { refresh, listView: list };
  };
})();
