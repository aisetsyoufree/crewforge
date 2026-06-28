const assert = require('node:assert');
const test = require('node:test');

const { buildReviewPrompt } = require('../lib/review');

const SAMPLE_DIFF = [
  'diff --git a/lib/foo.js b/lib/foo.js',
  '--- a/lib/foo.js',
  '+++ b/lib/foo.js',
  '@@ -1,3 +1,4 @@',
  ' const x = 1;',
  '+const y = 2;',
].join('\n');

test('buildReviewPrompt returns a non-empty string containing the diff text', () => {
  const prompt = buildReviewPrompt(SAMPLE_DIFF);
  assert.ok(typeof prompt === 'string' && prompt.length > 0);
  assert.ok(prompt.includes(SAMPLE_DIFF));
  assert.ok(prompt.includes('```diff'));
  assert.ok(prompt.includes('senior code reviewer'));
});

test('buildReviewPrompt handles empty diff by mentioning no changes', () => {
  const prompt = buildReviewPrompt('');
  assert.ok(typeof prompt === 'string' && prompt.length > 0);
  assert.ok(prompt.includes('no uncommitted changes'));
  assert.ok(!prompt.includes('```diff'));
});

test('buildReviewPrompt treats whitespace-only diff as empty', () => {
  const prompt = buildReviewPrompt('   \n  ');
  assert.ok(prompt.includes('no uncommitted changes'));
});
