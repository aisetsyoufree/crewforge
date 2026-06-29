'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-skills-'));
process.env.CREW_FORGE_SKILLS_FILE = path.join(tmpDir, 'custom-skills.json');

const { list, get, save, deleteCustom, buildSkillPrompt } = require('../lib/skills');

const EXPECTED_IDS = [
  'product-manager',
  'sprint-planner',
  'staff-engineer',
  'frontend-engineer',
  'backend-engineer',
  'qa-reviewer',
  'security-reviewer',
];

const REQUIRED_FIELDS = [
  'id',
  'name',
  'role',
  'instructions',
  'expectedOutputs',
  'preferredMode',
  'artifactTypes',
];

test('list() includes all built-in skill ids', () => {
  const skills = list();
  assert.strictEqual(skills.length, 7);

  const ids = skills.map((skill) => skill.id);
  for (const expectedId of EXPECTED_IDS) {
    assert.ok(ids.includes(expectedId), `missing skill id: ${expectedId}`);
  }
});

test('get() returns the correct shape for each skill', () => {
  for (const id of EXPECTED_IDS) {
    const skill = get(id);
    assert.ok(skill, `expected skill for id: ${id}`);

    for (const field of REQUIRED_FIELDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(skill, field),
        `${id} missing field: ${field}`
      );
    }

    assert.ok(
      skill.preferredMode === 'plan' || skill.preferredMode === 'edit',
      `${id} preferredMode must be plan or edit`
    );

    assert.ok(Array.isArray(skill.expectedOutputs));
    assert.ok(skill.expectedOutputs.length > 0);
    assert.ok(Array.isArray(skill.artifactTypes));
    assert.ok(skill.artifactTypes.length > 0);
    assert.ok(typeof skill.instructions === 'string');
    assert.ok(skill.instructions.length > 0);
  }
});

test('buildSkillPrompt embeds objective and skill instructions', () => {
  const objective = 'Ship user profile settings with avatar upload';
  const context = 'Repo uses Express and vanilla JS in public/.';

  for (const id of EXPECTED_IDS) {
    const skill = get(id);
    const prompt = buildSkillPrompt(id, { objective, context });

    assert.ok(prompt.includes(skill.instructions), `${id} prompt missing instructions`);
    assert.ok(prompt.includes(objective), `${id} prompt missing objective`);
    assert.ok(prompt.includes(context), `${id} prompt missing context`);
    assert.ok(prompt.includes('## Objective'), `${id} prompt missing objective section`);
  }
});

test('get() returns null and buildSkillPrompt falls back for unknown ids', () => {
  assert.strictEqual(get('nope'), null);

  const prompt = buildSkillPrompt('nope', {
    objective: 'Fix the flaky login test',
    context: 'CI fails intermittently on auth.test.js',
  });

  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('Fix the flaky login test'));
  assert.ok(prompt.includes('software engineer'));
});

test('save() creates and deleteCustom() removes a local custom skill', () => {
  const saved = save({
    name: 'Release Manager',
    role: 'Release Manager',
    instructions: 'Coordinate release notes, rollout risk, and verification.',
    expectedOutputs: ['Release checklist'],
    preferredMode: 'plan',
    artifactTypes: ['markdown'],
  });

  assert.ok(saved.id);
  assert.strictEqual(saved.name, 'Release Manager');
  assert.strictEqual(saved.custom, true);
  assert.strictEqual(saved.builtIn, false);
  assert.ok(get(saved.id));
  assert.ok(list().some((skill) => skill.id === saved.id));

  assert.strictEqual(deleteCustom(saved.id), true);
  assert.strictEqual(get(saved.id), null);
});

test('save() can locally override a built-in skill used by buildSkillPrompt', () => {
  const saved = save({
    id: 'product-manager',
    name: 'Product Manager',
    role: 'PM Lead',
    instructions: 'Custom PM instructions for this local install.',
    expectedOutputs: ['Custom product brief'],
    preferredMode: 'plan',
    artifactTypes: ['markdown'],
  });

  assert.strictEqual(saved.id, 'product-manager');
  assert.strictEqual(saved.custom, true);
  assert.strictEqual(saved.builtIn, true);

  const prompt = buildSkillPrompt('product-manager', {
    objective: 'Plan the beta launch',
  });
  assert.ok(prompt.includes('Custom PM instructions for this local install.'));
  assert.ok(prompt.includes('# Role: PM Lead'));

  assert.strictEqual(deleteCustom('product-manager'), true);
  assert.ok(get('product-manager').instructions.includes('You are the Product Manager'));
});
