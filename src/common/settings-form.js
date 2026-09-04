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
    { key: 'pauseOnHover', label: 'Pause when hovering the subtitles', type: 'bool' }
  ];

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

    const list = el('div', 'ds-form__list');
    const submenu = el('div', 'ds-form__submenu');
    submenu.hidden = true;
    root.appendChild(list);
    root.appendChild(submenu);

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

    function closeSubmenu() {
      submenu.hidden = true;
      submenu.textContent = '';
      list.hidden = false;
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
      back.addEventListener('click', closeSubmenu);
      header.appendChild(back);
      header.appendChild(el('span', 'ds-submenu__title', item.label));
      submenu.appendChild(header);

      const body = el('div', 'ds-submenu__list');
      const choose = (v) => {
        settings[item.key] = v;
        entry.value.textContent = currentLabel(item);
        DS.setSettings({ [item.key]: v });
        applyVisibility();
        closeSubmenu();
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
      list.hidden = true;
      submenu.hidden = false;
      submenu.scrollTop = 0;
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

    return { refresh };
  };
})();
