const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const {
  makePlanPrompt,
  parsePlan,
  runApproved,
  runPlan,
  validateSteps,
} = require('../lib/orchestrator');
const { inspect, apply } = require('../lib/worktree');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-orch-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@test.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function cleanupRepo(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

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

function runPlanHarness(adapters, overrides = {}) {
  const events = [];
  const store = {
    append(ws, sid, event) {
      events.push({ ws, sid, event });
    },
  };
  const team = overrides.team || {
    leadIndex: 0,
    members: [{ adapter: 'codex', model: 'gpt-5.5-codex', role: 'Lead' }],
  };
  const run = runPlan({
    adapters,
    buildContext: async (_ws, _sid, prompt) => prompt,
    store,
    team,
    prompt: 'Build a widget',
    ws: 'ws-1',
    sid: 'sid-1',
    cwd: null,
    ...overrides,
  });
  return { run, events };
}

test('runPlan appends plan and plan-ready status for a parseable streamed plan', async () => {
  const adapters = {
    async run(_adapter, _opts, emit) {
      emit({ type: 'message', text: '{"steps":[{"memberIndex":0,"task":"do it"}]}' });
      return { finalText: '' };
    },
  };
  const { run, events } = runPlanHarness(adapters);

  const steps = await run;

  assert.deepStrictEqual(steps, [{ memberIndex: 0, task: 'do it' }]);
  assert.ok(events.some(({ event }) => event.type === 'plan'));
  assert.ok(
    events.some(({ event }) => event.type === 'status' && /plan ready/.test(event.text || ''))
  );
});

test('runPlan rejects on late adapter result.error even with parseable streamed plan text', async () => {
  const adapters = {
    async run(_adapter, _opts, emit) {
      emit({ type: 'message', text: '{"steps":[{"memberIndex":0,"task":"do it"}]}' });
      return { finalText: '', error: 'cli exited with code 1' };
    },
  };
  const { run, events } = runPlanHarness(adapters);

  await assert.rejects(
    run,
    (err) => err instanceof Error && err.message === 'cli exited with code 1'
  );
  assert.ok(!events.some(({ event }) => event.type === 'plan'));
  assert.ok(
    !events.some(({ event }) => event.type === 'status' && /plan ready/.test(event.text || ''))
  );
});

test('runPlan rejects on cancelled result even with parseable streamed plan text', async () => {
  const adapters = {
    async run(_adapter, _opts, emit) {
      emit({ type: 'message', text: '{"steps":[{"memberIndex":0,"task":"do it"}]}' });
      return { finalText: '', cancelled: true };
    },
  };
  const { run, events } = runPlanHarness(adapters);

  await assert.rejects(run, (err) => err instanceof Error && /cancelled/.test(err.message));
  assert.ok(!events.some(({ event }) => event.type === 'plan'));
  assert.ok(
    !events.some(({ event }) => event.type === 'status' && /plan ready/.test(event.text || ''))
  );
});

test('runApproved respects read-only approval mode for edit-capable members', async () => {
  const calls = [];
  const events = [];
  const adapters = {
    catalog() {
      return [{ id: 'codex', canEdit: true }];
    },
    async run(adapter, opts, emit) {
      calls.push({ adapter, opts });
      emit({ type: 'message', text: 'done' });
    },
  };
  const store = {
    append(ws, sid, event) {
      events.push({ ws, sid, event });
    },
  };

  await runApproved({
    adapters,
    buildContext: async (_ws, _sid, prompt) => `context: ${prompt}`,
    store,
    team: { members: [{ adapter: 'codex', model: 'gpt-5.5-codex', role: 'Engineer' }] },
    steps: [{ memberIndex: 0, task: 'review only' }],
    approvalMode: 'plan',
    ws: 'ws-1',
    sid: 'sid-1',
    cwd: '/tmp/workspace',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].adapter, 'codex');
  assert.equal(calls[0].opts.mode, 'plan');
  assert.ok(events.some(({ event }) => /read-only mode/.test(event.text || '')));
});

function runApprovedHarness(adapters, steps, overrides = {}) {
  const events = [];
  const store = {
    append(ws, sid, event) {
      events.push({ ws, sid, event });
    },
  };
  const team = overrides.team || {
    members: [
      { adapter: 'codex', model: 'gpt-5.5-codex', role: 'Engineer' },
      { adapter: 'claude', model: 'sonnet', role: 'Reviewer' },
    ],
  };
  const repo = overrides.cwd || makeRepo();
  const ownsRepo = !overrides.cwd;
  const run = runApproved({
    adapters,
    buildContext: async (_ws, _sid, prompt) => `context: ${prompt}`,
    store,
    team,
    steps,
    ws: 'ws-1',
    sid: 'sid-1',
    cwd: repo,
    approvalMode: 'edit',
    ...overrides,
  }).finally(() => {
    if (ownsRepo) cleanupRepo(repo);
  });
  return { run, events, repo, ownsRepo };
}

test('runApproved propagates adapter error results', async () => {
  const adapters = {
    catalog() {
      return [
        { id: 'codex', canEdit: true },
        { id: 'claude', canEdit: false },
      ];
    },
    async run(adapter) {
      if (adapter === 'codex') return { finalText: '', error: 'cli exited with code 1' };
      return { finalText: 'ok' };
    },
  };

  const { run, events } = runApprovedHarness(adapters, [
    { memberIndex: 0, task: 'first' },
    { memberIndex: 1, task: 'review only' },
  ]);

  await assert.rejects(
    run,
    (err) => err instanceof Error && err.message === 'cli exited with code 1'
  );

  const failedStep = events.find(({ event }) => event.type === 'failed-step');
  assert.ok(failedStep);
  assert.equal(failedStep.event.kind, 'system');
  assert.equal(failedStep.event.actor, 'codex');
  assert.deepStrictEqual(failedStep.event.meta, {
    step: 1,
    total: 2,
    memberIndex: 0,
    role: 'Engineer',
    model: 'gpt-5.5-codex',
    error: 'cli exited with code 1',
  });
  assert.ok(
    events.some(
      ({ event }) =>
        event.type === 'status' && event.meta && event.meta.failed && event.meta.step === 1
    )
  );
});

test('runApproved fails fast and does not run later steps after adapter error', async () => {
  const calls = [];
  const adapters = {
    catalog() {
      return [
        { id: 'codex', canEdit: true },
        { id: 'claude', canEdit: false },
      ];
    },
    async run(adapter) {
      calls.push(adapter);
      if (adapter === 'codex') return { finalText: '', error: true };
      return { finalText: 'ok' };
    },
  };

  const { run, events } = runApprovedHarness(adapters, [
    { memberIndex: 0, task: 'first' },
    { memberIndex: 1, task: 'review only' },
  ]);

  await assert.rejects(run, (err) => err instanceof Error && err.message === 'agent run failed');
  assert.deepStrictEqual(calls, ['codex']);
  assert.ok(events.some(({ event }) => event.type === 'failed-step' && event.actor === 'codex'));
  assert.ok(
    events.some(({ event }) =>
      /Team delegation finished: 0 succeeded, 1 failed/.test(event.text || '')
    )
  );
});

test('runApproved isolates edit-capable steps in worktrees and pauses for integration', async () => {
  const repo = makeRepo();
  try {
    const calls = [];
    const events = [];
    const adapters = {
      catalog() {
        return [
          { id: 'codex', canEdit: true },
          { id: 'claude', canEdit: false },
        ];
      },
      async run(adapter, opts) {
        calls.push({ adapter, cwd: opts.cwd, mode: opts.mode });
        if (adapter === 'codex' && opts.mode === 'edit') {
          const target = path.join(opts.cwd, 'from-agent.txt');
          fs.writeFileSync(target, 'agent edit');
          git(opts.cwd, ['add', 'from-agent.txt']);
        }
        return { finalText: 'ok' };
      },
    };
    const store = {
      append(ws, sid, event) {
        events.push({ ws, sid, event });
      },
    };

    const result = await runApproved({
      adapters,
      buildContext: async (_ws, _sid, prompt) => prompt,
      store,
      team: {
        members: [
          { adapter: 'codex', model: 'gpt-5.5-codex', role: 'Engineer' },
          { adapter: 'claude', model: 'sonnet', role: 'Reviewer' },
        ],
      },
      steps: [
        { memberIndex: 0, task: 'implement' },
        { memberIndex: 1, task: 'review' },
      ],
      approvalMode: 'edit',
      ws: 'ws-1',
      sid: 'sid-1',
      cwd: repo,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, 'edit');
    assert.notEqual(calls[0].cwd, repo);
    assert.ok(
      !fs.existsSync(path.join(repo, 'from-agent.txt')),
      'main checkout must stay untouched'
    );

    const pending = events.find(({ event }) => event.type === 'pending-integration');
    assert.ok(pending);
    assert.equal(pending.event.meta.awaitingApproval, true);
    assert.ok(pending.event.meta.worktreeId);
    assert.ok(pending.event.meta.diff.includes('from-agent.txt'));
    assert.equal(pending.event.meta.continuation.version, 1);
    assert.deepEqual(pending.event.meta.continuation.remainingSteps, [
      { memberIndex: 1, task: 'review' },
    ]);
    assert.equal(pending.event.meta.continuation.nextStepOffset, 1);
    assert.equal(pending.event.meta.continuation.totalSteps, 2);

    assert.deepStrictEqual(result, {
      paused: true,
      awaitingIntegration: true,
      worktreeId: pending.event.meta.worktreeId,
      step: 1,
      total: 2,
    });

    const info = inspect(repo, pending.event.meta.worktreeId);
    assert.ok(info.diff.includes('from-agent.txt'));
    apply(repo, pending.event.meta.worktreeId);
    assert.equal(fs.readFileSync(path.join(repo, 'from-agent.txt'), 'utf8'), 'agent edit');
  } finally {
    cleanupRepo(repo);
  }
});

test('runApproved continuation preserves original step numbers and can pause again', async () => {
  const repo = makeRepo();
  try {
    const calls = [];
    const events = [];
    const adapters = {
      catalog() {
        return [
          { id: 'claude', canEdit: false },
          { id: 'codex', canEdit: true },
        ];
      },
      async run(adapter, opts) {
        calls.push({ adapter, cwd: opts.cwd, mode: opts.mode });
        if (adapter === 'codex') {
          fs.writeFileSync(path.join(opts.cwd, 'second-edit.txt'), 'second edit');
          git(opts.cwd, ['add', 'second-edit.txt']);
        }
        return { finalText: 'ok' };
      },
    };
    const store = {
      append(ws, sid, event) {
        events.push({ ws, sid, event });
      },
    };

    const result = await runApproved({
      adapters,
      buildContext: async (_ws, _sid, prompt) => prompt,
      store,
      team: {
        id: 'snapshot-team',
        members: [
          { adapter: 'claude', model: 'sonnet', role: 'Analyst' },
          { adapter: 'codex', model: 'gpt-5.5-codex', role: 'Engineer' },
        ],
      },
      steps: [
        { memberIndex: 0, task: 'analyze' },
        { memberIndex: 1, task: 'implement next' },
      ],
      approvalMode: 'edit',
      ws: 'ws-1',
      sid: 'sid-1',
      cwd: repo,
      stepOffset: 1,
      totalSteps: 3,
    });

    assert.equal(calls.length, 2);
    const pending = events.find(({ event }) => event.type === 'pending-integration');
    assert.equal(pending.event.meta.step, 3);
    assert.equal(pending.event.meta.total, 3);
    assert.deepEqual(pending.event.meta.continuation.remainingSteps, []);
    assert.deepEqual(result, {
      paused: true,
      awaitingIntegration: true,
      worktreeId: pending.event.meta.worktreeId,
      step: 3,
      total: 3,
    });
  } finally {
    cleanupRepo(repo);
  }
});

test('runApproved retains a cancelled worktree with changes and reports it for review', async () => {
  const repo = makeRepo();
  try {
    const events = [];
    const store = {
      append(ws, sid, event) {
        events.push({ ws, sid, event });
      },
    };
    const controller = new AbortController();
    const adapters = {
      catalog() {
        return [{ id: 'codex', canEdit: true }];
      },
      async run(_adapter, opts) {
        fs.writeFileSync(path.join(opts.cwd, 'from-agent.txt'), 'agent edit');
        git(opts.cwd, ['add', 'from-agent.txt']);
        controller.abort();
        return { finalText: 'ok' };
      },
    };

    await runApproved({
      adapters,
      buildContext: async (_ws, _sid, prompt) => prompt,
      store,
      team: { members: [{ adapter: 'codex', model: 'gpt-5.5-codex', role: 'Engineer' }] },
      steps: [{ memberIndex: 0, task: 'implement' }],
      approvalMode: 'edit',
      ws: 'ws-1',
      sid: 'sid-1',
      cwd: repo,
      signal: controller.signal,
    });

    assert.ok(
      !fs.existsSync(path.join(repo, 'from-agent.txt')),
      'main checkout must stay untouched'
    );

    const cancelled = events.find(({ event }) => event.type === 'cancelled-worktree');
    assert.ok(cancelled, 'expected a cancelled-worktree event');
    assert.equal(cancelled.event.actor, 'codex');
    assert.equal(cancelled.event.meta.step, 1);
    assert.equal(cancelled.event.meta.total, 1);
    assert.equal(cancelled.event.meta.memberIndex, 0);
    assert.equal(cancelled.event.meta.role, 'Engineer');
    assert.equal(cancelled.event.meta.cancelled, true);
    assert.ok(cancelled.event.meta.worktreeId);
    assert.ok(cancelled.event.meta.branch);
    assert.ok(cancelled.event.meta.diff.includes('from-agent.txt'));
    assert.equal(cancelled.event.meta.diffSummary.empty, false);

    // Worktree is retained on disk with the diff intact for Review/Reject.
    const info = inspect(repo, cancelled.event.meta.worktreeId);
    assert.ok(info.diff.includes('from-agent.txt'));

    assert.ok(!events.some(({ event }) => event.type === 'pending-integration'));
    assert.ok(!events.some(({ event }) => event.type === 'failed-step'));
    assert.ok(
      !events.some(({ event }) => event.type === 'status' && /finished step/.test(event.text || ''))
    );
  } finally {
    cleanupRepo(repo);
  }
});

test('runApproved safely removes an empty worktree left behind by a cancelled step', async () => {
  const repo = makeRepo();
  try {
    const events = [];
    const store = {
      append(ws, sid, event) {
        events.push({ ws, sid, event });
      },
    };
    const controller = new AbortController();
    let worktreeDir = null;
    const adapters = {
      catalog() {
        return [{ id: 'codex', canEdit: true }];
      },
      async run(_adapter, opts) {
        worktreeDir = opts.cwd;
        controller.abort();
        return { finalText: 'ok' };
      },
    };

    await runApproved({
      adapters,
      buildContext: async (_ws, _sid, prompt) => prompt,
      store,
      team: { members: [{ adapter: 'codex', model: 'gpt-5.5-codex', role: 'Engineer' }] },
      steps: [{ memberIndex: 0, task: 'implement' }],
      approvalMode: 'edit',
      ws: 'ws-1',
      sid: 'sid-1',
      cwd: repo,
      signal: controller.signal,
    });

    assert.ok(worktreeDir, 'expected an isolated worktree to have been created');
    assert.ok(!fs.existsSync(worktreeDir), 'empty worktree must be removed, never left orphaned');
    assert.ok(!events.some(({ event }) => event.type === 'cancelled-worktree'));
    assert.ok(!events.some(({ event }) => event.type === 'pending-integration'));
    assert.ok(!events.some(({ event }) => event.type === 'failed-step'));
    assert.ok(
      !events.some(({ event }) => event.type === 'status' && /finished step/.test(event.text || ''))
    );
  } finally {
    cleanupRepo(repo);
  }
});

test('runApproved retains a worktree cancelled mid-run (adapter throws after abort) for review', async () => {
  const repo = makeRepo();
  try {
    const events = [];
    const store = {
      append(ws, sid, event) {
        events.push({ ws, sid, event });
      },
    };
    const controller = new AbortController();
    const adapters = {
      catalog() {
        return [{ id: 'codex', canEdit: true }];
      },
      async run(_adapter, opts) {
        fs.writeFileSync(path.join(opts.cwd, 'from-agent.txt'), 'agent edit');
        git(opts.cwd, ['add', 'from-agent.txt']);
        controller.abort();
        throw new Error('aborted');
      },
    };

    await runApproved({
      adapters,
      buildContext: async (_ws, _sid, prompt) => prompt,
      store,
      team: { members: [{ adapter: 'codex', model: 'gpt-5.5-codex', role: 'Engineer' }] },
      steps: [{ memberIndex: 0, task: 'implement' }],
      approvalMode: 'edit',
      ws: 'ws-1',
      sid: 'sid-1',
      cwd: repo,
      signal: controller.signal,
    });

    assert.ok(
      !fs.existsSync(path.join(repo, 'from-agent.txt')),
      'main checkout must stay untouched'
    );
    const cancelled = events.find(({ event }) => event.type === 'cancelled-worktree');
    assert.ok(cancelled, 'expected a cancelled-worktree event on the throw path too');
    assert.ok(cancelled.event.meta.diff.includes('from-agent.txt'));
    assert.ok(!events.some(({ event }) => event.type === 'failed-step'));
  } finally {
    cleanupRepo(repo);
  }
});

test('runApproved keeps plan approval mode on the main workspace', async () => {
  const repo = makeRepo();
  try {
    const calls = [];
    const adapters = {
      catalog() {
        return [{ id: 'codex', canEdit: true }];
      },
      async run(_adapter, opts) {
        calls.push(opts);
        return { finalText: 'ok' };
      },
    };
    const store = { append() {} };

    await runApproved({
      adapters,
      buildContext: async (_ws, _sid, prompt) => prompt,
      store,
      team: { members: [{ adapter: 'codex', model: 'gpt-5.5-codex', role: 'Engineer' }] },
      steps: [{ memberIndex: 0, task: 'analyze only' }],
      approvalMode: 'plan',
      ws: 'ws-1',
      sid: 'sid-1',
      cwd: repo,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, 'plan');
    assert.equal(calls[0].cwd, repo);
  } finally {
    cleanupRepo(repo);
  }
});
