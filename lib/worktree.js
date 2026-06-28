'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const WORKTREE_DIR = '.mmo-worktrees';

function assertGitRepo(repoPath) {
  const gitDir = path.join(repoPath, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }
}

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function git(repoPath, args, opts = {}) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

/**
 * Create a git worktree at <repoPath>/.mmo-worktrees/<safeName> on branch mmo/<safeName>.
 * Reuses an existing worktree/branch if already present.
 * Returns { path, branch }.
 */
function create(repoPath, name) {
  assertGitRepo(repoPath);

  const safeName = sanitizeName(name);
  const branch = `mmo/${safeName}`;
  const worktreePath = path.join(repoPath, WORKTREE_DIR, safeName);

  // If the worktree directory already exists, return it directly.
  if (fs.existsSync(worktreePath)) {
    return { path: worktreePath, branch };
  }

  fs.mkdirSync(path.join(repoPath, WORKTREE_DIR), { recursive: true });

  // Check whether the branch already exists (local).
  let branchExists = false;
  try {
    git(repoPath, ['rev-parse', '--verify', branch]);
    branchExists = true;
  } catch (_) {
    // branch does not exist yet
  }

  if (branchExists) {
    // Add worktree on the existing branch.
    git(repoPath, ['worktree', 'add', worktreePath, branch]);
  } else {
    // Create branch from HEAD and add worktree.
    git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  }

  return { path: worktreePath, branch };
}

/**
 * List all worktrees that live under .mmo-worktrees and return [{path, branch}].
 */
function list(repoPath) {
  assertGitRepo(repoPath);

  const raw = git(repoPath, ['worktree', 'list', '--porcelain']);
  // Canonicalize: git emits real paths (e.g. /private/tmp), so a plain
  // path.resolve prefix can mismatch through symlinks like /tmp -> /private/tmp.
  let canonRoot;
  try {
    canonRoot = fs.realpathSync(path.resolve(repoPath));
  } catch {
    canonRoot = path.resolve(repoPath);
  }
  const mmoRoot = path.join(canonRoot, WORKTREE_DIR);
  const results = [];

  // Porcelain output is blocks separated by blank lines.
  // Each block has lines like: worktree <path>, HEAD <sha>, branch refs/heads/<name>
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
    if (wtPath && wtPath.startsWith(mmoRoot)) {
      results.push({ path: wtPath, branch: wtBranch });
    }
  }

  return results;
}

/**
 * Remove the worktree and delete the mmo/<safeName> branch.
 */
function remove(repoPath, name) {
  assertGitRepo(repoPath);

  const safeName = sanitizeName(name);
  const branch = `mmo/${safeName}`;
  const worktreePath = path.join(repoPath, WORKTREE_DIR, safeName);

  if (fs.existsSync(worktreePath)) {
    git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
  }

  // Delete the branch; ignore errors if it doesn't exist.
  try {
    git(repoPath, ['branch', '-D', branch]);
  } catch (err) {
    if (!err.stderr || !err.stderr.includes('not found')) {
      // Re-throw unexpected errors but ignore "branch not found".
      // execFileSync puts stderr on the Error object.
      const msg = err.stderr || err.message || '';
      if (!msg.includes('not found') && !msg.includes('error: branch')) {
        throw err;
      }
    }
  }
}

/**
 * Return a unified diff of uncommitted working-tree changes inside the worktree.
 */
function diff(repoPath, name) {
  assertGitRepo(repoPath);

  const safeName = sanitizeName(name);
  const worktreePath = path.join(repoPath, WORKTREE_DIR, safeName);

  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Worktree does not exist: ${worktreePath}`);
  }

  // git diff HEAD shows both staged and unstaged changes vs the branch tip.
  return git(worktreePath, ['diff', 'HEAD'], { cwd: worktreePath });
}

module.exports = { create, list, remove, diff };
