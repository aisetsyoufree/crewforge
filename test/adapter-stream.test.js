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
const {
  DIAGNOSTIC_MAX_EVENTS,
  DIAGNOSTIC_MAX_LINE_CHARS,
  createStreamDiagnostics,
  previewDiagnosticLine,
  redactSecrets,
} = require('../adapters/base');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'adapters');

function loadFixtureLines(name) {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
  // Keep non-empty lines only; trailing newline produces a blank that adapters ignore.
  return raw.split(/\r?\n/).filter((line) => line.length > 0);
}

function loadFixtureText(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

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

async function runGeminiWithSse(bodyText) {
  const oldFetch = global.fetch;
  const oldKey = process.env.GEMINI_API_KEY;
  const chunks = bodyText.split(/(?<=\n)/).map((value) => new TextEncoder().encode(value));
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
    return { events, result };
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
}

function diagnosticReasons(events) {
  return events
    .filter((event) => event.type === 'diagnostic')
    .map((event) => event.meta && event.meta.reason);
}

function assertNoSecrets(events) {
  const joined = events
    .filter((event) => event.type === 'diagnostic')
    .map((event) => `${event.text}\n${JSON.stringify(event.meta || {})}`)
    .join('\n');
  assert.doesNotMatch(joined, /sk-[a-z]{10,}/i);
  assert.doesNotMatch(joined, /supersecrettokenvalue/i);
  assert.doesNotMatch(joined, /super-secret-grok-token/i);
  assert.doesNotMatch(joined, /secret-codex-token-value/i);
  assert.doesNotMatch(joined, /hunter2/);
  assert.doesNotMatch(joined, /AIzaSyDummyKeyValueHere1234567890/);
  assert.doesNotMatch(joined, /Bearer\s+sk-live/i);
}

test('shared diagnostic helper redacts secrets, caps line length, and caps event count', () => {
  const secretLine = `Authorization: Bearer sk-live-supersecrettokenvalue ${'x'.repeat(500)}`;
  const preview = previewDiagnosticLine(secretLine);
  assert.ok(preview.includes('[redacted]') || preview.includes('…[redacted]'));
  assert.doesNotMatch(preview, /supersecrettokenvalue/);
  assert.ok(preview.length <= DIAGNOSTIC_MAX_LINE_CHARS + 20);

  const redacted = redactSecrets('api_key=secret-value-here and sk-abcdefghijklmnop');
  assert.match(redacted, /\[redacted\]/);
  assert.doesNotMatch(redacted, /secret-value-here/);

  const events = [];
  const diag = createStreamDiagnostics((event) => events.push(event), { adapter: 'test' });
  for (let i = 0; i < DIAGNOSTIC_MAX_EVENTS + 5; i += 1) {
    diag.nonJson(`noise line ${i}`);
  }
  assert.equal(events.length, DIAGNOSTIC_MAX_EVENTS);
  assert.equal(diag.stats().suppressed, 5);
  assert.equal(events[0].type, 'diagnostic');
  assert.equal(events[0].meta.reason, 'non_json');
  assert.equal(events[events.length - 1].meta.capped, true);
});

test('Claude stream-json transcript normalizes messages, tools, limits, usage, and completion', async () => {
  const { events, result } = await runWithFixtureBinary(
    'claude',
    loadFixtureLines('claude-success.jsonl'),
    claude
  );

  assert.equal(result.finalText, 'finished');
  assert.deepEqual(
    events.map((event) => event.type),
    ['status', 'reasoning', 'command', 'file_change', 'message', 'rate_limit', 'usage', 'done']
  );
  assert.equal(events.find((event) => event.type === 'file_change').meta.file, '/tmp/example.js');
  assert.equal(events.filter((event) => event.type === 'diagnostic').length, 0);
});

test('Codex JSONL transcript normalizes agent, command, file, usage, and completion events', async () => {
  const { events, result } = await runWithFixtureBinary(
    'codex',
    loadFixtureLines('codex-success.jsonl'),
    codex
  );

  assert.equal(result.finalText, 'done');
  assert.deepEqual(
    events.map((event) => event.type),
    ['status', 'reasoning', 'command', 'file_change', 'message', 'usage', 'done']
  );
  assert.equal(events.find((event) => event.type === 'file_change').meta.file, 'app.js');
  assert.equal(events.filter((event) => event.type === 'diagnostic').length, 0);
});

test('Grok streaming-json transcript preserves token streams and tool/file events', async () => {
  const { events, result } = await runWithFixtureBinary(
    'grok',
    loadFixtureLines('grok-success.jsonl'),
    grok
  );

  assert.equal(result.finalText, 'done');
  assert.ok(events.some((event) => event.type === 'reasoning' && event.meta.delta));
  assert.ok(events.some((event) => event.type === 'command'));
  assert.equal(events.find((event) => event.type === 'file_change').meta.file, 'app.js');
  assert.ok(events.some((event) => event.type === 'message' && event.meta.final));
  assert.ok(events.some((event) => event.type === 'done'));
  assert.ok(events.some((event) => event.type === 'usage' && event.meta.approximate));
  assert.equal(events.filter((event) => event.type === 'diagnostic').length, 0);
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
  const { events, result } = await runGeminiWithSse(loadFixtureText('gemini-success.sse'));
  assert.equal(result.finalText, 'hello world');
  assert.equal(events.filter((event) => event.type === 'message' && event.meta.delta).length, 2);
  assert.ok(events.some((event) => event.type === 'usage'));
  assert.ok(events.some((event) => event.type === 'message' && event.meta.final));
  assert.ok(events.some((event) => event.type === 'done'));
  assert.equal(events.filter((event) => event.type === 'diagnostic').length, 0);
});

test('Claude emits diagnostics for non-JSON, malformed JSON, and unknown schema', async () => {
  const { events, result } = await runWithFixtureBinary(
    'claude',
    loadFixtureLines('claude-resilience.jsonl'),
    claude
  );

  assert.equal(result.finalText, 'partial');
  assert.deepEqual(diagnosticReasons(events), ['non_json', 'malformed_json', 'unknown_schema']);
  assert.ok(events.some((event) => event.type === 'usage'));
  assert.ok(events.some((event) => event.type === 'done'));
  assertNoSecrets(events);
  for (const event of events.filter((e) => e.type === 'diagnostic')) {
    assert.equal(event.meta.adapter, 'claude');
    assert.ok(event.meta.preview.length <= DIAGNOSTIC_MAX_LINE_CHARS + 20);
  }
});

test('Codex emits diagnostics for non-JSON, malformed JSON, and unknown schema', async () => {
  const { events, result } = await runWithFixtureBinary(
    'codex',
    loadFixtureLines('codex-resilience.jsonl'),
    codex
  );

  assert.equal(result.finalText, 'ok');
  assert.deepEqual(diagnosticReasons(events), ['non_json', 'malformed_json', 'unknown_schema']);
  assert.ok(events.some((event) => event.type === 'status'));
  assert.ok(events.some((event) => event.type === 'message' && event.meta.final));
  assert.ok(events.some((event) => event.type === 'done'));
  assertNoSecrets(events);
});

test('Grok emits diagnostics for non-JSON, malformed JSON, and unknown schema', async () => {
  const { events, result } = await runWithFixtureBinary(
    'grok',
    loadFixtureLines('grok-resilience.jsonl'),
    grok
  );

  assert.equal(result.finalText, 'recovered');
  assert.deepEqual(diagnosticReasons(events), ['non_json', 'malformed_json', 'unknown_schema']);
  assert.ok(events.some((event) => event.type === 'message'));
  assert.ok(events.some((event) => event.type === 'done'));
  // Unknown schema must not be misclassified as reasoning anymore.
  assert.equal(
    events.filter((event) => event.type === 'reasoning' && /brand_new_event/.test(event.text))
      .length,
    0
  );
  assertNoSecrets(events);
});

test('Gemini emits diagnostics for non-JSON, malformed JSON, and unknown schema', async () => {
  const { events, result } = await runGeminiWithSse(loadFixtureText('gemini-resilience.sse'));
  assert.equal(result.finalText, 'hi');
  assert.deepEqual(diagnosticReasons(events), ['non_json', 'malformed_json', 'unknown_schema']);
  assert.ok(events.some((event) => event.type === 'message' && event.meta.delta));
  assert.ok(events.some((event) => event.type === 'message' && event.meta.final));
  assert.ok(events.some((event) => event.type === 'done'));
  assertNoSecrets(events);
  for (const event of events.filter((e) => e.type === 'diagnostic')) {
    assert.equal(event.meta.adapter, 'gemini');
  }
});
