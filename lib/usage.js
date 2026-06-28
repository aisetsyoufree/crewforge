'use strict';

/*
 * Aggregate observed token usage and rate-limit signals from session JSONL logs.
 * Providers do not expose queryable account balance — this reflects only what
 * passed through this app.
 */

const fs = require('fs');
const path = require('path');

function emptyProvider() {
  return { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, lastRateLimit: null };
}

function tokensFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return { in: 0, out: 0, cost: 0 };

  if (meta.usage && typeof meta.usage === 'object') {
    return {
      in: Number(meta.usage.input_tokens) || 0,
      out: Number(meta.usage.output_tokens) || 0,
      cost: Number(meta.cost) || 0,
    };
  }

  if ('input_tokens' in meta || 'output_tokens' in meta) {
    return {
      in: Number(meta.input_tokens) || 0,
      out: Number(meta.output_tokens) || 0,
      cost: 0,
    };
  }

  if ('promptTokenCount' in meta || 'candidatesTokenCount' in meta) {
    return {
      in: Number(meta.promptTokenCount) || 0,
      out: Number(meta.candidatesTokenCount) || 0,
      cost: 0,
    };
  }

  return { in: 0, out: 0, cost: 0 };
}

function aggregate(sessionsRoot) {
  const providers = {};
  const rateLimitTs = {};

  if (!fs.existsSync(sessionsRoot)) {
    return { providers, generatedAt: Date.now() };
  }

  let workspaces;
  try {
    workspaces = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return { providers, generatedAt: Date.now() };
  }

  for (const wsDir of workspaces) {
    if (!wsDir.isDirectory()) continue;
    const wsPath = path.join(sessionsRoot, wsDir.name);
    let files;
    try {
      files = fs.readdirSync(wsPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(path.join(wsPath, file), 'utf8');
      } catch {
        continue;
      }

      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }

        if (ev.kind !== 'agent') continue;
        const actor = ev.actor;
        if (!actor) continue;

        if (ev.type === 'usage') {
          if (!providers[actor]) providers[actor] = emptyProvider();
          const p = providers[actor];
          p.calls += 1;
          const { in: tin, out: tout, cost } = tokensFromMeta(ev.meta);
          p.tokensIn += tin;
          p.tokensOut += tout;
          p.costUsd += cost;
        } else if (ev.type === 'rate_limit' && ev.meta) {
          if (!providers[actor]) providers[actor] = emptyProvider();
          const p = providers[actor];
          const ts = Number(ev.ts) || 0;
          if (ts >= (rateLimitTs[actor] ?? -1)) {
            rateLimitTs[actor] = ts;
            p.lastRateLimit = {
              status: ev.meta.status,
              rateLimitType: ev.meta.rateLimitType,
              resetsAt: ev.meta.resetsAt,
            };
          }
        }
      }
    }
  }

  return { providers, generatedAt: Date.now() };
}

module.exports = { aggregate };
