#!/usr/bin/env node
'use strict';

/*
 * Crew Forge server — workspace + history + live agent runs.
 *
 *   GET  /                         dashboard UI
 *   GET  /styles.css               dashboard styles
 *   GET  /app.js                   dashboard client script
 *   GET  /api/catalog              available models/adapters
 *   GET  /api/catalog/refresh      refresh model lists from local CLIs
 *   GET  /api/health               provider readiness checks
 *   GET  /api/context-saver        context saver and optional Headroom status
 *   GET  /api/profile              local profile settings
 *   POST /api/profile {settings}   update local profile settings
 *   GET  /api/profile/export       export local profile backup
 *   POST /api/profile/import       import local profile backup
 *   GET  /api/fs?path=             folder browser (list subdirectories)
 *   GET  /api/file?ws=&path=       read a workspace file for preview
 *   POST /api/fs/pick-folder       open native folder picker when supported
 *   GET  /api/workspaces           saved workspaces
 *   POST /api/workspaces {path}    add a workspace
 *   DELETE /api/workspaces?id=     forget a workspace
 *   GET  /api/sessions?ws=         sessions for a workspace
 *   GET  /api/sessions/export?ws=&sid= export one session as CSV
 *   POST /api/sessions {ws}        create a session
 *   GET  /api/changes?ws=          changed files for a workspace
 *   GET  /api/diff?ws=             git diff for a workspace
 *   GET  /api/worktree/pending?ws=&worktreeId=  inspect pending Crew Forge worktree
 *   POST /api/worktree/integrate {ws,sid,worktreeId}  apply after preflight
 *   POST /api/worktree/reject {ws,sid,worktreeId}   discard pending worktree
 *   GET  /api/stream?ws=&sid=&off= SSE live event stream (replays history)
 *   POST /api/run {ws,sid,adapter,model,mode,prompt,role}  run one agent turn
 *   POST /api/review {ws,sid,reviewer,reviewerModel}        cross-model diff review
 *   POST /api/stop {ws,sid}                                  stop an active run
 *   GET  /api/teams                  saved teams
 *   POST /api/teams {team}           create/update a team
 *   DELETE /api/teams?id=            delete a team
 *   GET  /api/skills                 built-in and local crew skills
 *   POST /api/skills {skill}         create/update a local crew skill
 *   DELETE /api/skills?id=           delete/reset a local crew skill
 *   POST /api/plan {ws,sid,teamId,prompt}       propose team steps
 *   POST /api/approve {ws,sid,teamId,steps}     run approved team steps
 *   GET  /api/projects?ws=&sid=                 list tracked projects for a session
 *   GET  /api/projects/detail?projectId=        project + task summary (ws/sid ownership)
 *   GET  /api/tasks/detail?projectId=&taskId=   single tracked task detail
 *   GET  /api/usage                              observed token usage across sessions
 *   GET  /api/keys                               locally stored provider key status
 *   POST /api/keys {provider,key}                save provider API key
 *   DELETE /api/keys?provider=                   remove provider API key
 *   POST /api/dev/start {ws,cmd}                 spawn a dev server in the workspace
 *   POST /api/dev/stop {ws}                      kill the dev server
 *   GET  /api/dev/status?ws=                     dev server running state
 *   GET  /api/dev/stream?ws=                     SSE stream of dev server stdout/stderr
 *
 * Node >= 18.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

// Load .env if present — only sets vars not already in the environment.
// No external deps; reads KEY=VALUE lines, skips comments and blanks.
(function loadDotEnv() {
  const envFile = path.join(__dirname, '.env');
  try {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const val = line
        .slice(eq + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env is optional; silently ignore if missing.
  }
})();
const adapters = require('./adapters');
const store = require('./lib/store');
const watcher = require('./lib/watcher');
const teams = require('./lib/teams');
const orchestrator = require('./lib/orchestrator');
const contextSaver = require('./lib/context_saver');
const modelDiscovery = require('./lib/model_discovery');
const skills = require('./lib/skills');
const usage = require('./lib/usage');
const { guardedEmitter, withWorkspaceInstruction } = require('./lib/workspace_guard');
const worktree = require('./lib/worktree');
const { finishDirectRun } = require('./lib/run_outcome');
const { continuationFromPending, findUnresolvedPending } = require('./lib/pending_integration');
const { buildReviewPrompt } = require('./lib/review');
const keys = require('./lib/keys');
const tasks = require('./lib/tasks');
const taskTracker = require('./lib/task_tracker');
const { normalizeEffort, safeCliEnv } = require('./adapters/base');

const PORT = Number(process.argv[2]) || 4178;
const ROOT = __dirname;
const STATIC_ASSETS = {
  '/styles.css': {
    file: path.join(ROOT, 'public', 'styles.css'),
    contentType: 'text/css; charset=utf-8',
  },
  '/app.js': {
    file: path.join(ROOT, 'public', 'app.js'),
    contentType: 'application/javascript; charset=utf-8',
  },
};
const KEY_ENV = { gemini: 'GEMINI_API_KEY' };
const CLI_BINS = { claude: 'claude', codex: 'codex', grok: 'grok', antigravity: 'agy' };
const CLI_MIN_VERSION = { grok: '0.2.72', antigravity: '1.1.1' };
const CLI_LOGIN = {
  claude: 'claude login',
  codex: 'codex login',
  grok: 'grok login --device-auth',
  antigravity: 'Sign in with the Antigravity app, then run: agy models',
};
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_FILE_PREVIEW_BYTES = 2 * 1024 * 1024;
const RUN_TIMEOUT_MS = Number(process.env.CREW_FORGE_RUN_TIMEOUT_MS || 15 * 60 * 1000);
const activeRuns = new Map();

// ---------- dev process registry ----------
const devProcs = new Map(); // wsId -> { proc, cmd, pid, output[], listeners }

// Shell operators we will not interpret (no shell is spawned). Presence => reject.
const SHELL_META = /(\|\||&&|[;|&<>`\n]|\$\(|\$\{)/;

// Split a shell-like command line into argv, honoring single/double quotes.
// Throws a user-safe error on shell metacharacters or unbalanced quotes so the
// dev runner can never become an arbitrary-shell-execution sink.
function tokenizeCommand(cmd) {
  if (SHELL_META.test(cmd)) {
    const e = new Error(
      'Command contains shell operators (| & ; < > $() etc.). For safety the dev runner executes without a shell — put complex commands in an npm/package script and run that.'
    );
    e.userSafe = true;
    throw e;
  }
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const c of cmd) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === ' ' || c === '\t') {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote) {
    const e = new Error('Unbalanced quotes in command.');
    e.userSafe = true;
    throw e;
  }
  if (started) tokens.push(cur);
  return tokens;
}

function assertWorkspaceBoundDevCommand(argv) {
  const fail = (message) => {
    const e = new Error(message);
    e.userSafe = true;
    throw e;
  };
  const [bin, ...args] = argv;
  if (!bin) fail('No command to run.');
  if (bin.includes('/') || bin.includes('\\'))
    fail('Use a command from PATH or an npm/package script, not a path to an executable.');
  for (const arg of args) {
    if (path.isAbsolute(arg) || arg.split(/[\\/]/).includes('..')) {
      fail(
        'Dev server commands cannot reference absolute paths or parent directories. Put workspace-local commands in an npm/package script and run that.'
      );
    }
  }
}

function startDevProc(wsId, wsPath, cmd) {
  const argv = tokenizeCommand(cmd);
  // Run with an allowlisted env (never the full process.env, which holds API keys).
  // Leading KEY=VALUE assignments are pulled in so e.g. "PORT=3000 npm start" works,
  // but only for a safe allowlist — never loader/runtime hijack vars (LD_PRELOAD,
  // DYLD_*, NODE_OPTIONS) or arbitrary secrets.
  const env = safeCliEnv();
  const DEV_ENV_ALLOW = new Set([
    'PORT',
    'HOST',
    'NODE_ENV',
    'DEBUG',
    'BROWSER',
    'HTTPS',
    'CI',
    'FORCE_COLOR',
  ]);
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
    const eq = argv[0].indexOf('=');
    const key = argv[0].slice(0, eq);
    if (DEV_ENV_ALLOW.has(key)) env[key] = argv[0].slice(eq + 1);
    argv.shift();
  }
  if (!argv.length) {
    const e = new Error('No command to run.');
    e.userSafe = true;
    throw e;
  }
  assertWorkspaceBoundDevCommand(argv);
  stopDevProc(wsId);
  const [bin, ...args] = argv;
  const allowedExecutables = Object.freeze({
    npm: 'npm',
    npx: 'npx',
    node: 'node',
    pnpm: 'pnpm',
    yarn: 'yarn',
    bun: 'bun',
    deno: 'deno',
    python: 'python',
    python3: 'python3',
    uv: 'uv',
    go: 'go',
    cargo: 'cargo',
    ruby: 'ruby',
    php: 'php',
  });
  const executable = allowedExecutables[bin];
  if (!executable) {
    const e = new Error(`Unsupported dev command: ${bin}`);
    e.userSafe = true;
    throw e;
  }
  const proc = spawn(executable, args, { cwd: wsPath, env, shell: false });
  const info = { proc, cmd, pid: proc.pid, output: [], listeners: new Set() };
  devProcs.set(wsId, info);
  const pushLine = (text, type) => {
    const capped = text.length > 8192 ? text.slice(0, 8192) + '…[truncated]' : text;
    const ev = { type, text: capped.trimEnd(), ts: Date.now() };
    info.output.push(ev);
    if (info.output.length > 2000) info.output.splice(0, info.output.length - 2000);
    for (const fn of info.listeners) fn(ev);
  };
  const onData = (type) => (chunk) =>
    chunk
      .toString()
      .split('\n')
      .forEach((line) => line && pushLine(line, type));
  proc.stdout.on('data', onData('stdout'));
  proc.stderr.on('data', onData('stderr'));
  proc.on('exit', (code, signal) => {
    pushLine(`Process exited (${code != null ? 'code ' + code : signal})`, 'exit');
    devProcs.delete(wsId);
  });
  proc.on('error', (err) => {
    pushLine(`Spawn error: ${err.message}`, 'exit');
    devProcs.delete(wsId);
  });
  return info;
}

function stopDevProc(wsId) {
  const info = devProcs.get(wsId);
  if (!info) return;
  devProcs.delete(wsId);
  try {
    info.proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        info.proc.kill('SIGKILL');
      } catch {}
    }, 3000);
  } catch {}
}

process.on('exit', () => {
  for (const wsId of devProcs.keys()) stopDevProc(wsId);
});
const REQUESTED_HOST = process.env.CREW_FORGE_HOST || '127.0.0.1';
const AUTH_TOKEN_ENV = process.env.CREW_FORGE_AUTH_TOKEN || '';
const ALLOW_REMOTE = process.env.CREW_FORGE_ALLOW_REMOTE === '1' && !!AUTH_TOKEN_ENV;
const ALLOW_SENSITIVE_PATHS = process.env.CREW_FORGE_ALLOW_SENSITIVE_PATHS === '1';
const HOST = !isLoopbackHost(REQUESTED_HOST) && !ALLOW_REMOTE ? '127.0.0.1' : REQUESTED_HOST;
const HOST_IS_REMOTE = !isLoopbackHost(HOST);
const HOME = path.resolve(os.homedir());
const SESSION_COOKIE = 'crewforge_session';
const SESSION_TOKEN = AUTH_TOKEN_ENV || cryptoRandomToken();
const SESSION_MAX_AGE = 60 * 60 * 24; // 1 day
const CSRF_TOKEN = cryptoRandomToken();
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "frame-src 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
  ].join('; '),
};

for (const [provider, envName] of Object.entries(KEY_ENV)) {
  const value = keys.get(provider);
  if (value) process.env[envName] = value;
}

const send = (res, code, headers, payload) => {
  res.writeHead(code, { ...SECURITY_HEADERS, ...headers });
  res.end(payload);
};
const json = (res, code, obj) => {
  send(
    res,
    code,
    { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    JSON.stringify(obj)
  );
};
const reject = (res, code, message) => json(res, code, { error: message });
function cryptoRandomToken() {
  return crypto.randomBytes(24).toString('base64url');
}
function safeTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}
function hasSessionCookie(req) {
  return safeTokenEqual(parseCookies(req.headers.cookie)[SESSION_COOKIE], SESSION_TOKEN);
}
function hasRequestToken(req, url) {
  if (!AUTH_TOKEN_ENV) return false;
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const headerToken = req.headers['x-crewforge-token'];
  const queryToken = url && url.searchParams.get('token');
  return [bearer && bearer[1], headerToken, queryToken].some((token) =>
    safeTokenEqual(token, AUTH_TOKEN_ENV)
  );
}
function sessionCookieHeader() {
  let h = `${SESSION_COOKIE}=${encodeURIComponent(SESSION_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`;
  if (HOST_IS_REMOTE) h += '; Secure'; // remote deployments must be served over TLS
  return h;
}
// Redact absolute filesystem paths from error text before returning to the client,
// so host directory structure isn't disclosed. Preserves the rest of the message.
function safeErrMsg(e) {
  let m = String((e && (e.stderr || e.message)) || e || 'error');
  if (HOME) m = m.split(HOME).join('~');
  m = m.replace(/(?:\/(?:Users|home)\/[^\s'":]+)/g, '<path>');
  return m.length > 400 ? m.slice(0, 400) + '…' : m;
}
// Cookie-authenticated mutating requests must echo the CSRF token served in the page.
// Token-authenticated (Bearer/header/query) clients are not cookie-based, so exempt.
function passesCsrf(req, url) {
  if (hasRequestToken(req, url)) return true;
  return safeTokenEqual(req.headers['x-csrf-token'], CSRF_TOKEN);
}
const isJsonRequest = (req) => {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  return contentType.startsWith('application/json');
};
const hasTrustedFetchMetadata = (req) => {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return !site || site === 'same-origin' || site === 'none';
};
const body = (req, res, options = {}) =>
  new Promise((r) => {
    const maxBytes = options.maxBytes || MAX_BODY_BYTES;
    let b = '';
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        send(
          res,
          413,
          {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            Connection: 'close',
          },
          JSON.stringify({ error: 'payload too large' })
        );
        req.destroy();
        r(null);
        return;
      }
      b += c;
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        r(JSON.parse(b || '{}'));
      } catch {
        r({});
      }
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      r({});
    });
  });
const execFileP = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });

function hostPart(host) {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return '';
  }
}

function isLoopbackHost(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

function isAllowedLocalRequest(req, pathname) {
  const needsCheck =
    pathname.startsWith('/api/') ||
    req.method === 'POST' ||
    req.method === 'DELETE' ||
    (req.method === 'GET' && pathname === '/api/stream');
  if (!needsCheck) return true;
  if (!hasTrustedFetchMetadata(req)) return false;
  const host = hostPart(req.headers.host || '');
  if (!HOST_IS_REMOTE && !isLoopbackHost(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    if (HOST_IS_REMOTE) return new URL(origin).host === (req.headers.host || '');
    const allowed = new Set([
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${PORT}`,
      `http://[::1]:${PORT}`,
    ]);
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function isAllowedApiSession(req, pathname, url) {
  if (!pathname.startsWith('/api/')) return true;
  return hasSessionCookie(req) || hasRequestToken(req, url);
}

function invalidId(res, name) {
  return json(res, 400, { error: `invalid ${name}` });
}

function validId(res, name, value) {
  if (store.isValidId(value)) return true;
  invalidId(res, name);
  return false;
}
const WORKTREE_ID_RE = /^[a-zA-Z0-9_-]+$/;
function validWorktreeId(res, value) {
  const id = String(value || '').trim();
  if (id && WORKTREE_ID_RE.test(id)) return id;
  invalidId(res, 'worktreeId');
  return null;
}
function workspaceForApi(res, wsId) {
  if (!validId(res, 'ws', wsId)) return null;
  const wsObj = store.getWorkspace(wsId);
  if (!wsObj) {
    json(res, 400, { error: 'unknown workspace' });
    return null;
  }
  return wsObj;
}

function runKey(ws, sid) {
  return `${ws}/${sid}`;
}

function startRun(ws, sid) {
  const key = runKey(ws, sid);
  if (activeRuns.has(key)) return null;
  const controller = new AbortController();
  const timer =
    RUN_TIMEOUT_MS > 0
      ? setTimeout(() => {
          if (controller.signal.aborted) return;
          store.append(ws, sid, {
            kind: 'system',
            actor: 'system',
            type: 'status',
            text: `Run exceeded ${Math.round(RUN_TIMEOUT_MS / 60000)} minutes and was stopped automatically`,
            meta: { done: true, timedOut: true },
          });
          controller.abort();
        }, RUN_TIMEOUT_MS)
      : null;
  activeRuns.set(key, { controller, timer });
  return { key, controller };
}

function finishRun(key, controller) {
  const run = activeRuns.get(key);
  if (run && run.controller === controller) {
    if (run.timer) clearTimeout(run.timer);
    activeRuns.delete(key);
  }
}

// Build a compact transcript preamble so stateless CLI calls keep context.
async function buildContext(wsId, sid, newPrompt, options = {}) {
  const mode = contextSaver.normalizeMode(options.contextMode || 'balanced');
  const result = await contextSaver.buildSavedContext(store.readEvents(wsId, sid), newPrompt, {
    mode,
    model: options.model,
    provider: options.provider,
  });
  if (result.provider && result.tokensSaved > 0) {
    store.append(wsId, sid, {
      kind: 'system',
      actor: 'context',
      type: 'usage',
      text: `${result.provider} context saver kept about ${result.tokensSaved} tokens out of this request`,
      meta: {
        provider: result.provider,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        tokensSaved: result.tokensSaved,
        contextMode: mode,
      },
    });
  }
  return result.prompt;
}

function resumePendingContinuation({ ws, sid, wsObj, pendingEvent }) {
  const continuation = continuationFromPending(pendingEvent);
  if (!continuation) {
    if (pendingEvent && pendingEvent.type === 'pending-integration') {
      store.append(ws, sid, {
        kind: 'system',
        actor: 'team',
        type: 'continuation-failed',
        text: 'Changes were integrated, but the remaining team plan could not be resumed',
        meta: { done: true, failed: true },
      });
      return { resumed: false, continuationFailed: true };
    }
    return { resumed: false };
  }

  if (!continuation.remainingSteps.length) {
    store.append(ws, sid, {
      kind: 'system',
      actor: 'team',
      type: 'status',
      text: 'Team delegation finished',
      meta: { done: true },
    });
    return { resumed: false, complete: true };
  }

  const team = continuation.team;
  try {
    if (!team.members.length) throw new Error('stored team has no members');
    for (const member of team.members) {
      if (!adapters.adapters[member.adapter]) {
        throw new Error(`stored team references unknown adapter: ${member.adapter}`);
      }
    }
    orchestrator.validateSteps(continuation.remainingSteps, team.members.length);
  } catch (error) {
    store.append(ws, sid, {
      kind: 'system',
      actor: 'team',
      type: 'continuation-failed',
      text: `Changes were integrated, but continuation validation failed: ${safeErrMsg(error)}`,
      meta: { done: true, failed: true },
    });
    return { resumed: false, continuationFailed: true };
  }

  const run = startRun(ws, sid);
  if (!run) {
    store.append(ws, sid, {
      kind: 'system',
      actor: 'team',
      type: 'continuation-failed',
      text: 'Changes were integrated, but another run is already active',
      meta: { done: true, failed: true },
    });
    return { resumed: false, continuationFailed: true };
  }

  store.append(ws, sid, {
    kind: 'system',
    actor: 'team',
    type: 'status',
    text: `Resuming team delegation at step ${continuation.nextStepOffset + 1}/${continuation.totalSteps}`,
    meta: { running: true, resumed: true, step: continuation.nextStepOffset + 1 },
  });
  const resumeProject = taskTracker.findProjectForSession(ws, sid);
  orchestrator
    .runApproved({
      adapters,
      buildContext,
      store,
      team,
      steps: continuation.remainingSteps,
      approvalMode: continuation.approvalMode,
      ws,
      sid,
      cwd: wsObj.path,
      signal: run.controller.signal,
      stepOffset: continuation.nextStepOffset,
      totalSteps: continuation.totalSteps,
      tracking: taskTracker.buildOrchestratorTracking(resumeProject && resumeProject.id),
    })
    .catch((error) => {
      if (run.controller.signal.aborted) return;
      store.append(ws, sid, {
        kind: 'system',
        actor: 'team',
        type: 'error',
        text: safeErrMsg(error),
      });
    })
    .finally(() => finishRun(run.key, run.controller));
  return { resumed: true };
}

async function commandExists(bin) {
  try {
    await execFileP('/bin/sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8', timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function commandVersion(bin) {
  try {
    return String(await execFileP(bin, ['--version'], { encoding: 'utf8', timeout: 2000 })).trim();
  } catch {
    try {
      return String(await execFileP(bin, ['version'], { encoding: 'utf8', timeout: 2000 })).trim();
    } catch {
      return '';
    }
  }
}

async function pickNativeFolder() {
  if (process.platform !== 'darwin') {
    const err = new Error('native folder picker is only available on macOS');
    err.code = 'UNSUPPORTED_PLATFORM';
    throw err;
  }
  const script = [
    'set selectedFolder to choose folder with prompt "Choose a Crew Forge workspace"',
    'POSIX path of selectedFolder',
  ].join('\n');
  return String(await execFileP('osascript', ['-e', script], { encoding: 'utf8' })).trim();
}

function parseVersion(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map((part) => Number(part)) : null;
}

function versionAtLeast(actual, minimum) {
  const a = parseVersion(actual);
  const m = parseVersion(minimum);
  if (!a || !m) return false;
  for (let i = 0; i < m.length; i++) {
    if (a[i] > m[i]) return true;
    if (a[i] < m[i]) return false;
  }
  return true;
}

function isInsidePath(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function sensitivePathReason(absPath, options = {}) {
  if (ALLOW_SENSITIVE_PATHS) return '';
  let real;
  try {
    real = fs.realpathSync(absPath);
  } catch {
    real = path.resolve(absPath);
  }
  if (real === path.parse(real).root) return 'the filesystem root';
  if (real === HOME && !options.allowHomeRoot) return 'your home folder root';
  if (!isInsidePath(real, HOME)) return 'outside your home folder';
  const rel = path.relative(HOME, real);
  const parts = rel.split(path.sep).filter(Boolean);
  const sensitiveNames = new Set([
    '.ssh',
    '.aws',
    '.azure',
    '.config',
    '.docker',
    '.gnupg',
    '.kube',
    '.npmrc',
    '.pypirc',
    '.netrc',
  ]);
  const sensitive = parts.find((part) => sensitiveNames.has(part));
  return sensitive ? `inside ${sensitive}` : '';
}

function assertSafePath(absPath, options = {}) {
  const reason = sensitivePathReason(absPath, options);
  if (!reason) return;
  throw new Error(
    `Refusing ${absPath}: ${reason}. Set CREW_FORGE_ALLOW_SENSITIVE_PATHS=1 only if you understand the risk.`
  );
}

function isGitRepoPath(absPath) {
  return fs.existsSync(path.join(absPath, '.git'));
}

function looksBinary(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  return sample.includes(0);
}

async function providerHealth() {
  return Promise.all(
    adapters.catalog().map(async (a) => {
      let ready = false;
      let hint = '';
      let version = '';
      if (a.kind === 'cli') {
        const bin = CLI_BINS[a.id] || a.id;
        ready = await commandExists(bin);
        if (ready) {
          version = await commandVersion(bin);
          const minimum = CLI_MIN_VERSION[a.id];
          if (minimum && !versionAtLeast(version, minimum)) {
            ready = false;
            hint = `${a.label} CLI ${minimum}+ required; found ${version || 'unknown version'}`;
          }
        }
        if (!ready)
          hint =
            hint || `Install the ${a.label} CLI, then run: ${CLI_LOGIN[a.id] || `${a.id} login`}`;
      } else if (a.kind === 'api' && a.id === 'gemini') {
        ready = !!(process.env.GEMINI_API_KEY || keys.get('gemini'));
        if (!ready) hint = 'Add a Gemini API key in Connections';
      } else {
        hint = 'Configure this provider';
      }
      return { id: a.id, label: a.label, kind: a.kind, ready, hint, version };
    })
  );
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (!isAllowedLocalRequest(req, p)) return reject(res, 403, 'forbidden origin');
  if (!isAllowedApiSession(req, p, u)) return reject(res, 401, 'missing app session');
  if (req.method === 'POST' && !isJsonRequest(req)) return reject(res, 415, 'expected JSON body');
  if (
    (req.method === 'POST' || req.method === 'DELETE') &&
    p.startsWith('/api/') &&
    !passesCsrf(req, u)
  )
    return reject(res, 403, 'missing or invalid CSRF token');

  try {
    if (req.method === 'GET' && p === '/') {
      if (AUTH_TOKEN_ENV && !hasSessionCookie(req) && !hasRequestToken(req, u))
        return reject(res, 401, 'missing app token');
      const html = fs
        .readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
        .replace('<title>', `<meta name="csrf-token" content="${CSRF_TOKEN}" />\n<title>`);
      return send(
        res,
        200,
        { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': sessionCookieHeader() },
        html
      );
    }
    if (req.method === 'GET' && STATIC_ASSETS[p]) {
      const asset = STATIC_ASSETS[p];
      return send(
        res,
        200,
        { 'Content-Type': asset.contentType, 'Cache-Control': 'no-cache' },
        fs.readFileSync(asset.file)
      );
    }
    if (req.method === 'GET' && p === '/api/catalog') return json(res, 200, adapters.catalog());
    if (req.method === 'GET' && p === '/api/catalog/refresh')
      return json(res, 200, await modelDiscovery.refreshCatalog(adapters.catalog()));
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, await providerHealth());
    if (req.method === 'GET' && p === '/api/context-saver')
      return json(res, 200, await contextSaver.status());
    if (req.method === 'GET' && p === '/api/profile') return json(res, 200, store.getProfile());
    if (req.method === 'POST' && p === '/api/profile') {
      const data = await body(req, res);
      if (!data) return;
      return json(res, 200, store.saveProfileSettings(data.settings || {}));
    }
    if (req.method === 'GET' && p === '/api/profile/export') {
      const filename = `crewforge-profile-${new Date().toISOString().slice(0, 10)}.json`;
      return send(
        res,
        200,
        {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
        JSON.stringify(store.exportProfile(), null, 2)
      );
    }
    if (req.method === 'POST' && p === '/api/profile/import') {
      const data = await body(req, res, { maxBytes: MAX_PROFILE_IMPORT_BYTES });
      if (!data) return;
      try {
        return json(
          res,
          200,
          store.importProfile(data.profile || data, {
            workspaceAllowed: (workspacePath) => !sensitivePathReason(workspacePath),
          })
        );
      } catch (e) {
        return json(res, 400, { error: safeErrMsg(e) });
      }
    }

    if (req.method === 'GET' && p === '/ONBOARDING.md') {
      return send(
        res,
        200,
        { 'Content-Type': 'text/markdown; charset=utf-8' },
        fs.readFileSync(path.join(ROOT, 'ONBOARDING.md'))
      );
    }

    if (req.method === 'GET' && p === '/api/keys') return json(res, 200, keys.list());
    if (req.method === 'POST' && p === '/api/keys') {
      const data = await body(req, res);
      if (!data) return;
      const { provider, key } = data;
      const id = String(provider || '')
        .trim()
        .toLowerCase();
      const envName = KEY_ENV[id];
      if (!envName) return json(res, 400, { error: 'unknown provider' });
      try {
        const masked = keys.set(id, key);
        process.env[envName] = keys.get(id);
        return json(res, 200, { provider: id, set: true, masked });
      } catch (e) {
        return json(res, 400, { error: safeErrMsg(e) });
      }
    }
    if (req.method === 'DELETE' && p === '/api/keys') {
      const id = String(u.searchParams.get('provider') || '')
        .trim()
        .toLowerCase();
      const envName = KEY_ENV[id];
      if (!envName) return json(res, 400, { error: 'unknown provider' });
      keys.remove(id);
      delete process.env[envName];
      return json(res, 200, { provider: id, set: false, masked: null });
    }

    if (req.method === 'GET' && p === '/api/fs') {
      const dir = u.searchParams.get('path') || os.homedir();
      const includeFiles = u.searchParams.get('includeFiles') === '1';
      const abs = path.resolve(dir);
      try {
        assertSafePath(abs, { allowHomeRoot: true });
        const FS_CAP = 300;
        const rawEntries = fs.readdirSync(abs, { withFileTypes: true });
        const entries = rawEntries
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => ({ name: d.name, path: path.join(abs, d.name) }))
          .filter((entry) => !sensitivePathReason(entry.path))
          .sort((a, b) => a.name.localeCompare(b.name));
        const allFiles = includeFiles
          ? rawEntries
              .filter((d) => d.isFile() && !d.name.startsWith('.'))
              .map((d) => ({ name: d.name, path: path.join(abs, d.name) }))
              .filter((entry) => !sensitivePathReason(entry.path))
              .sort((a, b) => a.name.localeCompare(b.name))
          : [];
        const total = entries.length + allFiles.length;
        const truncated = total > FS_CAP;
        const cappedDirs = truncated ? entries.slice(0, Math.min(entries.length, FS_CAP)) : entries;
        const files = truncated
          ? allFiles.slice(0, Math.max(0, FS_CAP - cappedDirs.length))
          : allFiles;
        const isRepo = fs.existsSync(path.join(abs, '.git'));
        const parent = abs === HOME ? null : path.dirname(abs);
        return json(res, 200, {
          path: abs,
          parent,
          isRepo,
          dirs: cappedDirs,
          files,
          truncated,
          total,
        });
      } catch (e) {
        return json(res, 400, {
          error: safeErrMsg(e),
          path: abs,
          parent: HOME,
          isRepo: false,
          dirs: [],
          files: [],
        });
      }
    }

    if (req.method === 'GET' && p === '/api/file') {
      const ws = u.searchParams.get('ws');
      const requested = u.searchParams.get('path');
      if (!validId(res, 'ws', ws)) return;
      if (!requested) return json(res, 400, { error: 'path required' });
      const wsObj = store.getWorkspace(ws);
      if (!wsObj) return json(res, 400, { error: 'unknown workspace' });
      const candidate = path.resolve(requested);
      try {
        const root = fs.realpathSync(path.resolve(wsObj.path));
        if (!isInsidePath(candidate, path.resolve(wsObj.path))) {
          return json(res, 400, { error: 'file is outside workspace' });
        }
        const abs = fs.realpathSync(candidate);
        if (!isInsidePath(abs, root)) {
          return json(res, 400, { error: 'file is outside workspace' });
        }
        assertSafePath(abs, { allowHomeRoot: true });
        const stat = fs.statSync(abs);
        if (!stat.isFile()) return json(res, 400, { error: 'path is not a file' });
        if (stat.size > MAX_FILE_PREVIEW_BYTES) {
          return json(res, 413, {
            error: `file is too large to preview (${Math.ceil(stat.size / 1024)} KB)`,
            path: abs,
            size: stat.size,
          });
        }
        const buf = fs.readFileSync(abs);
        if (looksBinary(buf)) {
          return json(res, 415, {
            error: 'binary files cannot be previewed',
            path: abs,
            size: stat.size,
          });
        }
        return json(res, 200, {
          path: abs,
          name: path.basename(abs),
          relativePath: path.relative(root, abs).replace(/\\/g, '/'),
          size: stat.size,
          content: buf.toString('utf8'),
        });
      } catch (e) {
        return json(res, 400, { error: safeErrMsg(e), path: candidate });
      }
    }

    if (req.method === 'POST' && p === '/api/fs/pick-folder') {
      let picked = '';
      try {
        picked = await pickNativeFolder();
      } catch (e) {
        const message = String((e && (e.stderr || e.message)) || e);
        if (/user canceled/i.test(message)) return json(res, 200, { cancelled: true });
        return json(res, e && e.code === 'UNSUPPORTED_PLATFORM' ? 501 : 400, {
          error: message.trim() || 'Unable to choose folder',
          fallback: true,
        });
      }
      try {
        assertSafePath(path.resolve(picked));
        return json(res, 200, { path: picked, isRepo: isGitRepoPath(picked) });
      } catch (e) {
        return json(res, 400, { error: safeErrMsg(e) });
      }
    }

    if (req.method === 'GET' && p === '/api/workspaces')
      return json(res, 200, store.listWorkspaces());
    if (req.method === 'POST' && p === '/api/workspaces') {
      const data = await body(req, res);
      if (!data) return;
      const { path: wp } = data;
      if (!wp) return json(res, 400, { error: 'path required' });
      try {
        assertSafePath(path.resolve(wp));
        return json(res, 200, store.addWorkspace(wp));
      } catch (e) {
        return json(res, 400, { error: safeErrMsg(e) });
      }
    }
    if (req.method === 'DELETE' && p === '/api/workspaces') {
      const id = u.searchParams.get('id');
      if (!validId(res, 'workspace', id)) return;
      if (!store.removeWorkspace(id)) return json(res, 404, { error: 'workspace not found' });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/sessions') {
      const ws = u.searchParams.get('ws');
      if (!validId(res, 'ws', ws)) return;
      return json(res, 200, store.listSessions(ws));
    }
    if (req.method === 'GET' && p === '/api/sessions/export') {
      const ws = u.searchParams.get('ws');
      const sid = u.searchParams.get('sid');
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      if (!store.getWorkspace(ws)) return json(res, 400, { error: 'unknown workspace' });
      if (!store.listSessions(ws).some((session) => session.id === sid)) {
        return json(res, 404, { error: 'session not found' });
      }
      const csv = store.exportSessionCsv(ws, sid);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="crewforge-session-${sid}.csv"`,
        'Content-Length': Buffer.byteLength(csv),
        'Cache-Control': 'no-store',
      });
      return res.end(csv);
    }
    if (req.method === 'POST' && p === '/api/sessions') {
      const data = await body(req, res);
      if (!data) return;
      const { ws } = data;
      if (!validId(res, 'ws', ws)) return;
      return json(res, 200, { id: store.createSession(ws) });
    }

    if (req.method === 'GET' && p === '/api/changes') {
      const ws = u.searchParams.get('ws');
      if (!validId(res, 'ws', ws)) return;
      const wsObj = store.getWorkspace(ws);
      if (!wsObj) return json(res, 400, { error: 'unknown workspace' });
      try {
        return json(res, 200, watcher.getChanges(wsObj.path));
      } catch {
        return json(res, 200, { files: [], stat: '', notRepo: true });
      }
    }

    if (req.method === 'GET' && p === '/api/diff') {
      const ws = u.searchParams.get('ws');
      if (!validId(res, 'ws', ws)) return;
      const wsObj = store.getWorkspace(ws);
      if (!wsObj) return json(res, 400, { error: 'unknown workspace' });
      try {
        const diff = await execFileP('git', ['-C', wsObj.path, 'diff'], {
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024,
        });
        return json(res, 200, { diff });
      } catch {
        return json(res, 200, { diff: '', notRepo: true });
      }
    }

    if (req.method === 'GET' && p === '/api/worktree/pending') {
      const ws = u.searchParams.get('ws');
      const worktreeId = validWorktreeId(res, u.searchParams.get('worktreeId'));
      if (!worktreeId) return;
      const wsObj = workspaceForApi(res, ws);
      if (!wsObj) return;
      if (!isGitRepoPath(wsObj.path))
        return json(res, 400, { error: 'workspace is not a git repository' });
      try {
        const info = worktree.inspect(wsObj.path, worktreeId);
        return json(res, 200, info);
      } catch (e) {
        return json(res, 400, { error: safeErrMsg(e) });
      }
    }

    if (req.method === 'POST' && p === '/api/worktree/integrate') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid } = data;
      const worktreeId = validWorktreeId(res, data.worktreeId);
      if (!worktreeId) return;
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      const wsObj = workspaceForApi(res, ws);
      if (!wsObj) return;
      if (!isGitRepoPath(wsObj.path))
        return json(res, 400, { error: 'workspace is not a git repository' });

      const pendingEvent = findUnresolvedPending(store.readEvents(ws, sid), worktreeId);
      if (!pendingEvent) {
        return json(res, 409, {
          error: 'worktree is not pending in this session',
          status: 'not-pending',
        });
      }

      let inspectInfo;
      try {
        inspectInfo = worktree.inspect(wsObj.path, worktreeId);
      } catch (e) {
        return json(res, 400, { error: safeErrMsg(e), status: 'invalid-worktree' });
      }

      try {
        worktree.apply(wsObj.path, worktreeId);
        store.append(ws, sid, {
          kind: 'system',
          actor: 'user',
          type: 'integrated',
          text: `Integrated team step changes (${worktreeId})`,
          meta: {
            worktreeId,
            branch: inspectInfo.branch,
            diffSummary: inspectInfo.diffSummary,
          },
        });
        const trackProject = taskTracker.findProjectForWorktree(ws, sid, worktreeId);
        if (trackProject) taskTracker.onIntegrated(trackProject.id, worktreeId);
        const continuation = resumePendingContinuation({ ws, sid, wsObj, pendingEvent });
        return json(res, 200, { status: 'integrated', worktreeId, ...continuation });
      } catch (e) {
        const detail = safeErrMsg(e);
        const clientMessage = 'Integration failed';
        const trackProject = taskTracker.findProjectForWorktree(ws, sid, worktreeId);
        if (trackProject) taskTracker.onIntegrationFailed(trackProject.id, worktreeId, detail);
        store.append(ws, sid, {
          kind: 'system',
          actor: 'user',
          type: 'integration-failed',
          text: `Integration failed for ${worktreeId}`,
          meta: {
            worktreeId,
            branch: inspectInfo.branch,
            diffSummary: inspectInfo.diffSummary,
            error: detail,
          },
        });
        return json(res, 409, {
          status: 'integration-failed',
          worktreeId,
          error: clientMessage,
        });
      }
    }

    if (req.method === 'POST' && p === '/api/worktree/reject') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid } = data;
      const worktreeId = validWorktreeId(res, data.worktreeId);
      if (!worktreeId) return;
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      const wsObj = workspaceForApi(res, ws);
      if (!wsObj) return;
      if (!isGitRepoPath(wsObj.path))
        return json(res, 400, { error: 'workspace is not a git repository' });

      const pendingEvent = findUnresolvedPending(store.readEvents(ws, sid), worktreeId);
      if (!pendingEvent) {
        return json(res, 409, {
          error: 'worktree is not pending in this session',
          status: 'not-pending',
        });
      }

      try {
        worktree.reject(wsObj.path, worktreeId);
        const trackProject = taskTracker.findProjectForWorktree(ws, sid, worktreeId);
        if (trackProject) {
          taskTracker.onRejected(trackProject.id, worktreeId, {
            reason: data.reason,
            asChangesRequested: data.asChangesRequested === true,
          });
        }
        store.append(ws, sid, {
          kind: 'system',
          actor: 'user',
          type: 'rejected',
          text: `Rejected pending worktree ${worktreeId}`,
          meta: { worktreeId, rejected: true },
        });
        return json(res, 200, { status: 'rejected', worktreeId });
      } catch (e) {
        return json(res, 400, { error: safeErrMsg(e) });
      }
    }

    if (req.method === 'POST' && p === '/api/stop') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid } = data;
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      const wsObj = store.getWorkspace(ws);
      if (!wsObj) return json(res, 400, { error: 'unknown workspace' });
      const run = activeRuns.get(runKey(ws, sid));
      if (run && !run.controller.signal.aborted) run.controller.abort();
      store.append(ws, sid, {
        kind: 'system',
        actor: 'system',
        type: 'status',
        text: 'Run stopped by user',
        meta: { done: true },
      });
      const trackProject = taskTracker.findProjectForSession(ws, sid);
      if (trackProject) {
        const active = tasks
          .listTasks(trackProject.id)
          .find((task) => task.status === 'in_progress' || task.status === 'running');
        if (active && active.planStepIndex !== null) {
          taskTracker.onRunAborted(trackProject.id, active.planStepIndex, {
            displayStep: active.planStepIndex + 1,
            worktreeId: active.worktreeId,
            partial: !!active.worktreeId,
          });
        }
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/review') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid, reviewer, reviewerModel, contextMode, contextProvider } = data;
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      const wsObj = store.getWorkspace(ws);
      if (!wsObj) return json(res, 400, { error: 'unknown workspace' });
      if (!adapters.adapters[reviewer]) return json(res, 400, { error: 'unknown reviewer' });
      if (!sid) return json(res, 400, { error: 'sid required' });

      let diff = '';
      try {
        diff = await execFileP('git', ['-C', wsObj.path, 'diff'], {
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024,
        });
      } catch (e) {
        return json(res, 400, { error: safeErrMsg(e) });
      }

      const changes = watcher.getChanges(wsObj.path);
      const fileCount = (changes.files || []).length;
      const prompt = withWorkspaceInstruction(buildReviewPrompt(diff), wsObj.path, 'plan');
      const fullPrompt = await buildContext(ws, sid, prompt, {
        contextMode,
        provider: contextProvider,
        model: reviewerModel,
      });
      const run = startRun(ws, sid);
      if (!run) return json(res, 409, { error: 'run already active for this session' });

      store.append(ws, sid, {
        kind: 'system',
        actor: reviewer,
        type: 'status',
        text: `${reviewer} reviewing ${fileCount} changed file${fileCount === 1 ? '' : 's'}…`,
        meta: { running: true },
      });

      adapters
        .run(
          reviewer,
          {
            prompt: fullPrompt,
            model: reviewerModel,
            cwd: wsObj.path,
            mode: 'plan',
            signal: run.controller.signal,
          },
          guardedEmitter(wsObj.path, 'plan', (e) =>
            store.append(ws, sid, {
              kind: 'agent',
              actor: reviewer,
              model: reviewerModel,
              role: 'reviewer',
              type: e.type,
              text: e.text,
              meta: e.meta,
            })
          )
        )
        .then((result) => {
          finishDirectRun(store, ws, sid, reviewer, {
            aborted: run.controller.signal.aborted,
            result,
          });
        })
        .catch((err) => {
          finishDirectRun(store, ws, sid, reviewer, {
            aborted: run.controller.signal.aborted,
            thrown: err,
          });
        })
        .finally(() => finishRun(run.key, run.controller));

      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/stream') {
      const ws = u.searchParams.get('ws');
      const sid = u.searchParams.get('sid');
      const off = Number(u.searchParams.get('off') || 0);
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      const unsub = store.subscribe(ws, sid, res, off);
      req.on('close', unsub);
      return;
    }

    if (req.method === 'GET' && p === '/api/usage') {
      return json(
        res,
        200,
        usage.aggregate(
          path.join(ROOT, 'data', 'sessions'),
          adapters.catalog().map((adapter) => adapter.id)
        )
      );
    }

    if (req.method === 'GET' && p === '/api/teams') return json(res, 200, teams.listTeams());
    if (req.method === 'GET' && p === '/api/skills') return json(res, 200, skills.list());
    if (req.method === 'POST' && p === '/api/skills') {
      const data = await body(req, res);
      if (!data) return;
      try {
        return json(res, 200, skills.save(data.skill));
      } catch (err) {
        return json(res, 400, { error: err.message || 'invalid skill' });
      }
    }
    if (req.method === 'DELETE' && p === '/api/skills') {
      const id = u.searchParams.get('id');
      try {
        const deleted = skills.deleteCustom(id);
        return json(res, deleted ? 200 : 404, { ok: deleted });
      } catch (err) {
        return json(res, 400, { error: err.message || 'invalid skill id' });
      }
    }
    if (req.method === 'POST' && p === '/api/teams') {
      const data = await body(req, res);
      if (!data) return;
      const { team } = data;
      if (!team || !team.name) return json(res, 400, { error: 'team.name required' });
      for (const m of team.members || []) {
        if (!adapters.adapters[m.adapter])
          return json(res, 400, { error: `unknown adapter: ${m.adapter}` });
        if (m.skillId && !skills.get(m.skillId))
          return json(res, 400, { error: `unknown skill: ${m.skillId}` });
      }
      const lead = Number(team.leadIndex);
      if (
        team.members &&
        team.members.length &&
        (!Number.isInteger(lead) || lead < 0 || lead >= team.members.length)
      ) {
        return json(res, 400, { error: 'invalid leadIndex' });
      }
      return json(res, 200, teams.saveTeam(team));
    }
    if (req.method === 'DELETE' && p === '/api/teams') {
      const id = u.searchParams.get('id');
      if (!id) return json(res, 400, { error: 'id required' });
      if (!teams.deleteTeam(id)) return json(res, 404, { error: 'not found' });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/projects') {
      const ws = u.searchParams.get('ws');
      const sid = u.searchParams.get('sid');
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      if (!store.getWorkspace(ws)) return json(res, 400, { error: 'unknown workspace' });
      return json(res, 200, { projects: taskTracker.listProjectsForSession(ws, sid) });
    }

    if (req.method === 'GET' && p === '/api/projects/detail') {
      const ws = u.searchParams.get('ws');
      const sid = u.searchParams.get('sid');
      const projectId = u.searchParams.get('projectId');
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      if (!validId(res, 'projectId', projectId)) return;
      const project = tasks.getProject(projectId);
      if (!project || !tasks.projectOwnedBy(project, ws, sid))
        return json(res, 404, { error: 'project not found' });
      const view = taskTracker.projectView(projectId);
      return json(res, 200, view);
    }

    if (req.method === 'GET' && p === '/api/tasks/detail') {
      const ws = u.searchParams.get('ws');
      const sid = u.searchParams.get('sid');
      const projectId = u.searchParams.get('projectId');
      const taskId = u.searchParams.get('taskId');
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      if (!validId(res, 'projectId', projectId) || !validId(res, 'taskId', taskId)) return;
      const project = tasks.getProject(projectId);
      if (!project || !tasks.projectOwnedBy(project, ws, sid))
        return json(res, 404, { error: 'project not found' });
      const task = tasks.getTask(projectId, taskId);
      if (!task) return json(res, 404, { error: 'task not found' });
      return json(res, 200, { task: tasks.taskPublicView(task) });
    }

    if (req.method === 'POST' && p === '/api/plan') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid, teamId, prompt, contextMode, contextProvider } = data;
      const planMode = data.mode === 'plan' ? 'plan' : 'edit';
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      const wsObj = store.getWorkspace(ws);
      if (!wsObj) return json(res, 400, { error: 'unknown workspace' });
      const team = teams.getTeam(teamId);
      if (!team) return json(res, 400, { error: 'unknown team' });
      if (!sid) return json(res, 400, { error: 'sid required' });
      if (!prompt) return json(res, 400, { error: 'prompt required' });
      if (!team.members || !team.members.length)
        return json(res, 400, { error: 'team has no members' });
      const lead = team.members[team.leadIndex];
      if (!lead || !adapters.adapters[lead.adapter])
        return json(res, 400, { error: 'invalid team lead' });
      const run = startRun(ws, sid);
      if (!run) return json(res, 409, { error: 'run already active for this session' });

      store.append(ws, sid, {
        kind: 'user',
        actor: 'user',
        type: 'message',
        text: prompt,
        meta: { final: true },
      });
      try {
        const steps = await orchestrator.runPlan({
          adapters,
          buildContext,
          store,
          team: { ...team, contextMode, contextProvider },
          prompt,
          ws,
          sid,
          cwd: wsObj.path,
          signal: run.controller.signal,
        });
        if (run.controller.signal.aborted) return json(res, 200, { cancelled: true, steps: [] });
        const tracked = taskTracker.createProjectFromPlan({
          ws,
          sid,
          team: { ...team, contextMode, contextProvider },
          prompt,
          steps,
          approvalMode: planMode,
        });
        store.append(ws, sid, {
          kind: 'system',
          actor: 'team',
          type: 'task-project',
          text: 'Task tracker project created for team plan',
          meta: { projectId: tracked.project.id },
        });
        return json(res, 200, { steps, projectId: tracked.project.id });
      } catch (e) {
        if (run.controller.signal.aborted) return json(res, 200, { cancelled: true, steps: [] });
        store.append(ws, sid, { kind: 'system', actor: 'team', type: 'error', text: String(e) });
        store.append(ws, sid, {
          kind: 'system',
          actor: 'team',
          type: 'status',
          text: 'Team delegation planning failed',
          meta: { done: true, failed: true },
        });
        return json(res, 500, { error: safeErrMsg(e) });
      } finally {
        finishRun(run.key, run.controller);
      }
    }

    if (req.method === 'POST' && p === '/api/approve') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid, teamId, steps, contextMode, contextProvider, projectId } = data;
      const mode = data.mode === 'plan' ? 'plan' : 'edit';
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      const wsObj = store.getWorkspace(ws);
      if (!wsObj) return json(res, 400, { error: 'unknown workspace' });
      const team = teams.getTeam(teamId);
      if (!team) return json(res, 400, { error: 'unknown team' });
      if (!sid) return json(res, 400, { error: 'sid required' });
      if (!team.members || !team.members.length)
        return json(res, 400, { error: 'team has no members' });
      if (projectId && !validId(res, 'projectId', projectId)) return;
      const requestedProject = projectId ? tasks.getProject(projectId) : null;
      if (
        projectId &&
        (!requestedProject ||
          !tasks.projectOwnedBy(requestedProject, ws, sid) ||
          requestedProject.teamId !== teamId ||
          requestedProject.status !== 'planning')
      ) {
        return json(res, 400, { error: 'task project does not match this plan' });
      }
      for (const m of team.members) {
        if (!adapters.adapters[m.adapter])
          return json(res, 400, { error: `unknown adapter: ${m.adapter}` });
      }
      try {
        const plan = orchestrator.validateSteps(steps, team.members.length);
        if (requestedProject) {
          taskTracker.validateAndSyncApprovedPlan(requestedProject.id, team, plan);
        }
        const needsGit =
          mode === 'edit' &&
          plan.some((step) => {
            const member = team.members[step.memberIndex];
            const adapter = member && adapters.adapters[member.adapter];
            return adapter && adapter.canEdit;
          });
        if (needsGit && !isGitRepoPath(wsObj.path)) {
          return json(res, 400, {
            error:
              'Running edit-capable team members requires a git workspace. Team planning works without git; initialize git or assign approved steps to text-only members.',
          });
        }
      } catch (e) {
        return json(res, 400, { error: safeErrMsg(e) });
      }
      const run = startRun(ws, sid);
      if (!run) return json(res, 409, { error: 'run already active for this session' });

      const trackProject = requestedProject || taskTracker.findProjectForSession(ws, sid);
      if (trackProject) taskTracker.onPlanApproved(trackProject.id);

      orchestrator
        .runApproved({
          adapters,
          buildContext,
          store,
          team: { ...team, contextMode, contextProvider },
          steps,
          approvalMode: mode,
          ws,
          sid,
          cwd: wsObj.path,
          signal: run.controller.signal,
          tracking: taskTracker.buildOrchestratorTracking(trackProject && trackProject.id),
        })
        .catch((err) => {
          if (run.controller.signal.aborted) return;
          store.append(ws, sid, {
            kind: 'system',
            actor: 'team',
            type: 'error',
            text: String(err),
          });
          store.append(ws, sid, {
            kind: 'system',
            actor: 'team',
            type: 'status',
            text: 'Team delegation run failed',
            meta: { done: true, failed: true },
          });
        })
        .finally(() => finishRun(run.key, run.controller));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/run') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid, adapter, model, mode, prompt, role, contextMode, contextProvider } = data;
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      const wsObj = store.getWorkspace(ws);
      if (!wsObj) return json(res, 400, { error: 'unknown workspace' });
      if (!adapters.adapters[adapter]) return json(res, 400, { error: 'unknown adapter' });
      const allowedEfforts = adapters.effortLevels(adapter, model);
      const effort = normalizeEffort(data.effort, allowedEfforts);
      if (data.effort && String(data.effort).toLowerCase() !== 'default' && !effort) {
        return json(res, 400, {
          error: `unsupported effort for ${adapter}${model ? ' ' + model : ''}: ${data.effort}`,
        });
      }
      if (mode === 'edit' && !isGitRepoPath(wsObj.path))
        return json(res, 400, { error: 'Edit mode requires a git workspace' });
      const run = startRun(ws, sid);
      if (!run) return json(res, 409, { error: 'run already active for this session' });

      store.append(ws, sid, {
        kind: 'user',
        actor: 'user',
        type: 'message',
        text: prompt,
        meta: { final: true },
      });
      store.append(ws, sid, {
        kind: 'system',
        actor: adapter,
        type: 'status',
        text: `${adapter}${model ? ' · ' + model : ''}${effort ? ' · ' + effort : ''} (${mode || 'plan'}) running…`,
        meta: { running: true },
      });

      const fullPrompt = await buildContext(ws, sid, prompt, {
        contextMode,
        provider: contextProvider,
        model,
      });
      adapters
        .run(
          adapter,
          {
            prompt: fullPrompt,
            model,
            effort,
            cwd: wsObj.path,
            mode: mode || 'plan',
            signal: run.controller.signal,
          },
          guardedEmitter(wsObj.path, mode || 'plan', (e) =>
            store.append(ws, sid, {
              kind: 'agent',
              actor: adapter,
              model,
              role: role || 'agent',
              type: e.type,
              text: e.text,
              meta: e.meta,
            })
          )
        )
        .then((result) => {
          finishDirectRun(store, ws, sid, adapter, {
            aborted: run.controller.signal.aborted,
            result,
          });
        })
        .catch((err) => {
          finishDirectRun(store, ws, sid, adapter, {
            aborted: run.controller.signal.aborted,
            thrown: err,
          });
        })
        .finally(() => finishRun(run.key, run.controller));

      return json(res, 200, { ok: true });
    }

    // ---------- dev server process management ----------
    if (p === '/api/dev/start' && req.method === 'POST') {
      const data = await body(req, res);
      if (!data) return;
      const { ws: wsId, cmd } = data;
      if (!wsId || !store.isValidId(wsId)) return json(res, 400, { error: 'invalid ws' });
      if (!cmd || typeof cmd !== 'string' || !cmd.trim())
        return json(res, 400, { error: 'cmd required' });
      const wsObj = store.listWorkspaces().find((w) => w.id === wsId);
      if (!wsObj) return json(res, 404, { error: 'unknown workspace' });
      let info;
      try {
        info = startDevProc(wsId, wsObj.path, cmd.trim());
      } catch (e) {
        if (e && e.userSafe) return json(res, 400, { error: e.message });
        throw e;
      }
      return json(res, 200, { ok: true, pid: info.pid });
    }

    if (p === '/api/dev/stop' && req.method === 'POST') {
      const data = await body(req, res);
      if (!data) return;
      const { ws: wsId } = data;
      if (!wsId || !store.isValidId(wsId)) return json(res, 400, { error: 'invalid ws' });
      stopDevProc(wsId);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/dev/status' && req.method === 'GET') {
      const wsId = u.searchParams.get('ws');
      if (!wsId || !store.isValidId(wsId)) return json(res, 400, { error: 'invalid ws' });
      const info = devProcs.get(wsId);
      return json(res, 200, {
        running: !!info,
        cmd: info ? info.cmd : null,
        pid: info ? info.pid : null,
      });
    }

    if (p === '/api/dev/stream' && req.method === 'GET') {
      const wsId = u.searchParams.get('ws');
      if (!wsId || !store.isValidId(wsId)) return json(res, 400, { error: 'invalid ws' });
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (ev) => {
        try {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        } catch {}
      };
      const info = devProcs.get(wsId);
      if (info) {
        for (const ev of info.output) send(ev);
        info.listeners.add(send);
      }
      req.on('close', () => {
        const i = devProcs.get(wsId);
        if (i) i.listeners.delete(send);
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: safeErrMsg(e) });
  }
});

server.listen(PORT, HOST, () => {
  if (
    !HOST_IS_REMOTE &&
    !isLoopbackHost(REQUESTED_HOST) &&
    process.env.CREW_FORGE_ALLOW_REMOTE === '1'
  ) {
    console.warn(
      [
        '',
        'WARNING: Remote binding was requested but CREW_FORGE_AUTH_TOKEN is not set.',
        'Crew Forge fell back to local-only binding.',
        '',
      ].join('\n')
    );
  }
  if (HOST_IS_REMOTE) {
    console.warn(
      [
        '',
        'WARNING: Crew Forge is listening on a non-loopback host.',
        'This exposes a filesystem-browsing and code-execution surface to the network.',
        'Only do this on a trusted network, with trusted users, CREW_FORGE_ALLOW_REMOTE=1, and CREW_FORGE_AUTH_TOKEN set.',
        '',
      ].join('\n')
    );
  }
  console.log(
    `\n  Crew Forge -> http://${HOST}:${PORT}  (${HOST_IS_REMOTE ? 'remote access enabled' : 'local only'})\n`
  );
});
