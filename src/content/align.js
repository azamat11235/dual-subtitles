/**
 * Mapping a second-language cue list onto the timeline of the first one.
 *
 * Both lines are driven by a single list of segments, so the only question left
 * is what text the second line should carry inside each segment. Two answers,
 * depending on where that text came from:
 *
 *   alignByStart   — YouTube's own `tlang` translation. It reuses the timings of
 *                    the source track, so cues match exactly by start time.
 *   alignByOverlap — a separate track in another language. It is an independent
 *                    transcription with its own cue boundaries, so the best we
 *                    can do is match by time overlap.
 *
 * Neither ever drops a segment: a segment with no match keeps an empty string,
 * which hides the second line for its duration instead of shifting everything
 * that follows.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  /**
   * Joins the pieces that fell into one segment, dropping repeats. A long cue
   * spanning several segments is deliberately shown in each of them, and the
   * repeat check keeps that from turning into "text text" inside one segment.
   */
  function joinParts(parts) {
    const out = [];
    for (const p of parts) {
      const t = (p || '').trim();
      if (t && t !== out[out.length - 1]) out.push(t);
    }
    return out.join(' ');
  }

  const sourcesOf = (unit) => unit.sources || [unit];

  /**
   * Overlap-based alignment. A cue lands in every segment it shares a
   * meaningful part of its life with — "meaningful" being measured against the
   * shorter of the two, so that both a short cue inside a long segment and a
   * long cue covering several segments count as a match.
   *
   * A cue that clears the bar nowhere still has a home: the segment it overlaps
   * most. That fills a segment which would otherwise sit blank, without letting
   * a cue that merely grazes one segment show up in it while it really belongs
   * to the next.
   *
   * @param {Array<{start:number,end:number}>} units    segments, sorted by start
   * @param {Array<{start:number,end:number,text:string}>} cues sorted by start
   * @returns {string[]} one string per segment
   */
  DS.alignByOverlap = function alignByOverlap(units, cues, opts = {}) {
    const minRatio = opts.minRatio ?? 0.35;
    if (!units.length || !cues?.length) return units.map(() => '');

    const parts = units.map(() => []);
    const home = new Array(cues.length).fill(-1);
    const homeOverlap = new Array(cues.length).fill(0);

    // Both lists are sorted, so the scan window only ever moves forward.
    let from = 0;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      while (from < cues.length && cues[from].end <= u.start) from++;

      for (let k = from; k < cues.length && cues[k].start < u.end; k++) {
        const overlap = Math.min(u.end, cues[k].end) - Math.max(u.start, cues[k].start);
        if (overlap <= 0) continue;
        const shorter = Math.max(1, Math.min(u.end - u.start, cues[k].end - cues[k].start));
        if (overlap / shorter >= minRatio) parts[i].push(cues[k].text);
        if (overlap > homeOverlap[k]) { homeOverlap[k] = overlap; home[k] = i; }
      }
    }

    // Segments still blank take the cue that calls them home, if there is one.
    for (let k = 0; k < cues.length; k++) {
      const i = home[k];
      if (i >= 0 && !parts[i].length) parts[i].push(cues[k].text);
    }

    return parts.map(joinParts);
  };

  /**
   * Exact alignment by start time, for translations that kept the original
   * timings. Segments built from several source cues collect the translation of
   * each of them.
   *
   * Matching by index instead would look simpler and be wrong: YouTube drops the
   * odd cue from a translated track (an empty translation, a `[Music]` line),
   * and from that point on every following index is off by one.
   *
   * @param {Array<{start:number,end:number,sources?:Array}>} units
   * @param {Array<{start:number,end:number,text:string}>} cues
   * @returns {string[]} one string per segment
   */
  DS.alignByStart = function alignByStart(units, cues) {
    if (!units.length || !cues?.length) return units.map(() => '');

    const byStart = new Map();
    for (const c of cues) byStart.set(c.start, c.text);

    const out = units.map((u) => joinParts(sourcesOf(u).map((c) => byStart.get(c.start))));
    const matched = out.filter(Boolean).length;

    // Timings did not line up at all — the translated track was re-segmented,
    // so fall back to overlap for the whole thing.
    if (matched < units.length * 0.5) return DS.alignByOverlap(units, cues);

    // Mostly lined up: patch the individual gaps.
    if (matched < units.length) {
      const fallback = DS.alignByOverlap(units, cues);
      return out.map((t, i) => t || fallback[i]);
    }
    return out;
  };
})();
