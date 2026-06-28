'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const store = require('../lib/store');

const workspaceFile = path.join(__dirname, '..', 'data', 'workspaces.json');

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

test('addWorkspace and removeWorkspace manage saved workspace list', (t) => {
  const before = readWorkspacesRaw();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-store-'));
  t.after(() => {
    restoreWorkspaces(before);
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
