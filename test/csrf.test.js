'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCsrfController } = require('../lib/csrf');

test('localhost uses static CSRF; remote rotates with grace', () => {
  let remote = false;
  let now = 1_000_000;
  let n = 0;
  const ctrl = createCsrfController({
    isRemote: () => remote,
    now: () => now,
    rotateMs: 1000,
    graceMs: 200,
    randomToken: () => `tok-${++n}`,
    staticToken: 'static-local',
  });

  assert.equal(ctrl.currentToken(), 'static-local');
  assert.equal(ctrl.accepted('static-local'), true);
  assert.equal(ctrl.accepted('tok-1'), false);

  remote = true;
  const t1 = ctrl.currentToken();
  assert.equal(t1, 'tok-1');
  assert.equal(ctrl.accepted(t1), true);

  now += 1001; // past rotate
  const t2 = ctrl.currentToken();
  assert.equal(t2, 'tok-2');
  assert.notEqual(t1, t2);
  // Grace: previous still accepted shortly after rotation.
  assert.equal(ctrl.accepted(t1), true);
  assert.equal(ctrl.accepted(t2), true);

  now += 200; // grace expired
  assert.equal(ctrl.accepted(t1), false);
  assert.equal(ctrl.accepted(t2), true);
});
