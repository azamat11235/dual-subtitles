/**
 * Orchestrator: watches navigation, picks a track for each language, fetches the
 * subtitles and, when the wanted language has no track of its own, gets it
 * translated.
 *
 * How the second language is chosen (the interesting part):
 *   1. An existing track in that language (a manual one beats an automatic one).
 *   2. YouTube's own translation: the same request with a `tlang` parameter.
 *      Free, one request for the whole video, timings identical to the original.
 *   3. Machine translation in the background worker (Google / DeepL / MyMemory).
 *      Cues are merged into sentences first: translating a fragment such as
 *      "which means I had to" gives nonsense, translating a sentence does not.
 *
 * Whatever the source, the result is folded into a single list of segments --
 * {start, end, primary, secondary} -- built on the timing of the first line. The
 * renderer knows nothing about where the second line came from, and the two
 * lines cannot drift apart because they are two fields of one object.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  const renderer = new DS.Renderer();
  DS.renderer = renderer;

  /** Public state — read by the settings panel. */
  DS.state = {
    videoId: null,
    info: null,          // {tracks, translationLanguages}
    plan: null,          // {primary, secondary}
    status: { text: '', kind: '' },
    busy: false
  };

  const stateListeners = new Set();
  DS.onStateChange = (fn) => stateListeners.add(fn);
  const emit = () => stateListeners.forEach((fn) => fn(DS.state));

  function setStatus(text, kind = '') {
    DS.state.status = { text, kind };
    emit();
  }
  DS.setStatus = setStatus;

  // ------------------------------ picking tracks ------------------------------

  const baseLang = DS.baseLang;

  /**
   * Decides where the text for each line comes from.
   * @returns {{primary:Object, secondary:Object}}
   */
  function buildPlan(info, settings) {
    const { tracks, translationLanguages } = info;
    const videoLanguage = DS.videoLanguageOf(info);

    const primaryTrack = DS.pickTrack(tracks, settings.primaryLang, videoLanguage);
    const primary = primaryTrack
      ? { source: 'native', track: primaryTrack, lang: primaryTrack.languageCode }
      : { source: 'none', reason: 'no track for the first language' };

    const wanted = settings.secondaryLang;
    let secondary;

    if (!wanted || wanted === 'off') {
      secondary = { source: 'none', reason: 'second language is off' };
    } else {
      const nativeSecond = DS.pickTrack(tracks, wanted, null);
      const sameAsPrimary = nativeSecond && primaryTrack &&
        DS.trackKey(nativeSecond) === DS.trackKey(primaryTrack);

      if (nativeSecond && !sameAsPrimary) {
        secondary = { source: 'native', track: nativeSecond, lang: nativeSecond.languageCode };
      } else if (sameAsPrimary) {
        secondary = { source: 'none', reason: 'the video is already in this language' };
      } else if (!primaryTrack) {
        secondary = { source: 'none', reason: 'nothing to translate — this video has no subtitles' };
      } else {
        const ytCan = primaryTrack.isTranslatable &&
          (!translationLanguages.length ||
            translationLanguages.some((l) => baseLang(l.code) === baseLang(wanted)));
        secondary = ytCan
          ? { source: 'yt-translate', track: primaryTrack, tlang: wanted, lang: wanted }
          : { source: 'machine', from: primaryTrack.languageCode, lang: wanted };
      }
    }

    return { primary, secondary };
  }

  // -------------------------------- translation -------------------------------

  function translateTexts(videoId, texts, from, to, settings, onProgress) {
    return new Promise((resolve) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: 'ds-translate' });
      } catch (e) {
        resolve({ ok: false, error: 'the extension was reloaded, refresh the page' });
        return;
      }
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

      port.onMessage.addListener((m) => {
        if (m.type === 'progress') onProgress(m.done, m.total);
        else if (m.type === 'provider') onProgress(0, texts.length, m.provider);
        else if (m.type === 'result') { finish(m); try { port.disconnect(); } catch { /* already closed */ } }
      });
      port.onDisconnect.addListener(() => finish({ ok: false, error: 'lost connection to the worker' }));

      port.postMessage({
        type: 'translate',
        texts,
        from: baseLang(from),
        to: baseLang(to),
        provider: settings.translator,
        deeplKey: settings.deeplKey,
        videoId
      });
    });
  }

  const PROVIDER_LABEL = {
    google: 'Google',
    deepl: 'DeepL',
    mymemory: 'MyMemory'
  };

  // --------------------------------- main loop --------------------------------

  let runToken = 0;
  let playerWaits = 0;

  async function run(reason) {
    const token = ++runToken;
    const stale = () => token !== runToken;

    const settings = await DS.getSettings();
    const videoId = DS.videoIdFromUrl();

    if (!settings.enabled || !videoId) {
      renderer.detach();
      document.querySelector('.html5-video-player')?.classList.remove('ds-hide-native');
      DS.state.videoId = videoId;
      DS.state.plan = null;
      setStatus(settings.enabled ? '' : 'Off');
      return;
    }

    const player = await DS.waitFor('#movie_player, .html5-video-player');
    const video = player?.querySelector('video');
    if (stale()) return;
    if (!player || !video) {
      // The navigation event has already fired but the player is not assembled
      // yet — wait for it ourselves, though not forever, or pages without a
      // video would loop endlessly.
      if (playerWaits++ < 5) scheduleRun('player-not-ready');
      return;
    }
    playerWaits = 0;

    renderer.attach(player, video);
    renderer.applySettings(settings);
    renderer.clear();

    DS.state.videoId = videoId;
    DS.state.busy = true;
    setStatus('Looking for subtitles…', 'work');
    DS.log('run', reason, videoId);

    const info = await DS.getCaptionInfo(videoId);
    if (stale()) return;

    if (!info || !info.tracks.length) {
      DS.state.info = null;
      DS.state.plan = null;
      DS.state.busy = false;
      setStatus('This video has no subtitles', 'error');
      return;
    }

    DS.state.info = info;
    const plan = buildPlan(info, settings);
    DS.state.plan = plan;
    emit();

    // --- first line ---
    let primaryCues = [];
    if (plan.primary.source === 'native') {
      setStatus('Loading subtitles…', 'work');
      const r = await DS.fetchCues(videoId, plan.primary.track);
      if (stale()) return;
      if (r.cues) primaryCues = r.cues;
      else {
        DS.state.busy = false;
        setStatus(fetchErrorText(r.error), 'error');
        return;
      }
    }

    // Sentences are needed either way: machine translation works on them, and
    // `sources` links each sentence back to the cues it was built from.
    const sentences = DS.mergeIntoSentences(primaryCues);

    // The display unit, shared by both lines. Nothing changes on screen until
    // the current unit ends, which is where the synchronisation comes from.
    // One cue at a time, as the video itself captions them. The sentences above
    // are still built: a translator needs whole ones to work with, and their
    // text is mapped back onto the cues it was made from.
    let units = primaryCues.map((c) => ({ ...c, sources: [c] }));
    let secondaryTexts = units.map(() => '');

    // --- second line ---
    const sec = plan.secondary;

    if (sec.source === 'native') {
      const r = await DS.fetchCues(videoId, sec.track);
      if (stale()) return;
      if (r.cues) {
        if (units.length) {
          // A separate track is an independent transcription: it is matched to
          // the first line by time, phrase by phrase rather than word by word.
          secondaryTexts = DS.alignByOverlap(units, r.cues);
        } else {
          // The first language has no track at all — the second one then sets
          // the timeline on its own.
          units = r.cues.map((c) => ({ start: c.start, end: c.end, text: '', sources: [c] }));
          secondaryTexts = r.cues.map((c) => c.text);
        }
      } else {
        sec.fallbackNote = fetchErrorText(r.error);
      }
    }

    if (sec.source === 'yt-translate') {
      setStatus(`Translating through YouTube -> ${DS.languageName(sec.lang)}…`, 'work');
      const r = await DS.fetchCues(videoId, sec.track, sec.tlang);
      if (stale()) return;
      if (r.cues) {
        secondaryTexts = DS.alignByStart(units, r.cues);
      } else {
        // YouTube's own translation sometimes answers 429 — fall back to
        // machine translation.
        DS.log('tlang failed, switching to machine translation', r.error);
        sec.source = 'machine';
        sec.from = plan.primary.lang;
        sec.fallbackNote = 'YouTube translation unavailable';
      }
    }

    if (sec.source === 'machine') {
      if (!primaryCues.length) {
        setStatus('Nothing to translate', 'error');
      } else {
        const payload = sentences.map((s) => s.text);

        setStatus(`Translating ${payload.length} phrases…`, 'work');
        const res = await translateTexts(
          videoId, payload, sec.from, sec.lang, settings,
          (done, total, provider) => {
            if (stale()) return;
            const label = provider ? ` (${PROVIDER_LABEL[provider] || provider})` : '';
            setStatus(`Translating${label}: ${done}/${total}…`, 'work');
          }
        );
        if (stale()) return;

        if (res.ok) {
          // Sentences are translated, but the display unit may be a single cue.
          // Indexing through the source cues covers both cases: with sentences
          // shown, one unit gets one translation; with raw cues shown, the
          // sentence translation stays on screen across all of its cues.
          const byCue = new Map();
          sentences.forEach((s, i) => {
            const translated = res.items[i] || '';
            for (const c of s.sources) byCue.set(c.start, translated);
          });
          secondaryTexts = units.map((u) => byCue.get(u.sources[0].start) || '');
          sec.provider = res.provider;
          sec.cached = res.cached;
        } else {
          sec.error = res.error;
        }
      }
    }

    if (stale()) return;

    // An empty translation keeps its segment: dropping it would shift every
    // segment after it and pull the two lines apart.
    const segments = units.map((u, i) => ({
      start: u.start,
      end: u.end,
      primary: u.text || '',
      secondary: secondaryTexts[i] || ''
    }));

    renderer.setSegments(segments);
    // YouTube's own subtitles always give way to ours -- two sets of captions
    // over the same frames is nobody's idea of readable.
    player.classList.toggle('ds-hide-native', segments.length > 0);

    DS.state.busy = false;
    setStatus(summaryText(plan, segments));
  }

  function fetchErrorText(error) {
    switch (error) {
      case 'rate-limit': return 'YouTube is rate limiting requests. Try again in a minute';
      case 'empty': return 'YouTube returned no subtitle text. Try reloading the page';
      case 'network': return 'No connection to YouTube';
      case 'no-url': return 'Could not get the subtitle URL';
      default: return 'Could not load the subtitles (' + error + ')';
    }
  }

  function summaryText(plan, segments) {
    const parts = [];
    const hasPrimary = segments.some((s) => s.primary);
    const hasSecondary = segments.some((s) => s.secondary);

    if (hasPrimary) parts.push(DS.languageName(plan.primary.lang));
    const sec = plan.secondary;
    if (hasSecondary) {
      let tag = DS.languageName(sec.lang);
      if (sec.source === 'yt-translate') tag += ' (YouTube translation)';
      else if (sec.source === 'machine') {
        tag += ` (${PROVIDER_LABEL[sec.provider] || 'translated'}${sec.cached ? ', cached' : ''})`;
      }
      parts.push(tag);
    }
    if (!parts.length) return sec.reason || sec.error || 'No subtitles found';
    let text = parts.join('  +  ');
    if (sec.error) text += ` -- second line unavailable: ${sec.error}`;
    else if (!hasSecondary && sec.reason) text += ` -- ${sec.reason}`;
    return text;
  }

  DS.rerun = (reason) => run(reason || 'manual');

  // -------------------------------- navigation --------------------------------

  const scheduleRun = DS.debounce((reason) => run(reason), 350);

  function watchNavigation() {
    let lastId = DS.videoIdFromUrl();

    // YouTube is an SPA: there is no normal page load between videos.
    document.addEventListener('yt-navigate-finish', () => {
      DS.clearCueCache();
      playerWaits = 0;
      scheduleRun('yt-navigate-finish');
    });
    document.addEventListener('yt-player-updated', () => scheduleRun('yt-player-updated'));

    // Safety net in case the event never arrives.
    setInterval(() => {
      const id = DS.videoIdFromUrl();
      if (id !== lastId) {
        lastId = id;
        DS.clearCueCache();
        playerWaits = 0;
        scheduleRun('url-poll');
      }
    }, 1000);
  }

  // ---------------------------- reacting to settings --------------------------

  const APPEARANCE_KEYS = new Set([
    'fontSize', 'lineGap', 'background',
    'primaryColor', 'secondaryColor', 'pauseOnHover',
    'captionX', 'captionY'
  ]);

  DS.onSettingsChange((settings, patch) => {
    const keys = Object.keys(patch);
    const onlyAppearance = keys.length > 0 && keys.every((k) => APPEARANCE_KEYS.has(k));
    if (onlyAppearance) {
      renderer.applySettings(settings);
      emit();
      return;
    }
    scheduleRun('settings');
  });

  // ----------------------------------- start ----------------------------------

  function boot() {
    watchNavigation();
    DS.initUi?.();
    run('boot');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
