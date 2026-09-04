/**
 * Tests for choosing the track behind each line.
 *
 * The fixture at the centre of this file is real: it is what YouTube returns for
 * an auto-dubbed English video, where the extension used to put Arabic on the
 * first line.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from './harness.mjs';

const code = readFileSync(new URL('../src/content/select.js', import.meta.url), 'utf8');
const window = {};
new Function('window', code)(window);
const DS = window.DS;

const asr = (lang) => ({ languageCode: lang, kind: 'asr', name: '' });
const manual = (lang) => ({ languageCode: lang, kind: '', name: '' });

// "I Gave AI 7 Days to Get App Users": twenty automatic tracks, no manual ones,
// sorted by English language name, so Arabic comes first. videoDetails carries
// no defaultAudioLanguage, and audioTracks[*].defaultCaptionTrackIndex is 3 --
// the English track.
const DUBBED = {
  defaultAudioLanguage: null,
  defaultCaptionLanguage: 'en',
  tracks: ['ar', 'bn', 'nl-NL', 'en', 'fr-FR', 'de-DE', 'hi', 'id', 'it', 'ja',
           'ko', 'ml', 'pl', 'pt-BR', 'pa', 'ru', 'es-US', 'ta', 'te', 'uk'].map(asr)
};

test('an auto-dubbed video takes the language YouTube points at, not the first track', () => {
  assert.equal(DS.videoLanguageOf(DUBBED), 'en');
  const picked = DS.pickTrack(DUBBED.tracks, 'auto', DS.videoLanguageOf(DUBBED));
  assert.equal(picked.languageCode, 'en');   // was 'ar'
});

test('videoLanguageOf prefers the audio language over the caption pointer', () => {
  assert.equal(DS.videoLanguageOf({ ...DUBBED, defaultAudioLanguage: 'de-DE' }), 'de-DE');
});

test('a lone automatic track names the spoken language', () => {
  // YouTube only recognises speech in the language actually spoken, so one
  // automatic track is a reliable signal even with no pointer and no audio field.
  const info = {
    defaultAudioLanguage: null,
    defaultCaptionLanguage: null,
    tracks: [manual('fr'), asr('en'), manual('ru')]
  };
  assert.equal(DS.videoLanguageOf(info), 'en');
  // Without this the first manual track won, which is French here.
  assert.equal(DS.pickTrack(info.tracks, 'auto', DS.videoLanguageOf(info)).languageCode, 'en');
});

test('several automatic languages say nothing, so the signal is dropped', () => {
  assert.equal(DS.videoLanguageOf({ ...DUBBED, defaultCaptionLanguage: null }), null);
});

test('regional variants of one language still count as a single signal', () => {
  const info = { tracks: [asr('pt-BR'), asr('pt-PT')] };
  assert.equal(DS.videoLanguageOf(info), 'pt-BR');
});

test('videoLanguageOf survives missing data', () => {
  assert.equal(DS.videoLanguageOf(null), null);
  assert.equal(DS.videoLanguageOf({}), null);
  assert.equal(DS.videoLanguageOf({ tracks: [] }), null);
});

// --- picking a track for a language ---

test('a manual track beats an automatic one in the same language', () => {
  const tracks = [asr('en'), manual('en')];
  assert.equal(DS.pickTrack(tracks, 'en', null).kind, '');
});

test('an exact regional match beats a loose one', () => {
  const tracks = [manual('pt-BR'), manual('pt-PT')];
  assert.equal(DS.pickTrack(tracks, 'pt-PT', null).languageCode, 'pt-PT');
});

test('a bare language code matches a regional track', () => {
  assert.equal(DS.pickTrack([manual('pt-BR')], 'pt', null).languageCode, 'pt-BR');
});

test('a language with no track gives nothing', () => {
  assert.equal(DS.pickTrack([manual('en')], 'ja', null), null);
  assert.equal(DS.pickTrack([], 'en', null), null);
  assert.equal(DS.pickTrack(null, 'en', null), null);
});

test('auto falls back to a manual track when the video language has none', () => {
  // A dub can leave no track in the original language at all.
  const tracks = [asr('de'), manual('fr')];
  assert.equal(DS.pickTrack(tracks, 'auto', 'ja').languageCode, 'fr');
});

test('auto falls back to the first track when nothing else applies', () => {
  const tracks = [asr('de'), asr('fr')];
  assert.equal(DS.pickTrack(tracks, 'auto', null).languageCode, 'de');
});
