'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const workspaceFile = path.join(ROOT, 'data', 'workspaces.json');

function readWorkspacesRaw() {
  try {
    return fs.readFileSync(workspaceFile, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function restoreWorkspaces(raw) {
  fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
  if (raw === null) {
    try {
      fs.unlinkSync(workspaceFile);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
    }
    return;
  }
  fs.writeFileSync(workspaceFile, raw);
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

test('HTTP CSRF gate and dev command rejection are enforced', async (t) => {
  const before = readWorkspacesRaw();
  const wsDir = fs.mkdtempSync(path.join(os.homedir(), 'crewforge-server-test-'));
  const port = 48000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['server.js', String(port)], {
    cwd: ROOT,
    env: { ...process.env, CREW_FORGE_RUN_TIMEOUT_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    proc.kill();
    fs.rmSync(wsDir, { recursive: true, force: true });
    restoreWorkspaces(before);
  });

  const page = await waitForServer(baseUrl, proc);
  const html = await page.text();
  const csrf = csrfFromHtml(html);
  const cookie = page.headers.get('set-cookie');

  assert.ok(csrf, 'page should include a CSRF token');
  assert.ok(cookie && cookie.includes('crewforge_session='), 'page should set app session cookie');

  const noToken = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ path: wsDir }),
  });
  assert.equal(noToken.status, 403);

  const addWorkspace = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ path: wsDir }),
  });
  assert.equal(addWorkspace.status, 200);
  const workspace = await addWorkspace.json();
  assert.ok(workspace.id);

  const injected = await fetch(`${baseUrl}/api/dev/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ ws: workspace.id, cmd: 'npm start && whoami' }),
  });
  assert.equal(injected.status, 400);
  const body = await injected.json();
  assert.match(body.error, /shell operators/i);

  const escapingPath = await fetch(`${baseUrl}/api/dev/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ ws: workspace.id, cmd: 'cat ../../.ssh/id_rsa' }),
  });
  assert.equal(escapingPath.status, 400);
  const escapingPathBody = await escapingPath.json();
  assert.match(escapingPathBody.error, /absolute paths or parent directories/i);

  const unsupportedEffort = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({
      ws: workspace.id,
      sid: 'effort-test',
      adapter: 'claude',
      model: 'sonnet',
      effort: 'max',
      mode: 'plan',
      prompt: 'say ok',
    }),
  });
  assert.equal(unsupportedEffort.status, 400);
  const unsupportedEffortBody = await unsupportedEffort.json();
  assert.match(unsupportedEffortBody.error, /unsupported effort/i);
});
