'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  evaluateQualityGate,
  integrationBlockReason,
  QUALITY_GATE_VERSION,
} = require('../lib/quality_gate');

function baseEditTask(overrides = {}) {
  return {
    mode: 'edit',
    status: 'review',
    worktreeId: 'wt-1',
    acceptanceCriteria: [],
    acceptanceState: [],
    evidence: [
      {
        kind: 'pending-integration',
        worktreeId: 'wt-1',
        diffSummary: '1 file changed',
        hasDiff: true,
      },
    ],
    reviewResult: null,
    ...overrides,
  };
}

test('quality gate version is deterministic and never uses confidence', () => {
  const gate = evaluateQualityGate(baseEditTask());
  assert.equal(gate.version, QUALITY_GATE_VERSION);
  assert.ok(['pass', 'blocked', 'incomplete'].includes(gate.status));
  assert.ok(Array.isArray(gate.reasons));
  assert.ok(Array.isArray(gate.evidence));
  assert.ok(gate.evaluatedAt);
  assert.ok(gate.score && typeof gate.score.value === 'number');
  assert.match(gate.score.note, /rule-based/i);
  const blob = JSON.stringify(gate);
  assert.equal(/confidence\s*%/i.test(blob), false);
});

test('plan mode never blocks planning', () => {
  const gate = evaluateQualityGate({
    mode: 'plan',
    status: 'in_progress',
    evidence: [{ kind: 'error', severity: 'error', summary: 'x' }],
  });
  assert.equal(gate.blocksPlanning, false);
});

test('REQUEST_CHANGES review blocks ready to integrate', () => {
  const gate = evaluateQualityGate(
    baseEditTask({
      reviewResult: {
        verdict: 'REQUEST_CHANGES',
        parseStatus: 'ok',
        findings: [{ id: 'F1', severity: 'high', summary: 'bug' }],
      },
    })
  );
  assert.equal(gate.status, 'blocked');
  assert.equal(gate.readyToIntegrate, false);
  const reviewEv = gate.evidence.find((e) => e.kind === 'review');
  assert.equal(reviewEv.status, 'blocked');
});

test('unparseable review is incomplete not pass', () => {
  const gate = evaluateQualityGate(
    baseEditTask({
      reviewResult: {
        verdict: null,
        parseStatus: 'incomplete',
        findings: [],
      },
    }),
    { requireReview: true }
  );
  assert.equal(gate.status, 'incomplete');
  assert.equal(gate.readyToIntegrate, false);
});

test('PASS review with diff allows readyToIntegrate', () => {
  const gate = evaluateQualityGate(
    baseEditTask({
      reviewResult: {
        verdict: 'PASS',
        parseStatus: 'ok',
        findings: [],
      },
    })
  );
  assert.equal(gate.readyToIntegrate, true);
  const block = integrationBlockReason(
    baseEditTask({
      reviewResult: {
        verdict: 'PASS',
        parseStatus: 'ok',
        findings: [],
      },
    }),
    { humanApproved: true }
  );
  assert.equal(block, null);
});

test('failed check commands block the gate', () => {
  const gate = evaluateQualityGate(
    baseEditTask({
      evidence: [
        {
          kind: 'pending-integration',
          worktreeId: 'wt-1',
          diffSummary: '1 file',
          hasDiff: true,
        },
        { kind: 'test', ok: false, summary: 'npm test failed', exitCode: 1 },
      ],
    })
  );
  assert.equal(gate.status, 'blocked');
  assert.equal(gate.readyToIntegrate, false);
});

test('provider failure / cancellation blocks', () => {
  const failed = evaluateQualityGate(
    baseEditTask({
      status: 'failed',
      statusReason: 'provider blew up',
      evidence: [{ kind: 'error', severity: 'error', providerFailure: true, error: '429' }],
    })
  );
  assert.equal(failed.status, 'blocked');

  const cancelled = evaluateQualityGate(
    baseEditTask({
      status: 'cancelled',
      evidence: [{ kind: 'cancelled' }],
    })
  );
  assert.equal(cancelled.status, 'blocked');
});

test('integration blocked without override when review incomplete', () => {
  const task = baseEditTask({
    reviewResult: { verdict: null, parseStatus: 'incomplete', findings: [] },
  });
  const block = integrationBlockReason(task, {
    humanApproved: true,
    requireReview: true,
  });
  assert.ok(block);
  assert.match(block.error, /overrideReason|Quality gate/i);
});

test('explicit overrideReason allows integrate despite blocked review', () => {
  const task = baseEditTask({
    reviewResult: {
      verdict: 'REQUEST_CHANGES',
      parseStatus: 'ok',
      findings: [{ id: 'F1', severity: 'high', summary: 'bug' }],
    },
  });
  const block = integrationBlockReason(task, {
    humanApproved: true,
    overrideReason: 'ship hotfix after manual read',
  });
  assert.equal(block, null);
  const gate = evaluateQualityGate(task, {
    humanApproved: true,
    attemptingIntegrate: true,
    overrideReason: 'ship hotfix after manual read',
  });
  assert.equal(gate.canIntegrate, true);
  assert.equal(gate.overrideApplied, true);
});

test('unmet acceptance criteria block', () => {
  const gate = evaluateQualityGate(
    baseEditTask({
      acceptanceCriteria: ['tests pass'],
      acceptanceState: [{ criterion: 'tests pass', status: 'unmet' }],
    })
  );
  assert.equal(gate.status, 'blocked');
});

test('missing diff for edit awaiting integrate is incomplete', () => {
  const gate = evaluateQualityGate(
    baseEditTask({
      evidence: [],
      worktreeId: 'wt-1',
      status: 'review',
    })
  );
  const diff = gate.evidence.find((e) => e.kind === 'diff');
  assert.equal(diff.status, 'incomplete');
  assert.equal(gate.readyToIntegrate, false);
});
