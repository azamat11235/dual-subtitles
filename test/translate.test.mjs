/** Tests for the worker's pure logic: batching, provider order, concurrency. */
import assert from 'node:assert/strict';
import { test } from './harness.mjs';

// On load the worker registers chrome.* listeners -- give it a stub.
const noopListener = { addListener() {} };
globalThis.chrome = {
  runtime: { onConnect: noopListener, onMessage: noopListener },
  commands: { onCommand: noopListener },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
             sync: { get: async () => ({}), set: async () => {} } }
};

const sw = await import('../src/background/service-worker.js');

// --- splitting into batches ---

test('chunkByChars stays under the limit and loses nothing', () => {
  const texts = Array.from({ length: 40 }, (_, i) => 'phrase number ' + i);
  const chunks = sw.chunkByChars(texts, 100);
  assert.deepEqual(chunks.flat(), texts);
  for (const c of chunks) {
    const len = c.reduce((n, t) => n + t.length + 1, 0);
    // The limit can only be exceeded by a single string longer than the limit itself.
    assert.ok(len <= 100 || c.length === 1, `batch of length ${len}`);
  }
});

test('chunkByChars keeps a string longer than the limit', () => {
  const chunks = sw.chunkByChars(['x'.repeat(500), 'short'], 100);
  assert.deepEqual(chunks.flat(), ['x'.repeat(500), 'short']);
});

test('chunkByChars on an empty list gives an empty result', () => {
  assert.deepEqual(sw.chunkByChars([], 100), []);
});

// --- provider order ---

test('providerChain puts the chosen provider first', () => {
  assert.equal(sw.providerChain('mymemory', false)[0], 'mymemory');
});

test('providerChain swaps youtube for google (tlang lives in the content script)', () => {
  assert.equal(sw.providerChain('youtube', false)[0], 'google');
});

test('providerChain does not offer DeepL without a key', () => {
  assert.ok(!sw.providerChain('google', false).includes('deepl'));
  assert.ok(sw.providerChain('google', true).includes('deepl'));
});

test('providerChain never repeats a provider', () => {
  const chain = sw.providerChain('google', true);
  assert.equal(new Set(chain).size, chain.length);
});

// --- batching with an alignment check ---

test('batchWithVerification returns 1:1 when the split survived', async () => {
  let calls = 0;
  const translate = async (joined) => {
    calls++;
    return joined.split('\n').map((l) => 'T:' + l).join('\n');
  };
  const out = await sw.batchWithVerification(['a', 'b', 'c'], translate);
  assert.deepEqual(out, ['T:a', 'T:b', 'T:c']);
  assert.equal(calls, 1, 'one request is enough when it matches');
});

test('batchWithVerification repairs the alignment when lines got glued', async () => {
  // A model of Google's behaviour: on long batches it sometimes drops a newline.
  const translate = async (joined) => {
    const lines = joined.split('\n');
    const translated = lines.map((l) => 'T:' + l).join('\n');
    return lines.length >= 3 ? translated.replace('\n', ' ') : translated;
  };
  const out = await sw.batchWithVerification(['a', 'b', 'c', 'd'], translate);
  assert.deepEqual(out, ['T:a', 'T:b', 'T:c', 'T:d']);
});

test('batchWithVerification collapses extra newlines inside a single string', async () => {
  const translate = async (joined) => 'first\nsecond';
  const out = await sw.batchWithVerification(['one line'], translate);
  assert.deepEqual(out, ['first second']);
});

test('batchWithVerification always returns as many strings as it got', async () => {
  // A malicious translator: it never preserves the split.
  const translate = async (joined) => joined.split('\n').map((l) => 'T:' + l).join(' | ');
  for (const n of [1, 2, 5, 9]) {
    const input = Array.from({ length: n }, (_, i) => 'item' + i);
    const out = await sw.batchWithVerification(input, translate);
    assert.equal(out.length, n, `n=${n}`);
  }
});

test('batchWithVerification makes no request for an empty list', async () => {
  let calls = 0;
  const out = await sw.batchWithVerification([], async () => { calls++; return ''; });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

// --- concurrency ---

test('mapLimit preserves the order of the results', async () => {
  const items = [30, 5, 20, 1, 10];
  const out = await sw.mapLimit(items, 2, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assert.deepEqual(out, items);
});

test('mapLimit stays within the given concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  await sw.mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
  });
  assert.ok(peak <= 3, `peak concurrency ${peak}`);
});

// --- cache key ---

test('hashTexts changes with the text and with its length', () => {
  const a = sw.hashTexts(['one', 'two']);
  assert.equal(a, sw.hashTexts(['one', 'two']));
  assert.notEqual(a, sw.hashTexts(['one', 'three']));
  assert.notEqual(a, sw.hashTexts(['one', 'two', 'three']));
});
