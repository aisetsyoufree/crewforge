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
  editingTeam = null;
let planDraft = null;
let rateLimitActors = new Set();
const RATE_LIMIT_RE = /rate.?limit|quota|usage limit|429|insufficient|exhaust/i;
const ACTIVE_TEAM_KEY = 'crewforge.activeTeam';
const ONBOARD_KEY = 'crewforge.onboarded';
const SESSION_SORT_KEY = 'crewforge.sessionSort';
const LEFT_WIDTH_KEY = 'crewforge.leftWidth';
const RIGHT_WIDTH_KEY = 'crewforge.rightWidth';
const LEFT_WIDTH_MIN = 200;
const LEFT_WIDTH_MAX = 520;
const RIGHT_WIDTH_MIN = 260;
const RIGHT_WIDTH_MAX = 680;
let sessionSort = localStorage.getItem(SESSION_SORT_KEY) || 'newest';
if (sessionSort !== 'newest' && sessionSort !== 'oldest') sessionSort = 'newest';
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
  setTimeout(() => toast.remove(), 7000);
}

async function api(p, opt) {
  const r = await fetch(p, opt);
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
  try {
    rows = await api('/api/keys');
  } catch {}
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

// ---------- bootstrap ----------
(async () => {
  CAT = await api('/api/catalog');
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
  populateComposerModels();
  updateCaps();
  populateReviewModels();
  await loadWorkspaces();
  await loadTeams();
  loadUsage();
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
      body: JSON.stringify({ ws: state.ws, sid: state.sid, reviewer, reviewerModel }),
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
$('#addWs').onclick = () => openFs();
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
  const r = await api('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: fsCur }),
  });
  if (r.error) return notify(r.error);
  $('#fsModal').classList.remove('show');
  state.ws = r.id;
  await loadWorkspaces();
};

// ---------- teams ----------
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
    <label class="leadLbl"><input type="radio" name="teamLead" value="${idx}" ${idx === editingTeam.leadIndex ? 'checked' : ''} /> Lead</label>
    <button class="btn ghost rm" type="button">✕</button>`;
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
      return { adapter, model, role: row.querySelector('.memberRole').value.trim() };
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
      body: JSON.stringify({ ws: state.ws, sid: state.sid, teamId: team.id, prompt }),
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
      body: JSON.stringify({ ws: state.ws, sid: state.sid, teamId: planDraft.teamId, steps }),
    });
    if (r.error) {
      $('#planApprove').disabled = false;
      setRunActive(false);
      return notify(r.error);
    }
    hidePlan();
    startActivityPoll();
    loadUsage();
  } catch (_e) {
    $('#planApprove').disabled = false;
    setRunActive(false);
    notify('Unable to approve team plan.');
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
