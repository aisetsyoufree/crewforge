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

const DATA = path.join(__dirname, '..', 'data');
const PROJECTS_DIR = path.join(DATA, 'projects');

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
  in_progress: new Set(['review', 'done', 'failed', 'cancelled']),
  review: new Set(['done', 'failed', 'changes_requested']),
  blocked: new Set(['ready', 'planned', 'cancelled']),
  changes_requested: new Set(['ready', 'cancelled']),
  pending: new Set(['running', 'blocked', 'failed', 'complete', 'approved', 'cancelled', 'ready']),
  running: new Set(['blocked', 'failed', 'complete', 'approved', 'review', 'done', 'cancelled']),
  failed: new Set([]),
  done: new Set([]),
  complete: new Set([]),
  approved: new Set([]),
  cancelled: new Set([]),
};
const REVIEW_VERDICTS = new Set(['approve', 'request-changes']);
const TASK_MODES = new Set(['plan', 'edit']);

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

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeTaskRecord(task) {
  if (!task) return task;
  if (!Array.isArray(task.dependencies)) task.dependencies = [];
  if (!Array.isArray(task.artifacts)) task.artifacts = [];
  if (!Array.isArray(task.logs)) task.logs = [];
  if (!Array.isArray(task.evidence)) task.evidence = [];
  if (!Array.isArray(task.acceptanceCriteria)) task.acceptanceCriteria = [];
  if (task.attempts === undefined) task.attempts = 0;
  if (task.planStepIndex === undefined) task.planStepIndex = null;
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
  if (!REVIEW_VERDICTS.has(reviewResult.verdict)) throw new Error('invalid review verdict');
  return {
    verdict: reviewResult.verdict,
    notes: String(reviewResult.notes || ''),
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
  const data = requireProjectFile(id);
  data.project = {
    ...data.project,
    ...sanitizeProjectPatch(patch || {}),
    updatedAt: now(),
  };
  saveProjectFile(id, data);
  return data.project;
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
  } = fields;
  const data = requireProjectFile(projectId);
  const ts = now();
  const initialStatus = status && TASK_STATUSES.has(status) ? status : 'pending';
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
    acceptanceCriteria: Array.isArray(acceptanceCriteria)
      ? acceptanceCriteria.map((item) => String(item)).filter(Boolean)
      : [],
    attempts: 0,
    statusReason: '',
    worktreeId: '',
    branch: '',
    createdAt: ts,
    updatedAt: ts,
  });
  data.tasks[task.id] = task;
  data.project.taskIds.push(task.id);
  data.project.updatedAt = ts;
  saveProjectFile(projectId, data);
  return task;
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
  const data = requireProjectFile(projectId);
  if (!data.tasks[taskId]) throw new Error(`task not found: ${taskId}`);
  const ts = now();
  data.tasks[taskId] = {
    ...data.tasks[taskId],
    ...sanitizeTaskPatch(patch || {}),
    updatedAt: ts,
  };
  data.project.updatedAt = ts;
  saveProjectFile(projectId, data);
  return data.tasks[taskId];
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
  const task = getTask(projectId, taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  return updateTask(projectId, taskId, { artifacts: task.artifacts.concat(item) });
}

function addLog(projectId, taskId, { level, text }) {
  const item = {
    ts: now(),
    level: String(level || 'info'),
    text: String(text || ''),
  };
  const task = getTask(projectId, taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  return updateTask(projectId, taskId, { logs: task.logs.concat(item) });
}

function setReview(projectId, taskId, reviewResult) {
  return updateTask(projectId, taskId, { reviewResult: normalizeReview(reviewResult) });
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
  const data = requireProjectFile(projectId);
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
  if (changed) {
    data.project.updatedAt = ts;
    saveProjectFile(projectId, data);
  }
}

function canTransition(from, to) {
  const allowed = TASK_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

function transitionTask(projectId, taskId, toStatus, extra = {}) {
  assertValidId(taskId, 'task id');
  if (!TASK_STATUSES.has(toStatus)) throw new Error('invalid task status');
  const data = requireProjectFile(projectId);
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
  saveProjectFile(projectId, data);
  return next;
}

function appendEvidence(projectId, taskId, item) {
  const task = getTask(projectId, taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  const entry = {
    kind: String((item && item.kind) || 'note'),
    ...(item && typeof item === 'object' ? item : {}),
    ts: now(),
  };
  return updateTask(projectId, taskId, { evidence: task.evidence.concat(entry) });
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
    attempts: task.attempts,
    statusReason: task.statusReason,
    worktreeId: task.worktreeId,
    branch: task.branch,
    reviewResult: task.reviewResult,
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
  DEP_SATISFIED,
};
