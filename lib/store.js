'use strict';

/*
 * P2 state layer: workspaces + per-workspace sessions (persistent history) +
 * an in-process hub that streams live adapter events to SSE clients.
 *
 * On-disk layout (all under data/):
 *   workspaces.json                      list of { id, path, name, addedAt }
 *   sessions/<workspaceId>/<sid>.jsonl   one session = JSONL of envelope events
 *
 * Envelope event (superset of the adapter's normalized event):
 *   { ts, seq, kind, actor, role, model, type, text, meta }
 *   kind: 'user' | 'agent' | 'system'
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, '..', 'data');
const SESS_DIR = path.join(DATA, 'sessions');
const WS_FILE = path.join(DATA, 'workspaces.json');
fs.mkdirSync(SESS_DIR, { recursive: true });

const id = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);
const readJSON = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const writeJSON = (f, data) => fs.writeFileSync(f, JSON.stringify(data, null, 2));
const isValidId = (x) => typeof x === 'string' && /^[A-Za-z0-9._-]+$/.test(x) && !x.includes('..');

function assertValidSessionIds(wsId, sid) {
  if (!isValidId(wsId) || !isValidId(sid)) throw new Error('invalid session id');
}

// ---------- workspaces ----------
function listWorkspaces() {
  return readJSON(WS_FILE, []);
}

function addWorkspace(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory())
    throw new Error('not a directory: ' + abs);
  const list = listWorkspaces();
  let ws = list.find((w) => w.path === abs);
  if (!ws) {
    ws = { id: id(abs), path: abs, name: path.basename(abs), addedAt: Date.now() };
    list.unshift(ws);
    writeJSON(WS_FILE, list);
    fs.mkdirSync(path.join(SESS_DIR, ws.id), { recursive: true });
  }
  return ws;
}

function removeWorkspace(wsId) {
  if (!isValidId(wsId)) return false;
  const list = listWorkspaces();
  const next = list.filter((w) => w.id !== wsId);
  if (next.length === list.length) return false;
  writeJSON(WS_FILE, next);
  return true;
}

function getWorkspace(wsId) {
  if (!isValidId(wsId)) return null;
  return listWorkspaces().find((w) => w.id === wsId);
}

// ---------- sessions ----------
function sessionFile(wsId, sid) {
  assertValidSessionIds(wsId, sid);
  return path.join(SESS_DIR, wsId, `${sid}.jsonl`);
}

function listSessions(wsId) {
  if (!isValidId(wsId)) return [];
  const dir = path.join(SESS_DIR, wsId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const sid = f.replace(/\.jsonl$/, '');
      if (!isValidId(sid)) return null;
      const events = readEvents(wsId, sid);
      const firstUser = events.find((e) => e.kind === 'user');
      return {
        id: sid,
        title: firstUser && firstUser.text ? firstUser.text.slice(0, 60) : 'New session',
        count: events.length,
        mtime: fs.statSync(sessionFile(wsId, sid)).mtimeMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

function createSession(wsId) {
  if (!isValidId(wsId)) throw new Error('invalid workspace id');
  const sid = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;
  fs.mkdirSync(path.join(SESS_DIR, wsId), { recursive: true });
  fs.writeFileSync(sessionFile(wsId, sid), '');
  return sid;
}

function readEvents(wsId, sid) {
  if (!isValidId(wsId) || !isValidId(sid)) return [];
  const f = sessionFile(wsId, sid);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------- live hub (in-process pub/sub for SSE) ----------
const hub = new Map(); // key `${wsId}/${sid}` -> { seq, clients:Set<res> }

function chan(wsId, sid) {
  assertValidSessionIds(wsId, sid);
  const k = `${wsId}/${sid}`;
  if (!hub.has(k)) hub.set(k, { seq: readEvents(wsId, sid).length, clients: new Set() });
  return hub.get(k);
}

function append(wsId, sid, evt) {
  assertValidSessionIds(wsId, sid);
  const c = chan(wsId, sid);
  const env = { ts: Date.now(), seq: c.seq++, ...evt };
  fs.appendFileSync(sessionFile(wsId, sid), JSON.stringify(env) + '\n');
  for (const res of c.clients) {
    try {
      res.write(`data: ${JSON.stringify(env)}\n\n`);
    } catch {}
  }
  return env;
}

function subscribe(wsId, sid, res, fromSeq) {
  if (!isValidId(wsId) || !isValidId(sid)) return () => {};
  const c = chan(wsId, sid);
  // replay history first
  for (const e of readEvents(wsId, sid)) {
    if (e.seq >= (fromSeq || 0)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  c.clients.add(res);
  return () => c.clients.delete(res);
}

module.exports = {
  isValidId,
  listWorkspaces,
  addWorkspace,
  removeWorkspace,
  getWorkspace,
  listSessions,
  createSession,
  readEvents,
  append,
  subscribe,
};
