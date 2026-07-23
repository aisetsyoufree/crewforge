'use strict';

/*
 * Provider readiness: local CLI presence, conservative minimum-version gates,
 * and optional auth probes where the CLI exposes a non-interactive check.
 *
 * Keep CLI_MIN_VERSION easy to bump. Unknown/unparseable versions are NOT
 * treated as incompatible — they surface a clear diagnostic instead.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

/** Conservative floors based on versions exercised with Crew Forge. Bump carefully. */
const CLI_MIN_VERSION = {
  claude: '2.1.187',
  codex: '0.142.5',
  grok: '0.2.72',
  antigravity: '1.1.1',
};

const CLI_BINS = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
  antigravity: 'agy',
};

const CLI_LOGIN = {
  claude: 'claude login',
  codex: 'codex login',
  grok: 'grok login --device-auth',
  antigravity: 'Sign in with the Antigravity app, then run: agy models',
};

const STATUS = {
  READY: 'ready',
  MISSING_CLI: 'missing_cli',
  VERSION_TOO_OLD: 'version_too_old',
  VERSION_UNKNOWN: 'version_unknown',
  AUTH_NOT_CONFIRMED: 'auth_not_confirmed',
  NEEDS_KEY: 'needs_key',
  NOT_CONFIGURED: 'not_configured',
};

function parseVersion(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map((part) => Number(part)) : null;
}

function compareVersions(aParts, bParts) {
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const a = aParts[i] || 0;
    const b = bParts[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/** True only when both sides parse as semver triples and actual >= minimum. */
function versionAtLeast(actual, minimum) {
  const a = parseVersion(actual);
  const m = parseVersion(minimum);
  if (!a || !m) return false;
  return compareVersions(a, m) >= 0;
}

/**
 * Classify installed version against a minimum.
 * @returns {{ ok: boolean, status: string, hint: string }}
 *   ok=true means "do not treat as version-incompatible".
 */
function classifyVersion(actual, minimum, label) {
  if (!minimum) return { ok: true, status: STATUS.READY, hint: '' };
  const a = parseVersion(actual);
  const m = parseVersion(minimum);
  if (!m) return { ok: true, status: STATUS.READY, hint: '' };
  if (!a) {
    const shown = String(actual || '').trim() || 'empty output';
    return {
      ok: true,
      status: STATUS.VERSION_UNKNOWN,
      hint: `Could not parse ${label} CLI version (${shown}); minimum ${minimum}+ recommended. Not marking incompatible.`,
    };
  }
  if (compareVersions(a, m) < 0) {
    return {
      ok: false,
      status: STATUS.VERSION_TOO_OLD,
      hint: `${label} CLI ${minimum}+ required; found ${a.join('.')}`,
    };
  }
  return { ok: true, status: STATUS.READY, hint: '' };
}

async function commandExists(bin, exec = execFileP) {
  try {
    await exec('/bin/sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8', timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function commandVersion(bin, exec = execFileP) {
  try {
    const out = await exec(bin, ['--version'], { encoding: 'utf8', timeout: 2000 });
    return String(out.stdout != null ? out.stdout : out).trim();
  } catch {
    try {
      const out = await exec(bin, ['version'], { encoding: 'utf8', timeout: 2000 });
      return String(out.stdout != null ? out.stdout : out).trim();
    } catch {
      return '';
    }
  }
}

/**
 * Best-effort non-interactive auth probe. Returns:
 *   true  — logged in
 *   false — clearly not logged in
 *   null  — unknown / not probeable
 */
async function probeAuth(providerId, bin, exec = execFileP) {
  if (providerId === 'claude') {
    try {
      const out = await exec(bin, ['auth', 'status'], {
        encoding: 'utf8',
        timeout: 2500,
        maxBuffer: 64 * 1024,
      });
      const text = String(out.stdout != null ? out.stdout : out).trim();
      try {
        const json = JSON.parse(text);
        if (typeof json.loggedIn === 'boolean') return json.loggedIn;
      } catch {
        // fall through to text heuristics
      }
      if (/\blogged\s*in\b/i.test(text) && !/\bnot\s+logged\s*in\b/i.test(text)) return true;
      if (/\bnot\s+logged\s*in\b|\blogged\s*out\b/i.test(text)) return false;
      return null;
    } catch {
      return null;
    }
  }
  if (providerId === 'codex') {
    try {
      const out = await exec(bin, ['login', 'status'], {
        encoding: 'utf8',
        timeout: 2500,
        maxBuffer: 64 * 1024,
      });
      const text = String(out.stdout != null ? out.stdout : out.stderr || out).trim();
      if (/logged\s+in/i.test(text) && !/not\s+logged\s+in/i.test(text)) return true;
      if (/not\s+logged\s+in|logged\s+out|no\s+credentials/i.test(text)) return false;
      return null;
    } catch (err) {
      const combined = `${err && err.stdout ? err.stdout : ''}\n${err && err.stderr ? err.stderr : ''}`;
      if (/logged\s+in/i.test(combined) && !/not\s+logged\s+in/i.test(combined)) return true;
      if (/not\s+logged\s+in|logged\s+out|no\s+credentials/i.test(combined)) return false;
      return null;
    }
  }
  return null;
}

function statusLabel(status) {
  switch (status) {
    case STATUS.READY:
      return 'Ready';
    case STATUS.MISSING_CLI:
      return 'CLI missing';
    case STATUS.VERSION_TOO_OLD:
      return 'Version too old';
    case STATUS.VERSION_UNKNOWN:
      return 'Version unknown';
    case STATUS.AUTH_NOT_CONFIRMED:
      return 'Login not confirmed';
    case STATUS.NEEDS_KEY:
      return 'API key needed';
    case STATUS.NOT_CONFIGURED:
      return 'Needs setup';
    default:
      return 'Needs setup';
  }
}

/**
 * Build one health row for a catalog adapter entry.
 * @param {object} adapter catalog entry { id, label, kind }
 * @param {object} options
 */
async function checkProvider(adapter, options = {}) {
  const exec = options.exec || execFileP;
  const hasKey =
    typeof options.hasApiKey === 'function'
      ? options.hasApiKey
      : (id) =>
          !!(process.env[`${String(id).toUpperCase()}_API_KEY`] || process.env.GEMINI_API_KEY);
  const minVersions = options.minVersions || CLI_MIN_VERSION;
  const bins = options.bins || CLI_BINS;
  const loginHints = options.loginHints || CLI_LOGIN;

  const base = {
    id: adapter.id,
    label: adapter.label,
    kind: adapter.kind,
    ready: false,
    status: STATUS.NOT_CONFIGURED,
    statusLabel: statusLabel(STATUS.NOT_CONFIGURED),
    hint: '',
    version: '',
    minimumVersion: minVersions[adapter.id] || '',
    auth: null,
  };

  if (adapter.kind === 'cli') {
    const bin = bins[adapter.id] || adapter.id;
    const present = await commandExists(bin, exec);
    if (!present) {
      return {
        ...base,
        status: STATUS.MISSING_CLI,
        statusLabel: statusLabel(STATUS.MISSING_CLI),
        hint: `Install the ${adapter.label} CLI, then run: ${loginHints[adapter.id] || `${adapter.id} login`}`,
      };
    }

    const version = await commandVersion(bin, exec);
    const gate = classifyVersion(version, minVersions[adapter.id], adapter.label);
    if (!gate.ok) {
      return {
        ...base,
        version,
        ready: false,
        status: gate.status,
        statusLabel: statusLabel(gate.status),
        hint: gate.hint,
      };
    }

    const auth = await probeAuth(adapter.id, bin, exec);
    if (auth === false) {
      return {
        ...base,
        version,
        ready: false,
        status: STATUS.AUTH_NOT_CONFIRMED,
        statusLabel: statusLabel(STATUS.AUTH_NOT_CONFIRMED),
        hint: `Sign in to ${adapter.label}: ${loginHints[adapter.id] || `${adapter.id} login`}`,
        auth: false,
      };
    }

    const status = gate.status === STATUS.VERSION_UNKNOWN ? STATUS.VERSION_UNKNOWN : STATUS.READY;
    return {
      ...base,
      version,
      ready: true,
      status,
      statusLabel: statusLabel(status),
      hint: gate.hint,
      auth: auth === true ? true : null,
    };
  }

  if (adapter.kind === 'api' && adapter.id === 'gemini') {
    const ready = !!hasKey('gemini');
    return {
      ...base,
      ready,
      status: ready ? STATUS.READY : STATUS.NEEDS_KEY,
      statusLabel: statusLabel(ready ? STATUS.READY : STATUS.NEEDS_KEY),
      hint: ready ? '' : 'Add a Gemini API key in Connections',
    };
  }

  return {
    ...base,
    hint: 'Configure this provider',
  };
}

async function providerHealth(catalog, options = {}) {
  const list = Array.isArray(catalog) ? catalog : [];
  return Promise.all(list.map((a) => checkProvider(a, options)));
}

module.exports = {
  CLI_MIN_VERSION,
  CLI_BINS,
  CLI_LOGIN,
  STATUS,
  parseVersion,
  compareVersions,
  versionAtLeast,
  classifyVersion,
  commandExists,
  commandVersion,
  probeAuth,
  statusLabel,
  checkProvider,
  providerHealth,
};
