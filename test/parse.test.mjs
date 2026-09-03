/**
 * Тесты разбора json3 и склейки в предложения.
 * Фикстуры повторяют форму настоящего ответа /api/timedtext.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from './harness.mjs';

// parse.js -- обычный content script, а не модуль. Выполняем его в текущем
// realm (а не через node:vm), иначе созданные им массивы будут иметь чужой
// прототип и assert.deepEqual забракует совпадающие по структуре значения.
const code = readFileSync(new URL('../src/content/parse.js', import.meta.url), 'utf8');
const window = {};
new Function('window', code)(window);
const DS = window.DS;

// Форма настоящего ответа для kind=asr: событие-«окно» без segs, реальные
// реплики и служебные aAppend с одним переводом строки.
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

test('parseJson3 пропускает события-окна и служебные aAppend', () => {
  const cues = DS.parseJson3(ASR_FIXTURE);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map((c) => c.text), ['so in', 'college I', 'was a major']);
});

test('parseJson3 подрезает перекрывающиеся длительности', () => {
  const cues = DS.parseJson3(ASR_FIXTURE);
  // 12559 + 4480 = 17039, но следующая реплика начинается в 14360
  assert.equal(cues[0].end, 14360);
  assert.equal(cues[1].end, 19640);
  // последняя реплика ничем не ограничена
  assert.equal(cues[2].end, 22640);
});

test('parseJson3 не падает на пустом ответе', () => {
  assert.deepEqual(DS.parseJson3({}), []);
  assert.deepEqual(DS.parseJson3({ events: [] }), []);
  assert.deepEqual(DS.parseJson3({ events: [{ tStartMs: 0, segs: [{ utf8: '  ' }] }] }), []);
});

test('parseJson3 отбрасывает реплики нулевой длины', () => {
  const cues = DS.parseJson3({
    events: [
      { tStartMs: 1000, dDurationMs: 0, segs: [{ utf8: 'миг' }] },
      { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: 'нормально' }] }
    ]
  });
  assert.deepEqual(cues.map((c) => c.text), ['нормально']);
});

// --- склейка в предложения ---

const mk = (start, end, text) => ({ start, end, text });

test('mergeIntoSentences склеивает до знака конца предложения', () => {
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

test('mergeIntoSentences разрывает склейку на длинной паузе', () => {
  const segs = DS.mergeIntoSentences([
    mk(0, 1000, 'первая часть'),
    mk(9000, 10000, 'после паузы')
  ]);
  assert.equal(segs.length, 2);
});

test('mergeIntoSentences уважает предел длины', () => {
  const long = Array.from({ length: 20 }, (_, i) => mk(i * 500, i * 500 + 500, 'слово'.repeat(4)));
  const segs = DS.mergeIntoSentences(long, { maxChars: 60 });
  assert.ok(segs.length > 1);
  assert.ok(segs.every((s) => s.text.length <= 60));
});

test('mergeIntoSentences уважает предел длительности', () => {
  const many = Array.from({ length: 12 }, (_, i) => mk(i * 1000, i * 1000 + 1000, 'a'));
  const segs = DS.mergeIntoSentences(many, { maxMs: 4000 });
  assert.ok(segs.every((s) => s.end - s.start <= 4000 + 1000));
});

test('mergeIntoSentences сохраняет все реплики', () => {
  const cues = DS.parseJson3(ASR_FIXTURE);
  const segs = DS.mergeIntoSentences(cues);
  const total = segs.reduce((n, s) => n + s.sources.length, 0);
  assert.equal(total, cues.length);
});

// --- поиск активной реплики ---

const CUES = [mk(0, 1000, 'a'), mk(1000, 2000, 'b'), mk(5000, 6000, 'c')];

test('findActive находит реплику по времени', () => {
  assert.equal(DS.findActive(CUES, 500), 0);
  assert.equal(DS.findActive(CUES, 1500), 1);
  assert.equal(DS.findActive(CUES, 5500), 2);
});

test('findActive возвращает -1 в промежутках и за пределами', () => {
  assert.equal(DS.findActive(CUES, 3000), -1);   // дырка между репликами
  assert.equal(DS.findActive(CUES, 99999), -1);  // после конца
  assert.equal(DS.findActive([], 100), -1);
});

test('findActive даёт тот же ответ при любой подсказке', () => {
  for (const hint of [0, 1, 2, 5, -3]) {
    assert.equal(DS.findActive(CUES, 5500, hint), 2, `hint=${hint}`);
    assert.equal(DS.findActive(CUES, 500, hint), 0, `hint=${hint}`);
    assert.equal(DS.findActive(CUES, 3000, hint), -1, `hint=${hint}`);
  }
});

test('findActive совпадает с полным перебором на длинной дорожке', () => {
  const many = Array.from({ length: 500 }, (_, i) => mk(i * 100, i * 100 + 60, 't' + i));
  let hint = 0;
  for (let t = 0; t < 50000; t += 37) {
    const expected = many.findIndex((c) => t >= c.start && t < c.end);
    const got = DS.findActive(many, t, hint);
    assert.equal(got, expected, `t=${t}`);
    if (got >= 0) hint = got;
  }
});
