/**
 * Builder for the settings form. The same form appears in two places: the panel
 * inside the player (where the track list of the current video is known) and the
 * extension popup (where only the common languages are known).
 *
 * The only difference between them is where the language list comes from, so it
 * is passed in from outside through getLangOptions().
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
    { key: 'allowTranslation', label: 'Translate when there is no ready-made track', type: 'bool' },
    { key: 'translator', label: 'Translator', type: 'select', options: TRANSLATORS,
      when: (s) => s.allowTranslation },
    { key: 'deeplKey', label: 'DeepL key', type: 'text', placeholder: 'xxxx-xxxx-...:fx',
      when: (s) => s.allowTranslation && s.translator === 'deepl' },

    { section: 'Appearance' },
    { key: 'fontSize', label: 'Size', type: 'range', min: 60, max: 200, step: 5, suffix: '%' },
    { key: 'bottomOffset', label: 'Offset from bottom', type: 'range', min: 0, max: 40, step: 1, suffix: '%' },
    { key: 'resetPosition', label: 'Subtitles were dragged', type: 'button', buttonLabel: 'Put back',
      when: (s) => s.captionX != null || s.captionY != null,
      action: () => DS.setSettings({ captionX: null, captionY: null }) },
    { key: 'background', label: 'Backdrop', type: 'range', min: 0, max: 100, step: 5, suffix: '%' },
    { key: 'primaryColor', label: 'First language colour', type: 'color' },
    { key: 'secondaryColor', label: 'Second language colour', type: 'color' },
    { key: 'swapOrder', label: 'Second language on top', type: 'bool' },

    { section: 'Behaviour' },
    { key: 'hideNative', label: "Hide YouTube's own subtitles", type: 'bool' },
    { key: 'pauseOnHover', label: 'Pause when hovering the subtitles', type: 'bool' },
    { key: 'groupBySentence', label: 'Show whole sentences', type: 'bool' }
  ];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fillSelect(select, options, value) {
    select.textContent = '';
    const addOption = (parent, o) => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      parent.appendChild(opt);
    };
    for (const o of options) {
      if (o.group) {
        const g = document.createElement('optgroup');
        g.label = o.group;
        o.options.forEach((x) => addOption(g, x));
        select.appendChild(g);
      } else {
        addOption(select, o);
      }
    }
    // If the saved language is not among the tracks, still show the choice.
    const flat = options.flatMap((o) => (o.group ? o.options : [o]));
    if (value != null && !flat.some((o) => o.value === value)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = DS.languageName(value) + ' (not on this video)';
      select.appendChild(opt);
    }
    select.value = value;
  }

  /**
   * @param {HTMLElement} root       where to render
   * @param {object} opts
   * @param {(role:string)=>Array} opts.getLangOptions
   */
  DS.buildSettingsForm = function buildSettingsForm(root, opts) {
    const rows = [];
    let settings = { ...DS.DEFAULTS };

    for (const item of SCHEMA) {
      if (item.section) {
        const s = el('div', 'ds-panel__section', item.section);
        root.appendChild(s);
        rows.push({ item, node: s });
        continue;
      }

      const row = el('div', 'ds-row');
      let input;

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
        if (item.type === 'lang' || item.type === 'select') {
          input = document.createElement('select');
        } else if (item.type === 'range') {
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
          let value;
          if (item.type === 'bool') value = input.checked;
          else if (item.type === 'range') value = Number(input.value);
          else value = input.value;
          settings[item.key] = value;
          if (input._output) input._output.textContent = value + (item.suffix || '');
          DS.setSettings({ [item.key]: value });
          applyVisibility();
        };

        // Sliders and colours update live, everything else on change.
        input.addEventListener(item.type === 'range' || item.type === 'color' ? 'input' : 'change', commit);
      }

      root.appendChild(row);
      rows.push({ item, node: row, input });
    }

    function applyVisibility() {
      for (const r of rows) {
        if (r.item.when) r.node.hidden = !r.item.when(settings);
      }
    }

    async function refresh() {
      settings = await DS.getSettings();
      for (const r of rows) {
        if (!r.input || r.item.type === 'button') continue;
        const { item, input } = r;
        const value = settings[item.key];
        if (item.type === 'bool') input.checked = !!value;
        else if (item.type === 'lang') fillSelect(input, opts.getLangOptions(item.role), value);
        else if (item.type === 'select') fillSelect(input, item.options, value);
        else input.value = value;
        if (input._output) input._output.textContent = value + (item.suffix || '');
      }
      applyVisibility();
    }

    /**
     * Re-reads the settings and updates only which rows are visible, leaving the
     * field values alone. Needed when a setting changed from outside — the
     * subtitles were dragged, say — while the form is open: rebuilding it in full
     * would reset a dropdown right under the cursor.
     */
    async function syncVisibility() {
      settings = await DS.getSettings();
      applyVisibility();
    }

    return { refresh, syncVisibility };
  };
})();
