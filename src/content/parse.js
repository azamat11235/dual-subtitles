/**
 * Parsing the json3 format (what /api/timedtext&fmt=json3 returns) and merging
 * broken-up cues into sentences.
 *
 * Shape of json3 (verified against live YouTube data):
 *   events: [
 *     { tStartMs, dDurationMs, wpWinPosId, segs: null }   // a "window", not text
 *     { tStartMs, dDurationMs, wWinId, segs: [{utf8, tOffsetMs}, ...] }  // the cue itself
 *     { tStartMs, dDurationMs, wWinId, aAppend: 1, segs: [{utf8: "\n"}] } // service line break
 *   ]
 * On automatic tracks (kind=asr) the aAppend events make up exactly half of the
 * list — an artefact of the rolling caption, and they have to go. Neighbouring
 * events overlap in duration, so a cue is trimmed at the start of the next one.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  const MUSIC_RE = /^[\[(](музыка|music|аплодисменты|applause|смех|laughter|.{0,24})[\])]$/i;

  DS.parseJson3 = function parseJson3(data) {
    const events = (data && data.events) || [];
    const cues = [];

    for (const e of events) {
      if (!e.segs) continue;             // a window description, not text
      if (e.aAppend === 1) continue;     // service "\n" of the rolling caption
      let text = e.segs.map((s) => s.utf8 || '').join('');
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const start = e.tStartMs || 0;
      const dur = e.dDurationMs || 0;
      cues.push({ start, end: start + dur, text });
    }

    cues.sort((a, b) => a.start - b.start);

    // Trim the overlaps: a cue must not outlive the start of the next one.
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    }

    return cues.filter((c) => c.end > c.start);
  };

  /** Parsing the old XML format — the fallback when json3 is unavailable. */
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
   * Merges cues into sentences. Needed for two reasons:
   *  1) machine-translating a fragment ("which means I had to") gives nonsense,
   *     while translating a whole sentence gives usable text;
   *  2) a second line made of sentences is easier to read than one made of
   *     fragments.
   *
   * Each result keeps `sources` — the cues it was built from. That is what lets
   * a translation be mapped back onto the original timing.
   */
  DS.mergeIntoSentences = function mergeIntoSentences(cues, opts = {}) {
    // The limits come from live data: automatic YouTube tracks have no
    // punctuation at all, so the end-of-sentence test rarely fires and these
    // limits are what actually decides the length. 120 characters is roughly two
    // screen lines per language, four for both; more than that covers the frame.
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

  /** Text there is no point translating ([Music], [Applause] and the like). */
  DS.isNoise = (text) => MUSIC_RE.test(text.trim());

  /** Finds the active cue. `hint` is last frame's index, to avoid a fresh search. */
  DS.findActive = function findActive(cues, timeMs, hint = 0) {
    if (!cues || !cues.length) return -1;

    // Fast path: usually the active cue is the same one or the next one.
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
