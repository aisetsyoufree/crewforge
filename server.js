#!/usr/bin/env node
'use strict';

/*
 * Crew Forge server — workspace + history + live agent runs.
 *
 *   GET  /                         dashboard UI
 *   GET  /styles.css               dashboard styles
 *   GET  /app.js                   dashboard client script
 *   GET  /api/catalog              available models/adapters
 *   GET  /api/health               provider readiness checks
 *   GET  /api/fs?path=             folder browser (list subdirectories)
 *   GET  /api/workspaces           saved workspaces
 *   POST /api/workspaces {path}    add a workspace
 *   DELETE /api/workspaces?id=     forget a workspace
 *   GET  /api/sessions?ws=         sessions for a workspace
 *   POST /api/sessions {ws}        create a session
 *   GET  /api/changes?ws=          changed files for a workspace
 *   GET  /api/diff?ws=             git diff for a workspace
 *   GET  /api/stream?ws=&sid=&off= SSE live event stream (replays history)
 *   POST /api/run {ws,sid,adapter,model,mode,prompt,role}  run one agent turn
 *   POST /api/review {ws,sid,reviewer,reviewerModel}        cross-model diff review
 *   POST /api/stop {ws,sid}                                  stop an active run
 *   GET  /api/teams                  saved teams
 *   POST /api/teams {team}           create/update a team
 *   DELETE /api/teams?id=            delete a team
 *   POST /api/plan {ws,sid,teamId,prompt}       propose team steps
 *   POST /api/approve {ws,sid,teamId,steps}     run approved team steps
 *   GET  /api/usage                              observed token usage across sessions
 *   GET  /api/keys                               locally stored provider key status
 *   POST /api/keys {provider,key}                save provider API key
 *   DELETE /api/keys?provider=                   remove provider API key
 *
 * Zero dependencies. Node >= 18.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const adapters = require('./adapters');
const store = require('./lib/store');
const watcher = require('./lib/watcher');
const teams = require('./lib/teams');
const orchestrator = require('./lib/orchestrator');
const { compact } = require('./lib/compactor');
const usage = require('./lib/usage');
const { buildReviewPrompt } = require('./lib/review');
const keys = require('./lib/keys');

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
const CLI_BINS = { claude: 'claude', codex: 'codex', grok: 'grok' };
const CLI_LOGIN = {
  claude: 'claude login',
  codex: 'codex login',
  grok: 'grok login --device-auth',
};
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const activeRuns = new Map();
const REQUESTED_HOST = process.env.CREW_FORGE_HOST || process.env.MMO_HOST || '127.0.0.1';
const ALLOW_REMOTE =
  process.env.CREW_FORGE_ALLOW_REMOTE === '1' || process.env.MMO_ALLOW_REMOTE === '1';
const HOST = !isLoopbackHost(REQUESTED_HOST) && !ALLOW_REMOTE ? '127.0.0.1' : REQUESTED_HOST;
const HOST_IS_REMOTE = !isLoopbackHost(HOST);
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
const isJsonRequest = (req) => {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  return contentType.startsWith('application/json');
};
const hasTrustedFetchMetadata = (req) => {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return !site || site === 'same-origin' || site === 'none';
};
const body = (req, res) =>
  new Promise((r) => {
    let b = '';
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
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

function invalidId(res, name) {
  return json(res, 400, { error: `invalid ${name}` });
}

function validId(res, name, value) {
  if (store.isValidId(value)) return true;
  invalidId(res, name);
  return false;
}

function runKey(ws, sid) {
  return `${ws}/${sid}`;
}

function startRun(ws, sid) {
  const key = runKey(ws, sid);
  if (activeRuns.has(key)) return null;
  const controller = new AbortController();
  activeRuns.set(key, controller);
  return { key, controller };
}

function finishRun(key, controller) {
  if (activeRuns.get(key) === controller) activeRuns.delete(key);
}

// Build a compact transcript preamble so stateless CLI calls keep context.
function buildContext(wsId, sid, newPrompt) {
  const transcript = compact(store.readEvents(wsId, sid), { keepRecent: 8, maxChars: 6000 });
  if (!transcript) return newPrompt;
  return `${transcript}\n\nNow respond to:\n${newPrompt}`;
}

async function commandExists(bin) {
  try {
    await execFileP('/bin/sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8', timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function providerHealth() {
  return Promise.all(
    adapters.catalog().map(async (a) => {
      let ready = false;
      let hint = '';
      if (a.kind === 'cli') {
        ready = await commandExists(CLI_BINS[a.id] || a.id);
        if (!ready)
          hint = `Install the ${a.label} CLI, then run: ${CLI_LOGIN[a.id] || `${a.id} login`}`;
      } else if (a.kind === 'api' && a.id === 'gemini') {
        ready = !!(process.env.GEMINI_API_KEY || keys.get('gemini'));
        if (!ready) hint = 'Add a Gemini API key in Connections';
      } else {
        hint = 'Configure this provider';
      }
      return { id: a.id, label: a.label, kind: a.kind, ready, hint };
    })
  );
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (!isAllowedLocalRequest(req, p)) return reject(res, 403, 'forbidden origin');
  if (req.method === 'POST' && !isJsonRequest(req)) return reject(res, 415, 'expected JSON body');

  try {
    if (req.method === 'GET' && p === '/') {
      return send(
        res,
        200,
        { 'Content-Type': 'text/html; charset=utf-8' },
        fs.readFileSync(path.join(ROOT, 'public', 'index.html'))
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
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, await providerHealth());

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
        return json(res, 400, { error: e.message });
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
      const abs = path.resolve(dir);
      const entries = fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, path: path.join(abs, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const isRepo = fs.existsSync(path.join(abs, '.git'));
      return json(res, 200, { path: abs, parent: path.dirname(abs), isRepo, dirs: entries });
    }

    if (req.method === 'GET' && p === '/api/workspaces')
      return json(res, 200, store.listWorkspaces());
    if (req.method === 'POST' && p === '/api/workspaces') {
      const data = await body(req, res);
      if (!data) return;
      const { path: wp } = data;
      if (!wp) return json(res, 400, { error: 'path required' });
      try {
        return json(res, 200, store.addWorkspace(wp));
      } catch (e) {
        return json(res, 400, { error: e.message });
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

    if (req.method === 'POST' && p === '/api/stop') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid } = data;
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      const wsObj = store.getWorkspace(ws);
      if (!wsObj) return json(res, 400, { error: 'unknown workspace' });
      const controller = activeRuns.get(runKey(ws, sid));
      if (controller && !controller.signal.aborted) controller.abort();
      store.append(ws, sid, {
        kind: 'system',
        actor: 'system',
        type: 'status',
        text: 'Run stopped by user',
        meta: { done: true },
      });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/review') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid, reviewer, reviewerModel } = data;
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
        return json(res, 400, { error: e.message });
      }

      const changes = watcher.getChanges(wsObj.path);
      const fileCount = (changes.files || []).length;
      const prompt = buildReviewPrompt(diff);
      const fullPrompt = buildContext(ws, sid, prompt);
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
          (e) =>
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
        .then(() => {
          if (!run.controller.signal.aborted) {
            store.append(ws, sid, {
              kind: 'system',
              actor: reviewer,
              type: 'status',
              text: `${reviewer} review finished`,
              meta: { done: true },
            });
          }
        })
        .catch((err) => {
          if (!run.controller.signal.aborted)
            store.append(ws, sid, {
              kind: 'system',
              actor: reviewer,
              type: 'error',
              text: String(err),
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
      return json(res, 200, usage.aggregate(path.join(ROOT, 'data', 'sessions')));
    }

    if (req.method === 'GET' && p === '/api/teams') return json(res, 200, teams.listTeams());
    if (req.method === 'POST' && p === '/api/teams') {
      const data = await body(req, res);
      if (!data) return;
      const { team } = data;
      if (!team || !team.name) return json(res, 400, { error: 'team.name required' });
      for (const m of team.members || []) {
        if (!adapters.adapters[m.adapter])
          return json(res, 400, { error: `unknown adapter: ${m.adapter}` });
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

    if (req.method === 'POST' && p === '/api/plan') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid, teamId, prompt } = data;
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
          team,
          prompt,
          ws,
          sid,
          cwd: wsObj.path,
          signal: run.controller.signal,
        });
        if (run.controller.signal.aborted) return json(res, 200, { cancelled: true, steps: [] });
        return json(res, 200, { steps });
      } catch (e) {
        if (run.controller.signal.aborted) return json(res, 200, { cancelled: true, steps: [] });
        store.append(ws, sid, { kind: 'system', actor: 'team', type: 'error', text: String(e) });
        store.append(ws, sid, {
          kind: 'system',
          actor: 'team',
          type: 'status',
          text: 'Team delegation planning failed',
          meta: { done: true },
        });
        return json(res, 500, { error: e.message });
      } finally {
        finishRun(run.key, run.controller);
      }
    }

    if (req.method === 'POST' && p === '/api/approve') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid, teamId, steps } = data;
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      const wsObj = store.getWorkspace(ws);
      if (!wsObj) return json(res, 400, { error: 'unknown workspace' });
      const team = teams.getTeam(teamId);
      if (!team) return json(res, 400, { error: 'unknown team' });
      if (!sid) return json(res, 400, { error: 'sid required' });
      if (!team.members || !team.members.length)
        return json(res, 400, { error: 'team has no members' });
      for (const m of team.members) {
        if (!adapters.adapters[m.adapter])
          return json(res, 400, { error: `unknown adapter: ${m.adapter}` });
      }
      try {
        orchestrator.validateSteps(steps, team.members.length);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      const run = startRun(ws, sid);
      if (!run) return json(res, 409, { error: 'run already active for this session' });

      orchestrator
        .runApproved({
          adapters,
          buildContext,
          store,
          team,
          steps,
          ws,
          sid,
          cwd: wsObj.path,
          signal: run.controller.signal,
        })
        .catch((err) => {
          if (!run.controller.signal.aborted)
            store.append(ws, sid, {
              kind: 'system',
              actor: 'team',
              type: 'error',
              text: String(err),
            });
        })
        .finally(() => finishRun(run.key, run.controller));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/run') {
      const data = await body(req, res);
      if (!data) return;
      const { ws, sid, adapter, model, mode, prompt, role } = data;
      if (!validId(res, 'ws', ws) || !validId(res, 'sid', sid)) return;
      const wsObj = store.getWorkspace(ws);
      if (!wsObj) return json(res, 400, { error: 'unknown workspace' });
      if (!adapters.adapters[adapter]) return json(res, 400, { error: 'unknown adapter' });
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
        text: `${adapter}${model ? ' · ' + model : ''} (${mode || 'plan'}) running…`,
        meta: { running: true },
      });

      const fullPrompt = buildContext(ws, sid, prompt);
      adapters
        .run(
          adapter,
          {
            prompt: fullPrompt,
            model,
            cwd: wsObj.path,
            mode: mode || 'plan',
            signal: run.controller.signal,
          },
          (e) =>
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
        .then(() => {
          if (!run.controller.signal.aborted) {
            store.append(ws, sid, {
              kind: 'system',
              actor: adapter,
              type: 'status',
              text: `${adapter} finished`,
              meta: { done: true },
            });
          }
        })
        .catch((err) => {
          if (!run.controller.signal.aborted)
            store.append(ws, sid, {
              kind: 'system',
              actor: adapter,
              type: 'error',
              text: String(err),
            });
        })
        .finally(() => finishRun(run.key, run.controller));

      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  if (HOST_IS_REMOTE) {
    console.warn(
      [
        '',
        'WARNING: Crew Forge is listening on a non-loopback host.',
        'This exposes a filesystem-browsing and code-execution surface to the network.',
        'Only do this on a trusted network, with trusted users, and CREW_FORGE_ALLOW_REMOTE=1.',
        '',
      ].join('\n')
    );
  }
  console.log(
    `\n  Crew Forge -> http://${HOST}:${PORT}  (${HOST_IS_REMOTE ? 'remote access enabled' : 'local only'})\n`
  );
});
