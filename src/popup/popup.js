/** Попап расширения: те же настройки, что и в панели плеера, но глобальные. */
(async () => {
  const enabled = document.getElementById('enabled');
  const cacheInfo = document.getElementById('cacheInfo');

  const settings = await DS.getSettings();
  enabled.checked = settings.enabled;
  enabled.addEventListener('change', () => DS.setSettings({ enabled: enabled.checked }));
  DS.onSettingsChange((s) => { enabled.checked = s.enabled; });

  // В попапе список дорожек конкретного видео недоступен -- показываем
  // общий список языков.
  const langOptions = (role) => {
    const head = role === 'primary'
      ? [{ value: 'auto', label: 'Язык видео' }]
      : [{ value: 'off', label: 'Выключен' }];
    return [
      ...head,
      {
        group: 'Языки',
        options: DS.COMMON_LANGS.map((c) => ({ value: c, label: DS.languageName(c) }))
      }
    ];
  };

  const form = DS.buildSettingsForm(document.getElementById('form'), { getLangOptions: langOptions });
  await form.refresh();

  function showCacheStats() {
    chrome.runtime.sendMessage({ type: 'cacheStats' }, (r) => {
      if (chrome.runtime.lastError || !r?.ok) return;
      cacheInfo.textContent = r.entries ? `${r.entries} видео в кэше` : 'кэш пуст';
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
