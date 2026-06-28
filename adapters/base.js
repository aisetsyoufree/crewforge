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
 *   done         - turn finished (meta.finalText, meta.usage)
 *   error        - adapter or provider error
 *
 * meta.delta=true  -> text is an incremental token (append to current bubble)
 * meta.final=true  -> text is the complete section (replace/confirm)
 */

function ev(type, text, meta) {
  return { ts: Date.now(), type, text: text || '', meta: meta || null };
}

function stderrTail(stderr, maxChars = 1600) {
  const raw = String(stderr || '');
  if (!raw) return '';
  const redacted = raw
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [redacted]')
    .replace(
      /\b(api[_-]?key|token|authorization|password|secret)(\s*[:=]\s*)(["']?)[^\s"']+/gi,
      '$1$2$3[redacted]'
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1...[redacted]')
    .replace(/\b(AIza[0-9A-Za-z_-]{8})[0-9A-Za-z_-]+/g, '$1...[redacted]');
  const tail = redacted.length > maxChars ? `...${redacted.slice(-maxChars)}` : redacted;
  return tail.trim();
}

function cliExitError(name, code, signal, stderr) {
  const status = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`;
  const tail = stderrTail(stderr);
  return `${name} exited with ${status}${tail ? `: ${tail}` : ''}`;
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

module.exports = { ev, TokenStreamer, stderrTail, cliExitError };
