'use strict';

/*
 * Append-only local execution ledger (zero runtime dependencies).
 *
 * On-disk: data/ledger/entries.jsonl (mode 600, private dir 700)
 * Each line is one JSON entry. Corrupt lines are skipped on read.
 *
 * Never stores prompt text, env vars, API keys, tokens, unbounded command
 * output, or patent data. Fields are capped and secrets redacted.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_VERSION = 1;
const DEFAULT_DATA = require('./data_dir');
const DEFAULT_DIR = path.join(DEFAULT_DATA, 'ledger');
const DEFAULT_FILE = path.join(DEFAULT_DIR, 'entries.jsonl');

const MAX_RETAINED = 4000;
const ROTATE_KEEP = 3000;
const MAX_SUMMARY = 280;
const MAX_SHORT = 120;
const MAX_ID = 80;
const MAX_FILES = 40;
const MAX_FILE_PATH = 200;
const MAX_QUALITY_KEYS = 16;
const MAX_LIST_DEFAULT = 100;
const MAX_LIST_HARD = 500;
const MAX_EXPORT = 2000;

const VALID_ID = /^[A-Za-z0-9._-]+$/;

const TRANSITIONS = new Set([
  'run_started',
  'run_finished',
  'run_failed',
  'run_cancelled',
  'run_stopped',
  'plan_proposed',
  'plan_failed',
  'plan_approved',
  'step_started',
  'step_finished',
  'step_failed',
  'pending_integration',
  'integrated',
  'integration_failed',
  'rejected',
  'review_started',
  'review_finished',
  'review_failed',
  'quality_evaluated',
  'repair_started',
  'repair_finished',
  'repair_stopped',
  'override_integrate',
  'capsule_created',
  'capsule_resumed',
  'recovery',
]);

const OUTCOMES = new Set([
  'started',
  'success',
  'failure',
  'cancelled',
  'pending',
  'approved',
  'rejected',
  'info',
]);

const DECISIONS = new Set([
  'approved',
  'integrated',
  'rejected',
  'changes_requested',
  'stopped',
  'none',
]);

const SECRET_PATTERNS = [
  // Full-token replacements (group 1 is the secret itself).
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, keepPrefix: false },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, keepPrefix: false },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, keepPrefix: false },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, keepPrefix: false },
  { re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, keepPrefix: false },
  // Keep the label, redact the value.
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keepPrefix: true },
  {
    re: /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*['"]?[^\s'"]{6,}/gi,
    keepPrefix: true,
  },
  { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, keepPrefix: false },
];

let configured = {
  file: process.env.CREW_FORGE_LEDGER_FILE || DEFAULT_FILE,
  dir: process.env.CREW_FORGE_LEDGER_DIR || DEFAULT_DIR,
};

function configure(options = {}) {
  if (options.file) {
    configured.file = options.file;
    configured.dir = path.dirname(options.file);
  } else if (options.dir) {
    configured.dir = options.dir;
    configured.file = path.join(options.dir, 'entries.jsonl');
  }
  return { ...configured };
}

function resetConfig() {
  configured = {
    file: process.env.CREW_FORGE_LEDGER_FILE || DEFAULT_FILE,
    dir: process.env.CREW_FORGE_LEDGER_DIR || DEFAULT_DIR,
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

function redactText(input, max = MAX_SUMMARY) {
  let text = input == null ? '' : String(input);
  text = text.replace(/\0/g, '');
  for (const { re, keepPrefix } of SECRET_PATTERNS) {
    text = text.replace(re, (match, g1) => {
      if (keepPrefix && typeof g1 === 'string') {
        // Preserve only a short label prefix (e.g. "Bearer ", "api_key=").
        const label = g1.length <= 24 ? g1 : g1.slice(0, 24);
        return `${label}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  // Neutralize path-looking home expansions that might leak secrets folders
  text = text.replace(
    /(~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.(ssh|aws|gnupg|config)\b[^\s]*/gi,
    '[REDACTED_PATH]'
  );
  if (text.length > max) text = text.slice(0, max - 1) + '…';
  return text;
}

function capString(value, max = MAX_SHORT) {
  if (value == null) return '';
  return redactText(String(value), max);
}

function normalizeTransition(value) {
  const t = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  return TRANSITIONS.has(t) ? t : 'recovery';
}

function normalizeOutcome(value) {
  const o = String(value || '')
    .trim()
    .toLowerCase();
  return OUTCOMES.has(o) ? o : 'info';
}

function normalizeDecision(value) {
  if (value == null || value === '') return null;
  const d = String(value)
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  return DECISIONS.has(d) ? d : 'none';
}

function normalizeMode(value) {
  const m = String(value || '')
    .trim()
    .toLowerCase();
  if (m === 'edit' || m === 'plan' || m === 'review' || m === 'team') return m;
  return m ? capString(m, 32) : '';
}

function normalizeFiles(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_FILES) break;
    if (item == null) continue;
    if (typeof item === 'string') {
      const p = capString(item, MAX_FILE_PATH);
      if (p) out.push({ path: p });
      continue;
    }
    if (typeof item === 'object') {
      const entry = {
        path: capString(item.path || item.file || item.name || '', MAX_FILE_PATH),
      };
      if (item.status) entry.status = capString(item.status, 24);
      if (item.change) entry.change = capString(item.change, 24);
      if (Number.isFinite(Number(item.additions))) entry.additions = Number(item.additions);
      if (Number.isFinite(Number(item.deletions))) entry.deletions = Number(item.deletions);
      if (entry.path) out.push(entry);
    }
  }
  return out;
}

function normalizeDiffSummary(input) {
  if (!input) return null;
  if (typeof input === 'string') return { text: capString(input, MAX_SUMMARY) };
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  if (input.text) out.text = capString(input.text, MAX_SUMMARY);
  if (Number.isFinite(Number(input.filesChanged))) out.filesChanged = Number(input.filesChanged);
  if (Number.isFinite(Number(input.additions))) out.additions = Number(input.additions);
  if (Number.isFinite(Number(input.deletions))) out.deletions = Number(input.deletions);
  if (Array.isArray(input.files)) out.files = normalizeFiles(input.files);
  return Object.keys(out).length ? out : null;
}

function normalizeQuality(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= MAX_QUALITY_KEYS) break;
    const k = capString(key, 40).replace(/[^A-Za-z0-9._-]/g, '_');
    if (!k) continue;
    if (typeof value === 'boolean' || typeof value === 'number') {
      out[k] = value;
      count++;
    } else if (value == null) {
      continue;
    } else {
      out[k] = capString(value, 80);
      count++;
    }
  }
  return Object.keys(out).length ? out : null;
}

function normalizeRecovery(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  if (input.from) out.from = capString(input.from, 40);
  if (input.to) out.to = capString(input.to, 40);
  if (input.reason) out.reason = capString(input.reason, MAX_SUMMARY);
  if (input.worktreeId) out.worktreeId = sanitizeId(input.worktreeId);
  if (input.resumed === true || input.resumed === false) out.resumed = input.resumed;
  return Object.keys(out).length ? out : null;
}

function createId() {
  return `led-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function buildEntry(raw = {}) {
  const transition = normalizeTransition(raw.transition || raw.type);
  const outcome = normalizeOutcome(raw.outcome);
  const entry = {
    version: LEDGER_VERSION,
    id: sanitizeId(raw.id) || createId(),
    timestamp: Number.isFinite(Number(raw.timestamp)) ? Number(raw.timestamp) : Date.now(),
    actor: capString(raw.actor || '', 40),
    provider: capString(raw.provider || raw.adapter || '', 40),
    model: capString(raw.model || '', 60),
    role: capString(raw.role || '', 40),
    workspaceId: sanitizeId(raw.workspaceId || raw.ws || ''),
    sessionId: sanitizeId(raw.sessionId || raw.sid || ''),
    projectId: sanitizeId(raw.projectId || ''),
    taskId: sanitizeId(raw.taskId || ''),
    step:
      raw.step == null || raw.step === ''
        ? null
        : Number.isFinite(Number(raw.step))
          ? Number(raw.step)
          : null,
    mode: normalizeMode(raw.mode),
    transition,
    outcome,
    summary: capString(raw.summary || raw.text || '', MAX_SUMMARY),
    files: normalizeFiles(raw.files),
    diffSummary: normalizeDiffSummary(raw.diffSummary || raw.fileSummary),
    quality: normalizeQuality(raw.quality),
    decision: normalizeDecision(raw.decision),
    recovery: normalizeRecovery(raw.recovery),
  };

  // Strip empty optional objects/arrays for compactness
  if (!entry.files.length) delete entry.files;
  if (!entry.diffSummary) delete entry.diffSummary;
  if (!entry.quality) delete entry.quality;
  if (!entry.decision) delete entry.decision;
  if (!entry.recovery) delete entry.recovery;
  if (entry.step == null) delete entry.step;
  if (!entry.projectId) delete entry.projectId;
  if (!entry.taskId) delete entry.taskId;
  if (!entry.mode) delete entry.mode;
  if (!entry.model) delete entry.model;
  if (!entry.role) delete entry.role;
  if (!entry.actor) delete entry.actor;
  if (!entry.provider) delete entry.provider;

  return entry;
}

function ledgerPath() {
  return configured.file;
}

function readAllRawLines() {
  const file = ledgerPath();
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
}

function parseLines(lines) {
  const entries = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.id) {
        entries.push(obj);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

function atomicWrite(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best effort
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

function rotateIfNeeded() {
  const file = ledgerPath();
  const { entries } = parseLines(readAllRawLines());
  if (entries.length <= MAX_RETAINED) return;
  const kept = entries.slice(-ROTATE_KEEP);
  atomicWrite(file, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/**
 * Append one ledger entry. Returns the normalized entry or null on hard failure.
 * Never throws for validation issues — returns null after no-op.
 */
function append(raw) {
  try {
    const entry = buildEntry(raw || {});
    // Require at least a transition and some scope when identifiers exist — allow system-wide events too.
    if (!entry.transition) return null;
    ensureDir(configured.dir);
    const file = ledgerPath();
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best effort
    }
    // Opportunistic rotation (cheap check every ~append via line count estimate)
    try {
      const stat = fs.statSync(file);
      // ~400 bytes/entry rough; trigger parse+rotate when large
      if (stat.size > MAX_RETAINED * 500) rotateIfNeeded();
    } catch {
      // ignore
    }
    return entry;
  } catch {
    return null;
  }
}

function matchesFilter(entry, filter = {}) {
  if (filter.workspaceId && entry.workspaceId !== filter.workspaceId) return false;
  if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
  if (filter.projectId && entry.projectId !== filter.projectId) return false;
  if (filter.provider && entry.provider !== filter.provider) return false;
  if (filter.transition && entry.transition !== filter.transition) return false;
  if (filter.outcome && entry.outcome !== filter.outcome) return false;
  if (filter.since && Number(entry.timestamp) < Number(filter.since)) return false;
  if (filter.until && Number(entry.timestamp) > Number(filter.until)) return false;
  return true;
}

function list(filter = {}) {
  const limit = Math.min(Math.max(1, Number(filter.limit) || MAX_LIST_DEFAULT), MAX_LIST_HARD);
  const { entries, skipped } = parseLines(readAllRawLines());
  const filtered = entries.filter((e) => matchesFilter(e, filter));
  // Newest first
  filtered.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  return {
    entries: filtered.slice(0, limit),
    total: filtered.length,
    skippedCorrupt: skipped,
  };
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportJson(filter = {}) {
  const result = list({
    ...filter,
    limit: Math.min(Number(filter.limit) || MAX_EXPORT, MAX_EXPORT),
  });
  return {
    version: LEDGER_VERSION,
    exportedAt: new Date().toISOString(),
    total: result.total,
    skippedCorrupt: result.skippedCorrupt,
    entries: result.entries,
  };
}

function exportCsv(filter = {}) {
  const result = list({
    ...filter,
    limit: Math.min(Number(filter.limit) || MAX_EXPORT, MAX_EXPORT),
  });
  const columns = [
    'timestamp',
    'id',
    'workspaceId',
    'sessionId',
    'projectId',
    'taskId',
    'step',
    'actor',
    'provider',
    'model',
    'role',
    'mode',
    'transition',
    'outcome',
    'decision',
    'summary',
    'files',
    'diffSummary',
    'quality',
    'recovery',
  ];
  const rows = [columns.map(csvCell).join(',')];
  for (const e of result.entries) {
    const ts = Number.isFinite(Number(e.timestamp))
      ? new Date(Number(e.timestamp)).toISOString()
      : '';
    rows.push(
      [
        ts,
        e.id,
        e.workspaceId,
        e.sessionId,
        e.projectId,
        e.taskId,
        e.step,
        e.actor,
        e.provider,
        e.model,
        e.role,
        e.mode,
        e.transition,
        e.outcome,
        e.decision,
        e.summary,
        e.files ? JSON.stringify(e.files) : '',
        e.diffSummary ? JSON.stringify(e.diffSummary) : '',
        e.quality ? JSON.stringify(e.quality) : '',
        e.recovery ? JSON.stringify(e.recovery) : '',
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return rows.join('\r\n') + '\r\n';
}

/** Test helper: wipe ledger file under current config. */
function _resetForTests() {
  try {
    fs.rmSync(ledgerPath(), { force: true });
  } catch {
    // ignore
  }
}

module.exports = {
  LEDGER_VERSION,
  MAX_RETAINED,
  TRANSITIONS,
  OUTCOMES,
  configure,
  resetConfig,
  isValidId,
  sanitizeId,
  redactText,
  buildEntry,
  append,
  list,
  exportJson,
  exportCsv,
  normalizeTransition,
  normalizeOutcome,
  _resetForTests,
  _rotateIfNeeded: rotateIfNeeded,
};
