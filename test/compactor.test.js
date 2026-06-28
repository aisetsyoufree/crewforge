const assert = require('node:assert');
const test = require('node:test');

const { compact } = require('../lib/compactor');

function fakeEvents(n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      events.push({
        kind: 'user',
        type: 'message',
        text: `User question number ${i} with enough padding to exercise compaction logic.`,
      });
    } else {
      events.push({
        kind: 'agent',
        actor: 'claude',
        type: 'message',
        text: `Agent answer number ${i} explaining the approach in some detail for context growth.`,
        meta: { final: true },
      });
    }
    if (i === 3)
      events.push({
        kind: 'agent',
        actor: 'claude',
        type: 'file_change',
        text: 'edited lib/foo.js',
        meta: { file: 'lib/foo.js' },
      });
    if (i === 7)
      events.push({
        kind: 'agent',
        actor: 'codex',
        type: 'file_change',
        text: 'edited lib/bar.js',
        meta: { file: 'lib/bar.js' },
      });
  }
  return events;
}

test('compact keeps recent turns verbatim and summarizes older context', () => {
  const keepRecent = 8;
  const maxChars = 1500;
  const events = fakeEvents(20);
  const lastTurn =
    'Agent answer number 19 explaining the approach in some detail for context growth.';
  const out = compact(events, { keepRecent, maxChars });

  assert.ok(out.length <= maxChars, `output length ${out.length} exceeds maxChars`);
  assert.ok(out.includes(lastTurn), 'most recent turn should appear verbatim');
  assert.ok(out.includes('Earlier context'), 'should summarize when turns exceed keepRecent');
  assert.ok(out.includes('12 earlier exchanges'), 'summary should count older exchanges');
  assert.ok(
    out.includes('Files touched:'),
    'should list files touched when file_change events exist'
  );
  assert.ok(out.includes('lib/foo.js'), 'should include touched file paths');
  assert.ok(out.includes('lib/bar.js'), 'should include all touched file paths');
});

test('compact returns empty string when there is no history', () => {
  assert.strictEqual(compact([]), '');
  assert.strictEqual(compact([{ kind: 'system', type: 'status', text: 'running' }]), '');
});

test('compact returns verbatim transcript when under maxChars', () => {
  const events = fakeEvents(4);
  const out = compact(events, { keepRecent: 8, maxChars: 6000 });
  assert.ok(!out.includes('Earlier context'));
  assert.ok(out.includes('User question number 0'));
  assert.ok(out.includes('Agent answer number 3'));
});
