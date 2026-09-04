/**
 * Getting the track list and the subtitles themselves.
 *
 * Why this is not simple. The naive way — take captionTracks[].baseUrl from
 * ytInitialPlayerResponse and download it — today returns HTTP 200 with an EMPTY
 * body: YouTube wants a pot (proof-of-origin) token in the request, and baseUrl
 * has none. What does work is to watch the URL the player itself requests (that
 * one has a pot) and reuse it with the track parameters swapped: lang / name /
 * kind / tlang are not part of the signature (sparams), so one intercepted URL
 * can fetch any track and any translation.
 *
 * The player's URL is visible from the isolated world through the Resource
 * Timing API — no main-world hook needed for it.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  // ───────────────────────────── bridge to main world ──────────────────────────

  const pending = new Map();
  let msgSeq = 0;
  let bridgeReady = null;

  function injectScriptTag() {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('src/page/inject.js');
      s.dataset.dsBridge = '1';
      s.onload = () => { s.remove(); resolve(true); };
      s.onerror = () => { s.remove(); resolve(false); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  /**
   * The bridge is normally already in place: the manifest loads inject.js as a
   * content script in the MAIN world (Chrome 111+). The <script> tag is only
   * injected when there is no answer — a fallback for older Chromium builds.
   */
  function ensureBridge() {
    if (bridgeReady) return bridgeReady;
    bridgeReady = (async () => {
      if (await postAndWait('ping', {}, 800)) return true;
      await injectScriptTag();
      return !!(await postAndWait('ping', {}, 1500));
    })();
    return bridgeReady;
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__ds !== 'res') return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    clearTimeout(p.timer);
    p.resolve(d.ok ? d.data : null);
  });

  function postAndWait(action, args = {}, timeout = 6000) {
    const id = ++msgSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeout);
      pending.set(id, { resolve, timer });
      window.postMessage({ __ds: 'req', id, action, args }, location.origin);
    });
  }

  async function callPage(action, args = {}, timeout = 6000) {
    await ensureBridge();
    return postAndWait(action, args, timeout);
  }
  DS.callPage = callPage;

  // ───────────────────────── intercepting the pot URL ──────────────────────────

  /** videoId → the last /api/timedtext URL seen for that video. */
  const potUrls = new Map();

  function rememberUrl(url) {
    if (!url || url.indexOf('/api/timedtext') === -1) return;
    try {
      const v = new URL(url).searchParams.get('v');
      if (v) potUrls.set(v, url);
    } catch { /* not our URL */ }
  }

  function scanExistingEntries() {
    try {
      for (const e of performance.getEntriesByType('resource')) rememberUrl(e.name);
    } catch { /* Resource Timing unavailable */ }
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) rememberUrl(e.name);
    }).observe({ type: 'resource', buffered: true });
  } catch {
    scanExistingEntries();
  }

  /**
   * Makes sure a pot URL exists for the video: if the player has not loaded any
   * subtitles yet, ask it to switch a track on for a moment and catch the request.
   */
  async function ensurePotUrl(videoId, { force = false } = {}) {
    scanExistingEntries();
    if (!force && potUrls.has(videoId)) return potUrls.get(videoId);

    const primed = await callPage('primeCaptions', {}, 8000);
    if (!primed) return null;

    for (let i = 0; i < 20; i++) {
      await DS.sleep(150);
      scanExistingEntries();
      if (potUrls.has(videoId)) break;
    }
    // Put the player's own captions back the way they were.
    callPage('restoreCaptions', {}, 3000);
    return potUrls.get(videoId) || null;
  }

  // ──────────────────────────────── track list ─────────────────────────────────

  function normalizeTrack(t) {
    let name = null;
    try { name = new URL(t.baseUrl, location.origin).searchParams.get('name'); } catch { /* no baseUrl */ }
    return {
      languageCode: t.languageCode,
      kind: t.kind === 'asr' ? 'asr' : '',
      name: name || '',
      baseUrl: t.baseUrl || '',
      isTranslatable: t.isTranslatable !== false,
      displayName: t.name?.simpleText || t.name?.runs?.[0]?.text || ''
    };
  }

  /**
   * Fallback: pull captionTracks straight out of the page HTML.
   * The end of the array is found by counting brackets rather than with a regex:
   * tracks contain nested arrays (name.runs), and a lazy match trips over them.
   */
  function extractJsonArray(text, from) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = from; i < text.length; i++) {
      const c = text[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (!depth) return text.slice(from, i + 1); }
    }
    return null;
  }

  function tracksFromDom() {
    try {
      const html = document.documentElement.innerHTML;
      const at = html.indexOf('"captionTracks":[');
      if (at === -1) return null;
      const chunk = extractJsonArray(html, html.indexOf('[', at));
      if (!chunk) return null;
      const raw = JSON.parse(chunk.replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
      return { tracks: raw, translationLanguages: [] };
    } catch { return null; }
  }

  /**
   * @returns {{videoId:string, tracks:Array, translationLanguages:Array}|null}
   */
  DS.getCaptionInfo = async function getCaptionInfo(videoId) {
    let info = await callPage('getTracks', {});
    if (!info || !info.tracks?.length || (videoId && info.videoId !== videoId)) {
      const dom = tracksFromDom();
      if (dom?.tracks?.length) info = { videoId, tracks: dom.tracks, translationLanguages: info?.translationLanguages || [] };
    }
    if (!info || !info.tracks) return null;
    // Resolve the index before normalising: it points into the raw list, and
    // normalising drops the odd entry that carries no language.
    const at = info.defaultCaptionTrackIndex;
    const defaultCaptionLanguage = Number.isInteger(at)
      ? (info.tracks[at]?.languageCode || null)
      : null;
    return {
      videoId: info.videoId || videoId,
      defaultAudioLanguage: info.defaultAudioLanguage || null,
      defaultCaptionLanguage,
      tracks: info.tracks.map(normalizeTrack).filter((t) => t.languageCode),
      translationLanguages: (info.translationLanguages || []).map((l) => ({
        code: l.languageCode,
        name: l.languageName?.simpleText || l.languageName?.runs?.[0]?.text || l.languageCode
      }))
    };
  };

  // ───────────────────────────── fetching subtitles ────────────────────────────

  const RETRYABLE = new Set(['empty', 'rate-limit', 'server', 'network']);

  /**
   * One attempt. Returns {cues} or {error} — the caller decides whether to retry.
   */
  async function attempt(url, isXml) {
    let res;
    try {
      res = await fetch(url, { credentials: 'include' });
    } catch {
      return { error: 'network' };
    }
    if (res.status === 429) return { error: 'rate-limit' };
    if (res.status >= 500) return { error: 'server' };
    if (!res.ok) return { error: 'http-' + res.status };

    const text = await res.text();
    // YouTube's main failure mode: 200 with an empty body.
    if (!text.trim()) return { error: 'empty' };
    if (/^\s*<(!doctype\s+)?html/i.test(text)) return { error: 'rate-limit' };

    try {
      const cues = isXml ? DS.parseXml(text) : DS.parseJson3(JSON.parse(text));
      if (!cues.length) return { error: 'empty' };
      return { cues };
    } catch {
      return { error: 'parse' };
    }
  }

  const cueCache = new Map(); // key → cues

  /**
   * Downloads a track's subtitles, optionally through YouTube's own translation.
   * @returns {Promise<{cues:Array}|{error:string}>}
   */
  DS.fetchCues = async function fetchCues(videoId, track, tlang = null) {
    const key = `${videoId}|${DS.trackKey(track)}|${tlang || ''}`;
    if (cueCache.has(key)) return { cues: cueCache.get(key) };

    const run = async (potUrl) => {
      const strategies = [];
      if (potUrl) {
        strategies.push({ url: DS.buildFromPot(potUrl, track, tlang, null), xml: false });
        strategies.push({ url: DS.buildFromPot(potUrl, track, tlang, 'timing-optimized'), xml: false });
      }
      const jsonBase = DS.buildFromBase(track, tlang, 'json3');
      if (jsonBase) strategies.push({ url: jsonBase, xml: false });
      const xmlBase = DS.buildFromBase(track, tlang, null);
      if (xmlBase) strategies.push({ url: xmlBase, xml: true });

      if (!strategies.length) return { error: 'no-url' };

      // Every strategy is tried once before anything is retried. An empty body
      // is both what a wrong `variant` returns and what rate limiting returns,
      // and only the first is fixed by the next strategy -- pausing before
      // reaching it would cost seconds on the common case.
      let lastError = 'unknown';
      const spent = new Set();
      for (let pass = 0; pass < 3; pass++) {
        if (pass) await DS.sleep(400 * pass * pass); // 0 / 400 / 1600 ms
        for (const s of strategies) {
          if (spent.has(s)) continue;
          const r = await attempt(s.url, s.xml);
          if (r.cues) return r;
          lastError = r.error;
          if (!RETRYABLE.has(r.error)) spent.add(s); // 403/parse — retrying will not help
        }
        if (spent.size === strategies.length) break;
      }
      return { error: lastError };
    };

    const potUrl = await ensurePotUrl(videoId);
    let result = await run(potUrl);

    // The signature in the link lives only a few hours. If it went stale during
    // a long watch, ask the player to fetch subtitles again and retry.
    if (!result.cues && potUrl) {
      potUrls.delete(videoId);
      const fresh = await ensurePotUrl(videoId, { force: true });
      if (fresh && fresh !== potUrl) result = await run(fresh);
    }

    if (result.cues) {
      cueCache.set(key, result.cues);
      DS.log('subtitles fetched', { track: DS.trackKey(track), tlang, cues: result.cues.length });
      return { cues: result.cues };
    }
    DS.log('could not fetch subtitles', { track: DS.trackKey(track), tlang, error: result.error });
    return { error: result.error };
  };

  DS.clearCueCache = (videoId) => {
    for (const k of [...cueCache.keys()]) if (!videoId || k.startsWith(videoId + '|')) cueCache.delete(k);
  };
})();
