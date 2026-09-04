/** Tests for the geometry of dragging the subtitle block. */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from './harness.mjs';

// render.js is a plain content script and the class body does not run on load,
// so the file reads fine in Node without a DOM.
const code = readFileSync(new URL('../src/content/render.js', import.meta.url), 'utf8');
const window = {};
new Function('window', code)(window);
const { clampCaptionPosition } = window.DS;

// A 1000x600 player with a 400x80 subtitle block.
const PW = 1000, PH = 600, CW = 400, CH = 80;
const at = (x, y) => clampCaptionPosition(x, y, CW, CH, PW, PH);

test('a position inside the player is left alone', () => {
  const p = at(500, 50);
  assert.equal(p.x, 0.5);
  assert.ok(Math.abs(p.y - 50 / 600) < 1e-9);
});

test('the block cannot slide past the left edge', () => {
  const p = at(10, 50);
  assert.ok(p.x * PW >= CW / 2, `centre ${p.x * PW} must not be left of ${CW / 2}`);
});

test('the block cannot slide past the right edge', () => {
  const p = at(990, 50);
  assert.ok(p.x * PW + CW / 2 <= PW, `right edge ${p.x * PW + CW / 2} escaped ${PW}`);
});

test('the block cannot slide below the player', () => {
  const p = at(500, -100);
  assert.ok(p.y >= 0, 'a negative offset from the bottom is not allowed');
  assert.ok(p.y * PH >= 1);
});

test('the block cannot slide above the player', () => {
  const p = at(500, 5000);
  assert.ok(p.y * PH + CH <= PH, `top of the block ${p.y * PH + CH} escaped ${PH}`);
});

test('the result is fractions, not pixels', () => {
  const p = at(250, 120);
  assert.ok(p.x > 0 && p.x < 1);
  assert.ok(p.y > 0 && p.y < 1);
});

test('a block wider than the player is centred rather than pushed off', () => {
  // Happens on a narrow player with a long cue.
  assert.equal(clampCaptionPosition(100, 50, 1400, CH, PW, PH).x, 0.5);
  assert.equal(clampCaptionPosition(900, 50, 1400, CH, PW, PH).x, 0.5);
});

test('a block taller than the player sits on the bottom', () => {
  const tall = clampCaptionPosition(500, 400, CW, 900, PW, PH);
  assert.ok(tall.y * PH <= 5, 'a block taller than the player must sit on the bottom');
});

test('a position carries over between player sizes', () => {
  // Fractions do not depend on the size: the same spot in fullscreen.
  const small = clampCaptionPosition(500, 60, 400, 80, 1000, 600);
  const large = clampCaptionPosition(960, 115.2, 768, 153.6, 1920, 1152);
  assert.ok(Math.abs(small.x - large.x) < 1e-9);
  assert.ok(Math.abs(small.y - large.y) < 1e-9);
});

test('the margin is honoured on every side', () => {
  const margin = 12;
  const left = clampCaptionPosition(0, 50, CW, CH, PW, PH, margin);
  assert.ok(left.x * PW - CW / 2 >= margin - 1e-9);
  const top = clampCaptionPosition(500, PH, CW, CH, PW, PH, margin);
  assert.ok(top.y * PH + CH + margin <= PH + 1e-9);
});
