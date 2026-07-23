'use strict';

/*
 * CSRF token policy:
 * - Localhost (single-user): static process-wide token is acceptable.
 * - Remote/LAN: periodically rotate; accept previous token for a short grace window
 *   so open pages can complete in-flight mutations after rotation.
 */

function createCsrfController(options = {}) {
  const rotateMs = options.rotateMs != null ? options.rotateMs : 30 * 60 * 1000;
  const graceMs = options.graceMs != null ? options.graceMs : 5 * 60 * 1000;
  const randomToken =
    typeof options.randomToken === 'function'
      ? options.randomToken
      : () => require('crypto').randomBytes(24).toString('base64url');
  const isRemote = () =>
    typeof options.isRemote === 'function' ? options.isRemote() : !!options.isRemote;

  const staticToken = options.staticToken || randomToken();
  let primary = { token: randomToken(), at: options.now ? options.now() : Date.now() };
  let previous = null;

  function now() {
    return options.now ? options.now() : Date.now();
  }

  function currentToken() {
    if (!isRemote()) return staticToken;
    const t = now();
    if (t - primary.at >= rotateMs) {
      previous = primary;
      primary = { token: randomToken(), at: t };
    }
    return primary.token;
  }

  function accepted(actual, equalFn) {
    const eq =
      equalFn ||
      ((a, b) =>
        typeof a === 'string' && typeof b === 'string' && a.length === b.length && a === b);
    if (!isRemote()) return eq(actual, staticToken);
    currentToken();
    if (eq(actual, primary.token)) return true;
    if (previous && now() - primary.at < graceMs && eq(actual, previous.token)) return true;
    return false;
  }

  /** Test hook: force rotation on next currentToken() when remote. */
  function _forceAge(ms) {
    primary = { ...primary, at: now() - ms };
  }

  function _state() {
    return { staticToken, primary: { ...primary }, previous: previous ? { ...previous } : null };
  }

  return { currentToken, accepted, _forceAge, _state, rotateMs, graceMs };
}

module.exports = { createCsrfController };
