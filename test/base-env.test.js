'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { safeCliEnv } = require('../adapters/base');

test('safeCliEnv excludes API keys and arbitrary server environment', () => {
  const oldGemini = process.env.GEMINI_API_KEY;
  const oldCustom = process.env.CREW_FORGE_TEST_SECRET;
  process.env.GEMINI_API_KEY = 'secret-gemini-key';
  process.env.CREW_FORGE_TEST_SECRET = 'secret-custom-value';

  try {
    const env = safeCliEnv();
    assert.equal(env.GEMINI_API_KEY, undefined);
    assert.equal(env.CREW_FORGE_TEST_SECRET, undefined);
    assert.equal(typeof env.PATH, 'string');
  } finally {
    if (oldGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldGemini;
    if (oldCustom === undefined) delete process.env.CREW_FORGE_TEST_SECRET;
    else process.env.CREW_FORGE_TEST_SECRET = oldCustom;
  }
});
