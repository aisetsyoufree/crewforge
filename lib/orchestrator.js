'use strict';

const fs = require('node:fs');
const path = require('node:path');
const skills = require('./skills');
const worktree = require('./worktree');
const { guardedEmitter, withWorkspaceInstruction } = require('./workspace_guard');
const { adapterRunError } = require('./run_outcome');

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '__pycache__',
  'coverage',
  '.nyc_output',
  '.venv',
  'venv',
  'env',
  '.cache',
  'vendor',
  'sessions',
  'logs',
  'tmp',
  '.turbo',
  '.parcel-cache',
]);

function buildFileTree(rootPath, maxFiles = 120, maxDepth = 3) {
  const lines = [];
  function walk(dir, depth) {
    if (depth > maxDepth || lines.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const indent = '  '.repeat(depth - 1);
    for (const e of entries) {
      if (lines.length >= maxFiles) break;
      if (e.name.startsWith('.')) continue;
      // Never follow symlinks — a link pointing outside the workspace (e.g. ~/.ssh)
      // would otherwise leak external file names/structure into the planning prompt.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        lines.push(`${indent}${e.name}/`);
        walk(path.join(dir, e.name), depth + 1);
      } else {
        lines.push(`${indent}${e.name}`);
      }
    }
  }
  walk(rootPath, 1);
  return lines.join('\n');
}

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

function makePlanPrompt(team, prompt, fileTree) {
  const roster = (team.members || []).map((m, i) => memberLabel(m, i)).join('\n');
  const skillNotes = memberSkillNotes(team);
  return [
    'You are the lead for a multi-agent team.',
    'Create a delegation plan for the user request.',
    'Use member roles and skills to choose the best owner for each step.',
    'Return ONLY JSON shaped exactly like: {"steps":[{"memberIndex":0,"task":"...","acceptanceCriteria":["..."],"dependsOnStepIndex":0}]}',
    'dependsOnStepIndex is optional (0-based index of a prior step). Omit for linear order.',
    'Use memberIndex values from this roster:',
    roster,
    skillNotes ? '\nSkill guidance:\n' + skillNotes : '',
    fileTree
      ? '\nWorkspace file tree (for context only — do NOT answer the request directly):\n' +
        fileTree
      : '',
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
    const out = { memberIndex, task };
    if (s && Array.isArray(s.acceptanceCriteria)) {
      out.acceptanceCriteria = s.acceptanceCriteria
        .map((item) => String(item).trim())
        .filter(Boolean);
    }
    if (s && s.dependsOnStepIndex !== undefined && s.dependsOnStepIndex !== null) {
      const dep = Number(s.dependsOnStepIndex);
      if (!Number.isInteger(dep) || dep < 0 || dep >= i) {
        throw new Error(`invalid dependsOnStepIndex for step ${i + 1}`);
      }
      out.dependencies = [dep];
    } else if (s && Array.isArray(s.dependencies)) {
      out.dependencies = s.dependencies.map((idx) => {
        const dep = Number(idx);
        if (!Number.isInteger(dep) || dep < 0 || dep >= i) {
          throw new Error(`invalid dependency for step ${i + 1}`);
        }
        return dep;
      });
    }
    return out;
  });
}

async function runPlan({ adapters, buildContext, store, team, prompt, ws, sid, cwd, signal }) {
  const lead = team.members[team.leadIndex];
  if (!lead) throw new Error('team lead not found');
  if (signal && signal.aborted) return [];

  const fileTree = cwd ? buildFileTree(cwd) : '';
  const planPrompt = withWorkspaceInstruction(makePlanPrompt(team, prompt, fileTree), cwd, 'plan');
  // Planning needs roster + file tree only — not conversation history.
  // Sending history causes the lead to answer the question instead of delegating.
  const fullPrompt = await buildContext(ws, sid, planPrompt, {
    contextMode: 'off',
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
    { prompt: fullPrompt, model: lead.model, effort: lead.effort, cwd, mode: 'plan', signal },
    guardedEmitter(cwd, 'plan', (e) => {
      if (e.type === 'message' && e.text) chunks.push(e.text);
      if (e.type === 'error') {
        store.append(ws, sid, { kind: 'system', actor: lead.adapter, type: 'error', text: e.text });
      }
    })
  );
  if (signal && signal.aborted) return [];
  if (result && result.cancelled) throw new Error('agent run cancelled');
  const runErr = adapterRunError(result);
  if (runErr) throw new Error(runErr);

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

function appendFailedStep(
  store,
  ws,
  sid,
  { member, role, stepIndex, stepCount, memberIndex, message, worktreeId }
) {
  store.append(ws, sid, {
    kind: 'system',
    actor: member.adapter,
    type: 'failed-step',
    text: `${member.adapter} failed step ${stepIndex}/${stepCount}`,
    meta: {
      step: stepIndex,
      total: stepCount,
      memberIndex,
      role,
      model: member.model,
      error: message,
      ...(worktreeId ? { worktreeId } : {}),
    },
  });
  store.append(ws, sid, {
    kind: 'system',
    actor: member.adapter,
    type: 'status',
    text: `${member.adapter} failed step ${stepIndex}/${stepCount}`,
    meta: { done: true, failed: true, step: stepIndex },
  });
}

/**
 * A step's edit worktree was left behind when the run was aborted mid-step.
 * If the worktree has no changes, remove it so it never lingers invisibly.
 * If it has changes, keep it and surface a cancelled-worktree event so the
 * UI can offer Review/Reject on the partial work (never a normal
 * pending-integration/success event, since the run was cancelled).
 */
function settleCancelledStepWorktree(
  store,
  ws,
  sid,
  { runCwd, stepWorktree, member, role, step, total, memberIndex }
) {
  if (!stepWorktree) return;

  let patch = null;
  try {
    patch = worktree.diff(runCwd, stepWorktree.worktreeId);
  } catch {
    patch = null;
  }

  if (patch !== null && !patch.trim()) {
    try {
      worktree.remove(runCwd, stepWorktree.worktreeId);
    } catch {
      // Best effort — if removal fails the worktree is still registered with
      // git and can be cleaned up later; it is not invisible.
    }
    return;
  }

  const diffSummary = worktree.summarizeDiff(patch || '');
  store.append(ws, sid, {
    kind: 'system',
    actor: member.adapter,
    type: 'cancelled-worktree',
    text: `${member.adapter} step ${step}/${total} cancelled — changes retained for review`,
    meta: {
      cancelled: true,
      partial: true,
      awaitingApproval: true,
      done: true,
      paused: true,
      worktreeId: stepWorktree.worktreeId,
      branch: stepWorktree.branch,
      step,
      total,
      memberIndex,
      role,
      model: member.model,
      diffSummary,
      diff: patch || '',
    },
  });
}

async function runApproved({
  adapters,
  buildContext,
  store,
  team,
  steps,
  approvalMode = 'edit',
  ws,
  sid,
  cwd,
  signal,
  stepOffset = 0,
  totalSteps,
  tracking = null,
}) {
  const plan = validateSteps(steps, team.members.length);
  const readOnly = approvalMode === 'plan';
  const originalTotal = Number.isInteger(totalSteps) ? totalSteps : stepOffset + plan.length;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < plan.length; i++) {
    if (signal && signal.aborted) return;
    const step = plan[i];
    const member = team.members[step.memberIndex];
    const role = member.role || 'agent';
    const canEdit = adapterCanEdit(adapters, member.adapter);
    const mode = readOnly || !canEdit ? 'plan' : 'edit';
    const displayStep = stepOffset + i + 1;
    const planStepIndex = displayStep - 1;

    if (tracking && tracking.onStepStart) {
      tracking.onStepStart({ planStepIndex, displayStep, total: originalTotal, mode });
    }

    store.append(ws, sid, {
      kind: 'system',
      actor: member.adapter,
      type: 'status',
      text: `${member.adapter}${member.model ? ' - ' + member.model : ''} (${role}) running step ${displayStep}/${originalTotal}...`,
      meta: { running: true, step: displayStep, total: originalTotal },
    });

    if (!canEdit) {
      store.append(ws, sid, {
        kind: 'system',
        actor: member.adapter,
        type: 'status',
        text: `${member.adapter} is text-only; ran step as analysis (cannot edit files)`,
      });
    } else if (readOnly) {
      store.append(ws, sid, {
        kind: 'system',
        actor: member.adapter,
        type: 'status',
        text: `${member.adapter} is running this approved step in read-only mode`,
      });
    }

    const runCwd = cwd;
    let stepWorktree = null;

    try {
      const memberObjective = member.skillId
        ? skills.buildSkillPrompt(member.skillId, {
            objective: step.task,
            context: `Crew role: ${role}. Assigned by team lead as step ${displayStep}/${originalTotal}.`,
          })
        : step.task;

      let agentCwd = runCwd;
      if (mode === 'edit' && runCwd) {
        stepWorktree = worktree.createUnique(runCwd, `team-step-${displayStep}`);
        agentCwd = stepWorktree.path;
        store.append(ws, sid, {
          kind: 'system',
          actor: 'team',
          type: 'status',
          text: `${member.adapter} running step ${displayStep} in isolated worktree`,
          meta: {
            step: displayStep,
            total: originalTotal,
            worktreeId: stepWorktree.worktreeId,
            branch: stepWorktree.branch,
          },
        });
      }

      const safeObjective = withWorkspaceInstruction(memberObjective, agentCwd, mode);
      const fullPrompt = await buildContext(ws, sid, safeObjective, {
        contextMode: team.contextMode,
        provider: team.contextProvider,
        model: member.model,
      });
      const result = await adapters.run(
        member.adapter,
        {
          prompt: fullPrompt,
          model: member.model,
          effort: member.effort,
          cwd: agentCwd,
          mode,
          signal,
        },
        guardedEmitter(agentCwd, mode, (e) =>
          store.append(ws, sid, {
            kind: 'agent',
            actor: member.adapter,
            model: member.model,
            role,
            type: e.type,
            text: e.text,
            meta: e.meta,
          })
        )
      );
      if (signal && signal.aborted) {
        settleCancelledStepWorktree(store, ws, sid, {
          runCwd,
          stepWorktree,
          member,
          role,
          step: displayStep,
          total: originalTotal,
          memberIndex: step.memberIndex,
        });
        if (tracking && tracking.onRunAborted) {
          tracking.onRunAborted({
            planStepIndex,
            displayStep,
            worktreeId: stepWorktree && stepWorktree.worktreeId,
            partial: !!stepWorktree,
          });
        }
        return;
      }
      const runErr = adapterRunError(result);
      if (runErr) throw new Error(runErr);

      if (stepWorktree) {
        const patch = worktree.diff(runCwd, stepWorktree.worktreeId);
        const diffSummary = worktree.summarizeDiff(patch);
        store.append(ws, sid, {
          kind: 'system',
          actor: member.adapter,
          type: 'pending-integration',
          text: `${member.adapter} step ${displayStep}/${originalTotal} awaiting integration approval`,
          meta: {
            awaitingApproval: true,
            worktreeId: stepWorktree.worktreeId,
            branch: stepWorktree.branch,
            step: displayStep,
            total: originalTotal,
            memberIndex: step.memberIndex,
            role,
            model: member.model,
            diffSummary,
            diff: patch,
            continuation: {
              version: 1,
              team: {
                id: team.id,
                name: team.name,
                leadIndex: team.leadIndex,
                members: team.members,
                contextMode: team.contextMode,
                contextProvider: team.contextProvider,
              },
              approvalMode,
              remainingSteps: plan.slice(i + 1),
              nextStepOffset: displayStep,
              totalSteps: originalTotal,
            },
          },
        });
        store.append(ws, sid, {
          kind: 'system',
          actor: member.adapter,
          type: 'status',
          text: `${member.adapter} finished step ${displayStep}/${originalTotal} (awaiting integration)`,
          meta: {
            done: true,
            step: displayStep,
            total: originalTotal,
            awaitingIntegration: true,
            worktreeId: stepWorktree.worktreeId,
          },
        });
        store.append(ws, sid, {
          kind: 'system',
          actor: 'team',
          type: 'status',
          text:
            i + 1 < plan.length
              ? `Team delegation paused: integrate step ${displayStep} to continue`
              : `Team delegation paused: integrate step ${displayStep} to finish`,
          meta: {
            done: true,
            paused: true,
            awaitingIntegration: true,
            worktreeId: stepWorktree.worktreeId,
            step: displayStep,
            total: originalTotal,
          },
        });
        if (tracking && tracking.onStepAwaitingIntegration) {
          tracking.onStepAwaitingIntegration({
            planStepIndex,
            displayStep,
            worktreeId: stepWorktree.worktreeId,
            branch: stepWorktree.branch,
            diffSummary,
          });
        }
        return {
          paused: true,
          awaitingIntegration: true,
          worktreeId: stepWorktree.worktreeId,
          step: displayStep,
          total: originalTotal,
        };
      }

      store.append(ws, sid, {
        kind: 'system',
        actor: member.adapter,
        type: 'status',
        text: `${member.adapter} finished step ${displayStep}/${originalTotal}`,
        meta: { done: true, step: displayStep, total: originalTotal },
      });
      if (tracking && tracking.onStepFinished) {
        tracking.onStepFinished({
          planStepIndex,
          displayStep,
          summary: (result && result.finalText) || '',
        });
      }
      succeeded++;
    } catch (e) {
      if (signal && signal.aborted) {
        settleCancelledStepWorktree(store, ws, sid, {
          runCwd,
          stepWorktree,
          member,
          role,
          step: displayStep,
          total: originalTotal,
          memberIndex: step.memberIndex,
        });
        if (tracking && tracking.onRunAborted) {
          tracking.onRunAborted({
            planStepIndex,
            displayStep,
            worktreeId: stepWorktree && stepWorktree.worktreeId,
            partial: !!stepWorktree,
          });
        }
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      let failedWorktreeId = null;
      if (stepWorktree) {
        try {
          const patch = worktree.diff(runCwd, stepWorktree.worktreeId);
          if (patch.trim()) failedWorktreeId = stepWorktree.worktreeId;
          else worktree.remove(runCwd, stepWorktree.worktreeId);
        } catch {
          failedWorktreeId = stepWorktree.worktreeId;
        }
      }
      appendFailedStep(store, ws, sid, {
        member,
        role,
        stepIndex: displayStep,
        stepCount: originalTotal,
        memberIndex: step.memberIndex,
        message,
        worktreeId: failedWorktreeId,
      });
      if (tracking && tracking.onStepFailed) {
        tracking.onStepFailed({
          planStepIndex,
          displayStep,
          error: message,
          worktreeId: failedWorktreeId,
        });
      }
      failed++;
      store.append(ws, sid, {
        kind: 'system',
        actor: 'team',
        type: 'status',
        text: `Team delegation finished: ${succeeded} succeeded, ${failed} failed`,
        meta: { done: true },
      });
      throw e instanceof Error ? e : new Error(message);
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
