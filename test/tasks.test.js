const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const tasks = require('../lib/tasks');

const projectsDir = path.join(require('../lib/data_dir'), 'projects');
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
    assert.equal(persistedB.reviewResult.verdict, 'REQUEST_CHANGES');
    assert.equal(persistedB.reviewResult.parseStatus, 'ok');
    assert.equal(persistedB.reviewResult.notes, 'tighten tests');

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

test('appendEvidence caps at 100 newest entries on every append path', () => {
  let project;
  try {
    project = tasks.createProject({ objective: 'evidence cap', teamId: 't', leadName: 'L' });
    const task = tasks.createTask(project.id, {
      title: 'T',
      objective: 'o',
      owner: 'A',
      mode: 'edit',
    });
    for (let i = 0; i < 120; i++) {
      tasks.appendEvidence(project.id, task.id, { kind: 'note', n: i });
    }
    const reloaded = tasks.getTask(project.id, task.id);
    assert.equal(reloaded.evidence.length, tasks.MAX_EVIDENCE_ENTRIES);
    assert.equal(reloaded.evidence[0].n, 20);
    assert.equal(reloaded.evidence[99].n, 119);

    // updateTask path also caps when evidence is replaced wholesale.
    const oversized = Array.from({ length: 150 }, (_, i) => ({ kind: 'note', n: i, ts: 'x' }));
    const updated = tasks.updateTask(project.id, task.id, { evidence: oversized });
    assert.equal(updated.evidence.length, 100);
    assert.equal(updated.evidence[0].n, 50);
    assert.equal(updated.evidence[99].n, 149);
  } finally {
    if (project && project.id && fs.existsSync(projectPath(project.id))) {
      fs.unlinkSync(projectPath(project.id));
    }
  }
});

test('mutateProjectFile serializes nested reentrant updates without lost writes', () => {
  let project;
  try {
    project = tasks.createProject({ objective: 'lock', teamId: 't', leadName: 'L' });
    const task = tasks.createTask(project.id, {
      title: 'T',
      objective: 'o',
      owner: 'A',
      mode: 'plan',
    });

    tasks.mutateProjectFile(project.id, (data) => {
      data.tasks[task.id].statusReason = 'outer';
      // Nested mutation must see the same in-memory object and not clobber on exit.
      tasks.appendEvidence(project.id, task.id, { kind: 'note', from: 'inner' });
      data.tasks[task.id].statusReason = 'outer-after-inner';
      return true;
    });

    const reloaded = tasks.getTask(project.id, task.id);
    assert.equal(reloaded.statusReason, 'outer-after-inner');
    assert.equal(
      reloaded.evidence.some((e) => e.from === 'inner'),
      true
    );

    // Sequential appends accumulate (no lost-write from separate RMW).
    tasks.appendEvidence(project.id, task.id, { kind: 'note', from: 'a' });
    tasks.appendEvidence(project.id, task.id, { kind: 'note', from: 'b' });
    const again = tasks.getTask(project.id, task.id);
    const kinds = again.evidence.map((e) => e.from).filter(Boolean);
    assert.ok(kinds.includes('a') && kinds.includes('b') && kinds.includes('inner'));
  } finally {
    if (project && project.id && fs.existsSync(projectPath(project.id))) {
      fs.unlinkSync(projectPath(project.id));
    }
  }
});
