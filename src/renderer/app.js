'use strict';
/* global relay */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const BROADCAST = 'all';

let snap = null;
let current = BROADCAST;      // channel id being viewed
let pending = [];             // files queued for sending
const imgCache = new Map();

// ---------- helpers ----------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function channelFor(a, b) { if (a === BROADCAST || b === BROADCAST) return BROADCAST; return [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())).join('+'); }
function op() { return snap.settings.operatorName; }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function fmtDay(ts) { return new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
function ago(ts) { if (!ts) return 'never'; const s = (Date.now() - ts) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; }
function kb(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB'; }
const AVATAR_COLORS = ['#6d5efc', '#0ea5e9', '#16a34a', '#f97316', '#db2777', '#0d9488', '#ca8a04', '#9333ea', '#dc2626', '#2563eb'];
function colorFor(name) { let h = 2166136261; for (const c of String(name)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return AVATAR_COLORS[(h >>> 0) % AVATAR_COLORS.length]; }
const STATUS_LABEL = { open: 'Open', claimed: 'Claimed', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
function statusPill(st) { return `<span class="status ${esc(st)}">${esc(STATUS_LABEL[st] || st)}</span>`; }
function initials(n) { return String(n).replace(/[^A-Za-z0-9]/g, ' ').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?'; }
function toast(msg, ms = 2500) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms); }
function lastRead(ch) { try { return Number(localStorage.getItem('read:' + ch) || 0); } catch { return 0; } }
function setLastRead(ch, seq) { try { localStorage.setItem('read:' + ch, String(seq)); } catch { /* ignore */ } }

function md(text) {
  // Minimal, safe markdown: code fences, inline code, bold, italics, links, line breaks.
  const parts = String(text || '').split(/```/);
  return parts.map((p, i) => {
    if (i % 2) { const nl = p.indexOf('\n'); const body = nl >= 0 && /^[\w+-]*$/.test(p.slice(0, nl)) ? p.slice(nl + 1) : p; return `<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`; }
    let h = esc(p.replace(/^\n+|\n+$/g, ''));
    if (!h) return '';
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank">$2</a>');
    return h.split(/\n{2,}/).map(par => `<p>${par.replace(/\n/g, '<br>')}</p>`).join('');
  }).join('');
}

// ---------- theme ----------
function applyThemeAttr(theme) {
  const t = ['light', 'dark'].includes(theme) ? theme : 'system';
  document.documentElement.dataset.theme = t;
  $$('[data-theme-set]').forEach(b => { b.classList.toggle('active', b.dataset.themeSet === t); b.setAttribute('aria-checked', String(b.dataset.themeSet === t)); });
  const sel = $('#theme-select'); if (sel) sel.value = t;
  try { localStorage.setItem('theme', t); } catch { /* ignore */ }
}
async function setTheme(t) { applyThemeAttr(t); const saved = await relay.setTheme(t); if (snap) snap.settings.theme = saved; }
try { applyThemeAttr(localStorage.getItem('theme') || 'system'); } catch { applyThemeAttr('system'); } // avoid a flash before the snapshot loads
$$('[data-theme-set]').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.themeSet)));
$('#theme-select').addEventListener('change', e => setTheme(e.target.value));

// ---------- navigation ----------
function showView(v) {
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  if (v === 'jobs') renderJobs();
  if (v === 'connect') relay.snapshot().then(f => { snap = f; renderConnect(); });
  if (v === 'settings') relay.snapshot().then(f => { snap = f; renderSettings(); });
}
$$('#nav button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- sidebar ----------
function channelSummary(ch) { return (snap.channels || []).find(c => c.channel === ch); }

function convItem(ch, title, sub, online, avatarColor, avatarText) {
  const sum = channelSummary(ch);
  const unread = sum && sum.lastSeq > lastRead(ch) && sum.lastFrom !== op() && ch !== current ? '<span class="badge">new</span>' : '';
  return `<div class="conv ${ch === current ? 'active' : ''}" data-ch="${esc(ch)}">
    <div class="avatar" style="background:${avatarColor}">${esc(avatarText)}${online == null ? '' : `<span class="dot ${online ? 'on' : ''}"></span>`}</div>
    <div class="meta"><div class="name">${esc(title)}</div><div class="preview">${esc(sum ? `${sum.lastFrom}: ${sum.lastText}` : sub)}</div></div>${unread}</div>`;
}

function renderSidebar() {
  const agents = snap.agents.filter(a => a.name !== op());
  let html = convItem(BROADCAST, 'Broadcast (everyone)', 'Messages to all agents', null, 'linear-gradient(135deg,#7c6cff,#5b8cff)', '#');
  for (const a of agents) html += convItem(channelFor(op(), a.name), a.name, a.online ? 'online' : 'last seen ' + ago(a.lastSeen), a.online, colorFor(a.name), initials(a.name));
  $('#conversations').innerHTML = html;
  const others = (snap.channels || []).filter(c => c.channel !== BROADCAST && !c.channel.split('+').includes(op()));
  $('#agent-channels').innerHTML = others.length ? others.map(c => convItem(c.channel, c.channel.replace('+', ' ↔ '), '', null, '#394150', '⇄')).join('') : '<div class="muted small-text" style="padding:0 18px">Agent-to-agent chats appear here.</div>';
  $$('.conv').forEach(el => el.addEventListener('click', () => openChannel(el.dataset.ch)));
  const active = snap.jobs.filter(j => !['done', 'failed', 'cancelled'].includes(j.status)).length;
  $('#jobs-badge').textContent = active; $('#jobs-badge').classList.toggle('hidden', !active);
}

function renderServerStatus() {
  const c = snap.connection;
  const online = snap.agents.filter(a => a.online && a.name !== op()).length;
  $('#server-dot').className = 'dot ' + (c.status.running ? 'on' : 'err');
  $('#server-status').textContent = c.status.running ? `MCP on :${c.port} · ${online} agent${online === 1 ? '' : 's'} online` : (c.status.error || 'server stopped');
  $('#version').textContent = `v${snap.version}`;
  $('#update-badge').classList.toggle('hidden', !(snap.updater && snap.updater.status === 'ready'));
}

// ---------- chat ----------
function recipientFor(ch) {
  if (ch === BROADCAST) return BROADCAST;
  const parts = ch.split('+');
  if (!parts.includes(op())) return null;
  return parts.find(p => p !== op()) || null;
}

async function openChannel(ch) {
  current = ch;
  showView('chat');
  const to = recipientFor(ch);
  const agent = snap.agents.find(a => a.name === to);
  $('#chat-title').textContent = ch === BROADCAST ? 'Broadcast (everyone)' : to ? to : ch.replace('+', ' ↔ ');
  const onlineCount = snap.agents.filter(x => x.online && !x.human).length;
  $('#chat-sub').innerHTML = ch === BROADCAST ? `Every agent receives these messages · ${onlineCount} online`
    : agent ? `<span class="dot ${agent.online ? 'on' : ''}"></span> ${agent.online ? 'online' : 'offline'} · last seen ${ago(agent.lastSeen)}${agent.description ? ' · ' + esc(agent.description) : ''}`
      : 'Read-only view of a conversation between two agents';
  $('#composer').classList.toggle('hidden', !to);
  $('#input').placeholder = to === BROADCAST ? 'Message every agent…' : `Message ${to}…`;
  $('#input').title = 'Enter to send · Shift+Enter for a new line · paste or drop images and files';
  const msgs = await relay.channel(ch, { limit: PAGE });
  if (ch !== current) return; // user switched while loading
  renderMessages(msgs);
  const sum = channelSummary(ch);
  if (sum) setLastRead(ch, sum.lastSeq);
  relay.markRead();
  renderSidebar();
  $('#input').focus();
}

const PAGE = 200;
function messageHtml(m) {
  const mine = m.from === op();
  const atts = (m.attachments || []).map(a => /^image\//.test(a.mime)
    ? `<img data-att="${esc(a.id)}" alt="${esc(a.name)}" title="${esc(a.name)}">`
    : `<span class="file-chip" data-open="${esc(a.id)}">📄 ${esc(a.name)} <span class="muted">${kb(a.size)}</span></span>`).join('');
  return `<div class="msg ${mine ? 'mine' : ''} ${m.kind === 'job' ? 'job' : ''}" data-seq="${m.seq}">
    <div class="who"><b>${esc(m.from)}</b> → ${esc(m.to)} · ${fmtTime(m.ts)}</div>
    <div class="bubble">${md(m.text)}${atts ? `<div class="atts">${atts}</div>` : ''}${m.jobId ? `<button class="job-link" data-jobopen="${esc(m.jobId)}">Open job →</button>` : ''}</div></div>`;
}

let lastDay = null;
let currentMsgs = [];
function renderMessages(msgs, hasMore, keepScroll) {
  const box = $('#messages');
  lastDay = null;
  currentMsgs = msgs;
  if (!msgs.length) {
    box.innerHTML = recipientFor(current) ? '<div class="empty">No messages yet.<br>Say hello 👋</div>' : '<div class="empty">No messages in this conversation.</div>';
    return;
  }
  if (hasMore === undefined) hasMore = msgs.length >= PAGE;
  box.innerHTML = (hasMore ? '<button class="ghost small load-older">Load older messages</button>' : '')
    + msgs.map(m => daySep(m) + messageHtml(m)).join('');
  hydrate(box);
  if (keepScroll) box.scrollTop = box.scrollHeight - keepScroll; else box.scrollTop = box.scrollHeight;
}
async function loadOlder(btn) {
  btn.disabled = true;
  const ch = current;
  const older = await relay.channel(ch, { limit: PAGE, beforeSeq: currentMsgs[0].seq });
  if (ch !== current) return;
  const box = $('#messages');
  renderMessages(older.concat(currentMsgs), older.length >= PAGE, box.scrollHeight - box.scrollTop);
}
function daySep(m) { const d = new Date(m.ts).toDateString(); if (d === lastDay) return ''; lastDay = d; return `<div class="day-sep">${fmtDay(m.ts)}</div>`; }

function appendMessage(m) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  const empty = box.querySelector('.empty'); if (empty) empty.remove();
  currentMsgs.push(m);
  box.insertAdjacentHTML('beforeend', daySep(m) + messageHtml(m));
  hydrate(box);
  if (nearBottom || m.from === op()) box.scrollTop = box.scrollHeight;
}

function hydrate(root) {
  root.querySelectorAll('img[data-att]:not([src])').forEach(async img => {
    const id = img.dataset.att;
    if (!imgCache.has(id)) imgCache.set(id, await relay.attachmentData(id));
    const src = imgCache.get(id);
    if (src) img.src = src; else img.replaceWith(Object.assign(document.createElement('span'), { className: 'file-chip', textContent: '🖼 ' + img.alt + ' (unavailable)' }));
    img.onload = () => { const b = $('#messages'); if (b.scrollHeight - b.scrollTop - b.clientHeight < 400) b.scrollTop = b.scrollHeight; };
    img.onclick = () => { $('#lightbox-img').src = img.src; $('#lightbox').classList.remove('hidden'); };
  });
  root.querySelectorAll('[data-open]').forEach(el => { el.onclick = () => relay.openAttachment(el.dataset.open); });
  root.querySelectorAll('[data-jobopen]').forEach(el => { el.onclick = () => { showView('jobs'); openJob(el.dataset.jobopen); }; });
  root.querySelectorAll('.load-older').forEach(el => { el.onclick = () => loadOlder(el); });
}
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#modal').classList.contains('hidden')) { const c = $('#m-cancel'); if (c) c.click(); return; }
  if (!$('#lightbox').classList.contains('hidden')) { $('#lightbox').classList.add('hidden'); return; }
  if (!$('#job-detail').classList.contains('hidden')) { $('#job-detail').classList.add('hidden'); openJobId = null; renderJobs(); }
});

// composer
const input = $('#input');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(200, input.scrollHeight) + 'px'; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); } });
$('#btn-send').addEventListener('click', sendCurrent);
$('#as-job').addEventListener('change', e => $('#job-fields').classList.toggle('hidden', !e.target.checked));
$('#btn-attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
input.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); addFiles(files.map((f, i) => f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.${(f.type.split('/')[1] || 'png')}`, { type: f.type }))); }
});
const chatView = $('#view-chat');
chatView.addEventListener('dragover', e => { e.preventDefault(); $('#drop-hint').classList.remove('hidden'); });
chatView.addEventListener('dragleave', e => { if (!chatView.contains(e.relatedTarget)) $('#drop-hint').classList.add('hidden'); });
chatView.addEventListener('drop', e => { e.preventDefault(); $('#drop-hint').classList.add('hidden'); addFiles([...e.dataTransfer.files]); });

function addFiles(files) {
  for (const f of files) {
    if (f.size > 50 * 1024 * 1024) { toast(`${f.name} is larger than 50 MB`); continue; }
    const r = new FileReader();
    r.onload = () => { pending.push({ name: f.name, mime: f.type || 'application/octet-stream', data: String(r.result).split(',')[1], preview: /^image\//.test(f.type) ? r.result : null, size: f.size }); renderPending(); };
    r.readAsDataURL(f);
  }
}
function renderPending() {
  $('#pending-files').innerHTML = pending.map((p, i) => `<div class="pending">${p.preview ? `<img src="${p.preview}">` : '📄'} ${esc(p.name)} <span class="muted">${kb(p.size)}</span><button data-rm="${i}">✕</button></div>`).join('');
  $$('#pending-files [data-rm]').forEach(b => b.onclick = () => { pending.splice(Number(b.dataset.rm), 1); renderPending(); });
}

async function sendCurrent() {
  const to = recipientFor(current);
  const text = input.value.trim();
  if (!to || (!text && !pending.length)) return;
  const asJob = $('#as-job').checked;
  if (asJob && !text) { toast('Describe the job in the message box'); return; }
  $('#btn-send').disabled = true;
  try {
    await relay.send({ to, text, files: pending.map(({ name, mime, data }) => ({ name, mime, data })), asJob, title: $('#job-title').value.trim(), priority: $('#job-priority').value });
    input.value = ''; pending = []; renderPending(); autosize();
    if (asJob) { $('#as-job').checked = false; $('#job-fields').classList.add('hidden'); $('#job-title').value = ''; toast('Job created'); }
  } catch (e) { toast('Send failed: ' + e.message, 5000); }
  $('#btn-send').disabled = false;
  input.focus();
}

// ---------- jobs ----------
const COLUMNS = [
  { key: 'open', title: 'Open', match: s => s === 'open' },
  { key: 'progress', title: 'In progress', match: s => ['claimed', 'in_progress'].includes(s) },
  { key: 'blocked', title: 'Blocked', match: s => s === 'blocked' },
  { key: 'finished', title: 'Finished', match: s => ['done', 'failed', 'cancelled'].includes(s) }
];
$('#job-filter').addEventListener('change', renderJobs);
function renderJobs() {
  const f = $('#job-filter').value;
  let jobs = snap.jobs;
  if (f === 'active') jobs = jobs.filter(j => !['done', 'failed', 'cancelled'].includes(j.status));
  if (f === 'done') jobs = jobs.filter(j => j.status === 'done');
  if (f === 'failed') jobs = jobs.filter(j => ['failed', 'cancelled'].includes(j.status));
  $('#jobs-board').innerHTML = COLUMNS.map(c => {
    const list = jobs.filter(j => c.match(j.status));
    return `<div class="column"><h3>${c.title}<span class="muted">${list.length}</span></h3><div class="cards">${list.map(j => `
      <div class="job-card" data-job="${esc(j.id)}">
        <div class="t">${esc(j.title)}${j.priority !== 'normal' ? `<span class="prio ${esc(j.priority)}">${esc(j.priority)}</span>` : ''}</div>
        <div class="m">${esc(j.from)} → ${esc(j.claimedBy || j.to)}</div>
        <div class="m meta-row">${statusPill(j.status)}<span>updated ${ago(j.updated)}</span></div>
      </div>`).join('') || '<div class="muted small-text">Nothing here</div>'}</div></div>`;
  }).join('');
  $$('.job-card').forEach(el => el.addEventListener('click', () => openJob(el.dataset.job)));
  if (openJobId) openJob(openJobId);
}
let openJobId = null;
function openJob(id) {
  const j = snap.jobs.find(x => x.id === id);
  const d = $('#job-detail');
  if (!j) { d.classList.add('hidden'); openJobId = null; return; }
  openJobId = id;
  $$('.job-card').forEach(c => c.classList.toggle('selected', c.dataset.job === id));
  d.innerHTML = `<button class="ghost small close" id="jd-close" aria-label="Close">✕</button>
    <h2>${esc(j.title)}</h2>
    <div class="muted">${esc(j.id)} · ${esc(j.from)} → ${esc(j.to)}${j.claimedBy ? ` (claimed by ${esc(j.claimedBy)})` : ''}</div>
    <div class="meta-row" style="margin-top:6px">${statusPill(j.status)}<span class="prio ${esc(j.priority)}">${esc(j.priority)}</span><span class="muted small-text">created ${new Date(j.created).toLocaleString()}</span></div>
    <h3>Description</h3><div class="desc">${esc(j.description)}</div>
    ${j.attachments.length ? `<h3>Attachments</h3><div class="atts">${j.attachments.map(a => /^image\//.test(a.mime) ? `<img data-att="${esc(a.id)}" alt="${esc(a.name)}">` : `<span class="file-chip" data-open="${esc(a.id)}">📄 ${esc(a.name)}</span>`).join('')}</div>` : ''}
    ${j.result ? `<h3>Result</h3><div class="desc">${esc(j.result)}</div>` : ''}
    <h3>Update</h3>
    <input id="jd-note" placeholder="Add a note for the agent (optional)" style="width:100%">
    <div class="actions">
      ${[['open', 'Reopen'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Mark done ✓'], ['cancelled', 'Cancel job']].map(([st, label]) => `<button class="${st === 'done' ? 'primary' : 'ghost'} small" data-st="${st}" ${j.status === st ? 'disabled' : ''}>${label}</button>`).join('')}
      <span style="flex:1"></span>
      <button class="danger small" id="jd-del">Delete</button>
    </div>
    <h3>Activity</h3><div class="log">${j.log.slice().reverse().map(l => `<div>${new Date(l.ts).toLocaleString()} — <b>${esc(l.by)}</b>: ${l.status ? `[${esc(l.status)}] ` : ''}${esc(l.note || '')}</div>`).join('')}</div>`;
  d.classList.remove('hidden');
  hydrate(d);
  $('#jd-close').onclick = () => { d.classList.add('hidden'); openJobId = null; };
  $$('#job-detail [data-st]').forEach(b => b.onclick = async () => { await relay.updateJob(j.id, { status: b.dataset.st, note: $('#jd-note').value.trim() || undefined }); toast('Job updated'); });
  $('#jd-del').onclick = async () => { if (confirm('Delete this job ticket?')) { await relay.deleteJob(j.id); d.classList.add('hidden'); openJobId = null; } };
}

// ---------- connect ----------
function renderConnect() {
  $('#nokey-banner').classList.toggle('hidden', !!snap.connection.key);
  $('#notls-banner').classList.toggle('hidden', !!snap.connection.tls || !snap.connection.status.running);
  $('#conn-tls').innerHTML = snap.connection.tls
    ? `🔒 HTTPS — certificate fingerprint <code class="small-text" style="overflow-wrap:anywhere">${esc(snap.connection.caHash)}</code>`
    : '🔓 <span style="color:var(--warn)">Off — plain HTTP</span>';
  const c = snap.connection;
  $('#conn-status').innerHTML = c.status.running ? `<span class="dot on"></span> Running on port <b>${c.port}</b> · ${c.sessions} active MCP session(s) · host <b>${esc(c.hostname)}</b>` : `<span class="dot err"></span> ${esc(c.status.error || 'Stopped')}`;
  $('#conn-addresses').innerHTML = c.addresses.map(a => `${esc(a.address)} <span class="muted">(${esc(a.iface)})</span>`).join('<br>') || 'No network interfaces found';
  $('#conn-key').textContent = c.key || '(disabled)';
  const sel = $('#conn-ip'); const prev = sel.value;
  sel.innerHTML = [...c.addresses.map(a => a.address), c.hostname].map(a => `<option ${a === prev ? 'selected' : ''}>${esc(a)}</option>`).join('');
  updateSnippet();
  const agents = snap.agents.filter(a => !a.human);
  $('#conn-agents').innerHTML = agents.length ? agents.map(a => `<div class="agent-row"><span class="dot ${a.online ? 'on' : ''}"></span><b>${esc(a.name)}</b><span class="muted">${a.online ? 'online' : 'offline'} · last seen ${ago(a.lastSeen)}${a.description ? ' · ' + esc(a.description) : ''}</span></div>`).join('') : '<div class="muted">No agents have connected yet.</div>';
}
function mcpUrl() {
  const c = snap.connection;
  const name = ($('#conn-agent').value || 'DevPC-1').replace(/[^A-Za-z0-9_.-]/g, '');
  return `${c.protocol || 'http'}://${$('#conn-ip').value || 'localhost'}:${c.port}/mcp/${name}${c.key ? `?key=${c.key}` : ''}`;
}
function updateSnippet() {
  const url = mcpUrl();
  const c = snap.connection;
  const CA_PATH = 'C:\\AgentRelay\\relay-ca.pem';
  const server = c.tls
    ? { command: 'npx', args: ['-y', 'mcp-remote@latest', url, '--transport', 'http-only'], env: { NODE_EXTRA_CA_CERTS: CA_PATH } }
    : { command: 'npx', args: ['-y', 'mcp-remote@latest', url, '--allow-http', '--transport', 'http-only'] };
  $('#conn-snippet').textContent = JSON.stringify({ mcpServers: { 'agent-relay': server } }, null, 2);
  $('#trust-step').classList.toggle('hidden', !c.tls);
  $('#cfg-step-title').textContent = c.tls ? '3. Add the relay to Claude Desktop' : '2. Add the relay to Claude Desktop';
  if (c.tls) {
    const host = $('#conn-ip').value || 'localhost';
    $('#conn-fp').textContent = c.caHash;
    $('#conn-trust').textContent = `New-Item -ItemType Directory -Force C:\\AgentRelay | Out-Null; curl.exe -sk https://${host}:${c.port}/ca.pem -o ${CA_PATH}; (Get-FileHash ${CA_PATH}).Hash`;
  }
  $('#conn-cc').textContent = c.tls
    ? `setx NODE_EXTRA_CA_CERTS ${CA_PATH}\n# open a NEW terminal, then:\nclaude mcp add --transport http --scope user agent-relay "${url}"`
    : `claude mcp add --transport http --scope user agent-relay "${url}"`;
  const name = ($('#conn-agent').value || 'DevPC-1');
  $('#conn-instructions').textContent = `You are "${name}", one of several Claude agents that coordinate through the "agent-relay" MCP server.\n` +
    `- At the start of every conversation, call whoami and check_messages.\n` +
    `- When you need another computer/agent to do work, use create_job with a complete, self-contained description and any files attached.\n` +
    `- When you receive a job: update_job(status="claimed"), do the work, then update_job(status="done", result="...") with deliverables attached.\n` +
    `- When idle and asked to stand by, loop on wait_for_messages.\n` +
    `- Store durable shared knowledge with write_note.`;
}
$('#conn-agent').addEventListener('input', updateSnippet);
$('#conn-ip').addEventListener('change', updateSnippet);
$('#btn-copy-snippet').onclick = () => { relay.copy($('#conn-snippet').textContent); toast('Config copied'); };
$('#btn-copy-trust').onclick = () => { relay.copy($('#conn-trust').textContent); toast('Command copied — run it in PowerShell on the dev PC'); };
$('#btn-save-ca').onclick = async () => { if (await relay.saveCa()) toast('Certificate saved — copy it to C:\\AgentRelay\\relay-ca.pem on each dev PC', 5000); };
$('#btn-enable-tls').onclick = async () => {
  if (!confirm('Turn on encryption? The server restarts, and each dev PC must trust the certificate and use the new config shown on this page.')) return;
  snap = await relay.saveSettings({ tls: true });
  renderConnect(); toast('Encryption is on — update each PC with the steps below', 5000);
};
$('#btn-copy-cc').onclick = () => { relay.copy($('#conn-cc').textContent); toast('Command copied'); };
$('#btn-copy-instr').onclick = () => { relay.copy($('#conn-instructions').textContent); toast('Instructions copied'); };
$('#btn-copy-key').onclick = () => { relay.copy(snap.connection.key); toast('Key copied'); };
$('#btn-regen-key').onclick = async () => { if (!confirm('Regenerate the access key? Every connected PC will need the new config.')) return; snap = await relay.regenKey(); renderConnect(); toast('New key generated'); };
$('#btn-firewall').onclick = async () => { await relay.firewall(); toast('Approve the Windows admin prompt to add the firewall rule', 5000); };

// ---------- settings ----------
function renderSettings() {
  const s = snap.settings;
  $$('[data-setting]').forEach(el => { const v = s[el.dataset.setting]; if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; });
  renderUpdate(snap.updater);
  renderBackup();
  const m = snap.memory, st = snap.stats;
  $('#mem-status').textContent = `System RAM ${m.systemUsedPercent}% used (${m.systemFreeMB} MB free of ${m.systemTotalMB} MB) · App ${m.processRssMB} MB · ${st.messages} messages in ${st.chatFiles} chat file(s), ${kb(st.chatBytes)} · ${st.jobs} job(s)`;
  $('#retention-log').innerHTML = (snap.retentionHistory || []).slice(0, 8).map(e => `<div>${new Date(e.ts).toLocaleString()} [${esc(e.kind)}] ${esc(e.detail)}</div>`).join('');
}
// ---------- modal dialogs ----------
function openModal(html) { $('#modal-box').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-box').innerHTML = ''; }

/** Ask "encrypt?" and, if yes, a password (entered twice). Resolves {encrypt, password} or null if cancelled. */
function askEncryption({ title, schedule }) {
  return new Promise(resolve => {
    openModal(`<h2>${esc(title)}</h2>
      <p class="muted">${schedule ? 'Should automatic backups be encrypted?' : 'Should this backup be encrypted?'} Encrypted backups are a single sealed file — chats, files, notes and settings can only be read with the password.</p>
      <div class="choice-row">
        <button class="choice" data-enc="no"><b>No</b><span>Plain folder — anyone who can open the share can read it</span></button>
        <button class="choice" data-enc="yes"><b>🔒 Yes, encrypt</b><span>Protected with a password you choose</span></button>
      </div>
      <div id="pw-fields" class="hidden">
        <label>Password (at least 8 characters)<input type="password" id="pw1" autocomplete="new-password"></label>
        <label>Type it again<input type="password" id="pw2" autocomplete="new-password"></label>
        <p class="warn-text">⚠️ If you forget this password, ${schedule ? 'these backups' : 'this backup'} can't be restored — there is no recovery.
        ${schedule ? 'The app keeps it locked with Windows security on this PC so scheduled backups can run on their own; you only need it to restore.' : "It isn't saved anywhere."}</p>
      </div>
      <div class="modal-actions"><span id="m-err" class="err-text"></span><button class="ghost" id="m-cancel">Cancel</button><button class="primary" id="m-ok" disabled>Continue</button></div>`);
    let choice = null;
    const done = (v) => { closeModal(); resolve(v); };
    $$('#modal-box [data-enc]').forEach(b => b.onclick = () => {
      choice = b.dataset.enc;
      $$('#modal-box [data-enc]').forEach(x => x.classList.toggle('selected', x === b));
      $('#pw-fields').classList.toggle('hidden', choice !== 'yes');
      $('#m-ok').disabled = false;
      $('#m-ok').textContent = choice === 'yes' ? 'Encrypt' : 'Continue';
      if (choice === 'yes') $('#pw1').focus();
    });
    const submit = () => {
      if (!choice) return;
      if (choice === 'no') return done({ encrypt: false, password: null });
      const a = $('#pw1').value, b = $('#pw2').value;
      if (a.length < 8) { $('#m-err').textContent = 'Use at least 8 characters.'; return; }
      if (a !== b) { $('#m-err').textContent = "The passwords don't match."; return; }
      done({ encrypt: true, password: a });
    };
    $('#m-ok').onclick = submit;
    $('#m-cancel').onclick = () => done(null);
    $('#modal-box').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') submit(); });
  });
}

/** Ask for an existing password. Resolves the password or null if cancelled. */
function askPassword({ title, message, error }) {
  return new Promise(resolve => {
    openModal(`<h2>${esc(title)}</h2><p class="muted">${esc(message)}</p>
      <label>Password<input type="password" id="pw1" autocomplete="current-password"></label>
      <div class="modal-actions"><span id="m-err" class="err-text">${esc(error || '')}</span><button class="ghost" id="m-cancel">Cancel</button><button class="primary" id="m-ok">Restore</button></div>`);
    const done = (v) => { closeModal(); resolve(v); };
    const submit = () => { const v = $('#pw1').value; if (!v) { $('#m-err').textContent = 'Enter the password.'; return; } done(v); };
    $('#m-ok').onclick = submit;
    $('#m-cancel').onclick = () => done(null);
    $('#pw1').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    $('#pw1').focus();
  });
}

function scheduleOn(st) { return !!(st.backupPath && Number(st.backupIntervalHours) > 0); }

/** Save the settings form; if this creates (or re-creates) a backup schedule, ask about encryption. */
async function saveSettingsForm({ askIfUnanswered = false } = {}) {
  const before = snap.settings;
  try { snap = await relay.saveSettings(settingsPatch()); }
  catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 6000); return false; }
  // Ask when a schedule is created (or re-enabled); the Save button also asks if it was never answered.
  const created = scheduleOn(snap.settings) && !scheduleOn(before);
  if (created || (askIfUnanswered && scheduleOn(snap.settings) && !snap.settings.backupEncryptChosen)) await chooseScheduleEncryption();
  return true;
}

async function chooseScheduleEncryption() {
  const c = await askEncryption({ title: 'Automatic backups', schedule: true });
  if (!c) {
    if (!snap.settings.backupEncryptChosen) toast('Automatic backups are paused until you choose whether to encrypt them.', 5000);
    renderBackup(); return;
  }
  try { snap = await relay.setBackupSchedule(c); toast(c.encrypt ? '🔒 Automatic backups will be encrypted' : 'Automatic backups will not be encrypted'); }
  catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 6000); }
  renderBackup();
}

function renderBackup() {
  const b = snap.backup || {};
  const last = snap.settings.lastBackupAt;
  $('#backup-status').innerHTML = b.running ? 'Working…'
    : `${b.lastError ? `<span style="color:var(--err)">${esc(b.lastError)}</span><br>` : ''}${esc(b.lastResult || '')}${last ? `<div class="muted">Last successful backup: ${new Date(last).toLocaleString()}</div>` : '<div class="muted">No backup yet</div>'}`;
  $('#backup-pw-status').textContent = b.hasPassword ? 'password saved (encrypted)' : '';
  const st = snap.settings;
  const sched = !st.backupPath ? 'Set a backup folder to enable automatic backups'
    : !(Number(st.backupIntervalHours) > 0) ? 'Off — manual backups only'
      : !st.backupEncryptChosen ? '⏸ Paused — choose whether to encrypt them'
        : `Every ${st.backupIntervalHours} h · ${b.scheduleEncrypted ? '🔒 encrypted' : 'not encrypted'}`;
  $('#schedule-status').textContent = sched;
  $('#btn-schedule-enc').classList.toggle('hidden', !scheduleOn(st));
  $('#btn-schedule-enc').textContent = st.backupEncryptChosen ? 'Change encryption…' : 'Choose…';
}
function settingsPatch() {
  const patch = {};
  $$('[data-setting]').forEach(el => { const k = el.dataset.setting; patch[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim(); });
  return patch;
}
async function showBackups() {
  $('#backup-list').innerHTML = '<div class="muted">Loading…</div>';
  const r = await relay.listBackups();
  if (!r.ok) { $('#backup-list').innerHTML = `<div style="color:var(--err)">${esc(r.message)}</div>`; return; }
  $('#backup-list').innerHTML = r.backups.length ? r.backups.map(b => `<div class="backup-row"><div class="info"><div><b>${esc(new Date(b.manifest.created).toLocaleString())}</b>${b.manifest.encrypted ? '<span class="lock">🔒 encrypted</span>' : ''} · v${esc(b.manifest.version)} · ${esc(b.manifest.reason)}</div><div class="muted">${b.manifest.files} files · ${kb(b.manifest.bytes)} · from ${esc(b.manifest.host)} · ${esc(b.path)}</div></div><button class="ghost small" data-restore="${esc(b.path)}">Restore</button></div>`).join('') : '<div class="muted">No backups in this folder yet.</div>';
  $$('#backup-list [data-restore]').forEach(btn => btn.onclick = () => doRestore(btn.dataset.restore));
}
async function doRestore(dir) {
  const withSettings = $('#restore-settings').checked;
  let r = await relay.restoreBackup(dir, withSettings, null, false);
  if (r.cancelled) return;
  // Encrypted backup: ask for the password (again, if it was wrong) — the live data is untouched until it's right.
  while (!r.ok && (r.needPassword || r.wrongPassword)) {
    const pw = await askPassword({ title: '🔒 Restore encrypted backup', message: 'Enter the password this backup was created with.', error: r.wrongPassword ? 'Wrong password — try again.' : '' });
    if (pw == null) return;
    r = await relay.restoreBackup(dir, withSettings, pw, true);
  }
  toast(r.ok ? 'Restore complete' : 'Restore failed: ' + r.message, 6000);
  await refresh(); renderSettings();
}
$('#btn-pick-backup').onclick = async () => { const p = await relay.pickFolder('Choose backup folder (network share)'); if (p) $('[data-setting="backupPath"]').value = p; };
$('#btn-set-backup-pw').onclick = async () => {
  try {
    snap = await relay.saveSettings({ backupUser: $('[data-setting="backupUser"]').value.trim() });
    snap = await relay.setBackupPassword($('#backup-password').value);
    $('#backup-password').value = ''; renderBackup(); toast('Share credentials saved');
  } catch (e) { toast(e.message, 5000); }
};
$('#btn-backup-now').onclick = async () => {
  if (!await saveSettingsForm()) return; // use what's typed in the form
  if (!snap.settings.backupPath) { toast('Set a backup folder first'); return; }
  const c = await askEncryption({ title: 'Back up now', schedule: false });
  if (!c) return;
  $('#backup-status').textContent = c.encrypt ? 'Encrypting and backing up…' : 'Backing up…';
  const r = await relay.backupNow(c.encrypt ? c.password : null);
  toast(r.ok ? 'Backup complete' : 'Backup failed: ' + r.message, 5000);
  await refresh(); renderBackup();
  if (r.ok && $('#backup-list').innerHTML) showBackups();
};
$('#btn-list-backups').onclick = async () => { if (await saveSettingsForm()) showBackups(); };
$('#btn-schedule-enc').onclick = () => chooseScheduleEncryption();
$('#btn-restore-folder').onclick = async () => { const p = await relay.pickFolder('Choose an AgentRelay-Backup-… folder'); if (p) doRestore(p); };

function renderUpdate(u) {
  if (!u) return;
  $('#upd-version').textContent = 'v' + snap.version;
  $('#upd-status').textContent = u.message + (u.lastCheck ? ` · last checked ${ago(u.lastCheck)}` : '');
  $('#btn-install-update').classList.toggle('hidden', u.status !== 'ready');
  $('#update-badge').classList.toggle('hidden', u.status !== 'ready');
}
$('#btn-save').onclick = async () => {
  $('#save-status').textContent = 'Saving…';
  if (!await saveSettingsForm({ askIfUnanswered: true })) { $('#save-status').textContent = ''; return; }
  renderSettings();
  $('#save-status').textContent = 'Saved ✓';
  setTimeout(() => $('#save-status').textContent = '', 2500);
  renderAll();
};
$('#btn-check-updates').onclick = async () => { $('#upd-status').textContent = 'Checking…'; renderUpdate(await relay.checkUpdates()); };
$('#btn-install-update').onclick = () => relay.installUpdate();
$('#btn-pick-vault').onclick = async () => { const p = await relay.pickVault(); if (p) $('[data-setting="vaultPath"]').value = p; };
$('#btn-open-vault').onclick = $('#btn-open-vault2').onclick = () => relay.openVault();
$('#btn-logs').onclick = () => relay.openLogs();
$('#btn-prune').onclick = async () => { const r = await relay.pruneNow(); toast(`Cleanup removed ${r.files || 0} old file(s)`); await refresh(); renderSettings(); };
$('#btn-clear').onclick = async () => { if (await relay.clearHistory()) { toast('Chat history deleted'); await refresh(); openChannel(current); } };

// ---------- live updates ----------
function renderAll() { renderServerStatus(); renderSidebar(); }
async function refresh() { snap = await relay.snapshot(); applyThemeAttr(snap.settings.theme); renderAll(); }

relay.onMessage(m => {
  const sums = snap.channels || (snap.channels = []);
  let s = sums.find(c => c.channel === m.channel);
  if (!s) { s = { channel: m.channel, count: 0 }; sums.push(s); }
  Object.assign(s, { count: s.count + 1, lastSeq: m.seq, lastTs: m.ts, lastFrom: m.from, lastText: m.text.slice(0, 120) });
  sums.sort((a, b) => b.lastSeq - a.lastSeq);
  if (m.channel === current) { appendMessage(m); if (document.hasFocus()) { setLastRead(current, m.seq); relay.markRead(); } }
  if (!snap.agents.some(a => a.name === m.from)) refresh(); else renderSidebar();
});
relay.onAgents(a => { snap.agents = a; renderAll(); if ($('#view-connect').classList.contains('active')) renderConnect(); });
relay.onJobs(j => { snap.jobs = j; renderSidebar(); if ($('#view-jobs').classList.contains('active')) renderJobs(); });
relay.onReset(async () => { await refresh(); if ($('#view-chat').classList.contains('active')) openChannel(current); });
relay.onUpdate(u => { snap.updater = u; renderUpdate(u); if (u.status === 'ready') toast(u.message, 6000); });
relay.onRetention(e => toast(`Cleanup: ${e.detail}`, 5000));
relay.onTrayBackup(() => { showView('settings'); setTimeout(() => $('#btn-backup-now').click(), 300); });
window.addEventListener('focus', () => { const s = channelSummary(current); if (s) { setLastRead(current, s.lastSeq); renderSidebar(); } });
setInterval(async () => { if (snap) { const fresh = await relay.snapshot(); snap.connection = fresh.connection; snap.memory = fresh.memory; snap.stats = fresh.stats; snap.agents = fresh.agents; renderAll(); } }, 30000);

(async () => {
  await refresh();
  openChannel(BROADCAST);
})();
