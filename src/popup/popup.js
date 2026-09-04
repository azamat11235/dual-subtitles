/** Extension popup: the same settings as the in-player panel, but global. */
(async () => {
  const enabled = document.getElementById('enabled');
  const cacheInfo = document.getElementById('cacheInfo');

  const settings = await DS.getSettings();
  enabled.checked = settings.enabled;
  enabled.addEventListener('change', () => DS.setSettings({ enabled: enabled.checked }));
  DS.onSettingsChange((s) => { enabled.checked = s.enabled; });

  // Same label as the panel inside the player, down to the actual binding.
  DS.getShortcut().then((shortcut) => {
    const label = DS.shortcutLabel(shortcut);
    if (label) document.getElementById('enabledLabel').textContent = `Enabled (${label})`;
  });

  // The popup has no access to a particular video's track list -- show the
  // common set of languages instead.
  const langOptions = (role) => {
    const head = role === 'primary'
      ? [{ value: 'auto', label: 'Video language' }]
      : [{ value: 'off', label: 'Off' }];
    return [
      ...head,
      {
        group: 'Languages',
        options: DS.COMMON_LANGS.map((c) => ({ value: c, label: DS.languageName(c) }))
      }
    ];
  };

  const form = DS.buildSettingsForm(document.getElementById('form'), { getLangOptions: langOptions });
  // Everything rides inside the list view, so the whole popup slides away when a
  // submenu opens, exactly as the in-player panel does.
  const masterIcon = DS.rowIcon('enabled');
  if (masterIcon) document.getElementById('enabledRow').prepend(masterIcon);
  form.listView.prepend(...document.querySelectorAll('body > .ds-panel__title, body > .ds-row, body > .hint'));
  form.listView.append(document.querySelector('body > .foot'));
  await form.refresh();

  function showCacheStats() {
    chrome.runtime.sendMessage({ type: 'cacheStats' }, (r) => {
      if (chrome.runtime.lastError || !r?.ok) return;
      cacheInfo.textContent = r.entries ? `${r.entries} videos cached` : 'cache is empty';
    });
  }
  showCacheStats();

  document.getElementById('clearCache').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'clearCache' }, () => {
      if (chrome.runtime.lastError) return;
      showCacheStats();
    });
  });
})();
