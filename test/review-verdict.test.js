'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildReviewPrompt,
  parseReviewVerdict,
  findingsUnchanged,
  toPersistedReview,
  normalizeFindingSet,
} = require('../lib/review');

test('buildReviewPrompt asks for structured PASS/REQUEST_CHANGES JSON', () => {
  const prompt = buildReviewPrompt('diff --git a/x b/x\n+hi');
  assert.match(prompt, /PASS/);
  assert.match(prompt, /REQUEST_CHANGES/);
  assert.match(prompt, /confidence/i);
  assert.match(prompt, /```json/);
  assert.match(prompt, /diff --git a\/x b\/x/);
});

test('parses fenced JSON PASS with findings array', () => {
  const text = [
    'Looks good overall.',
    '```json',
    JSON.stringify({
      verdict: 'PASS',
      findings: [],
    }),
    '```',
    'VERDICT: PASS',
  ].join('\n');
  const parsed = parseReviewVerdict(text);
  assert.equal(parsed.parseStatus, 'ok');
  assert.equal(parsed.verdict, 'PASS');
  assert.deepEqual(parsed.findings, []);
});

test('parses REQUEST_CHANGES with bounded findings', () => {
  const text = `
Analysis...
\`\`\`json
{
  "verdict": "REQUEST_CHANGES",
  "findings": [
    {
      "id": "F1",
      "severity": "high",
      "summary": "Null deref in handler",
      "file": "lib/foo.js",
      "acceptanceCriterion": "no crashes"
    },
    {
      "id": "F2",
      "severity": "low",
      "summary": "typo"
    }
  ]
}
\`\`\`
VERDICT: REQUEST_CHANGES
`;
  const parsed = parseReviewVerdict(text);
  assert.equal(parsed.parseStatus, 'ok');
  assert.equal(parsed.verdict, 'REQUEST_CHANGES');
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0].file, 'lib/foo.js');
  assert.equal(parsed.findings[0].acceptanceCriterion, 'no crashes');
});

test('unparseable output is incomplete not PASS', () => {
  const parsed = parseReviewVerdict('I think this is probably fine, ship it maybe?');
  assert.equal(parsed.parseStatus, 'incomplete');
  assert.equal(parsed.verdict, null);
  assert.deepEqual(parsed.findings, []);
});

test('empty output is incomplete', () => {
  const parsed = parseReviewVerdict('');
  assert.equal(parsed.parseStatus, 'incomplete');
});

test('legacy APPROVE tail still maps to PASS', () => {
  const parsed = parseReviewVerdict('Some notes\n\n**APPROVE**');
  assert.equal(parsed.parseStatus, 'ok');
  assert.equal(parsed.verdict, 'PASS');
});

test('toPersistedReview redacts and bounds; raw text not stored', () => {
  const parsed = parseReviewVerdict(`
\`\`\`json
{"verdict":"REQUEST_CHANGES","findings":[{"id":"F1","severity":"error","summary":"leaked sk-abcdefghijklmnopqrstuvwxyz token"}],"notes":"Bearer abcdefghijklmnop"}
\`\`\`
`);
  const persisted = toPersistedReview(parsed);
  assert.equal(persisted.verdict, 'REQUEST_CHANGES');
  assert.equal(persisted.parseStatus, 'ok');
  const blob = JSON.stringify(persisted);
  assert.equal(blob.includes('sk-abcdefghijklmnopqrstuvwxyz'), false);
  assert.match(blob, /REDACTED/);
});

test('findingsUnchanged detects identical normalized sets', () => {
  const a = [
    { id: 'F1', severity: 'high', summary: 'Bug A', file: 'a.js' },
    { id: 'F2', severity: 'low', summary: 'Nit' },
  ];
  const b = [
    { id: 'F2', severity: 'low', summary: 'Nit' },
    { id: 'F1', severity: 'high', summary: 'Bug A', file: 'a.js' },
  ];
  assert.equal(findingsUnchanged(a, b), true);
  assert.equal(
    findingsUnchanged(a, [{ id: 'F1', severity: 'high', summary: 'Other', file: 'a.js' }]),
    false
  );
  assert.ok(normalizeFindingSet(a).length > 0);
});
