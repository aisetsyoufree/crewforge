const assert = require('node:assert');
const test = require('node:test');

const { list } = require('../lib/keys');

test('list returns sorted provider entries with expected shape', () => {
  const entries = list();
  assert.ok(Array.isArray(entries));
  assert.ok(entries.length >= 1);

  const providers = entries.map((e) => e.provider);
  assert.deepStrictEqual(providers, [...providers].sort());
  // Only providers with a working adapter are offered for BYOK.
  assert.ok(providers.includes('gemini'));

  for (const entry of entries) {
    assert.strictEqual(typeof entry.provider, 'string');
    assert.strictEqual(typeof entry.set, 'boolean');
    assert.ok(entry.masked === null || /^\\*\\*\\*\\*.+$/.test(entry.masked));
    if (!entry.set) {
      assert.strictEqual(entry.masked, null);
    }
  }
});

test('list is read-only and does not mutate keys.json', () => {
  const before = list();
  const after = list();
  assert.deepStrictEqual(after, before);
});
