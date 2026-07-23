'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const ph = require('../lib/provider_health');

test('parseVersion extracts first semver triple', () => {
  assert.deepEqual(ph.parseVersion('2.1.187 (Claude Code)'), [2, 1, 187]);
  assert.deepEqual(ph.parseVersion('codex-cli 0.142.5'), [0, 142, 5]);
  assert.equal(ph.parseVersion('not-a-version'), null);
  assert.equal(ph.parseVersion(''), null);
});

test('versionAtLeast compares semver triples', () => {
  assert.equal(ph.versionAtLeast('2.1.187', '2.1.187'), true);
  assert.equal(ph.versionAtLeast('2.1.188', '2.1.187'), true);
  assert.equal(ph.versionAtLeast('2.0.0', '2.1.187'), false);
  assert.equal(ph.versionAtLeast('unknown', '2.1.187'), false);
  assert.equal(ph.versionAtLeast('2.1.187', 'bad'), false);
});

test('classifyVersion does not mark unparseable as incompatible', () => {
  const unknown = ph.classifyVersion('built-from-source', '2.1.187', 'Claude');
  assert.equal(unknown.ok, true);
  assert.equal(unknown.status, ph.STATUS.VERSION_UNKNOWN);
  assert.match(unknown.hint, /Could not parse/);

  const old = ph.classifyVersion('2.0.0', '2.1.187', 'Claude');
  assert.equal(old.ok, false);
  assert.equal(old.status, ph.STATUS.VERSION_TOO_OLD);

  const ok = ph.classifyVersion('2.1.187', '2.1.187', 'Claude');
  assert.equal(ok.ok, true);
  assert.equal(ok.status, ph.STATUS.READY);
});

test('CLI_MIN_VERSION includes conservative Claude and Codex floors', () => {
  assert.equal(ph.CLI_MIN_VERSION.claude, '2.1.187');
  assert.equal(ph.CLI_MIN_VERSION.codex, '0.142.5');
  assert.ok(ph.CLI_MIN_VERSION.grok);
  assert.ok(ph.CLI_MIN_VERSION.antigravity);
});

test('checkProvider reports missing CLI status shape', async () => {
  const exec = async () => {
    throw new Error('missing');
  };
  const row = await ph.checkProvider({ id: 'claude', label: 'Claude', kind: 'cli' }, { exec });
  assert.equal(row.ready, false);
  assert.equal(row.status, ph.STATUS.MISSING_CLI);
  assert.equal(row.statusLabel, 'CLI missing');
  assert.match(row.hint, /Install/);
  assert.equal(row.minimumVersion, '2.1.187');
});

test('checkProvider reports version_too_old with clear hint', async () => {
  // commandExists uses /bin/sh -lc "command -v …"
  const smartExec = async (file, args) => {
    if (file === '/bin/sh') return { stdout: '/bin/claude\n' };
    if (args[0] === '--version' || args[0] === 'version') return { stdout: '2.0.0\n' };
    if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true }) };
    return { stdout: '' };
  };
  const row = await ph.checkProvider(
    { id: 'claude', label: 'Claude', kind: 'cli' },
    { exec: smartExec }
  );
  assert.equal(row.ready, false);
  assert.equal(row.status, ph.STATUS.VERSION_TOO_OLD);
  assert.match(row.hint, /2\.1\.187/);
  assert.equal(row.version.includes('2.0.0'), true);
});

test('checkProvider keeps ready true when version is unparseable', async () => {
  const smartExec = async (file, args) => {
    if (file === '/bin/sh') return { stdout: '/bin/claude\n' };
    if (args[0] === '--version' || args[0] === 'version') return { stdout: 'dev-build\n' };
    if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true }) };
    return { stdout: '' };
  };
  const row = await ph.checkProvider(
    { id: 'claude', label: 'Claude', kind: 'cli' },
    { exec: smartExec }
  );
  assert.equal(row.ready, true);
  assert.equal(row.status, ph.STATUS.VERSION_UNKNOWN);
  assert.match(row.hint, /Could not parse/);
});

test('checkProvider reports auth_not_confirmed when probe says logged out', async () => {
  const smartExec = async (file, args) => {
    if (file === '/bin/sh') return { stdout: '/bin/claude\n' };
    if (args[0] === '--version' || args[0] === 'version') return { stdout: '2.1.187\n' };
    if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: false }) };
    return { stdout: '' };
  };
  const row = await ph.checkProvider(
    { id: 'claude', label: 'Claude', kind: 'cli' },
    { exec: smartExec }
  );
  assert.equal(row.ready, false);
  assert.equal(row.status, ph.STATUS.AUTH_NOT_CONFIRMED);
  assert.equal(row.auth, false);
});

test('checkProvider ready shape includes version and statusLabel', async () => {
  const smartExec = async (file, args) => {
    if (file === '/bin/sh') return { stdout: '/bin/claude\n' };
    if (args[0] === '--version' || args[0] === 'version')
      return { stdout: '2.1.187 (Claude Code)\n' };
    if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true }) };
    return { stdout: '' };
  };
  const row = await ph.checkProvider(
    { id: 'claude', label: 'Claude', kind: 'cli' },
    { exec: smartExec }
  );
  assert.equal(row.ready, true);
  assert.equal(row.status, ph.STATUS.READY);
  assert.equal(row.statusLabel, 'Ready');
  assert.equal(row.auth, true);
  assert.ok(row.version.includes('2.1.187'));
  assert.equal(row.minimumVersion, '2.1.187');
});

test('providerHealth returns array matching catalog order', async () => {
  const catalog = [
    { id: 'claude', label: 'Claude', kind: 'cli' },
    { id: 'gemini', label: 'Gemini', kind: 'api' },
  ];
  const smartExec = async (file, _args) => {
    if (file === '/bin/sh') throw new Error('missing');
    return { stdout: '' };
  };
  const rows = await ph.providerHealth(catalog, {
    exec: smartExec,
    hasApiKey: () => false,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'claude');
  assert.equal(rows[0].status, ph.STATUS.MISSING_CLI);
  assert.equal(rows[1].id, 'gemini');
  assert.equal(rows[1].status, ph.STATUS.NEEDS_KEY);
  assert.equal(rows[1].ready, false);
});
