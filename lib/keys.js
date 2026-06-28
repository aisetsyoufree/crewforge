'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
// Only providers with a working adapter are offered for BYOK.
const KNOWN_PROVIDERS = ['gemini'];

let cache = readKeys();

function normalize(provider) {
  return String(provider || '')
    .trim()
    .toLowerCase();
}

function readKeys() {
  try {
    const raw = fs.readFileSync(KEYS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const keys = {};
    for (const [provider, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value) keys[normalize(provider)] = value;
    }
    return keys;
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    return {};
  }
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${KEYS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, KEYS_FILE);
  fs.chmodSync(KEYS_FILE, 0o600);
}

function mask(value) {
  if (!value) return null;
  return `****${String(value).slice(-4)}`;
}

function get(provider) {
  return cache[normalize(provider)] || null;
}

function set(provider, value) {
  const id = normalize(provider);
  const key = String(value || '').trim();
  if (!id) throw new Error('provider required');
  if (!key) throw new Error('key required');
  cache[id] = key;
  persist();
  return mask(key);
}

function remove(provider) {
  const id = normalize(provider);
  if (!id) return;
  if (Object.prototype.hasOwnProperty.call(cache, id)) {
    delete cache[id];
    persist();
  }
}

function list() {
  const providers = Array.from(new Set([...KNOWN_PROVIDERS, ...Object.keys(cache)])).sort();
  return providers.map((provider) => {
    const value = cache[provider] || null;
    return { provider, set: !!value, masked: mask(value) };
  });
}

module.exports = { get, set, remove, list };
