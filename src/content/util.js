/**
 * Shared helpers and settings. First script in the content-script chain — it
 * creates the window.DS namespace that every other file uses (all content
 * scripts of one extension share a single isolated world).
 */
(() => {
  const DS = (window.DS = window.DS || {});

  const DEBUG = false;
  DS.log = (...a) => DEBUG && console.log('%c[dual-subs]', 'color:#3ea6ff', ...a);
  DS.warn = (...a) => console.warn('[dual-subs]', ...a);

  /** Default settings. Stored in chrome.storage.sync. */
  DS.DEFAULTS = {
    enabled: true,
    // 'auto' = the language of the video itself; otherwise a code ('en', 'ru', ...)
    primaryLang: 'auto',
    secondaryLang: 'ru',
    // Allow machine translation when there is no ready-made track
    allowTranslation: true,
    // Translation provider. 'youtube' is YouTube's own built-in translation.
    translator: 'youtube',
    deeplKey: '',
    // Appearance
    fontSize: 100,        // % of the base size
    lineGap: 4,           // px between the lines
    bottomOffset: 8,      // % of the player height
    background: 55,       // backdrop opacity, %
    primaryColor: '#ffffff',
    secondaryColor: '#7fd1ff',
    swapOrder: false,     // true — second language on top
    // Behaviour
    hideNative: true,     // hide YouTube's own subtitles
    pauseOnHover: false,  // pause when the mouse is over the subtitles
    groupBySentence: true // show whole sentences instead of raw cues
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

  /** Human-readable language name. */
  const displayNames = (() => {
    try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; }
  })();
  DS.languageName = (code) => {
    if (!code || code === 'auto') return 'Video language';
    try {
      const n = displayNames?.of(code);
      if (n && n !== code) return n[0].toUpperCase() + n.slice(1);
    } catch { /* unknown code — show it as it is */ }
    return code;
  };

  DS.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  DS.debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  /** Unique key of a track — used to compare it against the user's choice. */
  DS.trackKey = (t) => (t ? `${t.languageCode}|${t.kind || ''}|${t.name || ''}` : '');

  /** Waits for an element to appear in the DOM. */
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
