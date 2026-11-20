'use strict';
/**
 * Vault store: persists chat messages, jobs, notes and attachments as an
 * Obsidian-compatible markdown vault and keeps a fast in-memory index.
 *
 * Layout:
 *   <vault>/Chats/<channel>/<YYYY-MM-DD>.md   one file per conversation per day
 *   <vault>/Attachments/<YYYY-MM-DD>/<id>-<name>
 *   <vault>/Jobs/<id>.md                       one note per job (frontmatter + log)
 *   <vault>/Notes/**.md                        shared knowledge base
 *   <vault>/.relay/state.json                  agents, read cursors, counters
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const BROADCAST = 'all';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const NOTE_EXT = /\.(md|markdown|txt|json|csv|ya?ml|log|html?|xml|canvas)$/i;
const JOB_STATUSES = ['open', 'claimed', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'];
const MSG_END = '<!-- /msg -->';
const ATT_MARK = '<!-- attachments -->';

function pad(n) { return String(n).padStart(2, '0'); }
function dayOf(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function timeOf(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function newId(prefix) { return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`; }
function safeFileName(name) {
  const base = path.basename(String(name || 'file').replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\x00-\x1f\u202e]/g, '_').replace(/[. ]+$/, '').trim();
  return (base || 'file').slice(0, 120);
}
function escapeBody(text) {
  return String(text || '').split(MSG_END).join('<!-- /msg\u200b -->').split(ATT_MARK).join('<!-- attachments\u200b -->')
    .split('<!-- msg ').join('<!--\u200b msg ').split('<!-- job ').join('<!--\u200b job ');
}
/** JSON safe to embed inside an HTML comment (no "-->" sequences). */
function commentJson(obj) { return JSON.stringify(obj).replace(/-->/g, '--\\u003e').replace(/<!--/g, '\\u003c!--'); }
function channelFor(a, b) {
  if (b === BROADCAST || a === BROADCAST) return BROADCAST;
  return [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())).join('+');
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.js': 'text/javascript', '.ts': 'text/plain', '.py': 'text/x-python', '.html': 'text/html', '.css': 'text/css',
  '.csv': 'text/csv', '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.log': 'text/plain',
  '.pdf': 'application/pdf', '.zip': 'application/zip'
};
function guessMime(name) { return MIME[path.extname(name || '').toLowerCase()] || 'application/octet-stream'; }
function isTextMime(m) { return /^text\//.test(m) || /json|xml|javascript|yaml/.test(m); }

class VaultStore extends EventEmitter {
  constructor(vaultPath, opts = {}) {
    super();
    this.root = vaultPath;
    this.operatorName = opts.operatorName || 'Operator';
    this.messages = [];          // sorted by seq
    this.jobs = new Map();       // id -> job
    this.attachments = new Map();// id -> attachment meta
    this.state = { seq: 0, agents: {} };
    this.online = new Map();     // agent -> number of live sessions
    this._waiters = new Set();
  }

  // ---------- paths ----------
  p(...parts) { return path.join(this.root, ...parts); }
  get chatsDir() { return this.p('Chats'); }
  get attDir() { return this.p('Attachments'); }
  get jobsDir() { return this.p('Jobs'); }
  get notesDir() { return this.p('Notes'); }
  get stateFile() { return this.p('.relay', 'state.json'); }

  init() {
    for (const d of [this.chatsDir, this.attDir, this.jobsDir, this.notesDir, this.p('.relay')]) fs.mkdirSync(d, { recursive: true });
    const welcome = this.p('Notes', 'README.md');
    if (!fs.existsSync(welcome)) {
      fs.writeFileSync(welcome, '# Agent Relay Vault\n\nShared notes written by agents and the operator live here.\n' +
        'Chats are in `Chats/`, job tickets in `Jobs/`, files in `Attachments/`.\n');
    }
    try { this.state = Object.assign({ seq: 0, agents: {} }, JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))); } catch { /* fresh */ }
    this._loadMessages();
    this._loadJobs();
    this.touchAgent(this.operatorName, { human: true });
    return this;
  }

  _saveState() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveStateNow(), 300);
  }
  saveStateNow() {
    clearTimeout(this._saveTimer);
    try {
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) { this.emit('error', e); }
  }

  // ---------- loading ----------
  _loadMessages() {
    this.messages = [];
    this.attachments.clear();
    if (!fs.existsSync(this.chatsDir)) return;
    for (const ch of fs.readdirSync(this.chatsDir)) {
      const dir = path.join(this.chatsDir, ch);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try { this._parseChatFile(path.join(dir, f), ch, f.slice(0, -3)); } catch (e) { this.emit('error', e); }
      }
    }
    this.messages.sort((a, b) => a.seq - b.seq);
    const maxSeq = this.messages.length ? this.messages[this.messages.length - 1].seq : 0;
    if (maxSeq > this.state.seq) this.state.seq = maxSeq;
  }

  _parseChatFile(file, channel, day) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /<!-- msg (\{.*?\}) -->\r?\n([\s\S]*?)\r?\n<!-- \/msg -->/g;
    let m;
    while ((m = re.exec(text))) {
      let meta;
      try { meta = JSON.parse(m[1]); } catch { continue; }
      let body = m[2];
      const ai = body.indexOf(ATT_MARK);
      if (ai >= 0) body = body.slice(0, ai);
      body = body.replace(/^.*\r?\n\r?\n?/, ''); // drop rendered header line
      body = body.replace(/\s+$/, '');
      const msg = Object.assign({ attachments: [] }, meta, { text: body, channel, day });
      for (const a of msg.attachments) this.attachments.set(a.id, a);
      this.messages.push(msg);
    }
  }

  _loadJobs() {
    this.jobs.clear();
    if (!fs.existsSync(this.jobsDir)) return;
    for (const f of fs.readdirSync(this.jobsDir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const txt = fs.readFileSync(path.join(this.jobsDir, f), 'utf8');
        const m = txt.match(/<!-- job (\{[\s\S]*?\}) -->/);
        if (m) { const job = JSON.parse(m[1]); job.file = f; this.jobs.set(job.id, job); }
      } catch (e) { this.emit('error', e); }
    }
  }

  // ---------- agents ----------
  validName(name) { return NAME_RE.test(String(name || '')) && name.toLowerCase() !== BROADCAST; }

  touchAgent(name, extra = {}) {
    const now = Date.now();
    const a = this.state.agents[name] || { name, firstSeen: now, cursor: this.state.seq };
    a.lastSeen = now;
    Object.assign(a, extra);
    this.state.agents[name] = a;
    this._saveState();
    return a;
  }

  setOnline(name, delta) {
    const n = Math.max(0, (this.online.get(name) || 0) + delta);
    if (n) this.online.set(name, n); else this.online.delete(name);
    this.touchAgent(name);
    this.emit('agents', this.listAgents());
  }

  listAgents() {
    return Object.values(this.state.agents).map(a => ({
      name: a.name,
      human: !!a.human,
      description: a.description || '',
      online: a.name === this.operatorName ? true : (this.online.has(a.name) && Date.now() - (a.lastSeen || 0) < 15 * 60000),
      lastSeen: a.lastSeen,
      firstSeen: a.firstSeen,
      unread: this.unreadFor(a.name).length
    })).sort((x, y) => x.name.localeCompare(y.name));
  }

  resolveAgent(name) {
    if (!name) return null;
    if (String(name).toLowerCase() === BROADCAST) return BROADCAST;
    const hit = Object.keys(this.state.agents).find(n => n.toLowerCase() === String(name).toLowerCase());
    return hit || null;
  }

  // ---------- attachments ----------
  /** Save a file. data: Buffer. Returns attachment meta. */
  saveAttachment(name, data, mime, from) {
    const ts = Date.now();
    const id = newId('att_');
    const fname = `${id}-${safeFileName(name)}`;
    const day = dayOf(ts);
    const dir = path.join(this.attDir, day);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fname), data);
    const meta = { id, name: safeFileName(name), mime: mime || guessMime(name), size: data.length, path: `Attachments/${day}/${fname}`, from: from || null, ts };
    this.attachments.set(id, meta);
    return meta;
  }

  /** Can this agent see the attachment? (sender, recipient, broadcast, job participant, or uploader) */
  canSeeAttachment(agent, id) {
    if (agent === this.operatorName) return true;
    const meta = this.attachments.get(id);
    if (!meta) return false;
    if (meta.from === agent) return true;
    for (const m of this.messages) {
      if ((m.from === agent || this.isFor(m, agent)) && m.attachments.some(a => a.id === id)) return true;
    }
    for (const j of this.jobs.values()) {
      if ((j.from === agent || j.to === agent || j.to === BROADCAST || j.claimedBy === agent) && j.attachments.some(a => a.id === id)) return true;
    }
    return false;
  }

  getAttachment(id) {
    const meta = this.attachments.get(id);
    if (!meta) return null;
    const abs = this.p(...meta.path.split('/'));
    if (!fs.existsSync(abs)) return null;
    return { meta, abs, read: () => fs.readFileSync(abs) };
  }

  // ---------- messages ----------
  /**
   * @param {object} o {from, to, text, attachments:[meta], kind, jobId, replyTo}
   */
  postMessage(o) {
    const from = o.from;
    const to = o.to === BROADCAST ? BROADCAST : o.to;
    if (!from || !to) throw new Error('from and to are required');
    if (!this.validName(from)) throw new Error(`Invalid sender name "${from}"`);
    if (to !== BROADCAST && !this.validName(to)) throw new Error(`Invalid recipient name "${to}"`);
    const ts = Date.now();
    const seq = ++this.state.seq;
    const msg = {
      id: newId('msg_'), seq, ts, from, to,
      kind: o.kind || 'message',
      jobId: o.jobId || undefined,
      replyTo: o.replyTo || undefined,
      attachments: (o.attachments || []).map(a => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, path: a.path })),
      text: String(o.text || ''),
      channel: channelFor(from, to),
      day: dayOf(ts)
    };
    this._appendToDisk(msg);
    this.messages.push(msg);
    this.touchAgent(from);
    if (to !== BROADCAST && !this.state.agents[to]) this.touchAgent(to);
    this._saveState();
    this.emit('message', msg);
    this._wake();
    return msg;
  }

  _appendToDisk(msg) {
    const dir = path.join(this.chatsDir, msg.channel);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${msg.day}.md`);
    let out = '';
    if (!fs.existsSync(file)) {
      const title = msg.channel === BROADCAST ? 'Broadcast channel' : msg.channel.replace('+', ' ↔ ');
      out += `# ${title} — ${msg.day}\n\n`;
    }
    const meta = { id: msg.id, seq: msg.seq, ts: msg.ts, from: msg.from, to: msg.to, kind: msg.kind };
    if (msg.jobId) meta.jobId = msg.jobId;
    if (msg.replyTo) meta.replyTo = msg.replyTo;
    if (msg.attachments.length) meta.attachments = msg.attachments;
    const label = msg.kind === 'job' ? ' 🧰' : msg.kind === 'system' ? ' ⚙️' : '';
    out += `<!-- msg ${commentJson(meta)} -->\n`;
    out += `**${msg.from}** → **${msg.to}** · ${timeOf(msg.ts)}${label}\n\n`;
    out += escapeBody(msg.text) + '\n';
    if (msg.attachments.length) {
      out += `\n${ATT_MARK}\n`;
      for (const a of msg.attachments) out += `${/^image\//.test(a.mime) ? '!' : ''}[[${a.path}|${a.name}]]\n`;
    }
    out += `${MSG_END}\n\n`;
    fs.appendFileSync(file, out);
  }

  isFor(msg, agent) {
    if (msg.from === agent) return false;
    return msg.to === agent || msg.to === BROADCAST;
  }

  unreadFor(agent) {
    const a = this.state.agents[agent];
    const cursor = a ? (a.cursor || 0) : 0;
    const out = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.seq <= cursor) break;
      if (this.isFor(m, agent)) out.push(m);
    }
    return out.reverse();
  }

  markRead(agent, upToSeq) {
    const a = this.state.agents[agent] || this.touchAgent(agent);
    a.cursor = Math.max(a.cursor || 0, upToSeq == null ? this.state.seq : upToSeq);
    this._saveState();
    this.emit('agents', this.listAgents());
  }

  /** History of a conversation. withWhom: agent name or 'all'. */
  history(agent, withWhom, { limit = 50, beforeSeq } = {}) {
    const ch = withWhom ? channelFor(agent, withWhom) : null;
    const out = [];
    for (let i = this.messages.length - 1; i >= 0 && out.length < limit; i--) {
      const m = this.messages[i];
      if (beforeSeq && m.seq >= beforeSeq) continue;
      if (ch ? m.channel === ch : (m.from === agent || this.isFor(m, agent))) out.push(m);
    }
    return out.reverse();
  }

  channelHistory(channel, { limit = 200, beforeSeq } = {}) {
    const out = [];
    for (let i = this.messages.length - 1; i >= 0 && out.length < limit; i--) {
      const m = this.messages[i];
      if (beforeSeq && m.seq >= beforeSeq) continue;
      if (m.channel === channel) out.push(m);
    }
    return out.reverse();
  }

  /** Summary of every conversation channel. */
  channels() {
    const map = new Map();
    for (const m of this.messages) {
      const c = map.get(m.channel) || { channel: m.channel, count: 0 };
      c.count++; c.lastSeq = m.seq; c.lastTs = m.ts; c.lastFrom = m.from; c.lastText = m.text.slice(0, 120);
      map.set(m.channel, c);
    }
    return [...map.values()].sort((a, b) => b.lastSeq - a.lastSeq);
  }

  /** Resolve when there is unread mail for agent or timeout. */
  waitFor(agent, timeoutMs, signal) {
    if (this.unreadFor(agent).length) return Promise.resolve(true);
    return new Promise(resolve => {
      const w = { agent, done: (v) => { clearTimeout(w.t); this._waiters.delete(w); resolve(v); } };
      w.t = setTimeout(() => w.done(false), timeoutMs);
      if (signal) signal.addEventListener('abort', () => w.done(false), { once: true });
      this._waiters.add(w);
    });
  }
  _wake() {
    for (const w of [...this._waiters]) if (this.unreadFor(w.agent).length) w.done(true);
  }

  // ---------- jobs ----------
  _writeJob(job) {
    if (!job.file) job.file = `${job.id}.md`;
    const fm = [
      '---',
      `id: ${job.id}`,
      `title: ${JSON.stringify(job.title)}`,
      `status: ${job.status}`,
      `from: ${job.from}`,
      `to: ${job.to}`,
      `priority: ${job.priority}`,
      `created: ${new Date(job.created).toISOString()}`,
      `updated: ${new Date(job.updated).toISOString()}`,
      'tags: [job]',
      '---'
    ].join('\n');
    const persisted = Object.assign({}, job); delete persisted.file;
    let body = `${fm}\n\n# ${job.title}\n\n**Status:** ${job.status}  \n**From:** ${job.from} → **To:** ${job.to}  \n**Priority:** ${job.priority}\n\n## Description\n\n${escapeBody(job.description)}\n`;
    if (job.attachments && job.attachments.length) {
      body += '\n## Attachments\n\n' + job.attachments.map(a => `- ${/^image\//.test(a.mime) ? '!' : ''}[[${a.path}|${a.name}]] (\`${a.id}\`)`).join('\n') + '\n';
    }
    body += '\n## Activity\n\n' + job.log.map(l => `- ${new Date(l.ts).toISOString()} — **${l.by}**: ${l.status ? `[${l.status}] ` : ''}${String(l.note || '').replace(/\n/g, ' ')}`).join('\n') + '\n';
    if (job.result) body += `\n## Result\n\n${escapeBody(job.result)}\n`;
    body += `\n<!-- job ${commentJson(persisted)} -->\n`;
    fs.writeFileSync(path.join(this.jobsDir, job.file), body);
  }

  createJob({ from, to, title, description, priority, attachments }) {
    const now = Date.now();
    const job = {
      id: newId('job_'), title: String(title || 'Untitled job').slice(0, 200), description: String(description || ''),
      from, to, priority: priority || 'normal', status: 'open', created: now, updated: now,
      attachments: (attachments || []).map(a => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, path: a.path })),
      log: [{ ts: now, by: from, status: 'open', note: 'Job created' }], result: ''
    };
    this.jobs.set(job.id, job);
    this._writeJob(job);
    this.postMessage({
      from, to, kind: 'job', jobId: job.id, attachments: job.attachments,
      text: `🧰 NEW JOB [${job.id}] (${job.priority}) — ${job.title}\n\n${job.description}\n\nClaim it with update_job(job_id="${job.id}", status="claimed").`
    });
    this.emit('jobs', this.listJobs());
    return job;
  }

  getJob(id) { return this.jobs.get(id) || null; }

  listJobs(filter = {}) {
    let list = [...this.jobs.values()];
    if (filter.status) list = list.filter(j => j.status === filter.status);
    if (filter.agent) list = list.filter(j => j.to === filter.agent || j.from === filter.agent || j.to === BROADCAST);
    if (filter.activeOnly) list = list.filter(j => !['done', 'failed', 'cancelled'].includes(j.status));
    return list.sort((a, b) => b.updated - a.updated);
  }

  updateJob(id, by, { status, note, result, attachments }) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No job with id ${id}`);
    if (status && !JOB_STATUSES.includes(status)) throw new Error(`Invalid status. Use one of: ${JOB_STATUSES.join(', ')}`);
    const now = Date.now();
    if (status) job.status = status;
    if (status === 'claimed' && job.to === BROADCAST) job.claimedBy = by;
    if (result) job.result = String(result);
    if (attachments && attachments.length) job.attachments.push(...attachments.map(a => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, path: a.path })));
    job.updated = now;
    job.log.push({ ts: now, by, status: status || undefined, note: note || (status ? `Status → ${status}` : 'Updated') });
    this._writeJob(job);
    // Notify the other party of the job.
    const other = by === job.from ? (job.claimedBy || job.to) : job.from;
    const lines = [`🧰 JOB UPDATE [${job.id}] — ${job.title}`, `Status: ${job.status}`];
    if (note) lines.push(`Note: ${note}`);
    if (result) lines.push(`\nResult:\n${result}`);
    this.postMessage({ from: by, to: other, kind: 'job', jobId: job.id, text: lines.join('\n'), attachments: attachments || [] });
    this.emit('jobs', this.listJobs());
    return job;
  }

  deleteJob(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    try { fs.unlinkSync(path.join(this.jobsDir, job.file || `${id}.md`)); } catch { /* gone */ }
    this.jobs.delete(id);
    this.emit('jobs', this.listJobs());
    return true;
  }

  // ---------- notes ----------
  _notePath(rel) {
    let r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!r) throw new Error('path is required');
    if (!/\.[a-z0-9]+$/i.test(r)) r += '.md';
    if (!NOTE_EXT.test(r)) throw new Error('Notes must be text files (.md, .txt, .json, .csv, .yaml, …)');
    if (r.split('/').some(seg => seg.startsWith('.'))) throw new Error('Hidden files/folders are not allowed in Notes');
    const abs = path.resolve(this.notesDir, r);
    if (!abs.startsWith(path.resolve(this.notesDir) + path.sep)) throw new Error('Path escapes the Notes folder');
    return { abs, rel: path.relative(this.notesDir, abs).replace(/\\/g, '/') };
  }
  writeNote(rel, content, append) {
    const { abs, rel: r } = this._notePath(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (append) fs.appendFileSync(abs, (fs.existsSync(abs) ? '\n' : '') + content); else fs.writeFileSync(abs, content);
    return r;
  }
  readNote(rel) { const { abs } = this._notePath(rel); return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null; }
  deleteNote(rel) { const { abs } = this._notePath(rel); if (fs.existsSync(abs)) { fs.unlinkSync(abs); return true; } return false; }
  listNotes(folder) {
    const base = folder ? this._notePath(folder + '/x').abs.replace(/[\\/]x\.md$/, '') : this.notesDir;
    const out = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs);
        else { const st = fs.statSync(abs); out.push({ path: path.relative(this.notesDir, abs).replace(/\\/g, '/'), size: st.size, modified: st.mtimeMs }); }
      }
    };
    walk(base);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  searchVault(query, limit = 30, agent = null) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    const hits = [];
    for (const n of this.listNotes()) {
      if (hits.length >= limit) break;
      const txt = this.readNote(n.path) || '';
      const i = txt.toLowerCase().indexOf(q);
      if (i >= 0 || n.path.toLowerCase().includes(q)) hits.push({ type: 'note', path: n.path, snippet: txt.slice(Math.max(0, i - 80), i + 160) });
    }
    for (const j of this.jobs.values()) {
      if (hits.length >= limit) break;
      if ((j.title + ' ' + j.description + ' ' + j.result).toLowerCase().includes(q)) hits.push({ type: 'job', id: j.id, title: j.title, status: j.status });
    }
    for (let i = this.messages.length - 1; i >= 0 && hits.length < limit; i--) {
      const m = this.messages[i];
      if (agent && agent !== this.operatorName && m.from !== agent && !this.isFor(m, agent)) continue;
      const k = m.text.toLowerCase().indexOf(q);
      if (k >= 0) hits.push({ type: 'message', seq: m.seq, from: m.from, to: m.to, ts: m.ts, snippet: m.text.slice(Math.max(0, k - 80), k + 160) });
    }
    return hits;
  }

  // ---------- retention ----------
  /** All chat day files sorted oldest first: [{channel, day, file}] */
  chatFiles() {
    const out = [];
    if (!fs.existsSync(this.chatsDir)) return out;
    for (const ch of fs.readdirSync(this.chatsDir)) {
      const dir = path.join(this.chatsDir, ch);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) out.push({ channel: ch, day: f.slice(0, 10), file: path.join(dir, f) });
    }
    return out.sort((a, b) => a.day.localeCompare(b.day) || a.channel.localeCompare(b.channel));
  }

  /** Delete one chat day file and the messages/attachments it holds. */
  removeChatFile(entry) {
    try { fs.unlinkSync(entry.file); } catch { /* ignore */ }
    const removed = [];
    this.messages = this.messages.filter(m => {
      if (m.channel === entry.channel && m.day === entry.day) { removed.push(m); return false; }
      return true;
    });
    for (const m of removed) for (const a of m.attachments) {
      if (this._attachmentInUse(a.id)) continue;
      const got = this.attachments.get(a.id);
      if (got) { try { fs.unlinkSync(this.p(...got.path.split('/'))); } catch { /* ignore */ } this.attachments.delete(a.id); }
    }
    try { const dir = path.dirname(entry.file); if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* ignore */ }
    return removed.length;
  }

  _attachmentInUse(id) {
    for (const j of this.jobs.values()) if (j.attachments.some(a => a.id === id) && !['done', 'failed', 'cancelled'].includes(j.status)) return true;
    return false;
  }

  /** Remove empty attachment day folders and orphans older than cutoff day. */
  cleanupAttachmentDirs(cutoffDay) {
    if (!fs.existsSync(this.attDir)) return 0;
    let n = 0;
    const referenced = new Set();
    for (const m of this.messages) for (const a of m.attachments) referenced.add(a.id);
    for (const j of this.jobs.values()) for (const a of j.attachments) referenced.add(a.id);
    for (const day of fs.readdirSync(this.attDir)) {
      const dir = path.join(this.attDir, day);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (cutoffDay && day >= cutoffDay) continue;
      for (const f of fs.readdirSync(dir)) {
        const id = f.split('-')[0];
        if (!referenced.has(id)) { try { fs.unlinkSync(path.join(dir, f)); n++; this.attachments.delete(id); } catch { /* ignore */ } }
      }
      try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* ignore */ }
    }
    return n;
  }

  clearAllHistory() {
    for (const e of this.chatFiles()) this.removeChatFile(e);
    this.cleanupAttachmentDirs(null);
    this.emit('reset');
  }

  stats() {
    let bytes = 0;
    for (const e of this.chatFiles()) { try { bytes += fs.statSync(e.file).size; } catch { /* ignore */ } }
    return { messages: this.messages.length, jobs: this.jobs.size, chatFiles: this.chatFiles().length, chatBytes: bytes, seq: this.state.seq };
  }
}

module.exports = { VaultStore, BROADCAST, JOB_STATUSES, NAME_RE, channelFor, guessMime, isTextMime, safeFileName, dayOf };
