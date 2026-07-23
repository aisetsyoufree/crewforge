'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const contextPolicy = require('../lib/context_policy');

test('normalizePolicy defaults and aliases', () => {
  assert.equal(contextPolicy.normalizePolicy(undefined), 'relevant-only');
  assert.equal(contextPolicy.normalizePolicy('relevant'), 'relevant-only');
  assert.equal(contextPolicy.normalizePolicy('metadata_only'), 'metadata-only');
  assert.equal(contextPolicy.normalizePolicy('full workspace'), 'full-workspace');
  assert.equal(contextPolicy.normalizePolicy('nope'), 'relevant-only');
});

test('exclusions cover secrets, vcs, runtime, patent, worktrees', () => {
  const blocked = [
    '.env',
    '.env.local',
    'secrets/app.key',
    '.ssh/id_rsa',
    '.aws/credentials',
    'node_modules/foo/index.js',
    '.git/config',
    'data/keys.json',
    'runs/log.txt',
    '.crewforge-worktrees/step-1/file.js',
    'worktrees/other/file.js',
    'patent/README.md',
    '/Users/me/.ssh/id_rsa',
    '../outside.txt',
  ];
  for (const p of blocked) {
    assert.equal(contextPolicy.isExcludedPath(p), true, `expected excluded: ${p}`);
  }
  assert.equal(contextPolicy.isExcludedPath('src/app.js'), false);
  assert.equal(contextPolicy.isExcludedPath('README.md'), false);
});

test('filterPaths drops excluded and absolute paths', () => {
  const out = contextPolicy.filterPaths([
    { path: 'src/a.js', status: 'M' },
    { path: '.env' },
    { path: '/etc/passwd' },
    { path: 'node_modules/x' },
    'lib/store.js',
  ]);
  assert.deepEqual(
    out.map((x) => x.path),
    ['src/a.js', 'lib/store.js']
  );
});

test('buildPolicyContext relevant-only does not inline file contents or full tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-policy-'));
  try {
    fs.writeFileSync(path.join(dir, 'secret.env'), 'API_KEY=abc');
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'main.js'), 'export default 1');
    const ctx = contextPolicy.buildPolicyContext({
      policy: 'relevant-only',
      objective: 'Fix the bug in src/main.js',
      workspaceRoot: dir,
      events: [
        { type: 'status', text: 'running', meta: { running: true } },
        { type: 'error', text: 'boom', meta: { failed: true } },
      ],
      changes: { files: [{ path: 'src/main.js', status: 'M' }, { path: '.env' }] },
      mode: 'plan',
    });
    assert.equal(ctx.policy, 'relevant-only');
    assert.match(ctx.text, /Context policy: relevant-only/);
    assert.match(ctx.text, /Local control with provider processing/);
    assert.match(ctx.text, /src\/main\.js/);
    assert.doesNotMatch(ctx.text, /console\.log/);
    assert.doesNotMatch(ctx.text, /API_KEY/);
    assert.doesNotMatch(ctx.text, /secret\.env/);
    assert.ok(!ctx.text.includes('Workspace listing'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metadata-only includes tree names but no contents; full-workspace warns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-policy-meta-'));
  try {
    fs.writeFileSync(path.join(dir, 'visible.js'), 'const secret = "x"');
    fs.writeFileSync(path.join(dir, '.env'), 'K=1');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '1');

    const meta = contextPolicy.buildPolicyContext({
      policy: 'metadata-only',
      objective: 'Review structure',
      workspaceRoot: dir,
    });
    assert.match(meta.text, /metadata-only/);
    assert.match(meta.text, /visible\.js/);
    assert.doesNotMatch(meta.text, /const secret/);
    assert.doesNotMatch(meta.text, /node_modules/);
    assert.doesNotMatch(meta.text, /\.env/);

    const full = contextPolicy.buildPolicyContext({
      policy: 'full-workspace',
      objective: 'Broad context',
      workspaceRoot: dir,
    });
    assert.match(full.text, /Full-workspace context policy/);
    assert.ok(full.warnings.length >= 1);
    assert.doesNotMatch(full.text, /const secret/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('filterDiffByPolicy redacts excluded paths and metadata-only omits contents', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/.env b/.env',
    '--- a/.env',
    '+++ b/.env',
    '@@ -1 +1 @@',
    '-A=1',
    '+A=2',
  ].join('\n');

  const relevant = contextPolicy.filterDiffByPolicy(diff, 'relevant-only');
  assert.match(relevant, /src\/a\.js/);
  assert.match(relevant, /\+new/);
  assert.doesNotMatch(relevant, /\.env/);
  assert.doesNotMatch(relevant, /A=2/);

  const meta = contextPolicy.filterDiffByPolicy(diff, 'metadata-only');
  assert.match(meta, /src\/a\.js/);
  assert.doesNotMatch(meta, /\+new/);
  assert.doesNotMatch(meta, /A=2/);
});

test('policyPublicView exposes accurate local-control notice', () => {
  const view = contextPolicy.policyPublicView('full-workspace');
  assert.equal(view.policy, 'full-workspace');
  assert.match(view.notice, /provider processing/i);
  assert.doesNotMatch(view.notice, /local\/private inference/i);
  assert.ok(view.warning);
});
