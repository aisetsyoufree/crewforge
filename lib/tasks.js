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
const TASK_STATUSES = new Set(['pending', 'running', 'blocked', 'failed', 'complete', 'approved']);
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

function normalizeTaskStore(data) {
  if (!data || !data.project) return null;
  if (!data.tasks || typeof data.tasks !== 'object' || Array.isArray(data.tasks)) {
    data.tasks = {};
  }
  if (!Array.isArray(data.project.taskIds)) data.project.taskIds = [];
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

function createProject({ objective, teamId, leadName }) {
  ensureProjectsDir();
  const ts = now();
  const project = {
    id: createId('project'),
    objective: String(objective || ''),
    teamId: String(teamId || ''),
    leadName: String(leadName || ''),
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

function getProject(id) {
  const data = loadProjectFile(id);
  return data ? data.project : null;
}

function listProjects() {
  ensureProjectsDir();
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .filter(isValidId)
    .map((id) => loadProjectFile(id))
    .filter(Boolean)
    .map((data) => data.project)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
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

function createTask(projectId, { title, objective, owner, dependencies, mode }) {
  const data = requireProjectFile(projectId);
  const ts = now();
  const task = {
    id: createId('task'),
    projectId,
    title: String(title || ''),
    objective: String(objective || ''),
    owner: String(owner || ''),
    status: 'pending',
    dependencies: normalizeDependencies(dependencies),
    artifacts: [],
    logs: [],
    reviewResult: null,
    mode: normalizeMode(mode),
    createdAt: ts,
    updatedAt: ts,
  };
  data.tasks[task.id] = task;
  data.project.taskIds.push(task.id);
  data.project.updatedAt = ts;
  saveProjectFile(projectId, data);
  return task;
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

function readyTasks(projectId) {
  const data = requireProjectFile(projectId);
  return data.project.taskIds
    .map((id) => data.tasks[id])
    .filter(Boolean)
    .filter((task) => task.status === 'pending')
    .filter((task) =>
      task.dependencies.every((id) => {
        const dep = data.tasks[id];
        return dep && (dep.status === 'approved' || dep.status === 'complete');
      })
    );
}

module.exports = {
  createProject,
  getProject,
  listProjects,
  updateProject,
  createTask,
  getTask,
  listTasks,
  updateTask,
  setTaskStatus,
  addArtifact,
  addLog,
  setReview,
  readyTasks,
};
