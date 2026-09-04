/**
 * The button in the player controls and the pop-out settings panel.
 *
 * The settings live inside the player, not only in the extension popup: the
 * language of the second line is often something you want to change on this
 * particular video, without looking away from it.
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

  // -------------------------------- language list -----------------------------

  function trackLabel(t) {
    const name = t.displayName || DS.languageName(t.languageCode);
    return t.kind === 'asr' ? `${name} (automatic)` : name;
  }

  function getLangOptions(role) {
    const info = DS.state.info;
    const tracks = info?.tracks || [];

    const head = role === 'primary'
      ? [{ value: 'auto', label: 'Video language' }]
      : [{ value: 'off', label: 'Off' }];

    if (!tracks.length) {
      return [
        ...head,
        { group: 'Languages', options: DS.COMMON_LANGS.map((c) => ({ value: c, label: DS.languageName(c) })) }
      ];
    }

    // One language can come as both a manual and an automatic track — it should
    // appear in the list only once.
    const seen = new Set();
    const available = [];
    for (const t of tracks) {
      if (seen.has(t.languageCode)) continue;
      seen.add(t.languageCode);
      available.push({ value: t.languageCode, label: trackLabel(t) });
    }

    const options = [...head, { group: 'Subtitles available', options: available }];

    if (role === 'secondary') {
      const translation = (info.translationLanguages || [])
        .filter((l) => !seen.has(l.code))
        .map((l) => ({ value: l.code, label: l.name }));
      const pool = translation.length
        ? translation
        : DS.COMMON_LANGS.filter((c) => !seen.has(c)).map((c) => ({ value: c, label: DS.languageName(c) }));
      options.push({ group: 'Translate into', options: pool });
    }

    return options;
  }

  // ------------------------------------ panel ---------------------------------

  function buildPanel(player) {
    const p = document.createElement('div');
    p.className = 'ds-panel';
    p.hidden = true;

    const title = document.createElement('div');
    title.className = 'ds-panel__title';
    title.append('Dual subtitles');
    const close = document.createElement('button');
    close.className = 'ds-panel__close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Close';
    close.addEventListener('click', () => togglePanel(false));
    title.appendChild(close);
    p.appendChild(title);

    const master = document.createElement('label');
    master.className = 'ds-switch';
    const masterInput = document.createElement('input');
    masterInput.type = 'checkbox';
    master.appendChild(masterInput);
    master.appendChild(document.createTextNode('Enabled (Alt+D)'));
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

    // Clicks inside the panel must not reach the player (or it would pause/seek).
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
    panel._status.textContent = text || 'Ready';
    panel._status.className = 'ds-status' + (kind ? ` ds-status--${kind}` : '');
  }

  // ----------------------------------- button ---------------------------------

  function ensureButton() {
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return;
    if (button && controls.contains(button)) return;

    button = document.createElement('button');
    button.className = 'ytp-button ds-btn';
    button.type = 'button';
    button.title = 'Dual subtitles';
    button.setAttribute('aria-label', 'Dual subtitles');
    button.innerHTML = ICON + '<span class="ds-btn-underline"></span>';
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    // querySelector reaches any descendant, but insertBefore only accepts a
    // direct child of `controls` — and on some player layouts YouTube wraps the
    // right-hand buttons in a container. Walk back up to the child that holds
    // the settings button; a bare settingsBtn would throw NotFoundError there.
    let anchor = controls.querySelector('.ytp-settings-button');
    while (anchor && anchor.parentNode !== controls) anchor = anchor.parentNode;
    controls.insertBefore(button, anchor || controls.firstChild);

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
    const hasText = !!DS.renderer?.segments.length;
    button.classList.toggle('ds-btn--active', s.enabled && hasText);
    button.classList.toggle('ds-btn--busy', !!DS.state.busy);
  }

  // ------------------------------------ start ---------------------------------

  DS.initUi = function initUi() {
    ensureButton();

    // YouTube rebuilds its control bar when the video changes and in fullscreen —
    // watch for that and put the button back. The observer is cheap: the real
    // work is hidden behind a debounce.
    const recheck = DS.debounce(() => ensureButton(), 200);
    new MutationObserver(recheck).observe(document.documentElement, { childList: true, subtree: true });

    // The form is only rebuilt when the set of tracks changed: doing it on every
    // status update would reset a dropdown right under the user's cursor.
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
