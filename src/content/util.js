/**
 * Общие утилиты и настройки. Первый скрипт в цепочке content scripts —
 * создаёт пространство имён window.DS, которое видят все остальные файлы
 * (content scripts одного расширения делят один isolated world).
 */
(() => {
  const DS = (window.DS = window.DS || {});

  const DEBUG = false;
  DS.log = (...a) => DEBUG && console.log('%c[dual-subs]', 'color:#3ea6ff', ...a);
  DS.warn = (...a) => console.warn('[dual-subs]', ...a);

  /** Настройки по умолчанию. Хранятся в chrome.storage.sync. */
  DS.DEFAULTS = {
    enabled: true,
    // 'auto' = язык оригинала видео; иначе код языка ('en', 'ru', ...)
    primaryLang: 'auto',
    secondaryLang: 'ru',
    // Разрешать машинный перевод, если готовой дорожки нет
    allowTranslation: true,
    // Порядок провайдеров перевода. 'youtube' — встроенный автоперевод YouTube.
    translator: 'youtube',
    deeplKey: '',
    // Внешний вид
    fontSize: 100,        // % от базового размера
    lineGap: 4,           // px между строками
    bottomOffset: 8,      // % высоты плеера
    background: 55,       // непрозрачность подложки, %
    primaryColor: '#ffffff',
    secondaryColor: '#7fd1ff',
    swapOrder: false,     // true — второй язык сверху
    // Поведение
    hideNative: true,     // прятать родные субтитры YouTube
    pauseOnHover: false,  // пауза при наведении мыши на субтитры
    groupBySentence: true // если перевод машинный — показывать обе строки предложениями
  };

  let cache = null;
  const listeners = new Set();

  DS.getSettings = async () => {
    if (cache) return cache;
    const stored = await chrome.storage.sync.get(DS.DEFAULTS);
    cache = { ...DS.DEFAULTS, ...stored };
    return cache;
  };

  DS.setSettings = async (patch) => {
    cache = { ...(cache || DS.DEFAULTS), ...patch };
    await chrome.storage.sync.set(patch);
    return cache;
  };

  DS.onSettingsChange = (fn) => listeners.add(fn);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    for (const [k, v] of Object.entries(changes)) patch[k] = v.newValue;
    cache = { ...(cache || DS.DEFAULTS), ...patch };
    listeners.forEach((fn) => fn(cache, patch));
  });

  /** Человекочитаемое название языка на русском. */
  const displayNames = (() => {
    try { return new Intl.DisplayNames(['ru'], { type: 'language' }); } catch { return null; }
  })();
  DS.languageName = (code) => {
    if (!code || code === 'auto') return 'Язык видео';
    try {
      const n = displayNames?.of(code);
      if (n && n !== code) return n[0].toUpperCase() + n.slice(1);
    } catch { /* неизвестный код — покажем как есть */ }
    return code;
  };

  DS.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  DS.debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  /** Уникальный ключ дорожки — по нему сравниваем выбор пользователя. */
  DS.trackKey = (t) => (t ? `${t.languageCode}|${t.kind || ''}|${t.name || ''}` : '');

  /** Ждём появления элемента в DOM. */
  DS.waitFor = (selector, timeout = 15000) => new Promise((resolve) => {
    const found = document.querySelector(selector);
    if (found) return resolve(found);
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { obs.disconnect(); clearTimeout(timer); resolve(el); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
  });

  DS.videoIdFromUrl = (url = location.href) => {
    try {
      const u = new URL(url);
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
      return m ? m[1] : null;
    } catch { return null; }
  };
})();
