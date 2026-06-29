'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const claude = require('../adapters/claude');
const codex = require('../adapters/codex');
const grok = require('../adapters/grok');
const { normalizeEffort } = require('../adapters/base');

test('normalizeEffort accepts known levels and drops unknown values', () => {
  assert.equal(normalizeEffort('high'), 'high');
  assert.equal(normalizeEffort('extra high'), 'xhigh');
  assert.equal(normalizeEffort('default'), null);
  assert.equal(normalizeEffort('turbo'), null);
});

test('Claude CLI receives effort flag for supported direct runs', () => {
  const args = claude._buildArgs({
    prompt: 'hello',
    model: 'sonnet',
    effort: 'high',
    mode: 'plan',
  });

  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), [
    '--effort',
    'high',
  ]);
});

test('Grok CLI receives effort flag for supported direct runs', () => {
  const args = grok._buildArgs({
    prompt: 'hello',
    model: 'grok-build',
    effort: 'max',
    cwd: '/tmp/example',
    mode: 'edit',
  });

  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), [
    '--effort',
    'max',
  ]);
});

test('Codex CLI receives per-run reasoning effort config', () => {
  const args = codex._buildArgs({
    prompt: 'hello',
    model: 'gpt-5.5',
    effort: 'high',
    cwd: '/tmp/example',
    mode: 'plan',
  });

  assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), [
    '-c',
    'model_reasoning_effort="high"',
  ]);
});

test('Codex maps max effort to xhigh because this CLI exposes xhigh, not max', () => {
  const args = codex._buildArgs({
    prompt: 'hello',
    model: 'gpt-5.5',
    effort: 'max',
    cwd: '/tmp/example',
    mode: 'plan',
  });

  assert.equal(args[args.indexOf('-c') + 1], 'model_reasoning_effort="xhigh"');
});
