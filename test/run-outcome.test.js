'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { adapterRunError, finishDirectRun } = require('../lib/run_outcome');

function mockStore() {
  const events = [];
  return {
    events,
    append(ws, sid, event) {
      events.push({ ws, sid, event });
    },
  };
}

test('adapterRunError normalizes string and boolean errors', () => {
  assert.equal(adapterRunError({ error: 'cli exited with code 1' }), 'cli exited with code 1');
  assert.equal(adapterRunError({ error: true }), 'agent run failed');
  assert.equal(adapterRunError({ finalText: 'ok' }), null);
});

test('finishDirectRun records failure without success status', () => {
  const store = mockStore();
  finishDirectRun(store, 'ws1', 'sid1', 'codex', {
    aborted: false,
    result: { error: 'boom' },
    meta: { createCapsule: false },
  });
  assert.equal(store.events.length, 2);
  assert.equal(store.events[0].event.type, 'error');
  assert.equal(store.events[1].event.meta.failed, true);
  assert.match(store.events[1].event.text, /failed/);
});

test('finishDirectRun records success only when adapter succeeded', () => {
  const store = mockStore();
  finishDirectRun(store, 'ws1', 'sid1', 'claude', {
    aborted: false,
    result: { finalText: 'done' },
  });
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].event.meta.done, true);
  assert.equal(store.events[0].event.meta.failed, undefined);
});

test('finishDirectRun skips completion when run was aborted', () => {
  const store = mockStore();
  finishDirectRun(store, 'ws1', 'sid1', 'claude', {
    aborted: true,
    result: { finalText: 'done' },
    meta: { createCapsule: false },
  });
  // Capsule creation disabled: no session events.
  assert.equal(store.events.length, 0);
});

test('finishDirectRun records ledger success and failure transitions', () => {
  const store = mockStore();
  const ledgerEntries = [];
  const ledger = {
    append(entry) {
      ledgerEntries.push(entry);
      return entry;
    },
  };

  finishDirectRun(store, 'ws1', 'sid1', 'claude', {
    aborted: false,
    result: { finalText: 'done' },
    ledger,
    meta: { provider: 'claude', model: 'sonnet', mode: 'plan' },
  });
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0].transition, 'run_finished');
  assert.equal(ledgerEntries[0].outcome, 'success');

  finishDirectRun(store, 'ws1', 'sid1', 'codex', {
    aborted: false,
    result: { error: 'boom' },
    ledger,
    meta: { provider: 'codex', mode: 'edit', createCapsule: false },
  });
  assert.equal(ledgerEntries[1].transition, 'run_failed');
  assert.equal(ledgerEntries[1].outcome, 'failure');

  finishDirectRun(store, 'ws1', 'sid1', 'claude', {
    aborted: true,
    result: { finalText: 'x' },
    ledger,
    meta: { review: true, mode: 'review', createCapsule: false },
  });
  assert.equal(ledgerEntries[2].transition, 'run_cancelled');
});
