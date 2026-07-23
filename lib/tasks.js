'use strict';

/*
 * Durable project/task lifecycle store.
 *
 * On-disk layout:
 *   data/projects/<projectId>.json
 *
 * Each file contains { project, tasks }, where tasks is an object keyed by task id.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = require('./data_dir');
const PROJECTS_DIR = path.join(DATA, 'projects');

/** Cap per-task evidence arrays at the N newest entries (every append path). */
const MAX_EVIDENCE_ENTRIES = 100;

const VALID_ID = /^[A-Za-z0-9._-]+$/;
const PROJECT_STATUSES = new Set(['planning', 'running', 'blocked', 'complete', 'cancelled']);
const PROJECT_PHASES = new Set(['planning', 'implementation', 'review', 'qa', 'summary', 'done']);
const TASK_STATUSES = new Set([
  'pending',
  'running',
  'blocked',
  'failed',
  'complete',
  'approved',
  'planned',
  'ready',
  'in_progress',
  'review',
  'done',
  'cancelled',
  'changes_requested',
]);
const DEP_SATISFIED = new Set(['done', 'complete', 'approved']);
const DEP_FAILED = new Set(['failed', 'cancelled']);
const TASK_TRANSITIONS = {
  planned: new Set(['ready', 'blocked', 'cancelled', 'in_progress', 'failed']),
  ready: new Set(['in_progress', 'blocked', 'cancelled', 'failed']),
  in_progress: new Set(['review', 'done', 'failed', 'cancelled', 'changes_requested']),
  review: new Set(['done', 'failed', 'changes_requested', 'in_progress']),
  blocked: new Set(['ready', 'planned', 'cancelled']),
  // Repair loop: original implementer re-enters in_progress from changes_requested.
  changes_requested: new Set(['ready', 'cancelled', 'in_progress', 'review', 'failed']),
  pending: new Set(['running', 'blocked', 'failed', 'complete', 'approved', 'cancelled', 'ready']),
  running: new Set(['blocked', 'failed', 'complete', 'approved', 'review', 'done', 'cancelled']),
  failed: new Set([]),
  done: new Set([]),
  complete: new Set([]),
  approved: new Set([]),
  cancelled: new Set([]),
};
const REVIEW_VERDICTS = new Set(['approve', 'request-changes', 'PASS', 'REQUEST_CHANGES']);
const TASK_MODES = new Set(['plan', 'edit']);
const ACCEPTANCE_STATUSES = new Set(['unknown', 'met', 'unmet']);

function now() {
  return new Date().toISOString();
}

function isValidId(id) {
  return typeof id === 'string' && VALID_ID.test(id);
}

function assertValidId(id, label) {
  if (!isValidId(id)) throw new Error(`invalid ${label || 'id'}`);
}

function ensureProjectsDir() {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  fs.mkdirSync(PROJECTS_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(DATA, 0o700);
    fs.chmodSync(PROJECTS_DIR, 0o700);
  } catch {}
}

function projectFile(projectId) {
  assertValidId(projectId, 'project id');
  return path.join(PROJECTS_DIR, `${projectId}.json`);
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  ensureProjectsDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Synchronous per-project-file mutate lock.
 * Serializes read-modify-write on a single project JSON file within this process.
 * Re-entrant: nested mutators share the same in-memory object (one final write).
 * Zero-dependency; keeps the public API synchronous.
 */
const projectMutations = new Map(); // projectId -> { data, depth }

function mutateProjectFile(projectId, mutator) {
  assertValidId(projectId, 'project id');
  const existing = projectMutations.get(projectId);
  if (existing) {
    existing.depth += 1;
    try {
      return mutator(existing.data);
    } finally {
      existing.depth -= 1;
    }
  }
  const data = requireProjectFile(projectId);
  const state = { data, depth: 1 };
  projectMutations.set(projectId, state);
  try {
    const result = mutator(data);
    saveProjectFile(projectId, data);
    return result;
  } finally {
    projectMutations.delete(projectId);
  }
}

function capEvidenceList(list) {
  if (!Array.isArray(list)) return [];
  if (list.length <= MAX_EVIDENCE_ENTRIES) return list;
  return list.slice(-MAX_EVIDENCE_ENTRIES);
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeAcceptanceState(list, criteria) {
  if (Array.isArray(list) && list.length) {
    return list
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        criterion: String(item.criterion || item.text || ''),
        status: ACCEPTANCE_STATUSES.has(item.status) ? item.status : 'unknown',
      }))
      .filter((item) => item.criterion);
  }
  const crit = Array.isArray(criteria) ? criteria : [];
  return crit.map((c) => ({ criterion: String(c), status: 'unknown' }));
}

function normalizeRepairState(repair) {
  if (!repair || typeof repair !== 'object' || Array.isArray(repair)) {
    return {
      enabled: false,
      maxIterations: 2,
      attempt: 0,
      status: 'idle',
      stopReason: null,
      lastFindingSet: '',
      history: [],
    };
  }
  return {
    enabled: repair.enabled === true,
    maxIterations: Number.isInteger(repair.maxIterations) ? repair.maxIterations : 2,
    attempt: Number.isInteger(repair.attempt) ? repair.attempt : 0,
    status: String(repair.status || 'idle'),
    stopReason: repair.stopReason || null,
    lastFindingSet: String(repair.lastFindingSet || ''),
    history: Array.isArray(repair.history) ? repair.history : [],
  };
}

function normalizeTaskRecord(task) {
  if (!task) return task;
  if (!Array.isArray(task.dependencies)) task.dependencies = [];
  if (!Array.isArray(task.artifacts)) task.artifacts = [];
  if (!Array.isArray(task.logs)) task.logs = [];
  if (!Array.isArray(task.evidence)) task.evidence = [];
  else task.evidence = capEvidenceList(task.evidence);
  if (!Array.isArray(task.acceptanceCriteria)) task.acceptanceCriteria = [];
  if (!Array.isArray(task.acceptanceState)) {
    task.acceptanceState = normalizeAcceptanceState(null, task.acceptanceCriteria);
  }
  if (task.attempts === undefined) task.attempts = 0;
  if (task.planStepIndex === undefined) task.planStepIndex = null;
  if (task.qualityGate === undefined) task.qualityGate = null;
  if (task.repair === undefined) task.repair = normalizeRepairState(null);
  else task.repair = normalizeRepairState(task.repair);
  return task;
}

function normalizeTaskStore(data) {
  if (!data || !data.project) return null;
  if (!data.tasks || typeof data.tasks !== 'object' || Array.isArray(data.tasks)) {
    data.tasks = {};
  }
  if (!Array.isArray(data.project.taskIds)) data.project.taskIds = [];
  if (!data.project.workspaceId) data.project.workspaceId = '';
  if (!data.project.sessionId) data.project.sessionId = '';
  for (const id of Object.keys(data.tasks)) {
    data.tasks[id] = normalizeTaskRecord(data.tasks[id]);
  }
  return data;
}

function loadProjectFile(projectId) {
  const file = projectFile(projectId);
  if (!fs.existsSync(file)) return null;
  return normalizeTaskStore(readJSON(file, null));
}

function requireProjectFile(projectId) {
  const data = loadProjectFile(projectId);
  if (!data) throw new Error(`project not found: ${projectId}`);
  return data;
}

function saveProjectFile(projectId, data) {
  writeJSON(projectFile(projectId), data);
}

function sanitizeProjectPatch(patch) {
  const next = { ...patch };
  delete next.id;
  delete next.taskIds;
  delete next.createdAt;
  delete next.updatedAt;
  if (next.status !== undefined && !PROJECT_STATUSES.has(next.status))
    throw new Error('invalid project status');
  if (next.phase !== undefined && !PROJECT_PHASES.has(next.phase))
    throw new Error('invalid project phase');
  return next;
}

function sanitizeTaskPatch(patch) {
  const next = { ...patch };
  delete next.id;
  delete next.projectId;
  delete next.createdAt;
  delete next.updatedAt;
  if (next.status !== undefined && !TASK_STATUSES.has(next.status))
    throw new Error('invalid task status');
  if (next.mode !== undefined && !TASK_MODES.has(next.mode)) throw new Error('invalid task mode');
  if (next.dependencies !== undefined) next.dependencies = normalizeDependencies(next.dependencies);
  if (next.reviewResult !== undefined) next.reviewResult = normalizeReview(next.reviewResult);
  if (next.repair !== undefined) next.repair = normalizeRepairState(next.repair);
  if (next.acceptanceState !== undefined) {
    next.acceptanceState = normalizeAcceptanceState(next.acceptanceState, next.acceptanceCriteria);
  }
  return next;
}

function normalizeDependencies(dependencies) {
  if (dependencies === undefined) return [];
  if (!Array.isArray(dependencies)) throw new Error('dependencies must be an array');
  for (const id of dependencies) assertValidId(id, 'dependency id');
  return dependencies.slice();
}

function normalizeMode(mode) {
  const next = mode || 'edit';
  if (!TASK_MODES.has(next)) throw new Error('invalid task mode');
  return next;
}

function normalizeReview(reviewResult) {
  if (reviewResult === null) return null;
  if (!reviewResult || typeof reviewResult !== 'object') throw new Error('invalid review result');
  // Structured gate form (preferred)
  if (
    reviewResult.parseStatus ||
    Array.isArray(reviewResult.findings) ||
    reviewResult.verdict === 'PASS' ||
    reviewResult.verdict === 'REQUEST_CHANGES'
  ) {
    let verdict = reviewResult.verdict || null;
    if (verdict === 'approve') verdict = 'PASS';
    if (verdict === 'request-changes') verdict = 'REQUEST_CHANGES';
    if (
      verdict != null &&
      verdict !== 'PASS' &&
      verdict !== 'REQUEST_CHANGES' &&
      !REVIEW_VERDICTS.has(verdict)
    ) {
      throw new Error('invalid review verdict');
    }
    const findings = Array.isArray(reviewResult.findings)
      ? reviewResult.findings
          .filter((f) => f && typeof f === 'object')
          .slice(0, 20)
          .map((f, i) => ({
            id: String(f.id || `F${i + 1}`).slice(0, 64),
            severity: String(f.severity || 'medium').slice(0, 24),
            summary: String(f.summary || '').slice(0, 240),
            ...(f.file ? { file: String(f.file).slice(0, 200) } : {}),
            ...(f.acceptanceCriterion
              ? { acceptanceCriterion: String(f.acceptanceCriterion).slice(0, 160) }
              : {}),
            ...(f.resolved === true ? { resolved: true } : {}),
          }))
          .filter((f) => f.summary)
      : [];
    return {
      verdict: verdict === 'PASS' || verdict === 'REQUEST_CHANGES' ? verdict : verdict || null,
      parseStatus: reviewResult.parseStatus === 'ok' ? 'ok' : 'incomplete',
      findings,
      notes: String(reviewResult.notes || '').slice(0, 400),
      evaluatedAt: reviewResult.evaluatedAt || now(),
    };
  }
  // Legacy form
  if (!REVIEW_VERDICTS.has(reviewResult.verdict)) throw new Error('invalid review verdict');
  const mapped =
    reviewResult.verdict === 'approve'
      ? 'PASS'
      : reviewResult.verdict === 'request-changes'
        ? 'REQUEST_CHANGES'
        : reviewResult.verdict;
  return {
    verdict: mapped === 'PASS' || mapped === 'REQUEST_CHANGES' ? mapped : reviewResult.verdict,
    parseStatus: 'ok',
    findings: [],
    notes: String(reviewResult.notes || '').slice(0, 400),
    evaluatedAt: now(),
  };
}

function createProject({ objective, teamId, leadName, workspaceId, sessionId }) {
  ensureProjectsDir();
  const ts = now();
  const project = {
    id: createId('project'),
    objective: String(objective || ''),
    teamId: String(teamId || ''),
    leadName: String(leadName || ''),
    workspaceId: String(workspaceId || ''),
    sessionId: String(sessionId || ''),
    status: 'planning',
    phase: 'planning',
    taskIds: [],
    summary: '',
    createdAt: ts,
    updatedAt: ts,
  };
  saveProjectFile(project.id, { project, tasks: {} });
  return project;
}

function createSessionProject(fields) {
  return createProject(fields);
}

function getProject(id) {
  const data = loadProjectFile(id);
  return data ? data.project : null;
}

function listProjects(filter = {}) {
  ensureProjectsDir();
  const ws = filter.workspaceId ? String(filter.workspaceId) : '';
  const sid = filter.sessionId ? String(filter.sessionId) : '';
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .filter(isValidId)
    .map((id) => loadProjectFile(id))
    .filter(Boolean)
    .map((data) => data.project)
    .filter((project) => {
      if (ws && project.workspaceId !== ws) return false;
      if (sid && project.sessionId !== sid) return false;
      return true;
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function findLatestProject({ workspaceId, sessionId }) {
  const rows = listProjects({ workspaceId, sessionId });
  return rows[0] || null;
}

function findProjectByWorktree({ workspaceId, sessionId, worktreeId }) {
  const id = String(worktreeId || '');
  if (!id) return null;
  for (const project of listProjects({ workspaceId, sessionId })) {
    const data = loadProjectFile(project.id);
    if (data && Object.values(data.tasks).some((task) => task && task.worktreeId === id)) {
      return project;
    }
  }
  return null;
}

function loadProjectBundle(projectId) {
  return loadProjectFile(projectId);
}

function projectOwnedBy(project, ws, sid) {
  if (!project) return false;
  if (ws && project.workspaceId !== ws) return false;
  if (sid && project.sessionId !== sid) return false;
  return true;
}

function updateProject(id, patch) {
  return mutateProjectFile(id, (data) => {
    data.project = {
      ...data.project,
      ...sanitizeProjectPatch(patch || {}),
      updatedAt: now(),
    };
    return data.project;
  });
}

function createTask(projectId, fields = {}) {
  const {
    title,
    objective,
    owner,
    dependencies,
    mode,
    status,
    planStepIndex,
    memberIndex,
    adapter,
    model,
    role,
    skillId,
    acceptanceCriteria,
    acceptanceState,
    repair,
  } = fields;
  return mutateProjectFile(projectId, (data) => {
    const ts = now();
    const initialStatus = status && TASK_STATUSES.has(status) ? status : 'pending';
    const criteria = Array.isArray(acceptanceCriteria)
      ? acceptanceCriteria.map((item) => String(item)).filter(Boolean)
      : [];
    const task = normalizeTaskRecord({
      id: createId('task'),
      projectId,
      title: String(title || ''),
      objective: String(objective || ''),
      owner: String(owner || ''),
      status: initialStatus,
      dependencies: normalizeDependencies(dependencies),
      artifacts: [],
      logs: [],
      evidence: [],
      reviewResult: null,
      mode: normalizeMode(mode),
      planStepIndex: planStepIndex === undefined ? null : planStepIndex,
      memberIndex: memberIndex === undefined ? null : memberIndex,
      adapter: String(adapter || ''),
      model: String(model || ''),
      role: String(role || ''),
      skillId: String(skillId || ''),
      acceptanceCriteria: criteria,
      acceptanceState: normalizeAcceptanceState(acceptanceState, criteria),
      attempts: 0,
      statusReason: '',
      worktreeId: '',
      branch: '',
      qualityGate: null,
      repair: normalizeRepairState(repair),
      createdAt: ts,
      updatedAt: ts,
    });
    data.tasks[task.id] = task;
    data.project.taskIds.push(task.id);
    data.project.updatedAt = ts;
    return task;
  });
}

function createTrackedTask(projectId, fields) {
  return createTask(projectId, fields);
}

function getTask(projectId, taskId) {
  assertValidId(taskId, 'task id');
  const data = requireProjectFile(projectId);
  return data.tasks[taskId] || null;
}

function listTasks(projectId) {
  const data = requireProjectFile(projectId);
  return data.project.taskIds.map((id) => data.tasks[id]).filter(Boolean);
}

function updateTask(projectId, taskId, patch) {
  assertValidId(taskId, 'task id');
  return mutateProjectFile(projectId, (data) => {
    if (!data.tasks[taskId]) throw new Error(`task not found: ${taskId}`);
    const ts = now();
    const nextPatch = sanitizeTaskPatch(patch || {});
    if (nextPatch.evidence !== undefined) {
      nextPatch.evidence = capEvidenceList(nextPatch.evidence);
    }
    data.tasks[taskId] = {
      ...data.tasks[taskId],
      ...nextPatch,
      updatedAt: ts,
    };
    data.project.updatedAt = ts;
    return data.tasks[taskId];
  });
}

function setTaskStatus(projectId, taskId, status) {
  if (!TASK_STATUSES.has(status)) throw new Error('invalid task status');
  return updateTask(projectId, taskId, { status });
}

function addArtifact(projectId, taskId, artifact) {
  const item = {
    ...artifact,
    type: String((artifact && artifact.type) || ''),
    name: String((artifact && artifact.name) || ''),
    createdAt: (artifact && artifact.createdAt) || now(),
  };
  return mutateProjectFile(projectId, (data) => {
    const task = data.tasks[taskId];
    if (!task) throw new Error(`task not found: ${taskId}`);
    const ts = now();
    task.artifacts = (task.artifacts || []).concat(item);
    task.updatedAt = ts;
    data.project.updatedAt = ts;
    return task;
  });
}

function addLog(projectId, taskId, { level, text }) {
  const item = {
    ts: now(),
    level: String(level || 'info'),
    text: String(text || ''),
  };
  return mutateProjectFile(projectId, (data) => {
    const task = data.tasks[taskId];
    if (!task) throw new Error(`task not found: ${taskId}`);
    const ts = now();
    task.logs = (task.logs || []).concat(item);
    task.updatedAt = ts;
    data.project.updatedAt = ts;
    return task;
  });
}

function setReview(projectId, taskId, reviewResult) {
  return updateTask(projectId, taskId, { reviewResult: normalizeReview(reviewResult) });
}

function setQualityGate(projectId, taskId, gate) {
  return updateTask(projectId, taskId, { qualityGate: gate || null });
}

function setRepairState(projectId, taskId, repair) {
  return updateTask(projectId, taskId, { repair: normalizeRepairState(repair) });
}

function setAcceptanceState(projectId, taskId, acceptanceState) {
  const task = getTask(projectId, taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  return updateTask(projectId, taskId, {
    acceptanceState: normalizeAcceptanceState(acceptanceState, task.acceptanceCriteria),
  });
}

function dependencyState(data, task) {
  for (const depId of task.dependencies) {
    const dep = data.tasks[depId];
    if (!dep) return { ok: false, blocked: true, reason: `missing dependency ${depId}` };
    if (DEP_FAILED.has(dep.status)) {
      return { ok: false, blocked: true, reason: `blocked by failed step ${dep.title || depId}` };
    }
    if (!DEP_SATISFIED.has(dep.status)) return { ok: false, blocked: false, reason: '' };
  }
  return { ok: true, blocked: false, reason: '' };
}

function readyTasks(projectId) {
  const data = requireProjectFile(projectId);
  return data.project.taskIds
    .map((id) => data.tasks[id])
    .filter(Boolean)
    .filter(
      (task) => task.status === 'pending' || task.status === 'planned' || task.status === 'ready'
    )
    .filter((task) => dependencyState(data, task).ok);
}

function refreshDependencyStates(projectId) {
  mutateProjectFile(projectId, (data) => {
    const ts = now();
    let changed = false;
    for (const id of data.project.taskIds) {
      const task = data.tasks[id];
      if (!task) continue;
      const dep = dependencyState(data, task);
      if (
        dep.blocked &&
        !['failed', 'cancelled', 'done', 'complete', 'approved', 'review', 'in_progress'].includes(
          task.status
        )
      ) {
        if (task.status !== 'blocked' || task.statusReason !== dep.reason) {
          task.status = 'blocked';
          task.statusReason = dep.reason;
          task.updatedAt = ts;
          changed = true;
        }
        continue;
      }
      if (task.status === 'blocked' && dep.ok) {
        task.status = 'planned';
        task.statusReason = '';
        task.updatedAt = ts;
        changed = true;
      }
      if ((task.status === 'planned' || task.status === 'pending') && dep.ok) {
        task.status = 'ready';
        task.updatedAt = ts;
        changed = true;
      }
    }
    if (changed) data.project.updatedAt = ts;
    return changed;
  });
}

function canTransition(from, to) {
  const allowed = TASK_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

function transitionTask(projectId, taskId, toStatus, extra = {}) {
  assertValidId(taskId, 'task id');
  if (!TASK_STATUSES.has(toStatus)) throw new Error('invalid task status');
  return mutateProjectFile(projectId, (data) => {
    const task = data.tasks[taskId];
    if (!task) throw new Error(`task not found: ${taskId}`);
    const from = task.status;
    if (from !== toStatus && !canTransition(from, toStatus)) {
      throw new Error(`illegal task transition ${from} -> ${toStatus}`);
    }
    const ts = now();
    const next = {
      ...task,
      status: toStatus,
      updatedAt: ts,
    };
    if (extra.statusReason !== undefined) next.statusReason = String(extra.statusReason || '');
    if (extra.worktreeId !== undefined) next.worktreeId = String(extra.worktreeId || '');
    if (extra.branch !== undefined) next.branch = String(extra.branch || '');
    if (extra.incrementAttempt) next.attempts = Number(task.attempts || 0) + 1;
    data.tasks[taskId] = next;
    data.project.updatedAt = ts;
    return next;
  });
}

function appendEvidence(projectId, taskId, item) {
  assertValidId(taskId, 'task id');
  return mutateProjectFile(projectId, (data) => {
    const task = data.tasks[taskId];
    if (!task) throw new Error(`task not found: ${taskId}`);
    const entry = {
      kind: String((item && item.kind) || 'note'),
      ...(item && typeof item === 'object' ? item : {}),
      ts: now(),
    };
    const ts = entry.ts;
    task.evidence = capEvidenceList((task.evidence || []).concat(entry));
    task.updatedAt = ts;
    data.project.updatedAt = ts;
    return task;
  });
}

function getTaskByPlanStep(projectId, planStepIndex) {
  const idx = Number(planStepIndex);
  if (!Number.isInteger(idx) || idx < 0) return null;
  return listTasks(projectId).find((task) => task.planStepIndex === idx) || null;
}

function findTaskByWorktree(projectId, worktreeId) {
  const id = String(worktreeId || '');
  if (!id) return null;
  return listTasks(projectId).find((task) => task.worktreeId === id) || null;
}

function statusCounts(projectId) {
  const counts = {};
  for (const task of listTasks(projectId)) {
    counts[task.status] = (counts[task.status] || 0) + 1;
  }
  return counts;
}

function taskPublicView(task) {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    objective: task.objective,
    owner: task.owner,
    status: task.status,
    dependencies: task.dependencies,
    mode: task.mode,
    planStepIndex: task.planStepIndex,
    memberIndex: task.memberIndex,
    adapter: task.adapter,
    model: task.model,
    role: task.role,
    skillId: task.skillId,
    acceptanceCriteria: task.acceptanceCriteria,
    acceptanceState: task.acceptanceState || [],
    attempts: task.attempts,
    statusReason: task.statusReason,
    worktreeId: task.worktreeId,
    branch: task.branch,
    reviewResult: task.reviewResult,
    qualityGate: task.qualityGate || null,
    repair: task.repair || null,
    evidence: task.evidence,
    artifacts: task.artifacts,
    logs: task.logs,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function exportAllProjects() {
  ensureProjectsDir();
  const out = [];
  for (const file of fs.readdirSync(PROJECTS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const id = file.replace(/\.json$/, '');
    if (!isValidId(id)) continue;
    const data = loadProjectFile(id);
    if (data) out.push(data);
  }
  return out;
}

function importAllProjects(items) {
  if (!Array.isArray(items)) return 0;
  let count = 0;
  for (const data of items) {
    const normalized = normalizeTaskStore(data);
    if (!normalized || !normalized.project || !isValidId(normalized.project.id)) continue;
    saveProjectFile(normalized.project.id, normalized);
    count++;
  }
  return count;
}

module.exports = {
  MAX_EVIDENCE_ENTRIES,
  createProject,
  createSessionProject,
  getProject,
  listProjects,
  findLatestProject,
  findProjectByWorktree,
  loadProjectBundle,
  projectOwnedBy,
  updateProject,
  createTask,
  createTrackedTask,
  getTask,
  listTasks,
  updateTask,
  setTaskStatus,
  addArtifact,
  addLog,
  setReview,
  setQualityGate,
  setRepairState,
  setAcceptanceState,
  readyTasks,
  refreshDependencyStates,
  transitionTask,
  appendEvidence,
  getTaskByPlanStep,
  findTaskByWorktree,
  statusCounts,
  taskPublicView,
  exportAllProjects,
  importAllProjects,
  normalizeReview,
  normalizeRepairState,
  mutateProjectFile,
  DEP_SATISFIED,
};
