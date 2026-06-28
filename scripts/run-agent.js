#!/usr/bin/env node
'use strict';

// Adapter smoke runner:
//   npm run adapter:run -- <claude|codex|grok|gemini> "<prompt>" [cwd] [plan|edit]

const { run, catalog } = require('../adapters');

const [, , id, prompt, cwd, mode] = process.argv;
if (!id || !prompt) {
  console.log('usage: npm run adapter:run -- <adapter> "<prompt>" [cwd] [plan|edit]');
  console.log(
    'adapters:',
    catalog()
      .map((a) => `${a.id}(${a.canEdit ? 'edit' : 'text'})`)
      .join(', ')
  );
  process.exit(1);
}

const C = {
  reasoning: '\x1b[90m',
  message: '\x1b[36m',
  command: '\x1b[33m',
  file_change: '\x1b[32m',
  usage: '\x1b[35m',
  status: '\x1b[34m',
  rate_limit: '\x1b[31m',
  error: '\x1b[41m',
  done: '\x1b[32m',
};
const R = '\x1b[0m';
let lastDelta = null;

function show(e) {
  if (e.meta && e.meta.delta) {
    if (lastDelta !== e.type) {
      process.stdout.write(`\n${C[e.type] || ''}${e.type}: ${R}`);
      lastDelta = e.type;
    }
    process.stdout.write((C[e.type] || '') + e.text + R);
    return;
  }
  if (e.meta && e.meta.final && lastDelta === e.type) {
    lastDelta = null;
    return;
  }
  lastDelta = null;
  const tag = `${C[e.type] || ''}${e.type.toUpperCase()}${R}`;
  console.log(`\n[${tag}] ${e.text}`);
}

(async () => {
  console.log(`\n=== running ${id} (${mode || 'plan'}) ===`);
  const t0 = Date.now();
  const out = await run(
    id,
    { prompt, model: undefined, cwd: cwd || process.cwd(), mode: mode || 'plan' },
    show
  );
  console.log(
    `\n\n--- finished in ${((Date.now() - t0) / 1000).toFixed(1)}s · final length ${((out && out.finalText) || '').length} chars ---`
  );
})();
