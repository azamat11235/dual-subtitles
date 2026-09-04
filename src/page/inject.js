/**
 * Bridge into the page's main world.
 *
 * A content script lives in the isolated world and sees neither
 * ytInitialPlayerResponse nor the methods YouTube hangs off the #movie_player
 * element. This file is injected into the page itself and answers the content
 * script's requests over window.postMessage.
 */
(() => {
  if (window.__dsBridgeInstalled) return;
  window.__dsBridgeInstalled = true;

  const ORIGIN = location.origin;

  const findPlayer = () =>
    document.getElementById('movie_player') ||
    document.querySelector('#shorts-player') ||
    document.querySelector('.html5-video-player');

  /** State of the native captions before we switched them on for a moment. */
  let savedTrack = null;
  let didPrime = false;

  function getPlayerResponse() {
    const p = findPlayer();
    try {
      if (p && typeof p.getPlayerResponse === 'function') {
        const r = p.getPlayerResponse();
        if (r) return r;
      }
    } catch { /* the player is not ready yet */ }
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
     * Makes the player request a subtitle track once — purely so that a URL with
     * a valid pot token shows up in Resource Timing.
     */
    primeCaptions({ force = false } = {}) {
      const p = findPlayer();
      if (!p || typeof p.getOption !== 'function') return null;

      let current = null;
      try { current = p.getOption('captions', 'track'); } catch { /* module not loaded yet */ }
      if (current && current.languageCode && !force) return { alreadyOn: true };

      try { if (typeof p.loadModule === 'function') p.loadModule('captions'); } catch { /* already loaded */ }

      let list = [];
      try { list = p.getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch { /* no list */ }
      if (!list.length) return null;

      // With force, pick a track other than the current one: for the same track
      // the player answers from its own cache and makes no network request.
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

    /** Puts the player's captions back the way they were. */
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

    /** Controlling the native captions from our panel. */
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
