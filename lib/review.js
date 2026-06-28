'use strict';

function buildReviewPrompt(diff, _opts = {}) {
  const trimmed = (diff || '').trim();
  const lines = [
    'You are a senior code reviewer. Review the uncommitted changes below.',
    '',
    'Report concisely:',
    '1. Correctness bugs — logic errors, edge cases, broken behavior',
    '2. Security issues — injection, auth, secrets, unsafe defaults',
    '3. Scope / regressions — unrelated changes, missing tests, breaking existing behavior',
    '4. Final verdict — end with a single line: **APPROVE** or **REQUEST CHANGES**',
    '',
  ];

  if (!trimmed) {
    lines.push('no uncommitted changes');
  } else {
    lines.push('```diff');
    lines.push(trimmed);
    lines.push('```');
  }

  return lines.join('\n');
}

module.exports = { buildReviewPrompt };
