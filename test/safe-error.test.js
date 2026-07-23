'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { safeErrMsg } = require('../lib/safe_error');

test('safeErrMsg redacts Bearer, sk-, api_key, password, and token before truncation', () => {
  const raw = [
    'failed Bearer supersecrettokenvalue12345',
    'key sk-abcdefghijklmnopqrstuvwxyz012345',
    'api_key=my-super-secret-api-key-value',
    'password: hunter2passwordvalue',
    'token=abcdef1234567890tokenval',
  ].join(' | ');

  const msg = safeErrMsg(new Error(raw), { home: '/Users/sid', max: 400 });

  assert.doesNotMatch(msg, /supersecrettokenvalue12345/);
  assert.doesNotMatch(msg, /sk-abcdefghijklmnopqrstuvwxyz012345/);
  assert.doesNotMatch(msg, /my-super-secret-api-key-value/);
  assert.doesNotMatch(msg, /hunter2passwordvalue/);
  assert.doesNotMatch(msg, /abcdef1234567890tokenval/);
  assert.match(msg, /\[redacted\]|REDACTED|\.\.\.\[redacted\]|…\[redacted\]/i);
});

test('safeErrMsg scrubs home paths and truncates after redaction', () => {
  const long = 'error at /Users/sid/secret/path ' + 'x'.repeat(500);
  const msg = safeErrMsg(long, { home: '/Users/sid', max: 80 });
  assert.doesNotMatch(msg, /\/Users\/sid/);
  assert.ok(msg.length <= 81); // 80 + ellipsis
  assert.ok(msg.endsWith('…'));
});

test('safeErrMsg handles stderr field and empty values', () => {
  assert.equal(
    safeErrMsg({ stderr: 'password=s3cretvaluehere' }).includes('s3cretvaluehere'),
    false
  );
  assert.equal(safeErrMsg(null), 'error');
  assert.equal(safeErrMsg(undefined), 'error');
});
