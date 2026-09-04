/**
 * Choosing which track feeds each line.
 *
 * Split out of main.js because it is pure decision-making over data YouTube
 * hands us, and because getting it wrong is quiet: the wrong language simply
 * appears on screen, with nothing in the console to say why.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  DS.baseLang = (code) => String(code || '').split('-')[0].toLowerCase();

  /**
   * The language the video is actually in.
   *
   * `videoDetails.defaultAudioLanguage` answers this when it is there, and on an
   * auto-dubbed video it is not — which is exactly where a guess does the most
   * damage, because such a video carries one automatic caption track per dub,
   * twenty of them, sorted alphabetically. Falling through to "the first track"
   * picked Arabic for an English video.
   *
   * YouTube does say which track belongs to the original: every entry of
   * `audioTracks` points its `defaultCaptionTrackIndex` at it. tracks.js resolves
   * that index into `defaultCaptionLanguage` while the raw list is still at hand.
   *
   * The last resort is a lone automatic track: YouTube only ever recognises
   * speech in the language actually spoken, so one such track names it. Several
   * of them mean dubs, and then it says nothing.
   */
  DS.videoLanguageOf = function videoLanguageOf(info) {
    if (!info) return null;
    if (info.defaultAudioLanguage) return info.defaultAudioLanguage;
    if (info.defaultCaptionLanguage) return info.defaultCaptionLanguage;

    const asr = (info.tracks || []).filter((t) => t.kind === 'asr');
    const languages = new Set(asr.map((t) => DS.baseLang(t.languageCode)));
    return languages.size === 1 ? asr[0].languageCode : null;
  };

  /**
   * @param {Array} tracks
   * @param {string} lang           a language code, or 'auto' for the video's own
   * @param {string|null} videoLanguage  result of videoLanguageOf, for 'auto'
   */
  DS.pickTrack = function pickTrack(tracks, lang, videoLanguage) {
    if (!tracks?.length) return null;

    const inLanguage = (code) => {
      const exact = tracks.filter((t) => t.languageCode.toLowerCase() === String(code).toLowerCase());
      const loose = tracks.filter((t) => DS.baseLang(t.languageCode) === DS.baseLang(code));
      const pool = exact.length ? exact : loose;
      // A manual track always beats an automatically recognised one.
      return pool.length ? (pool.find((t) => !t.kind) || pool[0]) : null;
    };

    if (!lang || lang === 'auto') {
      // Knowing the language is not the same as having a track for it: a dubbed
      // video may lack a track in the original language entirely.
      return (videoLanguage && inLanguage(videoLanguage)) ||
        tracks.find((t) => !t.kind) ||
        tracks[0];
    }

    return inLanguage(lang);
  };
})();
