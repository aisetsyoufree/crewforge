'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mdInline, markdownToHtml, escapeHtml, safeMarkdownHref } = require('../lib/markdown');

test('mdInline escapes capture groups so script/html cannot inject', () => {
  const bold = mdInline('**hello <script>alert(1)</script>**');
  assert.match(bold, /<strong>/);
  assert.doesNotMatch(bold, /<script>/);
  assert.match(bold, /&lt;script&gt;/);

  const code = mdInline('`</code><img src=x onerror=alert(1)>`');
  assert.match(code, /<code class="md-icode">/);
  assert.doesNotMatch(code, /<img /);
  assert.match(code, /&lt;\/code&gt;/);

  const em = mdInline('*<img src=x>*');
  assert.doesNotMatch(em, /<img /);
  assert.match(em, /&lt;img/);
});

test('mdInline link text and href are escaped; dangerous schemes stripped', () => {
  const bad = mdInline('[click</a><script>](javascript:alert(1))');
  assert.doesNotMatch(bad, /<script>/);
  assert.match(bad, /&lt;script&gt;/);
  assert.doesNotMatch(bad, /<a\b/i);

  const ok = mdInline('[docs](https://example.com/a?b=1)');
  assert.match(ok, /href="https:\/\/example\.com\/a\?b=1"/);
  assert.match(ok, />docs</);
});

test('markdownToHtml keeps formatting and escapes residual HTML', () => {
  const html = markdownToHtml('# Title <b>raw</b>\n\nHello **world** and `code`\n');
  assert.match(html, /<h1>/);
  assert.match(html, /&lt;b&gt;raw&lt;\/b&gt;/);
  assert.match(html, /<strong>world<\/strong>/);
  assert.match(html, /<code class="md-icode">code<\/code>/);
  assert.doesNotMatch(html, /<b>raw<\/b>/);
});

test('safeMarkdownHref and escapeHtml basics', () => {
  assert.equal(safeMarkdownHref('javascript:alert(1)'), '');
  assert.equal(safeMarkdownHref('//evil.example'), '');
  assert.equal(safeMarkdownHref('https://ok.example/x'), 'https://ok.example/x');
  assert.equal(escapeHtml(`a&b<c>"'`), 'a&amp;b&lt;c&gt;&quot;&#39;');
});

test('raw javascript anchor is escaped (F-01)', () => {
  const raw = '<a href="javascript:alert(1)">click</a>';
  const inline = mdInline(raw);
  const block = markdownToHtml(raw);
  // Must not emit a live anchor tag (escaped text may still contain the word).
  assert.doesNotMatch(inline, /<a\b/i);
  assert.doesNotMatch(block, /<a\b/i);
  assert.match(inline, /&lt;a\b/);
  assert.match(block, /&lt;a\b/);
  assert.match(inline, /&lt;\/a&gt;/);
  assert.match(inline, /href=&quot;javascript:alert\(1\)&quot;/);
});

test('raw https anchor is escaped (not trusted merely as <a>)', () => {
  const raw = '<a href="https://evil.example/phish">click</a>';
  const inline = mdInline(raw);
  const block = markdownToHtml(`See ${raw} now`);
  assert.doesNotMatch(inline, /<a\b/i);
  assert.doesNotMatch(block, /<a\b/i);
  assert.match(inline, /&lt;a\b/);
  assert.match(block, /&lt;a\b/);
  assert.match(inline, /https:\/\/evil\.example\/phish/);
});

test('data URL and vbscript markdown links are stripped', () => {
  // Parentheses inside the URL terminate the simple markdown link regex early;
  // still must not emit an anchor or a live data: attribute.
  const data = mdInline('[x](data:text/html,hello)');
  assert.doesNotMatch(data, /<a\b/i);
  assert.doesNotMatch(data, /href="/i);
  assert.match(data, /^x/);

  const vb = mdInline('[x](vbscript:msgbox(1))');
  assert.doesNotMatch(vb, /<a\b/i);
  assert.doesNotMatch(vb, /href="/i);

  const rawData = markdownToHtml('<a href="data:text/html,hi">x</a>');
  assert.doesNotMatch(rawData, /<a\b/i);
  assert.match(rawData, /&lt;a\b/);
});

test('encoded and mixed-case dangerous schemes are rejected', () => {
  for (const href of [
    'JavaScript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'jAvAsCrIpT:alert(1)',
    'DATA:text/html,x',
    'VbScript:msgbox(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
  ]) {
    assert.equal(safeMarkdownHref(href), '', href);
    const out = mdInline(`[ok](${href})`);
    assert.doesNotMatch(out, /<a\b/i, href);
  }

  // HTML-entity-encoded colon in a raw anchor must not become a live tag.
  const entityRaw = markdownToHtml('<a href="javascript&#58;alert(1)">x</a>');
  assert.doesNotMatch(entityRaw, /<a\b/i);
  assert.match(entityRaw, /&lt;a\b/);
});

test('quote breaking in markdown href is attribute-escaped', () => {
  const out = mdInline('[x](https://example.com/"onclick=alert(1))');
  assert.match(out, /<a href="/);
  assert.match(out, /&quot;/);
  assert.doesNotMatch(out, /href="[^"]*"onclick/i);
  // Attribute value must not close early and open a free onclick handler.
  assert.doesNotMatch(out, /\sonclick=/i);
});

test('safe markdown links survive with escaped text and href', () => {
  const https = mdInline('[docs](https://example.com/a?b=1&c=2)');
  assert.match(
    https,
    /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/
  );

  const http = mdInline('[h](http://example.com)');
  assert.match(http, /href="http:\/\/example\.com"/);

  const rel = mdInline('[r](/path/to)');
  assert.match(rel, /href="\/path\/to"/);

  const frag = mdInline('[f](#section-1)');
  assert.match(frag, /href="#section-1"/);

  const labeled = mdInline('[click <em>](https://ok.example)');
  assert.match(labeled, /href="https:\/\/ok\.example"/);
  assert.match(labeled, /click &lt;em&gt;/);
  assert.doesNotMatch(labeled, /click <em>/);
});

test('normal formatting is preserved (bold, italic, code, line breaks)', () => {
  const inline = mdInline('**bold** and *italic* and `code`');
  assert.equal(
    inline,
    '<strong>bold</strong> and <em>italic</em> and <code class="md-icode">code</code>'
  );

  const br = mdInline('line1\nline2');
  assert.equal(br, 'line1<br>line2');

  const block = markdownToHtml('Hello **world** and `code`\n\n- item *one*\n');
  assert.match(block, /<strong>world<\/strong>/);
  assert.match(block, /<code class="md-icode">code<\/code>/);
  assert.match(block, /<em>one<\/em>/);
  assert.match(block, /<ul>/);
  assert.match(block, /<li>/);
});

test('protocol-relative and malformed hrefs are rejected', () => {
  assert.equal(safeMarkdownHref('//evil.example/x'), '');
  assert.equal(safeMarkdownHref(''), '');
  assert.equal(safeMarkdownHref('   '), '');
  assert.doesNotMatch(mdInline('[x](//evil.example)'), /<a\b/i);
  assert.doesNotMatch(mdInline('[x](javascript:)'), /<a\b/i);
});

test('event-handler tags are not allowlisted by bare name', () => {
  const strong = mdInline('<strong onclick="alert(1)">x</strong>');
  // Text content may mention onclick, but it must not be a live attribute.
  assert.doesNotMatch(strong, /<strong\b/i);
  assert.match(strong, /&lt;strong /);
  assert.match(strong, /onclick=&quot;alert\(1\)&quot;/);

  const block = markdownToHtml('<br onmouseover="alert(1)">');
  assert.doesNotMatch(block, /<br\b/i);
  assert.match(block, /&lt;br /);
});
