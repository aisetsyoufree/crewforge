'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  guardWorkspaceEvent,
  isInsideWorkspace,
  withWorkspaceInstruction,
} = require('../lib/workspace_guard');

test('isInsideWorkspace accepts relative and nested workspace paths', () => {
  assert.equal(isInsideWorkspace('notes/plan.md', '/tmp/project'), true);
  assert.equal(isInsideWorkspace('/tmp/project/notes/plan.md', '/tmp/project'), true);
});

test('isInsideWorkspace rejects absolute and relative paths outside workspace', () => {
  assert.equal(isInsideWorkspace('/tmp/other/plan.md', '/tmp/project'), false);
  assert.equal(isInsideWorkspace('../other/plan.md', '/tmp/project'), false);
});

test('guardWorkspaceEvent converts read-only file changes into errors', () => {
  const event = guardWorkspaceEvent('/tmp/project', 'plan', {
    type: 'file_change',
    text: 'Write: /tmp/project/plan.md',
    meta: { file: '/tmp/project/plan.md' },
  });

  assert.equal(event.type, 'error');
  assert.match(event.text, /Read-only mode reported a file write/);
  assert.equal(event.meta.originalType, 'file_change');
});

test('guardWorkspaceEvent converts outside-workspace edit changes into errors', () => {
  const event = guardWorkspaceEvent('/tmp/project', 'edit', {
    type: 'file_change',
    text: 'Write: /tmp/other/plan.md',
    meta: { file: '/tmp/other/plan.md' },
  });

  assert.equal(event.type, 'error');
  assert.match(event.text, /outside the selected workspace/);
  assert.match(event.text, /did not prevent this host write/);
  assert.equal(event.meta.outsideWorkspace, true);
});

test('withWorkspaceInstruction tells models where files may be written', () => {
  const prompt = withWorkspaceInstruction('Build it', '/tmp/project', 'edit');

  assert.match(prompt, /Selected workspace: \/tmp\/project/);
  assert.match(prompt, /only inside this selected workspace/);
  assert.match(prompt, /User request:\nBuild it/);
});
