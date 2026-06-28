'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { aggregate } = require('../lib/usage');

function writeJsonl(filePath, events) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, events.map((ev) => JSON.stringify(ev)).join('\n') + '\n');
}

test('aggregate sums usage across providers and retains latest rate_limit', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-usage-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  writeJsonl(path.join(tempRoot, 'ws-alpha', 'session-1.jsonl'), [
    {
      kind: 'agent',
      actor: 'codex',
      type: 'usage',
      ts: 1,
      meta: { input_tokens: 100, output_tokens: 40 },
    },
    {
      kind: 'agent',
      actor: 'claude',
      type: 'usage',
      ts: 2,
      meta: { usage: { input_tokens: 200, output_tokens: 80 }, cost: 0.05 },
    },
    {
      kind: 'agent',
      actor: 'gemini',
      type: 'usage',
      ts: 3,
      meta: { promptTokenCount: 150, candidatesTokenCount: 60 },
    },
    {
      kind: 'agent',
      actor: 'claude',
      type: 'rate_limit',
      ts: 10,
      meta: { status: 429, rateLimitType: 'tokens', resetsAt: '2026-01-01T00:00:00Z' },
    },
  ]);

  writeJsonl(path.join(tempRoot, 'ws-beta', 'session-2.jsonl'), [
    {
      kind: 'agent',
      actor: 'codex',
      type: 'usage',
      ts: 4,
      meta: { input_tokens: 50, output_tokens: 20 },
    },
    {
      kind: 'agent',
      actor: 'claude',
      type: 'usage',
      ts: 5,
      meta: { usage: { input_tokens: 30, output_tokens: 10 }, cost: 0.02 },
    },
    {
      kind: 'agent',
      actor: 'claude',
      type: 'rate_limit',
      ts: 20,
      meta: { status: 429, rateLimitType: 'requests', resetsAt: '2026-01-02T00:00:00Z' },
    },
    {
      kind: 'agent',
      actor: 'claude',
      type: 'rate_limit',
      ts: 15,
      meta: { status: 429, rateLimitType: 'tokens', resetsAt: '2026-01-01T12:00:00Z' },
    },
  ]);

  const result = aggregate(tempRoot);

  assert.deepEqual(result.providers.codex, {
    calls: 2,
    tokensIn: 150,
    tokensOut: 60,
    costUsd: 0,
    lastRateLimit: null,
  });

  assert.deepEqual(result.providers.claude, {
    calls: 2,
    tokensIn: 230,
    tokensOut: 90,
    costUsd: 0.07,
    lastRateLimit: {
      status: 429,
      rateLimitType: 'requests',
      resetsAt: '2026-01-02T00:00:00Z',
    },
  });

  assert.deepEqual(result.providers.gemini, {
    calls: 1,
    tokensIn: 150,
    tokensOut: 60,
    costUsd: 0,
    lastRateLimit: null,
  });

  assert.equal(typeof result.generatedAt, 'number');
});
