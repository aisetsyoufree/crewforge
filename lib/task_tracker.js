'use strict';

const tasks = require('./tasks');

function memberOwner(member) {
  if (!member) return '';
  const role = member.role ? ` (${member.role})` : '';
  return `${member.adapter || ''}${member.model ? ' - ' + member.model : ''}${role}`;
}

function summarizeText(text, max = 240) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function createProjectFromPlan({ ws, sid, team, prompt, steps, approvalMode }) {
  const lead = team.members[team.leadIndex] || team.members[0];
  const project = tasks.createSessionProject({
    objective: String(prompt || ''),
    teamId: String(team.id || ''),
    leadName: memberOwner(lead),
    workspaceId: String(ws || ''),
    sessionId: String(sid || ''),
  });

  const prevTaskIds = [];
  const created = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const member = team.members[step.memberIndex];
    const depIndexes = Array.isArray(step.dependencies) ? step.dependencies : i > 0 ? [i - 1] : [];
    const deps = depIndexes.map((idx) => {
      const n = Number(idx);
      if (!Number.isInteger(n) || n < 0 || n >= i)
        throw new Error(`invalid dependency at step ${i + 1}`);
      return prevTaskIds[n];
    });

    const task = tasks.createTrackedTask(project.id, {
      title: `Step ${i + 1}`,
      objective: step.task,
      owner: memberOwner(member),
      memberIndex: step.memberIndex,
      adapter: member && member.adapter,
      model: member && member.model,
      role: member && (member.role || ''),
      skillId: member && member.skillId,
      mode: approvalMode === 'plan' ? 'plan' : step.mode || 'edit',
      dependencies: deps,
      planStepIndex: i,
      acceptanceCriteria: Array.isArray(step.acceptanceCriteria)
        ? step.acceptanceCriteria.map((item) => String(item)).filter(Boolean)
        : [],
      status: 'planned',
    });
    prevTaskIds.push(task.id);
    created.push(task);
  }

  tasks.refreshDependencyStates(project.id);
  return { project, tasks: created };
}

function findProjectForSession(ws, sid) {
  return tasks.findLatestProject({ workspaceId: ws, sessionId: sid });
}

function findProjectForWorktree(ws, sid, worktreeId) {
  return tasks.findProjectByWorktree({ workspaceId: ws, sessionId: sid, worktreeId });
}

function onPlanApproved(projectId) {
  tasks.updateProject(projectId, { status: 'running', phase: 'implementation' });
  tasks.refreshDependencyStates(projectId);
}

function validateAndSyncApprovedPlan(projectId, team, steps) {
  const project = tasks.getProject(projectId);
  if (!project || project.status !== 'planning')
    throw new Error('task project is not awaiting approval');
  const tracked = tasks.listTasks(projectId);
  if (tracked.length !== steps.length) throw new Error('approved plan does not match task project');
  for (let i = 0; i < steps.length; i++) {
    const task = tracked.find((item) => item.planStepIndex === i);
    const step = steps[i];
    const member = team.members[step.memberIndex];
    if (!task || task.memberIndex !== step.memberIndex || !member) {
      throw new Error('approved plan does not match task project');
    }
    tasks.updateTask(projectId, task.id, {
      objective: step.task,
      acceptanceCriteria: Array.isArray(step.acceptanceCriteria)
        ? step.acceptanceCriteria
        : task.acceptanceCriteria,
    });
  }
}

function taskForPlanStep(projectId, planStepIndex) {
  return tasks.getTaskByPlanStep(projectId, planStepIndex);
}

function addEvidence(projectId, taskId, item) {
  return tasks.appendEvidence(projectId, taskId, item);
}

function onStepStart(projectId, planStepIndex, { displayStep, total, mode }) {
  const task = taskForPlanStep(projectId, planStepIndex);
  if (!task) return null;
  tasks.transitionTask(projectId, task.id, 'in_progress', { incrementAttempt: true });
  addEvidence(projectId, task.id, {
    kind: 'start',
    displayStep,
    total,
    mode,
  });
  return task.id;
}

function onStepAwaitingIntegration(
  projectId,
  planStepIndex,
  { displayStep, worktreeId, branch, diffSummary }
) {
  const task = taskForPlanStep(projectId, planStepIndex);
  if (!task) return null;
  tasks.transitionTask(projectId, task.id, 'review', {
    worktreeId,
    branch,
    statusReason: 'Awaiting worktree integration',
  });
  addEvidence(projectId, task.id, {
    kind: 'pending-integration',
    displayStep,
    worktreeId,
    branch,
    diffSummary,
  });
  return task.id;
}

function onStepFinished(projectId, planStepIndex, { displayStep, summary }) {
  const task = taskForPlanStep(projectId, planStepIndex);
  if (!task) return null;
  tasks.transitionTask(projectId, task.id, 'done');
  addEvidence(projectId, task.id, {
    kind: 'complete',
    displayStep,
    summary: summarizeText(summary),
  });
  tasks.refreshDependencyStates(projectId);
  maybeCompleteProject(projectId);
  return task.id;
}

function onStepFailed(projectId, planStepIndex, { displayStep, error, worktreeId }) {
  const task = taskForPlanStep(projectId, planStepIndex);
  if (!task) return null;
  tasks.transitionTask(projectId, task.id, 'failed', {
    statusReason: summarizeText(error, 400),
    worktreeId: worktreeId || undefined,
  });
  addEvidence(projectId, task.id, {
    kind: 'error',
    displayStep,
    error: summarizeText(error, 400),
    worktreeId: worktreeId || undefined,
  });
  tasks.refreshDependencyStates(projectId);
  tasks.updateProject(projectId, { status: 'blocked', phase: 'review' });
  return task.id;
}

function onRunAborted(projectId, planStepIndex, { displayStep, worktreeId, partial }) {
  const task = taskForPlanStep(projectId, planStepIndex);
  if (!task) return null;
  if (partial && worktreeId) {
    tasks.transitionTask(projectId, task.id, 'review', {
      worktreeId,
      statusReason: 'Run cancelled — partial work retained for review',
    });
    addEvidence(projectId, task.id, {
      kind: 'cancelled-worktree',
      displayStep,
      worktreeId,
    });
  } else {
    tasks.transitionTask(projectId, task.id, 'cancelled', {
      statusReason: 'Run stopped by user',
    });
    addEvidence(projectId, task.id, { kind: 'cancelled', displayStep });
    tasks.refreshDependencyStates(projectId);
  }
  tasks.updateProject(projectId, { status: 'cancelled', phase: 'summary' });
  return task.id;
}

function onIntegrated(projectId, worktreeId) {
  const task = tasks.findTaskByWorktree(projectId, worktreeId);
  if (!task) return null;
  tasks.transitionTask(projectId, task.id, 'done', { statusReason: '' });
  addEvidence(projectId, task.id, { kind: 'integrated', worktreeId });
  tasks.refreshDependencyStates(projectId);
  maybeCompleteProject(projectId);
  return task.id;
}

function onRejected(projectId, worktreeId, { reason, asChangesRequested }) {
  const task = tasks.findTaskByWorktree(projectId, worktreeId);
  if (!task) return null;
  const next = asChangesRequested ? 'changes_requested' : 'failed';
  tasks.transitionTask(projectId, task.id, next, {
    statusReason: summarizeText(reason || 'Worktree rejected', 400),
  });
  addEvidence(projectId, task.id, {
    kind: 'rejected',
    worktreeId,
    reason: summarizeText(reason || 'Worktree rejected', 400),
  });
  tasks.refreshDependencyStates(projectId);
  if (next === 'failed') tasks.updateProject(projectId, { status: 'blocked', phase: 'review' });
  return task.id;
}

function onIntegrationFailed(projectId, worktreeId, error) {
  const task = tasks.findTaskByWorktree(projectId, worktreeId);
  if (!task) return null;
  addEvidence(projectId, task.id, {
    kind: 'integration-failed',
    worktreeId,
    error: summarizeText(error, 400),
  });
  return task.id;
}

function maybeCompleteProject(projectId) {
  const list = tasks.listTasks(projectId);
  if (!list.length) return;
  const terminal = new Set([
    'done',
    'complete',
    'approved',
    'failed',
    'cancelled',
    'changes_requested',
  ]);
  if (list.every((t) => terminal.has(t.status))) {
    const anyFailed = list.some((t) =>
      ['failed', 'cancelled', 'changes_requested'].includes(t.status)
    );
    tasks.updateProject(projectId, {
      status: anyFailed ? 'blocked' : 'complete',
      phase: 'done',
    });
  }
}

function buildOrchestratorTracking(projectId) {
  if (!projectId) return null;
  return {
    onStepStart(ctx) {
      onStepStart(projectId, ctx.planStepIndex, ctx);
    },
    onStepAwaitingIntegration(ctx) {
      onStepAwaitingIntegration(projectId, ctx.planStepIndex, ctx);
    },
    onStepFinished(ctx) {
      onStepFinished(projectId, ctx.planStepIndex, ctx);
    },
    onStepFailed(ctx) {
      onStepFailed(projectId, ctx.planStepIndex, ctx);
    },
    onRunAborted(ctx) {
      onRunAborted(projectId, ctx.planStepIndex, ctx);
    },
  };
}

function projectView(projectId) {
  const data = tasks.loadProjectBundle(projectId);
  if (!data) return null;
  return {
    project: data.project,
    tasks: tasks.listTasks(projectId).map((task) => tasks.taskPublicView(task)),
    counts: tasks.statusCounts(projectId),
  };
}

function listProjectsForSession(ws, sid) {
  return tasks.listProjects({ workspaceId: ws, sessionId: sid }).map((project) => ({
    project,
    counts: tasks.statusCounts(project.id),
  }));
}

module.exports = {
  createProjectFromPlan,
  findProjectForSession,
  findProjectForWorktree,
  onPlanApproved,
  validateAndSyncApprovedPlan,
  buildOrchestratorTracking,
  onStepStart,
  onStepAwaitingIntegration,
  onStepFinished,
  onStepFailed,
  onRunAborted,
  onIntegrated,
  onRejected,
  onIntegrationFailed,
  projectView,
  listProjectsForSession,
  taskForPlanStep,
};
