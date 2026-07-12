'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const workspaceFile = path.join(ROOT, 'data', 'workspaces.json');
const profileFile = path.join(ROOT, 'data', 'profile.json');
const sessionsDir = path.join(ROOT, 'data', 'sessions');
const { create, resolveRegisteredWorktree } = require('../lib/worktree');
const store = require('../lib/store');

function recordPending(ws, sid, worktreeId, continuation) {
  store.append(ws, sid, {
    kind: 'system',
    actor: 'codex',
    type: 'pending-integration',
    text: 'Pending test worktree',
    meta: {
      worktreeId,
      continuation: continuation || {
        version: 1,
        team: { id: 'test-team', members: [{ adapter: 'codex', model: 'test' }] },
        approvalMode: 'edit',
        remainingSteps: [],
        nextStepOffset: 1,
        totalSteps: 1,
      },
    },
  });
}

function readRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function restoreRaw(file, raw) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (raw === null) {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
    }
    return;
  }
  fs.writeFileSync(file, raw);
}

function snapshotSessions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-wt-sessions-'));
  if (fs.existsSync(sessionsDir)) fs.cpSync(sessionsDir, dir, { recursive: true });
  return dir;
}

function restoreSessions(snapshot) {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  if (fs.existsSync(snapshot)) fs.cpSync(snapshot, sessionsDir, { recursive: true });
  fs.rmSync(snapshot, { recursive: true, force: true });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'crewforge-wt-http-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@test.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function waitForServer(baseUrl, proc) {
  const deadline = Date.now() + 10000;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (proc.exitCode !== null) return reject(new Error(`server exited with ${proc.exitCode}`));
      try {
        const res = await fetch(baseUrl);
        if (res.status === 200) return resolve(res);
      } catch {}
      if (Date.now() > deadline) return reject(new Error('server did not start'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function csrfFromHtml(html) {
  const match = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  return match ? match[1] : '';
}

async function postJson(baseUrl, cookie, csrf, route, body) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify(body),
  });
}

function sessionEvents(ws, sid) {
  const file = path.join(sessionsDir, ws, `${sid}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('worktree pending, integrate, reject, and validation HTTP APIs', async (t) => {
  const beforeWorkspaces = readRaw(workspaceFile);
  const beforeProfile = readRaw(profileFile);
  const beforeSessions = snapshotSessions();
  const repo = makeRepo();
  const port = 49000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['server.js', String(port)], {
    cwd: ROOT,
    env: { ...process.env, CREW_FORGE_ALLOW_SENSITIVE_PATHS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    proc.kill();
    fs.rmSync(repo, { recursive: true, force: true });
    restoreRaw(workspaceFile, beforeWorkspaces);
    restoreRaw(profileFile, beforeProfile);
    restoreSessions(beforeSessions);
  });

  const page = await waitForServer(baseUrl, proc);
  const cookie = page.headers.get('set-cookie');
  const csrf = csrfFromHtml(await page.text());

  const addWorkspace = await postJson(baseUrl, cookie, csrf, '/api/workspaces', { path: repo });
  assert.equal(addWorkspace.status, 200);
  const workspace = await addWorkspace.json();

  const sessionRes = await postJson(baseUrl, cookie, csrf, '/api/sessions', { ws: workspace.id });
  const session = await sessionRes.json();
  const sid = session.id;

  const badId = await fetch(
    `${baseUrl}/api/worktree/pending?ws=${encodeURIComponent(workspace.id)}&worktreeId=../escape`,
    { headers: { cookie } }
  );
  assert.equal(badId.status, 400);

  const { worktreeId, path: wtPath } = create(repo, 'httpPending');
  fs.writeFileSync(path.join(wtPath, 'from-wt.txt'), 'hello from worktree');
  git(wtPath, ['add', 'from-wt.txt']);
  recordPending(workspace.id, sid, worktreeId);

  const otherSessionRes = await postJson(baseUrl, cookie, csrf, '/api/sessions', {
    ws: workspace.id,
  });
  const otherSid = (await otherSessionRes.json()).id;
  const crossSessionIntegrate = await postJson(baseUrl, cookie, csrf, '/api/worktree/integrate', {
    ws: workspace.id,
    sid: otherSid,
    worktreeId,
  });
  assert.equal(crossSessionIntegrate.status, 409);
  assert.equal((await crossSessionIntegrate.json()).status, 'not-pending');
  assert.ok(resolveRegisteredWorktree(repo, worktreeId));

  const pending = await fetch(
    `${baseUrl}/api/worktree/pending?ws=${encodeURIComponent(workspace.id)}&worktreeId=${encodeURIComponent(worktreeId)}`,
    { headers: { cookie } }
  );
  assert.equal(pending.status, 200);
  const pendingBody = await pending.json();
  assert.equal(pendingBody.worktreeId, worktreeId);
  assert.ok(pendingBody.diff.includes('from-wt.txt'));
  assert.ok(pendingBody.diffSummary.fileCount >= 1);

  const integrate = await postJson(baseUrl, cookie, csrf, '/api/worktree/integrate', {
    ws: workspace.id,
    sid,
    worktreeId,
  });
  assert.equal(integrate.status, 200);
  const integrateBody = await integrate.json();
  assert.equal(integrateBody.status, 'integrated');
  assert.ok(fs.existsSync(path.join(repo, 'from-wt.txt')));
  assert.throws(() => resolveRegisteredWorktree(repo, worktreeId));

  const eventsAfterIntegrate = sessionEvents(workspace.id, sid);
  assert.ok(eventsAfterIntegrate.some((e) => e.type === 'integrated'));

  const { worktreeId: rejectId, path: rejectPath } = create(repo, 'httpReject');
  fs.writeFileSync(path.join(rejectPath, 'nope.txt'), 'discard');
  git(rejectPath, ['add', 'nope.txt']);
  recordPending(workspace.id, sid, rejectId);
  const reject = await postJson(baseUrl, cookie, csrf, '/api/worktree/reject', {
    ws: workspace.id,
    sid,
    worktreeId: rejectId,
  });
  assert.equal(reject.status, 200);
  assert.equal((await reject.json()).status, 'rejected');
  assert.ok(!fs.existsSync(path.join(repo, 'nope.txt')));
  assert.throws(() => resolveRegisteredWorktree(repo, rejectId));
  assert.ok(sessionEvents(workspace.id, sid).some((e) => e.type === 'rejected'));
});

test('failed integration retains worktree and records integration-failed event', async (t) => {
  const beforeWorkspaces = readRaw(workspaceFile);
  const beforeProfile = readRaw(profileFile);
  const beforeSessions = snapshotSessions();
  const repo = makeRepo();
  const port = 49100 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['server.js', String(port)], {
    cwd: ROOT,
    env: { ...process.env, CREW_FORGE_ALLOW_SENSITIVE_PATHS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    proc.kill();
    fs.rmSync(repo, { recursive: true, force: true });
    restoreRaw(workspaceFile, beforeWorkspaces);
    restoreRaw(profileFile, beforeProfile);
    restoreSessions(beforeSessions);
  });

  const page = await waitForServer(baseUrl, proc);
  const cookie = page.headers.get('set-cookie');
  const csrf = csrfFromHtml(await page.text());

  const addWorkspace = await postJson(baseUrl, cookie, csrf, '/api/workspaces', { path: repo });
  const workspace = await addWorkspace.json();
  const sessionRes = await postJson(baseUrl, cookie, csrf, '/api/sessions', { ws: workspace.id });
  const sid = (await sessionRes.json()).id;

  fs.writeFileSync(path.join(repo, 'conflict.txt'), 'main\n');
  git(repo, ['add', 'conflict.txt']);
  git(repo, ['commit', '-m', 'main']);

  const { worktreeId, path: wtPath } = create(repo, 'httpConflict');
  fs.writeFileSync(path.join(wtPath, 'conflict.txt'), 'worktree\n');
  git(wtPath, ['add', 'conflict.txt']);

  fs.writeFileSync(path.join(repo, 'conflict.txt'), 'main changed after branch\n');
  git(repo, ['add', 'conflict.txt']);
  git(repo, ['commit', '-m', 'diverge main']);
  recordPending(workspace.id, sid, worktreeId);

  const integrate = await postJson(baseUrl, cookie, csrf, '/api/worktree/integrate', {
    ws: workspace.id,
    sid,
    worktreeId,
  });
  assert.equal(integrate.status, 409);
  const body = await integrate.json();
  assert.equal(body.status, 'integration-failed');
  assert.equal(body.error, 'Integration failed');
  assert.ok(resolveRegisteredWorktree(repo, worktreeId));
  assert.equal(
    fs.readFileSync(path.join(repo, 'conflict.txt'), 'utf8'),
    'main changed after branch\n'
  );

  const failedEvent = sessionEvents(workspace.id, sid).find((e) => e.type === 'integration-failed');
  assert.ok(failedEvent);
  assert.equal(failedEvent.meta.worktreeId, worktreeId);
});
