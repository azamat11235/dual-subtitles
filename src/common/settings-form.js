/**
 * Конструктор формы настроек. Одна и та же форма показывается в двух местах:
 * в панели внутри плеера (где известен список дорожек конкретного видео)
 * и в попапе расширения (где известны только общие языки).
 *
 * Разница между ними -- только в источнике списка языков, поэтому он
 * передаётся снаружи через getLangOptions().
 */
(() => {
  const DS = (window.DS = window.DS || {});

  /** Языки для попапа, где список дорожек видео недоступен. */
  DS.COMMON_LANGS = [
    'ru', 'en', 'uk', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'tr',
    'ar', 'zh-Hans', 'ja', 'ko', 'hi', 'kk', 'be', 'nl', 'sv', 'cs', 'he', 'id', 'vi'
  ];

  const TRANSLATORS = [
    { value: 'youtube', label: 'Автоперевод YouTube (быстро, без лимитов)' },
    { value: 'google', label: 'Google Переводчик (бесплатно)' },
    { value: 'deepl', label: 'DeepL (нужен бесплатный ключ, лучшее качество)' },
    { value: 'mymemory', label: 'MyMemory (запасной, малая квота)' }
  ];

  const SCHEMA = [
    { section: 'Языки' },
    { key: 'primaryLang', label: 'Первый', type: 'lang', role: 'primary' },
    { key: 'secondaryLang', label: 'Второй', type: 'lang', role: 'secondary' },
    { key: 'allowTranslation', label: 'Переводить, если готовой дорожки нет', type: 'bool' },
    { key: 'translator', label: 'Переводчик', type: 'select', options: TRANSLATORS,
      when: (s) => s.allowTranslation },
    { key: 'deeplKey', label: 'Ключ DeepL', type: 'text', placeholder: 'xxxx-xxxx-...:fx',
      when: (s) => s.allowTranslation && s.translator === 'deepl' },

    { section: 'Вид' },
    { key: 'fontSize', label: 'Размер', type: 'range', min: 60, max: 200, step: 5, suffix: '%' },
    { key: 'bottomOffset', label: 'Отступ снизу', type: 'range', min: 0, max: 40, step: 1, suffix: '%' },
    { key: 'background', label: 'Подложка', type: 'range', min: 0, max: 100, step: 5, suffix: '%' },
    { key: 'primaryColor', label: 'Цвет первого', type: 'color' },
    { key: 'secondaryColor', label: 'Цвет второго', type: 'color' },
    { key: 'swapOrder', label: 'Второй язык сверху', type: 'bool' },

    { section: 'Поведение' },
    { key: 'hideNative', label: 'Прятать родные субтитры YouTube', type: 'bool' },
    { key: 'pauseOnHover', label: 'Пауза при наведении на субтитры', type: 'bool' },
    { key: 'groupBySentence', label: 'Показывать оригинал предложениями при переводе', type: 'bool' }
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
    // Если сохранённого языка нет в списке дорожек, всё равно показываем выбор.
    const flat = options.flatMap((o) => (o.group ? o.options : [o]));
    if (value != null && !flat.some((o) => o.value === value)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = DS.languageName(value) + ' (нет у этого видео)';
      select.appendChild(opt);
    }
    select.value = value;
  }

  /**
   * @param {HTMLElement} root       куда рисовать
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

      // Ползунки и цвет обновляем на лету, остальное -- по change.
      input.addEventListener(item.type === 'range' || item.type === 'color' ? 'input' : 'change', commit);

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
        if (!r.input) continue;
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

    return { refresh };
  };
})();
