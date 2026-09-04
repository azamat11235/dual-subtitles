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
    // Translation provider. 'youtube' is YouTube's own built-in translation.
    translator: 'youtube',
    deeplKey: '',
    // Appearance
    fontSize: 100,        // % of the base size
    lineGap: 4,           // px between the lines
    // Where the block was dragged to, as fractions of the player size (X is the
    // centre of the block, Y its distance from the bottom). null means it was
    // never dragged and the resting place near the bottom edge is used.
    captionX: null,
    captionY: null,
    background: 55,       // backdrop opacity, %
    primaryColor: '#ffffff',
    secondaryColor: '#7fd1ff',
    // Behaviour
    pauseOnHover: false   // pause when the mouse is over the subtitles
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

  /**
   * The keyboard shortcut as this platform writes it.
   *
   * macOS has no Alt key: the same physical key is Option, written ⌥. Chrome
   * hands the binding over in whatever spelling it likes, so anything already in
   * symbols is passed through untouched and only the ASCII names are mapped.
   */
  const MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
  const KEY_SYMBOL = {
    command: '⌘', cmd: '⌘', meta: '⌘',
    ctrl: '⌃', control: '⌃', macctrl: '⌃',
    alt: '⌥', option: '⌥', opt: '⌥',
    shift: '⇧'
  };

  DS.shortcutLabel = (shortcut) => {
    if (!shortcut) return '';
    if (!MAC) return shortcut;
    // On a Mac the parts are written side by side, without separators.
    return shortcut.split('+').map((part) => {
      const key = part.trim();
      return KEY_SYMBOL[key.toLowerCase()] || key;
    }).join('');
  };

  /**
   * What the shortcut is actually bound to — it can be changed or cleared in the
   * browser's own settings, and an empty string means it is unbound.
   *
   * chrome.commands is out of reach from a content script, so there the question
   * goes to the background worker.
   */
  DS.getShortcut = async (name = 'toggle-dual-subs') => {
    try {
      if (chrome.commands?.getAll) {
        const all = await chrome.commands.getAll();
        return all.find((c) => c.name === name)?.shortcut || '';
      }
      const r = await chrome.runtime.sendMessage({ type: 'shortcut', name });
      return r?.shortcut || '';
    } catch {
      return ''; // worker asleep or extension reloaded — show the label bare
    }
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
