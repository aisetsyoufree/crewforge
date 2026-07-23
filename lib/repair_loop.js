'use strict';

/*
 * Bounded repair loop controller (no recursive model spawning outside this controller).
 *
 * When a designated reviewer returns REQUEST_CHANGES for an edit task, optionally
 * create a repair attempt assigned to the original implementer/provider/model/role.
 *
 * Safety defaults for beta:
 * - autoRepair opt-in per run/team, default OFF
 * - max iterations: setting default 2, min 0, hard cap 5
 * - No silent provider switching
 * - Human approval before integration remains mandatory (enforced by quality gate)
 */

const review = require('./review');

const DEFAULT_REPAIR_ITERATIONS = 2;
const MIN_REPAIR_ITERATIONS = 0;
const HARD_CAP_REPAIR_ITERATIONS = 5;

const STOP_REASONS = new Set([
  'pass',
  'unchanged_findings',
  'max_attempts',
  'cancelled',
  'provider_failure',
  'rate_limit',
  'missing_implementer',
  'human_stop',
  'auto_repair_disabled',
  'not_edit_task',
  'no_request_changes',
  'iterations_zero',
]);

function clampRepairIterations(value) {
  if (value == null || value === '') return DEFAULT_REPAIR_ITERATIONS;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_REPAIR_ITERATIONS;
  const i = Math.floor(n);
  if (i < MIN_REPAIR_ITERATIONS) return MIN_REPAIR_ITERATIONS;
  if (i > HARD_CAP_REPAIR_ITERATIONS) return HARD_CAP_REPAIR_ITERATIONS;
  return i;
}

function validateRepairIterations(value) {
  if (value == null || value === '') {
    return { ok: true, value: DEFAULT_REPAIR_ITERATIONS };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return {
      ok: false,
      error: `repairIterations must be an integer ${MIN_REPAIR_ITERATIONS}–${HARD_CAP_REPAIR_ITERATIONS}`,
    };
  }
  if (n < MIN_REPAIR_ITERATIONS || n > HARD_CAP_REPAIR_ITERATIONS) {
    return {
      ok: false,
      error: `repairIterations must be ${MIN_REPAIR_ITERATIONS}–${HARD_CAP_REPAIR_ITERATIONS} (hard cap ${HARD_CAP_REPAIR_ITERATIONS})`,
    };
  }
  return { ok: true, value: n };
}

function normalizeAutoRepair(value) {
  if (value === true || value === 'true' || value === 1 || value === '1' || value === 'on') {
    return true;
  }
  return false; // default OFF
}

function getRepairState(task) {
  const raw = (task && task.repair) || {};
  return {
    enabled: raw.enabled === true,
    maxIterations: clampRepairIterations(raw.maxIterations),
    attempt: Number.isInteger(raw.attempt) ? raw.attempt : 0,
    status: raw.status || 'idle', // idle | running | stopped | completed
    stopReason: raw.stopReason || null,
    lastFindingSet: raw.lastFindingSet || '',
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

function capText(text, max = 240) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Decide whether to start a repair attempt.
 * Pure decision — does not run models.
 *
 * @returns {{ action: 'repair'|'stop'|'none', stopReason?: string, attempt?: number, prompt?: string, implementer?: object }}
 */
function decideRepair(task, options = {}) {
  const autoRepair = normalizeAutoRepair(
    options.autoRepair != null ? options.autoRepair : task && task.repair && task.repair.enabled
  );
  const maxIterations = clampRepairIterations(
    options.maxIterations != null
      ? options.maxIterations
      : task && task.repair && task.repair.maxIterations
  );
  const state = getRepairState(task);
  const mode = task && task.mode === 'plan' ? 'plan' : 'edit';
  const reviewResult = (task && task.reviewResult) || {};
  const findings = Array.isArray(reviewResult.findings) ? reviewResult.findings : [];
  const unresolved = findings.filter((f) => f && f.resolved !== true);

  if (mode !== 'edit') {
    return { action: 'stop', stopReason: 'not_edit_task' };
  }
  if (!autoRepair) {
    return { action: 'stop', stopReason: 'auto_repair_disabled' };
  }
  if (maxIterations <= 0) {
    return { action: 'stop', stopReason: 'iterations_zero' };
  }
  if (options.cancelled || options.humanStop) {
    return { action: 'stop', stopReason: options.humanStop ? 'human_stop' : 'cancelled' };
  }
  if (options.providerFailure) {
    return {
      action: 'stop',
      stopReason: options.rateLimited ? 'rate_limit' : 'provider_failure',
    };
  }

  const implementer = options.implementer || {
    adapter: task && task.adapter,
    model: task && task.model,
    role: task && task.role,
    skillId: task && task.skillId,
    memberIndex: task && task.memberIndex,
    effort: options.effort,
  };
  if (!implementer || !implementer.adapter) {
    return { action: 'stop', stopReason: 'missing_implementer' };
  }

  // Only repair on REQUEST_CHANGES with a successfully parsed structured review.
  // Incomplete/unparseable reviews must never start a repair attempt.
  if (reviewResult.parseStatus !== 'ok') {
    return { action: 'stop', stopReason: 'no_request_changes' };
  }
  if (reviewResult.verdict === 'PASS') {
    return { action: 'stop', stopReason: 'pass' };
  }
  if (reviewResult.verdict !== 'REQUEST_CHANGES' && reviewResult.verdict !== 'request-changes') {
    return { action: 'stop', stopReason: 'no_request_changes' };
  }

  const findingSet = review.normalizeFindingSet(unresolved);
  if (state.lastFindingSet && findingSet && findingSet === state.lastFindingSet) {
    return { action: 'stop', stopReason: 'unchanged_findings' };
  }

  const nextAttempt = state.attempt + 1;
  if (nextAttempt > maxIterations) {
    return { action: 'stop', stopReason: 'max_attempts' };
  }

  const prompt = buildRepairPrompt(task, unresolved, options);
  return {
    action: 'repair',
    attempt: nextAttempt,
    maxIterations,
    prompt,
    implementer: {
      adapter: String(implementer.adapter),
      model: implementer.model ? String(implementer.model) : '',
      role: implementer.role ? String(implementer.role) : 'implementer',
      skillId: implementer.skillId || '',
      memberIndex: implementer.memberIndex,
      effort: implementer.effort,
    },
    findingSet,
    unresolvedFindings: unresolved.map((f) => ({
      id: f.id,
      severity: f.severity,
      summary: f.summary,
      file: f.file,
      acceptanceCriterion: f.acceptanceCriterion,
    })),
  };
}

function buildRepairPrompt(task, findings, options = {}) {
  const lines = [
    'You are repairing code after a structured review requested changes.',
    'Stay within the original objective and acceptance criteria.',
    'Only address the unresolved findings listed below.',
    'Do not expand scope. Do not switch providers or spawn sub-agents.',
    '',
    `Task objective: ${capText((task && task.objective) || '', 500)}`,
  ];
  const criteria = (task && task.acceptanceCriteria) || [];
  if (criteria.length) {
    lines.push('Acceptance criteria:');
    for (const c of criteria.slice(0, 12)) lines.push(`- ${capText(c, 160)}`);
  }
  lines.push('');
  lines.push('Unresolved review findings:');
  if (!findings.length) {
    lines.push('- (no structured findings; re-check objective and acceptance criteria)');
  } else {
    for (const f of findings.slice(0, 20)) {
      const loc = f.file ? ` [${f.file}]` : '';
      const ac = f.acceptanceCriterion ? ` (criterion: ${capText(f.acceptanceCriterion, 80)})` : '';
      lines.push(`- (${f.severity}) ${f.id || ''}${loc}: ${capText(f.summary, 200)}${ac}`);
    }
  }
  if (options.contextPolicy) {
    lines.push('');
    lines.push(`Context policy: ${options.contextPolicy}`);
  }
  if (task && task.worktreeId) {
    lines.push('');
    lines.push(
      `Work in the existing isolated worktree state (worktreeId=${task.worktreeId}). Do not modify unrelated files.`
    );
  }
  lines.push('');
  lines.push('When done, briefly list what you changed for each finding id.');
  return lines.join('\n');
}

/**
 * Apply a decision onto a repair state object (immutable-ish update).
 */
function applyDecision(prevState, decision) {
  const base = {
    enabled: prevState && prevState.enabled === true,
    maxIterations: clampRepairIterations(prevState && prevState.maxIterations),
    attempt: (prevState && prevState.attempt) || 0,
    status: (prevState && prevState.status) || 'idle',
    stopReason: (prevState && prevState.stopReason) || null,
    lastFindingSet: (prevState && prevState.lastFindingSet) || '',
    history: Array.isArray(prevState && prevState.history) ? prevState.history.slice() : [],
  };

  if (!decision || decision.action === 'none') return base;

  if (decision.action === 'stop') {
    const reason = STOP_REASONS.has(decision.stopReason) ? decision.stopReason : 'human_stop';
    base.status = reason === 'pass' ? 'completed' : 'stopped';
    base.stopReason = reason;
    base.history.push({
      ts: new Date().toISOString(),
      event: 'stop',
      reason,
      attempt: base.attempt,
    });
    return base;
  }

  if (decision.action === 'repair') {
    base.attempt = decision.attempt;
    base.status = 'running';
    base.stopReason = null;
    if (decision.findingSet) base.lastFindingSet = decision.findingSet;
    base.history.push({
      ts: new Date().toISOString(),
      event: 'start',
      attempt: decision.attempt,
      maxIterations: decision.maxIterations,
      findingCount: (decision.unresolvedFindings || []).length,
    });
    return base;
  }

  return base;
}

function markRepairFinished(prevState, { success, stopReason } = {}) {
  const base = applyDecision(prevState, null);
  if (success) {
    // Attempt completed; does not imply review PASS. Stay idle for a later re-review decision.
    base.status = 'idle';
    base.stopReason = null;
  } else if (stopReason) {
    base.status = stopReason === 'pass' ? 'completed' : 'stopped';
    base.stopReason = STOP_REASONS.has(stopReason) ? stopReason : 'provider_failure';
  } else {
    base.status = 'idle';
  }
  base.history.push({
    ts: new Date().toISOString(),
    event: success ? 'finished' : 'failed',
    reason: base.stopReason || (success ? 'attempt_complete' : null),
    attempt: base.attempt,
  });
  return base;
}

function shouldCreateCapsule(stopReason) {
  return (
    stopReason === 'cancelled' ||
    stopReason === 'provider_failure' ||
    stopReason === 'rate_limit' ||
    stopReason === 'human_stop'
  );
}

module.exports = {
  DEFAULT_REPAIR_ITERATIONS,
  MIN_REPAIR_ITERATIONS,
  HARD_CAP_REPAIR_ITERATIONS,
  STOP_REASONS,
  clampRepairIterations,
  validateRepairIterations,
  normalizeAutoRepair,
  getRepairState,
  decideRepair,
  buildRepairPrompt,
  applyDecision,
  markRepairFinished,
  shouldCreateCapsule,
};
