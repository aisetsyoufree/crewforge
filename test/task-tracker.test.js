const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const tasks = require('../lib/tasks');
const taskTracker = require('../lib/task_tracker');

const projectsDir = path.join(__dirname, '..', 'data', 'projects');
const projectPath = (id) => path.join(projectsDir, `${id}.json`);

function cleanupProject(id) {
  if (id && fs.existsSync(projectPath(id))) fs.unlinkSync(projectPath(id));
}

test('createProjectFromPlan builds linear tasks in planned state', () => {
  let projectId;
  try {
    const { project, tasks: created } = taskTracker.createProjectFromPlan({
      ws: 'ws-test',
      sid: 'sid-test',
      team: {
        id: 'team-1',
        leadIndex: 0,
        members: [
          { adapter: 'grok', model: 'fast', role: 'Lead' },
          { adapter: 'claude', model: 'sonnet', role: 'Dev' },
        ],
      },
      prompt: 'Ship tracker',
      steps: [
        { memberIndex: 0, task: 'Plan work' },
        { memberIndex: 1, task: 'Implement', acceptanceCriteria: ['tests pass'] },
      ],
      approvalMode: 'edit',
    });
    projectId = project.id;
    assert.strictEqual(project.workspaceId, 'ws-test');
    assert.strictEqual(project.sessionId, 'sid-test');
    assert.strictEqual(created.length, 2);
    assert.strictEqual(created[0].status, 'planned');
    assert.strictEqual(created[1].dependencies.length, 1);
    assert.deepStrictEqual(created[1].acceptanceCriteria, ['tests pass']);
    taskTracker.onPlanApproved(projectId);
    const ready = tasks.readyTasks(projectId);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].status, 'ready');
  } finally {
    cleanupProject(projectId);
  }
});

test('orchestration hooks move tasks through review and integration', () => {
  let projectId;
  try {
    const { project } = taskTracker.createProjectFromPlan({
      ws: 'ws-a',
      sid: 'sid-a',
      team: {
        id: 'team-1',
        leadIndex: 0,
        members: [{ adapter: 'grok', model: 'fast', role: 'Dev' }],
      },
      prompt: 'One step',
      steps: [{ memberIndex: 0, task: 'Edit files' }],
      approvalMode: 'edit',
    });
    projectId = project.id;
    taskTracker.onPlanApproved(projectId);
    taskTracker.onStepStart(projectId, 0, { displayStep: 1, total: 1, mode: 'edit' });
    let task = tasks.getTaskByPlanStep(projectId, 0);
    assert.strictEqual(task.status, 'in_progress');
    assert.strictEqual(task.attempts, 1);
    taskTracker.onStepAwaitingIntegration(projectId, 0, {
      displayStep: 1,
      worktreeId: 'wt-abc',
      branch: 'crewforge/wt-abc',
      diffSummary: '1 file',
    });
    task = tasks.getTaskByPlanStep(projectId, 0);
    assert.strictEqual(task.status, 'review');
    assert.strictEqual(task.worktreeId, 'wt-abc');
    taskTracker.onIntegrated(projectId, 'wt-abc');
    task = tasks.getTaskByPlanStep(projectId, 0);
    assert.strictEqual(task.status, 'done');
    const updatedProject = tasks.getProject(projectId);
    assert.strictEqual(updatedProject.status, 'complete');
  } finally {
    cleanupProject(projectId);
  }
});

test('failed dependency blocks downstream tasks', () => {
  let projectId;
  try {
    const { project } = taskTracker.createProjectFromPlan({
      ws: 'ws-b',
      sid: 'sid-b',
      team: {
        id: 'team-1',
        leadIndex: 0,
        members: [
          { adapter: 'grok', model: 'fast' },
          { adapter: 'claude', model: 'sonnet' },
        ],
      },
      prompt: 'Two steps',
      steps: [
        { memberIndex: 0, task: 'First' },
        { memberIndex: 1, task: 'Second' },
      ],
      approvalMode: 'edit',
    });
    projectId = project.id;
    taskTracker.onPlanApproved(projectId);
    taskTracker.onStepFailed(projectId, 0, { displayStep: 1, error: 'boom' });
    const second = tasks.getTaskByPlanStep(projectId, 1);
    assert.strictEqual(second.status, 'blocked');
    assert.match(second.statusReason, /failed step/i);
  } finally {
    cleanupProject(projectId);
  }
});

test('reject marks task failed and records evidence', () => {
  let projectId;
  try {
    const { project } = taskTracker.createProjectFromPlan({
      ws: 'ws-c',
      sid: 'sid-c',
      team: {
        id: 'team-1',
        leadIndex: 0,
        members: [{ adapter: 'grok', model: 'fast' }],
      },
      prompt: 'Reject path',
      steps: [{ memberIndex: 0, task: 'Edit' }],
      approvalMode: 'edit',
    });
    projectId = project.id;
    taskTracker.onPlanApproved(projectId);
    taskTracker.onStepStart(projectId, 0, { displayStep: 1, total: 1, mode: 'edit' });
    taskTracker.onStepAwaitingIntegration(projectId, 0, {
      displayStep: 1,
      worktreeId: 'wt-reject',
      branch: 'b',
      diffSummary: '',
    });
    taskTracker.onRejected(projectId, 'wt-reject', { reason: 'not good enough' });
    const task = tasks.getTaskByPlanStep(projectId, 0);
    assert.strictEqual(task.status, 'failed');
    assert.ok(task.evidence.some((e) => e.kind === 'rejected'));
  } finally {
    cleanupProject(projectId);
  }
});

test('worktree lookup resolves the owning project instead of the latest session project', () => {
  let firstId;
  let secondId;
  try {
    const team = {
      id: 'team-1',
      leadIndex: 0,
      members: [{ adapter: 'grok', model: 'fast' }],
    };
    const first = taskTracker.createProjectFromPlan({
      ws: 'ws-shared',
      sid: 'sid-shared',
      team,
      prompt: 'First',
      steps: [{ memberIndex: 0, task: 'First edit' }],
      approvalMode: 'edit',
    });
    firstId = first.project.id;
    taskTracker.onPlanApproved(firstId);
    taskTracker.onStepStart(firstId, 0, { displayStep: 1, total: 1, mode: 'edit' });
    taskTracker.onStepAwaitingIntegration(firstId, 0, {
      displayStep: 1,
      worktreeId: 'wt-owned',
      branch: 'crewforge/wt-owned',
      diffSummary: '1 file',
    });

    const second = taskTracker.createProjectFromPlan({
      ws: 'ws-shared',
      sid: 'sid-shared',
      team,
      prompt: 'Second',
      steps: [{ memberIndex: 0, task: 'Second edit' }],
      approvalMode: 'edit',
    });
    secondId = second.project.id;

    const owner = taskTracker.findProjectForWorktree('ws-shared', 'sid-shared', 'wt-owned');
    assert.strictEqual(owner.id, firstId);
  } finally {
    cleanupProject(firstId);
    cleanupProject(secondId);
  }
});

test('approval validates project identity and syncs edited task text', () => {
  let projectId;
  try {
    const team = {
      id: 'team-approve',
      leadIndex: 0,
      members: [{ adapter: 'claude', model: 'sonnet', role: 'Developer' }],
    };
    const created = taskTracker.createProjectFromPlan({
      ws: 'ws-approve',
      sid: 'sid-approve',
      team,
      prompt: 'Approval contract',
      steps: [{ memberIndex: 0, task: 'Draft task', acceptanceCriteria: ['original'] }],
      approvalMode: 'plan',
    });
    projectId = created.project.id;
    taskTracker.validateAndSyncApprovedPlan(projectId, team, [
      { memberIndex: 0, task: 'User-edited task', acceptanceCriteria: ['preserved'] },
    ]);
    const task = tasks.getTaskByPlanStep(projectId, 0);
    assert.strictEqual(task.objective, 'User-edited task');
    assert.deepStrictEqual(task.acceptanceCriteria, ['preserved']);
    assert.throws(
      () => taskTracker.validateAndSyncApprovedPlan(projectId, team, []),
      /does not match/
    );
  } finally {
    cleanupProject(projectId);
  }
});
