'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function execFileText(bin, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error ? error.message : '',
        });
      }
    );
  });
}

function cleanText(value) {
  return (
    String(value || '')
      .replace(ANSI_RE, '')
      .replace(/\[[0-9;?]*[A-Za-z]\]?/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .trim()
  );
}

function unique(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

async function discoverCodex() {
  const result = await execFileText('codex', ['debug', 'models'], 8000);
  if (!result.ok)
    return { models: [], modelEffortLevels: {}, source: 'error', error: result.error };
  try {
    const parsed = JSON.parse(result.stdout);
    const visible = Array.isArray(parsed.models)
      ? parsed.models.filter((model) => model && model.slug && model.visibility !== 'hidden')
      : [];
    const modelEffortLevels = {};
    for (const model of visible) {
      const efforts = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.map((level) => level && level.effort).filter(Boolean)
        : [];
      if (efforts.length) modelEffortLevels[model.slug] = unique(efforts);
    }
    return {
      models: unique(visible.map((model) => model.slug)),
      modelEffortLevels,
      source: 'codex debug models',
    };
  } catch (e) {
    return { models: [], modelEffortLevels: {}, source: 'error', error: e.message };
  }
}

async function discoverGrok() {
  const result = await execFileText('grok', ['models'], 8000);
  if (!result.ok) return { models: [], source: 'error', error: result.error || result.stderr };
  const models = [];
  let defaultModel = '';
  for (const line of result.stdout.split('\n')) {
    const defaultMatch = line.match(/Default model:\s*(\S+)/);
    if (defaultMatch) defaultModel = cleanText(defaultMatch[1]);
    const listMatch = line.match(/^\s*[-*]\s+(\S+)/);
    if (listMatch) models.push(listMatch[1]);
  }
  return { models: unique(models), defaultModel, source: 'grok models' };
}

async function discoverAntigravity() {
  const result =
    process.platform === 'darwin'
      ? await execFileText('/bin/sh', ['-lc', 'script -q /dev/null agy models </dev/null'], 15000)
      : await execFileText('agy', ['models'], 15000);
  if (!result.ok) return { models: [], source: 'error', error: result.error || result.stderr };
  const models = unique(
    result.stdout
      .split(/[\r\n]+/)
      .map(cleanText)
      .filter(
        (line) =>
          line &&
          !/^available models:?$/i.test(line) &&
          !/fetching available models/i.test(line) &&
          !/^\^D/.test(line)
      )
  );
  const preferred = 'Gemini 3.1 Pro (High)';
  return {
    models,
    defaultModel: models.includes(preferred) ? preferred : models[0] || '',
    source: process.platform === 'darwin' ? 'agy models (PTY)' : 'agy models',
  };
}

async function discoverClaude() {
  const models = ['sonnet', 'opus', 'haiku'];
  let defaultModel = '';
  try {
    const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (settings && settings.model) {
      defaultModel = cleanText(settings.model);
      models.unshift(defaultModel);
    }
  } catch {}

  const help = await execFileText('claude', ['--help'], 5000);
  if (help.ok) {
    const aliases = help.stdout.match(/'[^']+'/g) || [];
    for (const quoted of aliases) {
      const value = quoted.slice(1, -1);
      if (/^(sonnet|opus|haiku|fable)$/i.test(value)) models.push(value.toLowerCase());
    }
  }

  return {
    models: unique(models),
    defaultModel: defaultModel || 'sonnet',
    source: defaultModel ? 'claude settings + help' : 'claude help',
  };
}

function mergeAdapter(adapter, discovery) {
  if (!discovery || !discovery.models || !discovery.models.length) {
    return {
      ...adapter,
      modelSource: 'configured',
      modelRefreshError: discovery && discovery.error ? discovery.error : null,
    };
  }
  const models = unique([...discovery.models, ...(adapter.models || [])]);
  const defaultModel =
    discovery.defaultModel && models.includes(discovery.defaultModel)
      ? discovery.defaultModel
      : models.includes(adapter.defaultModel)
        ? adapter.defaultModel
        : models[0];
  return {
    ...adapter,
    defaultModel,
    models,
    modelEffortLevels: Object.keys(discovery.modelEffortLevels || {}).length
      ? discovery.modelEffortLevels
      : adapter.modelEffortLevels || null,
    modelSource: discovery.source || 'detected',
    modelRefreshError: null,
  };
}

async function refreshCatalog(catalog) {
  const discoveries = await Promise.all([
    discoverClaude(),
    discoverCodex(),
    discoverGrok(),
    discoverAntigravity(),
  ]);
  const byId = {
    claude: discoveries[0],
    codex: discoveries[1],
    grok: discoveries[2],
    antigravity: discoveries[3],
  };
  return catalog.map((adapter) => mergeAdapter(adapter, byId[adapter.id]));
}

module.exports = {
  discoverClaude,
  discoverCodex,
  discoverGrok,
  discoverAntigravity,
  refreshCatalog,
};
