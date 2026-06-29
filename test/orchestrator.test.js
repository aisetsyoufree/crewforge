const assert = require('node:assert');
const test = require('node:test');

const { makePlanPrompt, parsePlan, validateSteps } = require('../lib/orchestrator');

test('makePlanPrompt includes member skill guidance', () => {
  const prompt = makePlanPrompt(
    {
      members: [
        {
          adapter: 'claude',
          model: 'sonnet',
          role: 'Product Manager',
          skillId: 'product-manager',
        },
      ],
    },
    'Build a dashboard'
  );

  assert.ok(prompt.includes('skill=Product Manager'));
  assert.ok(prompt.includes('Skill guidance'));
  assert.ok(prompt.includes('Expected outputs'));
});

test('parsePlan returns steps from clean JSON', () => {
  const input = '{"steps":[{"memberIndex":0,"task":"x"}]}';
  const steps = parsePlan(input, 2);
  assert.deepStrictEqual(steps, [{ memberIndex: 0, task: 'x' }]);
});

test('parsePlan extracts JSON wrapped in prose', () => {
  const input = [
    'Here is the delegation plan for your request:',
    '{"steps":[{"memberIndex":1,"task":"review changes"}]}',
    'Let me know if you need adjustments.',
  ].join('\n');
  const steps = parsePlan(input, 3);
  assert.deepStrictEqual(steps, [{ memberIndex: 1, task: 'review changes' }]);
});

test('parsePlan extracts JSON from fenced code blocks', () => {
  const input = [
    'Plan:',
    '```json',
    '{"steps":[{"memberIndex":0,"task":"implement feature"}]}',
    '```',
  ].join('\n');
  const steps = parsePlan(input, 1);
  assert.deepStrictEqual(steps, [{ memberIndex: 0, task: 'implement feature' }]);
});

test('parsePlan throws on unparseable input', () => {
  assert.throws(
    () => parsePlan('not json at all', 2),
    (err) => err instanceof Error && /unable to parse delegation plan/.test(err.message)
  );
});

test('validateSteps accepts valid steps within member count', () => {
  const steps = [
    { memberIndex: 0, task: 'first' },
    { memberIndex: 1, task: 'second' },
  ];
  assert.deepStrictEqual(validateSteps(steps, 2), steps);
});

test('validateSteps rejects out-of-range memberIndex', () => {
  assert.throws(
    () => validateSteps([{ memberIndex: 2, task: 'too high' }], 2),
    (err) => err instanceof Error && /invalid memberIndex for step 1/.test(err.message)
  );
  assert.throws(
    () => validateSteps([{ memberIndex: -1, task: 'negative' }], 2),
    (err) => err instanceof Error && /invalid memberIndex for step 1/.test(err.message)
  );
});

test('validateSteps rejects malformed steps', () => {
  assert.throws(
    () => validateSteps(null, 2),
    (err) => err instanceof Error && /plan\.steps must be an array/.test(err.message)
  );
  assert.throws(
    () => validateSteps([{ memberIndex: 0, task: '   ' }], 2),
    (err) => err instanceof Error && /missing task for step 1/.test(err.message)
  );
  assert.throws(
    () => validateSteps([{ memberIndex: 'zero', task: 'bad index' }], 2),
    (err) => err instanceof Error && /invalid memberIndex for step 1/.test(err.message)
  );
});
