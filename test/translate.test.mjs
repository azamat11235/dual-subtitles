/** Тесты чистой логики фонового воркера: батчинг, порядок провайдеров, параллелизм. */
import assert from 'node:assert/strict';
import { test } from './harness.mjs';

// Воркер при загрузке вешает слушателей chrome.* -- подставляем заглушку.
const noopListener = { addListener() {} };
globalThis.chrome = {
  runtime: { onConnect: noopListener, onMessage: noopListener },
  commands: { onCommand: noopListener },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
             sync: { get: async () => ({}), set: async () => {} } }
};

const sw = await import('../src/background/service-worker.js');

// --- разбиение на пачки ---

test('chunkByChars не превышает лимит и ничего не теряет', () => {
  const texts = Array.from({ length: 40 }, (_, i) => 'фраза номер ' + i);
  const chunks = sw.chunkByChars(texts, 100);
  assert.deepEqual(chunks.flat(), texts);
  for (const c of chunks) {
    const len = c.reduce((n, t) => n + t.length + 1, 0);
    // Лимит может быть превышен только одной строкой, которая длиннее лимита сама по себе.
    assert.ok(len <= 100 || c.length === 1, `пачка длиной ${len}`);
  }
});

test('chunkByChars не теряет строку длиннее лимита', () => {
  const chunks = sw.chunkByChars(['x'.repeat(500), 'коротко'], 100);
  assert.deepEqual(chunks.flat(), ['x'.repeat(500), 'коротко']);
});

test('chunkByChars на пустом списке даёт пустой результат', () => {
  assert.deepEqual(sw.chunkByChars([], 100), []);
});

// --- порядок провайдеров ---

test('providerChain ставит выбранный провайдер первым', () => {
  assert.equal(sw.providerChain('mymemory', false)[0], 'mymemory');
});

test('providerChain подменяет youtube на google (tlang живёт в content script)', () => {
  assert.equal(sw.providerChain('youtube', false)[0], 'google');
});

test('providerChain не предлагает DeepL без ключа', () => {
  assert.ok(!sw.providerChain('google', false).includes('deepl'));
  assert.ok(sw.providerChain('google', true).includes('deepl'));
});

test('providerChain не повторяет провайдеров', () => {
  const chain = sw.providerChain('google', true);
  assert.equal(new Set(chain).size, chain.length);
});

// --- батчинг с проверкой выравнивания ---

test('batchWithVerification возвращает 1:1, когда разбиение сохранилось', async () => {
  let calls = 0;
  const translate = async (joined) => {
    calls++;
    return joined.split('\n').map((l) => 'T:' + l).join('\n');
  };
  const out = await sw.batchWithVerification(['a', 'b', 'c'], translate);
  assert.deepEqual(out, ['T:a', 'T:b', 'T:c']);
  assert.equal(calls, 1, 'при совпадении хватает одного запроса');
});

test('batchWithVerification чинит выравнивание, когда переводчик склеил строки', async () => {
  // Модель поведения Google: на длинных пачках иногда теряет перевод строки.
  const translate = async (joined) => {
    const lines = joined.split('\n');
    const translated = lines.map((l) => 'T:' + l).join('\n');
    return lines.length >= 3 ? translated.replace('\n', ' ') : translated;
  };
  const out = await sw.batchWithVerification(['a', 'b', 'c', 'd'], translate);
  assert.deepEqual(out, ['T:a', 'T:b', 'T:c', 'T:d']);
});

test('batchWithVerification схлопывает лишние переводы строк в одиночной строке', async () => {
  const translate = async (joined) => 'первая\nвторая';
  const out = await sw.batchWithVerification(['одна строка'], translate);
  assert.deepEqual(out, ['первая вторая']);
});

test('batchWithVerification всегда отдаёт столько же строк, сколько получил', async () => {
  // Злонамеренный переводчик: разбиение не сохраняет никогда.
  const translate = async (joined) => joined.split('\n').map((l) => 'T:' + l).join(' | ');
  for (const n of [1, 2, 5, 9]) {
    const input = Array.from({ length: n }, (_, i) => 'item' + i);
    const out = await sw.batchWithVerification(input, translate);
    assert.equal(out.length, n, `n=${n}`);
  }
});

test('batchWithVerification на пустом списке не делает запросов', async () => {
  let calls = 0;
  const out = await sw.batchWithVerification([], async () => { calls++; return ''; });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

// --- параллелизм ---

test('mapLimit сохраняет порядок результатов', async () => {
  const items = [30, 5, 20, 1, 10];
  const out = await sw.mapLimit(items, 2, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assert.deepEqual(out, items);
});

test('mapLimit не превышает заданный параллелизм', async () => {
  let inFlight = 0;
  let peak = 0;
  await sw.mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
  });
  assert.ok(peak <= 3, `пик параллелизма ${peak}`);
});

// --- ключ кэша ---

test('hashTexts меняется при изменении текста и его длины', () => {
  const a = sw.hashTexts(['раз', 'два']);
  assert.equal(a, sw.hashTexts(['раз', 'два']));
  assert.notEqual(a, sw.hashTexts(['раз', 'три']));
  assert.notEqual(a, sw.hashTexts(['раз', 'два', 'три']));
});
