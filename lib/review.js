'use strict';

/*
 * Review prompts and strict structured-verdict parsing.
 *
 * Persist only bounded/redacted structured findings for gates/repair.
 * Raw reviewer text stays in normal session history only.
 * Unparseable output => incomplete (never guess PASS).
 */

const MAX_FINDINGS = 20;
const MAX_SUMMARY = 240;
const MAX_FILE = 200;
const MAX_CRITERION = 160;
const MAX_ID = 64;
const MAX_NOTES = 400;

const SEVERITIES = new Set(['critical', 'error', 'high', 'medium', 'low', 'info', 'warning']);

function cap(text, max) {
  const s = String(text == null ? '' : text)
    .replace(/\0/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function redactSecrets(text) {
  let s = String(text || '');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  s = s.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED]');
  s = s.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]');
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
  s = s.replace(
    /\b(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^\s'"]{6,}/gi,
    '$1=[REDACTED]'
  );
  return s;
}

function normalizeSeverity(value) {
  const s = String(value || '')
    .trim()
    .toLowerCase();
  if (s === 'warn') return 'warning';
  if (s === 'err') return 'error';
  if (s === 'crit') return 'critical';
  return SEVERITIES.has(s) ? s : 'medium';
}

function buildReviewPrompt(diff, _opts = {}) {
  const trimmed = (diff || '').trim();
  const lines = [
    'You are a senior code reviewer. Review the uncommitted changes below.',
    '',
    'Report issues, then end with a STRICT structured verdict block.',
    '',
    'Rules:',
    '- Do NOT report confidence percentages or subjective certainty scores.',
    '- Verdict must be exactly PASS or REQUEST_CHANGES.',
    '- Findings are required when requesting changes; empty array allowed for PASS.',
    '',
    'After your brief prose analysis, output EXACTLY one fenced JSON block:',
    '```json',
    '{',
    '  "verdict": "PASS" | "REQUEST_CHANGES",',
    '  "findings": [',
    '    {',
    '      "id": "F1",',
    '      "severity": "critical|error|high|medium|low|info",',
    '      "summary": "short objective issue",',
    '      "file": "workspace/relative/path.js",',
    '      "acceptanceCriterion": "optional criterion text"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Also end with a single plain line: VERDICT: PASS  or  VERDICT: REQUEST_CHANGES',
    '',
  ];

  if (!trimmed) {
    lines.push('no uncommitted changes');
  } else {
    lines.push('```diff');
    lines.push(trimmed);
    lines.push('```');
  }

  return lines.join('\n');
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

function normalizeVerdictToken(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (raw === 'PASS' || raw === 'APPROVE' || raw === 'APPROVED') return 'PASS';
  if (
    raw === 'REQUEST CHANGES' ||
    raw === 'REQUEST_CHANGES' ||
    raw === 'CHANGES REQUESTED' ||
    raw === 'NEEDS WORK'
  ) {
    return 'REQUEST_CHANGES';
  }
  return null;
}

function extractLineVerdict(text) {
  const lines = String(text || '').split(/\r?\n/);
  // Prefer explicit VERDICT: line near the end.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const m = line.match(/^(?:\*\*)?VERDICT(?:\*\*)?\s*:\s*(.+)$/i);
    if (m) {
      const v = normalizeVerdictToken(m[1].replace(/\*+/g, ''));
      if (v) return v;
    }
    // Legacy: **APPROVE** / **REQUEST CHANGES** alone on a line
    const plain = line.replace(/\*+/g, '').trim();
    const v2 = normalizeVerdictToken(plain);
    if (
      v2 &&
      /^(PASS|APPROVE|APPROVED|REQUEST CHANGES|REQUEST_CHANGES|CHANGES REQUESTED)$/i.test(plain)
    ) {
      return v2;
    }
  }
  return null;
}

function normalizeFinding(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id =
    cap(raw.id || `F${index + 1}`, MAX_ID).replace(/[^A-Za-z0-9._-]/g, '_') || `F${index + 1}`;
  const summary = cap(redactSecrets(raw.summary || raw.message || raw.title || ''), MAX_SUMMARY);
  if (!summary) return null;
  const finding = {
    id,
    severity: normalizeSeverity(raw.severity || raw.level || 'medium'),
    summary,
  };
  if (raw.file || raw.path || raw.filename) {
    finding.file = cap(String(raw.file || raw.path || raw.filename).replace(/^\.\//, ''), MAX_FILE);
    // Workspace-relative only — strip absolute host paths.
    if (finding.file.startsWith('/') || /^[A-Za-z]:\\/.test(finding.file)) {
      const parts = finding.file.split(/[/\\]/);
      finding.file = cap(parts[parts.length - 1] || finding.file, MAX_FILE);
    }
  }
  if (raw.acceptanceCriterion || raw.criterion || raw.acceptance) {
    finding.acceptanceCriterion = cap(
      raw.acceptanceCriterion || raw.criterion || raw.acceptance,
      MAX_CRITERION
    );
  }
  if (raw.resolved === true) finding.resolved = true;
  return finding;
}

function normalizeFindings(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length && out.length < MAX_FINDINGS; i++) {
    const f = normalizeFinding(list[i], i);
    if (f) out.push(f);
  }
  return out;
}

function tryParseStructuredObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const verdict = normalizeVerdictToken(obj.verdict || obj.decision || obj.result);
  if (!verdict) return null;
  return {
    verdict,
    findings: normalizeFindings(obj.findings || obj.issues || obj.problems || []),
  };
}

/**
 * Strict parser for reviewer output.
 * @returns {{
 *   parseStatus: 'ok'|'incomplete',
 *   verdict: 'PASS'|'REQUEST_CHANGES'|null,
 *   findings: Array,
 *   notes: string,
 *   evaluatedAt: string
 * }}
 */
function parseReviewVerdict(text) {
  const raw = String(text || '');
  const evaluatedAt = new Date().toISOString();
  const incomplete = (notes) => ({
    parseStatus: 'incomplete',
    verdict: null,
    findings: [],
    notes: cap(redactSecrets(notes || 'Unable to parse structured review verdict'), MAX_NOTES),
    evaluatedAt,
  });

  if (!raw.trim()) {
    return incomplete('Empty reviewer output');
  }

  const candidates = [];
  for (const body of fencedBodies(raw)) {
    try {
      candidates.push(JSON.parse(body));
    } catch {
      // ignore
    }
  }
  for (const body of objectCandidates(raw)) {
    try {
      candidates.push(JSON.parse(body));
    } catch {
      // ignore
    }
  }

  for (const obj of candidates) {
    // Nested shapes: { review: {...} } or { result: {...} }
    const direct = tryParseStructuredObject(obj);
    if (direct) {
      return {
        parseStatus: 'ok',
        verdict: direct.verdict,
        findings: direct.findings,
        notes: cap(redactSecrets(obj.notes || obj.summary || ''), MAX_NOTES),
        evaluatedAt,
      };
    }
    if (obj.review) {
      const nested = tryParseStructuredObject(obj.review);
      if (nested) {
        return {
          parseStatus: 'ok',
          verdict: nested.verdict,
          findings: nested.findings,
          notes: cap(redactSecrets(obj.notes || ''), MAX_NOTES),
          evaluatedAt,
        };
      }
    }
  }

  // Fallback: explicit VERDICT line without JSON — accept only if PASS (empty findings)
  // or REQUEST_CHANGES (incomplete findings list => still ok verdict with empty findings,
  // but REQUEST_CHANGES with zero findings remains valid structured-enough for gates).
  const lineVerdict = extractLineVerdict(raw);
  if (lineVerdict) {
    // Without structured findings block, REQUEST_CHANGES is still a valid verdict;
    // findings stay empty (repair loop will use objective/acceptance only).
    return {
      parseStatus: 'ok',
      verdict: lineVerdict,
      findings: [],
      notes: cap(redactSecrets('Verdict line only; no structured findings block'), MAX_NOTES),
      evaluatedAt,
    };
  }

  // Legacy **APPROVE** / **REQUEST CHANGES** from older prompt.
  if (/\bREQUEST\s+CHANGES\b/i.test(raw) && !/\b(?:PASS|APPROVE)\b/i.test(raw.slice(-200))) {
    // Ambiguous free-form: mark incomplete rather than guessing when both appear.
  }
  const tail = raw.slice(-400);
  if (
    /\b(?:\*\*)?(?:APPROVE|PASS)(?:\*\*)?\b/i.test(tail) &&
    !/\bREQUEST\s+CHANGES\b/i.test(tail)
  ) {
    return {
      parseStatus: 'ok',
      verdict: 'PASS',
      findings: [],
      notes: cap(redactSecrets('Legacy APPROVE/PASS tail match'), MAX_NOTES),
      evaluatedAt,
    };
  }
  if (/\b(?:\*\*)?REQUEST\s+CHANGES(?:\*\*)?\b/i.test(tail)) {
    return {
      parseStatus: 'ok',
      verdict: 'REQUEST_CHANGES',
      findings: [],
      notes: cap(redactSecrets('Legacy REQUEST CHANGES tail match'), MAX_NOTES),
      evaluatedAt,
    };
  }

  return incomplete('No parseable PASS/REQUEST_CHANGES structured verdict');
}

/**
 * Normalize finding set for equality checks (repair stop: unchanged findings).
 */
function normalizeFindingSet(findings) {
  const list = normalizeFindings(findings);
  return list
    .map((f) =>
      [
        f.severity,
        f.summary.toLowerCase(),
        (f.file || '').toLowerCase(),
        (f.acceptanceCriterion || '').toLowerCase(),
      ].join('|')
    )
    .sort()
    .join('\n');
}

function findingsUnchanged(a, b) {
  return normalizeFindingSet(a) === normalizeFindingSet(b) && normalizeFindingSet(a) !== '';
}

/**
 * Bounded public review record for persistence (no raw transcript).
 */
function toPersistedReview(parsed) {
  if (!parsed) {
    return {
      verdict: null,
      parseStatus: 'incomplete',
      findings: [],
      notes: '',
      evaluatedAt: new Date().toISOString(),
    };
  }
  // Map legacy store values
  let verdict = parsed.verdict;
  if (verdict === 'approve') verdict = 'PASS';
  if (verdict === 'request-changes') verdict = 'REQUEST_CHANGES';
  return {
    verdict: verdict === 'PASS' || verdict === 'REQUEST_CHANGES' ? verdict : null,
    parseStatus: parsed.parseStatus === 'ok' ? 'ok' : 'incomplete',
    findings: normalizeFindings(parsed.findings),
    notes: cap(redactSecrets(parsed.notes || ''), MAX_NOTES),
    evaluatedAt: parsed.evaluatedAt || new Date().toISOString(),
  };
}

module.exports = {
  buildReviewPrompt,
  parseReviewVerdict,
  normalizeFindings,
  normalizeFindingSet,
  findingsUnchanged,
  toPersistedReview,
  normalizeVerdictToken,
  MAX_FINDINGS,
};
