/**
 * Background worker: machine translation and the cache.
 *
 * Translation lives here rather than in the content script for two reasons:
 * cross-origin requests are allowed by the extension's host_permissions, and the
 * result is cached once for every tab.
 *
 * The provider order is chosen so that everything works for free and without
 * keys:
 *   1. YouTube tlang  -- done in the content script, never reaches here (0 requests)
 *   2. google         -- free unofficial endpoint, in batches
 *   3. deepl          -- if the user entered a free key (best quality)
 *   4. mymemory       -- small daily quota, the last line of defence
 */

const CACHE_PREFIX = 'mt:';
const CACHE_LIMIT = 120;

// --------------------------------- helpers ----------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hashTexts(texts) {
  let h = 0x811c9dc5;
  const s = texts.join(' ');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + texts.length;
}

class HttpError extends Error {
  constructor(status) { super('HTTP ' + status); this.status = status; }
}

/** Bounded concurrency: be gentle with the free endpoints. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Retry with exponential backoff -- a 429 from a free API is routine. */
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(700 * Math.pow(2, i - 1));
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e instanceof HttpError ? e.status : 0;
      if (status && status !== 429 && status < 500) throw e; // 400/403 will not heal
    }
  }
  throw lastErr;
}

/** Splits a list of strings into batches no longer than maxChars characters. */
export function chunkByChars(texts, maxChars) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const t of texts) {
    const add = t.length + 1;
    if (cur.length && len + add > maxChars) { chunks.push(cur); cur = []; len = 0; }
    cur.push(t);
    len += add;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ---------------------------- provider: Google ------------------------------

async function gtxTranslate(text, from, to) {
  const body = new URLSearchParams({
    client: 'gtx',
    dt: 't',
    sl: from || 'auto',
    tl: to,
    q: text
  });
  const res = await fetch('https://translate.googleapis.com/translate_a/single', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body
  });
  if (!res.ok) throw new HttpError(res.status);
  const raw = await res.text();
  if (/^\s*</.test(raw)) throw new HttpError(429); // a "Sorry..." page instead of JSON
  const data = JSON.parse(raw);
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('unexpected shape');
  return data[0].map((x) => (x && x[0]) || '').join('');
}

/**
 * Translates a batch of strings in one request, joined by newlines.
 *
 * Google almost always keeps the \n split, but does not guarantee it. So the
 * answer is checked by line count: if it does not match, the batch is halved and
 * translated again -- down to a single line, where a mismatch is impossible.
 * That way a translated line never ends up attached to the wrong cue.
 *
 * @param {string[]} texts
 * @param {(joined:string)=>Promise<string>} translateJoined translates the joined text
 */
export async function batchWithVerification(texts, translateJoined) {
  if (!texts.length) return [];
  const out = await translateJoined(texts.join('\n'));
  const lines = out.split('\n');
  if (lines.length === texts.length) return lines.map((s) => s.trim());
  if (texts.length === 1) return [out.replace(/\s*\n\s*/g, ' ').trim()];
  const mid = Math.ceil(texts.length / 2);
  const head = await batchWithVerification(texts.slice(0, mid), translateJoined);
  const tail = await batchWithVerification(texts.slice(mid), translateJoined);
  return [...head, ...tail];
}

async function providerGoogle(texts, from, to, onProgress) {
  const chunks = chunkByChars(texts, 1600);
  const translateJoined = (joined) => withRetry(() => gtxTranslate(joined, from, to));
  let done = 0;
  const results = await mapLimit(chunks, 2, async (chunk) => {
    const r = await batchWithVerification(chunk, translateJoined);
    done += chunk.length;
    onProgress(done);
    return r;
  });
  return results.flat();
}

// ----------------------------- provider: DeepL ------------------------------

async function providerDeepl(texts, from, to, onProgress, key) {
  if (!key) throw new Error('no DeepL key');
  const host = key.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const chunks = [];
  for (let i = 0; i < texts.length; i += 45) chunks.push(texts.slice(i, i + 45));

  let done = 0;
  const results = await mapLimit(chunks, 2, async (chunk) => {
    const payload = { text: chunk, target_lang: to.toUpperCase().slice(0, 2) };
    if (from && from !== 'auto') payload.source_lang = from.toUpperCase().slice(0, 2);
    const r = await withRetry(async () => {
      const res = await fetch(host + '/v2/translate', {
        method: 'POST',
        headers: {
          Authorization: 'DeepL-Auth-Key ' + key.trim(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new HttpError(res.status);
      return res.json();
    });
    done += chunk.length;
    onProgress(done);
    return (r.translations || []).map((t) => t.text);
  });
  return results.flat();
}

// --------------------------- provider: MyMemory -----------------------------

async function providerMyMemory(texts, from, to, onProgress) {
  // The anonymous quota is tiny, so this is the very last resort and the lines
  // go one by one -- slow, but nothing can end up on the wrong cue.
  let done = 0;
  return mapLimit(texts, 2, async (text) => {
    try {
      const r = await withRetry(async () => {
        const u = new URL('https://api.mymemory.translated.net/get');
        u.searchParams.set('q', text.slice(0, 480));
        u.searchParams.set('langpair', `${from || 'en'}|${to}`);
        const res = await fetch(u);
        if (!res.ok) throw new HttpError(res.status);
        return res.json();
      }, 2);
      return r?.responseData?.translatedText || '';
    } catch {
      return '';
    } finally {
      onProgress(++done);
    }
  });
}

const PROVIDERS = {
  google: providerGoogle,
  deepl: providerDeepl,
  mymemory: providerMyMemory
};

/** Order of attempts: the chosen one first, then the other free ones. */
export function providerChain(preferred, hasKey) {
  const chain = [];
  const add = (p) => {
    if (p && !chain.includes(p) && (p !== 'deepl' || hasKey)) chain.push(p);
  };
  add(preferred === 'youtube' ? 'google' : preferred);
  add('google');
  add('deepl');
  add('mymemory');
  return chain;
}

// ---------------------------------- cache -----------------------------------

/**
 * The cache keys. getKeys() returns names only (Chrome 130+); on older builds
 * the whole storage has to be read -- megabytes of subtitles -- so take the fast
 * path whenever it exists.
 */
async function cacheKeys() {
  if (typeof chrome.storage.local.getKeys === 'function') {
    return (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(CACHE_PREFIX));
  }
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
}

async function cacheGet(key, hash) {
  const stored = await chrome.storage.local.get(key);
  const hit = stored[key];
  if (hit && hit.h === hash && Array.isArray(hit.i)) {
    chrome.storage.local.set({ [key]: { ...hit, t: Date.now() } });
    return hit;
  }
  return null;
}

async function cachePut(key, hash, items, provider) {
  await chrome.storage.local.set({ [key]: { h: hash, i: items, p: provider, t: Date.now() } });

  const keys = await cacheKeys();
  if (keys.length <= CACHE_LIMIT) return;
  // Read the contents only when something really has to be evicted.
  const entries = await chrome.storage.local.get(keys);
  keys.sort((a, b) => (entries[a]?.t || 0) - (entries[b]?.t || 0));
  await chrome.storage.local.remove(keys.slice(0, keys.length - CACHE_LIMIT));
}

// ------------------------------ request handling ----------------------------

async function translate(req, post) {
  const { texts, from, to, provider = 'google', deeplKey = '', videoId = '' } = req;
  if (!texts?.length) return { ok: true, items: [], provider: 'none' };

  const hash = hashTexts(texts);
  const key = `${CACHE_PREFIX}${videoId}:${from || 'auto'}:${to}`;

  const cached = await cacheGet(key, hash);
  if (cached) {
    post({ type: 'progress', done: texts.length, total: texts.length });
    return { ok: true, items: cached.i, provider: cached.p, cached: true };
  }

  const chain = providerChain(provider, !!deeplKey);
  const errors = [];

  for (const name of chain) {
    const fn = PROVIDERS[name];
    if (!fn) continue;
    try {
      post({ type: 'provider', provider: name });
      const items = await fn(
        texts,
        from,
        to,
        (done) => post({ type: 'progress', done, total: texts.length }),
        deeplKey
      );
      const filled = items.filter((s) => s && s.trim()).length;
      if (filled < texts.length * 0.5) throw new Error('too many empty translations');
      const normalized = texts.map((_, i) => (items[i] || '').trim());
      await cachePut(key, hash, normalized, name);
      return { ok: true, items: normalized, provider: name };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  return { ok: false, error: errors.join('; ') || 'translation failed' };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ds-translate') return;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'translate') return;
    const post = (m) => {
      try { port.postMessage(m); } catch { /* port already closed */ }
    };
    try {
      const result = await translate(msg, post);
      post({ type: 'result', ...result });
    } catch (e) {
      post({ type: 'result', ok: false, error: e.message });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'clearCache') {
    cacheKeys().then((keys) =>
      chrome.storage.local.remove(keys).then(() => sendResponse({ ok: true, removed: keys.length })));
    return true;
  }
  if (msg?.type === 'cacheStats') {
    cacheKeys().then((keys) => sendResponse({ ok: true, entries: keys.length }));
    return true;
  }
  return false;
});

/** Alt+D -- the quick toggle. */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-dual-subs') return;
  const { enabled = true } = await chrome.storage.sync.get({ enabled: true });
  await chrome.storage.sync.set({ enabled: !enabled });
});
