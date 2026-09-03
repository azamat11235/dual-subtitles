/**
 * Мост в main world страницы.
 *
 * Content script живёт в isolated world и не видит ни ytInitialPlayerResponse,
 * ни методы, которые YouTube навешивает на элемент #movie_player. Этот файл
 * инжектится в саму страницу и отвечает на запросы content script'а
 * через window.postMessage.
 */
(() => {
  if (window.__dsBridgeInstalled) return;
  window.__dsBridgeInstalled = true;

  const ORIGIN = location.origin;

  const findPlayer = () =>
    document.getElementById('movie_player') ||
    document.querySelector('#shorts-player') ||
    document.querySelector('.html5-video-player');

  /** Состояние родных субтитров до того, как мы их временно включили. */
  let savedTrack = null;
  let didPrime = false;

  function getPlayerResponse() {
    const p = findPlayer();
    try {
      if (p && typeof p.getPlayerResponse === 'function') {
        const r = p.getPlayerResponse();
        if (r) return r;
      }
    } catch { /* плеер ещё не готов */ }
    return window.ytInitialPlayerResponse || null;
  }

  const handlers = {
    getTracks() {
      const pr = getPlayerResponse();
      if (!pr) return null;
      const r = pr.captions?.playerCaptionsTracklistRenderer || {};
      return {
        videoId: pr.videoDetails?.videoId || null,
        title: pr.videoDetails?.title || '',
        defaultAudioLanguage: pr.videoDetails?.defaultAudioLanguage || null,
        tracks: r.captionTracks || [],
        translationLanguages: r.translationLanguages || []
      };
    },

    /**
     * Заставляем плеер один раз запросить дорожку субтитров — только ради того,
     * чтобы в Resource Timing появился URL с валидным pot-токеном.
     */
    primeCaptions({ force = false } = {}) {
      const p = findPlayer();
      if (!p || typeof p.getOption !== 'function') return null;

      let current = null;
      try { current = p.getOption('captions', 'track'); } catch { /* модуль ещё не загружен */ }
      if (current && current.languageCode && !force) return { alreadyOn: true };

      try { if (typeof p.loadModule === 'function') p.loadModule('captions'); } catch { /* уже загружен */ }

      let list = [];
      try { list = p.getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch { /* нет списка */ }
      if (!list.length) return null;

      // При force берём дорожку, отличную от текущей: на ту же самую плеер
      // ответит из своего кэша и нового сетевого запроса не сделает.
      const target = force
        ? (list.find((t) => t.languageCode !== current?.languageCode) || list[0])
        : list[0];

      if (!didPrime) { savedTrack = current || {}; didPrime = true; }
      try {
        p.setOption('captions', 'track', target);
        return { primed: true, languageCode: target.languageCode };
      } catch {
        return null;
      }
    },

    /** Возвращаем субтитры плеера в исходное состояние. */
    restoreCaptions() {
      if (!didPrime) return { restored: false };
      const p = findPlayer();
      didPrime = false;
      if (!p || typeof p.setOption !== 'function') return { restored: false };
      try {
        p.setOption('captions', 'track', savedTrack && savedTrack.languageCode ? savedTrack : {});
        return { restored: true };
      } catch {
        return { restored: false };
      }
    },

    /** Управление родными субтитрами из нашей панели. */
    setNativeTrack({ languageCode = null } = {}) {
      const p = findPlayer();
      if (!p || typeof p.setOption !== 'function') return null;
      try {
        if (!languageCode) { p.setOption('captions', 'track', {}); return { ok: true }; }
        const list = p.getOption('captions', 'tracklist', { includeAsr: true }) || [];
        const t = list.find((x) => x.languageCode === languageCode) || list[0];
        if (!t) return null;
        p.setOption('captions', 'track', t);
        return { ok: true };
      } catch { return null; }
    },

    ping() { return { ok: true, hasPlayer: !!findPlayer() }; }
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const d = ev.data;
    if (!d || d.__ds !== 'req' || typeof d.id !== 'number') return;
    const fn = handlers[d.action];
    let data = null;
    let ok = false;
    if (fn) {
      try { data = fn(d.args || {}); ok = data !== null && data !== undefined; }
      catch (e) { ok = false; data = null; }
    }
    window.postMessage({ __ds: 'res', id: d.id, ok, data }, ORIGIN);
  });
})();
