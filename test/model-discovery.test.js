'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const discovery = require('../lib/model_discovery');

function writeBin(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

test('refreshCatalog merges CLI-discovered models for Codex, Grok, Claude, and Antigravity', async (t) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-models-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-model-home-'));
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  t.after(() => {
    process.env.PATH = oldPath;
    process.env.HOME = oldHome;
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  writeBin(
    binDir,
    'codex',
    `cat <<'JSON'
{"models":[{"slug":"gpt-new","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]},{"slug":"hidden","visibility":"hidden"}]}
JSON`
  );
  writeBin(
    binDir,
    'grok',
    `cat <<'EOF'
Default model: grok-new
Available models:
  - grok-build
  * grok-new
EOF`
  );
  writeBin(
    binDir,
    'claude',
    `cat <<'EOF'
--model <model> Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')
EOF`
  );
  writeBin(
    binDir,
    'agy',
    `cat <<'EOF'
Gemini 3.5 Flash (High)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
EOF`
  );
  if (process.platform === 'darwin') {
    writeBin(
      binDir,
      'script',
      `cat <<'EOF'
Gemini 3.5 Flash (High)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
EOF`
    );
  }
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.claude', 'settings.json'),
    JSON.stringify({ model: 'claude-fable-5' })
  );
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  process.env.HOME = homeDir;

  const refreshed = await discovery.refreshCatalog([
    {
      id: 'claude',
      label: 'Claude',
      models: ['sonnet'],
      defaultModel: 'sonnet',
      modelEffortLevels: null,
    },
    { id: 'codex', label: 'Codex', models: ['gpt-old'], defaultModel: 'gpt-old' },
    { id: 'grok', label: 'Grok', models: ['grok-old'], defaultModel: 'grok-old' },
    {
      id: 'antigravity',
      label: 'Google Antigravity',
      models: ['configured-model'],
      defaultModel: 'configured-model',
    },
  ]);

  const claude = refreshed.find((entry) => entry.id === 'claude');
  const codex = refreshed.find((entry) => entry.id === 'codex');
  const grok = refreshed.find((entry) => entry.id === 'grok');
  const antigravity = refreshed.find((entry) => entry.id === 'antigravity');

  assert.equal(claude.defaultModel, 'claude-fable-5');
  assert.equal(claude.models.includes('fable'), true);
  assert.deepEqual(codex.models.slice(0, 2), ['gpt-new', 'gpt-old']);
  assert.deepEqual(codex.modelEffortLevels['gpt-new'], ['low', 'high']);
  assert.equal(grok.defaultModel, 'grok-new');
  assert.equal(grok.models.includes('grok-new'), true);
  assert.equal(antigravity.defaultModel, 'Gemini 3.1 Pro (High)');
  assert.equal(antigravity.models.includes('Claude Sonnet 4.6 (Thinking)'), true);
});
