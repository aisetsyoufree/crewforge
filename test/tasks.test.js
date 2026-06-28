const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const tasks = require('../lib/tasks');

const projectsDir = path.join(__dirname, '..', 'data', 'projects');
const projectPath = (id) => path.join(projectsDir, `${id}.json`);

test('projects and tasks persist with dependency lifecycle', () => {
  let project;
  try {
    project = tasks.createProject({
      objective: 'Ship durable tasks',
      teamId: 'team-alpha',
      leadName: 'Lead',
    });

    assert.strictEqual(project.status, 'planning');
    assert.strictEqual(project.phase, 'planning');

    const taskA = tasks.createTask(project.id, {
      title: 'A',
      objective: 'First task',
      owner: 'Alice',
      mode: 'edit',
    });
    const taskB = tasks.createTask(project.id, {
      title: 'B',
      objective: 'Second task',
      owner: 'Bob',
      dependencies: [taskA.id],
      mode: 'plan',
    });

    assert.deepStrictEqual(
      tasks.readyTasks(project.id).map((task) => task.id),
      [taskA.id]
    );

    tasks.setTaskStatus(project.id, taskA.id, 'approved');
    assert.deepStrictEqual(
      tasks.readyTasks(project.id).map((task) => task.id),
      [taskB.id]
    );

    tasks.addArtifact(project.id, taskB.id, {
      type: 'file',
      name: 'notes',
      path: 'notes.md',
      content: 'done',
    });
    tasks.addLog(project.id, taskB.id, { level: 'info', text: 'implemented' });
    tasks.setReview(project.id, taskB.id, { verdict: 'request-changes', notes: 'tighten tests' });
    tasks.setTaskStatus(project.id, taskB.id, 'running');

    const reloaded = JSON.parse(fs.readFileSync(projectPath(project.id), 'utf8'));
    const persistedB = reloaded.tasks[taskB.id];
    assert.strictEqual(persistedB.status, 'running');
    assert.deepStrictEqual(
      persistedB.artifacts.map((artifact) => artifact.name),
      ['notes']
    );
    assert.strictEqual(persistedB.artifacts[0].createdAt.length > 0, true);
    assert.deepStrictEqual(
      persistedB.logs.map((log) => [log.level, log.text]),
      [['info', 'implemented']]
    );
    assert.strictEqual(persistedB.logs[0].ts.length > 0, true);
    assert.deepStrictEqual(persistedB.reviewResult, {
      verdict: 'request-changes',
      notes: 'tighten tests',
    });

    const loadedTask = tasks.getTask(project.id, taskB.id);
    assert.strictEqual(loadedTask.status, 'running');
    assert.strictEqual(tasks.getProject(project.id).taskIds.length, 2);
    assert.deepStrictEqual(
      tasks.listTasks(project.id).map((task) => task.id),
      [taskA.id, taskB.id]
    );
  } finally {
    if (project && project.id && fs.existsSync(projectPath(project.id))) {
      fs.unlinkSync(projectPath(project.id));
    }
  }
});

test('invalid ids are rejected', () => {
  assert.throws(
    () => tasks.getProject('../bad'),
    (err) => err instanceof Error && /invalid project id/.test(err.message)
  );
  assert.throws(
    () => tasks.getTask('project-ok', '../bad'),
    (err) => err instanceof Error && /invalid task id/.test(err.message)
  );
});
