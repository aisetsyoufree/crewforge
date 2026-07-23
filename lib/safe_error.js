'use strict';

/*
 * Client-safe error messages: secret redaction before path scrubbing/truncation.
 * Shared by the HTTP server so error responses never leak credentials.
 */

const { redactSecrets } = require('../adapters/base');

const DEFAULT_MAX = 400;

/**
 * Build a short, redacted error string suitable for JSON API responses.
 * Always runs comprehensive secret redaction before length truncation.
 *
 * @param {*} e - Error, string, or value with message/stderr
 * @param {{ home?: string, max?: number }} [options]
 * @returns {string}
 */
function safeErrMsg(e, options = {}) {
  const home = options.home != null ? options.home : '';
  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : DEFAULT_MAX;
  let m = String((e && (e.stderr || e.message)) || e || 'error');
  // Secrets first — never truncate mid-secret into a still-sensitive tail.
  m = redactSecrets(m);
  if (home) m = m.split(home).join('~');
  m = m.replace(/(?:\/(?:Users|home)\/[^\s'":]+)/g, '<path>');
  if (m.length > max) m = m.slice(0, max) + '…';
  return m;
}

module.exports = {
  safeErrMsg,
  DEFAULT_MAX,
};
