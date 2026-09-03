/**
 * Оркестратор: следит за навигацией, выбирает дорожки под два языка,
 * достаёт субтитры и, если нужного языка нет, добывает перевод.
 *
 * Логика выбора второго языка (самое интересное место):
 *   1. Готовая дорожка нужного языка (ручная лучше автоматической).
 *   2. Автоперевод YouTube: тот же запрос с параметром tlang. Бесплатно,
 *      один запрос на всё видео, тайминги совпадают с оригиналом.
 *   3. Машинный перевод в фоновом воркере (Google / DeepL / MyMemory).
 *      Реплики предварительно склеиваются в предложения: перевод обрывка
 *      вроде "which means I had to" даёт мусор, перевод предложения -- нет.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  const renderer = new DS.Renderer();
  DS.renderer = renderer;

  /** Публичное состояние -- его читает панель настроек. */
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

  // ------------------------------ выбор дорожек -------------------------------

  const baseLang = (code) => String(code || '').split('-')[0].toLowerCase();

  function pickTrack(tracks, lang, defaultAudioLanguage) {
    if (!tracks?.length) return null;

    if (!lang || lang === 'auto') {
      // "Язык видео": сначала дорожка языка озвучки, иначе первая ручная.
      const byAudio = defaultAudioLanguage &&
        tracks.find((t) => baseLang(t.languageCode) === baseLang(defaultAudioLanguage));
      return byAudio || tracks.find((t) => !t.kind) || tracks[0];
    }

    const exact = tracks.filter((t) => t.languageCode.toLowerCase() === lang.toLowerCase());
    const loose = tracks.filter((t) => baseLang(t.languageCode) === baseLang(lang));
    const pool = exact.length ? exact : loose;
    if (!pool.length) return null;
    // Ручная дорожка всегда лучше распознанной автоматически.
    return pool.find((t) => !t.kind) || pool[0];
  }

  /**
   * Решает, откуда взять текст для каждой строки.
   * @returns {{primary:Object, secondary:Object}}
   */
  function buildPlan(info, settings) {
    const { tracks, translationLanguages, defaultAudioLanguage } = info;

    const primaryTrack = pickTrack(tracks, settings.primaryLang, defaultAudioLanguage);
    const primary = primaryTrack
      ? { source: 'native', track: primaryTrack, lang: primaryTrack.languageCode }
      : { source: 'none', reason: 'нет дорожки для первого языка' };

    const wanted = settings.secondaryLang;
    let secondary;

    if (!wanted || wanted === 'off') {
      secondary = { source: 'none', reason: 'второй язык выключен' };
    } else {
      const nativeSecond = pickTrack(tracks, wanted, null);
      const sameAsPrimary = nativeSecond && primaryTrack &&
        DS.trackKey(nativeSecond) === DS.trackKey(primaryTrack);

      if (nativeSecond && !sameAsPrimary) {
        secondary = { source: 'native', track: nativeSecond, lang: nativeSecond.languageCode };
      } else if (sameAsPrimary) {
        secondary = { source: 'none', reason: 'видео уже на этом языке' };
      } else if (!settings.allowTranslation) {
        secondary = { source: 'none', reason: `нет субтитров на «${DS.languageName(wanted)}»` };
      } else if (!primaryTrack) {
        secondary = { source: 'none', reason: 'нечего переводить -- у видео нет субтитров' };
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

  // -------------------------------- перевод -----------------------------------

  function translateTexts(videoId, texts, from, to, settings, onProgress) {
    return new Promise((resolve) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: 'ds-translate' });
      } catch (e) {
        resolve({ ok: false, error: 'расширение перезагружено, обновите страницу' });
        return;
      }
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

      port.onMessage.addListener((m) => {
        if (m.type === 'progress') onProgress(m.done, m.total);
        else if (m.type === 'provider') onProgress(0, texts.length, m.provider);
        else if (m.type === 'result') { finish(m); try { port.disconnect(); } catch { /* уже закрыт */ } }
      });
      port.onDisconnect.addListener(() => finish({ ok: false, error: 'соединение с воркером прервано' }));

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

  // ------------------------------- основной цикл ------------------------------

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
      setStatus(settings.enabled ? '' : 'Выключено');
      return;
    }

    const player = await DS.waitFor('#movie_player, .html5-video-player');
    const video = player?.querySelector('video');
    if (stale()) return;
    if (!player || !video) {
      // Событие навигации уже отгремело, а плеер ещё не собрался -- ждём его
      // сами, но не бесконечно, иначе на страницах без видео будет вечный цикл.
      if (playerWaits++ < 5) scheduleRun('player-not-ready');
      return;
    }
    playerWaits = 0;

    renderer.attach(player, video);
    renderer.applySettings(settings);
    renderer.clear();

    DS.state.videoId = videoId;
    DS.state.busy = true;
    setStatus('Ищу субтитры…', 'work');
    DS.log('run', reason, videoId);

    const info = await DS.getCaptionInfo(videoId);
    if (stale()) return;

    if (!info || !info.tracks.length) {
      DS.state.info = null;
      DS.state.plan = null;
      DS.state.busy = false;
      setStatus('У этого видео нет субтитров', 'error');
      return;
    }

    DS.state.info = info;
    const plan = buildPlan(info, settings);
    DS.state.plan = plan;
    emit();

    // --- первая строка ---
    let primaryCues = [];
    if (plan.primary.source === 'native') {
      setStatus('Загружаю субтитры…', 'work');
      const r = await DS.fetchCues(videoId, plan.primary.track);
      if (stale()) return;
      if (r.cues) primaryCues = r.cues;
      else {
        DS.state.busy = false;
        setStatus(fetchErrorText(r.error), 'error');
        return;
      }
    }

    let primaryDisplay = primaryCues;
    let secondaryDisplay = [];

    // --- вторая строка ---
    const sec = plan.secondary;

    if (sec.source === 'native') {
      const r = await DS.fetchCues(videoId, sec.track);
      if (stale()) return;
      if (r.cues) secondaryDisplay = r.cues;
      else sec.fallbackNote = fetchErrorText(r.error);
    }

    if (sec.source === 'yt-translate') {
      setStatus(`Перевожу через YouTube -> ${DS.languageName(sec.lang)}…`, 'work');
      const r = await DS.fetchCues(videoId, sec.track, sec.tlang);
      if (stale()) return;
      if (r.cues) {
        secondaryDisplay = r.cues;
      } else {
        // Автоперевод YouTube иногда отдаёт 429 -- уходим на машинный перевод.
        DS.log('tlang не сработал, переключаюсь на машинный перевод', r.error);
        sec.source = 'machine';
        sec.from = plan.primary.lang;
        sec.fallbackNote = 'автоперевод YouTube недоступен';
      }
    }

    if (sec.source === 'machine') {
      if (!primaryCues.length) {
        setStatus('Нечего переводить', 'error');
      } else {
        const segments = DS.mergeIntoSentences(primaryCues);
        const payload = segments.map((s) => s.text);

        setStatus(`Перевожу ${payload.length} фраз…`, 'work');
        const res = await translateTexts(
          videoId, payload, sec.from, sec.lang, settings,
          (done, total, provider) => {
            if (stale()) return;
            const label = provider ? ` (${PROVIDER_LABEL[provider] || provider})` : '';
            setStatus(`Перевожу${label}: ${done}/${total}…`, 'work');
          }
        );
        if (stale()) return;

        if (res.ok) {
          secondaryDisplay = segments.map((s, i) => ({
            start: s.start,
            end: s.end,
            text: res.items[i] || ''
          })).filter((c) => c.text);
          sec.provider = res.provider;
          sec.cached = res.cached;
          // Обе строки идут предложениями -- читать заметно удобнее.
          if (settings.groupBySentence) primaryDisplay = segments;
        } else {
          sec.error = res.error;
        }
      }
    }

    if (stale()) return;

    renderer.setCues('primary', primaryDisplay);
    renderer.setCues('secondary', secondaryDisplay);
    player.classList.toggle(
      'ds-hide-native',
      settings.hideNative && (primaryDisplay.length > 0 || secondaryDisplay.length > 0)
    );

    DS.state.busy = false;
    setStatus(summaryText(plan, primaryDisplay, secondaryDisplay));
  }

  function fetchErrorText(error) {
    switch (error) {
      case 'rate-limit': return 'YouTube временно ограничил запросы. Попробуйте через минуту';
      case 'empty': return 'YouTube не отдал текст субтитров. Попробуйте перезагрузить страницу';
      case 'network': return 'Нет связи с YouTube';
      case 'no-url': return 'Не удалось получить ссылку на субтитры';
      default: return 'Не удалось загрузить субтитры (' + error + ')';
    }
  }

  function summaryText(plan, primaryCues, secondaryCues) {
    const parts = [];
    if (primaryCues.length) parts.push(DS.languageName(plan.primary.lang));
    const sec = plan.secondary;
    if (secondaryCues.length) {
      let tag = DS.languageName(sec.lang);
      if (sec.source === 'yt-translate') tag += ' (автоперевод YouTube)';
      else if (sec.source === 'machine') {
        tag += ` (${PROVIDER_LABEL[sec.provider] || 'перевод'}${sec.cached ? ', из кэша' : ''})`;
      }
      parts.push(tag);
    }
    if (!parts.length) return sec.reason || sec.error || 'Субтитры не найдены';
    let text = parts.join('  +  ');
    if (sec.error) text += ` -- вторая строка недоступна: ${sec.error}`;
    else if (!secondaryCues.length && sec.reason) text += ` -- ${sec.reason}`;
    return text;
  }

  DS.rerun = (reason) => run(reason || 'manual');

  // ------------------------------- навигация ----------------------------------

  const scheduleRun = DS.debounce((reason) => run(reason), 350);

  function watchNavigation() {
    let lastId = DS.videoIdFromUrl();

    // YouTube -- SPA: обычной перезагрузки страницы между видео не происходит.
    document.addEventListener('yt-navigate-finish', () => {
      DS.clearCueCache();
      playerWaits = 0;
      scheduleRun('yt-navigate-finish');
    });
    document.addEventListener('yt-player-updated', () => scheduleRun('yt-player-updated'));

    // Страховка на случай, если событие не пришло.
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

  // ------------------------------- реакция на настройки -----------------------

  const APPEARANCE_KEYS = new Set([
    'fontSize', 'lineGap', 'bottomOffset', 'background',
    'primaryColor', 'secondaryColor', 'swapOrder', 'pauseOnHover'
  ]);

  DS.onSettingsChange((settings, patch) => {
    const keys = Object.keys(patch);
    const onlyAppearance = keys.length > 0 && keys.every((k) => APPEARANCE_KEYS.has(k));
    if (onlyAppearance) {
      renderer.applySettings(settings);
      emit();
      return;
    }
    if ('hideNative' in patch) {
      document.querySelector('.html5-video-player')
        ?.classList.toggle('ds-hide-native', !!settings.hideNative);
    }
    scheduleRun('settings');
  });

  // --------------------------------- старт ------------------------------------

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
