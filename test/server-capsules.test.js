'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const store = require('../lib/store');
const capsuleLib = require('../lib/continuation_capsule');

const ROOT = path.join(__dirname, '..');
const DATA = require('../lib/data_dir');
const workspaceFile = path.join(DATA, 'workspaces.json');
const profileFile = path.join(DATA, 'profile.json');
const sessionsDir = path.join(DATA, 'sessions');
const capsulesDir = path.join(DATA, 'capsules');
const ledgerDir = path.join(DATA, 'ledger');

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

function snapshotDir(dir) {
  const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-snap-'));
  if (fs.existsSync(dir)) fs.cpSync(dir, snap, { recursive: true });
  return snap;
}

function restoreDir(dir, snapshot) {
  fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(snapshot)) fs.cpSync(snapshot, dir, { recursive: true });
  fs.rmSync(snapshot, { recursive: true, force: true });
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

test('context policy profile persistence and capsule list/resume ownership', async (t) => {
  const beforeWorkspaces = readRaw(workspaceFile);
  const beforeProfile = readRaw(profileFile);
  const beforeSessions = snapshotDir(sessionsDir);
  const beforeCapsules = snapshotDir(capsulesDir);
  const beforeLedger = snapshotDir(ledgerDir);
  const wsDir = fs.mkdtempSync(path.join(os.homedir(), 'crewforge-capsule-api-'));
  fs.writeFileSync(path.join(wsDir, 'app.js'), 'console.log(1)\n');
  restoreRaw(workspaceFile, '[]');
  restoreRaw(
    profileFile,
    JSON.stringify({ version: 1, name: 'Local', settings: {}, updatedAt: 0 })
  );
  fs.rmSync(capsulesDir, { recursive: true, force: true });
  fs.rmSync(ledgerDir, { recursive: true, force: true });

  const port = 49100 + Math.floor(Math.random() * 900);
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['server.js', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      CREW_FORGE_ALLOW_SENSITIVE_PATHS: '0',
      CREW_FORGE_RUN_TIMEOUT_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    proc.kill();
    fs.rmSync(wsDir, { recursive: true, force: true });
    restoreRaw(workspaceFile, beforeWorkspaces);
    restoreRaw(profileFile, beforeProfile);
    restoreDir(sessionsDir, beforeSessions);
    restoreDir(capsulesDir, beforeCapsules);
    restoreDir(ledgerDir, beforeLedger);
  });

  const home = await waitForServer(baseUrl, proc);
  const html = await home.text();
  const csrf = csrfFromHtml(html);
  assert.ok(csrf);
  const cookie = (home.headers.getSetCookie && home.headers.getSetCookie()[0]) || '';
  const cookieHeader = cookie.split(';')[0];

  async function api(pathname, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookieHeader) headers.cookie = cookieHeader;
    if (opts.method && opts.method !== 'GET') headers['X-CSRF-Token'] = csrf;
    const res = await fetch(baseUrl + pathname, { ...opts, headers });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  const policyCatalog = await api('/api/context-policy');
  assert.equal(policyCatalog.status, 200);
  assert.ok(policyCatalog.body.policies.includes('relevant-only'));
  assert.match(policyCatalog.body.notice, /provider processing/i);

  const badPolicy = await api('/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { contextPolicy: 'not-a-policy' } }),
  });
  assert.equal(badPolicy.status, 200);
  assert.equal(badPolicy.body.settings.contextPolicy, undefined);

  const goodPolicy = await api('/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { contextPolicy: 'metadata-only' } }),
  });
  assert.equal(goodPolicy.status, 200);
  assert.equal(goodPolicy.body.settings.contextPolicy, 'metadata-only');

  const reloaded = await api('/api/profile');
  assert.equal(reloaded.body.settings.contextPolicy, 'metadata-only');

  const addWs = await api('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: wsDir }),
  });
  assert.equal(addWs.status, 200);
  const ws =
    addWs.body.id ||
    addWs.body.workspace?.id ||
    store.listWorkspaces().find((w) => w.path === wsDir)?.id;
  assert.ok(ws);

  const sess = await api('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ws }),
  });
  assert.equal(sess.status, 200);
  const sid = sess.body.id;
  assert.ok(sid);

  const capsule = capsuleLib.persistCapsule({
    workspaceId: ws,
    sessionId: sid,
    reason: 'failed',
    objective: 'Continue the incomplete task',
    contextPolicy: 'relevant-only',
    mode: 'plan',
    provider: 'claude',
    model: 'sonnet',
  });

  const list = await api(
    `/api/capsules?ws=${encodeURIComponent(ws)}&sid=${encodeURIComponent(sid)}`
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.capsules.length, 1);
  assert.equal(list.body.capsules[0].id, capsule.id);

  const detail = await api(
    `/api/capsules/detail?ws=${encodeURIComponent(ws)}&sid=${encodeURIComponent(sid)}&id=${encodeURIComponent(capsule.id)}`
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.body.capsule.id, capsule.id);

  // Wrong session ownership
  const wrong = await api(
    `/api/capsules/detail?ws=${encodeURIComponent(ws)}&sid=${encodeURIComponent(sid)}&id=cap-nope`
  );
  assert.equal(wrong.status, 404);

  // Invalid context policy on resume
  const badResume = await api('/api/capsules/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ws,
      sid,
      capsuleId: capsule.id,
      adapter: 'claude',
      model: 'sonnet',
      mode: 'plan',
      contextPolicy: 'teleport-all',
    }),
  });
  assert.equal(badResume.status, 400);

  // Unknown adapter
  const badAdapter = await api('/api/capsules/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ws,
      sid,
      capsuleId: capsule.id,
      adapter: 'not-a-provider',
      mode: 'plan',
      contextPolicy: 'relevant-only',
    }),
  });
  assert.equal(badAdapter.status, 400);

  // Valid resume request is accepted (run may fail later if CLI missing — ok for API shape).
  const resume = await api('/api/capsules/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ws,
      sid,
      capsuleId: capsule.id,
      adapter: 'claude',
      model: 'sonnet',
      mode: 'plan',
      contextPolicy: 'relevant-only',
      contextMode: 'off',
    }),
  });
  assert.equal(resume.status, 200);
  assert.equal(resume.body.ok, true);
  assert.equal(resume.body.resumed, true);
  assert.equal(resume.body.contextPolicy, 'relevant-only');
});
