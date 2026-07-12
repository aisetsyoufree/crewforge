'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const antigravity = require('../adapters/antigravity');
const claude = require('../adapters/claude');
const codex = require('../adapters/codex');
const gemini = require('../adapters/gemini');
const grok = require('../adapters/grok');

async function runWithFixtureBinary(name, lines, adapter, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-adapter-'));
  const bin = path.join(dir, name);
  const script = `#!/usr/bin/env node\n${lines
    .map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`)
    .join('\n')}\n`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath || ''}`;
  const events = [];
  try {
    const result = await adapter.run(
      {
        prompt: 'fixture prompt',
        model: adapter.defaultModel,
        cwd: dir,
        mode: 'plan',
        ...options,
      },
      (event) => events.push(event)
    );
    return { events, result };
  } finally {
    // Tests run serially; restore the temporary executable lookup path.
    // eslint-disable-next-line require-atomic-updates
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Claude stream-json transcript normalizes messages, tools, limits, usage, and completion', async () => {
  const { events, result } = await runWithFixtureBinary(
    'claude',
    [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'considering' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/example.js' } },
            { type: 'text', text: 'finished' },
          ],
        },
      }),
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
      }),
      JSON.stringify({
        type: 'result',
        result: 'finished',
        usage: { input_tokens: 12, output_tokens: 4 },
        total_cost_usd: 0.01,
      }),
    ],
    claude
  );

  assert.equal(result.finalText, 'finished');
  assert.deepEqual(
    events.map((event) => event.type),
    ['status', 'reasoning', 'command', 'file_change', 'message', 'rate_limit', 'usage', 'done']
  );
  assert.equal(events.find((event) => event.type === 'file_change').meta.file, '/tmp/example.js');
});

test('Codex JSONL transcript normalizes agent, command, file, usage, and completion events', async () => {
  const { events, result } = await runWithFixtureBinary(
    'codex',
    [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', text: 'updated', path: 'app.js' },
      }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }),
    ],
    codex
  );

  assert.equal(result.finalText, 'done');
  assert.deepEqual(
    events.map((event) => event.type),
    ['status', 'reasoning', 'command', 'file_change', 'message', 'usage', 'done']
  );
  assert.equal(events.find((event) => event.type === 'file_change').meta.file, 'app.js');
});

test('Grok streaming-json transcript preserves token streams and tool/file events', async () => {
  const { events, result } = await runWithFixtureBinary(
    'grok',
    [
      JSON.stringify({ type: 'thought', data: 'thinking' }),
      JSON.stringify({ type: 'command', command: 'npm test' }),
      JSON.stringify({ type: 'file_change', data: 'updated', path: 'app.js' }),
      JSON.stringify({ type: 'text', data: 'done' }),
      JSON.stringify({ type: 'end', stopReason: 'complete' }),
    ],
    grok
  );

  assert.equal(result.finalText, 'done');
  assert.ok(events.some((event) => event.type === 'reasoning' && event.meta.delta));
  assert.ok(events.some((event) => event.type === 'command'));
  assert.equal(events.find((event) => event.type === 'file_change').meta.file, 'app.js');
  assert.ok(events.some((event) => event.type === 'message' && event.meta.final));
  assert.ok(events.some((event) => event.type === 'done'));
  assert.ok(events.some((event) => event.type === 'usage' && event.meta.approximate));
});

test('Antigravity plain transcript becomes a final message and completion event', async () => {
  const { events, result } = await runWithFixtureBinary('agy', ['generated response'], antigravity);
  assert.equal(result.finalText, 'generated response');
  assert.deepEqual(
    events.map((event) => event.type),
    ['status', 'message', 'usage', 'done']
  );
});

test('Gemini SSE transcript normalizes deltas, usage, final message, and completion', async () => {
  const oldFetch = global.fetch;
  const oldKey = process.env.GEMINI_API_KEY;
  const chunks = [
    'data: {"candidates":[{"content":{"parts":[{"text":"hello "}]}}]}\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"world"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n',
    'data: [DONE]\n',
  ].map((value) => new TextEncoder().encode(value));
  let index = 0;
  global.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            return index < chunks.length
              ? { value: chunks[index++], done: false }
              : { value: undefined, done: true };
          },
        };
      },
    },
  });
  process.env.GEMINI_API_KEY = 'fixture-key';
  const events = [];
  try {
    const result = await gemini.run({ prompt: 'fixture' }, (event) => events.push(event));
    assert.equal(result.finalText, 'hello world');
    assert.equal(events.filter((event) => event.type === 'message' && event.meta.delta).length, 2);
    assert.ok(events.some((event) => event.type === 'usage'));
    assert.ok(events.some((event) => event.type === 'message' && event.meta.final));
    assert.ok(events.some((event) => event.type === 'done'));
  } finally {
    // Tests run serially; restore process-global fixtures.
    // eslint-disable-next-line require-atomic-updates
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else {
      // eslint-disable-next-line require-atomic-updates
      process.env.GEMINI_API_KEY = oldKey;
    }
  }
});
