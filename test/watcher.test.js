const assert = require('node:assert');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { getChanges } = require('../lib/watcher');

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
  });
}

test('getChanges lists staged files', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'watcher-'));
  const fileName = 'example.txt';

  git(repoPath, ['init']);
  writeFileSync(join(repoPath, fileName), 'hello\n');
  git(repoPath, ['add', fileName]);

  const changes = getChanges(repoPath);

  assert.ok(
    changes.files.some((file) => file.path === fileName && file.status === 'A '),
    'expected staged file to appear in git status output'
  );
  assert.strictEqual(typeof changes.stat, 'string');
});
