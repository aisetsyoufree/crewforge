'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { ev, cliExitError, safeCliEnv } = require('./base');

// Codex emits JSONL: thread.started / item.completed{item} / turn.completed{usage}
module.exports = {
  id: 'codex',
  label: 'Codex',
  kind: 'cli',
  canEdit: true,
  defaultModel: 'gpt-5.5',
  models: ['gpt-5.5', 'gpt-5.5-codex'],

  run({ prompt, model, cwd, mode, signal }, onEvent) {
    if (signal && signal.aborted)
      return Promise.resolve({ finalText: '', usage: null, cancelled: true });
    return new Promise((resolve) => {
      const sandbox = mode === 'edit' ? 'workspace-write' : 'read-only';
      const args = [
        'exec',
        '--json',
        '--sandbox',
        sandbox,
        '--skip-git-repo-check',
        '-C',
        cwd || process.cwd(),
      ];
      if (model) args.push('-m', model);
      args.push(prompt);

      const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'], env: safeCliEnv() });
      const rl = readline.createInterface({ input: child.stdout });
      let finalText = '';
      let usage = null;
      let stderr = '';
      let settled = false;
      let cancelled = false;

      function onAbort() {
        if (settled) return;
        cancelled = true;
        onEvent(ev('status', 'cancelled'));
        child.kill('SIGTERM');
        rl.close();
        finish({ finalText, usage, cancelled: true });
      }
      function cleanup() {
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function finish(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      rl.on('line', (line) => {
        const t = line.trim();
        if (!t || t[0] !== '{') return;
        let o;
        try {
          o = JSON.parse(t);
        } catch {
          return;
        }

        if (o.type === 'thread.started') {
          onEvent(ev('status', 'Codex session started', { thread: o.thread_id }));
        } else if (o.type === 'item.completed' && o.item) {
          const it = o.item;
          const text = it.text || it.message || '';
          if (it.type === 'agent_message') {
            finalText = text;
            onEvent(ev('message', text, { final: true }));
          } else if (/reason/i.test(it.type)) {
            onEvent(ev('reasoning', text || '(thinking)', { final: true }));
          } else if (/command|exec/i.test(it.type)) {
            onEvent(ev('command', it.command || text || JSON.stringify(it)));
          } else if (/file|patch|change/i.test(it.type)) {
            onEvent(ev('file_change', text || JSON.stringify(it.changes || it), { file: it.path }));
          } else {
            onEvent(ev('reasoning', text || `(${it.type})`, { final: true }));
          }
        } else if (o.type === 'turn.completed' && o.usage) {
          usage = o.usage;
          onEvent(ev('usage', `in:${o.usage.input_tokens} out:${o.usage.output_tokens}`, o.usage));
        }
      });

      child.stderr.on('data', (c) => {
        stderr += String(c);
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on('error', (e) => {
        if (cancelled) return finish({ finalText, usage, cancelled: true });
        onEvent(ev('error', `codex spawn failed: ${e.message}`));
        finish({ finalText, usage, error: true });
      });
      child.on('close', (code, sig) => {
        if (cancelled || settled) return;
        if (code !== 0) onEvent(ev('error', cliExitError('codex', code, sig, stderr)));
        onEvent(ev('done', '', { finalText, usage }));
        finish({ finalText, usage, error: code !== 0 });
      });
    });
  },
};
