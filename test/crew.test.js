'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const crew = require('../lib/crew');
const tasks = require('../lib/tasks');

const projectsDir = path.join(__dirname, '..', 'data', 'projects');
const projectPath = (id) => path.join(projectsDir, `${id}.json`);

const team = {
  id: 'crew-test-team',
  name: 'Crew Test Team',
  leadIndex: 0,
  members: [
    {
      name: 'Lead',
      role: 'Lead',
      adapter: 'gemini',
      model: 'gemini-test',
      skills: ['sprint-planner'],
    },
    {
      name: 'Engineer',
      role: 'Engineer',
      adapter: 'codex',
      model: 'codex-test',
      skills: ['staff-engineer'],
    },
  ],
};

function cleanupProject(project) {
  if (project && project.id && fs.existsSync(projectPath(project.id))) {
    fs.unlinkSync(projectPath(project.id));
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-test-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@test.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

test('buildPlanPrompt includes roster and JSON-only instructions', () => {
  const prompt = crew.buildPlanPrompt(team, 'Ship the feature');
  assert.match(prompt, /Output ONLY JSON/);
  assert.match(prompt, /ownerIndex/);
  assert.match(prompt, /index: 0/);
  assert.match(prompt, /adapter: gemini/);
  assert.match(prompt, /skills: sprint-planner/);
  assert.match(prompt, /Ship the feature/);
});

test('parsePlan returns normalized tasks from valid JSON', () => {
  const plan = crew.parsePlan(
    JSON.stringify({
      tasks: [
        {
          title: 'Plan',
          objective: 'Define scope',
          ownerIndex: 0,
          skillId: 'sprint-planner',
          mode: 'plan',
          dependsOn: [],
        },
        {
          title: 'Build',
          objective: 'Implement scope',
          ownerIndex: 1,
          skillId: 'staff-engineer',
          mode: 'edit',
          dependsOn: [0],
        },
      ],
    }),
    team
  );

  assert.deepEqual(plan, [
    {
      title: 'Plan',
      objective: 'Define scope',
      ownerIndex: 0,
      skillId: 'sprint-planner',
      mode: 'plan',
      dependsOn: [],
    },
    {
      title: 'Build',
      objective: 'Implement scope',
      ownerIndex: 1,
      skillId: 'staff-engineer',
      mode: 'edit',
      dependsOn: [0],
    },
  ]);
});

test('parsePlan extracts fenced JSON and falls back unknown skillId', () => {
  const text = [
    'Here is the plan:',
    '```json',
    '{"tasks":[{"title":"Build","objective":"Implement","ownerIndex":1,"skillId":"not-real","mode":"edit","dependsOn":[]}]}',
    '```',
  ].join('\n');

  const plan = crew.parsePlan(text, team);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].skillId, 'staff-engineer');
});

test('parsePlan rejects unparseable or invalid plans', () => {
  assert.throws(() => crew.parsePlan('not json at all', team), /unable to parse crew plan/);
  assert.throws(
    () =>
      crew.parsePlan(
        '{"tasks":[{"title":"Bad","objective":"Bad","ownerIndex":7,"skillId":"staff-engineer","mode":"edit","dependsOn":[]}]}',
        team
      ),
    /invalid ownerIndex/
  );
  assert.throws(
    () =>
      crew.parsePlan(
        '{"tasks":[{"title":"Bad","objective":"Bad","ownerIndex":0,"skillId":"staff-engineer","mode":"edit","dependsOn":[4]}]}',
        team
      ),
    /invalid dependency index/
  );
});

test('planObjective creates a project and resolves task dependencies', async () => {
  let project;
  try {
    const runAgent = async (adapterId, spec, onEvent) => {
      assert.equal(adapterId, 'gemini');
      assert.equal(spec.mode, 'plan');
      onEvent({ type: 'message', text: 'planning' });
      return {
        finalText: JSON.stringify({
          tasks: [
            {
              title: 'Design',
              objective: 'Design it',
              ownerIndex: 0,
              skillId: 'sprint-planner',
              mode: 'plan',
              dependsOn: [],
            },
            {
              title: 'Build',
              objective: 'Build it',
              ownerIndex: 1,
              skillId: 'staff-engineer',
              mode: 'edit',
              dependsOn: [0],
            },
          ],
        }),
      };
    };

    const result = await crew.planObjective({ team, objective: 'Ship orchestration' }, runAgent);
    project = result.project;

    assert.equal(result.project.objective, 'Ship orchestration');
    assert.equal(result.project.teamId, team.id);
    assert.equal(result.project.leadName, 'Lead');
    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].owner, 'Lead');
    assert.equal(result.tasks[1].owner, 'Engineer');
    assert.deepEqual(result.tasks[1].dependencies, [result.tasks[0].id]);
    assert.equal(tasks.getTask(project.id, result.tasks[1].id).skillId, 'staff-engineer');
  } finally {
    cleanupProject(project);
  }
});

test('executeTask in plan mode adds a markdown artifact and completes', async () => {
  let project;
  const events = [];
  try {
    project = tasks.createProject({ objective: 'Plan mode', teamId: team.id, leadName: 'Lead' });
    const task = tasks.createTask(project.id, {
      title: 'Write notes',
      objective: 'Produce notes',
      owner: 'Planner',
      mode: 'plan',
    });
    tasks.updateTask(project.id, task.id, { skillId: 'sprint-planner' });

    const runAgent = async (adapterId, spec, onEvent) => {
      assert.equal(adapterId, 'gemini');
      assert.equal(spec.mode, 'plan');
      onEvent({ type: 'message', text: 'notes from planner' });
      return { finalText: 'final notes' };
    };

    const updated = await crew.executeTask(
      {
        wsPath: process.cwd(),
        projectId: project.id,
        taskId: task.id,
        member: { adapter: 'gemini', model: 'gemini-test', skills: ['sprint-planner'] },
      },
      (event) => events.push(event),
      runAgent
    );

    assert.equal(updated.status, 'complete');
    assert.equal(events.length, 1);
    const reloaded = tasks.getTask(project.id, task.id);
    assert.equal(reloaded.artifacts.length, 1);
    assert.equal(reloaded.artifacts[0].type, 'markdown');
    assert.equal(reloaded.artifacts[0].content, 'final notes');
    assert.equal(
      reloaded.logs.some((log) => log.text === 'notes from planner'),
      true
    );
  } finally {
    cleanupProject(project);
  }
});

test('executeTask in edit mode creates a worktree and captures a diff', async () => {
  const repo = makeRepo();
  let project;
  try {
    project = tasks.createProject({ objective: 'Edit mode', teamId: team.id, leadName: 'Lead' });
    const task = tasks.createTask(project.id, {
      title: 'Edit file',
      objective: 'Create agent output',
      owner: 'Engineer',
      mode: 'edit',
    });
    tasks.updateTask(project.id, task.id, { skillId: 'staff-engineer' });

    const runAgent = async (adapterId, spec, onEvent) => {
      assert.equal(adapterId, 'codex');
      assert.equal(spec.mode, 'edit');
      fs.writeFileSync(path.join(spec.cwd, 'agent-output.txt'), 'hello from crew\n');
      git(spec.cwd, ['add', 'agent-output.txt']);
      onEvent({ type: 'message', text: 'created file' });
      return { finalText: 'done' };
    };

    const updated = await crew.executeTask(
      {
        wsPath: repo,
        projectId: project.id,
        taskId: task.id,
        member: { adapter: 'codex', model: 'codex-test', skills: ['staff-engineer'] },
      },
      null,
      runAgent
    );

    assert.equal(updated.status, 'complete');
    const reloaded = tasks.getTask(project.id, task.id);
    assert.ok(reloaded.worktree.path);
    assert.equal(reloaded.artifacts.length, 1);
    assert.equal(reloaded.artifacts[0].type, 'diff');
    assert.match(reloaded.artifacts[0].content, /agent-output\.txt/);
    assert.match(reloaded.artifacts[0].content, /hello from crew/);
  } finally {
    cleanupProject(project);
    cleanupDir(repo);
  }
});
