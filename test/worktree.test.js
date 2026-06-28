'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { create, list, remove, diff } = require('../lib/worktree');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-test-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@test.com']);
  git(dir, ['config', 'user.name', 'Test']);
  // Need at least one commit so HEAD exists.
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

test('create returns path and branch, worktree dir is usable', () => {
  const repo = makeRepo();
  try {
    const result = create(repo, 'featA');
    assert.ok(result.path, 'should return a path');
    assert.equal(result.branch, 'crewforge/featA');
    assert.ok(fs.existsSync(result.path), 'worktree path should exist on disk');
  } finally {
    cleanup(repo);
  }
});

test('create is idempotent — calling twice does not throw', () => {
  const repo = makeRepo();
  try {
    const r1 = create(repo, 'featA');
    const r2 = create(repo, 'featA');
    assert.equal(r1.path, r2.path);
    assert.equal(r1.branch, r2.branch);
  } finally {
    cleanup(repo);
  }
});

test('create rejects a stale worktree directory that is not a git worktree', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, '.crewforge-worktrees', 'featA'), { recursive: true });
    assert.throws(() => create(repo, 'featA'), /Worktree path exists but is not a git worktree/);
  } finally {
    cleanup(repo);
  }
});

test('list includes the created worktree', () => {
  const repo = makeRepo();
  try {
    create(repo, 'featA');
    const entries = list(repo);
    const found = entries.find((e) => e.branch === 'crewforge/featA');
    assert.ok(found, 'list() should contain the featA worktree');
    assert.ok(found.path.includes('featA'), 'path should contain the name');
  } finally {
    cleanup(repo);
  }
});

test('diff reflects a new untracked/modified file inside the worktree', () => {
  const repo = makeRepo();
  try {
    const { path: wtPath } = create(repo, 'featA');

    // Write and stage a file so `git diff HEAD` (or `git diff`) picks it up.
    const newFile = path.join(wtPath, 'agent-output.txt');
    fs.writeFileSync(newFile, 'hello from agent');
    git(wtPath, ['add', 'agent-output.txt']);

    const output = diff(repo, 'featA');
    assert.ok(
      output.includes('agent-output.txt'),
      `diff output should mention agent-output.txt, got: ${output}`
    );
  } finally {
    cleanup(repo);
  }
});

test('remove deletes the worktree and branch', () => {
  const repo = makeRepo();
  try {
    const { path: wtPath } = create(repo, 'featA');
    assert.ok(fs.existsSync(wtPath), 'worktree must exist before remove');

    remove(repo, 'featA');

    assert.ok(!fs.existsSync(wtPath), 'worktree path should be gone after remove');
    const entries = list(repo);
    assert.ok(
      !entries.find((e) => e.branch === 'crewforge/featA'),
      'list() should not contain featA after remove'
    );
  } finally {
    cleanup(repo);
  }
});

test('create throws for non-git directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-nogit-'));
  try {
    assert.throws(() => create(dir, 'x'), /Not a git repository/);
  } finally {
    cleanup(dir);
  }
});

test('name sanitization strips special characters', () => {
  const repo = makeRepo();
  try {
    const result = create(repo, 'feat/hello world!');
    // Should not throw; branch name should be sanitized.
    assert.ok(result.branch.startsWith('crewforge/'), 'branch should start with crewforge/');
    const suffix = result.branch.slice('crewforge/'.length);
    assert.ok(
      !/[ /!]/.test(suffix),
      `branch suffix "${suffix}" should not contain spaces, slashes, or bangs`
    );
  } finally {
    cleanup(repo);
  }
});
