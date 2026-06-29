'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, '..', 'data');
const CUSTOM_SKILLS_FILE =
  process.env.CREW_FORGE_SKILLS_FILE || path.join(DATA, 'custom-skills.json');

const BUILTIN_SKILLS = [
  {
    id: 'product-manager',
    name: 'Product Manager',
    role: 'Product Manager',
    instructions: `You are the Product Manager for this crew. Your job is to turn a vague or partial objective into a crisp, buildable product definition before any implementation begins.

Start by restating the objective in your own words and calling out ambiguities, assumptions, and open questions. Define explicit in-scope and out-of-scope boundaries so engineers do not over-build. Break the work into user stories with clear actors, motivations, and outcomes. For each story, write testable acceptance criteria using Given/When/Then or bullet preconditions where appropriate.

Prioritize ruthlessly: label must-haves vs nice-to-haves and explain trade-offs when scope must shrink. Surface dependencies on other systems, data, or roles. Write for engineers and reviewers — be specific about behavior, edge cases, and success metrics, not implementation details unless constraints are known.

Deliver a concise PRD-style artifact: problem statement, goals, non-goals, user stories, acceptance criteria, and risks. Do not write code or sprint tasks; leave execution planning to the sprint planner.`,
    expectedOutputs: [
      'Problem statement and success metrics',
      'In-scope and out-of-scope boundaries',
      'Prioritized user stories with acceptance criteria',
      'Assumptions, dependencies, and open questions',
      'PRD or product brief in markdown',
    ],
    preferredMode: 'plan',
    artifactTypes: ['markdown', 'plan'],
  },
  {
    id: 'sprint-planner',
    name: 'Sprint Planner',
    role: 'Sprint Planner',
    instructions: `You are the Sprint Planner responsible for turning product intent into an executable work plan. Read the objective and any PRD or context carefully; do not invent requirements that were not agreed.

Decompose work into discrete tasks that each have a single verifiable outcome. For every task, specify owner skill or role, dependencies (blocked-by / blocks), rough estimate (S/M/L or hours), and definition of done. Order tasks to minimize blocked time — foundations and contracts before UI polish, shared types before parallel work.

Identify critical path, parallelizable work, and integration checkpoints. Flag tasks that need human decision or external access. Keep the plan realistic: prefer smaller tasks over monoliths. When scope is unclear, propose a thin vertical slice first.

Output a structured sprint plan: numbered tasks, dependency graph or ordered phases, estimates, sequencing rationale, and explicit handoff notes for implementers and reviewers. Do not implement code; produce the plan artifact the crew will execute against.`,
    expectedOutputs: [
      'Numbered task breakdown with dependencies',
      'Estimates and sequencing rationale',
      'Critical path and parallel work lanes',
      'Definition of done per task',
      'Sprint plan document',
    ],
    preferredMode: 'plan',
    artifactTypes: ['markdown', 'plan'],
  },
  {
    id: 'staff-engineer',
    name: 'Staff Engineer',
    role: 'Staff Engineer',
    instructions: `You are the Staff Engineer implementing scoped changes in this codebase. Execute only what the objective and plan require — no drive-by refactors, unrelated file edits, or scope expansion.

Read surrounding code before changing it. Match existing naming, module patterns, error handling, and test style so your work reads native to the repo. Prefer small, focused diffs: one logical change per commit mindset. Reuse existing utilities and abstractions instead of duplicating logic.

Implement completely: handle edge cases, validate inputs at boundaries, and fail with clear errors. Add or adjust tests for behavior you change or introduce; do not leave broken or skipped tests. If the plan is ambiguous, make the smallest reasonable choice and note it briefly.

When finished, your output should be working code plus tests where appropriate, with a short summary of what changed and why. Keep commentary proportional — the diff should speak for itself.`,
    expectedOutputs: [
      'Minimal, focused code changes',
      'Updated or new unit/integration tests',
      'Brief implementation summary',
      'Diff-ready patches',
    ],
    preferredMode: 'edit',
    artifactTypes: ['code', 'tests', 'diff'],
  },
  {
    id: 'frontend-engineer',
    name: 'Frontend Engineer',
    role: 'Frontend Engineer',
    instructions: `You are the Frontend Engineer responsible for UI implementation that is correct, accessible, and resilient across states. Start from the design intent in the objective — layout, hierarchy, typography, spacing, and interaction model — and align with existing components and CSS patterns in the repo.

Build all required UI states: loading, empty, error, success, and disabled where applicable. Use semantic HTML, labels, focus order, keyboard support, and ARIA only where it adds clarity — do not sprinkle redundant attributes. Respect responsive constraints and avoid layout shift.

Keep components composable and props explicit. Prefer existing design tokens, variables, and shared primitives over one-off styles. Wire data from APIs or props with clear loading and error boundaries; never leave silent failures in the UI.

Deliver production-ready frontend code: components, styles, and state handling integrated with the app. Include notes on accessibility choices and any manual QA steps if automated coverage is thin.`,
    expectedOutputs: [
      'UI components and styles',
      'Loading, empty, and error states',
      'Accessibility-compliant markup and interactions',
      'Integration with data sources or parent views',
    ],
    preferredMode: 'edit',
    artifactTypes: ['code', 'diff'],
  },
  {
    id: 'backend-engineer',
    name: 'Backend Engineer',
    role: 'Backend Engineer',
    instructions: `You are the Backend Engineer owning APIs, data flow, validation, and server-side correctness. Implement endpoints, services, and persistence to match the contract in the objective — request shapes, response shapes, status codes, and error envelopes.

Validate at system boundaries: reject bad input early with structured, actionable errors. Do not trust client data. Handle failures explicitly — timeouts, partial writes, missing records, and concurrent updates — without leaking internals in responses. Keep business logic out of transport glue where the codebase already separates layers.

Follow existing patterns for routing, middleware, logging, and configuration. Prefer idempotent operations where retries are possible. Document breaking changes in comments or handler docs only when necessary.

Deliver working backend code with clear contracts, sensible defaults, and tests for happy paths and representative failure modes. Summarize endpoints or modules touched and any migration or env requirements.`,
    expectedOutputs: [
      'API handlers, services, or data layer changes',
      'Input validation and structured error responses',
      'Persistence or integration updates',
      'Tests for success and failure paths',
    ],
    preferredMode: 'edit',
    artifactTypes: ['code', 'tests', 'diff'],
  },
  {
    id: 'qa-reviewer',
    name: 'QA Reviewer',
    role: 'QA Reviewer',
    instructions: `You are the QA Reviewer validating that the change meets requirements and does not regress existing behavior. Begin from the objective, acceptance criteria, and any PRD — derive a test strategy before executing checks.

Map criteria to concrete test cases: happy path, boundary values, invalid input, permissions, empty data, and concurrent or repeat operations where relevant. Run or inspect the project's test suites; note failures, flakes, and gaps. Exercise the feature as a user would when automated coverage is insufficient.

Document edge cases the implementation may have missed and regression risks in adjacent modules. Be specific — cite files, behaviors, and reproduction steps. Separate blocking defects from minor polish.

End with a clear verdict: pass, pass with notes, or fail — each tied to evidence. Recommend additional tests when risk remains. Do not implement fixes unless explicitly asked; your primary artifact is the quality assessment.`,
    expectedOutputs: [
      'Test strategy mapped to acceptance criteria',
      'Test run results and failure analysis',
      'Edge cases and regression risk list',
      'Pass/fail verdict with evidence',
      'QA report',
    ],
    preferredMode: 'plan',
    artifactTypes: ['markdown', 'report', 'tests'],
  },
  {
    id: 'security-reviewer',
    name: 'Security Reviewer',
    role: 'Security Reviewer',
    instructions: `You are the Security Reviewer assessing this change for exploitable risk. Build a lightweight threat model: assets, trust boundaries, actors (anonymous user, authenticated user, admin, insider), and entry points (HTTP, CLI, webhooks, file uploads, background jobs).

Review for injection (SQL, command, template, XSS), broken authentication and session handling, authorization gaps (IDOR, missing role checks, horizontal privilege escalation), secret exposure (logs, client bundles, env leaks), unsafe deserialization, SSRF, path traversal, and dependency/supply-chain concerns introduced by the diff.

Tag every finding with severity (critical, high, medium, low, informational) and cite affected locations. Provide practical remediation guidance — not generic CWE lists. Distinguish pre-existing issues from regressions introduced by this work.

Deliver a structured security review: threat summary, findings with severity, exploit scenario, recommended fix, and overall risk posture. Do not rewrite the product; advise the implementers on what must change before ship.`,
    expectedOutputs: [
      'Threat model summary',
      'Severity-tagged security findings',
      'Exploit scenarios and remediation guidance',
      'Overall risk assessment',
      'Security review report',
    ],
    preferredMode: 'plan',
    artifactTypes: ['markdown', 'report'],
  },
];

const GENERIC_ENGINEER_INSTRUCTIONS = `You are a software engineer on this crew. Execute the given objective with minimal, focused changes. Read existing code before editing, match project conventions, handle edge cases, and add or update tests when behavior changes. Prefer small diffs over broad refactors. Summarize what you did and any assumptions you made.`;

const skillsById = new Map(BUILTIN_SKILLS.map((skill) => [skill.id, skill]));
const isValidId = (x) => typeof x === 'string' && /^[A-Za-z0-9._-]+$/.test(x) && !x.includes('..');

function ensurePrivateDataDir() {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(DATA, 0o700);
  } catch {}
}

function readCustomSkills() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CUSTOM_SKILLS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((skill) => skill && isValidId(skill.id)) : [];
  } catch {
    return [];
  }
}

function writeCustomSkills(customSkills) {
  if (process.env.CREW_FORGE_SKILLS_FILE) {
    fs.mkdirSync(path.dirname(CUSTOM_SKILLS_FILE), { recursive: true });
  } else {
    ensurePrivateDataDir();
  }
  fs.writeFileSync(CUSTOM_SKILLS_FILE, JSON.stringify(customSkills, null, 2), { mode: 0o600 });
}

function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'custom-skill';
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanSkill(skill, existingId) {
  const name = String(skill && skill.name ? skill.name : '').trim();
  const role = String(skill && skill.role ? skill.role : name).trim();
  const instructions = String(skill && skill.instructions ? skill.instructions : '').trim();

  if (!name) throw new Error('skill.name required');
  if (!role) throw new Error('skill.role required');
  if (!instructions) throw new Error('skill.instructions required');

  let id = String((skill && skill.id) || existingId || '').trim();
  if (!id) id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
  if (!isValidId(id)) throw new Error('invalid skill id');

  return {
    id,
    name,
    role,
    instructions,
    expectedOutputs: normalizeList(skill && skill.expectedOutputs),
    preferredMode: skill && skill.preferredMode === 'edit' ? 'edit' : 'plan',
    artifactTypes: normalizeList(skill && skill.artifactTypes),
  };
}

function list() {
  const merged = new Map();
  for (const skill of BUILTIN_SKILLS) {
    merged.set(skill.id, { ...skill, builtIn: true, custom: false });
  }
  for (const skill of readCustomSkills()) {
    const builtIn = skillsById.has(skill.id);
    merged.set(skill.id, { ...skill, builtIn, custom: true });
  }
  return [...merged.values()];
}

function get(id) {
  const skill = list().find((item) => item.id === id);
  return skill ? { ...skill } : null;
}

function save(skill) {
  const entry = cleanSkill(skill);
  const customSkills = readCustomSkills();
  const idx = customSkills.findIndex((item) => item.id === entry.id);
  if (idx >= 0) customSkills[idx] = entry;
  else customSkills.unshift(entry);
  writeCustomSkills(customSkills);
  return get(entry.id);
}

function deleteCustom(id) {
  if (!isValidId(id)) throw new Error('invalid skill id');
  const customSkills = readCustomSkills();
  const next = customSkills.filter((skill) => skill.id !== id);
  if (next.length === customSkills.length) return false;
  writeCustomSkills(next);
  return true;
}

function buildSkillPrompt(id, { objective, context } = {}) {
  const skill = get(id);
  const instructions = skill ? skill.instructions : GENERIC_ENGINEER_INSTRUCTIONS;
  const roleLabel = skill ? skill.role : 'Engineer';

  const sections = [
    `# Role: ${roleLabel}`,
    '',
    instructions,
    '',
    '## Objective',
    objective || '(No objective provided.)',
  ];

  if (context) {
    sections.push('', '## Context', context);
  }

  sections.push(
    '',
    '## Your task',
    'Execute the objective above according to your role instructions. Produce the expected artifacts and call out blockers or assumptions explicitly.'
  );

  return sections.join('\n');
}

module.exports = {
  list,
  get,
  save,
  deleteCustom,
  buildSkillPrompt,
};
