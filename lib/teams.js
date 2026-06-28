'use strict';

/*
 * P4 teams layer: named groups of model seats with roles and a lead.
 *
 * On-disk: data/teams.json — array of { id, name, members, leadIndex }
 *   members: [{ adapter, model, role }]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, '..', 'data');
const TEAMS_FILE = path.join(DATA, 'teams.json');
fs.mkdirSync(DATA, { recursive: true });

const readJSON = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const writeJSON = (f, data) => fs.writeFileSync(f, JSON.stringify(data, null, 2));

function listTeams() {
  return readJSON(TEAMS_FILE, []);
}

function getTeam(id) {
  return listTeams().find((t) => t.id === id) || null;
}

const isValidId = (x) => typeof x === 'string' && /^[A-Za-z0-9._-]+$/.test(x) && !x.includes('..');

function saveTeam(team) {
  const list = listTeams();
  // Reject malformed client-supplied ids; mint a safe one when absent.
  if (team.id && !isValidId(team.id)) throw new Error('invalid team id');
  if (!team.id) team = { ...team, id: crypto.randomBytes(6).toString('hex') };
  const idx = list.findIndex((t) => t.id === team.id);
  const entry = {
    id: team.id,
    name: String(team.name || 'Untitled team'),
    members: Array.isArray(team.members) ? team.members : [],
    leadIndex: Number.isInteger(team.leadIndex) ? team.leadIndex : 0,
  };
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry);
  writeJSON(TEAMS_FILE, list);
  return entry;
}

function deleteTeam(id) {
  const list = listTeams();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  writeJSON(TEAMS_FILE, next);
  return true;
}

module.exports = { listTeams, saveTeam, getTeam, deleteTeam };
