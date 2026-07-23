'use strict';

const { ev, createStreamDiagnostics } = require('./base');

// Gemini via REST (no CLI on disk). Reads GEMINI_API_KEY from the environment.
// Text generation only — the raw API cannot edit files, so Gemini fills
// reasoning/analysis/research roles, not file-editing worker roles.
module.exports = {
  id: 'gemini',
  label: 'Gemini API (legacy)',
  kind: 'api',
  canEdit: false,
  defaultModel: 'gemini-2.5-pro',
  models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  effortLevels: [],

  async run({ prompt, model, signal }, onEvent) {
    if (signal && signal.aborted) return { finalText: '', cancelled: true };
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      onEvent(ev('error', 'GEMINI_API_KEY is not set in the environment.'));
      onEvent(ev('done', '', { finalText: '' }));
      return { finalText: '', error: true };
    }
    const m = model || module.exports.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse`;
    let finalText = '';
    const diag = createStreamDiagnostics(onEvent, { adapter: 'gemini' });
    try {
      onEvent(ev('status', `Gemini (${m}) request started`));
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      });
      if (!res.ok) {
        const body = await res.text();
        onEvent(ev('error', `Gemini HTTP ${res.status}: ${body.slice(0, 300)}`));
        onEvent(ev('done', '', { finalText }));
        return { finalText, error: true };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          // SSE framing: blank lines and comment lines are protocol noise, not payload.
          if (!s || s.startsWith(':')) continue;
          if (!s.startsWith('data:')) {
            diag.nonJson(s);
            continue;
          }
          const payload = s.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let o;
          try {
            o = JSON.parse(payload);
          } catch {
            diag.malformedJson(payload);
            continue;
          }
          const parts =
            o.candidates &&
            o.candidates[0] &&
            o.candidates[0].content &&
            o.candidates[0].content.parts;
          let handled = false;
          if (parts) {
            handled = true;
            for (const p of parts) {
              if (p.text) {
                finalText += p.text;
                onEvent(ev('message', p.text, { delta: true }));
              }
            }
          }
          if (o.usageMetadata) {
            handled = true;
            onEvent(
              ev(
                'usage',
                `in:${o.usageMetadata.promptTokenCount || '?'} out:${o.usageMetadata.candidatesTokenCount || '?'}`,
                o.usageMetadata
              )
            );
          }
          // candidates present but empty (e.g. finishReason only) is still known schema.
          if (!handled && o.candidates) handled = true;
          if (!handled) {
            diag.unknownSchema(payload, {
              keys: o && typeof o === 'object' ? Object.keys(o).slice(0, 8) : [],
            });
          }
        }
      }
      onEvent(ev('message', finalText, { final: true }));
      onEvent(ev('done', '', { finalText }));
      return { finalText };
    } catch (e) {
      if ((signal && signal.aborted) || e.name === 'AbortError') {
        onEvent(ev('status', 'cancelled'));
        return { finalText, cancelled: true };
      }
      onEvent(ev('error', `Gemini request failed: ${e.message}`));
      onEvent(ev('done', '', { finalText }));
      return { finalText, error: true };
    }
  },
};
