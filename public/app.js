const $ = (s) => document.querySelector(s);
let CAT = [],
  state = {
    ws: null,
    wsPath: null,
    sid: null,
    mode: 'plan',
    es: null,
    running: false,
    activeRun: false,
  };
let activity = { timer: null, selected: null, notRepo: false };
let connectionsTimer = null;
let TEAMS = [],
  SKILLS = [],
  editingTeam = null;
let planDraft = null;
let rateLimitActors = new Set();
const RATE_LIMIT_RE = /rate.?limit|quota|usage limit|429|insufficient|exhaust/i;
const ACTIVE_TEAM_KEY = 'crewforge.activeTeam';
const ONBOARD_KEY = 'crewforge.onboarded';
const SESSION_SORT_KEY = 'crewforge.sessionSort';
const LEFT_WIDTH_KEY = 'crewforge.leftWidth';
const RIGHT_WIDTH_KEY = 'crewforge.rightWidth';
const BOTTOM_H_KEY = 'crewforge.bottomH';
const RIGHT_TAB_KEY = 'crewforge.rightTab';
const CONTEXT_MODE_KEY = 'crewforge.contextMode';
const LEFT_WIDTH_MIN = 200;
const LEFT_WIDTH_MAX = 520;
const RIGHT_WIDTH_MIN = 260;
const RIGHT_WIDTH_MAX = 680;
const BOTTOM_H_MIN = 100;
const BOTTOM_H_MAX = 480;
const BOTTOM_H_DEFAULT = 180;
let sessionSort = localStorage.getItem(SESSION_SORT_KEY) || 'newest';
if (sessionSort !== 'newest' && sessionSort !== 'oldest') sessionSort = 'newest';
let contextMode = localStorage.getItem(CONTEXT_MODE_KEY) || 'balanced';
if (!['off', 'balanced', 'maximum'].includes(contextMode)) contextMode = 'balanced';
let contextSaverInfo = null;
const NOT_REPO_MSG = 'Not a git repository — file activity & diff/review need a git repo';
const COLOR = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
  grok: 'var(--grok)',
  gemini: 'var(--gemini)',
  user: 'var(--user)',
  team: 'var(--ok)',
};
const AV = { claude: 'C', codex: 'Cx', grok: 'Gk', gemini: 'Gm', user: 'You', team: 'Tm' };
const CONNECTIONS = [
  { id: 'claude', name: 'Claude', method: 'CLI subscription login', apiKey: false },
  { id: 'codex', name: 'Codex', method: 'CLI subscription login', apiKey: false },
  { id: 'grok', name: 'Grok', method: 'CLI subscription login', apiKey: false },
  { id: 'gemini', name: 'Gemini', method: 'API key', apiKey: true },
];
const LOGIN_COMMANDS = {
  claude: 'claude login',
  codex: 'codex login',
  grok: 'grok login --device-auth',
};
let onboardingStep = 0,
  onboardingHealth = null,
  onboardingLoading = false;
const esc = (s) =>
  (s || '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s || '';
  return t.value;
}
function safeMarkdownHref(href) {
  const raw = (href || '').trim();
  const decoded = decodeEntities(raw).trim();
  // Strip encoded control characters before scheme validation.
  // eslint-disable-next-line no-control-regex
  const normalized = decoded.replace(/[\u0000-\u001F\u007F\s]+/g, '');
  if (!normalized || normalized.startsWith('//')) return '';
  const scheme = normalized.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (scheme && !['http', 'https'].includes(scheme[1].toLowerCase())) return '';
  return raw;
}

function mdInline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="md-icode">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
      const safe = safeMarkdownHref(href);
      return safe
        ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text;
    })
    .replace(/\n/g, '<br>');
}
function markdownToHtml(raw) {
  if (!raw) return '';
  const lines = esc(raw).split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('```')) {
      i++;
      const code = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(`<pre class="md-pre"><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const h = lines[i].match(/^(#{1,6}) (.+)$/);
    if (h) {
      blocks.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^[-*] /.test(lines[i])) {
      const items = [];
      let m;
      while (i < lines.length && (m = lines[i].match(/^[-*] (.+)$/))) {
        items.push(`<li>${mdInline(m[1])}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(lines[i])) {
      const items = [];
      let m;
      while (i < lines.length && (m = lines[i].match(/^\d+\. (.+)$/))) {
        items.push(`<li>${mdInline(m[1])}</li>`);
        i++;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('```') &&
      !/^#{1,6} /.test(lines[i]) &&
      !/^[-*] /.test(lines[i]) &&
      !/^\d+\. /.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(`<p>${mdInline(para.join('\n'))}</p>`);
  }
  return blocks.join('');
}
async function copyRaw(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent;
    btn.textContent = 'copied';
    setTimeout(() => {
      btn.textContent = prev;
    }, 1200);
  } catch {
    btn.textContent = 'failed';
  }
}
function attachCopyBtn(bubbleEl, raw) {
  if (!bubbleEl || bubbleEl.querySelector('.copyBtn')) return;
  const who = bubbleEl.querySelector('.who');
  if (!who) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copyBtn';
  btn.textContent = 'copy';
  btn.title = 'Copy message';
  btn.onclick = () => copyRaw(raw, btn);
  who.appendChild(btn);
}
function wireReasoningToggle(bubbleEl) {
  const btn = bubbleEl && bubbleEl.querySelector('.reasoning-toggle');
  if (!btn || btn._wired) return;
  btn._wired = true;
  btn.onclick = () => {
    const collapsed = bubbleEl.classList.toggle('collapsed');
    btn.textContent = collapsed ? '▸ show thinking' : '▾ hide thinking';
  };
}
function reasoningBubbleHtml(text) {
  return `<button type="button" class="reasoning-toggle">▸ show thinking</button><div class="body">${esc(text)}</div>`;
}
function setMessageBody(bodyEl, text, asMarkdown) {
  if (asMarkdown) {
    bodyEl.innerHTML = markdownToHtml(text);
    bodyEl.classList.add('md-body');
  } else {
    bodyEl.classList.remove('md-body');
    bodyEl.textContent = text;
  }
}

function notify(message, level = 'error') {
  const stack = $('#toastStack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast ${level}`;
  toast.innerHTML = `<span>${esc(message)}</span><button type="button" aria-label="Dismiss">x</button>`;
  toast.querySelector('button').onclick = () => toast.remove();
  stack.appendChild(toast);
  setTimeout(() => toast.remove(), level === 'info' ? 2500 : 7000);
}

let _sessionExpired = false;
async function api(p, opt) {
  const r = await fetch(p, opt);
  if (r.status === 401) {
    if (!_sessionExpired) {
      _sessionExpired = true;
      notify('Session lost — refresh the page to reconnect.', 'error');
    }
    const err = new Error('session_expired');
    err.sessionExpired = true;
    throw err;
  }
  return r.json();
}
function setRunActive(active) {
  state.activeRun = !!active;
  updateRunControls();
}
function updateRunControls() {
  const active = state.activeRun;
  $('#send').disabled = active;
  $('#stop').style.display = active ? 'inline-block' : 'none';
  $('#stop').disabled = false;
  $('#delegate').disabled = active;
  $('#reviewBtn').disabled = active || activity.notRepo;
  $('#reviewGo').disabled = active || activity.notRepo;
}

// ---------- connections ----------
async function loadConnections() {
  let rows = [];
  let saver = null;
  try {
    rows = await api('/api/keys');
  } catch {}
  try {
    saver = await api('/api/context-saver');
  } catch {}
  renderContextSaverStatus(saver);
  const byProvider = {};
  (rows || []).forEach((r) => {
    byProvider[r.provider] = r;
  });
  $('#connectionsRows').innerHTML = CONNECTIONS.map((c) => {
    const status = byProvider[c.id] || { set: false, masked: null };
    const statusText = c.apiKey
      ? status.set
        ? status.masked
        : 'Not set'
      : 'Managed outside this app';
    const controls = c.apiKey
      ? `<div class="connControls" data-provider="${c.id}">
      <input type="password" autocomplete="off" placeholder="Paste ${esc(c.name)} API key" />
      <button class="btn primary saveKey" type="button">Save</button>
      <button class="btn ghost removeKey" type="button" ${status.set ? '' : 'disabled'}>Remove</button>
    </div>`
      : '';
    return `<div class="connRow">
      <div class="connName" style="color:${COLOR[c.id]}">${esc(c.name)}</div>
      <div class="connMethod">${esc(c.method)}</div>
      <div class="connStatus ${status.set ? 'set' : ''}">${esc(statusText)}</div>
      ${controls}
    </div>`;
  }).join('');
  $('#connectionsRows')
    .querySelectorAll('.saveKey')
    .forEach((btn) => (btn.onclick = saveKey));
  $('#connectionsRows')
    .querySelectorAll('.removeKey')
    .forEach((btn) => (btn.onclick = removeKey));
}
function renderContextSaverStatus(saver) {
  if (!saver || saver.error) {
    $('#contextSaverStatus').innerHTML = '';
    return;
  }
  const headroomState = saver.headroomActive
    ? 'Headroom active'
    : saver.headroomInstalled
      ? 'Headroom installed, needs proxy/API key'
      : 'Using built-in saver';
  const stateClass = saver.headroomActive ? 'set' : saver.headroomInstalled ? 'warn' : '';
  $('#contextSaverStatus').innerHTML = `<div class="contextSaverTitle">Context Saver</div>
    <div class="contextSaverGrid">
      <span>Current behavior</span><strong class="${stateClass}">${esc(headroomState)}</strong>
      <span>Composer setting</span><strong>${esc(contextMode)}</strong>
      <span>Optional install</span><code>npm install headroom-ai</code>
      <span>Optional proxy</span><code>headroom proxy</code>
    </div>`;
}
function updateContextSaverBadge() {
  const badge = $('#contextSaverBadge');
  if (!badge) return;
  badge.classList.remove('set', 'warn');
  if (contextMode === 'off') {
    badge.textContent = 'off';
    badge.title = 'Context Saver is off';
    return;
  }
  if (!contextSaverInfo) {
    badge.textContent = 'checking';
    badge.title = 'Checking Context Saver status';
    return;
  }
  if (contextSaverInfo.headroomActive) {
    badge.textContent = 'Headroom';
    badge.classList.add('set');
    badge.title = 'Headroom is active';
    return;
  }
  badge.textContent = 'built-in';
  badge.classList.add(contextSaverInfo.headroomInstalled ? 'warn' : '');
  badge.title = contextSaverInfo.headroomInstalled
    ? 'Headroom is installed but not configured. Open details.'
    : 'Using built-in saver. Open details for Headroom setup.';
}
async function refreshContextSaverInfo() {
  try {
    contextSaverInfo = await api('/api/context-saver');
  } catch {
    contextSaverInfo = null;
  }
  updateContextSaverBadge();
}
function contextSaverStateText() {
  if (!contextSaverInfo) return 'Checking current status.';
  if (contextMode === 'off') return 'Context Saver is off for new runs.';
  if (contextSaverInfo.headroomActive) return 'Headroom is active for new runs.';
  if (contextSaverInfo.headroomInstalled)
    return 'Crew Forge is using the built-in saver. Headroom is installed but not configured.';
  return 'Crew Forge is using the built-in saver. Headroom is not installed or configured.';
}
function openContextSaverInfo() {
  const headroomActive = contextSaverInfo && contextSaverInfo.headroomActive;
  $('#contextSaverInfoBody').innerHTML = `<h4>${esc(contextSaverStateText())}</h4>
    <p><strong>Built-in saver</strong> ships with Crew Forge. It keeps recent turns, summarizes older turns, preserves touched-file hints, and caps context before each model call.</p>
    <p><strong>Headroom</strong> is optional. Crew Forge can use it only when the optional package and proxy/API are configured for this app.</p>
    <ul>
      <li>Install optional package here: <code>npm install headroom-ai</code></li>
      <li>Start the proxy separately: <code>headroom proxy</code></li>
      <li>Set <code>HEADROOM_BASE_URL</code> or <code>HEADROOM_API_KEY</code>, then restart Crew Forge.</li>
    </ul>
    <p>Installing Headroom for Crew Forge does not automatically install or wrap Claude Code, Codex, or Grok outside this app. Use Headroom Desktop or Headroom wrapper setup if you want those tools covered globally.</p>
    <p>${headroomActive ? 'The badge will show Headroom while that path is active.' : 'Until then, the badge shows built-in and Crew Forge uses its local saver.'}</p>`;
  $('#contextSaverModal').classList.add('show');
}
function closeContextSaverInfo() {
  $('#contextSaverModal').classList.remove('show');
}
function openConnections() {
  $('#connectionsModal').classList.add('show');
  loadConnections();
  if (!connectionsTimer) connectionsTimer = setInterval(loadConnections, 10000);
}
function closeConnections() {
  $('#connectionsModal').classList.remove('show');
  if (connectionsTimer) {
    clearInterval(connectionsTimer);
    connectionsTimer = null;
  }
}
async function saveKey(e) {
  const button = e.target;
  const row = e.target.closest('.connControls');
  const provider = row.dataset.provider;
  const input = row.querySelector('input');
  const key = input.value.trim();
  if (!key) return notify('Paste a key first.');
  button.disabled = true;
  const r = await api('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  });
  button.disabled = false;
  if (r.error) return notify(r.error);
  input.value = '';
  await loadConnections();
}
async function removeKey(e) {
  const button = e.target;
  const row = e.target.closest('.connControls');
  const provider = row.dataset.provider;
  button.disabled = true;
  const r = await api('/api/keys?provider=' + encodeURIComponent(provider), { method: 'DELETE' });
  button.disabled = false;
  if (r.error) return notify(r.error);
  await loadConnections();
}
$('#connectionsBtn').onclick = openConnections;
$('#connectionsClose').onclick = closeConnections;
$('#connectionsRefresh').onclick = loadConnections;

// ---------- onboarding ----------
function openOnboarding(step = 0) {
  onboardingStep = step;
  $('#onboardingModal').classList.add('show');
  renderOnboarding();
}
function closeOnboarding() {
  $('#onboardingModal').classList.remove('show');
}
async function loadOnboardingHealth() {
  onboardingLoading = true;
  renderOnboarding();
  try {
    onboardingHealth = await api('/api/health');
  } catch {
    onboardingHealth = null;
  } finally {
    onboardingLoading = false;
    renderOnboarding();
  }
}
function renderHealthRows() {
  if (onboardingLoading)
    return '<div class="healthList"><div class="healthRow"><div class="healthMeta">Checking providers...</div></div></div>';
  if (!onboardingHealth)
    return '<div class="healthList"><div class="healthRow"><div class="healthMeta">Unable to load provider health.</div></div></div>';
  return `<div class="healthList">${onboardingHealth
    .map((p) => {
      const cmd = LOGIN_COMMANDS[p.id];
      const actions =
        p.kind === 'cli'
          ? `<code>${esc(cmd || '')}</code><button class="btn ghost onboardCopy" type="button" data-copy="${esc(cmd || '')}">Copy</button>`
          : `<button class="btn ghost onboardConnections" type="button">Open Connections</button>`;
      return `<div class="healthRow">
      <div class="healthIcon ${p.ready ? 'ok' : 'bad'}">${p.ready ? '✓' : '✗'}</div>
      <div>
        <div class="healthName" style="color:${COLOR[p.id] || 'var(--text)'}">${esc(p.label)}</div>
        <div class="healthMeta">${esc(p.kind.toUpperCase())} · ${p.ready ? 'Ready' : 'Needs setup'}</div>
        ${p.ready ? '' : `<div class="healthHint">${esc(p.hint)}</div>`}
      </div>
      <div class="healthActions">${actions}</div>
    </div>`;
    })
    .join('')}</div>`;
}
function renderOnboarding() {
  const titles = ['Welcome', 'Connect your models', 'Add a workspace', 'Done'];
  let body = '';
  if (onboardingStep === 0) {
    body = `<div class="onboardStep">Step 1 of 4</div>
      <h4>${titles[0]}</h4>
      <p>Use multiple local AI providers against one workspace, keep session history, review changes, and delegate work across a small team.</p>
      <div class="safetyCallout">Runs locally (127.0.0.1 only). Edit mode lets AI agents run commands and modify files in the folder you choose — only use trusted folders.</div>`;
  } else if (onboardingStep === 1) {
    body = `<div class="onboardStep">Step 2 of 4</div>
      <h4>${titles[1]}</h4>
      <p>Check which providers are ready on this machine. CLI providers need their tools installed and signed in; Gemini needs an API key.</p>
      <div class="row" style="margin:0 0 10px"><button class="btn ghost" id="onboardingRefresh" type="button">Refresh</button></div>
      ${renderHealthRows()}`;
  } else if (onboardingStep === 2) {
    body = `<div class="onboardStep">Step 3 of 4</div>
      <h4>${titles[2]}</h4>
      <p>Add the folder you want this app to work in. Choose a trusted project folder, especially before using Edit mode.</p>
      <button class="btn primary" id="onboardingAddWorkspace" type="button">Add workspace</button>`;
  } else {
    body = `<div class="onboardStep">Step 4 of 4</div>
      <h4>${titles[3]}</h4>
      <p>Send your first message in Plan mode (read-only) to try it safely.</p>
      <p><a class="onboardGuide" href="/ONBOARDING.md" target="_blank" rel="noopener noreferrer">Read ONBOARDING.md for the full guide</a>.</p>`;
  }
  $('#onboardingBody').innerHTML = body;
  $('#onboardingBack').style.visibility = onboardingStep ? 'visible' : 'hidden';
  $('#onboardingNext').textContent = onboardingStep === 3 ? 'Finish' : 'Next';
  $('#onboardingRefresh') && ($('#onboardingRefresh').onclick = loadOnboardingHealth);
  $('#onboardingAddWorkspace') && ($('#onboardingAddWorkspace').onclick = () => openFs());
  $('#onboardingBody')
    .querySelectorAll('.onboardCopy')
    .forEach((btn) => (btn.onclick = () => copyRaw(btn.dataset.copy, btn)));
  $('#onboardingBody')
    .querySelectorAll('.onboardConnections')
    .forEach((btn) => (btn.onclick = openConnections));
  if (onboardingStep === 1 && !onboardingHealth && !onboardingLoading) loadOnboardingHealth();
}
$('#onboardingBtn').onclick = () => openOnboarding();
$('#onboardingClose').onclick = closeOnboarding;
$('#onboardingBack').onclick = () => {
  if (onboardingStep > 0) {
    onboardingStep--;
    renderOnboarding();
  }
};
$('#onboardingNext').onclick = () => {
  if (onboardingStep < 3) {
    onboardingStep++;
    renderOnboarding();
    return;
  }
  localStorage.setItem(ONBOARD_KEY, '1');
  closeOnboarding();
};

// ---------- session sort ----------
function updateSortBtn() {
  const btn = $('#sessSort');
  if (!btn) return;
  if (sessionSort === 'newest') {
    btn.textContent = '↓';
    btn.title = 'Newest first — click for oldest first';
  } else {
    btn.textContent = '↑';
    btn.title = 'Oldest first — click for newest first';
  }
}
function sortSessions(list) {
  const sorted = [...list];
  sorted.sort((a, b) => {
    const am = a.mtime != null ? Number(a.mtime) : null;
    const bm = b.mtime != null ? Number(b.mtime) : null;
    if (am != null && bm != null) return sessionSort === 'newest' ? bm - am : am - bm;
    if (am != null) return sessionSort === 'newest' ? -1 : 1;
    if (bm != null) return sessionSort === 'newest' ? 1 : -1;
    const cmp = String(a.id).localeCompare(String(b.id));
    return sessionSort === 'newest' ? -cmp : cmp;
  });
  return sorted;
}
$('#sessSort').onclick = () => {
  sessionSort = sessionSort === 'newest' ? 'oldest' : 'newest';
  localStorage.setItem(SESSION_SORT_KEY, sessionSort);
  updateSortBtn();
  loadSessions();
};
updateSortBtn();

// ---------- resizable left sidebar ----------
function setLeftWidth(w) {
  w = Math.max(LEFT_WIDTH_MIN, Math.min(LEFT_WIDTH_MAX, w));
  document.body.style.setProperty('--leftw', w + 'px');
  localStorage.setItem(LEFT_WIDTH_KEY, String(w));
}
function setRightWidth(w) {
  w = Math.max(RIGHT_WIDTH_MIN, Math.min(RIGHT_WIDTH_MAX, w));
  document.body.style.setProperty('--rightw', w + 'px');
  localStorage.setItem(RIGHT_WIDTH_KEY, String(w));
}
function initLeftResize() {
  const saved = localStorage.getItem(LEFT_WIDTH_KEY);
  if (saved) {
    const w = parseInt(saved, 10);
    if (!isNaN(w)) setLeftWidth(w);
  }
  const handle = $('#leftResize');
  let dragging = false,
    startX = 0,
    startW = 0;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = parseInt(getComputedStyle(document.body).getPropertyValue('--leftw'), 10) || 280;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    setLeftWidth(startW + (e.clientX - startX));
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });
}
initLeftResize();

function initRightResize() {
  const saved = localStorage.getItem(RIGHT_WIDTH_KEY);
  if (saved) {
    const w = parseInt(saved, 10);
    if (!isNaN(w)) setRightWidth(w);
  }
  const handle = $('#rightResize');
  let dragging = false,
    startX = 0,
    startW = 0;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = parseInt(getComputedStyle(document.body).getPropertyValue('--rightw'), 10) || 340;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    setRightWidth(startW - (e.clientX - startX));
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });
}
initRightResize();

// ---------- resizable composer (bottom pane) ----------
function setBottomH(h) {
  h = Math.max(BOTTOM_H_MIN, Math.min(BOTTOM_H_MAX, h));
  document.body.style.setProperty('--bottomh', h + 'px');
  localStorage.setItem(BOTTOM_H_KEY, String(h));
}
function initBottomResize() {
  const saved = localStorage.getItem(BOTTOM_H_KEY);
  if (saved) {
    const h = parseInt(saved, 10);
    if (!isNaN(h)) setBottomH(h);
  }
  const handle = $('#composerResize');
  let dragging = false,
    startY = 0,
    startH = 0;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH =
      parseInt(getComputedStyle(document.body).getPropertyValue('--bottomh'), 10) ||
      BOTTOM_H_DEFAULT;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    setBottomH(startH - (e.clientY - startY));
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });
}
initBottomResize();

// ---------- right panel tabs ----------
function switchRightTab(name) {
  document.querySelectorAll('.panelTab').forEach((btn) => {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.panelPane').forEach((pane) => {
    pane.classList.toggle(
      'hidden',
      pane.id !== 'pane' + name.charAt(0).toUpperCase() + name.slice(1)
    );
  });
  localStorage.setItem(RIGHT_TAB_KEY, name);
}
document.querySelectorAll('.panelTab').forEach((btn) => {
  btn.onclick = () => switchRightTab(btn.dataset.tab);
});
(function initRightTab() {
  const saved = localStorage.getItem(RIGHT_TAB_KEY);
  if (saved && ['files', 'terminal', 'preview', 'changes', 'usage'].includes(saved))
    switchRightTab(saved);
})();

// ---------- file explorer ----------
const fileExplorer = { root: null, current: null, data: null, filter: '' };

function fileExt(name) {
  const m = name.match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}
function fileIcon(name) {
  const ext = fileExt(name);
  const code = [
    'js',
    'ts',
    'jsx',
    'tsx',
    'mjs',
    'cjs',
    'py',
    'rb',
    'go',
    'rs',
    'java',
    'c',
    'cpp',
    'h',
  ];
  const data = ['json', 'yaml', 'yml', 'toml', 'env', 'xml', 'csv'];
  const doc = ['md', 'txt', 'rst', 'log'];
  const style = ['css', 'scss', 'sass', 'less'];
  if (code.includes(ext)) return '{}';
  if (data.includes(ext)) return '⚙';
  if (doc.includes(ext)) return '≡';
  if (style.includes(ext)) return '#';
  if (['html', 'htm', 'svg'].includes(ext)) return '⟨⟩';
  return '·';
}

async function openWsFiles(rootPath, navPath) {
  fileExplorer.root = rootPath;
  fileExplorer.current = navPath || rootPath;
  if (!rootPath) {
    fileExplorer.data = null;
    fileExplorer.filter = '';
    $('#fileFilter').value = '';
    $('#fileTree').innerHTML = '<div class="actEmpty">No workspace selected.</div>';
    $('#filePanePath').textContent = '';
    $('#filePaneUp').disabled = true;
    return;
  }
  $('#fileTree').innerHTML = '<div class="actEmpty">Loading…</div>';
  try {
    const requestedPath = fileExplorer.current;
    const url = '/api/fs?includeFiles=1&path=' + encodeURIComponent(requestedPath);
    const d = await api(url);
    if (fileExplorer.current !== requestedPath) return;
    if (d.error) {
      $('#fileTree').innerHTML = `<div class="actEmpty">${esc(d.error)}</div>`;
      return;
    }
    fileExplorer.data = d;
    renderFileTree(d);
  } catch (_e) {
    $('#fileTree').innerHTML = '<div class="actEmpty">Unable to load files.</div>';
  }
}

function renderFileTree(d) {
  if (!d) return;
  const filter = fileExplorer.filter;
  const relLabel = fileExplorer.root
    ? fileExplorer.current === fileExplorer.root
      ? '/'
      : fileExplorer.current.replace(fileExplorer.root, '').replace(/\\/g, '/') || '/'
    : '';
  $('#filePanePath').textContent = relLabel;
  $('#filePaneUp').disabled = !d.parent || fileExplorer.current === fileExplorer.root;

  const dirs = (d.dirs || []).filter((x) => !filter || x.name.toLowerCase().includes(filter));
  const files = (d.files || []).filter((x) => !filter || x.name.toLowerCase().includes(filter));

  if (!dirs.length && !files.length) {
    $('#fileTree').innerHTML = filter
      ? `<div class="actEmpty">No matches for "${esc(filter)}".</div>`
      : '<div class="actEmpty">Empty directory.</div>';
    return;
  }

  const dirHtml = dirs
    .map(
      (x) =>
        `<button type="button" class="fileEntry dir" data-path="${esc(x.path)}" title="${esc(x.name)}/">` +
        `<span class="fileIcon" aria-hidden="true">▶</span>` +
        `<span class="fileName">${esc(x.name)}/</span>` +
        `</button>`
    )
    .join('');
  const fileHtml = files
    .map(
      (x) =>
        `<button type="button" class="fileEntry file" data-path="${esc(x.path)}" title="Click to copy path: ${esc(x.name)}">` +
        `<span class="fileIcon" aria-hidden="true">${esc(fileIcon(x.name))}</span>` +
        `<span class="fileName">${esc(x.name)}</span>` +
        `</button>`
    )
    .join('');

  $('#fileTree').innerHTML = dirHtml + fileHtml;
  $('#fileTree')
    .querySelectorAll('.fileEntry.dir')
    .forEach((btn) => {
      btn.onclick = () => openWsFiles(fileExplorer.root, btn.dataset.path);
    });
  $('#fileTree')
    .querySelectorAll('.fileEntry.file')
    .forEach((btn) => {
      btn.onclick = async () => {
        const rel = fileExplorer.root
          ? btn.dataset.path.replace(fileExplorer.root, '').replace(/^[/\\]/, '')
          : btn.dataset.path;
        const inChanges = (activity.changedFiles || []).find((f) => f.path === rel);
        if (inChanges) {
          switchRightTab('changes');
          activity.selected = inChanges.path;
          if (activity.lastChanges) renderChanges(activity.lastChanges);
          loadDiff(inChanges.path);
          return;
        }
        try {
          await navigator.clipboard.writeText(rel);
          notify(`Copied: ${rel}`, 'info');
        } catch (_e) {
          notify(`Copy failed — ${rel}`, 'info');
        }
      };
    });
  if (d.truncated) {
    $('#fileTree').insertAdjacentHTML(
      'beforeend',
      `<div class="actEmpty" style="font-size:10.5px;padding-top:6px">… showing ${(d.dirs || []).length + (d.files || []).length} of ${d.total} entries</div>`
    );
  }
}

$('#filePaneUp').onclick = () => {
  if (!fileExplorer.data || !fileExplorer.data.parent) return;
  if (fileExplorer.current === fileExplorer.root) return;
  openWsFiles(fileExplorer.root, fileExplorer.data.parent);
};
$('#fileRefresh').onclick = () => {
  if (fileExplorer.root) openWsFiles(fileExplorer.root, fileExplorer.current);
};

// ---------- dev server runner ----------
const devState = { running: false, es: null, savedCmd: '' };
const DEV_CMD_KEY = 'crewforge.devCmd';

function devStatusText(info) {
  if (!info) return '';
  if (info.running) return `● Running: ${info.cmd}  (pid ${info.pid})`;
  return '';
}

function setDevRunning(running, info) {
  devState.running = running;
  $('#devRun').style.display = running ? 'none' : '';
  $('#devStop').style.display = running ? '' : 'none';
  $('#termStatus').textContent = running && info ? devStatusText(info) : running ? '● Running' : '';
}

function appendTermLine(text, cls) {
  const pre = $('#termOutput');
  const meta = pre.querySelector('.termMeta');
  if (meta) meta.remove();
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text + '\n';
  pre.appendChild(span);
  pre.scrollTop = pre.scrollHeight;
}

function clearTermOutput() {
  $('#termOutput').innerHTML = '<span class="termMeta">Output cleared.</span>';
}

function openDevStream() {
  if (devState.es) {
    devState.es.close();
    devState.es = null;
  }
  if (!state.ws) return;
  const es = new EventSource('/api/dev/stream?ws=' + encodeURIComponent(state.ws));
  devState.es = es;
  es.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      appendTermLine(
        d.text,
        d.type === 'stderr' ? 'stderr' : d.type === 'exit' ? 'exit' : 'stdout'
      );
      if (d.type === 'exit') setDevRunning(false, null);
    } catch {}
  };
  es.onerror = () => {
    es.close();
    devState.es = null;
  };
}

async function startDev() {
  if (!state.ws) return notify('Select a workspace first.');
  const cmd = $('#devCmd').value.trim();
  if (!cmd) return notify('Enter a start command (e.g. npm start).');
  localStorage.setItem(DEV_CMD_KEY, cmd);
  $('#termOutput').innerHTML = `<span class="termMeta">Starting: ${esc(cmd)}…</span>`;
  try {
    const r = await api('/api/dev/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ws: state.ws, cmd }),
    });
    if (r.error) return notify(r.error);
    setDevRunning(true, r);
    openDevStream();
  } catch (_e) {
    notify('Unable to start process.');
  }
}

async function stopDev() {
  if (!state.ws) return;
  try {
    await api('/api/dev/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ws: state.ws }),
    });
    setDevRunning(false, null);
    if (devState.es) {
      devState.es.close();
      devState.es = null;
    }
  } catch (_e) {
    notify('Unable to stop process.');
  }
}

async function syncDevStatus() {
  if (!state.ws) return;
  try {
    const info = await api('/api/dev/status?ws=' + encodeURIComponent(state.ws));
    if (info.running) {
      setDevRunning(true, info);
      openDevStream();
    } else {
      setDevRunning(false, null);
    }
  } catch {}
}

$('#devRun').onclick = startDev;
$('#devStop').onclick = stopDev;
$('#devClear').onclick = clearTermOutput;
$('#devCmd').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startDev();
});
(function initDevCmd() {
  const saved = localStorage.getItem(DEV_CMD_KEY);
  if (saved) $('#devCmd').value = saved;
})();

// ---------- agent log ----------
const agentLog = [];

function appendAgentLog(text) {
  agentLog.push(text);
  const pre = $('#agentLog');
  const meta = pre.querySelector('.termMeta');
  if (meta) meta.remove();
  const span = document.createElement('span');
  span.className = 'stdout';
  span.textContent = text + '\n';
  pre.appendChild(span);
  pre.scrollTop = pre.scrollHeight;
}

function clearAgentLog() {
  agentLog.length = 0;
  $('#agentLog').innerHTML = '<span class="termMeta">No commands yet.</span>';
}

$('#agentLogToggle').onclick = () => {
  const body = $('#agentLogBody');
  const collapsed = body.classList.toggle('hidden');
  $('#agentLogToggle').textContent = collapsed ? '▾ show' : '▴ hide';
};

// ---------- preview pane ----------
function loadPreview() {
  const url = $('#previewUrl').value.trim();
  if (!url) return;
  $('#previewFrame').src = url;
  $('#previewExternal').href = url;
}

$('#previewLoad').onclick = loadPreview;
$('#previewUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadPreview();
});
$('#previewUrl').addEventListener('input', () => {
  $('#previewExternal').href = $('#previewUrl').value.trim() || '#';
});
$('#fileFilter').oninput = () => {
  fileExplorer.filter = $('#fileFilter').value.trim().toLowerCase();
  renderFileTree(fileExplorer.data);
};

// ---------- bootstrap ----------
(async () => {
  CAT = await api('/api/catalog');
  await loadSkills();
  $('#provider').innerHTML = CAT.map(
    (a) =>
      `<option value="${a.id}" data-edit="${a.canEdit}">${esc(a.label)}${a.canEdit ? '' : ' (text only)'}</option>`
  ).join('');
  $('#provider').onchange = () => {
    populateComposerModels();
    updateCaps();
    populateReviewModels();
  };
  $('#model').onchange = updateCaps;
  $('#contextMode').value = contextMode;
  $('#contextMode').onchange = () => {
    contextMode = $('#contextMode').value;
    localStorage.setItem(CONTEXT_MODE_KEY, contextMode);
    updateContextSaverBadge();
    if (contextMode !== 'off' && contextSaverInfo && !contextSaverInfo.headroomActive) {
      notify('Using built-in Context Saver. Open Connections for Headroom install steps.', 'warn');
    }
  };
  $('#contextSaverBadge').onclick = openContextSaverInfo;
  $('#contextSaverClose').onclick = closeContextSaverInfo;
  $('#contextSaverOpenConnections').onclick = () => {
    closeContextSaverInfo();
    openConnections();
  };
  populateComposerModels();
  updateCaps();
  populateReviewModels();
  await loadWorkspaces();
  await loadTeams();
  loadUsage();
  refreshContextSaverInfo();
  setInterval(loadUsage, 10000);
  if (!localStorage.getItem(ONBOARD_KEY)) openOnboarding();
})();

function selectedProvider() {
  return CAT.find((x) => x.id === $('#provider').value);
}
function populateComposerModels() {
  const a = selectedProvider();
  if (!a) {
    $('#model').innerHTML = '';
    return;
  }
  $('#model').innerHTML = (a.models || [])
    .map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)
    .join('');
  if (a.defaultModel) $('#model').value = a.defaultModel;
}
function updateCaps() {
  const a = selectedProvider();
  $('#caps').textContent = a ? `models: ${a.models.join(', ')}` : '';
  const editBtn = $('#mode').querySelector('[data-m=edit]');
  if (a && !a.canEdit) {
    editBtn.disabled = true;
    editBtn.style.opacity = 0.4;
    if (state.mode === 'edit') setMode('plan');
  } else {
    editBtn.disabled = false;
    editBtn.style.opacity = 1;
  }
}
function setMode(m) {
  state.mode = m;
  $('#mode')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', b.dataset.m === m));
}
$('#mode')
  .querySelectorAll('button')
  .forEach((b) => (b.onclick = () => !b.disabled && setMode(b.dataset.m)));

// ---------- workspaces ----------
let live = {}; // key actor:type -> {body, raw} (open delta bubble)
async function loadWorkspaces() {
  const list = await api('/api/workspaces');
  $('#ws').innerHTML =
    list.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('') ||
    '<option value="">— none —</option>';
  $('#forgetWs').disabled = !list.length;
  if (list.length) {
    const next = state.ws && list.some((w) => w.id === state.ws) ? state.ws : list[0].id;
    $('#ws').value = next;
    selectWs(next, list);
    return;
  }
  clearWorkspace();
}
$('#ws').onchange = () => selectWs($('#ws').value);
function clearWorkspace() {
  state.ws = null;
  state.wsPath = null;
  state.sid = null;
  live = {};
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  openWsFiles(null);
  $('#wsName').textContent = 'No workspace';
  $('#wsPath').textContent = 'pick or add a folder to begin';
  $('#sessList').innerHTML =
    '<div style="color:var(--muted);padding:10px;font-size:12px">No workspace selected.</div>';
  $('#feed').innerHTML =
    '<div class="empty">Pick a workspace and a model, then send a message to watch it work.</div>';
  $('#actState').textContent = 'Idle';
  $('#actFiles').innerHTML = '<div class="actEmpty">No workspace selected.</div>';
  $('#actStat').textContent = '';
  $('#diffTitle').textContent = 'Diff';
  $('#diffOut').textContent = 'Select a changed file or refresh the diff.';
  $('#forgetWs').disabled = true;
}
async function selectWs(id, list) {
  list = list || (await api('/api/workspaces'));
  const w = list.find((x) => x.id === id);
  if (!w) return;
  state.ws = id;
  state.wsPath = w.path;
  $('#wsName').textContent = w.name;
  $('#wsPath').textContent = w.path;
  activity.selected = null;
  openWsFiles(w.path);
  syncDevStatus();
  await loadChanges();
  await loadSessions();
}
async function forgetWorkspace() {
  if (!state.ws) return;
  const name = $('#wsName').textContent || 'this workspace';
  const ws = state.ws;
  if (
    !confirm(
      `Forget "${name}" from the workspace list? This will not delete files or session history.`
    )
  )
    return;
  const r = await api('/api/workspaces?id=' + encodeURIComponent(ws), { method: 'DELETE' });
  if (r.error) return notify(r.error);
  if (state.ws === ws) {
    state.ws = null;
    state.wsPath = null;
    state.sid = null;
  }
  await loadWorkspaces();
}
$('#forgetWs').onclick = forgetWorkspace;
async function loadSessions() {
  const list = sortSessions(await api('/api/sessions?ws=' + state.ws));
  $('#sessList').innerHTML =
    list
      .map(
        (s) =>
          `<div class="sess ${s.id === state.sid ? 'active' : ''}" data-id="${s.id}"><div class="t">${esc(s.title)}</div><div class="m">${s.count} events</div></div>`
      )
      .join('') ||
    '<div style="color:var(--muted);padding:10px;font-size:12px">No sessions yet — send a message.</div>';
  $('#sessList')
    .querySelectorAll('.sess')
    .forEach((d) => (d.onclick = () => openSession(d.dataset.id)));
}
$('#newSess').onclick = async () => {
  if (!state.ws) return notify('Add a workspace first');
  const r = await api('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ws: state.ws }),
  });
  await loadSessions();
  openSession(r.id);
};

// ---------- session stream ----------
function openSession(sid) {
  state.sid = sid;
  live = {};
  setRunActive(false);
  $('#feed').innerHTML = '';
  clearAgentLog();
  loadSessions();
  stopActivityPoll();
  if (state.es) state.es.close();
  const es = new EventSource(`/api/stream?ws=${state.ws}&sid=${sid}&off=0`);
  state.es = es;
  es.onmessage = (ev) => {
    try {
      render(JSON.parse(ev.data));
    } catch {}
  };
}
function feedEl() {
  return $('#feed');
}
function scrollFeed() {
  const f = $('.feed');
  f.scrollTop = f.scrollHeight;
}

function bubble(actor, role, cls, html) {
  const left = actor !== 'user';
  return `<div class="turn ${left ? 'left' : 'user'}"><div class="av" style="background:${COLOR[actor] || 'var(--user)'}">${AV[actor] || '?'}</div>
    <div class="bubble ${cls}"><div class="who" style="color:${COLOR[actor] || 'var(--text)'}">${actor}${role && role !== 'agent' ? `<span class="role">${role}</span>` : ''}</div>${html}</div></div>`;
}
function appendHTML(h) {
  feedEl().insertAdjacentHTML('beforeend', h);
  scrollFeed();
  return feedEl().lastElementChild;
}

function finalizeActor(actor) {
  for (const k in live) if (k.startsWith(actor + ':')) delete live[k];
}

function showRateLimitBanner(actor) {
  const inner = feedEl();
  let banner = inner.querySelector('.rateBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'rateBanner';
    inner.insertBefore(banner, inner.firstChild);
  }
  banner.innerHTML = `<span>⚠ ${esc(actor)} hit a usage/rate limit — switch models or wait.</span><button class="rateBannerDismiss" type="button" aria-label="Dismiss">✕</button>`;
  banner.querySelector('.rateBannerDismiss').onclick = () => banner.remove();
}

function maybeRateLimitError(actor, text) {
  if (!RATE_LIMIT_RE.test(text || '')) return false;
  rateLimitActors.add(actor);
  showRateLimitBanner(actor);
  loadUsage();
  return true;
}

function render(e) {
  const f = feedEl();
  if (f.querySelector('.empty')) f.innerHTML = '';
  const { kind, actor, role, type, text, meta } = e;

  if (kind === 'user') {
    appendHTML(bubble('user', '', ' ', `<div class="body">${esc(text)}</div>`));
    return;
  }
  if (kind === 'system') {
    if (type === 'error') {
      maybeRateLimitError(actor, text);
      setRunActive(false);
      stopActivityPoll();
      loadChanges();
      appendHTML(`<div class="turn left status err"><div class="body">⚠ ${esc(text)}</div></div>`);
      return;
    }
    if (type === 'plan') {
      const steps = (meta && meta.steps) || [];
      const body = steps.map((s, i) => `${i + 1}. member ${s.memberIndex}: ${s.task}`).join('\n');
      appendHTML(bubble('team', '', '', `<div class="body">${esc(body || text)}</div>`));
      return;
    }
    const running = meta && meta.running;
    if (running) {
      setRunActive(true);
      startActivityPoll();
    }
    appendHTML(
      `<div class="status">${running ? '<span class="dot"></span>' : '—'} ${esc(text)} ${meta && meta.done ? '✓' : ''}</div>`
    );
    if (meta && meta.done) {
      finalizeActor(actor);
      setRunActive(false);
      stopActivityPoll();
      loadChanges();
    }
    return;
  }
  // agent events
  const key = actor + ':' + type;
  if (meta && meta.delta && (type === 'message' || type === 'reasoning')) {
    if (!live[key]) {
      const inner = type === 'reasoning' ? reasoningBubbleHtml('') : '<div class="body"></div>';
      const cls = type === 'reasoning' ? 'reasoning collapsed' : '';
      const el = appendHTML(bubble(actor, role, cls, inner));
      const bubbleEl = el.querySelector('.bubble');
      if (type === 'reasoning') wireReasoningToggle(bubbleEl);
      live[key] = { body: el.querySelector('.body'), raw: '' };
    }
    live[key].raw += text;
    live[key].body.textContent = live[key].raw;
    scrollFeed();
    return;
  }
  if (meta && meta.final && (type === 'message' || type === 'reasoning')) {
    if (live[key]) {
      const { body } = live[key];
      const bubbleEl = body.closest('.bubble');
      if (type === 'message') {
        setMessageBody(body, text, true);
        attachCopyBtn(bubbleEl, text);
      } else body.textContent = text;
      delete live[key];
    } else if (type === 'message') {
      const el = appendHTML(
        bubble(actor, role, '', `<div class="body md-body">${markdownToHtml(text)}</div>`)
      );
      attachCopyBtn(el.querySelector('.bubble'), text);
    } else {
      const el = appendHTML(bubble(actor, role, 'reasoning collapsed', reasoningBubbleHtml(text)));
      wireReasoningToggle(el.querySelector('.bubble'));
    }
    return;
  }
  if (type === 'command') {
    finalizeActor(actor);
    appendHTML(bubble(actor, role, 'mono', `<div class="body">$ ${esc(text)}</div>`));
    appendAgentLog(`[${actor}] $ ${text}`);
    return;
  }
  if (type === 'file_change') {
    finalizeActor(actor);
    appendHTML(bubble(actor, role, 'file', `<div class="body">✎ ${esc(text)}</div>`));
    return;
  }
  if (type === 'usage') {
    appendHTML(`<div class="chip">${esc(text)}</div>`);
    return;
  }
  if (type === 'rate_limit') {
    appendHTML(`<div class="chip warn">rate-limit: ${esc(text)}</div>`);
    return;
  }
  if (type === 'status') {
    appendHTML(`<div class="status">${esc(text)}</div>`);
    return;
  }
  if (type === 'error') {
    maybeRateLimitError(actor, text);
    appendHTML(bubble(actor, role, 'err', `<div class="body">⚠ ${esc(text)}</div>`));
    return;
  }
}

// ---------- send ----------
async function ensureSession() {
  if (state.sid) return;
  const r = await api('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ws: state.ws }),
  });
  openSession(r.id);
  await new Promise((resolve) => {
    setTimeout(resolve, 120);
  });
}
async function send() {
  if (!state.ws) return notify('Add/select a workspace first');
  if (state.activeRun) return notify('A run is already active in this session.');
  const prompt = $('#prompt').value.trim();
  if (!prompt) return;
  await ensureSession();
  $('#prompt').value = '';
  setRunActive(true);
  startActivityPoll();
  try {
    const r = await api('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ws: state.ws,
        sid: state.sid,
        adapter: $('#provider').value,
        model: $('#model').value,
        mode: state.mode,
        prompt,
        contextMode,
      }),
    });
    if (r.error) {
      setRunActive(false);
      stopActivityPoll();
      return notify(r.error);
    }
    loadUsage();
  } catch (_e) {
    setRunActive(false);
    stopActivityPoll();
    notify('Unable to start run.');
  }
}
$('#send').onclick = send;
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    send();
  }
});
async function stopRun() {
  if (!state.ws || !state.sid || !state.activeRun) return;
  $('#stop').disabled = true;
  try {
    const r = await api('/api/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ws: state.ws, sid: state.sid }),
    });
    if (r.error) {
      $('#stop').disabled = false;
      return notify(r.error);
    }
    setRunActive(false);
    stopActivityPoll();
    loadChanges();
  } catch (_e) {
    $('#stop').disabled = false;
    notify('Unable to stop run.');
  }
}
$('#stop').onclick = stopRun;

// ---------- usage ----------
const PROVIDER_ORDER = ['claude', 'codex', 'grok', 'gemini'];
function stripTrailingZero(v) {
  return v.toFixed(1).replace(/\.0$/, '');
}
function humanTokens(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return `${stripTrailingZero(n / 1000)}k`;
  return `${stripTrailingZero(n / 1000000)}M`;
}
function formatResetsIn(resetsAt) {
  const sec = Number(resetsAt) * 1000 - Date.now();
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const h = Math.floor(sec / 3600000);
  const m = Math.floor((sec % 3600000) / 60000);
  return `${h}h ${m}m`;
}
function renderUsage(data) {
  const providers = (data && data.providers) || {};
  const actors = PROVIDER_ORDER.filter(
    (a) =>
      providers[a] &&
      (providers[a].calls > 0 || providers[a].tokensIn > 0 || providers[a].tokensOut > 0)
  );
  if (!actors.length) {
    $('#usageRows').innerHTML = '<div class="usageEmpty">No usage recorded yet.</div>';
    return;
  }
  $('#usageRows').innerHTML = actors
    .map((actor) => {
      const p = providers[actor];
      const color = COLOR[actor] || 'var(--text)';
      let stats = `${p.calls} call${p.calls === 1 ? '' : 's'} · in ${humanTokens(p.tokensIn)} · out ${humanTokens(p.tokensOut)}`;
      if (p.costUsd > 0) stats += ` · <span class="cost">$${p.costUsd.toFixed(4)}</span>`;
      let limit = '';
      const isLimited =
        (p.lastRateLimit && p.lastRateLimit.status !== 'allowed') || rateLimitActors.has(actor);
      if (isLimited) stats += `<span class="usageLimited">limited</span>`;
      if (actor === 'claude' && p.lastRateLimit && p.lastRateLimit.resetsAt) {
        const left = formatResetsIn(p.lastRateLimit.resetsAt);
        if (left) limit = `<div class="usageLimit">resets in ${left}</div>`;
      }
      return `<div class="usageRow"><div class="usageName" style="color:${color}">${esc(actor)}</div><div class="usageStats">${stats}${limit}</div></div>`;
    })
    .join('');
}
async function loadUsage() {
  try {
    const data = await api('/api/usage');
    renderUsage(data);
  } catch {}
}

// ---------- activity ----------
function statusClass(status) {
  if (status.includes('A') || status === '??') return 'add';
  if (status.includes('D')) return 'del';
  return 'mod';
}
function setActivityState(text) {
  $('#actState').textContent = text;
}
function startActivityPoll() {
  state.running = true;
  if (activity.timer) return;
  setActivityState('Watching changes every 2s');
  loadChanges();
  activity.timer = setInterval(loadChanges, 2000);
}
function stopActivityPoll() {
  state.running = false;
  if (activity.timer) {
    clearInterval(activity.timer);
    activity.timer = null;
  }
  setActivityState(state.ws ? 'Idle' : 'No workspace selected');
}
async function loadChanges() {
  if (!state.ws) {
    activity.notRepo = false;
    updateRunControls();
    $('#actFiles').innerHTML = '<div class="actEmpty">No workspace selected.</div>';
    $('#actStat').textContent = '';
    $('#diffOut').textContent = 'Select a changed file or refresh the diff.';
    setActivityState('No workspace selected');
    return;
  }
  try {
    const d = await api('/api/changes?ws=' + encodeURIComponent(state.ws));
    renderChanges(d);
    if (!state.running && !d.notRepo) setActivityState('Idle');
  } catch (_e) {
    setActivityState('Unable to load changes');
  }
}
function renderChanges(d) {
  if (d.notRepo) {
    activity.notRepo = true;
    activity.selected = null;
    updateRunControls();
    $('#actFiles').innerHTML = `<div class="actEmpty">${NOT_REPO_MSG}</div>`;
    $('#actStat').textContent = '';
    $('#diffTitle').textContent = 'Diff';
    $('#diffOut').innerHTML = `<span class="meta">${NOT_REPO_MSG}</span>`;
    setActivityState(NOT_REPO_MSG);
    return;
  }
  activity.notRepo = false;
  activity.lastChanges = d;
  activity.changedFiles = d.files || [];
  updateRunControls();
  const files = d.files || [];
  if (!files.length) {
    activity.selected = null;
    $('#actFiles').innerHTML = '<div class="actEmpty">No changed files.</div>';
    $('#actStat').textContent = d.stat || '';
    return;
  }
  $('#actFiles').innerHTML = files
    .map((f, i) => {
      const active = f.path === activity.selected ? ' active' : '';
      return `<button class="actFile${active}" data-i="${i}"><span class="badge ${statusClass(f.status)}">${esc(f.status)}</span><span class="name">${esc(f.path)}</span></button>`;
    })
    .join('');
  $('#actFiles')
    .querySelectorAll('.actFile')
    .forEach(
      (b) =>
        (b.onclick = () => {
          const f = files[Number(b.dataset.i)];
          activity.selected = f.path;
          renderChanges(d);
          loadDiff(activity.selected);
        })
    );
  $('#actStat').textContent = d.stat || '';
}
async function loadDiff(file) {
  if (!state.ws) return;
  if (activity.notRepo) {
    $('#diffTitle').textContent = 'Diff';
    $('#diffOut').innerHTML = `<span class="meta">${NOT_REPO_MSG}</span>`;
    return;
  }
  $('#diffTitle').textContent = file || 'Workspace diff';
  $('#diffOut').innerHTML = '<span class="meta">Loading diff...</span>';
  try {
    const d = await api('/api/diff?ws=' + encodeURIComponent(state.ws));
    renderDiff(d.diff || '', d.notRepo);
  } catch (_e) {
    $('#diffOut').innerHTML = '<span class="del">Unable to load diff.</span>';
  }
}
function renderDiff(diff, notRepo) {
  if (notRepo) {
    $('#diffOut').innerHTML = `<span class="meta">${NOT_REPO_MSG}</span>`;
    return;
  }
  if (!diff) {
    $('#diffOut').innerHTML = '<span class="meta">No unstaged diff.</span>';
    return;
  }
  $('#diffOut').innerHTML = diff
    .split('\n')
    .map((line) => {
      let cls = 'meta';
      if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
      else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
      else if (line.startsWith('@@')) cls = 'hunk';
      return `<span class="${cls}">${esc(line)}</span>`;
    })
    .join('\n');
}
$('#refreshAct').onclick = () => loadChanges();
$('#viewDiff').onclick = () => loadDiff(activity.selected);

// ---------- cross-model review ----------
function populateReviewModels() {
  const composer = $('#provider').value;
  const opts = CAT.map((a) =>
    a.models
      .map((m) => `<option value="${a.id}|${esc(m)}">${esc(a.label)} · ${esc(m)}</option>`)
      .join('')
  ).join('');
  $('#reviewModel').innerHTML = opts;
  const alt = CAT.find((a) => a.id !== composer);
  if (alt) $('#reviewModel').value = `${alt.id}|${alt.defaultModel}`;
}
function showReviewPick(open) {
  $('#reviewPick').classList.toggle('show', open);
  $('#reviewBtn').style.display = open ? 'none' : '';
}
$('#reviewBtn').onclick = () => {
  if (!state.ws) return notify('Add/select a workspace first');
  if (activity.notRepo) return notify(NOT_REPO_MSG);
  populateReviewModels();
  showReviewPick(true);
};
$('#reviewCancel').onclick = () => showReviewPick(false);
async function startReview() {
  if (!state.ws) return notify('Add/select a workspace first');
  if (state.activeRun) return notify('A run is already active in this session.');
  const val = $('#reviewModel').value;
  if (!val) return;
  const [reviewer, reviewerModel] = val.split('|');
  await ensureSession();
  showReviewPick(false);
  setRunActive(true);
  startActivityPoll();
  try {
    const r = await api('/api/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ws: state.ws, sid: state.sid, reviewer, reviewerModel, contextMode }),
    });
    if (r.error) {
      setRunActive(false);
      stopActivityPoll();
      return notify(r.error);
    }
    loadUsage();
  } catch (_e) {
    setRunActive(false);
    stopActivityPoll();
    notify('Unable to start review.');
  }
}
$('#reviewGo').onclick = startReview;

// ---------- folder browser ----------
let fsCur = null,
  fsCurIsRepo = false;
$('#addWs').onclick = () => pickFolder();
async function addWorkspacePath(folderPath, options = {}) {
  const r = await api('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: folderPath }),
  });
  if (r.error) {
    if (options.fallbackToBrowser) openFs();
    notify(r.error);
    return false;
  }
  state.ws = r.id;
  await loadWorkspaces();
  if (options.warnNonRepo && !options.isRepo) {
    notify(
      'Folder added. It is not a git repository, so Edit/review features are limited.',
      'warn'
    );
  }
  return true;
}
async function pickFolder() {
  $('#addWs').disabled = true;
  try {
    const r = await api('/api/fs/pick-folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (r.cancelled) return;
    if (r.error) {
      if (r.fallback) {
        notify('Native folder picker is unavailable here. Using in-app browser.', 'warn');
        return openFs();
      }
      return notify(r.error);
    }
    await addWorkspacePath(r.path, { warnNonRepo: true, isRepo: r.isRepo });
  } catch (_e) {
    notify('Unable to open native folder picker. Using in-app browser.', 'warn');
    openFs();
  } finally {
    $('#addWs').disabled = false;
  }
}
async function openFs(p) {
  const d = await api('/api/fs' + (p ? '?path=' + encodeURIComponent(p) : ''));
  if (d.error) notify(d.error);
  fsCur = d.path;
  fsCurIsRepo = !!d.isRepo;
  $('#fsPath').textContent = d.path;
  $('#fsUp').disabled = !d.parent;
  $('#fsWarn').textContent = d.error
    ? d.error
    : fsCurIsRepo
      ? ''
      : 'This folder is not a git repository — activity, diff, and review need a git repo.';
  $('#fsWarn').classList.toggle('show', !!d.error || !fsCurIsRepo);
  $('#fsDirs').innerHTML =
    d.dirs
      .map((x) => `<div class="d" data-p="${esc(x.path)}"><span>📁 ${esc(x.name)}</span></div>`)
      .join('') || '<div style="padding:10px;color:var(--muted)">(no subfolders)</div>';
  $('#fsDirs')
    .querySelectorAll('.d')
    .forEach((el) => (el.onclick = () => openFs(el.dataset.p)));
  $('#fsModal').classList.add('show');
}
$('#fsUp').onclick = async () => {
  if (!fsCur) return;
  const d = await api('/api/fs?path=' + encodeURIComponent(fsCur));
  if (d.parent) openFs(d.parent);
};
$('#fsCancel').onclick = () => $('#fsModal').classList.remove('show');
$('#fsUse').onclick = async () => {
  if (await addWorkspacePath(fsCur)) $('#fsModal').classList.remove('show');
};

// ---------- teams ----------
async function loadSkills() {
  SKILLS = await api('/api/skills');
  refreshTeamSkillSelects();
  if ($('#skillsModal') && $('#skillsModal').classList.contains('show')) renderSkillEditor();
}

function modelOptions(selected) {
  return CAT.map((a) => {
    const textOnly = a.canEdit ? '' : ' (text only)';
    return a.models
      .map(
        (m) =>
          `<option value="${a.id}|${esc(m)}" ${selected && selected.adapter === a.id && selected.model === m ? 'selected' : ''}>${esc(a.label)} · ${esc(m)}${textOnly}</option>`
      )
      .join('');
  }).join('');
}
function skillOptions(selectedId) {
  return (
    '<option value="">No skill</option>' +
    SKILLS.map(
      (s) =>
        `<option value="${esc(s.id)}" ${selectedId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`
    ).join('')
  );
}
function refreshTeamSkillSelects() {
  const selects = [...document.querySelectorAll('.memberSkill')];
  for (const select of selects) {
    const selected = select.value;
    select.innerHTML = skillOptions(selected);
    select.value = SKILLS.some((skill) => skill.id === selected) ? selected : '';
  }
}
function selectedSkill() {
  return SKILLS.find((skill) => skill.id === $('#skillPick').value) || null;
}
function listField(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}
function fillSkillEditor(skill) {
  $('#skillName').value = (skill && skill.name) || '';
  $('#skillRole').value = (skill && skill.role) || '';
  $('#skillInstructions').value = (skill && skill.instructions) || '';
  $('#skillExpectedOutputs').value = skill ? listField(skill.expectedOutputs) : '';
  $('#skillMode').value = skill && skill.preferredMode === 'edit' ? 'edit' : 'plan';
  $('#skillDelete').disabled = !skill || !skill.custom;
  $('#skillDelete').textContent = skill && skill.builtIn ? 'Reset' : 'Delete';
  $('#skillEditorNote').textContent = skill
    ? skill.custom
      ? 'This is a local skill. It is stored on this machine and used in team prompts.'
      : 'Built-in skill. Saving creates a local override; reset returns to the default.'
    : 'Create a local skill for teams to use in orchestration prompts.';
}
function renderSkillEditor(selectId) {
  const previous = selectId || $('#skillPick').value || (SKILLS[0] && SKILLS[0].id) || '';
  $('#skillPick').innerHTML =
    '<option value="">+ New skill</option>' +
    SKILLS.map((skill) => {
      const marker = skill.custom ? ' · local' : ' · built-in';
      return `<option value="${esc(skill.id)}">${esc(skill.name)}${marker}</option>`;
    }).join('');
  $('#skillPick').value = SKILLS.some((skill) => skill.id === previous) ? previous : '';
  fillSkillEditor(selectedSkill());
}
function openSkillsModal() {
  renderSkillEditor();
  $('#skillsModal').classList.add('show');
  $('#skillPick').focus();
}
function closeSkillsModal() {
  $('#skillsModal').classList.remove('show');
}
async function saveSkillFromEditor() {
  const current = selectedSkill();
  const skill = {
    id: current ? current.id : undefined,
    name: $('#skillName').value.trim(),
    role: $('#skillRole').value.trim(),
    instructions: $('#skillInstructions').value.trim(),
    expectedOutputs: $('#skillExpectedOutputs')
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    preferredMode: $('#skillMode').value,
  };
  if (!skill.name || !skill.role || !skill.instructions) {
    return notify('Skill name, role, and instructions are required.', 'warn');
  }
  const saved = await api('/api/skills', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skill }),
  });
  if (saved.error) return notify(saved.error);
  await loadSkills();
  renderSkillEditor(saved.id);
  notify('Skill saved.', 'info');
}
async function deleteSelectedSkill() {
  const skill = selectedSkill();
  if (!skill || !skill.custom) return;
  const action = skill.builtIn ? 'Reset this skill to the built-in default?' : 'Delete this skill?';
  if (!confirm(action)) return;
  const result = await api('/api/skills?id=' + encodeURIComponent(skill.id), { method: 'DELETE' });
  if (result.error) return notify(result.error);
  await loadSkills();
  renderSkillEditor();
  notify(skill.builtIn ? 'Skill reset.' : 'Skill deleted.', 'info');
}
function updateMemberHint(row) {
  const val = row.querySelector('.memberModel').value;
  const adapter = val ? val.split('|')[0] : '';
  const a = CAT.find((x) => x.id === adapter);
  let hint = row.querySelector('.textOnlyHint');
  if (a && !a.canEdit) {
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'textOnlyHint';
      row.appendChild(hint);
    }
    hint.textContent = 'This provider cannot edit files — steps run as analysis only.';
  } else if (hint) hint.remove();
}
function addMemberRow(member, idx) {
  const sel = member ? `${member.adapter}|${member.model}` : '';
  const row = document.createElement('div');
  row.className = 'teamRow';
  row.innerHTML = `<select class="memberModel">${modelOptions(member)}</select>
    <input class="memberRole" placeholder="Role (e.g. reviewer)" value="${esc((member && member.role) || '')}" />
    <select class="memberSkill">${skillOptions(member && member.skillId)}</select>
    <label class="leadOnly" title="Team lead"><input type="radio" name="teamLead" value="${idx}" ${idx === editingTeam.leadIndex ? 'checked' : ''} aria-label="Team lead" /></label>
    <button class="btn ghost rm" type="button" aria-label="Remove member">✕</button>`;
  if (sel) row.querySelector('.memberModel').value = sel;
  row.querySelector('.memberModel').onchange = () => updateMemberHint(row);
  updateMemberHint(row);
  row.querySelector('.rm').onclick = () => {
    row.remove();
    reindexLeadRadios();
  };
  $('#teamMembers').appendChild(row);
}
function reindexLeadRadios() {
  const rows = [...$('#teamMembers').querySelectorAll('.teamRow')];
  const checked = [...$('#teamMembers').querySelectorAll('input[name=teamLead]')].findIndex(
    (r) => r.checked
  );
  rows.forEach((row, i) => {
    const radio = row.querySelector('input[name=teamLead]');
    radio.value = i;
    if (checked === i) radio.checked = true;
  });
  if (
    rows.length &&
    !rows.some((r) => r.querySelector('input[name=teamLead]').checked) &&
    rows[0]
  ) {
    rows[0].querySelector('input[name=teamLead]').checked = true;
  }
}
function openTeamModal(team) {
  editingTeam = team
    ? { ...team, members: (team.members || []).map((m) => ({ ...m })) }
    : { id: null, name: '', members: [], leadIndex: 0 };
  $('#teamModalTitle').textContent = team ? 'Edit team' : 'New team';
  $('#teamName').value = editingTeam.name || '';
  $('#teamDelete').style.display = team ? 'inline-block' : 'none';
  $('#teamMembers').innerHTML = '';
  if (editingTeam.members.length) editingTeam.members.forEach((m, i) => addMemberRow(m, i));
  else addMemberRow(null, 0);
  $('#teamModal').classList.add('show');
  $('#teamName').focus();
}
function collectTeamFromModal() {
  const rows = [...$('#teamMembers').querySelectorAll('.teamRow')];
  const members = rows
    .map((row) => {
      const [adapter, model] = (row.querySelector('.memberModel').value || '').split('|');
      return {
        adapter,
        model,
        role: row.querySelector('.memberRole').value.trim(),
        skillId: row.querySelector('.memberSkill').value || undefined,
      };
    })
    .filter((m) => m.adapter);
  let leadIndex = [...$('#teamMembers').querySelectorAll('input[name=teamLead]')].findIndex(
    (r) => r.checked
  );
  if (leadIndex < 0 && members.length) leadIndex = 0;
  return {
    id: editingTeam.id,
    name: $('#teamName').value.trim() || 'Untitled team',
    members,
    leadIndex,
  };
}
async function loadTeams() {
  TEAMS = await api('/api/teams');
  const active = localStorage.getItem(ACTIVE_TEAM_KEY);
  const valid = TEAMS.some((t) => t.id === active);
  $('#teamPick').innerHTML =
    '<option value="">— none —</option>' +
    TEAMS.map(
      (t) => `<option value="${t.id}">${esc(t.name)} (${(t.members || []).length} seats)</option>`
    ).join('');
  if (valid) $('#teamPick').value = active;
  else if (TEAMS.length) {
    $('#teamPick').value = TEAMS[0].id;
    localStorage.setItem(ACTIVE_TEAM_KEY, TEAMS[0].id);
  }
  updateDelegateButton();
}
function setActiveTeam(id) {
  if (id) localStorage.setItem(ACTIVE_TEAM_KEY, id);
  else localStorage.removeItem(ACTIVE_TEAM_KEY);
  updateDelegateButton();
}
function activeTeam() {
  const id = $('#teamPick').value;
  return TEAMS.find((t) => t.id === id) || null;
}
function updateDelegateButton() {
  const on = !!activeTeam();
  $('#delegate').style.display = on ? 'inline-block' : 'none';
  $('#delegate').disabled = state.activeRun;
  if (!on) hidePlan();
}
function memberName(team, memberIndex) {
  const m = team && team.members && team.members[memberIndex];
  if (!m) return `member ${memberIndex}`;
  return `${m.adapter}${m.role ? ' · ' + m.role : ''}`;
}
function showPlan(steps) {
  const team = activeTeam();
  planDraft = { teamId: team.id, steps };
  $('#planBox').innerHTML =
    `<div class="planTitle">Review team delegation</div>` +
    steps
      .map(
        (s, i) => `<div class="planStep" data-i="${i}" data-member="${s.memberIndex}">
      <div class="planWho">${esc(memberName(team, s.memberIndex))}</div>
      <textarea class="planTask">${esc(s.task)}</textarea>
    </div>`
      )
      .join('') +
    `<div class="planActions"><button class="btn ghost" id="planCancel">Cancel</button><button class="btn primary" id="planApprove">Approve</button></div>`;
  $('#planBox').classList.add('show');
  $('#planCancel').onclick = hidePlan;
  $('#planApprove').onclick = approvePlan;
}
function hidePlan() {
  planDraft = null;
  $('#planBox').classList.remove('show');
  $('#planBox').innerHTML = '';
}
async function delegateToTeam() {
  if (!state.ws) return notify('Add/select a workspace first');
  if (state.activeRun) return notify('A run is already active in this session.');
  const team = activeTeam();
  if (!team) return notify('Select a team first');
  const prompt = $('#prompt').value.trim();
  if (!prompt) return;
  await ensureSession();
  $('#delegate').disabled = true;
  setRunActive(true);
  try {
    const r = await api('/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ws: state.ws, sid: state.sid, teamId: team.id, prompt, contextMode }),
    });
    if (r.cancelled) {
      setRunActive(false);
      return;
    }
    if (r.error) {
      setRunActive(false);
      return notify(r.error);
    }
    $('#prompt').value = '';
    showPlan(r.steps || []);
    setRunActive(false);
  } catch (_e) {
    setRunActive(false);
    notify('Unable to create team plan.');
  } finally {
    $('#delegate').disabled = state.activeRun;
  }
}
async function approvePlan() {
  if (!planDraft) return;
  if (state.activeRun) return notify('A run is already active in this session.');
  const rows = [...$('#planBox').querySelectorAll('.planStep')];
  const steps = rows.map((row) => ({
    memberIndex: Number(row.dataset.member),
    task: row.querySelector('.planTask').value.trim(),
  }));
  if (steps.some((s) => !s.task)) return notify('Every step needs a task.');
  $('#planApprove').disabled = true;
  setRunActive(true);
  try {
    const r = await api('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ws: state.ws,
        sid: state.sid,
        teamId: planDraft.teamId,
        steps,
        contextMode,
      }),
    });
    if (r.error) {
      $('#planApprove').disabled = false;
      setRunActive(false);
      return notify(r.error);
    }
    hidePlan();
    startActivityPoll();
    loadUsage();
  } catch (e) {
    $('#planApprove').disabled = false;
    setRunActive(false);
    if (!e.sessionExpired) notify('Unable to approve team plan.');
  }
}
$('#delegate').onclick = delegateToTeam;
$('#teamPick').onchange = () => setActiveTeam($('#teamPick').value);
$('#newTeam').onclick = () => openTeamModal(null);
$('#editTeam').onclick = () => {
  const id = $('#teamPick').value;
  const t = TEAMS.find((x) => x.id === id);
  if (t) openTeamModal(t);
  else openTeamModal(null);
};
$('#addMember').onclick = () => {
  addMemberRow(null, $('#teamMembers').querySelectorAll('.teamRow').length);
  reindexLeadRadios();
};
$('#editSkills').onclick = openSkillsModal;
$('#skillPick').onchange = () => fillSkillEditor(selectedSkill());
$('#skillNew').onclick = () => {
  $('#skillPick').value = '';
  fillSkillEditor(null);
  $('#skillName').focus();
};
$('#skillSave').onclick = saveSkillFromEditor;
$('#skillDelete').onclick = deleteSelectedSkill;
$('#skillsCancel').onclick = closeSkillsModal;
$('#teamCancel').onclick = () => $('#teamModal').classList.remove('show');
$('#teamSave').onclick = async () => {
  const team = collectTeamFromModal();
  if (!team.members.length) return notify('Add at least one member with a model.');
  const saved = await api('/api/teams', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ team }),
  });
  if (saved.error) return notify(saved.error);
  $('#teamModal').classList.remove('show');
  setActiveTeam(saved.id);
  await loadTeams();
};
$('#teamDelete').onclick = async () => {
  if (!editingTeam || !editingTeam.id) return;
  if (!confirm('Delete this team?')) return;
  await api('/api/teams?id=' + encodeURIComponent(editingTeam.id), { method: 'DELETE' });
  if (localStorage.getItem(ACTIVE_TEAM_KEY) === editingTeam.id)
    localStorage.removeItem(ACTIVE_TEAM_KEY);
  $('#teamModal').classList.remove('show');
  await loadTeams();
};
