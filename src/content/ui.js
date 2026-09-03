/**
 * Кнопка в панели плеера и всплывающая панель настроек.
 *
 * Настройки живут прямо в плеере, а не только в попапе расширения: язык
 * второй строки часто хочется поменять именно на конкретном видео, не
 * отрывая взгляд от него.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  const ICON = `
    <svg viewBox="0 0 36 36" height="100%" width="100%" fill="none">
      <path fill="currentColor" d="M8 10h20a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h20a1 1 0 0 0 1-1V13a1 1 0 0 0-1-1H8Z"/>
      <rect x="9.5" y="15" width="17" height="2.3" rx="1.15" fill="currentColor"/>
      <rect x="9.5" y="19.4" width="11" height="2.3" rx="1.15" fill="#7fd1ff"/>
    </svg>`;

  let button = null;
  let panel = null;
  let form = null;

  // ------------------------------ список языков -------------------------------

  function trackLabel(t) {
    const name = t.displayName || DS.languageName(t.languageCode);
    return t.kind === 'asr' ? `${name} (автоматические)` : name;
  }

  function getLangOptions(role) {
    const info = DS.state.info;
    const tracks = info?.tracks || [];

    const head = role === 'primary'
      ? [{ value: 'auto', label: 'Язык видео' }]
      : [{ value: 'off', label: 'Выключен' }];

    if (!tracks.length) {
      return [
        ...head,
        { group: 'Языки', options: DS.COMMON_LANGS.map((c) => ({ value: c, label: DS.languageName(c) })) }
      ];
    }

    // Один язык может быть представлен ручной и автоматической дорожкой --
    // в списке он должен быть один раз.
    const seen = new Set();
    const available = [];
    for (const t of tracks) {
      if (seen.has(t.languageCode)) continue;
      seen.add(t.languageCode);
      available.push({ value: t.languageCode, label: trackLabel(t) });
    }

    const options = [...head, { group: 'Есть субтитры', options: available }];

    if (role === 'secondary') {
      const translation = (info.translationLanguages || [])
        .filter((l) => !seen.has(l.code))
        .map((l) => ({ value: l.code, label: l.name }));
      const pool = translation.length
        ? translation
        : DS.COMMON_LANGS.filter((c) => !seen.has(c)).map((c) => ({ value: c, label: DS.languageName(c) }));
      options.push({ group: 'Перевести на', options: pool });
    }

    return options;
  }

  // --------------------------------- панель -----------------------------------

  function buildPanel(player) {
    const p = document.createElement('div');
    p.className = 'ds-panel';
    p.hidden = true;

    const title = document.createElement('div');
    title.className = 'ds-panel__title';
    title.append('Двойные субтитры');
    const close = document.createElement('button');
    close.className = 'ds-panel__close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Закрыть';
    close.addEventListener('click', () => togglePanel(false));
    title.appendChild(close);
    p.appendChild(title);

    const master = document.createElement('label');
    master.className = 'ds-switch';
    const masterInput = document.createElement('input');
    masterInput.type = 'checkbox';
    master.appendChild(masterInput);
    master.appendChild(document.createTextNode('Включено (Alt+D)'));
    masterInput.addEventListener('change', () => DS.setSettings({ enabled: masterInput.checked }));
    const masterRow = document.createElement('div');
    masterRow.className = 'ds-row';
    masterRow.appendChild(master);
    p.appendChild(masterRow);
    p._masterInput = masterInput;

    const status = document.createElement('div');
    status.className = 'ds-status';
    p.appendChild(status);
    p._status = status;

    const body = document.createElement('div');
    p.appendChild(body);
    form = DS.buildSettingsForm(body, { getLangOptions });

    // Клики внутри панели не должны доходить до плеера (иначе пауза/перемотка).
    for (const ev of ['click', 'dblclick', 'mousedown', 'keydown', 'wheel']) {
      p.addEventListener(ev, (e) => e.stopPropagation());
    }

    player.appendChild(p);
    return p;
  }

  function togglePanel(show) {
    if (!panel) return;
    const next = show ?? panel.hidden;
    panel.hidden = !next;
    if (next) {
      form?.refresh();
      DS.getSettings().then((s) => { panel._masterInput.checked = s.enabled; });
      renderStatus();
      document.addEventListener('click', onDocClick, true);
    } else {
      document.removeEventListener('click', onDocClick, true);
    }
  }

  function onDocClick(e) {
    if (!panel || panel.hidden) return;
    if (panel.contains(e.target) || button?.contains(e.target)) return;
    togglePanel(false);
  }

  function renderStatus() {
    if (!panel) return;
    const { text, kind } = DS.state.status;
    panel._status.textContent = text || 'Готово';
    panel._status.className = 'ds-status' + (kind ? ` ds-status--${kind}` : '');
  }

  // --------------------------------- кнопка -----------------------------------

  function ensureButton() {
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return;
    if (button && controls.contains(button)) return;

    button = document.createElement('button');
    button.className = 'ytp-button ds-btn';
    button.type = 'button';
    button.title = 'Двойные субтитры';
    button.setAttribute('aria-label', 'Двойные субтитры');
    button.innerHTML = ICON + '<span class="ds-btn-underline"></span>';
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    const settingsBtn = controls.querySelector('.ytp-settings-button');
    controls.insertBefore(button, settingsBtn || controls.firstChild);

    const player = document.querySelector('#movie_player, .html5-video-player');
    if (player && (!panel || !player.contains(panel))) {
      panel?.remove();
      panel = buildPanel(player);
    }
    syncButton();
  }

  async function syncButton() {
    if (!button) return;
    const s = await DS.getSettings();
    const hasText = !!(DS.renderer?.cues.primary.length || DS.renderer?.cues.secondary.length);
    button.classList.toggle('ds-btn--active', s.enabled && hasText);
    button.classList.toggle('ds-btn--busy', !!DS.state.busy);
  }

  // ---------------------------------- старт -----------------------------------

  DS.initUi = function initUi() {
    ensureButton();

    // Панель управления YouTube пересобирается при смене видео и в полноэкранном
    // режиме -- следим и возвращаем кнопку на место. Наблюдатель дешёвый:
    // реальная работа спрятана за debounce.
    const recheck = DS.debounce(() => ensureButton(), 200);
    new MutationObserver(recheck).observe(document.documentElement, { childList: true, subtree: true });

    // Форму перерисовываем только когда сменился набор дорожек: делать это на
    // каждое обновление статуса значило бы сбрасывать выпадающий список прямо
    // под курсором пользователя.
    let lastTracksKey = null;
    DS.onStateChange((state) => {
      renderStatus();
      syncButton();
      const key = state.videoId + '|' + (state.info?.tracks.map(DS.trackKey).join(',') || '');
      if (key !== lastTracksKey) {
        lastTracksKey = key;
        if (panel && !panel.hidden) form?.refresh();
      }
    });
    DS.onSettingsChange(() => syncButton());
  };
})();
