'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { ev, TokenStreamer, cliExitError, safeCliEnv } = require('./base');

// Grok streaming-json emits token events: {type:"thought",data} {type:"text",data}
// {type:"end",stopReason,...}. Tool/file events appear as other types during
// coding tasks and are passed through defensively.
module.exports = {
  id: 'grok',
  label: 'Grok Build',
  kind: 'cli',
  canEdit: true,
  defaultModel: 'grok-build',
  models: ['grok-build', 'grok-composer-2.5-fast'],

  run({ prompt, model, cwd, mode, signal }, onEvent) {
    if (signal && signal.aborted) return Promise.resolve({ finalText: '', cancelled: true });
    return new Promise((resolve) => {
      // Headless Grok uses --single. Plan mode restricts the available tools;
      // edit mode allows approvals so it can modify files in the workspace.
      const args = [
        '--single',
        prompt,
        '--output-format',
        'streaming-json',
        '--permission-mode',
        mode === 'edit' ? 'acceptEdits' : 'plan',
        '--cwd',
        cwd || process.cwd(),
      ];
      if (mode === 'edit') args.push('--always-approve');
      else args.push('--tools', 'read_file,grep,list_dir');
      if (model) args.push('-m', model);

      const child = spawn('grok', args, { stdio: ['ignore', 'pipe', 'pipe'], env: safeCliEnv() });
      const rl = readline.createInterface({ input: child.stdout });
      const stream = new TokenStreamer(onEvent);
      let finalText = '';
      let stderr = '';
      let settled = false;
      let cancelled = false;

      function onAbort() {
        if (settled) return;
        cancelled = true;
        stream.flush();
        onEvent(ev('status', 'cancelled'));
        child.kill('SIGTERM');
        rl.close();
        finish({ finalText, cancelled: true });
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

        switch (o.type) {
          case 'thought':
            stream.push('reasoning', o.data || '');
            break;
          case 'text':
            finalText += o.data || '';
            stream.push('message', o.data || '');
            break;
          case 'tool_use':
          case 'tool':
          case 'command':
            stream.flush();
            onEvent(ev('command', o.data || o.command || JSON.stringify(o)));
            break;
          case 'file':
          case 'file_change':
          case 'patch':
            stream.flush();
            onEvent(ev('file_change', o.data || JSON.stringify(o), { file: o.path }));
            break;
          case 'error':
            stream.flush();
            onEvent(ev('error', o.message || JSON.stringify(o)));
            break;
          case 'end':
            stream.flush();
            onEvent(ev('done', '', { finalText, stopReason: o.stopReason, session: o.sessionId }));
            break;
          default:
            // unknown event types: surface as reasoning so nothing is silently lost
            stream.flush();
            onEvent(
              ev(
                'reasoning',
                `[${o.type || 'unknown'}] ${o.data || o.message || JSON.stringify(o)}`,
                {
                  final: true,
                }
              )
            );
        }
      });

      child.stderr.on('data', (c) => {
        stderr += String(c);
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on('error', (e) => {
        if (cancelled) return finish({ finalText, cancelled: true });
        onEvent(ev('error', `grok spawn failed: ${e.message}`));
        finish({ finalText, error: true });
      });
      child.on('close', (code, sig) => {
        if (cancelled || settled) return;
        stream.flush();
        if (code !== 0) onEvent(ev('error', cliExitError('grok', code, sig, stderr)));
        finish({ finalText, error: code !== 0 });
      });
    });
  },
};
