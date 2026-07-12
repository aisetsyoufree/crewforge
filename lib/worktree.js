'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const WORKTREE_DIR = '.crewforge-worktrees';
const BRANCH_PREFIX = 'crewforge';
const WORKTREE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function assertGitRepo(repoPath) {
  const gitDir = path.join(repoPath, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }
}

function sanitizeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function git(repoPath, args, opts = {}) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function gitErrorMessage(err) {
  return String((err && err.stderr) || (err && err.message) || err).trim();
}

function registeredWorktreePaths(repoPath) {
  try {
    const raw = git(repoPath, ['worktree', 'list', '--porcelain']);
    return raw
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => {
        const wtPath = line.slice('worktree '.length).trim();
        try {
          return fs.realpathSync(wtPath);
        } catch {
          return path.resolve(wtPath);
        }
      });
  } catch {
    return [];
  }
}

function crewForgeRoot(repoPath) {
  try {
    return path.join(fs.realpathSync(path.resolve(repoPath)), WORKTREE_DIR);
  } catch {
    return path.join(path.resolve(repoPath), WORKTREE_DIR);
  }
}

/**
 * Resolve a registered Crew Forge worktree id to its canonical path and branch.
 * Rejects traversal, arbitrary paths, and ids that are not git-registered worktrees.
 */
function resolveRegisteredWorktree(repoPath, worktreeId) {
  assertGitRepo(repoPath);
  const id = String(worktreeId || '').trim();
  if (!id || !WORKTREE_ID_RE.test(id) || id !== sanitizeName(id)) {
    throw new Error(`Invalid worktree id: ${worktreeId}`);
  }

  const worktreePath = path.join(repoPath, WORKTREE_DIR, id);
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Worktree does not exist: ${id}`);
  }

  let canonRepo;
  let canonWt;
  try {
    canonRepo = fs.realpathSync(path.resolve(repoPath));
    canonWt = fs.realpathSync(worktreePath);
  } catch {
    throw new Error(`Worktree does not exist: ${id}`);
  }

  const registryRoot = path.join(canonRepo, WORKTREE_DIR);
  const rel = path.relative(registryRoot, canonWt);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('..')) {
    throw new Error(`Worktree path escapes registry: ${id}`);
  }

  const registered = registeredWorktreePaths(repoPath);
  if (!registered.includes(canonWt)) {
    throw new Error(`Worktree is not registered: ${id}`);
  }

  return {
    worktreeId: id,
    path: canonWt,
    branch: `${BRANCH_PREFIX}/${id}`,
  };
}

function includeUntrackedFiles(worktreePath) {
  try {
    git(worktreePath, ['add', '-N', '.'], { cwd: worktreePath });
  } catch (_) {
    // Diff capture still works for modified tracked files if intent-to-add fails.
  }
}

function summarizeDiff(diffText) {
  const text = String(diffText || '');
  const files = new Set();
  let insertions = 0;
  let deletions = 0;
  let hasBinary = false;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\//);
      if (match) files.add(match[1]);
    }
    if (/^Binary files /.test(line) || /^GIT binary patch/.test(line)) hasBinary = true;
    if (line.startsWith('+') && !line.startsWith('+++')) insertions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }

  return {
    fileCount: files.size,
    insertions,
    deletions,
    hasBinary,
    empty: !text.trim(),
  };
}

function captureDiffFromWorktree(worktreePath) {
  includeUntrackedFiles(worktreePath);
  return git(worktreePath, ['diff', '--binary', 'HEAD'], { cwd: worktreePath });
}

function patchForWorktree(repoPath, worktreeId) {
  const { path: worktreePath } = resolveRegisteredWorktree(repoPath, worktreeId);
  return captureDiffFromWorktree(worktreePath);
}

/**
 * Create a git worktree at <repoPath>/.crewforge-worktrees/<safeName>
 * on branch crewforge/<safeName>.
 * Reuses an existing worktree/branch if already present.
 * Returns { path, branch, worktreeId }.
 */
function create(repoPath, name) {
  assertGitRepo(repoPath);

  const safeName = sanitizeName(name);
  const branch = `${BRANCH_PREFIX}/${safeName}`;
  const worktreePath = path.join(repoPath, WORKTREE_DIR, safeName);

  if (fs.existsSync(worktreePath)) {
    const registered = registeredWorktreePaths(repoPath);
    const resolved = fs.realpathSync(worktreePath);
    if (!registered.includes(resolved)) {
      throw new Error(`Worktree path exists but is not a git worktree: ${worktreePath}`);
    }
    return { path: worktreePath, branch, worktreeId: safeName };
  }

  fs.mkdirSync(path.join(repoPath, WORKTREE_DIR), { recursive: true });

  let branchExists = false;
  try {
    git(repoPath, ['rev-parse', '--verify', branch]);
    branchExists = true;
  } catch (_) {
    // branch does not exist yet
  }

  if (branchExists) {
    git(repoPath, ['worktree', 'add', worktreePath, branch]);
  } else {
    git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  }

  return { path: worktreePath, branch, worktreeId: safeName };
}

/**
 * Create a new unique worktree (never reuses an existing id).
 */
function createUnique(repoPath, hint = 'step') {
  const prefix = sanitizeName(hint) || 'step';
  for (let attempt = 0; attempt < 50; attempt++) {
    const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}_${attempt}`;
    const name = `${prefix}_${token}`;
    const candidatePath = path.join(repoPath, WORKTREE_DIR, sanitizeName(name));
    if (fs.existsSync(candidatePath)) continue;
    return create(repoPath, name);
  }
  throw new Error('unable to allocate a unique worktree id');
}

/**
 * List all worktrees that live under .crewforge-worktrees and return [{path, branch}].
 */
function list(repoPath) {
  assertGitRepo(repoPath);

  const raw = git(repoPath, ['worktree', 'list', '--porcelain']);
  const crewForgeRootPath = crewForgeRoot(repoPath);
  const results = [];

  const blocks = raw.trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n');
    let wtPath = null;
    let wtBranch = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim();
      if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        wtBranch = ref.replace(/^refs\/heads\//, '');
      }
    }
    if (!wtPath) continue;
    let canonWt = wtPath;
    try {
      canonWt = fs.realpathSync(wtPath);
    } catch {
      canonWt = path.resolve(wtPath);
    }
    const rel = path.relative(crewForgeRootPath, canonWt);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes('..')) {
      results.push({ path: wtPath, branch: wtBranch });
    }
  }

  return results;
}

/**
 * Remove the worktree and delete the crewforge/<safeName> branch.
 */
function remove(repoPath, name) {
  const { worktreeId, path: worktreePath, branch } = resolveRegisteredWorktree(repoPath, name);

  if (fs.existsSync(worktreePath)) {
    git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
  }

  try {
    git(repoPath, ['branch', '-D', branch]);
  } catch (err) {
    const msg = gitErrorMessage(err);
    if (!msg.includes('not found') && !msg.includes('error: branch')) {
      throw err;
    }
  }

  return { removed: true, worktreeId };
}

/**
 * Return a unified diff of working-tree changes inside a registered worktree.
 */
function diff(repoPath, name) {
  const { path: worktreePath } = resolveRegisteredWorktree(repoPath, name);
  return captureDiffFromWorktree(worktreePath);
}

function inspect(repoPath, worktreeId) {
  const { worktreeId: id, branch } = resolveRegisteredWorktree(repoPath, worktreeId);
  const patch = patchForWorktree(repoPath, id);
  return {
    worktreeId: id,
    branch,
    diff: patch,
    diffSummary: summarizeDiff(patch),
  };
}

function preflightApply(repoPath, worktreeId) {
  resolveRegisteredWorktree(repoPath, worktreeId);
  const patch = patchForWorktree(repoPath, worktreeId);
  if (!patch.trim()) {
    return { ok: true, empty: true };
  }
  try {
    git(repoPath, ['apply', '--check'], { cwd: repoPath, input: patch });
    return { ok: true, empty: false };
  } catch (err) {
    return { ok: false, error: gitErrorMessage(err) };
  }
}

function apply(repoPath, worktreeId) {
  const preflight = preflightApply(repoPath, worktreeId);
  if (!preflight.ok) {
    const message = preflight.error || 'git apply --check failed';
    const err = new Error(message);
    err.code = 'WORKTREE_APPLY_FAILED';
    throw err;
  }

  const patch = patchForWorktree(repoPath, worktreeId);
  if (!preflight.empty && patch.trim()) {
    try {
      git(repoPath, ['apply'], { cwd: repoPath, input: patch });
    } catch (err) {
      const message = gitErrorMessage(err);
      const applyErr = new Error(message);
      applyErr.code = 'WORKTREE_APPLY_FAILED';
      throw applyErr;
    }
  }

  remove(repoPath, worktreeId);
  return { integrated: true, worktreeId };
}

function reject(repoPath, worktreeId) {
  remove(repoPath, worktreeId);
  return { rejected: true, worktreeId };
}

module.exports = {
  WORKTREE_DIR,
  create,
  createUnique,
  list,
  remove,
  diff,
  inspect,
  preflightApply,
  apply,
  reject,
  summarizeDiff,
  resolveRegisteredWorktree,
};
