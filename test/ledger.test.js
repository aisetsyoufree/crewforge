'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ledger = require('../lib/ledger');

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-ledger-'));
  ledger.configure({ dir });
  ledger._resetForTests();
  return dir;
}

test('append stores capped redacted entry with scope ids', (t) => {
  const dir = tempLedger();
  t.after(() => {
    ledger.resetConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const entry = ledger.append({
    workspaceId: 'ws-abc123',
    sessionId: 'sid-2024-01',
    projectId: 'project-xyz',
    actor: 'claude',
    provider: 'claude',
    model: 'sonnet',
    role: 'implementer',
    mode: 'edit',
    step: 2,
    transition: 'step_finished',
    outcome: 'success',
    summary: 'Implemented feature using key sk-abc123456789SECRET and token=supersecretvalue99',
    files: [{ path: 'src/app.js', status: 'M' }],
    quality: { testsPassed: true, score: 1 },
    decision: 'approved',
  });

  assert.ok(entry);
  assert.equal(entry.version, 1);
  assert.ok(entry.id.startsWith('led-'));
  assert.equal(entry.workspaceId, 'ws-abc123');
  assert.equal(entry.sessionId, 'sid-2024-01');
  assert.equal(entry.projectId, 'project-xyz');
  assert.equal(entry.transition, 'step_finished');
  assert.equal(entry.outcome, 'success');
  assert.equal(entry.decision, 'approved');
  assert.ok(!entry.summary.includes('sk-abc123456789SECRET'));
  assert.match(entry.summary, /REDACTED/);
  assert.ok(entry.summary.length <= 280);
  assert.equal(entry.files[0].path, 'src/app.js');

  const listed = ledger.list({ workspaceId: 'ws-abc123' });
  assert.equal(listed.total, 1);
  assert.equal(listed.entries[0].id, entry.id);
});

test('redactText strips common secret patterns', () => {
  assert.match(ledger.redactText('Bearer abcdefghijklmnop'), /REDACTED/);
  assert.match(ledger.redactText('api_key=mysecretvaluehere'), /REDACTED/);
  assert.ok(!ledger.redactText('ghp_' + 'x'.repeat(30)).includes('ghp_xxx'));
});

test('invalid ids are dropped rather than stored', (t) => {
  const dir = tempLedger();
  t.after(() => {
    ledger.resetConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const entry = ledger.append({
    workspaceId: '../etc/passwd',
    sessionId: 'ok-sid',
    transition: 'run_started',
    outcome: 'started',
    summary: 'hi',
  });
  assert.equal(entry.workspaceId, '');
  assert.equal(entry.sessionId, 'ok-sid');
});

test('corrupt lines are skipped without losing valid entries', (t) => {
  const dir = tempLedger();
  t.after(() => {
    ledger.resetConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const a = ledger.append({
    workspaceId: 'ws1',
    sessionId: 's1',
    transition: 'run_started',
    outcome: 'started',
    summary: 'first',
  });
  const file = path.join(dir, 'entries.jsonl');
  fs.appendFileSync(file, '{not valid json\n');
  fs.appendFileSync(file, '{"noId":true}\n');
  const b = ledger.append({
    workspaceId: 'ws1',
    sessionId: 's1',
    transition: 'run_finished',
    outcome: 'success',
    summary: 'second',
  });
  const listed = ledger.list({ workspaceId: 'ws1' });
  assert.equal(listed.total, 2);
  assert.ok(listed.skippedCorrupt >= 2);
  const ids = listed.entries.map((e) => e.id).sort();
  assert.deepEqual(ids.sort(), [a.id, b.id].sort());
});

test('CSV export neutralizes spreadsheet formula injection', (t) => {
  const dir = tempLedger();
  t.after(() => {
    ledger.resetConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  ledger.append({
    workspaceId: 'ws1',
    sessionId: 's1',
    transition: 'run_finished',
    outcome: 'success',
    summary: '=cmd|"/c calc"!A0',
  });
  const csv = ledger.exportCsv({ workspaceId: 'ws1' });
  assert.match(csv, /"'=cmd/);
  assert.ok(!csv.split('\r\n').some((line) => line.includes(',"=cmd')));
});

test('JSON export is bounded and scoped', (t) => {
  const dir = tempLedger();
  t.after(() => {
    ledger.resetConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  ledger.append({
    workspaceId: 'wsA',
    sessionId: 'sA',
    transition: 'run_started',
    outcome: 'started',
    summary: 'a',
  });
  ledger.append({
    workspaceId: 'wsB',
    sessionId: 'sB',
    transition: 'run_started',
    outcome: 'started',
    summary: 'b',
  });
  const payload = ledger.exportJson({ workspaceId: 'wsA', limit: 10 });
  assert.equal(payload.version, 1);
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].workspaceId, 'wsA');
  assert.ok(payload.exportedAt);
});

test('buildEntry never keeps prompt-like unbounded fields', () => {
  const entry = ledger.buildEntry({
    transition: 'run_started',
    outcome: 'started',
    prompt: 'SECRET PROMPT SHOULD NOT APPEAR',
    env: { API_KEY: 'x' },
    summary: 'ok',
  });
  assert.equal(entry.prompt, undefined);
  assert.equal(entry.env, undefined);
  assert.equal(entry.summary, 'ok');
});

test('normalizeTransition maps known and unknown values', () => {
  assert.equal(ledger.normalizeTransition('pending-integration'), 'pending_integration');
  assert.equal(ledger.normalizeTransition('totally-unknown'), 'recovery');
});
