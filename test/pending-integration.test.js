'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { continuationFromPending, findUnresolvedPending } = require('../lib/pending_integration');

const pending = {
  type: 'pending-integration',
  meta: {
    worktreeId: 'wt-1',
    continuation: {
      version: 1,
      team: { members: [{ adapter: 'codex' }] },
      approvalMode: 'edit',
      remainingSteps: [{ memberIndex: 0, task: 'next' }],
      nextStepOffset: 1,
      totalSteps: 2,
    },
  },
};

test('findUnresolvedPending returns only an unresolved server event', () => {
  assert.equal(findUnresolvedPending([pending], 'wt-1'), pending);
  assert.equal(
    findUnresolvedPending([pending, { type: 'integrated', meta: { worktreeId: 'wt-1' } }], 'wt-1'),
    null
  );
  assert.equal(findUnresolvedPending([pending], 'other'), null);
});

test('continuationFromPending validates durable continuation data', () => {
  assert.deepEqual(continuationFromPending(pending), pending.meta.continuation);
  assert.equal(
    continuationFromPending({
      ...pending,
      meta: { ...pending.meta, continuation: { version: 1 } },
    }),
    null
  );
});
