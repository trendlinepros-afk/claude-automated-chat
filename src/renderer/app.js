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
function colorFor(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; }
function initials(n) { return String(n).replace(/[^A-Za-z0-9]/g, ' ').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?'; }
function toast(msg, ms = 2500) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms); }
function lastRead(ch) { try { return Number(localStorage.getItem('read:' + ch) || 0); } catch { return 0; } }
function setLastRead(ch, seq) { try { localStorage.setItem('read:' + ch, String(seq)); } catch { /* ignore */ } }

function md(text) {
  // Minimal, safe markdown: code fences, inline code, bold, italics, links, line breaks.
  const parts = String(text || '').split(/```/);
  return parts.map((p, i) => {
    if (i % 2) { const nl = p.indexOf('\n'); const body = nl >= 0 && /^[\w+-]*$/.test(p.slice(0, nl)) ? p.slice(nl + 1) : p; return `<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`; }
    let h = esc(p);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank">$2</a>');
    return h.split(/\n{2,}/).map(par => `<p>${par.replace(/\n/g, '<br>')}</p>`).join('');
  }).join('');
}

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
  $('#chat-sub').textContent = ch === BROADCAST ? 'Every connected agent receives these messages'
    : agent ? `${agent.online ? '● online' : '○ offline'} · last seen ${ago(agent.lastSeen)}${agent.description ? ' · ' + agent.description : ''}`
      : 'Read-only view of a conversation between two agents';
  $('#composer').classList.toggle('hidden', !to);
  const msgs = await relay.channel(ch, { limit: 300 });
  renderMessages(msgs);
  const sum = channelSummary(ch);
  if (sum) setLastRead(ch, sum.lastSeq);
  relay.markRead();
  renderSidebar();
  $('#input').focus();
}

function messageHtml(m) {
  const mine = m.from === op();
  const atts = (m.attachments || []).map(a => /^image\//.test(a.mime)
    ? `<img data-att="${esc(a.id)}" alt="${esc(a.name)}" title="${esc(a.name)}">`
    : `<span class="file-chip" data-open="${esc(a.id)}">📄 ${esc(a.name)} <span class="muted">${kb(a.size)}</span></span>`).join('');
  return `<div class="msg ${mine ? 'mine' : ''} ${m.kind === 'job' ? 'job' : ''}" data-seq="${m.seq}">
    <div class="who"><b>${esc(m.from)}</b> → ${esc(m.to)} · ${fmtTime(m.ts)}</div>
    <div class="bubble">${md(m.text)}${atts ? `<div class="atts">${atts}</div>` : ''}</div></div>`;
}

let lastDay = null;
function renderMessages(msgs) {
  const box = $('#messages');
  lastDay = null;
  if (!msgs.length) { box.innerHTML = '<div class="empty">No messages yet.<br>Say hello 👋</div>'; return; }
  box.innerHTML = msgs.map(m => daySep(m) + messageHtml(m)).join('');
  hydrate(box);
  box.scrollTop = box.scrollHeight;
}
function daySep(m) { const d = new Date(m.ts).toDateString(); if (d === lastDay) return ''; lastDay = d; return `<div class="day-sep">${fmtDay(m.ts)}</div>`; }

function appendMessage(m) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  const empty = box.querySelector('.empty'); if (empty) empty.remove();
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
}
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));

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
        <div class="m">${esc(j.from)} → ${esc(j.claimedBy || j.to)} · <span class="status ${esc(j.status)}">${esc(j.status)}</span></div>
        <div class="m">updated ${ago(j.updated)}</div>
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
  d.innerHTML = `<button class="ghost small" id="jd-close" style="float:right">✕</button>
    <h2>${esc(j.title)}</h2>
    <div class="muted">${esc(j.id)} · ${esc(j.from)} → ${esc(j.to)}${j.claimedBy ? ` (claimed by ${esc(j.claimedBy)})` : ''} · <span class="status ${esc(j.status)}">${esc(j.status)}</span> <span class="prio ${esc(j.priority)}">${esc(j.priority)}</span></div>
    <h3>Description</h3><div class="desc">${esc(j.description)}</div>
    ${j.attachments.length ? `<h3>Attachments</h3><div class="atts">${j.attachments.map(a => /^image\//.test(a.mime) ? `<img data-att="${esc(a.id)}" alt="${esc(a.name)}">` : `<span class="file-chip" data-open="${esc(a.id)}">📄 ${esc(a.name)}</span>`).join('')}</div>` : ''}
    ${j.result ? `<h3>Result</h3><div class="desc">${esc(j.result)}</div>` : ''}
    <div class="actions">
      <input id="jd-note" placeholder="Add a note (optional)" style="flex:1;min-width:200px">
      ${['open', 'in_progress', 'blocked', 'done', 'cancelled'].map(s => `<button class="ghost small" data-st="${s}">${s.replace('_', ' ')}</button>`).join('')}
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
  return `http://${$('#conn-ip').value || 'localhost'}:${c.port}/mcp/${name}${c.key ? `?key=${c.key}` : ''}`;
}
function updateSnippet() {
  const url = mcpUrl();
  const cfg = { mcpServers: { 'agent-relay': { command: 'npx', args: ['-y', 'mcp-remote@latest', url, '--allow-http', '--transport', 'http-only'] } } };
  $('#conn-snippet').textContent = JSON.stringify(cfg, null, 2);
  $('#conn-cc').textContent = `claude mcp add --transport http --scope user agent-relay "${url}"`;
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
  const m = snap.memory, st = snap.stats;
  $('#mem-status').textContent = `System RAM ${m.systemUsedPercent}% used (${m.systemFreeMB} MB free of ${m.systemTotalMB} MB) · App ${m.processRssMB} MB · ${st.messages} messages in ${st.chatFiles} chat file(s), ${kb(st.chatBytes)} · ${st.jobs} job(s)`;
  $('#retention-log').innerHTML = (snap.retentionHistory || []).slice(0, 8).map(e => `<div>${new Date(e.ts).toLocaleString()} [${esc(e.kind)}] ${esc(e.detail)}</div>`).join('');
}
function renderUpdate(u) {
  if (!u) return;
  $('#upd-version').textContent = 'v' + snap.version;
  $('#upd-status').textContent = u.message + (u.lastCheck ? ` · last checked ${ago(u.lastCheck)}` : '');
  $('#btn-install-update').classList.toggle('hidden', u.status !== 'ready');
  $('#update-badge').classList.toggle('hidden', u.status !== 'ready');
}
$('#btn-save').onclick = async () => {
  const patch = {};
  $$('[data-setting]').forEach(el => { const k = el.dataset.setting; patch[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim(); });
  $('#save-status').textContent = 'Saving…';
  snap = await relay.saveSettings(patch);
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
async function refresh() { snap = await relay.snapshot(); renderAll(); }

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
window.addEventListener('focus', () => { const s = channelSummary(current); if (s) { setLastRead(current, s.lastSeq); renderSidebar(); } });
setInterval(async () => { if (snap) { const fresh = await relay.snapshot(); snap.connection = fresh.connection; snap.memory = fresh.memory; snap.stats = fresh.stats; snap.agents = fresh.agents; renderAll(); } }, 30000);

(async () => {
  await refresh();
  openChannel(BROADCAST);
})();
