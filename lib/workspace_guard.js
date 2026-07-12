'use strict';

const path = require('path');

function normalizePath(filePath, cwd) {
  if (!filePath || !cwd) return null;
  const raw = String(filePath);
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(cwd, raw));
}

function isInsideWorkspace(filePath, cwd) {
  const resolvedFile = normalizePath(filePath, cwd);
  if (!resolvedFile || !cwd) return true;
  const resolvedCwd = path.resolve(cwd);
  const rel = path.relative(resolvedCwd, resolvedFile);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function guardWorkspaceEvent(cwd, mode, event) {
  if (!event || event.type !== 'file_change') return event;
  const file = event.meta && event.meta.file;
  if (!file) return event;

  const resolvedFile = normalizePath(file, cwd);
  if (mode === 'plan' || !isInsideWorkspace(file, cwd)) {
    const selected = cwd ? path.resolve(cwd) : 'the selected workspace';
    return {
      ...event,
      type: 'error',
      text:
        mode === 'plan'
          ? `Read-only mode reported a file write outside Crew Forge control: ${resolvedFile || file}. The selected workspace is ${selected}.`
          : `Detected a reported file write outside the selected workspace: ${resolvedFile || file}. Crew Forge did not prevent this host write. The selected workspace is ${selected}.`,
      meta: { ...(event.meta || {}), originalType: 'file_change', outsideWorkspace: true },
    };
  }
  return event;
}

function guardedEmitter(cwd, mode, onEvent) {
  return (event) => onEvent(guardWorkspaceEvent(cwd, mode || 'plan', event));
}

function workspaceInstruction(cwd, mode) {
  if (!cwd) return '';
  const selected = path.resolve(cwd);
  const writeRule =
    mode === 'edit'
      ? 'Create or modify files only inside this selected workspace.'
      : 'This is read-only Plan mode: do not create, edit, or move files; return any document or artifact content in the chat response.';
  return [
    `Selected workspace: ${selected}`,
    writeRule,
    'Do not write files to provider-private folders, home-directory plan folders, temp folders, or any path outside the selected workspace.',
  ].join('\n');
}

function withWorkspaceInstruction(prompt, cwd, mode) {
  const instruction = workspaceInstruction(cwd, mode);
  return instruction ? `${instruction}\n\nUser request:\n${prompt || ''}` : prompt;
}

module.exports = {
  guardWorkspaceEvent,
  guardedEmitter,
  isInsideWorkspace,
  workspaceInstruction,
  withWorkspaceInstruction,
};
