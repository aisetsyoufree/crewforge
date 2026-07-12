'use strict';

const PENDING_TYPES = new Set(['pending-integration', 'cancelled-worktree']);
const RESOLVED_TYPES = new Set(['integrated', 'rejected']);

function eventWorktreeId(event) {
  return event && event.meta && String(event.meta.worktreeId || '');
}

function findUnresolvedPending(events, worktreeId) {
  const id = String(worktreeId || '');
  let pending = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (eventWorktreeId(event) !== id) continue;
    if (PENDING_TYPES.has(event.type)) pending = event;
    if (RESOLVED_TYPES.has(event.type)) pending = null;
  }
  return pending;
}

function continuationFromPending(event) {
  const value = event && event.meta && event.meta.continuation;
  if (!value || value.version !== 1) return null;
  if (!value.team || !Array.isArray(value.team.members)) return null;
  if (!Array.isArray(value.remainingSteps)) return null;
  if (!Number.isInteger(value.nextStepOffset) || value.nextStepOffset < 0) return null;
  if (!Number.isInteger(value.totalSteps) || value.totalSteps < value.nextStepOffset) return null;
  if (value.approvalMode !== 'edit' && value.approvalMode !== 'plan') return null;
  return value;
}

module.exports = { continuationFromPending, findUnresolvedPending };
