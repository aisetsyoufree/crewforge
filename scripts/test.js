'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'test');
const isolatedData = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-tests-'));
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join('test', name));

let status = 1;
try {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: root,
    env: { ...process.env, CREW_FORGE_DATA_DIR: isolatedData },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  status = Number.isInteger(result.status) ? result.status : 1;
} finally {
  fs.rmSync(isolatedData, { recursive: true, force: true });
}

process.exitCode = status;
