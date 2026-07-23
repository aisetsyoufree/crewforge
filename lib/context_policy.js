'use strict';

/*
 * Server-enforced privacy-aware context policy.
 *
 * Policies:
 *   relevant-only   (default) — objective + bounded metadata/events + selected/changed paths
 *   metadata-only             — names/types/tree/task evidence; no file contents
 *   full-workspace            — broader workspace listing via provider CLI; still excludes
 *                               sensitive/ignored paths; user is warned
 *
 * Exclusions are enforced when Crew Forge constructs prompts, trees, evidence,
 * and review material. Provider CLIs may still read files under the workspace
 * when run in full-workspace mode — label this accurately as local control with
 * provider processing, not local/private inference.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POLICY_VERSION = 1;
const POLICIES = Object.freeze(['relevant-only', 'metadata-only', 'full-workspace']);
const DEFAULT_POLICY = 'relevant-only';

const MAX_OBJECTIVE = 2000;
const MAX_EVENT_SUMMARY = 200;
const MAX_EVENTS = 24;
const MAX_PATHS = 40;
const MAX_PATH_LEN = 200;
const MAX_TREE_ENTRIES = 120;
const MAX_TREE_DEPTH = 3;
const MAX_TREE_CHARS = 6000;
const MAX_FILE_BYTES_FOR_HASH = 512 * 1024;

const LOCAL_CONTROL_NOTICE =
  'Local control with provider processing: Crew Forge runs on this machine and selects what context to send, but the selected provider CLI/API performs inference. Do not treat provider inference as local or private to Crew Forge alone.';

const FULL_WORKSPACE_WARNING =
  'Full-workspace context policy is active. The provider may see a broader workspace listing and can read non-excluded files through its CLI. Sensitive and ignored paths are still excluded from Crew Forge-built context.';

/** Default exclusion set (basename or path segment / prefix patterns). */
const DEFAULT_EXCLUSION_PATTERNS = Object.freeze([
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*credentials*',
  '*secret*',
  '*secrets*',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.ssh',
  '.aws',
  '.gnupg',
  '.config',
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'data',
  'runs',
  '.crewforge-worktrees',
  'worktrees',
  'patent',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
  '.nyc_output',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.parcel-cache',
  'vendor',
  'tmp',
  'logs',
  'sessions',
]);

const SENSITIVE_DIR_NAMES = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.config',
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'patent',
  '.crewforge-worktrees',
  'worktrees',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
  '.nyc_output',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.parcel-cache',
  'vendor',
  'tmp',
  'logs',
  'sessions',
  'data',
  'runs',
]);

function normalizePolicy(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  if (raw === 'relevant' || raw === 'relevantonly') return 'relevant-only';
  if (raw === 'metadata' || raw === 'metadataonly') return 'metadata-only';
  if (raw === 'full' || raw === 'fullworkspace' || raw === 'full-ws') return 'full-workspace';
  return POLICIES.includes(raw) ? raw : DEFAULT_POLICY;
}

function isValidPolicy(value) {
  return POLICIES.includes(
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, '-')
  );
}

function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function compilePatterns(extra = []) {
  const list = [...DEFAULT_EXCLUSION_PATTERNS];
  if (Array.isArray(extra)) {
    for (const item of extra) {
      const p = String(item || '').trim();
      if (p && p.length <= 120) list.push(p);
    }
  }
  return list.map((p) => ({ raw: p, re: globToRegExp(p) }));
}

const DEFAULT_COMPILED = compilePatterns();

function toPosixRel(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
}

/**
 * Returns true when a workspace-relative path must be excluded from context.
 * Rejects absolute paths, parent escapes, and default/configurable patterns.
 */
function isExcludedPath(relPath, options = {}) {
  if (relPath == null || relPath === '') return true;
  const raw = String(relPath);
  if (path.isAbsolute(raw)) return true;
  // Unix absolute or Windows drive / UNC, even if path.isAbsolute is false on host OS.
  if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(raw.replace(/\\/g, '/'))) return true;
  if (raw.includes('\0')) return true;
  const posix = toPosixRel(raw).replace(/^\/+/, '');
  if (!posix || posix === '.' || posix.startsWith('../') || posix.includes('/../')) return true;

  const segments = posix.split('/').filter(Boolean);
  if (!segments.length) return true;
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return true;
    if (SENSITIVE_DIR_NAMES.has(seg)) return true;
  }

  const compiled = options.compiled || DEFAULT_COMPILED;
  const base = segments[segments.length - 1];
  for (const { re } of compiled) {
    if (re.test(base) || re.test(posix)) return true;
    // Also match any path segment against the pattern (e.g. "credentials").
    for (const seg of segments) {
      if (re.test(seg)) return true;
    }
  }

  // Hidden credential-ish files
  if (/^\.env($|\.)/i.test(base)) return true;
  if (/\.(pem|key|p12|pfx|jks)$/i.test(base)) return true;
  if (/(^|[/\\])(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/i.test(posix)) return true;

  return false;
}

function sanitizeRelPath(relPath, options = {}) {
  const posix = toPosixRel(relPath);
  if (!posix || posix.length > MAX_PATH_LEN) return null;
  if (isExcludedPath(posix, options)) return null;
  return posix.slice(0, MAX_PATH_LEN);
}

function filterPaths(paths, options = {}) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(paths) ? paths : []) {
    if (out.length >= MAX_PATHS) break;
    const raw =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? item.path || item.file || item.name
          : '';
    const clean = sanitizeRelPath(raw, options);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    if (typeof item === 'object' && item && !Array.isArray(item)) {
      out.push({
        path: clean,
        status: item.status ? String(item.status).slice(0, 16) : undefined,
        change: item.change ? String(item.change).slice(0, 24) : undefined,
      });
    } else {
      out.push({ path: clean });
    }
  }
  return out;
}

function capText(value, max) {
  const text = String(value == null ? '' : value)
    .replace(/\0/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function redactSecrets(text) {
  let out = String(text || '');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
  out = out.replace(
    /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*['"]?[^\s'"]{6,}/gi,
    '$1=[REDACTED]'
  );
  out = out.replace(
    /(~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.(ssh|aws|gnupg|config)\b[^\s]*/gi,
    '[REDACTED_PATH]'
  );
  // Strip absolute paths that look like host paths.
  out = out.replace(
    /(^|[\s"'])(\/Users\/|\/home\/|\/var\/|\/tmp\/|\/private\/)[^\s"']+/g,
    '$1[PATH]'
  );
  return out;
}

function workspaceRelative(filePath, workspaceRoot) {
  if (!filePath || !workspaceRoot) return null;
  try {
    const abs = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(workspaceRoot, filePath);
    const root = path.resolve(workspaceRoot);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return toPosixRel(rel);
  } catch {
    return null;
  }
}

function fileContentHash(workspaceRoot, relPath) {
  const clean = sanitizeRelPath(relPath);
  if (!clean || !workspaceRoot) return null;
  try {
    const abs = path.join(path.resolve(workspaceRoot), ...clean.split('/'));
    const root = path.resolve(workspaceRoot);
    if (!abs.startsWith(root + path.sep) && abs !== root) return null;
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES_FOR_HASH) return null;
    const buf = fs.readFileSync(abs);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Bounded workspace tree (names only). Always applies exclusions.
 */
function buildBoundedTree(workspaceRoot, options = {}) {
  const maxFiles = Math.min(Number(options.maxFiles) || MAX_TREE_ENTRIES, MAX_TREE_ENTRIES);
  const maxDepth = Math.min(Number(options.maxDepth) || MAX_TREE_DEPTH, 5);
  const compiled = options.compiled || DEFAULT_COMPILED;
  const lines = [];

  function walk(dir, depth, relBase) {
    if (depth > maxDepth || lines.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const indent = '  '.repeat(Math.max(0, depth - 1));
    for (const e of entries) {
      if (lines.length >= maxFiles) break;
      if (e.isSymbolicLink()) continue;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (isExcludedPath(rel, { compiled })) continue;
      // In non full-workspace modes, skip other hidden entries at root.
      if (e.name.startsWith('.') && depth === 1 && options.policy !== 'full-workspace') continue;
      if (e.isDirectory()) {
        lines.push(`${indent}${e.name}/`);
        walk(path.join(dir, e.name), depth + 1, rel);
      } else {
        lines.push(`${indent}${e.name}`);
      }
    }
  }

  if (workspaceRoot && fs.existsSync(workspaceRoot)) {
    walk(path.resolve(workspaceRoot), 1, '');
  }
  let text = lines.join('\n');
  if (text.length > MAX_TREE_CHARS) text = text.slice(0, MAX_TREE_CHARS - 1) + '…';
  return text;
}

function relevantEvents(events, max = MAX_EVENTS) {
  const list = Array.isArray(events) ? events : [];
  const out = [];
  // Prefer recent non-user-message terminal/progress events.
  for (let i = list.length - 1; i >= 0 && out.length < max; i--) {
    const e = list[i];
    if (!e || typeof e !== 'object') continue;
    const type = String(e.type || '');
    if (
      ![
        'status',
        'error',
        'failed-step',
        'rate_limit',
        'pending-integration',
        'cancelled-worktree',
        'integration-failed',
        'plan',
        'task-project',
        'usage',
        'file_change',
        'command',
      ].includes(type)
    ) {
      continue;
    }
    const summary = capText(redactSecrets(e.text || type), MAX_EVENT_SUMMARY);
    if (!summary) continue;
    const entry = {
      type,
      summary,
      actor: e.actor ? String(e.actor).slice(0, 40) : undefined,
    };
    if (e.meta && e.meta.failed) entry.outcome = 'failure';
    else if (e.meta && e.meta.done) entry.outcome = e.meta.paused ? 'paused' : 'done';
    if (type === 'file_change' && e.meta && e.meta.file) {
      const rel = e.meta.file;
      // Only keep if it looks workspace-relative after sanitization attempt.
      entry.path = String(rel).slice(0, MAX_PATH_LEN);
    }
    out.push(entry);
  }
  return out.reverse();
}

function collectChangedPaths(changes, selectedPaths, events, options = {}) {
  const collected = [];
  if (Array.isArray(selectedPaths)) collected.push(...selectedPaths);
  if (changes && Array.isArray(changes.files)) {
    for (const f of changes.files) collected.push(f);
  }
  // Explicitly mentioned file_change events that are already workspace-relative.
  if (Array.isArray(events)) {
    for (const e of events) {
      if (e && e.type === 'file_change' && e.meta && e.meta.file) {
        collected.push({ path: e.meta.file, change: 'event' });
      }
    }
  }
  return filterPaths(collected, options);
}

/**
 * Build the policy-enforced context block prepended to run prompts.
 * Never scans arbitrary full file contents into the prompt.
 */
function buildPolicyContext({
  policy: rawPolicy,
  objective,
  workspaceRoot,
  events,
  changes,
  selectedPaths,
  extraExclusions,
  mode,
} = {}) {
  const policy = normalizePolicy(rawPolicy);
  const compiled = compilePatterns(extraExclusions);
  const safeObjective = capText(redactSecrets(objective || ''), MAX_OBJECTIVE);
  const paths = collectChangedPaths(changes, selectedPaths, events, { compiled });
  const eventsBlock = relevantEvents(events);
  const sections = [];

  sections.push(`Context policy: ${policy} (v${POLICY_VERSION})`);
  sections.push(LOCAL_CONTROL_NOTICE);
  if (policy === 'full-workspace') sections.push(FULL_WORKSPACE_WARNING);
  if (mode) sections.push(`Run mode: ${String(mode).slice(0, 24)}`);

  if (safeObjective) {
    sections.push(`Task / objective:\n${safeObjective}`);
  }

  if (eventsBlock.length) {
    const lines = eventsBlock.map((e) => {
      const bits = [`- [${e.type}]`, e.summary];
      if (e.outcome) bits.push(`(${e.outcome})`);
      return bits.join(' ');
    });
    sections.push(`Relevant recent events (bounded):\n${lines.join('\n')}`);
  }

  if (policy === 'metadata-only' || policy === 'full-workspace') {
    const tree = buildBoundedTree(workspaceRoot, { policy, compiled });
    if (tree) {
      sections.push(
        policy === 'metadata-only'
          ? `Workspace metadata tree (names only; no file contents):\n${tree}`
          : `Workspace listing (sensitive/ignored paths excluded):\n${tree}`
      );
    }
  }

  if (paths.length) {
    if (policy === 'relevant-only') {
      const lines = paths.map((p) => {
        const st = p.status || p.change || '';
        return st ? `- ${p.path} (${st})` : `- ${p.path}`;
      });
      sections.push(
        `Explicitly selected or changed workspace-relative paths (no file contents scanned):\n${lines.join('\n')}`
      );
    } else if (policy === 'metadata-only') {
      const lines = paths.map((p) => `- ${p.path}${p.status ? ' [' + p.status + ']' : ''}`);
      sections.push(`Changed path names (metadata only):\n${lines.join('\n')}`);
    } else {
      // full-workspace: still only list paths here; CLI may read contents itself
      const lines = paths.map((p) => `- ${p.path}${p.status ? ' [' + p.status + ']' : ''}`);
      sections.push(`Changed paths (contents not inlined by Crew Forge):\n${lines.join('\n')}`);
    }
  } else if (policy === 'relevant-only') {
    sections.push(
      'No explicitly selected or changed workspace paths were attached. Do not scan the full workspace; work from the objective and events above.'
    );
  }

  if (policy === 'metadata-only') {
    sections.push(
      'Metadata-only policy: do not request or rely on full workspace file contents from Crew Forge context. Names, types, and task evidence only.'
    );
  }

  return {
    policy,
    text: sections.join('\n\n'),
    paths,
    events: eventsBlock,
    warnings: policy === 'full-workspace' ? [FULL_WORKSPACE_WARNING] : [],
    notice: LOCAL_CONTROL_NOTICE,
  };
}

/**
 * Filter a unified git diff to drop excluded path hunks (server-side).
 */
function filterDiffByPolicy(diffText, policy, options = {}) {
  const text = String(diffText || '');
  if (!text) return '';
  const pol = normalizePolicy(policy);
  // For metadata-only: never return file contents — path list only.
  if (pol === 'metadata-only') {
    const files = [];
    const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
    let m;
    while ((m = re.exec(text))) {
      const p = sanitizeRelPath(m[2] || m[1], options);
      if (p) files.push(p);
    }
    if (!files.length) return '(no non-excluded changed files)';
    return `Changed files (metadata only; contents omitted by context policy):\n${files
      .map((f) => `- ${f}`)
      .join('\n')}`;
  }

  // relevant-only and full-workspace: keep non-excluded hunks only.
  const chunks = text.split(/(?=^diff --git )/m);
  const kept = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!header) {
      // preamble (e.g. stat) — keep truncated
      kept.push(chunk.slice(0, 500));
      continue;
    }
    const rel = sanitizeRelPath(header[2] || header[1], options);
    if (!rel) continue;
    kept.push(chunk);
  }
  return kept.join('').slice(0, pol === 'relevant-only' ? 80_000 : 200_000);
}

function policyPublicView(policy) {
  const p = normalizePolicy(policy);
  return {
    version: POLICY_VERSION,
    policy: p,
    default: DEFAULT_POLICY,
    policies: POLICIES.slice(),
    notice: LOCAL_CONTROL_NOTICE,
    warning: p === 'full-workspace' ? FULL_WORKSPACE_WARNING : '',
    label:
      p === 'relevant-only'
        ? 'Relevant only'
        : p === 'metadata-only'
          ? 'Metadata only'
          : 'Full workspace',
  };
}

module.exports = {
  POLICY_VERSION,
  POLICIES,
  DEFAULT_POLICY,
  DEFAULT_EXCLUSION_PATTERNS,
  LOCAL_CONTROL_NOTICE,
  FULL_WORKSPACE_WARNING,
  normalizePolicy,
  isValidPolicy,
  isExcludedPath,
  sanitizeRelPath,
  filterPaths,
  buildBoundedTree,
  buildPolicyContext,
  filterDiffByPolicy,
  workspaceRelative,
  fileContentHash,
  relevantEvents,
  redactSecrets,
  capText,
  policyPublicView,
  compilePatterns,
};
