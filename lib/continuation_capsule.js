'use strict';

/*
 * Provider-neutral continuation capsule.
 *
 * Built when a direct or team run fails, is cancelled with partial progress,
 * receives a rate-limit event, or is otherwise left incomplete. Resuming is
 * always explicit and user-selected (provider/model/effort/mode) — never an
 * automatic provider switch or silent failover.
 *
 * Capsules never store environment variables, credentials, auth tokens,
 * absolute host paths, raw unbounded commands, or confidential ignored paths.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const contextPolicy = require('./context_policy');

const CAPSULE_VERSION = 1;
const DEFAULT_DATA = require('./data_dir');
const DEFAULT_ROOT = path.join(DEFAULT_DATA, 'capsules');

const MAX_OBJECTIVE = 2000;
const MAX_SUMMARY = 280;
const MAX_ID = 80;
const MAX_TASKS = 40;
const MAX_CRITERIA = 12;
const MAX_CRITERION = 200;
const MAX_EVENTS = 32;
const MAX_EVIDENCE = 40;
const MAX_INSTRUCTIONS = 1500;
const MAX_RESUME_USES = 50;

const VALID_ID = /^[A-Za-z0-9._-]+$/;
const REASONS = new Set(['failed', 'cancelled', 'rate_limit', 'incomplete']);
const STATUSES = new Set(['eligible', 'resumed', 'superseded', 'expired']);

let configured = {
  root: process.env.CREW_FORGE_CAPSULES_DIR || DEFAULT_ROOT,
};

function configure(options = {}) {
  if (options.root) configured.root = options.root;
  return { ...configured };
}

function resetConfig() {
  configured = {
    root: process.env.CREW_FORGE_CAPSULES_DIR || DEFAULT_ROOT,
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
}

function isValidId(value) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_ID && VALID_ID.test(value)
  );
}

function sanitizeId(value) {
  if (value == null || value === '') return '';
  const text = String(value).slice(0, MAX_ID);
  return isValidId(text) ? text : '';
}

function createId() {
  return `cap-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function capText(value, max) {
  return contextPolicy.capText(contextPolicy.redactSecrets(value), max);
}

function normalizeReason(value) {
  const r = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (r === 'rate-limit' || r === 'ratelimit') return 'rate_limit';
  if (r === 'cancel' || r === 'stopped' || r === 'aborted') return 'cancelled';
  if (r === 'fail' || r === 'error' || r === 'failure') return 'failed';
  return REASONS.has(r) ? r : 'incomplete';
}

function normalizeStatus(value) {
  const s = String(value || '')
    .trim()
    .toLowerCase();
  return STATUSES.has(s) ? s : 'eligible';
}

function normalizeMode(value) {
  const m = String(value || '')
    .trim()
    .toLowerCase();
  if (m === 'edit' || m === 'plan' || m === 'review' || m === 'team') return m;
  return m ? capText(m, 24) : 'plan';
}

function normalizeTaskList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_TASKS) break;
    if (!item) continue;
    if (typeof item === 'string') {
      const id = sanitizeId(item) || capText(item, 40).replace(/\s+/g, '-').slice(0, 40);
      if (id) out.push({ id, summary: capText(item, MAX_SUMMARY) });
      continue;
    }
    if (typeof item !== 'object') continue;
    const id =
      sanitizeId(item.id) ||
      sanitizeId(item.taskId) ||
      (item.planStepIndex != null ? `step-${Number(item.planStepIndex) + 1}` : '');
    const summary = capText(
      item.summary || item.objective || item.task || item.title || id,
      MAX_SUMMARY
    );
    if (!id && !summary) continue;
    const entry = {
      id: id || `task-${out.length + 1}`,
      summary,
    };
    if (Array.isArray(item.acceptanceCriteria)) {
      entry.acceptanceCriteria = item.acceptanceCriteria
        .map((c) => capText(c, MAX_CRITERION))
        .filter(Boolean)
        .slice(0, MAX_CRITERIA);
    }
    if (item.status) entry.status = capText(item.status, 32);
    out.push(entry);
  }
  return out;
}

function normalizeEvents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_EVENTS) break;
    if (!item || typeof item !== 'object') continue;
    const type = capText(item.type || 'event', 40);
    const summary = capText(item.summary || item.text || type, MAX_SUMMARY);
    if (!summary) continue;
    const entry = { type, summary };
    if (item.outcome) entry.outcome = capText(item.outcome, 32);
    if (item.actor) entry.actor = capText(item.actor, 40);
    if (item.path) {
      const p = contextPolicy.sanitizeRelPath(item.path);
      if (p) entry.path = p;
    }
    out.push(entry);
  }
  return out;
}

function normalizeEvidence(list, workspaceRoot) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (out.length >= MAX_EVIDENCE) break;
    let rel = '';
    let change = '';
    let hash = '';
    if (typeof item === 'string') {
      rel = item;
    } else if (item && typeof item === 'object') {
      rel = item.path || item.file || item.name || '';
      change = item.change || item.status || '';
      hash = item.hash || '';
    }
    // Convert absolute to relative when possible; drop if outside / excluded.
    if (path.isAbsolute(String(rel))) {
      rel = contextPolicy.workspaceRelative(rel, workspaceRoot) || '';
    }
    const clean = contextPolicy.sanitizeRelPath(rel);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const entry = { path: clean };
    if (change) entry.change = capText(change, 24);
    if (hash && /^[a-f0-9]{8,64}$/i.test(String(hash))) {
      entry.hash = String(hash).slice(0, 64);
    } else if (workspaceRoot) {
      const h = contextPolicy.fileContentHash(workspaceRoot, clean);
      if (h) entry.hash = h;
    }
    out.push(entry);
  }
  return out;
}

function buildResumeInstructions(capsule) {
  const lines = [
    'Provider-neutral resume instructions:',
    '1. Continue the incomplete work described in this continuation capsule.',
    '2. Do not redo completed tasks; focus on remaining tasks and acceptance criteria.',
    '3. Use only the listed workspace-relative evidence paths; do not require credentials or environment secrets.',
    '4. Respect the active context policy and run mode.',
    '5. Prefer incremental progress with clear outcomes; stop if blocked by missing human approval.',
  ];
  if (capsule.reason === 'rate_limit') {
    lines.push(
      '6. The previous run hit a rate-limit signal. Resume only after the user explicitly chose this provider/model.'
    );
  }
  if (capsule.constraints && capsule.constraints.mode === 'edit') {
    lines.push(
      '6. Edit mode: keep changes inside the selected workspace or isolated worktree; human approval is required before integration.'
    );
  }
  if (capsule.remainingTasks && capsule.remainingTasks.length) {
    lines.push('Remaining tasks:');
    for (const t of capsule.remainingTasks.slice(0, 12)) {
      lines.push(`- [${t.id}] ${t.summary}`);
      if (t.acceptanceCriteria && t.acceptanceCriteria.length) {
        for (const c of t.acceptanceCriteria.slice(0, 4)) lines.push(`  acceptance: ${c}`);
      }
    }
  }
  return capText(lines.join('\n'), MAX_INSTRUCTIONS);
}

/**
 * Validate and normalize a capsule object. Throws on hard invalid input.
 */
function validateCapsule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('capsule must be an object');
  }
  // Reject forbidden fields on the raw payload before normalization strips them.
  assertNoForbiddenFields(raw);
  const version = Number(raw.version) || CAPSULE_VERSION;
  if (version !== CAPSULE_VERSION) throw new Error(`unsupported capsule version: ${version}`);

  const workspaceId = sanitizeId(raw.workspaceId || raw.ws);
  const sessionId = sanitizeId(raw.sessionId || raw.sid);
  if (!workspaceId || !sessionId) throw new Error('capsule requires workspaceId and sessionId');

  const id = sanitizeId(raw.id) || createId();
  const reason = normalizeReason(raw.reason);
  const status = normalizeStatus(raw.status);
  const policy = contextPolicy.normalizePolicy(
    (raw.constraints && raw.constraints.contextPolicy) || raw.contextPolicy
  );

  const objective = capText(raw.objective || raw.taskSummary || '', MAX_OBJECTIVE);
  if (!objective) throw new Error('capsule requires a bounded objective or task summary');

  const capsule = {
    version: CAPSULE_VERSION,
    id,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now(),
    status,
    reason,
    workspaceId,
    sessionId,
    projectId: sanitizeId(raw.projectId) || undefined,
    objective,
    completedTasks: normalizeTaskList(raw.completedTasks),
    remainingTasks: normalizeTaskList(raw.remainingTasks),
    events: normalizeEvents(raw.events),
    evidence: normalizeEvidence(raw.evidence, raw.workspaceRoot || raw._workspaceRoot),
    constraints: {
      contextPolicy: policy,
      mode: normalizeMode((raw.constraints && raw.constraints.mode) || raw.mode),
      effort:
        raw.constraints && raw.constraints.effort ? capText(raw.constraints.effort, 24) : undefined,
    },
    source: {
      provider: capText((raw.source && raw.source.provider) || raw.provider || '', 40),
      model: capText((raw.source && raw.source.model) || raw.model || '', 60),
      role: capText((raw.source && raw.source.role) || raw.role || '', 40),
    },
    resumeInstructions: '',
    worktreeId: sanitizeId(raw.worktreeId) || undefined,
    useCount: Math.max(0, Number(raw.useCount) || 0),
    lastResumedAt: Number.isFinite(Number(raw.lastResumedAt))
      ? Number(raw.lastResumedAt)
      : undefined,
  };

  if (!capsule.projectId) delete capsule.projectId;
  if (!capsule.worktreeId) delete capsule.worktreeId;
  if (!capsule.constraints.effort) delete capsule.constraints.effort;
  if (!capsule.source.provider) delete capsule.source.provider;
  if (!capsule.source.model) delete capsule.source.model;
  if (!capsule.source.role) delete capsule.source.role;
  if (!capsule.lastResumedAt) delete capsule.lastResumedAt;

  capsule.resumeInstructions =
    capText(raw.resumeInstructions || '', MAX_INSTRUCTIONS) || buildResumeInstructions(capsule);

  // Strip any accidental secret-looking keys
  assertNoForbiddenFields(capsule);
  return capsule;
}

function assertNoForbiddenFields(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  const forbidden = new Set([
    'env',
    'environment',
    'processEnv',
    'apiKey',
    'api_key',
    'token',
    'accessToken',
    'refreshToken',
    'password',
    'secret',
    'authorization',
    'credentials',
    'sessionToken',
    'cookie',
    'cookies',
    'privateKey',
    'rawPrompt',
    'fullPrompt',
    'commandOutput',
  ]);
  for (const key of Object.keys(obj)) {
    if (forbidden.has(key)) {
      throw new Error(`capsule must not include forbidden field: ${key}`);
    }
    const val = obj[key];
    if (val && typeof val === 'object') assertNoForbiddenFields(val, depth + 1);
  }
}

function sessionDir(workspaceId, sessionId) {
  if (!isValidId(workspaceId) || !isValidId(sessionId)) {
    throw new Error('invalid workspace/session id');
  }
  return path.join(configured.root, workspaceId, sessionId);
}

function capsulePath(workspaceId, sessionId, capsuleId) {
  if (!isValidId(capsuleId)) throw new Error('invalid capsule id');
  return path.join(sessionDir(workspaceId, sessionId), `${capsuleId}.json`);
}

function writeCapsule(capsule) {
  const validated = validateCapsule(capsule);
  const dir = sessionDir(validated.workspaceId, validated.sessionId);
  ensureDir(dir);
  const file = capsulePath(validated.workspaceId, validated.sessionId, validated.id);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  // mode option is umask-masked on POSIX; chmod enforces 0600 on temp + destination.
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Best-effort on platforms that do not support POSIX modes (e.g. Windows).
  }
  fs.renameSync(tmp, file);
  // rename preserves mode on typical POSIX filesystems; re-apply for Windows/non-POSIX.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
  return validated;
}

function readCapsule(workspaceId, sessionId, capsuleId) {
  if (!isValidId(workspaceId) || !isValidId(sessionId) || !isValidId(capsuleId)) return null;
  const file = capsulePath(workspaceId, sessionId, capsuleId);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validateCapsule(raw);
  } catch {
    return null;
  }
}

function listCapsules(workspaceId, sessionId, options = {}) {
  if (!isValidId(workspaceId) || !isValidId(sessionId)) return [];
  const dir = sessionDir(workspaceId, sessionId);
  if (!fs.existsSync(dir)) return [];
  const eligibleOnly = options.eligibleOnly !== false;
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!isValidId(id)) continue;
    const cap = readCapsule(workspaceId, sessionId, id);
    if (!cap) continue;
    if (eligibleOnly && cap.status !== 'eligible') continue;
    out.push(cap);
  }
  out.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  return out;
}

function capsulePublicView(capsule) {
  if (!capsule) return null;
  return {
    id: capsule.id,
    version: capsule.version,
    createdAt: capsule.createdAt,
    updatedAt: capsule.updatedAt,
    status: capsule.status,
    reason: capsule.reason,
    workspaceId: capsule.workspaceId,
    sessionId: capsule.sessionId,
    projectId: capsule.projectId,
    objective: capsule.objective,
    completedTasks: capsule.completedTasks,
    remainingTasks: capsule.remainingTasks,
    events: capsule.events,
    evidence: capsule.evidence,
    constraints: capsule.constraints,
    source: capsule.source,
    resumeInstructions: capsule.resumeInstructions,
    worktreeId: capsule.worktreeId,
    useCount: capsule.useCount || 0,
    lastResumedAt: capsule.lastResumedAt,
    notice: contextPolicy.LOCAL_CONTROL_NOTICE,
  };
}

/**
 * Build a capsule from run/session state. Safe defaults when fields missing.
 */
function buildCapsule(input = {}) {
  const workspaceId = sanitizeId(input.workspaceId || input.ws);
  const sessionId = sanitizeId(input.sessionId || input.sid);
  if (!workspaceId || !sessionId) throw new Error('workspaceId and sessionId required');

  const policy = contextPolicy.normalizePolicy(input.contextPolicy || input.policy);
  const reason = normalizeReason(input.reason);
  const objective = capText(
    input.objective || input.taskSummary || input.promptSummary || 'Incomplete task',
    MAX_OBJECTIVE
  );

  let events = normalizeEvents(input.events);
  if (!events.length && Array.isArray(input.sessionEvents)) {
    events = normalizeEvents(contextPolicy.relevantEvents(input.sessionEvents, MAX_EVENTS));
  }

  let evidence = normalizeEvidence(input.evidence, input.workspaceRoot);
  if (!evidence.length && input.changes) {
    evidence = normalizeEvidence(
      contextPolicy.filterPaths((input.changes.files || []).map((f) => f)),
      input.workspaceRoot
    );
  }

  const completedTasks = normalizeTaskList(input.completedTasks);
  const remainingTasks = normalizeTaskList(
    input.remainingTasks && input.remainingTasks.length
      ? input.remainingTasks
      : objective
        ? [{ id: 'remaining-1', summary: objective }]
        : []
  );

  const capsule = validateCapsule({
    id: input.id || createId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'eligible',
    reason,
    workspaceId,
    sessionId,
    projectId: input.projectId,
    objective,
    completedTasks,
    remainingTasks,
    events,
    evidence,
    constraints: {
      contextPolicy: policy,
      mode: input.mode || 'plan',
      effort: input.effort,
    },
    source: {
      provider: input.provider || input.adapter,
      model: input.model,
      role: input.role,
    },
    worktreeId: input.worktreeId,
    workspaceRoot: input.workspaceRoot,
  });

  return capsule;
}

function persistCapsule(input, options = {}) {
  const capsule = input.version ? validateCapsule(input) : buildCapsule(input);
  const saved = writeCapsule(capsule);
  if (options.ledger && typeof options.ledger.append === 'function') {
    try {
      options.ledger.append({
        workspaceId: saved.workspaceId,
        sessionId: saved.sessionId,
        projectId: saved.projectId,
        actor: 'system',
        provider: saved.source && saved.source.provider,
        model: saved.source && saved.source.model,
        role: saved.source && saved.source.role,
        mode: saved.constraints && saved.constraints.mode,
        transition: 'capsule_created',
        outcome: 'pending',
        summary: `Continuation capsule created (${saved.reason})`,
        quality: {
          capsuleId: saved.id,
          reason: saved.reason,
          contextPolicy: saved.constraints.contextPolicy,
        },
        recovery: {
          from: saved.reason,
          to: 'eligible',
          worktreeId: saved.worktreeId,
        },
      });
    } catch {
      // ledger must not break capsule persistence
    }
  }
  return saved;
}

function markResumed(workspaceId, sessionId, capsuleId, options = {}) {
  const cap = readCapsule(workspaceId, sessionId, capsuleId);
  if (!cap) throw new Error('capsule not found');
  if (cap.status !== 'eligible' && !options.allowReuse) {
    throw new Error(`capsule is not eligible (status=${cap.status})`);
  }
  if ((cap.useCount || 0) >= MAX_RESUME_USES) {
    throw new Error('capsule resume limit reached');
  }
  cap.status = 'resumed';
  cap.useCount = (cap.useCount || 0) + 1;
  cap.lastResumedAt = Date.now();
  cap.updatedAt = Date.now();
  // Keep eligible if allowReuse so user can resume again after another failure.
  if (options.keepEligible) cap.status = 'eligible';
  const saved = writeCapsule(cap);
  if (options.ledger && typeof options.ledger.append === 'function') {
    try {
      options.ledger.append({
        workspaceId,
        sessionId,
        projectId: saved.projectId,
        actor: 'user',
        provider: options.provider,
        model: options.model,
        mode: options.mode || (saved.constraints && saved.constraints.mode),
        transition: 'capsule_resumed',
        outcome: 'started',
        summary: `Continuation capsule resumed (${saved.id})`,
        quality: {
          capsuleId: saved.id,
          contextPolicy:
            options.contextPolicy || (saved.constraints && saved.constraints.contextPolicy),
        },
        recovery: {
          from: 'eligible',
          to: 'resumed',
          resumed: true,
          worktreeId: saved.worktreeId,
        },
      });
    } catch {
      // ignore
    }
  }
  return saved;
}

/**
 * Build a provider-neutral resume prompt from a capsule.
 * Does not include raw original prompts beyond the bounded objective.
 */
function buildResumePrompt(capsule, options = {}) {
  const cap = validateCapsule(capsule);
  const policy = contextPolicy.normalizePolicy(
    options.contextPolicy || (cap.constraints && cap.constraints.contextPolicy)
  );
  const mode = normalizeMode(options.mode || (cap.constraints && cap.constraints.mode));
  const sections = [
    'You are resuming incomplete work from a provider-neutral continuation capsule.',
    contextPolicy.LOCAL_CONTROL_NOTICE,
    `Capsule id: ${cap.id}`,
    `Resume reason: ${cap.reason}`,
    `Context policy: ${policy}`,
    `Mode: ${mode}`,
    '',
    'Objective / task summary:',
    cap.objective,
    '',
    cap.resumeInstructions || buildResumeInstructions(cap),
  ];

  if (cap.completedTasks.length) {
    sections.push('', 'Completed tasks:');
    for (const t of cap.completedTasks) {
      sections.push(`- [${t.id}] ${t.summary}`);
    }
  }
  if (cap.remainingTasks.length) {
    sections.push('', 'Remaining tasks:');
    for (const t of cap.remainingTasks) {
      sections.push(`- [${t.id}] ${t.summary}`);
      if (t.acceptanceCriteria) {
        for (const c of t.acceptanceCriteria) sections.push(`  acceptance: ${c}`);
      }
    }
  }
  if (cap.events.length) {
    sections.push('', 'Normalized relevant events/outcomes:');
    for (const e of cap.events.slice(-16)) {
      sections.push(`- [${e.type}] ${e.summary}${e.outcome ? ' (' + e.outcome + ')' : ''}`);
    }
  }
  if (cap.evidence.length) {
    sections.push('', 'Workspace-relative evidence (paths/hashes only):');
    for (const e of cap.evidence) {
      sections.push(
        `- ${e.path}${e.hash ? ' sha256:' + e.hash : ''}${e.change ? ' [' + e.change + ']' : ''}`
      );
    }
  }
  if (cap.worktreeId) {
    sections.push(
      '',
      `Prior isolated worktree id (if still present): ${cap.worktreeId}. Prefer reviewing that worktree or a fresh isolated worktree; human approval is required before integration.`
    );
  }
  sections.push(
    '',
    'Proceed with the remaining work only. Do not invent credentials or read excluded/sensitive paths.'
  );
  return sections.join('\n');
}

function assertOwnership(capsule, workspaceId, sessionId) {
  if (!capsule) throw new Error('capsule not found');
  if (capsule.workspaceId !== workspaceId || capsule.sessionId !== sessionId) {
    throw new Error('capsule does not belong to this workspace/session');
  }
  return true;
}

module.exports = {
  CAPSULE_VERSION,
  REASONS,
  STATUSES,
  configure,
  resetConfig,
  isValidId,
  sanitizeId,
  createId,
  validateCapsule,
  buildCapsule,
  persistCapsule,
  readCapsule,
  listCapsules,
  capsulePublicView,
  markResumed,
  buildResumePrompt,
  buildResumeInstructions,
  assertOwnership,
  writeCapsule,
};
