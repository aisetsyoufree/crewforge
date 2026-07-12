'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const claude = require('../adapters/claude');
const antigravity = require('../adapters/antigravity');
const adapters = require('../adapters');
const codex = require('../adapters/codex');
const grok = require('../adapters/grok');
const { normalizeEffort } = require('../adapters/base');

test('normalizeEffort accepts known levels and drops unknown values', () => {
  assert.equal(normalizeEffort('high'), 'high');
  assert.equal(normalizeEffort('extra high'), 'xhigh');
  assert.equal(normalizeEffort('default'), null);
  assert.equal(normalizeEffort('turbo'), null);
});

test('Antigravity binds an explicit project workspace and sandbox', () => {
  const args = antigravity._buildArgs({
    prompt: 'build it',
    model: 'Gemini 3.1 Pro (High)',
    cwd: '/tmp/example',
    mode: 'edit',
  });

  assert.deepEqual(args.slice(0, 4), ['--new-project', '--add-dir', '/tmp/example', '--model']);
  assert.equal(args[args.indexOf('--mode') + 1], 'accept-edits');
  assert.ok(args.includes('--sandbox'));
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.equal(args[args.indexOf('--print') + 1], 'build it');
});

test('Antigravity plan mode stays read-only and does not auto-approve edits', () => {
  const args = antigravity._buildArgs({
    prompt: 'review it',
    model: 'Gemini 3.5 Flash (High)',
    cwd: '/tmp/example',
    mode: 'plan',
  });

  assert.equal(args[args.indexOf('--mode') + 1], 'plan');
  assert.ok(args.includes('--sandbox'));
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
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

test('Claude plan mode disallows file-writing tools', () => {
  const args = claude._buildArgs({
    prompt: 'plan only',
    model: 'sonnet',
    effort: 'default',
    mode: 'plan',
  });

  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(args.includes('--disallowedTools'));
  assert.match(args[args.indexOf('--disallowedTools') + 1], /Write/);
});

test('Claude Sonnet only advertises and forwards low/medium/high effort', () => {
  assert.deepEqual(adapters.effortLevels('claude', 'sonnet'), ['low', 'medium', 'high']);
  const args = claude._buildArgs({
    prompt: 'hello',
    model: 'sonnet',
    effort: 'max',
    mode: 'plan',
  });

  assert.equal(args.includes('--effort'), false);
});

test('Claude Opus keeps extended effort options', () => {
  assert.deepEqual(adapters.effortLevels('claude', 'opus'), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
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
