'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const capsuleLib = require('../lib/continuation_capsule');
const { finishDirectRun } = require('../lib/run_outcome');

test('validateCapsule bounds fields and redacts secrets', () => {
  const cap = capsuleLib.validateCapsule({
    workspaceId: 'ws-abc',
    sessionId: 'sid-1',
    objective: 'Implement feature X with sk-abcdefghijklmnopqrstuvwxyz',
    reason: 'failed',
    contextPolicy: 'relevant-only',
    mode: 'plan',
    provider: 'claude',
    model: 'sonnet',
    remainingTasks: [{ id: 't1', summary: 'Do the thing', acceptanceCriteria: ['tests pass'] }],
    evidence: [{ path: 'src/app.js' }, { path: '.env' }, { path: '/Users/me/secret' }],
    events: [{ type: 'error', summary: 'Bearer abcdefghijklmnop failed' }],
  });
  assert.equal(cap.version, 1);
  assert.equal(cap.status, 'eligible');
  assert.match(cap.objective, /\[REDACTED\]/);
  assert.equal(cap.evidence.length, 1);
  assert.equal(cap.evidence[0].path, 'src/app.js');
  assert.match(cap.events[0].summary, /REDACTED/);
  assert.ok(cap.resumeInstructions);
  assert.throws(() =>
    capsuleLib.validateCapsule({
      workspaceId: 'ws-abc',
      sessionId: 'sid-1',
      objective: 'x',
      apiKey: 'secret',
    })
  );
});

test('persist, list, ownership, and explicit resume mark', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-caps-'));
  capsuleLib.configure({ root });
  try {
    const ledgerEntries = [];
    const ledger = {
      append(e) {
        ledgerEntries.push(e);
        return e;
      },
    };
    const saved = capsuleLib.persistCapsule(
      {
        workspaceId: 'ws1',
        sessionId: 'sid1',
        reason: 'rate_limit',
        objective: 'Continue implementing login',
        contextPolicy: 'metadata-only',
        mode: 'edit',
        provider: 'codex',
        model: 'gpt',
        remainingTasks: [{ id: 'r1', summary: 'Finish login' }],
        completedTasks: [{ id: 'c1', summary: 'Scaffolded form' }],
      },
      { ledger }
    );
    assert.equal(saved.status, 'eligible');
    assert.equal(ledgerEntries[0].transition, 'capsule_created');

    const listed = capsuleLib.listCapsules('ws1', 'sid1');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, saved.id);

    assert.throws(() => capsuleLib.assertOwnership(saved, 'other', 'sid1'));
    capsuleLib.assertOwnership(saved, 'ws1', 'sid1');

    const other = capsuleLib.readCapsule('ws1', 'other-sid', saved.id);
    assert.equal(other, null);

    const resumed = capsuleLib.markResumed('ws1', 'sid1', saved.id, {
      ledger,
      provider: 'claude',
      model: 'opus',
      mode: 'plan',
      contextPolicy: 'relevant-only',
      keepEligible: true,
    });
    assert.equal(resumed.status, 'eligible');
    assert.equal(resumed.useCount, 1);
    assert.equal(
      ledgerEntries.some((e) => e.transition === 'capsule_resumed'),
      true
    );

    const prompt = capsuleLib.buildResumePrompt(resumed, {
      contextPolicy: 'relevant-only',
      mode: 'plan',
    });
    assert.match(prompt, /provider-neutral continuation capsule/i);
    assert.match(prompt, /Continue implementing login/);
    assert.match(prompt, /Local control with provider processing/);
    assert.doesNotMatch(prompt, /apiKey|process\.env/i);
  } finally {
    capsuleLib.resetConfig();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('finishDirectRun creates capsule on failure and records ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-caps-run-'));
  capsuleLib.configure({ root });
  const events = [];
  const store = {
    events,
    append(_ws, _sid, event) {
      events.push(event);
    },
    readEvents() {
      return [{ kind: 'user', type: 'message', text: 'Ship the feature' }];
    },
  };
  const ledgerEntries = [];
  const ledger = {
    append(e) {
      ledgerEntries.push(e);
      return e;
    },
  };
  try {
    finishDirectRun(store, 'ws1', 'sid1', 'claude', {
      aborted: false,
      result: { error: 'rate limit 429' },
      ledger,
      meta: {
        provider: 'claude',
        model: 'sonnet',
        mode: 'plan',
        contextPolicy: 'relevant-only',
        objective: 'Ship the feature',
      },
    });
    const capsuleEvent = events.find((e) => e.type === 'continuation-capsule');
    assert.ok(capsuleEvent);
    assert.equal(capsuleEvent.meta.reason, 'rate_limit');
    assert.ok(capsuleEvent.meta.capsuleId);
    assert.ok(ledgerEntries.some((e) => e.transition === 'run_failed'));
    assert.ok(ledgerEntries.some((e) => e.transition === 'capsule_created'));
    const listed = capsuleLib.listCapsules('ws1', 'sid1');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].reason, 'rate_limit');
  } finally {
    capsuleLib.resetConfig();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capsule limits objective length', () => {
  const long = 'x'.repeat(5000);
  const cap = capsuleLib.buildCapsule({
    workspaceId: 'ws1',
    sessionId: 'sid1',
    objective: long,
    reason: 'incomplete',
  });
  assert.ok(cap.objective.length <= 2000);
});

test('capsule temp destination files are mode 0600 on POSIX', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-caps-mode-'));
  capsuleLib.configure({ root });
  try {
    const saved = capsuleLib.persistCapsule({
      workspaceId: 'ws-mode',
      sessionId: 'sid-mode',
      reason: 'incomplete',
      objective: 'mode check',
      contextPolicy: 'relevant-only',
      mode: 'plan',
    });
    const file = path.join(root, 'ws-mode', 'sid-mode', `${saved.id}.json`);
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    // Ensure no world/group read leftovers from umask.
    assert.equal(mode & 0o077, 0);
  } finally {
    capsuleLib.resetConfig();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
