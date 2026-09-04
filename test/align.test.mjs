/**
 * Tests for mapping the second language onto the timeline of the first.
 *
 * The invariant every test here defends: alignment returns exactly one string
 * per segment. That is what makes the two lines switch together — the renderer
 * reads both of them out of one object, so it cannot mix up the pairing.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from './harness.mjs';

const window = {};
for (const file of ['../src/content/parse.js', '../src/content/align.js']) {
  const code = readFileSync(new URL(file, import.meta.url), 'utf8');
  new Function('window', code)(window);
}
const DS = window.DS;

const mk = (start, end, text) => ({ start, end, text });
const unit = (start, end, text, sources) => ({ start, end, text, sources: sources || [mk(start, end, text)] });

// --- alignByStart: YouTube's own translation keeps the original timings ------

test('alignByStart matches cue for cue when the timings coincide', () => {
  const units = [unit(0, 1000, 'one'), unit(1000, 2000, 'two')];
  const translated = [mk(0, 1000, 'uno'), mk(1000, 2000, 'dos')];
  assert.deepEqual(DS.alignByStart(units, translated), ['uno', 'dos']);
});

test('alignByStart collects every source cue of a sentence', () => {
  const cues = [mk(0, 1000, 'I went'), mk(1000, 2000, 'to college.')];
  const units = DS.mergeIntoSentences(cues);
  const translated = [mk(0, 1000, 'Fui a la'), mk(1000, 2000, 'universidad.')];
  assert.equal(units.length, 1);
  assert.deepEqual(DS.alignByStart(units, translated), ['Fui a la universidad.']);
});

test('alignByStart does not shift when the translation is missing a cue', () => {
  // The regression this guards: matching by index would put "tres" on cue two
  // and stay off by one until the end of the video.
  const units = [unit(0, 1000, 'one'), unit(1000, 2000, '[Music]'), unit(2000, 3000, 'three')];
  const translated = [mk(0, 1000, 'uno'), mk(2000, 3000, 'tres')];
  assert.deepEqual(DS.alignByStart(units, translated), ['uno', '', 'tres']);
});

test('alignByStart falls back to overlap when the track was re-segmented', () => {
  // Not one start time in common — index or start matching is useless here.
  const units = [unit(0, 2000, 'one two'), unit(2000, 4000, 'three four')];
  const translated = [mk(100, 1900, 'uno dos'), mk(2100, 3900, 'tres cuatro')];
  assert.deepEqual(DS.alignByStart(units, translated), ['uno dos', 'tres cuatro']);
});

// --- alignByOverlap: a separate track in another language -------------------

test('alignByOverlap returns exactly one string per segment', () => {
  const units = [unit(0, 1000, 'a'), unit(1000, 2000, 'b'), unit(2000, 3000, 'c')];
  const foreign = [mk(500, 2500, 'sprawling line')];
  const out = DS.alignByOverlap(units, foreign);
  assert.equal(out.length, units.length);
  assert.ok(out.every((s) => typeof s === 'string'));
});

test('alignByOverlap places a cue in every segment it covers', () => {
  // A long foreign cue spans two segments: it is shown across both rather than
  // leaving one of them blank.
  const units = [unit(0, 1000, 'a'), unit(1000, 2000, 'b')];
  const foreign = [mk(0, 2000, 'una linea larga')];
  assert.deepEqual(DS.alignByOverlap(units, foreign), ['una linea larga', 'una linea larga']);
});

test('alignByOverlap joins several cues that fall inside one segment', () => {
  const units = [unit(0, 4000, 'a long sentence')];
  const foreign = [mk(0, 2000, 'primera mitad'), mk(2000, 4000, 'segunda mitad')];
  assert.deepEqual(DS.alignByOverlap(units, foreign), ['primera mitad segunda mitad']);
});

test('alignByOverlap does not repeat the same text inside one segment', () => {
  const units = [unit(0, 4000, 'a')];
  const foreign = [mk(0, 2000, 'repetido'), mk(2000, 4000, 'repetido')];
  assert.deepEqual(DS.alignByOverlap(units, foreign), ['repetido']);
});

test('alignByOverlap ignores a barely touching neighbour', () => {
  const units = [unit(0, 5000, 'a'), unit(5000, 10000, 'b')];
  const foreign = [mk(4900, 9900, 'segunda linea')];
  const out = DS.alignByOverlap(units, foreign);
  assert.equal(out[1], 'segunda linea');
  // 100 ms out of 5000 is noise, not a match.
  assert.equal(out[0], '');
});

test('alignByOverlap falls back to the closest cue rather than a blank', () => {
  // Nothing clears the ratio bar, but one cue does overlap: better that than a
  // second line that blinks out mid-phrase.
  const units = [unit(0, 10000, 'a very long segment')];
  const foreign = [mk(9000, 12000, 'final de la frase')];
  assert.deepEqual(DS.alignByOverlap(units, foreign), ['final de la frase']);
});

test('alignByOverlap leaves a segment empty when nothing overlaps it', () => {
  const units = [unit(0, 1000, 'a'), unit(5000, 6000, 'b')];
  const foreign = [mk(5000, 6000, 'solo la segunda')];
  assert.deepEqual(DS.alignByOverlap(units, foreign), ['', 'solo la segunda']);
});

test('alignByOverlap keeps the segment count on empty input', () => {
  const units = [unit(0, 1000, 'a'), unit(1000, 2000, 'b')];
  assert.deepEqual(DS.alignByOverlap(units, []), ['', '']);
  assert.deepEqual(DS.alignByOverlap(units, null), ['', '']);
  assert.deepEqual(DS.alignByOverlap([], [mk(0, 1000, 'x')]), []);
});

test('alignByOverlap scans a long track in order', () => {
  // Both lists are walked with one moving window; this checks that the window
  // never runs ahead of a cue that a later segment still needs.
  const units = Array.from({ length: 200 }, (_, i) => unit(i * 1000, i * 1000 + 1000, 'u' + i));
  const foreign = Array.from({ length: 200 }, (_, i) => mk(i * 1000, i * 1000 + 1000, 'f' + i));
  const out = DS.alignByOverlap(units, foreign);
  assert.deepEqual(out, foreign.map((c) => c.text));
});
