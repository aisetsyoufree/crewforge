'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { ev, cliExitError, safeCliEnv } = require('./base');

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Claude stream-json: system/init, assistant{message.content[]}, rate_limit_event,
// result{result,usage,total_cost_usd}. Content blocks: text | thinking | tool_use.
module.exports = {
  id: 'claude',
  label: 'Claude',
  kind: 'cli',
  canEdit: true,
  defaultModel: 'sonnet',
  models: ['sonnet', 'opus', 'haiku'],

  run({ prompt, model, cwd, mode, signal }, onEvent) {
    if (signal && signal.aborted)
      return Promise.resolve({ finalText: '', usage: null, cancelled: true });
    return new Promise((resolve) => {
      const args = [
        '--print',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        mode === 'edit' ? 'acceptEdits' : 'plan',
      ];
      if (model) args.push('--model', model);

      const child = spawn('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: cwd || process.cwd(),
        env: safeCliEnv(),
      });
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

        if (o.type === 'system' && o.subtype === 'init') {
          onEvent(ev('status', 'Claude session started', { model: o.model }));
        } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
          for (const block of o.message.content) {
            if (block.type === 'text' && block.text) {
              onEvent(ev('message', block.text, { final: true }));
            } else if (block.type === 'thinking' && block.thinking) {
              onEvent(ev('reasoning', block.thinking, { final: true }));
            } else if (block.type === 'tool_use') {
              if (block.name === 'Bash') {
                onEvent(
                  ev('command', (block.input && block.input.command) || '', { tool: 'Bash' })
                );
              } else if (FILE_TOOLS.has(block.name)) {
                onEvent(
                  ev(
                    'file_change',
                    `${block.name}: ${(block.input && block.input.file_path) || ''}`,
                    { file: block.input && block.input.file_path, tool: block.name }
                  )
                );
              } else {
                onEvent(
                  ev(
                    'command',
                    `${block.name} ${JSON.stringify(block.input || {})}`.slice(0, 400),
                    { tool: block.name }
                  )
                );
              }
            }
          }
        } else if (o.type === 'rate_limit_event' && o.rate_limit_info) {
          const r = o.rate_limit_info;
          onEvent(ev('rate_limit', `status:${r.status} type:${r.rateLimitType}`, r));
        } else if (o.type === 'result') {
          finalText = o.result || finalText;
          usage = o.usage || null;
          onEvent(
            ev(
              'usage',
              `in:${usage ? usage.input_tokens : '?'} out:${usage ? usage.output_tokens : '?'} $${(o.total_cost_usd || 0).toFixed(4)}`,
              { usage, cost: o.total_cost_usd }
            )
          );
          onEvent(ev('done', '', { finalText, usage, terminal: o.terminal_reason }));
        }
      });

      child.stderr.on('data', (c) => {
        stderr += String(c);
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on('error', (e) => {
        if (cancelled) return finish({ finalText, usage, cancelled: true });
        onEvent(ev('error', `claude spawn failed: ${e.message}`));
        finish({ finalText, usage, error: true });
      });
      child.on('close', (code, sig) => {
        if (cancelled || settled) return;
        if (code !== 0) onEvent(ev('error', cliExitError('claude', code, sig, stderr)));
        finish({ finalText, usage, error: code !== 0 });
      });
    });
  },
};
