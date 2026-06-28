'use strict';

const { execFileSync } = require('node:child_process');

const adapters = require('../adapters');
const skills = require('./skills');
const tasks = require('./tasks');
const worktree = require('./worktree');

function memberName(member) {
  return String((member && (member.name || member.role)) || 'agent');
}

function skillIds() {
  return new Set(skills.list().map((skill) => skill.id));
}

function fallbackSkillId(member) {
  const known = skillIds();
  const memberSkills = Array.isArray(member && member.skills) ? member.skills : [];
  const memberSkill = memberSkills.find((id) => known.has(id));
  if (memberSkill) return memberSkill;
  if (known.has('staff-engineer')) return 'staff-engineer';
  const first = skills.list()[0];
  return first ? first.id : '';
}

function buildPlanPrompt(team, objective) {
  const roster = (team.members || [])
    .map((member, index) => {
      const memberSkills = Array.isArray(member.skills) ? member.skills.join(', ') : '';
      return [
        `- index: ${index}`,
        `role: ${member.role || ''}`,
        `adapter: ${member.adapter || ''}`,
        `model: ${member.model || ''}`,
        `skills: ${memberSkills || '(none)'}`,
      ].join(' | ');
    })
    .join('\n');

  return [
    'You are the LEAD for a local AI software team.',
    'Create an execution plan for the objective.',
    'Assign each task to the best roster member by role and skills.',
    'Output ONLY JSON with this exact shape:',
    '{"tasks":[{"title":"...","objective":"...","ownerIndex":0,"skillId":"staff-engineer","mode":"plan","dependsOn":[0]}]}',
    '',
    'Rules:',
    '- ownerIndex must be a roster index.',
    '- skillId should be one of the owner skills when possible.',
    '- mode must be "plan" or "edit".',
    '- dependsOn contains zero-based task indexes that must run first.',
    '- Do not include prose, markdown, or comments.',
    '',
    'Roster:',
    roster || '(empty team)',
    '',
    'Objective:',
    String(objective || ''),
  ].join('\n');
}

function fencedBodies(text) {
  const out = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(text))) out.push(match[1].trim());
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

function normalizePlan(parsed, team) {
  if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('plan.tasks must be an array');
  const members = Array.isArray(team && team.members) ? team.members : [];
  const knownSkills = skillIds();

  return parsed.tasks.map((step, index) => {
    const ownerIndex = Number(step && step.ownerIndex);
    if (!Number.isInteger(ownerIndex) || ownerIndex < 0 || ownerIndex >= members.length) {
      throw new Error(`invalid ownerIndex for task ${index + 1}`);
    }

    const title = String((step && step.title) || '').trim();
    const objective = String((step && step.objective) || '').trim();
    if (!title) throw new Error(`missing title for task ${index + 1}`);
    if (!objective) throw new Error(`missing objective for task ${index + 1}`);

    const mode =
      step && step.mode === 'plan' ? 'plan' : step && step.mode === 'edit' ? 'edit' : null;
    if (!mode) throw new Error(`invalid mode for task ${index + 1}`);

    const dependsOn = step && step.dependsOn === undefined ? [] : step && step.dependsOn;
    if (!Array.isArray(dependsOn))
      throw new Error(`dependsOn must be an array for task ${index + 1}`);
    const normalizedDependsOn = dependsOn.map((value) => {
      const depIndex = Number(value);
      if (!Number.isInteger(depIndex) || depIndex < 0 || depIndex >= parsed.tasks.length) {
        throw new Error(`invalid dependency index for task ${index + 1}`);
      }
      return depIndex;
    });

    const requestedSkill = String((step && step.skillId) || '').trim();
    const skillId = knownSkills.has(requestedSkill)
      ? requestedSkill
      : fallbackSkillId(members[ownerIndex]);

    return {
      title,
      objective,
      ownerIndex,
      skillId,
      mode,
      dependsOn: normalizedDependsOn,
    };
  });
}

function parsePlan(text, team) {
  const raw = String(text || '').trim();
  const candidates = [raw, ...fencedBodies(raw), ...objectCandidates(raw)];
  let lastError = null;

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return normalizePlan(JSON.parse(candidate), team);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`unable to parse crew plan${lastError ? ': ' + lastError.message : ''}`);
}

function appendEvent(projectId, taskId, event, onEvent, chunks) {
  if (onEvent) onEvent(event);
  if (event && event.text) {
    tasks.addLog(projectId, taskId, {
      level: event.type === 'error' ? 'error' : 'info',
      text: event.text,
    });
    if (event.type === 'message' && chunks) chunks.push(event.text);
  }
}

function adapterCanEdit(adapterId) {
  const entry = adapters.catalog().find((item) => item.id === adapterId);
  return entry ? !!entry.canEdit : false;
}

function includeUntrackedFiles(wtPath) {
  try {
    execFileSync('git', ['add', '-N', '.'], {
      cwd: wtPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (_) {
    // Diff capture still works for modified tracked files if intent-to-add fails.
  }
}

async function planObjective({ team, objective }, runAgent = adapters.run) {
  const lead = team && team.members && team.members[team.leadIndex];
  if (!lead) throw new Error('team lead not found');

  const prompt = buildPlanPrompt(team, objective);
  const chunks = [];
  const result = await runAgent(
    lead.adapter,
    {
      prompt,
      model: lead.model,
      mode: 'plan',
    },
    (event) => {
      if (event && event.type === 'message' && event.text) chunks.push(event.text);
    }
  );

  const text = (result && result.finalText) || chunks.join('\n');
  const steps = parsePlan(text, team);
  const project = tasks.createProject({
    objective,
    teamId: team.id,
    leadName: memberName(lead),
  });
  const created = [];

  for (const step of steps) {
    const member = team.members[step.ownerIndex];
    const task = tasks.createTask(project.id, {
      title: step.title,
      objective: step.objective,
      owner: memberName(member),
      dependencies: [],
      mode: step.mode,
    });
    created.push(task);
  }

  for (let i = 0; i < steps.length; i++) {
    created[i] = tasks.updateTask(project.id, created[i].id, {
      dependencies: steps[i].dependsOn.map((depIndex) => created[depIndex].id),
      skillId: steps[i].skillId,
      ownerIndex: steps[i].ownerIndex,
    });
  }

  return {
    project: tasks.getProject(project.id),
    tasks: created,
  };
}

async function executeTask(
  { wsPath, projectId, taskId, member },
  onEvent,
  runAgent = adapters.run,
  signal
) {
  let task = tasks.getTask(projectId, taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  tasks.setTaskStatus(projectId, taskId, 'running');
  tasks.addLog(projectId, taskId, { level: 'info', text: `started ${task.mode || 'edit'} task` });

  const canEdit = adapterCanEdit(member.adapter);
  const chunks = [];
  let wt = null;

  try {
    if (signal && signal.aborted) throw new Error('task aborted');

    if (task.mode === 'edit' && canEdit) {
      wt = worktree.create(wsPath, taskId);
      tasks.updateTask(projectId, taskId, { worktree: wt });
      const skillId = (Array.isArray(member.skills) && member.skills[0]) || task.skillId;
      const result = await runAgent(
        member.adapter,
        {
          prompt: skills.buildSkillPrompt(skillId, { objective: task.objective }),
          model: member.model,
          cwd: wt.path,
          mode: 'edit',
          signal,
        },
        (event) => appendEvent(projectId, taskId, event, onEvent, chunks)
      );

      if (signal && signal.aborted) throw new Error('task aborted');
      if (result && result.cancelled) throw new Error('task aborted');
      if (result && result.error) throw new Error('agent run failed');

      includeUntrackedFiles(wt.path);
      const diff = worktree.diff(wsPath, taskId);
      tasks.addArtifact(projectId, taskId, {
        type: 'diff',
        name: `${taskId}.diff`,
        content: diff,
        branch: wt.branch,
        worktreePath: wt.path,
      });
    } else {
      const skillId = (Array.isArray(member.skills) && member.skills[0]) || task.skillId;
      const result = await runAgent(
        member.adapter,
        {
          prompt: skills.buildSkillPrompt(skillId, { objective: task.objective }),
          model: member.model,
          cwd: wsPath,
          mode: 'plan',
          signal,
        },
        (event) => appendEvent(projectId, taskId, event, onEvent, chunks)
      );

      if (signal && signal.aborted) throw new Error('task aborted');
      if (result && result.cancelled) throw new Error('task aborted');
      if (result && result.error) throw new Error('agent run failed');

      const finalText = (result && result.finalText) || chunks.join('\n');
      tasks.addArtifact(projectId, taskId, {
        type: 'markdown',
        name: `${taskId}.md`,
        content: finalText,
      });
    }

    return tasks.setTaskStatus(projectId, taskId, 'complete');
  } catch (err) {
    tasks.addLog(projectId, taskId, {
      level: 'error',
      text: err && err.message ? err.message : String(err),
    });
    return tasks.setTaskStatus(projectId, taskId, 'failed');
  }
}

function taskArtifactText(task) {
  return (task.artifacts || [])
    .map((artifact) => {
      const label = artifact.name || artifact.type || 'artifact';
      return [`## ${label}`, artifact.content || ''].join('\n');
    })
    .join('\n\n');
}

function parseReview(text) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  const requestChanges = /\brequest[\s-]*changes\b/.test(lower);
  const approve = /\bapprove\b/.test(lower) || /\bapproved\b/.test(lower);
  if (requestChanges) return { verdict: 'request-changes', notes: raw };
  if (approve) return { verdict: 'approve', notes: raw };
  return {
    verdict: 'request-changes',
    notes: raw || 'Reviewer did not provide an explicit verdict.',
  };
}

async function reviewTask(
  { wsPath, projectId, taskId, reviewerMember },
  onEvent,
  runAgent = adapters.run
) {
  const task = tasks.getTask(projectId, taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  const artifactText = taskArtifactText(task) || 'No artifacts were produced.';
  const prompt = [
    'You are reviewing a crew task result.',
    'Return a concise review with an explicit verdict: approve or request-changes.',
    '',
    'Task:',
    task.title,
    '',
    'Objective:',
    task.objective,
    '',
    'Artifacts:',
    artifactText,
  ].join('\n');
  const chunks = [];

  const result = await runAgent(
    reviewerMember.adapter,
    {
      prompt,
      model: reviewerMember.model,
      cwd: wsPath,
      mode: 'plan',
    },
    (event) => {
      if (onEvent) onEvent(event);
      if (event && event.type === 'message' && event.text) chunks.push(event.text);
    }
  );
  const text = (result && result.finalText) || chunks.join('\n');
  const reviewResult = parseReview(text);
  return tasks.setReview(projectId, taskId, reviewResult).reviewResult;
}

function mergeTask({ wsPath, projectId, taskId }) {
  const task = tasks.getTask(projectId, taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const wt = task.worktree || {};
  if (task.mode === 'edit' && wt.branch) {
    const diff = worktree.diff(wsPath, taskId);
    if (diff.trim()) {
      execFileSync('git', ['apply'], {
        cwd: wsPath,
        input: diff,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    worktree.remove(wsPath, taskId);
  }

  tasks.setTaskStatus(projectId, taskId, 'approved');
  return { merged: true };
}

async function finalSummary({ projectId }, runAgent = adapters.run, leadMember) {
  const project = tasks.getProject(projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
  if (!leadMember) throw new Error('lead member required');

  const projectTasks = tasks.listTasks(projectId);
  const artifactText = projectTasks
    .map((task) => [`# ${task.title}`, taskArtifactText(task) || 'No artifacts.'].join('\n'))
    .join('\n\n');
  const prompt = [
    'Summarize the completed crew project into a delivery summary.',
    '',
    'Project objective:',
    project.objective,
    '',
    'Task artifacts:',
    artifactText || 'No task artifacts.',
  ].join('\n');
  const chunks = [];

  const result = await runAgent(
    leadMember.adapter,
    {
      prompt,
      model: leadMember.model,
      mode: 'plan',
    },
    (event) => {
      if (event && event.type === 'message' && event.text) chunks.push(event.text);
    }
  );
  const summary = (result && result.finalText) || chunks.join('\n');
  return tasks.updateProject(projectId, { summary, phase: 'done' });
}

module.exports = {
  buildPlanPrompt,
  parsePlan,
  planObjective,
  executeTask,
  reviewTask,
  mergeTask,
  finalSummary,
};
