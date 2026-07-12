'use strict';

function adapterRunError(result) {
  if (!result || !result.error) return null;
  const err = result.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  return 'agent run failed';
}

/**
 * Record terminal status for a direct /api/run adapter invocation.
 * Never appends a successful completion when the adapter reported an error or a throw occurred.
 */
function finishDirectRun(store, ws, sid, actor, { aborted, result, thrown }) {
  if (aborted) return;
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
    return;
  }
  store.append(ws, sid, {
    kind: 'system',
    actor,
    type: 'status',
    text: `${actor} finished`,
    meta: { done: true },
  });
}

module.exports = { adapterRunError, finishDirectRun };
