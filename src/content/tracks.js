/**
 * Получение списка дорожек и самих субтитров.
 *
 * Почему всё так непросто. Наивный способ — взять captionTracks[].baseUrl из
 * ytInitialPlayerResponse и скачать его — сегодня возвращает HTTP 200 с ПУСТЫМ
 * телом: YouTube требует в запросе токен pot (proof-of-origin), которого в
 * baseUrl нет. Рабочий способ — подсмотреть URL, который запрашивает сам плеер
 * (в нём есть pot), и переиспользовать его, подменив параметры дорожки:
 * lang / name / kind / tlang НЕ входят в подпись (sparams), поэтому одним
 * перехваченным URL можно скачать любую дорожку и любой автоперевод.
 *
 * URL плеера видно из isolated world через Resource Timing API — хук в main
 * world для этого не нужен.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  // ───────────────────────────── мост в main world ─────────────────────────────

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
   * Обычно мост уже стоит: манифест грузит inject.js как content script в
   * MAIN world (Chrome 111+). Тег <script> внедряем только если ответа нет --
   * это запасной путь для старых сборок Chromium.
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

  // ──────────────────────── перехват URL с pot-токеном ─────────────────────────

  /** videoId → последний увиденный URL /api/timedtext для этого видео. */
  const potUrls = new Map();

  function rememberUrl(url) {
    if (!url || url.indexOf('/api/timedtext') === -1) return;
    try {
      const v = new URL(url).searchParams.get('v');
      if (v) potUrls.set(v, url);
    } catch { /* не наш URL */ }
  }

  function scanExistingEntries() {
    try {
      for (const e of performance.getEntriesByType('resource')) rememberUrl(e.name);
    } catch { /* Resource Timing недоступен */ }
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) rememberUrl(e.name);
    }).observe({ type: 'resource', buffered: true });
  } catch {
    scanExistingEntries();
  }

  /**
   * Гарантирует наличие pot-URL для видео: если плеер ещё не грузил субтитры,
   * просим его на мгновение включить дорожку и ловим запрос.
   */
  async function ensurePotUrl(videoId, { force = false } = {}) {
    scanExistingEntries();
    if (!force && potUrls.has(videoId)) return potUrls.get(videoId);

    const primed = await callPage('primeCaptions', { force }, 8000);
    if (!primed) return null;

    for (let i = 0; i < 20; i++) {
      await DS.sleep(150);
      scanExistingEntries();
      if (potUrls.has(videoId)) break;
    }
    // Возвращаем плееру исходное состояние субтитров.
    callPage('restoreCaptions', {}, 3000);
    return potUrls.get(videoId) || null;
  }

  // ──────────────────────────── список дорожек ─────────────────────────────────

  function normalizeTrack(t) {
    let name = null;
    try { name = new URL(t.baseUrl, location.origin).searchParams.get('name'); } catch { /* нет baseUrl */ }
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
   * Запасной путь: выдрать captionTracks прямо из HTML страницы.
   * Границу массива ищем счётчиком скобок, а не регуляркой: внутри дорожек
   * встречаются вложенные массивы (name.runs), и ленивый поиск на них спотыкается.
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
    return {
      videoId: info.videoId || videoId,
      defaultAudioLanguage: info.defaultAudioLanguage || null,
      tracks: info.tracks.map(normalizeTrack).filter((t) => t.languageCode),
      translationLanguages: (info.translationLanguages || []).map((l) => ({
        code: l.languageCode,
        name: l.languageName?.simpleText || l.languageName?.runs?.[0]?.text || l.languageCode
      }))
    };
  };

  // ─────────────────────────── загрузка субтитров ──────────────────────────────

  function buildFromPot(potUrl, track, tlang) {
    const u = new URL(potUrl);
    u.searchParams.set('fmt', 'json3');
    // Параметры, определяющие дорожку. Они не подписаны, их можно подменять.
    const src = track.baseUrl ? new URL(track.baseUrl, location.origin).searchParams : null;
    const pick = (key, fallback) => (src ? src.get(key) : fallback);

    const lang = pick('lang', track.languageCode) ?? track.languageCode;
    u.searchParams.set('lang', lang);

    const name = pick('name', track.name || null);
    if (name) u.searchParams.set('name', name); else u.searchParams.delete('name');

    const kind = pick('kind', track.kind || null);
    if (kind) u.searchParams.set('kind', kind); else u.searchParams.delete('kind');

    if (tlang) u.searchParams.set('tlang', tlang); else u.searchParams.delete('tlang');
    return u.toString();
  }

  function buildFromBase(track, tlang, fmt) {
    if (!track.baseUrl) return null;
    const u = new URL(track.baseUrl, location.origin);
    if (fmt) u.searchParams.set('fmt', fmt); else u.searchParams.delete('fmt');
    if (tlang) u.searchParams.set('tlang', tlang); else u.searchParams.delete('tlang');
    return u.toString();
  }

  const RETRYABLE = new Set(['empty', 'rate-limit', 'server', 'network']);

  /**
   * Одна попытка. Возвращает {cues} либо {error} — вызывающий решает, повторять ли.
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
    // Главный режим отказа YouTube: 200 и пустое тело.
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

  const cueCache = new Map(); // ключ → cues

  /**
   * Скачивает субтитры дорожки, при необходимости с автопереводом YouTube (tlang).
   * @returns {Promise<{cues:Array}|{error:string}>}
   */
  DS.fetchCues = async function fetchCues(videoId, track, tlang = null) {
    const key = `${videoId}|${DS.trackKey(track)}|${tlang || ''}`;
    if (cueCache.has(key)) return { cues: cueCache.get(key) };

    const run = async (potUrl) => {
      const strategies = [];
      if (potUrl) strategies.push({ url: buildFromPot(potUrl, track, tlang), xml: false });
      const jsonBase = buildFromBase(track, tlang, 'json3');
      if (jsonBase) strategies.push({ url: jsonBase, xml: false });
      const xmlBase = buildFromBase(track, tlang, null);
      if (xmlBase) strategies.push({ url: xmlBase, xml: true });

      if (!strategies.length) return { error: 'no-url' };

      let lastError = 'unknown';
      for (const s of strategies) {
        for (let tryNo = 0; tryNo < 3; tryNo++) {
          if (tryNo) await DS.sleep(400 * tryNo * tryNo); // 0 / 400 / 1600 мс
          const r = await attempt(s.url, s.xml);
          if (r.cues) return r;
          lastError = r.error;
          if (!RETRYABLE.has(r.error)) break; // 403/parse — повтор не поможет
        }
      }
      return { error: lastError };
    };

    const potUrl = await ensurePotUrl(videoId);
    let result = await run(potUrl);

    // Подпись в ссылке живёт считаные часы. Если за долгий просмотр она
    // протухла, просим плеер сходить за субтитрами заново и пробуем ещё раз.
    if (!result.cues && potUrl) {
      potUrls.delete(videoId);
      const fresh = await ensurePotUrl(videoId, { force: true });
      if (fresh && fresh !== potUrl) result = await run(fresh);
    }

    if (result.cues) {
      cueCache.set(key, result.cues);
      DS.log('субтитры получены', { track: DS.trackKey(track), tlang, cues: result.cues.length });
      return { cues: result.cues };
    }
    DS.log('не удалось скачать субтитры', { track: DS.trackKey(track), tlang, error: result.error });
    return { error: result.error };
  };

  DS.clearCueCache = (videoId) => {
    for (const k of [...cueCache.keys()]) if (!videoId || k.startsWith(videoId + '|')) cueCache.delete(k);
  };
})();
