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
const PROFILE_FILE = path.join(DATA, 'profile.json');
const TEAMS_FILE = path.join(DATA, 'teams.json');
const CUSTOM_SKILLS_FILE =
  process.env.CREW_FORGE_SKILLS_FILE || path.join(DATA, 'custom-skills.json');
const tasks = require('./tasks');
const BACKUP_VERSION = 1;
const PROFILE_VERSION = 1;
const PROFILE_SETTING_KEYS = new Set([
  'selectedWorkspaceId',
  'selectedSessionId',
  'activeTeamId',
  'sessionSort',
  'contextMode',
  'contextProvider',
  'directEffort',
  'provider',
  'model',
  'theme',
  'fontSize',
]);

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort on filesystems that do not support POSIX permissions.
  }
}

ensurePrivateDir(DATA);
ensurePrivateDir(SESS_DIR);

const id = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);
const readJSON = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const writeJSON = (f, data) => fs.writeFileSync(f, JSON.stringify(data, null, 2), { mode: 0o600 });
const isValidId = (x) => typeof x === 'string' && /^[A-Za-z0-9._-]+$/.test(x) && !x.includes('..');

function assertValidSessionIds(wsId, sid) {
  if (!isValidId(wsId) || !isValidId(sid)) throw new Error('invalid session id');
}

const hub = new Map(); // key `${wsId}/${sid}` -> { seq, clients:Set<res> }

function readArrayFile(file) {
  const value = readJSON(file, []);
  return Array.isArray(value) ? value : [];
}

function writeDataFile(file, data) {
  ensurePrivateDir(path.dirname(file));
  writeJSON(file, data);
}

function resetPrivateDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  ensurePrivateDir(dir);
}

function cleanSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!PROFILE_SETTING_KEYS.has(key)) continue;
    if (value == null) {
      out[key] = null;
      continue;
    }
    if (key === 'fontSize') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 12 && n <= 18) out[key] = n;
      continue;
    }
    const text = String(value).slice(0, 240);
    if (key.endsWith('Id') && text && !isValidId(text)) continue;
    out[key] = text;
  }
  return out;
}

function getProfile() {
  const raw = readJSON(PROFILE_FILE, null);
  const profile =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw
      : { version: PROFILE_VERSION, name: 'Local', settings: {}, updatedAt: 0 };
  return {
    version: PROFILE_VERSION,
    name: String(profile.name || 'Local'),
    settings: cleanSettings(profile.settings),
    updatedAt: Number(profile.updatedAt) || 0,
  };
}

function saveProfileSettings(patch) {
  const profile = getProfile();
  profile.settings = { ...profile.settings, ...cleanSettings(patch) };
  profile.updatedAt = Date.now();
  writeDataFile(PROFILE_FILE, profile);
  return profile;
}

function readSessionBackup() {
  const sessions = {};
  if (!fs.existsSync(SESS_DIR)) return sessions;
  for (const wsEntry of fs.readdirSync(SESS_DIR, { withFileTypes: true })) {
    if (!wsEntry.isDirectory() || !isValidId(wsEntry.name)) continue;
    const wsSessions = {};
    const dir = path.join(SESS_DIR, wsEntry.name);
    for (const sessionEntry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!sessionEntry.isFile() || !sessionEntry.name.endsWith('.jsonl')) continue;
      const sid = sessionEntry.name.replace(/\.jsonl$/, '');
      if (!isValidId(sid)) continue;
      wsSessions[sid] = fs.readFileSync(path.join(dir, sessionEntry.name), 'utf8');
    }
    sessions[wsEntry.name] = wsSessions;
  }
  return sessions;
}

function writeSessionBackup(sessions) {
  let count = 0;
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return count;
  ensurePrivateDir(SESS_DIR);
  for (const [wsId, wsSessions] of Object.entries(sessions)) {
    if (!isValidId(wsId) || !wsSessions || typeof wsSessions !== 'object') continue;
    const dir = path.join(SESS_DIR, wsId);
    ensurePrivateDir(dir);
    for (const [sid, raw] of Object.entries(wsSessions)) {
      if (!isValidId(sid)) continue;
      fs.writeFileSync(path.join(dir, `${sid}.jsonl`), String(raw || ''), { mode: 0o600 });
      count++;
    }
  }
  return count;
}

function cleanImportedTeams(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((team) => team && (!team.id || isValidId(team.id)))
    .map((team) => {
      const members = Array.isArray(team.members)
        ? team.members
            .filter((member) => member && typeof member === 'object')
            .map((member) => ({
              adapter: String(member.adapter || ''),
              model: String(member.model || ''),
              role: String(member.role || ''),
              skillId: member.skillId && isValidId(member.skillId) ? member.skillId : undefined,
              effort: String(member.effort || 'medium'),
            }))
        : [];
      return {
        id: team.id || crypto.randomBytes(6).toString('hex'),
        name: String(team.name || 'Untitled team'),
        members,
        leadIndex:
          Number.isInteger(team.leadIndex) && team.leadIndex >= 0 && team.leadIndex < members.length
            ? team.leadIndex
            : 0,
      };
    });
}

function cleanImportedCustomSkills(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((skill) => skill && isValidId(skill.id))
    .map((skill) => ({
      id: skill.id,
      name: String(skill.name || 'Untitled skill'),
      role: String(skill.role || skill.name || 'Skill'),
      instructions: String(skill.instructions || ''),
      expectedOutputs: Array.isArray(skill.expectedOutputs)
        ? skill.expectedOutputs.map((item) => String(item)).filter(Boolean)
        : [],
      preferredMode: skill.preferredMode === 'edit' ? 'edit' : 'plan',
      artifactTypes: Array.isArray(skill.artifactTypes)
        ? skill.artifactTypes.map((item) => String(item)).filter(Boolean)
        : [],
    }));
}

function exportProfile() {
  return {
    type: 'crewforge-profile',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    profile: getProfile(),
    workspaces: listWorkspaces(),
    teams: readArrayFile(TEAMS_FILE),
    customSkills: readArrayFile(CUSTOM_SKILLS_FILE),
    sessions: readSessionBackup(),
    projects: tasks.exportAllProjects(),
  };
}

function importProfile(pkg, options = {}) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg))
    throw new Error('profile package must be an object');
  if (pkg.type !== 'crewforge-profile') throw new Error('not a Crew Forge profile export');
  if (pkg.version !== BACKUP_VERSION) throw new Error('unsupported profile export version');

  const workspaces = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
        .filter((w) => w && isValidId(w.id) && typeof w.path === 'string')
        .filter((w) => {
          if (!options.workspaceAllowed) return true;
          try {
            return options.workspaceAllowed(path.resolve(w.path));
          } catch {
            return false;
          }
        })
        .map((w) => ({
          id: w.id,
          path: path.resolve(w.path),
          name: String(w.name || path.basename(w.path) || 'Workspace'),
          addedAt: Number(w.addedAt) || Date.now(),
        }))
    : [];
  writeDataFile(WS_FILE, workspaces);
  const importedTeams = cleanImportedTeams(pkg.teams);
  const importedCustomSkills = cleanImportedCustomSkills(pkg.customSkills);
  writeDataFile(TEAMS_FILE, importedTeams);
  writeDataFile(CUSTOM_SKILLS_FILE, importedCustomSkills);

  const profile = pkg.profile && typeof pkg.profile === 'object' ? pkg.profile : {};
  const importedProfile = {
    version: PROFILE_VERSION,
    name: String(profile.name || 'Local'),
    settings: cleanSettings(profile.settings),
    updatedAt: Date.now(),
  };
  writeDataFile(PROFILE_FILE, importedProfile);
  hub.clear();
  resetPrivateDir(SESS_DIR);
  const importedSessions = writeSessionBackup(pkg.sessions);
  const importedProjects = tasks.importAllProjects(pkg.projects);
  return {
    ok: true,
    workspaces: workspaces.length,
    teams: importedTeams.length,
    customSkills: importedCustomSkills.length,
    sessions: importedSessions,
    projects: importedProjects,
  };
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
    ensurePrivateDir(path.join(SESS_DIR, ws.id));
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
  ensurePrivateDir(path.join(SESS_DIR, wsId));
  fs.writeFileSync(sessionFile(wsId, sid), '', { mode: 0o600 });
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

function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Prevent exported model/user text from becoming an executable spreadsheet formula.
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function eventsToCsv(events) {
  const columns = [
    'timestamp',
    'sequence',
    'kind',
    'actor',
    'role',
    'model',
    'type',
    'text',
    'meta',
  ];
  const rows = [columns.map(csvCell).join(',')];
  for (const event of Array.isArray(events) ? events : []) {
    let meta = '';
    try {
      meta = event.meta == null ? '' : JSON.stringify(event.meta);
    } catch {
      meta = '[unserializable metadata]';
    }
    const timestamp = Number.isFinite(Number(event.ts))
      ? new Date(Number(event.ts)).toISOString()
      : '';
    rows.push(
      [
        timestamp,
        event.seq,
        event.kind,
        event.actor,
        event.role,
        event.model,
        event.type,
        event.text,
        meta,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return rows.join('\r\n') + '\r\n';
}

function exportSessionCsv(wsId, sid) {
  assertValidSessionIds(wsId, sid);
  return eventsToCsv(readEvents(wsId, sid));
}

// ---------- live hub (in-process pub/sub for SSE) ----------
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
  eventsToCsv,
  exportSessionCsv,
  append,
  subscribe,
  getProfile,
  saveProfileSettings,
  exportProfile,
  importProfile,
};
