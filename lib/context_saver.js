'use strict';

const { compact, buildTurns } = require('./compactor');

// keepRecent: turns kept verbatim. maxChars: hard cap on the full preamble.
// Coding sessions routinely produce 2-4 KB per turn (plans, diffs, explanations).
// The original 4200-char balanced cap fell below a single large agent message — raised 4×.
const MODES = {
  off: { keepRecent: 40, maxChars: 100000, headroom: false },
  balanced: { keepRecent: 12, maxChars: 16000, headroom: true },
  maximum: { keepRecent: 6, maxChars: 8000, headroom: true },
};

function normalizeMode(mode) {
  return Object.prototype.hasOwnProperty.call(MODES, mode) ? mode : 'balanced';
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function headroomInstalled() {
  try {
    require.resolve('headroom-ai');
    return true;
  } catch {
    return false;
  }
}

function status() {
  const configured = !!(process.env.HEADROOM_BASE_URL || process.env.HEADROOM_API_KEY);
  const installed = headroomInstalled();
  return {
    builtIn: true,
    headroomInstalled: installed,
    headroomConfigured: configured,
    headroomActive: installed && configured,
    modeDefault: 'balanced',
  };
}

function toMessages(events, newPrompt) {
  const turns = buildTurns(events);
  const messages = turns.map((turn) => {
    if (turn.startsWith('User: ')) return { role: 'user', content: turn.slice(6) };
    return { role: 'assistant', content: turn };
  });
  messages.push({ role: 'user', content: newPrompt });
  return messages;
}

function messagesToPrompt(messages) {
  return messages
    .map((m) => {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
      return `${role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
    })
    .join('\n');
}

async function tryHeadroom(events, newPrompt, opts) {
  if (!opts.headroom || (!process.env.HEADROOM_BASE_URL && !process.env.HEADROOM_API_KEY))
    return null;
  let headroom;
  try {
    headroom = require('headroom-ai');
  } catch {
    return null;
  }
  if (!headroom || typeof headroom.compress !== 'function') return null;

  const messages = toMessages(events, newPrompt);
  const headroomOptions = {
    tokenBudget: Math.max(1000, opts.maxChars / 4),
    fallback: true,
    timeout: 8000,
  };
  if (opts.model) headroomOptions.model = opts.model;
  const result = await headroom.compress(messages, headroomOptions);
  const compressedMessages = Array.isArray(result && result.messages) ? result.messages : messages;
  const prompt = messagesToPrompt(compressedMessages);
  return {
    prompt,
    provider: 'headroom',
    beforeTokens: result.tokensBefore || estimateTokens(messagesToPrompt(messages)),
    afterTokens: result.tokensAfter || estimateTokens(prompt),
    tokensSaved:
      result.tokensSaved ||
      Math.max(0, estimateTokens(messagesToPrompt(messages)) - estimateTokens(prompt)),
  };
}

async function buildSavedContext(events, newPrompt, options = {}) {
  const mode = normalizeMode(options.mode);
  const cfg = MODES[mode];
  if (mode === 'off') {
    const transcript = compact(events, { keepRecent: cfg.keepRecent, maxChars: cfg.maxChars });
    return { prompt: transcript ? `${transcript}\n\nNow respond to:\n${newPrompt}` : newPrompt };
  }

  try {
    const hr = await tryHeadroom(events, newPrompt, { ...cfg, model: options.model });
    if (hr && hr.prompt) return hr;
  } catch {
    // Fall back silently; provider runs should not fail because compression is unavailable.
  }

  const transcript = compact(events, { keepRecent: cfg.keepRecent, maxChars: cfg.maxChars });
  const prompt = transcript ? `${transcript}\n\nNow respond to:\n${newPrompt}` : newPrompt;
  // Baseline: full history under off-mode limits, to measure real savings.
  const offCfg = MODES.off;
  const baseline = compact(events, { keepRecent: offCfg.keepRecent, maxChars: offCfg.maxChars });
  const baselinePrompt = baseline ? `${baseline}\n\nNow respond to:\n${newPrompt}` : newPrompt;
  return {
    prompt,
    provider: 'built-in',
    beforeTokens: estimateTokens(baselinePrompt),
    afterTokens: estimateTokens(prompt),
    tokensSaved: Math.max(0, estimateTokens(baselinePrompt) - estimateTokens(prompt)),
  };
}

module.exports = { buildSavedContext, normalizeMode, estimateTokens, status };
