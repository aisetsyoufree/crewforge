'use strict';

const capsuleLib = require('./continuation_capsule');
const contextPolicy = require('./context_policy');

function adapterRunError(result) {
  if (!result || !result.error) return null;
  const err = result.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  return 'agent run failed';
}

function safeObjective(text) {
  return contextPolicy.capText(contextPolicy.redactSecrets(text || ''), 2000);
}

/**
 * Create and persist a continuation capsule for an incomplete direct run.
 * Best-effort: never throws into the run path.
 */
function maybeCreateDirectCapsule(store, ws, sid, actor, options = {}) {
  try {
    if (!options.createCapsule) return null;
    const reason = options.reason || 'incomplete';
    const events = typeof store.readEvents === 'function' ? store.readEvents(ws, sid) : [];
    const lastUser = [...events]
      .reverse()
      .find((e) => e && e.kind === 'user' && e.type === 'message');
    const objective = safeObjective(
      options.objective || (lastUser && lastUser.text) || `${actor} run left incomplete`
    );
    const sawRateLimit =
      reason === 'rate_limit' ||
      events.some(
        (e) => e && (e.type === 'rate_limit' || /rate.?limit|429/i.test(String(e.text || '')))
      );
    const capsule = capsuleLib.persistCapsule(
      {
        workspaceId: ws,
        sessionId: sid,
        projectId: options.projectId,
        reason: sawRateLimit && reason !== 'cancelled' ? 'rate_limit' : reason,
        objective,
        contextPolicy: options.contextPolicy,
        mode: options.mode,
        effort: options.effort,
        provider: options.provider || actor,
        model: options.model,
        role: options.role,
        worktreeId: options.worktreeId,
        workspaceRoot: options.workspaceRoot,
        sessionEvents: events,
        evidence: options.evidence,
        changes: options.changes,
        completedTasks: options.completedTasks,
        remainingTasks: options.remainingTasks || [{ id: 'remaining-1', summary: objective }],
      },
      { ledger: options.ledger }
    );

    if (store && typeof store.append === 'function') {
      store.append(ws, sid, {
        kind: 'system',
        actor: 'system',
        type: 'continuation-capsule',
        text: `Continuation capsule ready (${capsule.reason})`,
        meta: {
          capsuleId: capsule.id,
          reason: capsule.reason,
          status: capsule.status,
          contextPolicy: capsule.constraints && capsule.constraints.contextPolicy,
          eligible: true,
          notice: contextPolicy.LOCAL_CONTROL_NOTICE,
        },
      });
    }
    return capsule;
  } catch {
    return null;
  }
}

/**
 * Record terminal status for a direct /api/run adapter invocation.
 * Never appends a successful completion when the adapter reported an error or a throw occurred.
 * Optional ledger service records a redacted outcome without prompt text.
 * On failure/cancel, optionally persists a provider-neutral continuation capsule.
 */
function finishDirectRun(store, ws, sid, actor, { aborted, result, thrown, ledger, meta }) {
  const m = meta || {};
  if (aborted) {
    if (ledger && typeof ledger.append === 'function') {
      ledger.append({
        workspaceId: ws,
        sessionId: sid,
        actor,
        provider: m.provider || actor,
        model: m.model,
        role: m.role,
        mode: m.mode,
        transition: 'run_cancelled',
        outcome: 'cancelled',
        summary: `${actor} run cancelled`,
        quality: m.contextPolicy ? { contextPolicy: m.contextPolicy } : null,
      });
    }
    maybeCreateDirectCapsule(store, ws, sid, actor, {
      createCapsule: m.createCapsule !== false,
      reason: 'cancelled',
      ledger,
      provider: m.provider || actor,
      model: m.model,
      role: m.role,
      mode: m.mode,
      effort: m.effort,
      contextPolicy: m.contextPolicy,
      objective: m.objective,
      projectId: m.projectId,
      workspaceRoot: m.workspaceRoot,
      worktreeId: m.worktreeId,
      changes: m.changes,
      evidence: m.evidence,
    });
    return;
  }
  const runErr = thrown
    ? thrown instanceof Error
      ? thrown.message
      : String(thrown)
    : adapterRunError(result);
  if (runErr) {
    store.append(ws, sid, {
      kind: 'system',
      actor,
      type: 'error',
      text: runErr,
    });
    store.append(ws, sid, {
      kind: 'system',
      actor,
      type: 'status',
      text: `${actor} run failed`,
      meta: { done: true, failed: true },
    });
    if (ledger && typeof ledger.append === 'function') {
      ledger.append({
        workspaceId: ws,
        sessionId: sid,
        actor,
        provider: m.provider || actor,
        model: m.model,
        role: m.role,
        mode: m.mode,
        transition: m.review ? 'review_failed' : 'run_failed',
        outcome: 'failure',
        summary: `${actor} run failed`,
        quality: {
          failed: true,
          ...(m.contextPolicy ? { contextPolicy: m.contextPolicy } : {}),
        },
      });
    }
    const rateLimited = /rate.?limit|quota|429|usage limit/i.test(runErr) || m.rateLimited === true;
    maybeCreateDirectCapsule(store, ws, sid, actor, {
      createCapsule: m.createCapsule !== false && !m.review,
      reason: rateLimited ? 'rate_limit' : 'failed',
      ledger,
      provider: m.provider || actor,
      model: m.model,
      role: m.role,
      mode: m.mode,
      effort: m.effort,
      contextPolicy: m.contextPolicy,
      objective: m.objective,
      projectId: m.projectId,
      workspaceRoot: m.workspaceRoot,
      worktreeId: m.worktreeId,
      changes: m.changes,
      evidence: m.evidence,
    });
    return;
  }
  store.append(ws, sid, {
    kind: 'system',
    actor,
    type: 'status',
    text: `${actor} finished`,
    meta: { done: true },
  });
  if (ledger && typeof ledger.append === 'function') {
    ledger.append({
      workspaceId: ws,
      sessionId: sid,
      actor,
      provider: m.provider || actor,
      model: m.model,
      role: m.role,
      mode: m.mode,
      transition: m.review ? 'review_finished' : 'run_finished',
      outcome: 'success',
      summary: `${actor} finished`,
      quality: m.contextPolicy ? { contextPolicy: m.contextPolicy } : null,
    });
  }
}

module.exports = { adapterRunError, finishDirectRun, maybeCreateDirectCapsule };
