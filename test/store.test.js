'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const store = require('../lib/store');

const dataDir = path.join(__dirname, '..', 'data');
const workspaceFile = path.join(__dirname, '..', 'data', 'workspaces.json');
const profileFile = path.join(dataDir, 'profile.json');
const teamsFile = path.join(dataDir, 'teams.json');
const customSkillsFile = path.join(dataDir, 'custom-skills.json');
const sessionsDir = path.join(dataDir, 'sessions');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-sessions-snapshot-'));
  if (fs.existsSync(sessionsDir)) fs.cpSync(sessionsDir, dir, { recursive: true });
  return dir;
}

function restoreSessions(snapshot) {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  if (fs.existsSync(snapshot)) fs.cpSync(snapshot, sessionsDir, { recursive: true });
  fs.rmSync(snapshot, { recursive: true, force: true });
}

test('addWorkspace and removeWorkspace manage saved workspace list', (t) => {
  const before = readRaw(workspaceFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-store-'));
  t.after(() => {
    restoreRaw(workspaceFile, before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const added = store.addWorkspace(dir);
  assert.equal(added.path, dir);
  assert.equal(
    store.listWorkspaces().some((w) => w.id === added.id),
    true
  );

  assert.equal(store.removeWorkspace(added.id), true);
  assert.equal(
    store.listWorkspaces().some((w) => w.id === added.id),
    false
  );
  assert.equal(store.removeWorkspace(added.id), false);
});

test('session CSV export preserves diagnostics and neutralizes spreadsheet formulas', () => {
  const csv = store.eventsToCsv([
    {
      ts: 0,
      seq: 4,
      kind: 'agent',
      actor: 'claude',
      role: 'developer',
      model: 'sonnet',
      type: 'message',
      text: '=HYPERLINK("https://example.invalid","click")\nnext line',
      meta: { final: true },
    },
  ]);

  assert.match(csv, /"timestamp","sequence","kind","actor","role","model","type","text","meta"/);
  assert.match(csv, /1970-01-01T00:00:00\.000Z/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid"",""click""\)\nnext line"/);
  assert.match(csv, /"\{""final"":true\}"/);
});

test('local profile settings and backup export/import persist app state', (t) => {
  const beforeWorkspaces = readRaw(workspaceFile);
  const beforeProfile = readRaw(profileFile);
  const beforeTeams = readRaw(teamsFile);
  const beforeSkills = readRaw(customSkillsFile);
  const beforeSessions = snapshotSessions();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-profile-'));

  t.after(() => {
    restoreRaw(workspaceFile, beforeWorkspaces);
    restoreRaw(profileFile, beforeProfile);
    restoreRaw(teamsFile, beforeTeams);
    restoreRaw(customSkillsFile, beforeSkills);
    restoreSessions(beforeSessions);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ws = store.addWorkspace(dir);
  const sid = store.createSession(ws.id);
  store.append(ws.id, sid, { kind: 'user', actor: 'user', type: 'message', text: 'hello' });
  const profile = store.saveProfileSettings({
    selectedWorkspaceId: ws.id,
    selectedSessionId: sid,
    activeTeamId: 'alpha',
    contextMode: 'maximum',
    fontSize: 16,
    ignored: 'nope',
  });
  assert.equal(profile.settings.selectedWorkspaceId, ws.id);
  assert.equal(profile.settings.ignored, undefined);

  fs.writeFileSync(
    teamsFile,
    JSON.stringify([{ id: 'alpha', name: 'Alpha', members: [], leadIndex: 0 }], null, 2)
  );
  fs.writeFileSync(
    customSkillsFile,
    JSON.stringify([{ id: 'pm-local', name: 'PM', role: 'PM', instructions: 'Plan' }], null, 2)
  );

  const exported = store.exportProfile();
  assert.equal(exported.type, 'crewforge-profile');
  assert.equal(exported.profile.settings.selectedSessionId, sid);
  assert.equal(exported.sessions[ws.id][sid].includes('hello'), true);
  assert.equal(exported.teams[0].id, 'alpha');
  assert.equal(exported.customSkills[0].id, 'pm-local');
  const orphanDir = path.join(sessionsDir, 'orphanws');
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(orphanDir, 'old.jsonl'), '{"text":"stale"}\n');

  store.importProfile(
    {
      ...exported,
      workspaces: [
        ...exported.workspaces,
        { id: 'unsafe', path: '/tmp/outside-home', name: 'Unsafe', addedAt: Date.now() },
      ],
    },
    { workspaceAllowed: (workspacePath) => workspacePath === dir }
  );

  assert.equal(fs.existsSync(path.join(orphanDir, 'old.jsonl')), false);
  assert.deepEqual(
    store.listWorkspaces().map((w) => w.id),
    [ws.id]
  );
  assert.equal(store.getProfile().settings.contextMode, 'maximum');
  assert.equal(store.readEvents(ws.id, sid)[0].text, 'hello');
});
