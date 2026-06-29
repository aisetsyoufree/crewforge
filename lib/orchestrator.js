'use strict';

const skills = require('./skills');

function memberLabel(member, index) {
  const skill = member.skillId ? skills.get(member.skillId) : null;
  const role = member.role || (skill && skill.role) || '';
  const skillText = skill ? ` skill=${skill.name}` : '';
  return `${index}: ${member.adapter}${member.model ? ' - ' + member.model : ''}${role ? ' (' + role + ')' : ''}${skillText}`;
}

function memberSkillNotes(team) {
  const notes = [];
  for (const member of team.members || []) {
    if (!member.skillId) continue;
    const skill = skills.get(member.skillId);
    if (!skill) continue;
    notes.push(
      `- ${skill.name}: ${skill.role}. Expected outputs: ${(skill.expectedOutputs || []).join('; ')}.`
    );
  }
  return [...new Set(notes)].join('\n');
}

function makePlanPrompt(team, prompt) {
  const roster = (team.members || []).map((m, i) => memberLabel(m, i)).join('\n');
  const skillNotes = memberSkillNotes(team);
  return [
    'You are the lead for a multi-agent team.',
    'Create a delegation plan for the user request.',
    'Use member roles and skills to choose the best owner for each step.',
    'Return ONLY JSON shaped exactly like: {"steps":[{"memberIndex":0,"task":"..."}]}',
    'Use memberIndex values from this roster:',
    roster,
    skillNotes ? '\nSkill guidance:\n' + skillNotes : '',
    '',
    'User request:',
    prompt,
  ].join('\n');
}

function fencedBodies(text) {
  const out = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return out;
}

function objectCandidates(text) {
  const out = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

function parsePlan(text, memberCount) {
  const raw = String(text || '').trim();
  const candidates = [raw, ...fencedBodies(raw), ...objectCandidates(raw)];
  let lastError = null;

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      const steps = validateSteps(parsed.steps, memberCount);
      return steps;
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(`unable to parse delegation plan${lastError ? ': ' + lastError.message : ''}`);
}

function validateSteps(steps, memberCount) {
  if (!Array.isArray(steps)) throw new Error('plan.steps must be an array');
  return steps.map((s, i) => {
    const memberIndex = Number(s && s.memberIndex);
    const task = String((s && s.task) || '').trim();
    if (!Number.isInteger(memberIndex) || memberIndex < 0 || memberIndex >= memberCount) {
      throw new Error(`invalid memberIndex for step ${i + 1}`);
    }
    if (!task) throw new Error(`missing task for step ${i + 1}`);
    return { memberIndex, task };
  });
}

async function runPlan({ adapters, buildContext, store, team, prompt, ws, sid, cwd, signal }) {
  const lead = team.members[team.leadIndex];
  if (!lead) throw new Error('team lead not found');
  if (signal && signal.aborted) return [];

  const planPrompt = makePlanPrompt(team, prompt);
  const fullPrompt = await buildContext(ws, sid, planPrompt, {
    contextMode: team.contextMode,
    model: lead.model,
  });
  const chunks = [];

  store.append(ws, sid, {
    kind: 'system',
    actor: lead.adapter,
    type: 'status',
    text: `${lead.adapter}${lead.model ? ' - ' + lead.model : ''} planning team delegation...`,
    meta: { running: true },
  });

  const result = await adapters.run(
    lead.adapter,
    { prompt: fullPrompt, model: lead.model, cwd, mode: 'plan', signal },
    (e) => {
      if (e.type === 'message' && e.text) chunks.push(e.text);
      if (e.type === 'error') {
        store.append(ws, sid, { kind: 'system', actor: lead.adapter, type: 'error', text: e.text });
      }
    }
  );
  if (signal && signal.aborted) return [];

  const text = (result && result.finalText) || chunks.join('\n');
  const steps = parsePlan(text, team.members.length);
  store.append(ws, sid, {
    kind: 'system',
    actor: 'team',
    type: 'plan',
    text: 'Team delegation plan proposed',
    meta: { steps },
  });
  store.append(ws, sid, {
    kind: 'system',
    actor: lead.adapter,
    type: 'status',
    text: `${lead.adapter} plan ready`,
    meta: { done: true },
  });
  return steps;
}

function adapterCanEdit(adapters, adapterId) {
  const entry = adapters.catalog().find((a) => a.id === adapterId);
  return entry ? !!entry.canEdit : false;
}

async function runApproved({ adapters, buildContext, store, team, steps, ws, sid, cwd, signal }) {
  const plan = validateSteps(steps, team.members.length);
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < plan.length; i++) {
    if (signal && signal.aborted) return;
    const step = plan[i];
    const member = team.members[step.memberIndex];
    const role = member.role || 'agent';
    const canEdit = adapterCanEdit(adapters, member.adapter);
    const mode = canEdit ? 'edit' : 'plan';

    store.append(ws, sid, {
      kind: 'system',
      actor: member.adapter,
      type: 'status',
      text: `${member.adapter}${member.model ? ' - ' + member.model : ''} (${role}) running step ${i + 1}/${plan.length}...`,
      meta: { running: true, step: i + 1 },
    });

    if (!canEdit) {
      store.append(ws, sid, {
        kind: 'system',
        actor: member.adapter,
        type: 'status',
        text: `${member.adapter} is text-only; ran step as analysis (cannot edit files)`,
      });
    }

    try {
      const memberObjective = member.skillId
        ? skills.buildSkillPrompt(member.skillId, {
            objective: step.task,
            context: `Crew role: ${role}. Assigned by team lead as step ${i + 1}/${plan.length}.`,
          })
        : step.task;
      const fullPrompt = await buildContext(ws, sid, memberObjective, {
        contextMode: team.contextMode,
        model: member.model,
      });
      await adapters.run(
        member.adapter,
        { prompt: fullPrompt, model: member.model, cwd, mode, signal },
        (e) =>
          store.append(ws, sid, {
            kind: 'agent',
            actor: member.adapter,
            model: member.model,
            role,
            type: e.type,
            text: e.text,
            meta: e.meta,
          })
      );
      if (signal && signal.aborted) return;
      store.append(ws, sid, {
        kind: 'system',
        actor: member.adapter,
        type: 'status',
        text: `${member.adapter} finished step ${i + 1}/${plan.length}`,
        meta: { done: true, step: i + 1 },
      });
      succeeded++;
    } catch (e) {
      if (signal && signal.aborted) return;
      store.append(ws, sid, {
        kind: 'system',
        actor: member.adapter,
        type: 'error',
        text: String(e),
      });
      failed++;
    }
  }

  if (signal && signal.aborted) return;
  store.append(ws, sid, {
    kind: 'system',
    actor: 'team',
    type: 'status',
    text: `Team delegation finished: ${succeeded} succeeded, ${failed} failed`,
    meta: { done: true },
  });
}

module.exports = { makePlanPrompt, parsePlan, validateSteps, runPlan, runApproved };
