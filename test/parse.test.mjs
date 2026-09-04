/**
 * Tests for json3 parsing and sentence merging.
 * The fixtures mirror the shape of a real /api/timedtext response.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from './harness.mjs';

// parse.js is a plain content script, not a module. It is executed in the
// current realm (rather than through node:vm), or the arrays it creates would
// carry a foreign prototype and assert.deepEqual would reject values that match
// structurally.
const code = readFileSync(new URL('../src/content/parse.js', import.meta.url), 'utf8');
const window = {};
new Function('window', code)(window);
const DS = window.DS;

// The shape of a real kind=asr response: a "window" event without segs, the real
// cues, and the service aAppend events carrying a single line break.
const ASR_FIXTURE = {
  events: [
    { tStartMs: 0, dDurationMs: 843279, wpWinPosId: 1 },
    { tStartMs: 12559, dDurationMs: 4480, wWinId: 1, segs: [{ utf8: 'so' }, { utf8: ' in', tOffsetMs: 200 }] },
    { tStartMs: 14350, dDurationMs: 2689, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 14360, dDurationMs: 5280, wWinId: 1, segs: [{ utf8: 'college' }, { utf8: ' I', tOffsetMs: 1000 }] },
    { tStartMs: 17029, dDurationMs: 2611, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 19640, dDurationMs: 3000, wWinId: 1, segs: [{ utf8: '  was a  major\n' }] }
  ]
};

test('parseJson3 skips window events and service aAppend ones', () => {
  const cues = DS.parseJson3(ASR_FIXTURE);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map((c) => c.text), ['so in', 'college I', 'was a major']);
});

test('parseJson3 trims overlapping durations', () => {
  const cues = DS.parseJson3(ASR_FIXTURE);
  // 12559 + 4480 = 17039, but the next cue starts at 14360
  assert.equal(cues[0].end, 14360);
  assert.equal(cues[1].end, 19640);
  // nothing limits the last cue
  assert.equal(cues[2].end, 22640);
});

test('parseJson3 survives an empty response', () => {
  assert.deepEqual(DS.parseJson3({}), []);
  assert.deepEqual(DS.parseJson3({ events: [] }), []);
  assert.deepEqual(DS.parseJson3({ events: [{ tStartMs: 0, segs: [{ utf8: '  ' }] }] }), []);
});

test('parseJson3 drops zero-length cues', () => {
  const cues = DS.parseJson3({
    events: [
      { tStartMs: 1000, dDurationMs: 0, segs: [{ utf8: 'blink' }] },
      { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: 'fine' }] }
    ]
  });
  assert.deepEqual(cues.map((c) => c.text), ['fine']);
});

// --- merging into sentences ---

const mk = (start, end, text) => ({ start, end, text });

test('mergeIntoSentences merges up to an end-of-sentence mark', () => {
  const segs = DS.mergeIntoSentences([
    mk(0, 1000, 'Hello there.'),
    mk(1000, 2000, 'This is'),
    mk(2000, 3000, 'a test.'),
    mk(3000, 4000, 'And more')
  ]);
  assert.deepEqual(segs.map((s) => s.text), ['Hello there.', 'This is a test.', 'And more']);
  assert.equal(segs[1].start, 1000);
  assert.equal(segs[1].end, 3000);
});

test('mergeIntoSentences breaks the merge on a long pause', () => {
  const segs = DS.mergeIntoSentences([
    mk(0, 1000, 'first part'),
    mk(9000, 10000, 'after the pause')
  ]);
  assert.equal(segs.length, 2);
});

test('mergeIntoSentences respects the length limit', () => {
  const long = Array.from({ length: 20 }, (_, i) => mk(i * 500, i * 500 + 500, 'word'.repeat(4)));
  const segs = DS.mergeIntoSentences(long, { maxChars: 60 });
  assert.ok(segs.length > 1);
  assert.ok(segs.every((s) => s.text.length <= 60));
});

test('mergeIntoSentences respects the duration limit', () => {
  const many = Array.from({ length: 12 }, (_, i) => mk(i * 1000, i * 1000 + 1000, 'a'));
  const segs = DS.mergeIntoSentences(many, { maxMs: 4000 });
  assert.ok(segs.every((s) => s.end - s.start <= 4000 + 1000));
});

test('mergeIntoSentences keeps every cue', () => {
  const cues = DS.parseJson3(ASR_FIXTURE);
  const segs = DS.mergeIntoSentences(cues);
  const total = segs.reduce((n, s) => n + s.sources.length, 0);
  assert.equal(total, cues.length);
});

// --- finding the active cue ---

const CUES = [mk(0, 1000, 'a'), mk(1000, 2000, 'b'), mk(5000, 6000, 'c')];

test('findActive finds a cue by time', () => {
  assert.equal(DS.findActive(CUES, 500), 0);
  assert.equal(DS.findActive(CUES, 1500), 1);
  assert.equal(DS.findActive(CUES, 5500), 2);
});

test('findActive returns -1 in the gaps and out of range', () => {
  assert.equal(DS.findActive(CUES, 3000), -1);   // a hole between cues
  assert.equal(DS.findActive(CUES, 99999), -1);  // past the end
  assert.equal(DS.findActive([], 100), -1);
});

test('findActive gives the same answer for any hint', () => {
  for (const hint of [0, 1, 2, 5, -3]) {
    assert.equal(DS.findActive(CUES, 5500, hint), 2, `hint=${hint}`);
    assert.equal(DS.findActive(CUES, 500, hint), 0, `hint=${hint}`);
    assert.equal(DS.findActive(CUES, 3000, hint), -1, `hint=${hint}`);
  }
});

test('findActive matches a full scan over a long track', () => {
  const many = Array.from({ length: 500 }, (_, i) => mk(i * 100, i * 100 + 60, 't' + i));
  let hint = 0;
  for (let t = 0; t < 50000; t += 37) {
    const expected = many.findIndex((c) => t >= c.start && t < c.end);
    const got = DS.findActive(many, t, hint);
    assert.equal(got, expected, `t=${t}`);
    if (got >= 0) hint = got;
  }
});
