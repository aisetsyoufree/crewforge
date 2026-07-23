'use strict';

/*
 * P4 teams layer: named groups of model seats with roles and a lead.
 *
 * On-disk: data/teams.json — array of { id, name, members, leadIndex }
 *   members: [{ adapter, model, role, skillId }]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = require('./data_dir');
const TEAMS_FILE = path.join(DATA, 'teams.json');

function ensurePrivateDataDir() {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(DATA, 0o700);
  } catch {}
}

ensurePrivateDataDir();

const readJSON = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const writeJSON = (f, data) => {
  ensurePrivateDataDir();
  fs.writeFileSync(f, JSON.stringify(data, null, 2), { mode: 0o600 });
};

/**
 * Synchronous per-file mutate lock for teams.json.
 * Re-entrant nested mutators share one in-memory list and one final write.
 */
let teamsMutation = null; // { list, depth } | null

function mutateTeamsFile(mutator) {
  if (teamsMutation) {
    teamsMutation.depth += 1;
    try {
      return mutator(teamsMutation.list);
    } finally {
      teamsMutation.depth -= 1;
    }
  }
  const list = listTeams();
  // Work on a mutable array reference; writers replace contents in place or reassign via splice.
  teamsMutation = { list, depth: 1 };
  try {
    const result = mutator(list);
    writeJSON(TEAMS_FILE, list);
    return result;
  } finally {
    teamsMutation = null;
  }
}

function listTeams() {
  if (teamsMutation) return teamsMutation.list;
  return readJSON(TEAMS_FILE, []);
}

function getTeam(id) {
  return listTeams().find((t) => t.id === id) || null;
}

const isValidId = (x) => typeof x === 'string' && /^[A-Za-z0-9._-]+$/.test(x) && !x.includes('..');

function saveTeam(team) {
  return mutateTeamsFile((list) => {
    // Reject malformed client-supplied ids; mint a safe one when absent.
    if (team.id && !isValidId(team.id)) throw new Error('invalid team id');
    if (!team.id) team = { ...team, id: crypto.randomBytes(6).toString('hex') };
    const idx = list.findIndex((t) => t.id === team.id);
    // autoRepair default OFF for beta safety; repairIterations default 2, hard cap 5.
    let repairIterations = 2;
    if (team.repairIterations != null && team.repairIterations !== '') {
      const n = Number(team.repairIterations);
      if (Number.isInteger(n) && n >= 0 && n <= 5) repairIterations = n;
    }
    const entry = {
      id: team.id,
      name: String(team.name || 'Untitled team'),
      members: Array.isArray(team.members) ? team.members : [],
      leadIndex: Number.isInteger(team.leadIndex) ? team.leadIndex : 0,
      autoRepair:
        team.autoRepair === true ||
        team.autoRepair === 'true' ||
        team.autoRepair === 1 ||
        team.autoRepair === '1' ||
        team.autoRepair === 'on',
      repairIterations,
    };
    if (idx >= 0) list[idx] = entry;
    else list.unshift(entry);
    return entry;
  });
}

function deleteTeam(id) {
  return mutateTeamsFile((list) => {
    const before = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].id === id) list.splice(i, 1);
    }
    return list.length !== before;
  });
}

module.exports = { listTeams, saveTeam, getTeam, deleteTeam, mutateTeamsFile };
