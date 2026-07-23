'use strict';

/*
 * Pure markdown → HTML helpers (browser-independent).
 *
 * Security model (escape-first, never sanitize arbitrary raw HTML):
 * 1. Escape all untrusted input.
 * 2. Apply only the supported markdown transforms, which insert fixed tags.
 * 3. escapeLoose only preserves exact tags our transforms emit — never a bare
 *    tag-name allowlist (raw <a> from model text must not survive).
 */

function escapeHtml(s) {
  return String(s || '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]
  );
}

function decodeBasicEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Allow only safe hrefs for markdown links.
 * Permits http(s), relative paths, and #fragments.
 * Rejects javascript:, data:, vbscript:, protocol-relative, etc.
 */
function safeMarkdownHref(href) {
  const raw = String(href || '').trim();
  const decoded = decodeBasicEntities(raw).trim();
  // eslint-disable-next-line no-control-regex
  const normalized = decoded.replace(/[\u0000-\u001F\u007F\s]+/g, '');
  if (!normalized || normalized.startsWith('//')) return '';
  const scheme = normalized.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (scheme && !['http', 'https'].includes(scheme[1].toLowerCase())) return '';
  return raw;
}

/**
 * Inline markdown formatter.
 * Escapes all raw input first, then applies only supported transforms so raw
 * HTML (including allowlist-shaped tags) cannot pass through.
 */
function mdInline(s) {
  // Escape every character of untrusted input before introducing any markup.
  let text = escapeHtml(String(s || ''));
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="md-icode">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, href) => {
      // href is already HTML-escaped; decode for scheme checks only.
      const safe = safeMarkdownHref(decodeBasicEntities(href));
      if (!safe) return linkText;
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
    })
    .replace(/\n/g, '<br>');
}

/**
 * Block-level markdown. Unformatted spans are escaped; code blocks are escaped.
 */
function markdownToHtml(raw) {
  if (!raw) return '';
  const lines = String(raw).split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('```')) {
      i++;
      const code = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(`<pre class="md-pre"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = lines[i].match(/^(#{1,6}) (.+)$/);
    if (h) {
      blocks.push(`<h${h[1].length}>${escapeLoose(mdInline(h[2]))}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^[-*] /.test(lines[i])) {
      const items = [];
      let m;
      while (i < lines.length && (m = lines[i].match(/^[-*] (.+)$/))) {
        items.push(`<li>${escapeLoose(mdInline(m[1]))}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(lines[i])) {
      const items = [];
      let m;
      while (i < lines.length && (m = lines[i].match(/^\d+\. (.+)$/))) {
        items.push(`<li>${escapeLoose(mdInline(m[1]))}</li>`);
        i++;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('```') &&
      !/^#{1,6} /.test(lines[i]) &&
      !/^[-*] /.test(lines[i]) &&
      !/^\d+\. /.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(`<p>${escapeLoose(mdInline(para.join('\n')))}</p>`);
  }
  return blocks.join('');
}

/**
 * Preserve only exact tags emitted by mdInline; neutralize any other raw tags.
 * Deliberately does NOT allowlist by tag name alone — a raw <a href=...> from
 * model text will not match the trusted anchor shape and is escaped.
 *
 * Residual text from mdInline is already entity-escaped; we only escape raw
 * angle brackets here so we never double-encode &amp; / &lt; sequences.
 */
function escapeLoose(html) {
  // Exact shapes only (case-sensitive). No attribute wildcards on strong/em/br.
  const tokenRe =
    /(<\/strong>|<\/em>|<\/code>|<\/a>|<strong>|<em>|<code class="md-icode">|<br>|<a href="[^"]*" target="_blank" rel="noopener noreferrer">)/g;
  const parts = String(html || '').split(tokenRe);
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    if (
      part === '</strong>' ||
      part === '</em>' ||
      part === '</code>' ||
      part === '</a>' ||
      part === '<strong>' ||
      part === '<em>' ||
      part === '<code class="md-icode">' ||
      part === '<br>'
    ) {
      out += part;
      continue;
    }
    const am = part.match(/^<a href="([^"]*)" target="_blank" rel="noopener noreferrer">$/);
    if (am && safeMarkdownHref(am[1])) {
      out += part;
      continue;
    }
    // Kill raw tags without re-encoding already-escaped entities from mdInline.
    out += part.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return out;
}

module.exports = {
  escapeHtml,
  safeMarkdownHref,
  mdInline,
  markdownToHtml,
};
