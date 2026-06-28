'use strict';

const DEFAULT_KEEP_RECENT = 8;
const DEFAULT_MAX_CHARS = 6000;
const SNIPPET_CHARS = 120;

function countTurns(events) {
  let n = 0;
  for (const e of events) {
    if (e.kind === 'user' && e.text) n++;
    else if (e.kind === 'agent' && e.type === 'message' && e.meta && e.meta.final && e.text) n++;
  }
  return n;
}

const MAX_FILES_TOUCHED = 10;

function collectFiles(events) {
  const files = new Set();
  for (const e of events) {
    if (files.size >= MAX_FILES_TOUCHED) break;
    if (e.type === 'file_change' && e.meta && e.meta.file) files.add(e.meta.file);
    else if (e.meta && e.meta.file) files.add(e.meta.file);
  }
  return files;
}

function buildTurns(events) {
  const turns = [];
  for (const e of events) {
    if (e.kind === 'user' && e.text) turns.push(`User: ${e.text}`);
    else if (e.kind === 'agent' && e.type === 'message' && e.meta && e.meta.final && e.text) {
      turns.push(`${e.actor || 'assistant'}: ${e.text}`);
    }
  }
  return turns;
}

function truncateSnippet(text, maxLen = SNIPPET_CHARS) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '…';
}

function buildOlderSummary(olderTurns, files, maxSummaryChars) {
  const n = olderTurns.length;
  if (!n) return '';

  const seen = new Set();
  const snippets = [];
  for (const turn of olderTurns) {
    const snip = truncateSnippet(turn);
    if (!seen.has(snip)) {
      seen.add(snip);
      snippets.push(snip);
    }
  }

  const filesLine = files.size ? `\nFiles touched: ${[...files].join(', ')}` : '';
  const header = `Earlier context (${n} earlier exchanges): `;
  let body = snippets.join(' | ');
  const maxBodyChars = Math.max(0, maxSummaryChars - header.length - filesLine.length);
  if (body.length > maxBodyChars) body = body.slice(0, Math.max(0, maxBodyChars - 1)) + '…';

  let summary = `${header}${body}${filesLine}`;
  if (summary.length > maxSummaryChars) {
    summary = summary.slice(0, Math.max(0, maxSummaryChars - 1)) + '…';
  }
  return summary;
}

function compact(events, opts = {}) {
  const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  const turns = buildTurns(events);
  if (!turns.length) return '';

  const prefix = 'Conversation so far:\n';
  const verbatim = turns.join('\n');
  if (verbatim.length <= maxChars) return `${prefix}${verbatim}`;

  const recent = turns.slice(-keepRecent);
  const older = turns.slice(0, -keepRecent);
  const recentBlock = recent.join('\n');
  const files = collectFiles(events);

  if (!older.length) {
    let body = `${prefix}${recentBlock}`;
    if (body.length > maxChars) body = body.slice(0, maxChars - 1) + '…';
    return body;
  }

  const separator = '\n\n';
  const reserved = prefix.length + separator.length + recentBlock.length;
  const maxSummaryChars = Math.max(0, maxChars - reserved);
  const summary = buildOlderSummary(older, files, maxSummaryChars);

  let body = `${prefix}${summary}${separator}${recentBlock}`;
  if (body.length > maxChars) body = body.slice(0, maxChars - 1) + '…';
  return body;
}

module.exports = { compact, countTurns };
