'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const {
  EFFORT_LEVELS,
  ev,
  normalizeEffort,
  TokenStreamer,
  cliExitError,
  safeCliEnv,
} = require('./base');

function signalsPath(cwd, sessionId) {
  if (!sessionId) return null;
  const base = path.join(
    os.homedir(),
    '.grok',
    'sessions',
    encodeURIComponent(cwd || process.cwd())
  );
  return path.join(base, sessionId, 'signals.json');
}

function readSignals(cwd, sessionId) {
  const file = signalsPath(cwd, sessionId);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function buildArgs({ prompt, model, effort, cwd, mode }) {
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
  const normalizedEffort = normalizeEffort(effort);
  if (normalizedEffort) args.push('--effort', normalizedEffort);
  if (model) args.push('-m', model);
  return args;
}

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
  effortLevels: EFFORT_LEVELS,
  defaultEffort: 'medium',
  _buildArgs: buildArgs,

  run({ prompt, model, effort, cwd, mode, signal }, onEvent) {
    if (signal && signal.aborted) return Promise.resolve({ finalText: '', cancelled: true });
    return new Promise((resolve) => {
      const args = buildArgs({ prompt, model, effort, cwd, mode });

      const child = spawn('grok', args, { stdio: ['ignore', 'pipe', 'pipe'], env: safeCliEnv() });
      const rl = readline.createInterface({ input: child.stdout });
      const stream = new TokenStreamer(onEvent);
      let finalText = '';
      let sessionId = null;
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
            sessionId = o.sessionId || sessionId;
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
        const signals = readSignals(cwd, sessionId);
        if (signals) {
          onEvent(
            ev(
              'usage',
              `context:${signals.contextTokensUsed || 0} tools:${signals.toolCallCount || 0}`,
              {
                contextTokensUsed: signals.contextTokensUsed,
                contextWindowTokens: signals.contextWindowTokens,
                toolCallCount: signals.toolCallCount,
                sessionDurationSeconds: signals.sessionDurationSeconds,
                session: sessionId,
                approximate: true,
              }
            )
          );
        } else {
          onEvent(ev('usage', 'call recorded; token details unavailable', { approximate: true }));
        }
        if (code !== 0) onEvent(ev('error', cliExitError('grok', code, sig, stderr)));
        finish({ finalText, error: code !== 0 });
      });
    });
  },
  _readSignals: readSignals,
};
