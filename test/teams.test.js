'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const teams = require('../lib/teams');

const teamsFile = path.join(__dirname, '..', 'data', 'teams.json');

function readTeamsRaw() {
  try {
    return fs.readFileSync(teamsFile, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function restoreTeams(raw) {
  fs.mkdirSync(path.dirname(teamsFile), { recursive: true });
  if (raw === null) {
    try {
      fs.unlinkSync(teamsFile);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
    }
    return;
  }
  fs.writeFileSync(teamsFile, raw);
}

test('saveTeam mints an id when absent and persists', (t) => {
  const before = readTeamsRaw();
  t.after(() => restoreTeams(before));

  const saved = teams.saveTeam({ name: 'Alpha Squad' });
  assert.match(saved.id, /^[a-f0-9]{12}$/);
  assert.equal(saved.name, 'Alpha Squad');

  const loaded = teams.getTeam(saved.id);
  assert.deepEqual(loaded, saved);
  assert.equal(
    teams.listTeams().some((team) => team.id === saved.id),
    true
  );
});

test('saveTeam with a provided valid id upserts', (t) => {
  const before = readTeamsRaw();
  t.after(() => restoreTeams(before));

  const id = 'team-upsert-test';
  const first = teams.saveTeam({
    id,
    name: 'Original',
    members: [{ adapter: 'codex', model: 'gpt-4', role: 'lead' }],
    leadIndex: 0,
  });
  const second = teams.saveTeam({
    id,
    name: 'Updated',
    members: [{ adapter: 'claude', model: 'opus', role: 'reviewer' }],
    leadIndex: 0,
  });

  assert.equal(first.id, id);
  assert.equal(second.id, id);
  assert.equal(second.name, 'Updated');
  assert.equal(teams.listTeams().filter((team) => team.id === id).length, 1);

  const loaded = teams.getTeam(id);
  assert.equal(loaded.name, 'Updated');
  assert.deepEqual(loaded.members, [{ adapter: 'claude', model: 'opus', role: 'reviewer' }]);
});

test('saveTeam rejects invalid ids', (t) => {
  const before = readTeamsRaw();
  t.after(() => restoreTeams(before));

  for (const badId of ['../x', 'a/b']) {
    assert.throws(
      () => teams.saveTeam({ id: badId, name: 'Bad' }),
      (err) => err instanceof Error && /invalid team id/.test(err.message)
    );
  }
});

test('getTeam returns saved team and null for unknown', (t) => {
  const before = readTeamsRaw();
  t.after(() => restoreTeams(before));

  const saved = teams.saveTeam({ id: 'team-get-test', name: 'Lookup' });
  assert.deepEqual(teams.getTeam('team-get-test'), saved);
  assert.equal(teams.getTeam('team-does-not-exist'), null);
});

test('member objects are preserved', (t) => {
  const before = readTeamsRaw();
  t.after(() => restoreTeams(before));

  const members = [
    { adapter: 'codex', model: 'gpt-4.1', role: 'implementer' },
    { adapter: 'claude', model: 'sonnet', role: 'reviewer' },
  ];
  const saved = teams.saveTeam({
    id: 'team-members-test',
    name: 'Member Team',
    members,
    leadIndex: 1,
  });

  assert.deepEqual(saved.members, members);
  assert.deepEqual(teams.getTeam('team-members-test').members, members);
  assert.equal(saved.leadIndex, 1);
});

test('deleteTeam removes team and returns true, false for unknown', (t) => {
  const before = readTeamsRaw();
  t.after(() => restoreTeams(before));

  const saved = teams.saveTeam({ id: 'team-delete-test', name: 'Disposable' });
  assert.equal(teams.getTeam(saved.id) !== null, true);

  assert.equal(teams.deleteTeam(saved.id), true);
  assert.equal(teams.getTeam(saved.id), null);
  assert.equal(teams.deleteTeam(saved.id), false);
  assert.equal(teams.deleteTeam('team-never-saved'), false);
});
