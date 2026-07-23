'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ROOT = path.join(__dirname, '..');
const DATA = require('../lib/data_dir');
const workspaceFile = path.join(DATA, 'workspaces.json');
const profileFile = path.join(DATA, 'profile.json');
const sessionsDir = path.join(DATA, 'sessions');
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

test('ledger list/export APIs respect session cookies and workspace scope', async (t) => {
  const beforeWorkspaces = readRaw(workspaceFile);
  const beforeProfile = readRaw(profileFile);
  const beforeSessions = snapshotDir(sessionsDir);
  const beforeLedger = snapshotDir(ledgerDir);
  const wsDir = fs.mkdtempSync(path.join(os.homedir(), 'crewforge-ledger-api-'));
  restoreRaw(workspaceFile, '[]');
  restoreRaw(
    profileFile,
    JSON.stringify({ version: 1, name: 'Local', settings: {}, updatedAt: 0 })
  );
  fs.rmSync(ledgerDir, { recursive: true, force: true });

  const port = 49000 + Math.floor(Math.random() * 1000);
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
    restoreDir(ledgerDir, beforeLedger);
  });

  const home = await waitForServer(baseUrl, proc);
  const html = await home.text();
  const csrf = csrfFromHtml(html);
  const cookie = home.headers.getSetCookie
    ? home.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ')
    : String(home.headers.get('set-cookie') || '')
        .split(',')
        .map((c) => c.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');

  // No cookie => unauthorized
  const denied = await fetch(`${baseUrl}/api/ledger`);
  assert.equal(denied.status, 401);

  const addWs = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify({ path: wsDir }),
  });
  assert.equal(addWs.status, 200);
  const wsObj = await addWs.json();

  const createSid = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify({ ws: wsObj.id }),
  });
  assert.equal(createSid.status, 200);
  const sidBody = await createSid.json();
  const sid = sidBody.id || sidBody.sid;
  assert.ok(sid);

  // Seed a ledger entry through stop (always available)
  const stop = await fetch(`${baseUrl}/api/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify({ ws: wsObj.id, sid }),
  });
  assert.equal(stop.status, 200);

  const list = await fetch(
    `${baseUrl}/api/ledger?ws=${encodeURIComponent(wsObj.id)}&sid=${encodeURIComponent(sid)}`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.ok(Array.isArray(listed.entries));
  assert.ok(listed.entries.some((e) => e.transition === 'run_stopped'));

  const unknownWs = await fetch(`${baseUrl}/api/ledger?ws=not-a-real-ws`, {
    headers: { Cookie: cookie },
  });
  assert.equal(unknownWs.status, 404);

  const csvRes = await fetch(
    `${baseUrl}/api/ledger/export?ws=${encodeURIComponent(wsObj.id)}&format=csv`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type') || '', /text\/csv/);
  const csv = await csvRes.text();
  assert.match(csv, /transition/);
  assert.match(csv, /run_stopped/);

  const jsonRes = await fetch(
    `${baseUrl}/api/ledger/export?ws=${encodeURIComponent(wsObj.id)}&format=json`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(jsonRes.status, 200);
  const payload = await jsonRes.json();
  assert.equal(payload.version, 1);
  assert.ok(payload.entries.length >= 1);

  // Health shape includes status fields
  const health = await fetch(`${baseUrl}/api/health`, { headers: { Cookie: cookie } });
  assert.equal(health.status, 200);
  const rows = await health.json();
  assert.ok(Array.isArray(rows));
  for (const row of rows) {
    assert.ok(row.id);
    assert.equal(typeof row.ready, 'boolean');
    assert.ok(row.status);
    assert.ok(row.statusLabel);
    assert.ok('version' in row);
    assert.ok('hint' in row);
  }
});
