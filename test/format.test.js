const assert = require('node:assert');
const test = require('node:test');

const { humanTokens, humanDuration, truncate } = require('../lib/format');

test('humanTokens formats token counts', () => {
  assert.strictEqual(humanTokens(0), '0');
  assert.strictEqual(humanTokens(999), '999');
  assert.strictEqual(humanTokens(1000), '1k');
  assert.strictEqual(humanTokens(12484), '12.5k');
  assert.strictEqual(humanTokens(1500000), '1.5M');
  assert.strictEqual(humanTokens(2000000), '2M');
});

test('humanDuration formats milliseconds', () => {
  assert.strictEqual(humanDuration(0), '0ms');
  assert.strictEqual(humanDuration(999), '999ms');
  assert.strictEqual(humanDuration(1000), '1s');
  assert.strictEqual(humanDuration(1200), '1.2s');
  assert.strictEqual(humanDuration(59000), '59s');
  assert.strictEqual(humanDuration(184000), '3m 4s');
});

test('truncate shortens strings only when needed', () => {
  assert.strictEqual(truncate('hello', 10), 'hello');
  assert.strictEqual(truncate('hello', 5), 'hello');
  assert.strictEqual(truncate('hello', 4), 'hell…');
  assert.strictEqual(truncate('hello', 0), '…');
  assert.strictEqual(truncate('', 0), '');
});
