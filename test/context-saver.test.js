const assert = require('node:assert');
const test = require('node:test');

const contextSaver = require('../lib/context_saver');

const oldBaseUrl = process.env.HEADROOM_BASE_URL;
const oldApiKey = process.env.HEADROOM_API_KEY;
delete process.env.HEADROOM_BASE_URL;
delete process.env.HEADROOM_API_KEY;
test.after(() => {
  if (oldBaseUrl === undefined) delete process.env.HEADROOM_BASE_URL;
  else process.env.HEADROOM_BASE_URL = oldBaseUrl;
  if (oldApiKey === undefined) delete process.env.HEADROOM_API_KEY;
  else process.env.HEADROOM_API_KEY = oldApiKey;
});

function events(n) {
  return Array.from({ length: n }, (_, i) => ({
    kind: i % 2 ? 'agent' : 'user',
    actor: i % 2 ? 'codex' : 'user',
    type: 'message',
    text: `${i % 2 ? 'Assistant answer' : 'User request'} ${i} with enough words to make context grow over repeated turns.`,
    meta: i % 2 ? { final: true } : undefined,
  }));
}

test('normalizeMode defaults to balanced for unknown values', () => {
  assert.equal(contextSaver.normalizeMode('off'), 'off');
  assert.equal(contextSaver.normalizeMode('maximum'), 'maximum');
  assert.equal(contextSaver.normalizeMode('wat'), 'balanced');
});

test('built-in context saver reduces prompt size in maximum mode', async () => {
  const balanced = await contextSaver.buildSavedContext(events(40), 'Now do the next step', {
    mode: 'balanced',
  });
  const maximum = await contextSaver.buildSavedContext(events(40), 'Now do the next step', {
    mode: 'maximum',
  });

  assert.equal(balanced.provider, 'built-in');
  assert.equal(maximum.provider, 'built-in');
  assert.ok(maximum.prompt.length < balanced.prompt.length);
  assert.ok(maximum.afterTokens <= maximum.beforeTokens);
});

test('off mode keeps the legacy context shape', async () => {
  const out = await contextSaver.buildSavedContext(events(4), 'New request', { mode: 'off' });
  assert.ok(out.prompt.includes('Conversation so far:'));
  assert.ok(out.prompt.includes('Now respond to:'));
  assert.equal(out.provider, undefined);
});

test('status reports built-in saver and optional Headroom flags', () => {
  const status = contextSaver.status();
  assert.equal(status.builtIn, true);
  assert.equal(typeof status.headroomInstalled, 'boolean');
  assert.equal(typeof status.headroomConfigured, 'boolean');
  assert.equal(status.headroomActive, status.headroomInstalled && status.headroomConfigured);
});
