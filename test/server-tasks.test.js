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
const projectsDir = path.join(ROOT, 'data', 'projects');
const taskTracker = require('../lib/task_tracker');

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

test('task tracker HTTP APIs enforce session ownership', async (t) => {
  const beforeWorkspaces = readRaw(workspaceFile);
  const beforeProfile = readRaw(profileFile);
  const beforeProjects = fs.existsSync(projectsDir)
    ? fs
        .readdirSync(projectsDir)
        .map((f) => ({ name: f, body: fs.readFileSync(path.join(projectsDir, f)) }))
    : [];

  const port = 48000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['server.js', String(port)], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    proc.kill('SIGTERM');
    restoreRaw(workspaceFile, beforeWorkspaces);
    restoreRaw(profileFile, beforeProfile);
    if (fs.existsSync(projectsDir)) fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    for (const file of beforeProjects) {
      fs.writeFileSync(path.join(projectsDir, file.name), file.body);
    }
  });

  await waitForServer(baseUrl, proc);
  const landing = await fetch(baseUrl);
  const cookie = landing.headers.get('set-cookie') || '';
  const csrf = csrfFromHtml(await landing.text());

  const ws = 'ws-task-http';
  const sid = 'sid-task-http';
  const { project } = taskTracker.createProjectFromPlan({
    ws,
    sid,
    team: {
      id: 'team-http',
      leadIndex: 0,
      members: [{ adapter: 'grok', model: 'fast', role: 'Dev' }],
    },
    prompt: 'HTTP tracker test',
    steps: [{ memberIndex: 0, task: 'Do work' }],
    approvalMode: 'plan',
  });

  const listRes = await fetch(
    `${baseUrl}/api/projects?ws=${encodeURIComponent(ws)}&sid=${encodeURIComponent(sid)}`,
    { headers: { cookie } }
  );
  assert.equal(listRes.status, 400);

  fs.writeFileSync(
    workspaceFile,
    JSON.stringify([{ id: ws, path: os.homedir(), name: 'Task HTTP', addedAt: Date.now() }])
  );

  const listOk = await fetch(
    `${baseUrl}/api/projects?ws=${encodeURIComponent(ws)}&sid=${encodeURIComponent(sid)}`,
    { headers: { cookie } }
  );
  assert.equal(listOk.status, 200);
  const listed = await listOk.json();
  assert.ok(Array.isArray(listed.projects));
  assert.ok(listed.projects.some((row) => row.project.id === project.id));

  const detailRes = await fetch(
    `${baseUrl}/api/projects/detail?ws=${encodeURIComponent(ws)}&sid=${encodeURIComponent(sid)}&projectId=${encodeURIComponent(project.id)}`,
    { headers: { cookie } }
  );
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.project.id, project.id);
  assert.equal(detail.tasks.length, 1);

  const taskId = detail.tasks[0].id;
  const taskRes = await fetch(
    `${baseUrl}/api/tasks/detail?ws=${encodeURIComponent(ws)}&sid=${encodeURIComponent(sid)}&projectId=${encodeURIComponent(project.id)}&taskId=${encodeURIComponent(taskId)}`,
    { headers: { cookie } }
  );
  assert.equal(taskRes.status, 200);
  const taskBody = await taskRes.json();
  assert.equal(taskBody.task.id, taskId);

  const cross = await fetch(
    `${baseUrl}/api/projects/detail?ws=${encodeURIComponent(ws)}&sid=other-session&projectId=${encodeURIComponent(project.id)}`,
    { headers: { cookie } }
  );
  assert.equal(cross.status, 404);

  const badPost = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({}),
  });
  assert.equal(badPost.status, 404);
});
