'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const workspaceFile = path.join(ROOT, 'data', 'workspaces.json');
const profileFile = path.join(ROOT, 'data', 'profile.json');
const sessionsDir = path.join(ROOT, 'data', 'sessions');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-server-sessions-snapshot-'));
  if (fs.existsSync(sessionsDir)) fs.cpSync(sessionsDir, dir, { recursive: true });
  return dir;
}

function restoreSessions(snapshot) {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  if (fs.existsSync(snapshot)) fs.cpSync(snapshot, sessionsDir, { recursive: true });
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

test('HTTP CSRF gate and dev command rejection are enforced', async (t) => {
  const beforeWorkspaces = readRaw(workspaceFile);
  const beforeProfile = readRaw(profileFile);
  const beforeSessions = snapshotSessions();
  const wsDir = fs.mkdtempSync(path.join(os.homedir(), 'crewforge-server-test-'));
  const outsideDir = fs.mkdtempSync(path.join(os.homedir(), 'crewforge-server-outside-'));
  restoreRaw(workspaceFile, '[]');
  restoreRaw(
    profileFile,
    JSON.stringify({ version: 1, name: 'Local', settings: {}, updatedAt: 0 })
  );
  const port = 48000 + Math.floor(Math.random() * 1000);
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
    fs.rmSync(outsideDir, { recursive: true, force: true });
    restoreRaw(workspaceFile, beforeWorkspaces);
    restoreRaw(profileFile, beforeProfile);
    restoreSessions(beforeSessions);
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

  const previewFile = path.join(wsDir, 'notes.md');
  fs.writeFileSync(previewFile, '# Notes\n\nhello\n');
  const filePreview = await fetch(
    `${baseUrl}/api/file?ws=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(previewFile)}`,
    { headers: { cookie } }
  );
  assert.equal(filePreview.status, 200);
  const filePreviewBody = await filePreview.json();
  assert.equal(filePreviewBody.relativePath, 'notes.md');
  assert.match(filePreviewBody.content, /hello/);

  const outsidePreview = await fetch(
    `${baseUrl}/api/file?ws=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(path.join(os.tmpdir(), 'outside.md'))}`,
    { headers: { cookie } }
  );
  assert.equal(outsidePreview.status, 400);
  const outsidePreviewBody = await outsidePreview.json();
  assert.match(outsidePreviewBody.error, /outside workspace/i);

  const symlinkTarget = path.join(outsideDir, 'outside-via-link.md');
  const symlinkPath = path.join(wsDir, 'linked.md');
  fs.writeFileSync(symlinkTarget, 'must not be readable through workspace link\n');
  fs.symlinkSync(symlinkTarget, symlinkPath);
  const symlinkPreview = await fetch(
    `${baseUrl}/api/file?ws=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(symlinkPath)}`,
    { headers: { cookie } }
  );
  assert.equal(symlinkPreview.status, 400);
  const symlinkPreviewBody = await symlinkPreview.json();
  assert.match(symlinkPreviewBody.error, /outside workspace/i);

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

  const saveTeam = await fetch(`${baseUrl}/api/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({
      team: {
        id: 'git-gate-team',
        name: 'Git gate team',
        members: [{ adapter: 'claude', model: 'sonnet', role: 'Engineer' }],
        leadIndex: 0,
      },
    }),
  });
  assert.equal(saveTeam.status, 200);
  const editApprove = await fetch(`${baseUrl}/api/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({
      ws: workspace.id,
      sid: 'team-git-gate',
      teamId: 'git-gate-team',
      steps: [{ memberIndex: 0, task: 'edit something' }],
    }),
  });
  assert.equal(editApprove.status, 400);
  const editApproveBody = await editApprove.json();
  assert.match(editApproveBody.error, /requires a git workspace/i);

  const saveProfile = await fetch(`${baseUrl}/api/profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({
      settings: {
        selectedWorkspaceId: workspace.id,
        selectedSessionId: 'session-one',
        contextMode: 'maximum',
      },
    }),
  });
  assert.equal(saveProfile.status, 200);
  const savedProfile = await saveProfile.json();
  assert.equal(savedProfile.settings.selectedWorkspaceId, workspace.id);
  assert.equal(savedProfile.settings.contextMode, 'maximum');

  const exported = await fetch(`${baseUrl}/api/profile/export`, {
    headers: { cookie },
  });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition') || '', /crewforge-profile/);
  const exportedBody = await exported.json();
  assert.equal(exportedBody.type, 'crewforge-profile');
  assert.equal(exportedBody.profile.settings.selectedWorkspaceId, workspace.id);

  const orphanDir = path.join(sessionsDir, 'orphan-http');
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(orphanDir, 'stale.jsonl'), '{"text":"stale"}\n');
  const importProfile = await fetch(`${baseUrl}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({
      profile: {
        ...exportedBody,
        workspaces: [
          ...exportedBody.workspaces,
          { id: 'unsafe', path: '/tmp/crewforge-unsafe', name: 'Unsafe', addedAt: Date.now() },
        ],
      },
    }),
  });
  assert.equal(importProfile.status, 200);
  const importBody = await importProfile.json();
  assert.equal(importBody.workspaces, 1);
  assert.equal(fs.existsSync(path.join(orphanDir, 'stale.jsonl')), false);

  const importedWorkspaces = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie } });
  const importedWorkspaceBody = await importedWorkspaces.json();
  assert.deepEqual(
    importedWorkspaceBody.map((w) => w.id),
    [workspace.id]
  );
});
