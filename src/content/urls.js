/**
 * Building the /api/timedtext request.
 *
 * Pure string work, kept apart from tracks.js so it can be tested: the rules
 * here are quirks of YouTube's API rather than anything derivable, and getting
 * one wrong produces an empty response rather than an error.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  const ORIGIN = (typeof location !== 'undefined' && location.origin) || 'https://www.youtube.com';

  /**
   * Reuses an intercepted URL — the one the player requested, carrying a valid
   * `pot` token — for a different track.
   *
   * `lang`, `name`, `kind` and `tlang` are outside the signature (`sparams`) and
   * can be swapped freely. `variant` cannot: it belongs to the track, and the
   * original transcript is served without it while a dub-derived one is served
   * only with it. Carrying the captured value across to another language earns a
   * 200 with an empty body, so the caller asks for each form in turn.
   *
   * @param {string} potUrl   a URL the player itself requested
   * @param {object} track    the track wanted, as normalised by tracks.js
   * @param {string|null} tlang   YouTube-side translation target
   * @param {string|null} variant `'timing-optimized'`, or null to drop it
   */
  DS.buildFromPot = function buildFromPot(potUrl, track, tlang, variant) {
    const u = new URL(potUrl);
    u.searchParams.set('fmt', 'json3');

    // The parameters that select the track, taken from the track's own baseUrl
    // where it has them.
    const src = track.baseUrl ? new URL(track.baseUrl, ORIGIN).searchParams : null;
    const pick = (key, fallback) => (src ? src.get(key) : fallback);

    const lang = pick('lang', track.languageCode) ?? track.languageCode;
    u.searchParams.set('lang', lang);

    const name = pick('name', track.name || null);
    if (name) u.searchParams.set('name', name); else u.searchParams.delete('name');

    const kind = pick('kind', track.kind || null);
    if (kind) u.searchParams.set('kind', kind); else u.searchParams.delete('kind');

    if (tlang) u.searchParams.set('tlang', tlang); else u.searchParams.delete('tlang');
    if (variant) u.searchParams.set('variant', variant); else u.searchParams.delete('variant');

    return u.toString();
  };

  /**
   * The track's own baseUrl. Today this answers 200 with an empty body — it
   * carries no `pot` — but it costs nothing to try and it is the only route left
   * when nothing could be intercepted.
   */
  DS.buildFromBase = function buildFromBase(track, tlang, fmt) {
    if (!track.baseUrl) return null;
    const u = new URL(track.baseUrl, ORIGIN);
    if (fmt) u.searchParams.set('fmt', fmt); else u.searchParams.delete('fmt');
    if (tlang) u.searchParams.set('tlang', tlang); else u.searchParams.delete('tlang');
    return u.toString();
  };
})();
