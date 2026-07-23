'use strict';

/*
 * Deterministic, versioned quality gates for Crew Forge.
 *
 * Rule-based pass | blocked | incomplete from objective persisted evidence.
 * Never uses or displays model self-reported confidence percentages.
 * Scoring, if present, is secondary and transparent.
 */

const QUALITY_GATE_VERSION = 1;
const STATUSES = new Set(['pass', 'blocked', 'incomplete']);
const SEVERITIES = new Set(['critical', 'error', 'high', 'medium', 'low', 'info', 'warning']);

const BLOCKING_FINDING_SEVERITIES = new Set(['critical', 'error', 'high']);
const BLOCKING_DIAGNOSTIC_SEVERITIES = new Set(['critical', 'error', 'high']);

function nowIso() {
  return new Date().toISOString();
}

function cap(text, max = 200) {
  const s = String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function normalizeSeverity(value) {
  const s = String(value || '')
    .trim()
    .toLowerCase();
  if (s === 'warn') return 'warning';
  if (s === 'err') return 'error';
  return SEVERITIES.has(s) ? s : 'medium';
}

function isReviewerRole(role) {
  return /\breview/i.test(String(role || ''));
}

/**
 * Extract a bounded evidence list from a task and optional session signals.
 * All items are objective/persisted — never model confidence.
 */
function collectEvidence(task, options = {}) {
  const items = [];
  const t = task || {};
  const evidence = Array.isArray(t.evidence) ? t.evidence : [];
  const mode = t.mode === 'plan' ? 'plan' : 'edit';
  const review = t.reviewResult || null;

  // --- Acceptance criteria ---
  const criteria = Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : [];
  const acceptanceState = Array.isArray(t.acceptanceState) ? t.acceptanceState : [];
  if (criteria.length) {
    const states = acceptanceState.length
      ? acceptanceState
      : criteria.map((c) => ({
          criterion: String(c),
          status: 'unknown',
        }));
    const unmet = states.filter((s) => s.status === 'unmet');
    const unknown = states.filter((s) => s.status === 'unknown' || !s.status);
    const met = states.filter((s) => s.status === 'met');
    items.push({
      id: 'acceptance_criteria',
      kind: 'acceptance_criteria',
      status: unmet.length
        ? 'blocked'
        : unknown.length
          ? 'incomplete'
          : met.length
            ? 'pass'
            : 'incomplete',
      summary: unmet.length
        ? `${unmet.length} acceptance criterion unmet`
        : unknown.length
          ? `${unknown.length} acceptance criterion not yet verified`
          : `${met.length} acceptance criteria met`,
      detail: {
        total: states.length,
        met: met.length,
        unmet: unmet.length,
        unknown: unknown.length,
      },
    });
  } else {
    items.push({
      id: 'acceptance_criteria',
      kind: 'acceptance_criteria',
      status: 'pass',
      summary: 'No acceptance criteria declared',
      optional: true,
    });
  }

  // --- Recognizable test / check command outcomes from evidence ---
  const checkEv = evidence.filter(
    (e) =>
      e &&
      (e.kind === 'test' ||
        e.kind === 'check' ||
        e.kind === 'command-check' ||
        (e.kind === 'command' && e.check === true) ||
        (e.kind === 'command' &&
          /test|lint|typecheck|ci|check/i.test(String(e.command || e.text || ''))))
  );
  if (checkEv.length) {
    const failed = checkEv.filter(
      (e) =>
        e.ok === false ||
        e.passed === false ||
        e.exitCode === 1 ||
        e.failed === true ||
        /fail|error|exit\s*[1-9]/i.test(String(e.summary || e.error || e.text || ''))
    );
    const passed = checkEv.filter(
      (e) =>
        e.ok === true ||
        e.passed === true ||
        e.exitCode === 0 ||
        /pass|ok|success/i.test(String(e.summary || e.text || ''))
    );
    items.push({
      id: 'checks',
      kind: 'checks',
      status: failed.length ? 'blocked' : passed.length ? 'pass' : 'incomplete',
      summary: failed.length
        ? `${failed.length} check/test command failed`
        : passed.length
          ? `${passed.length} check/test command passed`
          : 'Check/test outcomes incomplete',
      detail: { failed: failed.length, passed: passed.length, total: checkEv.length },
    });
  } else {
    items.push({
      id: 'checks',
      kind: 'checks',
      status: 'pass',
      summary: 'No recognizable test/check outcomes recorded',
      optional: true,
    });
  }

  // --- Structured reviewer verdict / findings ---
  if (review && (review.verdict || review.parseStatus || review.findings)) {
    const parseStatus = review.parseStatus || (review.verdict ? 'ok' : 'incomplete');
    const findings = Array.isArray(review.findings) ? review.findings : [];
    const openBlocking = findings.filter(
      (f) =>
        f && f.resolved !== true && BLOCKING_FINDING_SEVERITIES.has(normalizeSeverity(f.severity))
    );
    let status = 'incomplete';
    let summary = 'Review evidence incomplete';
    if (parseStatus === 'incomplete' || parseStatus === 'absent') {
      status = 'incomplete';
      summary =
        parseStatus === 'absent'
          ? 'Review verdict not yet available'
          : 'Review verdict could not be parsed (not guessing pass)';
    } else if (review.verdict === 'REQUEST_CHANGES' || review.verdict === 'request-changes') {
      status = openBlocking.length || findings.length ? 'blocked' : 'blocked';
      summary = `Reviewer requested changes (${findings.length} finding${findings.length === 1 ? '' : 's'})`;
    } else if (review.verdict === 'PASS' || review.verdict === 'approve') {
      status = openBlocking.length ? 'blocked' : 'pass';
      summary = openBlocking.length
        ? `Review PASS but ${openBlocking.length} unresolved high-severity finding(s)`
        : 'Structured review verdict PASS';
    } else {
      status = 'incomplete';
      summary = 'Review verdict missing or unrecognized';
    }
    items.push({
      id: 'review',
      kind: 'review',
      status,
      summary,
      detail: {
        verdict: review.verdict || null,
        parseStatus,
        findingCount: findings.length,
        openBlocking: openBlocking.length,
      },
    });
  } else {
    // Review is optional unless a designated reviewer was expected or task is edit awaiting integrate.
    const expectReview =
      options.requireReview === true ||
      isReviewerRole(t.role) ||
      evidence.some((e) => e && (e.kind === 'review-started' || e.kind === 'review'));
    items.push({
      id: 'review',
      kind: 'review',
      status: expectReview ? 'incomplete' : 'pass',
      summary: expectReview ? 'Review evidence not yet recorded' : 'No structured review required',
      optional: !expectReview,
    });
  }

  // --- Unresolved error / diagnostic severity ---
  const diags = evidence.filter(
    (e) =>
      e &&
      (e.kind === 'error' ||
        e.kind === 'diagnostic' ||
        e.kind === 'failed-step' ||
        (e.severity && BLOCKING_DIAGNOSTIC_SEVERITIES.has(normalizeSeverity(e.severity))))
  );
  const openDiags = diags.filter((e) => e.resolved !== true);
  const severe = openDiags.filter((e) =>
    BLOCKING_DIAGNOSTIC_SEVERITIES.has(
      normalizeSeverity(e.severity || (e.kind === 'error' ? 'error' : 'medium'))
    )
  );
  if (openDiags.length) {
    items.push({
      id: 'diagnostics',
      kind: 'diagnostics',
      status: severe.length ? 'blocked' : 'incomplete',
      summary: severe.length
        ? `${severe.length} unresolved error/diagnostic(s)`
        : `${openDiags.length} open diagnostic(s)`,
      detail: { open: openDiags.length, severe: severe.length },
    });
  } else {
    items.push({
      id: 'diagnostics',
      kind: 'diagnostics',
      status: 'pass',
      summary: 'No unresolved error/diagnostic evidence',
      optional: true,
    });
  }

  // --- Worktree integration state ---
  const pendingInt = evidence.filter((e) => e && e.kind === 'pending-integration').slice(-1)[0];
  const integrated = evidence.some((e) => e && e.kind === 'integrated');
  const rejected = evidence.filter((e) => e && e.kind === 'rejected').slice(-1)[0];
  const intFailed = evidence.filter((e) => e && e.kind === 'integration-failed').slice(-1)[0];
  if (rejected && !integrated) {
    items.push({
      id: 'integration',
      kind: 'integration',
      status: 'blocked',
      summary: cap(rejected.reason || 'Worktree rejected'),
    });
  } else if (intFailed && !integrated && !pendingInt) {
    items.push({
      id: 'integration',
      kind: 'integration',
      status: 'blocked',
      summary: cap(intFailed.error || 'Integration failed'),
    });
  } else if (pendingInt && !integrated) {
    items.push({
      id: 'integration',
      kind: 'integration',
      status: 'incomplete',
      summary: 'Pending worktree integration (human approval required)',
      detail: { worktreeId: pendingInt.worktreeId || t.worktreeId || '' },
    });
  } else if (integrated) {
    items.push({
      id: 'integration',
      kind: 'integration',
      status: 'pass',
      summary: 'Worktree integrated',
    });
  } else if (mode === 'edit' && (t.status === 'review' || t.worktreeId)) {
    items.push({
      id: 'integration',
      kind: 'integration',
      status: 'incomplete',
      summary: 'Edit task not yet integrated',
    });
  } else {
    items.push({
      id: 'integration',
      kind: 'integration',
      status: 'pass',
      summary: mode === 'plan' ? 'Plan mode — no worktree integration' : 'No pending integration',
      optional: true,
    });
  }

  // --- Diff presence for edit tasks ---
  const diffEv = evidence
    .filter(
      (e) =>
        e &&
        (e.kind === 'diff' ||
          e.kind === 'pending-integration' ||
          e.diffSummary != null ||
          e.kind === 'file-change')
    )
    .slice(-1)[0];
  if (
    mode === 'edit' &&
    (t.status === 'review' || t.status === 'changes_requested' || pendingInt)
  ) {
    const hasDiff =
      diffEv &&
      (diffEv.diffSummary ||
        diffEv.hasDiff === true ||
        (diffEv.filesChanged != null && Number(diffEv.filesChanged) > 0) ||
        diffEv.kind === 'pending-integration');
    const emptyDiff = diffEv && (diffEv.empty === true || diffEv.hasDiff === false);
    items.push({
      id: 'diff',
      kind: 'diff',
      status: hasDiff || emptyDiff ? 'pass' : 'incomplete',
      summary: hasDiff
        ? cap(typeof diffEv.diffSummary === 'string' ? diffEv.diffSummary : 'Diff evidence present')
        : emptyDiff
          ? 'Edit task recorded empty diff'
          : 'Diff evidence missing for edit task',
    });
  } else {
    items.push({
      id: 'diff',
      kind: 'diff',
      status: 'pass',
      summary:
        mode === 'plan' ? 'Plan mode — diff not required' : 'Diff not required in current state',
      optional: true,
    });
  }

  // --- Cancellation / provider failure ---
  const cancelled = evidence
    .filter((e) => e && (e.kind === 'cancelled' || e.kind === 'cancelled-worktree'))
    .slice(-1)[0];
  const providerFail = evidence
    .filter(
      (e) =>
        e &&
        (e.kind === 'provider-failure' ||
          e.kind === 'rate-limit' ||
          (e.kind === 'error' && e.providerFailure === true))
    )
    .slice(-1)[0];
  const failedStatus = t.status === 'failed' || t.status === 'cancelled';
  if (providerFail && !integrated) {
    items.push({
      id: 'run_outcome',
      kind: 'run_outcome',
      status: 'blocked',
      summary: cap(providerFail.error || providerFail.summary || 'Provider failure / rate limit'),
    });
  } else if (cancelled && !integrated && t.status !== 'review') {
    items.push({
      id: 'run_outcome',
      kind: 'run_outcome',
      status: 'blocked',
      summary: 'Run cancelled',
    });
  } else if (failedStatus && t.status === 'failed') {
    items.push({
      id: 'run_outcome',
      kind: 'run_outcome',
      status: 'blocked',
      summary: cap(t.statusReason || 'Task failed'),
    });
  } else if (failedStatus && t.status === 'cancelled') {
    items.push({
      id: 'run_outcome',
      kind: 'run_outcome',
      status: 'blocked',
      summary: cap(t.statusReason || 'Task cancelled'),
    });
  } else {
    items.push({
      id: 'run_outcome',
      kind: 'run_outcome',
      status: 'pass',
      summary: 'No cancellation or provider failure blocking gate',
      optional: true,
    });
  }

  // --- Human approval ---
  const humanApproved =
    options.humanApproved === true ||
    evidence.some((e) => e && (e.kind === 'human-approved' || e.kind === 'integrated'));
  const overrideReason = options.overrideReason ? cap(options.overrideReason, 280) : '';
  if (humanApproved) {
    items.push({
      id: 'human_approval',
      kind: 'human_approval',
      status: 'pass',
      summary: 'Human approval recorded',
    });
  } else if (
    mode === 'plan' ||
    t.status === 'done' ||
    t.status === 'complete' ||
    t.status === 'planned' ||
    t.status === 'ready' ||
    t.status === 'in_progress'
  ) {
    items.push({
      id: 'human_approval',
      kind: 'human_approval',
      status: 'pass',
      summary:
        mode === 'plan'
          ? 'Plan mode — integration approval not required'
          : 'Human approval not required for current task state',
      optional: true,
    });
  } else {
    items.push({
      id: 'human_approval',
      kind: 'human_approval',
      status: 'incomplete',
      summary: 'Human approval not yet recorded',
    });
  }

  if (overrideReason) {
    items.push({
      id: 'override',
      kind: 'override',
      status: 'pass',
      summary: `Explicit override: ${overrideReason}`,
      detail: { reason: overrideReason },
    });
  }

  return items;
}

/**
 * Secondary transparent score (0–100). Never used for pass/fail.
 * Deducts for blocked/incomplete non-optional items.
 */
function computeScore(evidenceItems) {
  const relevant = evidenceItems.filter((e) => !e.optional);
  if (!relevant.length) return 100;
  let score = 100;
  const weight = Math.floor(100 / relevant.length);
  for (const item of relevant) {
    if (item.status === 'blocked') score -= weight;
    else if (item.status === 'incomplete') score -= Math.ceil(weight / 2);
  }
  return Math.max(0, Math.min(100, score));
}

/**
 * Evaluate quality gate from task + options.
 * @returns {{ version, status, reasons, evidence, score, evaluatedAt, readyToIntegrate, canIntegrate, blocksPlanning }}
 */
function evaluateQualityGate(task, options = {}) {
  const mode = task && task.mode === 'plan' ? 'plan' : 'edit';
  const evidence = collectEvidence(task, options);
  const reasons = [];

  // Rule-based aggregation: blocked wins over incomplete over pass.
  // Optional incomplete/pass items never force incomplete when all required pass.
  const required = evidence.filter((e) => !e.optional);
  let status = 'pass';
  for (const item of required) {
    if (item.status === 'blocked') {
      status = 'blocked';
      reasons.push(item.summary);
    } else if (item.status === 'incomplete' && status !== 'blocked') {
      status = 'incomplete';
      reasons.push(item.summary);
    }
  }

  // Human approval incomplete alone should not mark gate blocked for "status",
  // but readyToIntegrate/canIntegrate must still require it (handled below).
  // Integration-pending incomplete is expected pre-approve — it contributes to
  // incomplete which correctly blocks readyToIntegrate.

  // Override: explicit recorded reason can clear mandatory-evidence blocks for integrate.
  // Override never invents a pass without reason; it only allows integrate when provided.
  const overrideReason = options.overrideReason ? String(options.overrideReason).trim() : '';
  const hasOverride = overrideReason.length > 0;

  // Planning must never be blocked by this gate.
  const blocksPlanning = false;

  // readyToIntegrate: evidence-wise ready (excluding human_approval and integration pending itself).
  const preIntegrateRequired = required.filter(
    (e) => e.kind !== 'human_approval' && e.kind !== 'integration'
  );
  let evidenceReady = true;
  const evidenceBlockReasons = [];
  for (const item of preIntegrateRequired) {
    if (item.status === 'blocked' || item.status === 'incomplete') {
      evidenceReady = false;
      evidenceBlockReasons.push(item.summary);
    }
  }

  // Diff/run_outcome blocked always blocks ready.
  const hardBlocked = required.some(
    (e) =>
      e.status === 'blocked' &&
      (e.kind === 'review' ||
        e.kind === 'diagnostics' ||
        e.kind === 'checks' ||
        e.kind === 'acceptance_criteria' ||
        e.kind === 'run_outcome' ||
        e.kind === 'diff')
  );

  const readyToIntegrate =
    mode === 'edit' &&
    !hardBlocked &&
    evidenceReady &&
    task &&
    (task.status === 'review' ||
      task.status === 'changes_requested' ||
      (task.worktreeId && task.status !== 'done' && task.status !== 'failed'));

  // canIntegrate: ready evidence OR (override with reason) AND (human approved or this call is the approval).
  const humanApproved =
    options.humanApproved === true ||
    (Array.isArray(task && task.evidence) &&
      task.evidence.some((e) => e && (e.kind === 'human-approved' || e.kind === 'integrated')));

  let canIntegrate = false;
  if (mode === 'edit' && (options.attemptingIntegrate === true || humanApproved)) {
    if (evidenceReady && !hardBlocked) {
      canIntegrate = true;
    } else if (hasOverride) {
      // Explicit override reason required to bypass missing/blocked mandatory evidence.
      canIntegrate = true;
    }
  }

  // When integrating is attempted without override and evidence not ready, status stays blocked/incomplete.
  if (options.attemptingIntegrate && !canIntegrate && !hasOverride) {
    if (status === 'pass') status = 'incomplete';
    for (const r of evidenceBlockReasons) {
      if (!reasons.includes(r)) reasons.push(r);
    }
    if (!humanApproved && options.humanApproved !== true) {
      const msg = 'Human approval required for integration';
      if (!reasons.includes(msg)) reasons.push(msg);
    }
  }

  if (!reasons.length && status === 'pass') {
    reasons.push('All required evidence rules passed');
  }

  const score = computeScore(evidence);

  return {
    version: QUALITY_GATE_VERSION,
    status: STATUSES.has(status) ? status : 'incomplete',
    reasons: reasons.map((r) => cap(r, 240)),
    evidence: evidence.map((e) => ({
      id: e.id,
      kind: e.kind,
      status: e.status,
      summary: cap(e.summary, 240),
      ...(e.optional ? { optional: true } : {}),
      ...(e.detail ? { detail: e.detail } : {}),
    })),
    // Secondary transparent metric — never the sole pass/fail signal.
    score: {
      value: score,
      max: 100,
      note: 'Secondary transparent score only; pass/fail is rule-based from evidence statuses.',
    },
    evaluatedAt: nowIso(),
    readyToIntegrate: !!readyToIntegrate,
    canIntegrate: !!canIntegrate,
    blocksPlanning,
    mode,
    overrideApplied: hasOverride && !!canIntegrate && (!evidenceReady || hardBlocked),
  };
}

/**
 * Whether integration should be refused by the server.
 * Returns null if allowed, or { error, qualityGate } if blocked.
 */
function integrationBlockReason(task, options = {}) {
  const gate = evaluateQualityGate(task, {
    ...options,
    attemptingIntegrate: true,
    humanApproved: options.humanApproved !== false,
  });
  if (gate.canIntegrate) return null;
  const overrideHint =
    ' Provide overrideReason (non-empty) to integrate despite incomplete/blocked mandatory evidence.';
  return {
    error:
      `Quality gate ${gate.status}: ${gate.reasons.slice(0, 3).join('; ') || 'not ready'}.` +
      (options.overrideReason ? '' : overrideHint),
    qualityGate: gate,
  };
}

function compactGateView(gate) {
  if (!gate) return null;
  return {
    version: gate.version,
    status: gate.status,
    reasons: gate.reasons || [],
    evidence: (gate.evidence || []).map((e) => ({
      id: e.id,
      kind: e.kind,
      status: e.status,
      summary: e.summary,
      optional: e.optional || undefined,
    })),
    score: gate.score,
    evaluatedAt: gate.evaluatedAt,
    readyToIntegrate: !!gate.readyToIntegrate,
    canIntegrate: !!gate.canIntegrate,
    overrideApplied: !!gate.overrideApplied,
  };
}

module.exports = {
  QUALITY_GATE_VERSION,
  STATUSES,
  evaluateQualityGate,
  collectEvidence,
  integrationBlockReason,
  compactGateView,
  computeScore,
  isReviewerRole,
};
