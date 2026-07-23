'use strict';

const tasks = require('./tasks');
const qualityGate = require('./quality_gate');
const review = require('./review');
const repairLoop = require('./repair_loop');

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

function createProjectFromPlan({ ws, sid, team, prompt, steps, approvalMode, repairSettings }) {
  const lead = team.members[team.leadIndex] || team.members[0];
  const project = tasks.createSessionProject({
    objective: String(prompt || ''),
    teamId: String(team.id || ''),
    leadName: memberOwner(lead),
    workspaceId: String(ws || ''),
    sessionId: String(sid || ''),
  });

  const autoRepair = repairLoop.normalizeAutoRepair(
    (repairSettings && repairSettings.autoRepair) != null
      ? repairSettings.autoRepair
      : team && team.autoRepair
  );
  const maxIterations = repairLoop.clampRepairIterations(
    (repairSettings && repairSettings.repairIterations) != null
      ? repairSettings.repairIterations
      : team && team.repairIterations
  );

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
      repair: {
        enabled: autoRepair,
        maxIterations,
        attempt: 0,
        status: 'idle',
        stopReason: null,
        lastFindingSet: '',
        history: [],
      },
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

/**
 * Find the most relevant edit task for attaching a review.
 * When worktreeId is supplied, it must resolve to a concrete task — never fall back
 * to an arbitrary in-review task (wrong assignment risk with multiple edit tasks).
 *
 * @returns {{ project: object, task: object } | null}
 */
function findReviewTargetTask(ws, sid, worktreeId) {
  const wt = worktreeId != null && worktreeId !== '' ? String(worktreeId) : '';
  if (wt) {
    const project = findProjectForWorktree(ws, sid, wt);
    if (!project) {
      const diag = String(wt).slice(0, 80);
      console.warn(`[review] worktreeId did not resolve to a project: ${diag}`);
      return null;
    }
    const byWt = tasks.findTaskByWorktree(project.id, wt);
    if (!byWt) {
      const diag = String(wt).slice(0, 80);
      console.warn(`[review] worktreeId did not resolve to a task: ${diag}`);
      return null;
    }
    return { project, task: byWt };
  }
  const project = findProjectForSession(ws, sid);
  if (!project) return null;
  const list = tasks.listTasks(project.id);
  const preferred = list.find(
    (t) =>
      t.mode === 'edit' &&
      (t.status === 'review' || t.status === 'changes_requested' || t.status === 'in_progress')
  );
  if (preferred) return { project, task: preferred };
  return null;
}

function onPlanApproved(projectId) {
  tasks.updateProject(projectId, { status: 'running', phase: 'implementation' });
  tasks.refreshDependencyStates(projectId);
  recomputeProjectGates(projectId, { phase: 'approval' });
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

/**
 * Recompute and persist quality gate for one task.
 * Never blocks plan-mode planning (blocksPlanning always false).
 */
function recomputeQualityGate(projectId, taskId, options = {}) {
  const task = tasks.getTask(projectId, taskId);
  if (!task) return null;
  const gate = qualityGate.evaluateQualityGate(task, options);
  const compact = qualityGate.compactGateView(gate);
  tasks.setQualityGate(projectId, taskId, compact);
  addEvidence(projectId, taskId, {
    kind: 'quality-gate',
    status: compact.status,
    reasons: compact.reasons,
    readyToIntegrate: compact.readyToIntegrate,
    phase: options.phase || '',
  });
  if (options.ledger && typeof options.ledger.append === 'function') {
    try {
      options.ledger.append({
        workspaceId: options.workspaceId || '',
        sessionId: options.sessionId || '',
        projectId,
        taskId,
        actor: 'system',
        mode: task.mode,
        transition: 'quality_evaluated',
        outcome:
          compact.status === 'pass'
            ? 'success'
            : compact.status === 'blocked'
              ? 'failure'
              : 'pending',
        summary: `Quality gate ${compact.status}`,
        quality: {
          status: compact.status,
          readyToIntegrate: !!compact.readyToIntegrate,
          score: compact.score && compact.score.value,
          version: compact.version,
        },
        decision: compact.status === 'pass' ? 'none' : 'changes_requested',
      });
    } catch {
      // ledger must never break tracker
    }
  }
  return compact;
}

function recomputeProjectGates(projectId, options = {}) {
  const list = tasks.listTasks(projectId);
  const out = [];
  for (const task of list) {
    out.push(recomputeQualityGate(projectId, task.id, options));
  }
  return out;
}

function onStepStart(projectId, planStepIndex, { displayStep, total, mode }) {
  const task = taskForPlanStep(projectId, planStepIndex);
  if (!task) return null;
  // Repair re-entry also uses in_progress.
  if (task.status === 'changes_requested' || task.status === 'review') {
    tasks.transitionTask(projectId, task.id, 'in_progress', { incrementAttempt: true });
  } else {
    tasks.transitionTask(projectId, task.id, 'in_progress', { incrementAttempt: true });
  }
  addEvidence(projectId, task.id, {
    kind: 'start',
    displayStep,
    total,
    mode,
  });
  recomputeQualityGate(projectId, task.id, { phase: 'implementation' });
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
    hasDiff: !!(diffSummary && String(diffSummary).trim()),
  });
  recomputeQualityGate(projectId, task.id, { phase: 'integration' });
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
  recomputeQualityGate(projectId, task.id, { phase: 'implementation' });
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
    severity: 'error',
    providerFailure: /rate.?limit|quota|429|provider/i.test(String(error || '')),
  });
  recomputeQualityGate(projectId, task.id, { phase: 'failure' });
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
  // Stop any in-flight repair bookkeeping.
  if (task.repair && task.repair.status === 'running') {
    const stopped = repairLoop.markRepairFinished(task.repair, {
      success: false,
      stopReason: 'human_stop',
    });
    tasks.setRepairState(projectId, task.id, stopped);
  }
  recomputeQualityGate(projectId, task.id, { phase: 'failure' });
  tasks.updateProject(projectId, { status: 'cancelled', phase: 'summary' });
  return task.id;
}

function onIntegrated(projectId, worktreeId) {
  const task = tasks.findTaskByWorktree(projectId, worktreeId);
  if (!task) return null;
  tasks.transitionTask(projectId, task.id, 'done', { statusReason: '' });
  addEvidence(projectId, task.id, { kind: 'integrated', worktreeId });
  addEvidence(projectId, task.id, { kind: 'human-approved', worktreeId });
  recomputeQualityGate(projectId, task.id, { phase: 'integration', humanApproved: true });
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
  recomputeQualityGate(projectId, task.id, { phase: 'rejection' });
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
    severity: 'error',
  });
  recomputeQualityGate(projectId, task.id, { phase: 'failure' });
  return task.id;
}

/**
 * Apply a structured review verdict to a task (raw text stays in session history only).
 */
function onStructuredReview(projectId, taskId, rawText, options = {}) {
  const task = tasks.getTask(projectId, taskId);
  if (!task) return null;
  const parsed = review.toPersistedReview(review.parseReviewVerdict(rawText));
  tasks.setReview(projectId, taskId, parsed);
  addEvidence(projectId, taskId, {
    kind: 'review',
    verdict: parsed.verdict,
    parseStatus: parsed.parseStatus,
    findingCount: (parsed.findings || []).length,
    // Never store full raw text in evidence.
  });

  if (parsed.verdict === 'REQUEST_CHANGES' && task.mode === 'edit') {
    if (task.status === 'review' || task.status === 'in_progress' || task.status === 'ready') {
      try {
        tasks.transitionTask(projectId, task.id, 'changes_requested', {
          statusReason: 'Reviewer requested changes',
        });
      } catch {
        // status may already allow staying put
      }
    }
  }

  const gate = recomputeQualityGate(projectId, taskId, {
    phase: 'review',
    requireReview: true,
    ledger: options.ledger,
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
  });

  let repairDecision = null;
  if (parsed.verdict === 'REQUEST_CHANGES' && task.mode === 'edit') {
    repairDecision = repairLoop.decideRepair(tasks.getTask(projectId, taskId), {
      autoRepair: options.autoRepair,
      maxIterations: options.maxIterations,
      implementer: {
        adapter: task.adapter,
        model: task.model,
        role: task.role,
        skillId: task.skillId,
        memberIndex: task.memberIndex,
      },
      contextPolicy: options.contextPolicy,
    });
    const nextRepair = repairLoop.applyDecision(task.repair, repairDecision);
    tasks.setRepairState(projectId, taskId, nextRepair);
    if (repairDecision.action === 'stop') {
      addEvidence(projectId, taskId, {
        kind: 'repair-stop',
        stopReason: repairDecision.stopReason,
      });
      if (options.ledger && typeof options.ledger.append === 'function') {
        try {
          options.ledger.append({
            workspaceId: options.workspaceId || '',
            sessionId: options.sessionId || '',
            projectId,
            taskId,
            actor: 'system',
            mode: task.mode,
            transition: 'repair_stopped',
            outcome: repairDecision.stopReason === 'pass' ? 'success' : 'info',
            summary: `Repair stopped: ${repairDecision.stopReason}`,
            decision: 'changes_requested',
            quality: { stopReason: repairDecision.stopReason },
          });
        } catch {
          // ignore
        }
      }
    } else if (repairDecision.action === 'repair') {
      addEvidence(projectId, taskId, {
        kind: 'repair-planned',
        attempt: repairDecision.attempt,
        maxIterations: repairDecision.maxIterations,
        findingCount: (repairDecision.unresolvedFindings || []).length,
      });
    }
  }

  return {
    review: parsed,
    qualityGate: gate,
    repairDecision,
    task: tasks.taskPublicView(tasks.getTask(projectId, taskId)),
  };
}

/**
 * Record that a repair attempt started (controller-driven, not recursive spawn).
 */
function onRepairStarted(projectId, taskId, decision, options = {}) {
  const task = tasks.getTask(projectId, taskId);
  if (!task) return null;
  const next = repairLoop.applyDecision(task.repair, decision);
  tasks.setRepairState(projectId, taskId, next);
  try {
    if (task.status === 'changes_requested' || task.status === 'review') {
      tasks.transitionTask(projectId, taskId, 'in_progress', {
        incrementAttempt: true,
        statusReason: `Repair attempt ${decision.attempt}/${decision.maxIterations}`,
      });
    }
  } catch {
    // ignore illegal transitions in edge cases
  }
  addEvidence(projectId, taskId, {
    kind: 'repair-start',
    attempt: decision.attempt,
    maxIterations: decision.maxIterations,
    implementer: decision.implementer && decision.implementer.adapter,
  });
  if (options.ledger && typeof options.ledger.append === 'function') {
    try {
      options.ledger.append({
        workspaceId: options.workspaceId || '',
        sessionId: options.sessionId || '',
        projectId,
        taskId,
        actor: (decision.implementer && decision.implementer.adapter) || 'system',
        provider: decision.implementer && decision.implementer.adapter,
        model: decision.implementer && decision.implementer.model,
        role: decision.implementer && decision.implementer.role,
        mode: 'edit',
        transition: 'repair_started',
        outcome: 'started',
        summary: `Repair attempt ${decision.attempt}/${decision.maxIterations}`,
        quality: {
          attempt: decision.attempt,
          maxIterations: decision.maxIterations,
          findingCount: (decision.unresolvedFindings || []).length,
        },
      });
    } catch {
      // ignore
    }
  }
  recomputeQualityGate(projectId, taskId, { phase: 'repair' });
  return tasks.getTask(projectId, taskId);
}

function onRepairFinished(projectId, taskId, { success, stopReason, error } = {}, options = {}) {
  const task = tasks.getTask(projectId, taskId);
  if (!task) return null;
  const next = repairLoop.markRepairFinished(task.repair, { success, stopReason });
  tasks.setRepairState(projectId, taskId, next);
  if (error) {
    addEvidence(projectId, taskId, {
      kind: 'error',
      error: summarizeText(error, 400),
      severity: 'error',
      providerFailure: true,
    });
  }
  addEvidence(projectId, taskId, {
    kind: success ? 'repair-complete' : 'repair-stop',
    stopReason: next.stopReason,
    attempt: next.attempt,
  });
  if (options.ledger && typeof options.ledger.append === 'function') {
    try {
      options.ledger.append({
        workspaceId: options.workspaceId || '',
        sessionId: options.sessionId || '',
        projectId,
        taskId,
        actor: task.adapter || 'system',
        provider: task.adapter,
        model: task.model,
        mode: 'edit',
        transition: success ? 'repair_finished' : 'repair_stopped',
        outcome: success ? 'success' : 'failure',
        summary: success
          ? `Repair attempt ${next.attempt} finished`
          : `Repair stopped: ${next.stopReason || 'unknown'}`,
        quality: { stopReason: next.stopReason, attempt: next.attempt },
      });
    } catch {
      // ignore
    }
  }
  recomputeQualityGate(projectId, taskId, { phase: 'repair' });
  return tasks.getTask(projectId, taskId);
}

/**
 * Check whether a worktree can be integrated under the quality gate.
 */
function checkIntegrationAllowed(projectId, worktreeId, options = {}) {
  const task = tasks.findTaskByWorktree(projectId, worktreeId);
  if (!task) return { allowed: true, task: null, qualityGate: null, block: null };
  const block = qualityGate.integrationBlockReason(task, {
    humanApproved: true,
    overrideReason: options.overrideReason || '',
    requireReview: options.requireReview,
  });
  if (block) {
    return {
      allowed: false,
      task,
      qualityGate: block.qualityGate,
      block,
    };
  }
  const gate = qualityGate.evaluateQualityGate(task, {
    humanApproved: true,
    attemptingIntegrate: true,
    overrideReason: options.overrideReason || '',
  });
  return { allowed: true, task, qualityGate: gate, block: null };
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
  findReviewTargetTask,
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
  onStructuredReview,
  onRepairStarted,
  onRepairFinished,
  recomputeQualityGate,
  recomputeProjectGates,
  checkIntegrationAllowed,
  projectView,
  listProjectsForSession,
  taskForPlanStep,
};
