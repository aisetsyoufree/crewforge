'use strict';

const { spawn } = require('node:child_process');
const { ev, cliExitError, safeCliEnv } = require('./base');

const DEFAULT_MODEL = 'Gemini 3.1 Pro (High)';
const CONFIGURED_MODELS = [
  DEFAULT_MODEL,
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (Low)',
];

function buildArgs({ prompt, model, cwd, mode }) {
  const workspace = cwd || process.cwd();
  const args = [
    '--new-project',
    '--add-dir',
    workspace,
    '--model',
    model || DEFAULT_MODEL,
    '--mode',
    mode === 'edit' ? 'accept-edits' : 'plan',
    '--sandbox',
    '--print-timeout',
    '10m',
  ];
  args.push('--print', prompt);
  return args;
}

module.exports = {
  id: 'antigravity',
  label: 'Google Antigravity',
  kind: 'cli',
  canEdit: true,
  defaultModel: DEFAULT_MODEL,
  models: CONFIGURED_MODELS,
  effortLevels: [],
  _buildArgs: buildArgs,

  run({ prompt, model, cwd, mode, signal }, onEvent) {
    if (signal && signal.aborted) return Promise.resolve({ finalText: '', cancelled: true });
    return new Promise((resolve) => {
      const args = buildArgs({ prompt, model, cwd, mode });
      const child = spawn('agy', args, {
        cwd: cwd || process.cwd(),
        env: safeCliEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let cancelled = false;

      function finish(result) {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(result);
      }

      function onAbort() {
        if (settled) return;
        cancelled = true;
        child.kill('SIGTERM');
        onEvent(ev('status', 'cancelled'));
        finish({ finalText: stdout.trim(), cancelled: true });
      }

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      onEvent(
        ev('status', `Antigravity (${model || DEFAULT_MODEL}) started`, {
          sandbox: true,
          mode: mode === 'edit' ? 'accept-edits' : 'plan',
        })
      );

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-8 * 1024 * 1024);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on('error', (error) => {
        if (cancelled) return finish({ finalText: stdout.trim(), cancelled: true });
        onEvent(ev('error', `Antigravity spawn failed: ${error.message}`));
        finish({ finalText: stdout.trim(), error: true });
      });
      child.on('close', (code, closeSignal) => {
        if (cancelled || settled) return;
        const finalText = stdout.trim();
        if (code !== 0) {
          onEvent(ev('error', cliExitError('agy', code, closeSignal, stderr)));
          return finish({ finalText, error: true });
        }
        if (finalText) onEvent(ev('message', finalText, { final: true }));
        onEvent(ev('usage', 'call recorded; token details unavailable', { approximate: true }));
        onEvent(ev('done', '', { finalText }));
        finish({ finalText });
      });
    });
  },
};
