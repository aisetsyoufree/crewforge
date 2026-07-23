'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repairLoop = require('../lib/repair_loop');
const tasks = require('../lib/tasks');
const taskTracker = require('../lib/task_tracker');
const ledger = require('../lib/ledger');

const projectsDir = path.join(require('../lib/data_dir'), 'projects');
const projectPath = (id) => path.join(projectsDir, `${id}.json`);

function cleanupProject(id) {
  if (id && fs.existsSync(projectPath(id))) fs.unlinkSync(projectPath(id));
}

function editTaskWithRequestChanges(overrides = {}) {
  return {
    mode: 'edit',
    status: 'changes_requested',
    adapter: 'claude',
    model: 'sonnet',
    role: 'Dev',
    objective: 'Fix the bug',
    acceptanceCriteria: ['tests pass'],
    worktreeId: 'wt-repair',
    repair: {
      enabled: true,
      maxIterations: 2,
      attempt: 0,
      status: 'idle',
      stopReason: null,
      lastFindingSet: '',
      history: [],
    },
    reviewResult: {
      verdict: 'REQUEST_CHANGES',
      parseStatus: 'ok',
      findings: [{ id: 'F1', severity: 'high', summary: 'Null deref', file: 'lib/x.js' }],
    },
    ...overrides,
  };
}

test('setting validation clamps and rejects out of range', () => {
  assert.equal(repairLoop.clampRepairIterations(undefined), 2);
  assert.equal(repairLoop.clampRepairIterations(-3), 0);
  assert.equal(repairLoop.clampRepairIterations(99), 5);
  assert.equal(repairLoop.clampRepairIterations(3), 3);
  assert.equal(repairLoop.validateRepairIterations(2).ok, true);
  assert.equal(repairLoop.validateRepairIterations(6).ok, false);
  assert.equal(repairLoop.validateRepairIterations(-1).ok, false);
  assert.equal(repairLoop.validateRepairIterations(1.5).ok, false);
  assert.equal(repairLoop.normalizeAutoRepair(undefined), false);
  assert.equal(repairLoop.normalizeAutoRepair(true), true);
});

test('auto repair default OFF stops decision', () => {
  const d = repairLoop.decideRepair(editTaskWithRequestChanges({ repair: { enabled: false } }), {
    autoRepair: false,
  });
  assert.equal(d.action, 'stop');
  assert.equal(d.stopReason, 'auto_repair_disabled');
});

test('starts repair for original implementer when enabled', () => {
  const d = repairLoop.decideRepair(editTaskWithRequestChanges(), { autoRepair: true });
  assert.equal(d.action, 'repair');
  assert.equal(d.attempt, 1);
  assert.equal(d.implementer.adapter, 'claude');
  assert.equal(d.implementer.model, 'sonnet');
  assert.match(d.prompt, /Null deref/);
  assert.match(d.prompt, /tests pass/);
});

test('stop on PASS evidence', () => {
  const d = repairLoop.decideRepair(
    editTaskWithRequestChanges({
      reviewResult: { verdict: 'PASS', parseStatus: 'ok', findings: [] },
    }),
    { autoRepair: true }
  );
  assert.equal(d.action, 'stop');
  assert.equal(d.stopReason, 'pass');
});

test('incomplete or unparseable review never starts repair', () => {
  const incomplete = repairLoop.decideRepair(
    editTaskWithRequestChanges({
      reviewResult: {
        verdict: 'REQUEST_CHANGES',
        parseStatus: 'incomplete',
        findings: [{ id: 'F1', severity: 'high', summary: 'maybe', file: 'a.js' }],
      },
    }),
    { autoRepair: true }
  );
  assert.equal(incomplete.action, 'stop');
  assert.equal(incomplete.stopReason, 'no_request_changes');

  const missing = repairLoop.decideRepair(
    editTaskWithRequestChanges({
      reviewResult: {
        verdict: 'REQUEST_CHANGES',
        // parseStatus omitted / unparseable
        findings: [],
      },
    }),
    { autoRepair: true }
  );
  assert.equal(missing.action, 'stop');
  assert.equal(missing.stopReason, 'no_request_changes');

  const nullVerdict = repairLoop.decideRepair(
    editTaskWithRequestChanges({
      reviewResult: { verdict: null, parseStatus: 'incomplete', findings: [] },
    }),
    { autoRepair: true }
  );
  assert.equal(nullVerdict.action, 'stop');
  assert.equal(nullVerdict.stopReason, 'no_request_changes');
});

test('stop on max attempts', () => {
  const d = repairLoop.decideRepair(
    editTaskWithRequestChanges({
      repair: {
        enabled: true,
        maxIterations: 2,
        attempt: 2,
        status: 'idle',
        lastFindingSet: '',
        history: [],
      },
    }),
    { autoRepair: true, maxIterations: 2 }
  );
  assert.equal(d.action, 'stop');
  assert.equal(d.stopReason, 'max_attempts');
});

test('stop on unchanged normalized finding set', () => {
  const findings = [{ id: 'F1', severity: 'high', summary: 'Null deref', file: 'lib/x.js' }];
  const set = require('../lib/review').normalizeFindingSet(findings);
  const d = repairLoop.decideRepair(
    editTaskWithRequestChanges({
      repair: {
        enabled: true,
        maxIterations: 5,
        attempt: 1,
        lastFindingSet: set,
        history: [],
      },
      reviewResult: {
        verdict: 'REQUEST_CHANGES',
        parseStatus: 'ok',
        findings,
      },
    }),
    { autoRepair: true, maxIterations: 5 }
  );
  assert.equal(d.action, 'stop');
  assert.equal(d.stopReason, 'unchanged_findings');
});

test('stop on cancel, provider failure, missing implementer, human stop', () => {
  assert.equal(
    repairLoop.decideRepair(editTaskWithRequestChanges(), {
      autoRepair: true,
      cancelled: true,
    }).stopReason,
    'cancelled'
  );
  assert.equal(
    repairLoop.decideRepair(editTaskWithRequestChanges(), {
      autoRepair: true,
      providerFailure: true,
      rateLimited: true,
    }).stopReason,
    'rate_limit'
  );
  assert.equal(
    repairLoop.decideRepair(editTaskWithRequestChanges({ adapter: '' }), {
      autoRepair: true,
      implementer: { adapter: '' },
    }).stopReason,
    'missing_implementer'
  );
  assert.equal(
    repairLoop.decideRepair(editTaskWithRequestChanges(), {
      autoRepair: true,
      humanStop: true,
    }).stopReason,
    'human_stop'
  );
});

test('hard cap is 5 even if caller asks higher', () => {
  assert.equal(repairLoop.clampRepairIterations(100), 5);
  const d = repairLoop.decideRepair(
    editTaskWithRequestChanges({
      repair: {
        enabled: true,
        maxIterations: 5,
        attempt: 5,
        lastFindingSet: '',
        history: [],
      },
    }),
    { autoRepair: true, maxIterations: 99 }
  );
  assert.equal(d.action, 'stop');
  assert.equal(d.stopReason, 'max_attempts');
});

test('task tracker structured review + repair decision and ledger transitions', () => {
  const ledgerFile = path.join(
    require('node:os').tmpdir(),
    `crewforge-repair-ledger-${Date.now()}.jsonl`
  );
  ledger.configure({ file: ledgerFile });
  ledger._resetForTests();

  let projectId;
  try {
    const { project, tasks: created } = taskTracker.createProjectFromPlan({
      ws: 'ws-repair',
      sid: 'sid-repair',
      team: {
        id: 'team-r',
        leadIndex: 0,
        members: [{ adapter: 'claude', model: 'sonnet', role: 'Dev' }],
        autoRepair: true,
        repairIterations: 2,
      },
      prompt: 'Fix',
      steps: [{ memberIndex: 0, task: 'Implement fix', acceptanceCriteria: ['ok'] }],
      approvalMode: 'edit',
      repairSettings: { autoRepair: true, repairIterations: 2 },
    });
    projectId = project.id;
    const taskId = created[0].id;
    taskTracker.onPlanApproved(projectId);
    taskTracker.onStepStart(projectId, 0, { displayStep: 1, total: 1, mode: 'edit' });
    taskTracker.onStepAwaitingIntegration(projectId, 0, {
      displayStep: 1,
      worktreeId: 'wt-r1',
      branch: 'crewforge/wt-r1',
      diffSummary: '1 file',
    });

    const raw = `
\`\`\`json
{"verdict":"REQUEST_CHANGES","findings":[{"id":"F1","severity":"high","summary":"broken edge case","file":"a.js"}]}
\`\`\`
VERDICT: REQUEST_CHANGES
`;
    const applied = taskTracker.onStructuredReview(projectId, taskId, raw, {
      autoRepair: true,
      maxIterations: 2,
      ledger,
      workspaceId: 'ws-repair',
      sessionId: 'sid-repair',
    });
    assert.equal(applied.review.verdict, 'REQUEST_CHANGES');
    assert.equal(applied.repairDecision.action, 'repair');
    assert.equal(applied.qualityGate.status, 'blocked');

    taskTracker.onRepairStarted(projectId, taskId, applied.repairDecision, {
      ledger,
      workspaceId: 'ws-repair',
      sessionId: 'sid-repair',
    });
    let task = tasks.getTask(projectId, taskId);
    assert.equal(task.repair.attempt, 1);
    assert.equal(task.repair.status, 'running');

    taskTracker.onRepairFinished(
      projectId,
      taskId,
      { success: true },
      { ledger, workspaceId: 'ws-repair', sessionId: 'sid-repair' }
    );
    task = tasks.getTask(projectId, taskId);
    assert.equal(task.repair.status, 'idle');
    assert.equal(task.repair.attempt, 1);

    // Integration blocked while review still REQUEST_CHANGES
    const check = taskTracker.checkIntegrationAllowed(projectId, 'wt-r1');
    assert.equal(check.allowed, false);

    // Override allows integrate path
    const check2 = taskTracker.checkIntegrationAllowed(projectId, 'wt-r1', {
      overrideReason: 'manual accept',
    });
    assert.equal(check2.allowed, true);

    const listed = ledger.list({ workspaceId: 'ws-repair', sessionId: 'sid-repair', limit: 50 });
    const transitions = listed.entries.map((e) => e.transition);
    assert.ok(transitions.includes('quality_evaluated'));
    assert.ok(transitions.includes('repair_started'));
    assert.ok(transitions.includes('repair_finished'));
  } finally {
    cleanupProject(projectId);
    ledger._resetForTests();
    ledger.resetConfig();
    try {
      fs.unlinkSync(ledgerFile);
    } catch {
      // ignore
    }
  }
});

test('iterations zero stops without repair', () => {
  const d = repairLoop.decideRepair(editTaskWithRequestChanges(), {
    autoRepair: true,
    maxIterations: 0,
  });
  assert.equal(d.action, 'stop');
  assert.equal(d.stopReason, 'iterations_zero');
});

test('shouldCreateCapsule for interrupt reasons', () => {
  assert.equal(repairLoop.shouldCreateCapsule('cancelled'), true);
  assert.equal(repairLoop.shouldCreateCapsule('rate_limit'), true);
  assert.equal(repairLoop.shouldCreateCapsule('pass'), false);
  assert.equal(repairLoop.shouldCreateCapsule('max_attempts'), false);
});
