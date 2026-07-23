'use strict';

/*
 * Normalized event schema shared by every adapter.
 *
 *   { ts, type, role, text, meta }
 *
 * type:
 *   status       - lifecycle note (session started, etc.)
 *   reasoning    - model thinking (may stream as deltas)
 *   message      - model's visible answer (may stream as deltas)
 *   command      - a shell/tool command the agent ran
 *   file_change  - the agent created/edited a file
 *   usage        - token/cost accounting
 *   rate_limit   - provider rate-limit signal (status, resetsAt)
 *   diagnostic   - parse/schema anomaly (redacted preview; bounded count)
 *   done         - turn finished (meta.finalText, meta.usage)
 *   error        - adapter or provider error
 *
 * meta.delta=true  -> text is an incremental token (append to current bubble)
 * meta.final=true  -> text is the complete section (replace/confirm)
 *
 * diagnostic meta:
 *   reason: 'malformed_json' | 'non_json' | 'unknown_schema'
 *   adapter, preview, index, capped?
 */

function ev(type, text, meta) {
  return { ts: Date.now(), type, text: text || '', meta: meta || null };
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Cap each diagnostic preview so secrets/noise cannot flood the UI. */
const DIAGNOSTIC_MAX_LINE_CHARS = 400;
/** Cap diagnostic events emitted per adapter run. */
const DIAGNOSTIC_MAX_EVENTS = 25;

const DIAGNOSTIC_REASONS = {
  MALFORMED_JSON: 'malformed_json',
  NON_JSON: 'non_json',
  UNKNOWN_SCHEMA: 'unknown_schema',
};

function normalizeEffort(effort, allowed = EFFORT_LEVELS) {
  const value = String(effort || '')
    .trim()
    .toLowerCase();
  if (!value || value === 'default') return null;
  const normalized = value === 'extra-high' || value === 'extra high' ? 'xhigh' : value;
  return allowed.includes(normalized) ? normalized : null;
}

/** Strip likely secrets from free-form adapter output before UI/diagnostics. */
function redactSecrets(text) {
  return (
    String(text || '')
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [redacted]')
      // JSON-style "password":"value" / "api_key": "value"
      .replace(
        /(["']?)(api[_-]?key|token|authorization|password|secret)\1\s*:\s*(["']?)[^"'}\s,]+/gi,
        '$1$2$1: $3[redacted]'
      )
      // Plain key=value / key: value forms
      .replace(
        /\b(api[_-]?key|token|authorization|password|secret)(\s*[:=]\s*)(["']?)[^\s"']+/gi,
        '$1$2$3[redacted]'
      )
      .replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1...[redacted]')
      .replace(/\b(AIza[0-9A-Za-z_-]{8})[0-9A-Za-z_-]+/g, '$1...[redacted]')
      .replace(/\b(xox[baprs]-[A-Za-z0-9-]{8,})/gi, 'xox…[redacted]')
      .replace(/\b(ghp_[A-Za-z0-9]{8})[A-Za-z0-9]*/g, '$1…[redacted]')
  );
}

function previewDiagnosticLine(line, maxChars = DIAGNOSTIC_MAX_LINE_CHARS) {
  const redacted = redactSecrets(line).replace(/\s+/g, ' ').trim();
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}…[truncated]`;
}

/**
 * Per-stream diagnostic emitter for unparseable / unexpected / unknown-schema lines.
 * Ensures no stream line is silently discarded while bounding volume and redacting secrets.
 */
function createStreamDiagnostics(onEvent, { adapter } = {}) {
  let emitted = 0;
  let suppressed = 0;
  const source = adapter || 'adapter';

  function emit(reason, rawLine, extra = {}) {
    if (emitted >= DIAGNOSTIC_MAX_EVENTS) {
      suppressed += 1;
      return null;
    }
    emitted += 1;
    const preview = previewDiagnosticLine(rawLine);
    const label =
      reason === DIAGNOSTIC_REASONS.MALFORMED_JSON
        ? 'malformed JSON'
        : reason === DIAGNOSTIC_REASONS.NON_JSON
          ? 'unexpected non-JSON'
          : 'unknown schema';
    const text = `${label} from ${source}: ${preview}`;
    const meta = {
      reason,
      adapter: source,
      preview,
      index: emitted,
      ...extra,
    };
    if (emitted >= DIAGNOSTIC_MAX_EVENTS) meta.capped = true;
    if (suppressed > 0) meta.suppressed = suppressed;
    const event = ev('diagnostic', text, meta);
    if (typeof onEvent === 'function') onEvent(event);
    return event;
  }

  return {
    malformedJson(line, extra) {
      return emit(DIAGNOSTIC_REASONS.MALFORMED_JSON, line, extra);
    },
    nonJson(line, extra) {
      return emit(DIAGNOSTIC_REASONS.NON_JSON, line, extra);
    },
    unknownSchema(line, extra) {
      return emit(DIAGNOSTIC_REASONS.UNKNOWN_SCHEMA, line, extra);
    },
    stats() {
      return { emitted, suppressed, maxEvents: DIAGNOSTIC_MAX_EVENTS };
    },
  };
}

function stderrTail(stderr, maxChars = 1600) {
  const raw = String(stderr || '');
  if (!raw) return '';
  const redacted = redactSecrets(raw);
  const tail = redacted.length > maxChars ? `...${redacted.slice(-maxChars)}` : redacted;
  return tail.trim();
}

function cliExitError(name, code, signal, stderr) {
  const status = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`;
  const tail = stderrTail(stderr);
  return `${name} exited with ${status}${tail ? `: ${tail}` : ''}`;
}

function safeCliEnv(extra) {
  const allowed = [
    'PATH',
    'HOME',
    'SHELL',
    'TERM',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'SSH_AUTH_SOCK',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'GROK_HOME',
  ];
  const env = {};
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...(extra || {}) };
}

// Streams text tokens into consolidated sections. Adapters that emit
// token-by-token (grok) use this; chunked adapters (codex/claude) emit directly.
class TokenStreamer {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.current = null; // 'reasoning' | 'message'
    this.buf = '';
  }
  push(type, token) {
    if (this.current && this.current !== type) this.flush();
    this.current = type;
    this.buf += token;
    this.onEvent(ev(type, token, { delta: true }));
  }
  flush() {
    if (this.current && this.buf) {
      this.onEvent(ev(this.current, this.buf, { final: true }));
    }
    this.current = null;
    this.buf = '';
  }
}

module.exports = {
  EFFORT_LEVELS,
  DIAGNOSTIC_MAX_LINE_CHARS,
  DIAGNOSTIC_MAX_EVENTS,
  DIAGNOSTIC_REASONS,
  ev,
  normalizeEffort,
  redactSecrets,
  previewDiagnosticLine,
  createStreamDiagnostics,
  TokenStreamer,
  stderrTail,
  cliExitError,
  safeCliEnv,
};
