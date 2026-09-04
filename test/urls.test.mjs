/**
 * Tests for building the /api/timedtext request.
 *
 * These exist because the failure mode of this file is silence: a wrong
 * parameter earns a 200 with an empty body, which reads exactly like the rate
 * limiting the fetcher already expects, and a missing one throws inside a
 * promise where nothing surfaces it.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from './harness.mjs';

const code = readFileSync(new URL('../src/content/urls.js', import.meta.url), 'utf8');
const window = {};
new Function('window', code)(window);
const DS = window.DS;

// A URL of the shape the player requests, signature and pot included.
const POT = 'https://www.youtube.com/api/timedtext?v=VID&ei=E1&caps=asr&opi=1&exp=xpe' +
  '&expire=1788577871&sparams=ip,ipbits,expire,v,ei,caps,opi,exp,xoaf&signature=SIG&key=yt8' +
  '&lang=de-DE&kind=asr&fmt=json3&variant=timing-optimized';

const track = (over = {}) => ({ languageCode: 'en', kind: 'asr', name: '', baseUrl: '', ...over });
const q = (url) => new URL(url).searchParams;

test('buildFromPot swaps the track and keeps the signature', () => {
  const p = q(DS.buildFromPot(POT, track(), null, null));
  assert.equal(p.get('lang'), 'en');
  assert.equal(p.get('kind'), 'asr');
  assert.equal(p.get('fmt'), 'json3');
  assert.equal(p.get('signature'), 'SIG');   // untouched
  assert.equal(p.get('sparams'), 'ip,ipbits,expire,v,ei,caps,opi,exp,xoaf');
});

test('buildFromPot drops the captured variant unless one is asked for', () => {
  // The whole point: the captured URL was for a dub, the wanted track is not.
  assert.equal(q(DS.buildFromPot(POT, track(), null, null)).get('variant'), null);
  assert.equal(
    q(DS.buildFromPot(POT, track(), null, 'timing-optimized')).get('variant'),
    'timing-optimized'
  );
});

test('buildFromPot clears kind for a manual track', () => {
  assert.equal(q(DS.buildFromPot(POT, track({ kind: '' }), null, null)).get('kind'), null);
});

test('buildFromPot carries name only when the track has one', () => {
  assert.equal(q(DS.buildFromPot(POT, track(), null, null)).get('name'), null);
  assert.equal(q(DS.buildFromPot(POT, track({ name: 'CC1' }), null, null)).get('name'), 'CC1');
});

test('buildFromPot sets and clears tlang', () => {
  assert.equal(q(DS.buildFromPot(POT, track(), 'ru', null)).get('tlang'), 'ru');
  assert.equal(q(DS.buildFromPot(POT, track(), null, null)).get('tlang'), null);
});

test('buildFromPot prefers the parameters carried by the track baseUrl', () => {
  const t = track({ baseUrl: 'https://www.youtube.com/api/timedtext?lang=pt-BR&kind=asr&name=CC' });
  const p = q(DS.buildFromPot(POT, t, null, null));
  assert.equal(p.get('lang'), 'pt-BR');
  assert.equal(p.get('name'), 'CC');
});

// --- the track's own URL ---

test('buildFromBase needs a baseUrl', () => {
  assert.equal(DS.buildFromBase(track(), null, 'json3'), null);
});

test('buildFromBase sets the format and clears it for XML', () => {
  const t = track({ baseUrl: 'https://www.youtube.com/api/timedtext?v=VID&lang=en' });
  assert.equal(q(DS.buildFromBase(t, null, 'json3')).get('fmt'), 'json3');
  assert.equal(q(DS.buildFromBase(t, null, null)).get('fmt'), null);
});

test('buildFromBase leaves variant alone', () => {
  // Regression: variant handling once leaked into this function, which has no
  // such parameter — every call threw ReferenceError inside a promise, and the
  // only sign of it was the status line never moving off "Loading subtitles".
  const t = track({ baseUrl: 'https://www.youtube.com/api/timedtext?v=VID&lang=en&variant=timing-optimized' });
  const url = DS.buildFromBase(t, 'ru', 'json3');
  assert.equal(typeof url, 'string');
  assert.equal(q(url).get('variant'), 'timing-optimized');
  assert.equal(q(url).get('tlang'), 'ru');
});
