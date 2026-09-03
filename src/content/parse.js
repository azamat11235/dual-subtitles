/**
 * Разбор формата json3 (то, что отдаёт /api/timedtext&fmt=json3) и
 * склейка обрывочных реплик в предложения.
 *
 * Структура json3 (проверена на живых данных YouTube):
 *   events: [
 *     { tStartMs, dDurationMs, wpWinPosId, segs: null }   // описание "окна", не текст
 *     { tStartMs, dDurationMs, wWinId, segs: [{utf8, tOffsetMs}, ...] }  // сама реплика
 *     { tStartMs, dDurationMs, wWinId, aAppend: 1, segs: [{utf8: "\n"}] } // служебный перевод строки
 *   ]
 * У авторубрик (kind=asr) события с aAppend=1 составляют ровно половину списка —
 * это артефакт "бегущей строки", их нужно выбрасывать. Длительности соседних
 * событий перекрываются, поэтому конец реплики подрезаем началом следующей.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  const MUSIC_RE = /^[\[(](музыка|music|аплодисменты|applause|смех|laughter|.{0,24})[\])]$/i;

  DS.parseJson3 = function parseJson3(data) {
    const events = (data && data.events) || [];
    const cues = [];

    for (const e of events) {
      if (!e.segs) continue;             // описание окна, не текст
      if (e.aAppend === 1) continue;     // служебный "\n" бегущей строки
      let text = e.segs.map((s) => s.utf8 || '').join('');
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const start = e.tStartMs || 0;
      const dur = e.dDurationMs || 0;
      cues.push({ start, end: start + dur, text });
    }

    cues.sort((a, b) => a.start - b.start);

    // Подрезаем перекрытия: реплика не должна жить дольше начала следующей.
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    }

    return cues.filter((c) => c.end > c.start);
  };

  /** Разбор старого XML-формата — запасной путь, если json3 недоступен. */
  DS.parseXml = function parseXml(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const nodes = [...doc.querySelectorAll('text')];
    const cues = nodes.map((n) => {
      const start = Math.round(parseFloat(n.getAttribute('start') || '0') * 1000);
      const dur = Math.round(parseFloat(n.getAttribute('dur') || '0') * 1000);
      const box = document.createElement('textarea');
      box.innerHTML = n.textContent || '';
      const text = box.value.replace(/\s+/g, ' ').trim();
      return { start, end: start + dur, text };
    }).filter((c) => c.text && c.end > c.start);
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    }
    return cues;
  };

  const SENTENCE_END = /[.!?…。！？]["'”»)\]]?$/;

  /**
   * Склеивает реплики в предложения. Нужно по двум причинам:
   *  1) машинный перевод обрывка ("which means I had to") даёт мусор,
   *     а перевод целого предложения — нормальный текст;
   *  2) читать вторую строку предложениями удобнее, чем обрывками.
   */
  DS.mergeIntoSentences = function mergeIntoSentences(cues, opts = {}) {
    // Пределы подобраны по живым данным: у авторубрик YouTube пунктуации нет
    // вовсе, поэтому знак конца предложения срабатывает редко и реальную длину
    // куска задают именно эти ограничения. 120 символов -- это примерно две
    // экранные строки на язык, то есть четыре на оба; больше уже закрывает кадр.
    const maxChars = opts.maxChars ?? 120;
    const maxMs = opts.maxMs ?? 7000;
    const gapMs = opts.gapMs ?? 1500;

    const out = [];
    let cur = null;
    const flush = () => { if (cur) { out.push(cur); cur = null; } };

    for (const c of cues) {
      if (!cur) {
        cur = { start: c.start, end: c.end, text: c.text, sources: [c] };
        continue;
      }
      const gap = c.start - cur.end;
      const nextLen = cur.text.length + 1 + c.text.length;
      const nextDur = c.end - cur.start;
      if (SENTENCE_END.test(cur.text) || gap > gapMs || nextLen > maxChars || nextDur > maxMs) {
        flush();
        cur = { start: c.start, end: c.end, text: c.text, sources: [c] };
      } else {
        cur.text += ' ' + c.text;
        cur.end = c.end;
        cur.sources.push(c);
      }
    }
    flush();
    return out;
  };

  /** Текст, который бессмысленно переводить ([Музыка], [Аплодисменты] и т.п.). */
  DS.isNoise = (text) => MUSIC_RE.test(text.trim());

  /** Поиск активной реплики. hint — индекс с прошлого кадра, чтобы не искать заново. */
  DS.findActive = function findActive(cues, timeMs, hint = 0) {
    if (!cues || !cues.length) return -1;

    // Быстрый путь: обычно активна та же реплика или следующая.
    for (let i = Math.max(0, hint); i < Math.min(cues.length, hint + 3); i++) {
      if (timeMs >= cues[i].start && timeMs < cues[i].end) return i;
    }

    let lo = 0, hi = cues.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= timeMs) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best >= 0 && timeMs < cues[best].end) return best;
    return -1;
  };
})();
