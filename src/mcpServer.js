'use strict';
/**
 * Network MCP server (Streamable HTTP) + small REST helpers.
 *
 * Endpoints
 *   POST|GET|DELETE /mcp/<AgentName>?key=<accessKey>   MCP endpoint (one URL per agent)
 *   POST /upload/<AgentName>?key=..&filename=..        raw upload, returns attachment id
 *   GET  /files/<AgentName>/<attachmentId>?key=..      download an attachment visible to that agent
 *   GET  /health                                       liveness probe (no auth)
 */
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { BROADCAST, JOB_STATUSES, guessMime, isTextMime } = require('./store');

const MAX_BODY = 60 * 1024 * 1024;
const MAX_INLINE_IMAGE = 3.5 * 1024 * 1024;
const MAX_INLINE_TEXT = 120 * 1024;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const MAX_SESSIONS_TOTAL = 200;
const MAX_SESSIONS_PER_AGENT = 16;
const AUTH_FAIL_LIMIT = 20;            // failed attempts per IP…
const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000; // …within this window → blocked for the rest of it
const SAFE_INLINE = /^image\/(png|jpeg|gif|webp|bmp)$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;

const INSTRUCTIONS = `You are connected to Agent Relay, a shared chat + job board used by several Claude agents and a human operator.
Your agent name is fixed by the URL you connected with (see whoami).
Protocol:
- Call check_messages at the start of every task and regularly while idle. Use wait_for_messages to block until something arrives.
- To hand work to another agent, use create_job (preferred for real work) or send_message for conversation. Be explicit: goal, context, files, acceptance criteria.
- When you receive a job: update_job(status="claimed"), then "in_progress", then "done" with a result (or "failed"/"blocked" with a note).
- Files and images can be attached as text or base64. Use get_attachment to fetch files you receive.
- The shared Obsidian-style vault (write_note/read_note/list_notes/search_vault) is for durable knowledge both agents should keep.`;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, address: a.address });
  }
  return out;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function fmtTime(ts) { return new Date(ts).toLocaleString(); }

function fmtMessage(m) {
  const head = `#${m.seq} [${fmtTime(m.ts)}] ${m.from} → ${m.to}${m.kind !== 'message' ? ` (${m.kind}${m.jobId ? ' ' + m.jobId : ''})` : ''}`;
  let s = `${head}\n${m.text}`;
  if (m.attachments && m.attachments.length) {
    s += '\nAttachments: ' + m.attachments.map(a => `${a.name} [${a.id}, ${a.mime}, ${Math.ceil(a.size / 1024)} KB]`).join('; ');
  }
  return s;
}

function fmtJob(j, full) {
  let s = `${j.id} | ${j.status.toUpperCase()} | ${j.priority} | ${j.from} → ${j.to}${j.claimedBy ? ` (claimed by ${j.claimedBy})` : ''} | ${j.title} | updated ${fmtTime(j.updated)}`;
  if (full) {
    s += `\n\nDescription:\n${j.description}`;
    if (j.attachments.length) s += `\n\nAttachments: ${j.attachments.map(a => `${a.name} [${a.id}]`).join('; ')}`;
    s += `\n\nActivity:\n${j.log.map(l => `- ${fmtTime(l.ts)} ${l.by}: ${l.status ? '[' + l.status + '] ' : ''}${l.note || ''}`).join('\n')}`;
    if (j.result) s += `\n\nResult:\n${j.result}`;
  }
  return s;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: `Error: ${t}` }], isError: true });

const attachmentInput = z.array(z.object({
  filename: z.string().min(1).max(200).describe('File name including extension, e.g. "report.md" or "screenshot.png"'),
  text: z.string().max(25 * 1024 * 1024).optional().describe('File content for text files'),
  base64: z.string().max(40 * 1024 * 1024).optional().describe('Base64 content for binary files (images, pdf, zip...)'),
  mime_type: z.string().optional()
})).max(20).optional().describe('Files to attach (text or base64)');

class RelayServer {
  constructor(store, getSettings, log = console) {
    this.store = store;
    this.getSettings = getSettings;
    this.log = log;
    this.sessions = new Map(); // sessionId -> {transport, server, agent, lastActivity}
    this.authFails = new Map(); // ip -> {count, since}
    this.httpServer = null;
    this.status = { running: false, error: null, port: null };
  }

  // ---------- auth / routing ----------
  _blocked(ip) {
    const f = this.authFails.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > AUTH_FAIL_WINDOW_MS) { this.authFails.delete(ip); return false; }
    return f.count >= AUTH_FAIL_LIMIT;
  }

  _recordFail(ip) {
    const now = Date.now();
    const f = this.authFails.get(ip);
    if (!f || now - f.since > AUTH_FAIL_WINDOW_MS) this.authFails.set(ip, { count: 1, since: now });
    else f.count++;
    if (this.authFails.size > 5000) this.authFails.clear(); // memory guard
    const c = this.authFails.get(ip);
    if (c && c.count === AUTH_FAIL_LIMIT) this.log.warn ? this.log.warn(`[security] blocking ${ip} for repeated bad access keys`) : this.log.info(`[security] blocking ${ip}`);
  }

  _authorized(req, url) {
    const s = this.getSettings();
    if (!s.requireKey || !s.accessKey) return true;
    const auth = req.headers['authorization'] || '';
    const given = url.searchParams.get('key') || req.headers['x-relay-key'] || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
    // Compare fixed-length digests so neither content nor length leaks through timing.
    const a = crypto.createHash('sha256').update(String(given)).digest();
    const b = crypto.createHash('sha256').update(String(s.accessKey)).digest();
    return crypto.timingSafeEqual(a, b) && String(given).length > 0;
  }

  _agentFrom(req, url, segment) {
    let seg = '';
    try { seg = decodeURIComponent(segment || ''); } catch { seg = ''; }
    return seg || req.headers['x-agent-name'] || url.searchParams.get('agent') || '';
  }

  /** Name usable by a network agent: valid and not the human operator's name. */
  _agentAllowed(name) {
    if (!this.store.validName(name)) return 'Agent name missing or invalid. Connect to /mcp/<AgentName> (start with a letter/digit; letters, digits, _ . - only; max 40).';
    if (name.toLowerCase() === String(this.store.operatorName).toLowerCase()) return `"${name}" is reserved for the human operator. Pick another agent name.`;
    return null;
  }

  async start() {
    await this.stop();
    const s = this.getSettings();
    this.httpServer = http.createServer((req, res) => this._handle(req, res).catch(e => {
      this.log.error('[http] ' + (e.stack || e));
      sendJson(res, e.status || 500, { error: e.message });
    }));
    this.httpServer.requestTimeout = 0;      // allow long-poll / SSE
    this.httpServer.headersTimeout = 30000;
    this.httpServer.maxHeadersCount = 100;
    this.httpServer.maxConnections = 500;
    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(s.port, s.host || '0.0.0.0', () => { this.httpServer.off('error', reject); resolve(); });
    }).then(() => {
      this.status = { running: true, error: null, port: s.port };
      this.log.info(`[mcp] listening on ${s.host}:${s.port}`);
    }).catch(e => {
      this.status = { running: false, error: e.code === 'EADDRINUSE' ? `Port ${s.port} is already in use` : e.message, port: s.port };
      this.log.error('[mcp] failed to start: ' + e.message);
    });
    this.reaper = setInterval(() => this._reap(), 60000);
    return this.status;
  }

  async stop() {
    clearInterval(this.reaper);
    for (const [id, sess] of this.sessions) { try { await sess.transport.close(); } catch { /* ignore */ } this.sessions.delete(id); }
    if (this.httpServer) {
      const srv = this.httpServer; this.httpServer = null;
      srv.closeAllConnections && srv.closeAllConnections();
      await new Promise(r => srv.close(() => r()));
    }
    this.status = { running: false, error: null, port: null };
  }

  _reap() {
    const now = Date.now();
    for (const [id, sess] of this.sessions) {
      if (now - sess.lastActivity > SESSION_IDLE_MS) { try { sess.transport.close(); } catch { /* ignore */ } }
    }
  }

  connectionInfo() {
    const s = this.getSettings();
    return { port: s.port, key: s.requireKey ? s.accessKey : '', addresses: lanAddresses(), hostname: os.hostname(), status: this.status, sessions: this.sessions.size };
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const ip = req.socket.remoteAddress || 'unknown';
    // No CORS: MCP clients are not browsers. Without CORS headers a malicious web page cannot read responses.
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (parts[0] === 'health') return sendJson(res, 200, { ok: true, app: 'agent-relay', sessions: this.sessions.size });
    // Respond 404 to OAuth discovery so mcp-remote does not start an OAuth flow.
    if (parts[0] === '.well-known') return sendJson(res, 404, { error: 'not found' });

    if (this._blocked(ip)) return sendJson(res, 429, { error: 'Too many failed attempts. Try again later.' });
    if (!this._authorized(req, url)) {
      this._recordFail(ip);
      // 403 (not 401) on purpose: 401 makes MCP clients attempt OAuth.
      return sendJson(res, 403, { error: 'Invalid or missing access key. Append ?key=<access key> to the URL.' });
    }
    this.authFails.delete(ip);

    if (parts[0] === 'mcp') return this._handleMcp(req, res, url, parts[1]);
    if (parts[0] === 'upload' && req.method === 'POST') return this._handleUpload(req, res, url, parts[1]);
    if (parts[0] === 'files' && parts[1] && parts[2] && req.method === 'GET') return this._handleFile(req, res, parts[1], parts[2]);
    return sendJson(res, 404, { error: 'Not found. MCP endpoint is /mcp/<AgentName>' });
  }

  async _handleUpload(req, res, url, seg) {
    const agent = this._agentFrom(req, url, seg);
    const bad = this._agentAllowed(agent);
    if (bad) return sendJson(res, 400, { error: bad });
    const name = url.searchParams.get('filename') || 'upload.bin';
    const buf = await readBody(req);
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim();
    const mime = ct && ct !== 'application/octet-stream' && MIME_RE.test(ct) ? ct.toLowerCase() : guessMime(name);
    const meta = this.store.saveAttachment(name, buf, mime, agent);
    this.store.touchAgent(agent);
    sendJson(res, 200, { attachment_id: meta.id, name: meta.name, size: meta.size, mime: meta.mime });
  }

  _handleFile(req, res, agentSeg, idSeg) {
    let agent, id;
    try { agent = decodeURIComponent(agentSeg); id = decodeURIComponent(idSeg); } catch { return sendJson(res, 400, { error: 'Bad path' }); }
    const att = this.store.getAttachment(id);
    if (!att || this._agentAllowed(agent) || !this.store.canSeeAttachment(agent, id)) return sendJson(res, 404, { error: 'No such attachment' });
    const inline = SAFE_INLINE.test(att.meta.mime);
    res.writeHead(200, {
      // Never let the browser render uploaded HTML/SVG/JS: only plain raster images inline, everything else as a download.
      'Content-Type': inline ? att.meta.mime : 'application/octet-stream',
      'Content-Length': att.meta.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.meta.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'no-store'
    });
    require('fs').createReadStream(att.abs).pipe(res);
  }

  async _handleMcp(req, res, url, seg) {
    const sid = req.headers['mcp-session-id'];
    let body;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined; } catch { return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); }
    }

    if (sid && this.sessions.has(sid)) {
      const sess = this.sessions.get(sid);
      const urlAgent = this._agentFrom(req, url, seg);
      if (urlAgent && urlAgent !== sess.agent) return sendJson(res, 403, { jsonrpc: '2.0', error: { code: -32000, message: 'Session belongs to a different agent' }, id: null });
      sess.lastActivity = Date.now();
      this.store.touchAgent(sess.agent);
      return sess.transport.handleRequest(req, res, body);
    }

    if (req.method === 'POST' && !sid && body && (Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body))) {
      const agent = this._agentFrom(req, url, seg);
      const bad = this._agentAllowed(agent);
      if (bad) return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: bad }, id: null });
      const mine = [...this.sessions.values()].filter(x => x.agent === agent).sort((x, y) => x.lastActivity - y.lastActivity);
      if (mine.length >= MAX_SESSIONS_PER_AGENT) { try { await mine[0].transport.close(); } catch { /* ignore */ } } // drop the stalest
      if (this.sessions.size >= MAX_SESSIONS_TOTAL) return sendJson(res, 503, { jsonrpc: '2.0', error: { code: -32000, message: 'Too many sessions' }, id: null });
      const server = this._buildServer(agent);
      let sessionRef;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessionRef = id;
          this.sessions.set(id, { transport, server, agent, lastActivity: Date.now() });
          this.store.setOnline(agent, +1);
          this.log.info(`[mcp] ${agent} connected (session ${id.slice(0, 8)})`);
        }
      });
      transport.onclose = () => {
        if (sessionRef && this.sessions.delete(sessionRef)) {
          this.store.setOnline(agent, -1);
          this.log.info(`[mcp] ${agent} disconnected`);
        }
      };
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }

    if (sid) return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found — please reconnect' }, id: null });
    return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session' }, id: null });
  }

  // ---------- MCP tools ----------
  _saveInputAttachments(agent, list, ids) {
    const out = [];
    for (const a of list || []) {
      let buf;
      if (a.base64 != null) buf = Buffer.from(a.base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      else if (a.text != null) buf = Buffer.from(a.text, 'utf8');
      else throw new Error(`Attachment ${a.filename} needs "text" or "base64"`);
      const mime = a.mime_type && MIME_RE.test(a.mime_type) ? a.mime_type.toLowerCase() : guessMime(a.filename);
      out.push(this.store.saveAttachment(a.filename, buf, mime, agent));
    }
    if ((list || []).length + (ids || []).length > 20) throw new Error('At most 20 attachments per call');
    for (const id of ids || []) {
      const got = this.store.getAttachment(id);
      if (!got || !this.store.canSeeAttachment(agent, id)) throw new Error(`Unknown attachment id ${id}`);
      out.push(got.meta);
    }
    return out;
  }

  _resolveTarget(agent, to) {
    const target = this.store.resolveAgent(to);
    if (target) return target;
    if (this.store.validName(to)) return to; // allow messaging agents that haven't connected yet
    throw new Error(`Unknown recipient "${to}". Use list_agents, or "all" to broadcast.`);
  }

  /** Build MCP content for a batch of messages, inlining images and small text files. */
  _messagesContent(msgs, includeFiles) {
    const content = [];
    let inlineBudget = 8 * 1024 * 1024;
    for (const m of msgs) {
      content.push({ type: 'text', text: fmtMessage(m) });
      if (!includeFiles) continue;
      for (const a of m.attachments || []) {
        const got = this.store.getAttachment(a.id);
        if (!got) continue;
        if (/^image\/(png|jpeg|gif|webp)$/.test(a.mime) && a.size <= MAX_INLINE_IMAGE && a.size <= inlineBudget) {
          inlineBudget -= a.size;
          content.push({ type: 'image', data: got.read().toString('base64'), mimeType: a.mime });
        } else if (isTextMime(a.mime) && a.size <= MAX_INLINE_TEXT) {
          content.push({ type: 'text', text: `--- ${a.name} (${a.id}) ---\n${got.read().toString('utf8')}\n--- end ${a.name} ---` });
        }
      }
    }
    return content;
  }

  _jobVisible(j, agent) {
    return !!j && (j.from === agent || j.to === agent || j.to === BROADCAST || j.claimedBy === agent);
  }

  _buildServer(agent) {
    const store = this.store;
    const server = new McpServer({ name: 'agent-relay', version: require('../package.json').version }, { instructions: INSTRUCTIONS, capabilities: { logging: {} } });
    const wrap = (fn) => async (args, extra) => {
      try { store.touchAgent(agent); return await fn(args || {}, extra); } catch (e) { return fail(e.message); }
    };

    server.registerTool('whoami', {
      title: 'Who am I',
      description: 'Show your agent name, the other agents, your unread message count and open jobs. Call this first.',
      inputSchema: { description: z.string().optional().describe('Optional: set a short description of this agent/computer (what it is good at)') }
    }, wrap(async ({ description }) => {
      if (description) store.touchAgent(agent, { description: description.slice(0, 300) });
      const agents = store.listAgents().filter(a => a.name !== agent);
      const jobs = store.listJobs({ agent, activeOnly: true });
      return text([
        `You are "${agent}" on Agent Relay (${os.hostname()}).`,
        `Unread messages: ${store.unreadFor(agent).length}`,
        `Other participants:\n${agents.map(a => `- ${a.name}${a.human ? ' (human operator)' : ''} — ${a.online ? 'online' : 'offline, last seen ' + fmtTime(a.lastSeen)}${a.description ? ' — ' + a.description : ''}`).join('\n') || '- none yet'}`,
        `Active jobs involving you:\n${jobs.map(j => '- ' + fmtJob(j)).join('\n') || '- none'}`,
        '',
        INSTRUCTIONS
      ].join('\n'));
    }));

    server.registerTool('list_agents', {
      title: 'List agents',
      description: 'List every agent/participant known to the relay with online status.',
      inputSchema: {}
    }, wrap(async () => text(store.listAgents().map(a => `${a.name}${a.name === agent ? ' (you)' : ''}${a.human ? ' (human)' : ''} — ${a.online ? 'online' : 'offline'} — last seen ${fmtTime(a.lastSeen)}${a.description ? ' — ' + a.description : ''}`).join('\n'))));

    server.registerTool('send_message', {
      title: 'Send message',
      description: 'Send a chat message (optionally with files/images) to another agent, the human operator, or "all".',
      inputSchema: {
        to: z.string().describe('Recipient agent name, or "all" to broadcast'),
        text: z.string().describe('Message text (markdown ok)'),
        attachments: attachmentInput,
        attachment_ids: z.array(z.string()).optional().describe('IDs of already-uploaded attachments to include'),
        reply_to: z.string().optional().describe('Optional message id being replied to')
      }
    }, wrap(async ({ to, text: body, attachments, attachment_ids, reply_to }) => {
      const target = this._resolveTarget(agent, to);
      const atts = this._saveInputAttachments(agent, attachments, attachment_ids);
      const m = store.postMessage({ from: agent, to: target, text: body, attachments: atts, replyTo: reply_to });
      return text(`Sent #${m.seq} to ${target}${atts.length ? ` with ${atts.length} attachment(s)` : ''}.`);
    }));

    server.registerTool('check_messages', {
      title: 'Check messages',
      description: 'Get your unread messages (direct + broadcast). Images and small text files are included inline. Marks them read.',
      inputSchema: {
        mark_read: z.boolean().optional().describe('Default true'),
        include_files: z.boolean().optional().describe('Inline images/text attachments. Default true'),
        limit: z.number().int().min(1).max(200).optional()
      }
    }, wrap(async ({ mark_read = true, include_files = true, limit = 50 }) => {
      const unread = store.unreadFor(agent);
      const batch = unread.slice(0, limit);
      if (!batch.length) {
        const jobs = store.listJobs({ agent, activeOnly: true }).filter(j => j.to === agent || j.to === BROADCAST);
        return text(`No new messages.${jobs.length ? `\nYou have ${jobs.length} active job(s) assigned:\n${jobs.map(j => '- ' + fmtJob(j)).join('\n')}` : ''}`);
      }
      if (mark_read) store.markRead(agent, batch[batch.length - 1].seq);
      const content = this._messagesContent(batch, include_files);
      if (unread.length > batch.length) content.push({ type: 'text', text: `(${unread.length - batch.length} more unread — call check_messages again)` });
      return { content };
    }));

    server.registerTool('wait_for_messages', {
      title: 'Wait for messages',
      description: 'Block until a new message arrives for you (or timeout), then return it. Use this to idle efficiently while waiting for work.',
      inputSchema: { timeout_seconds: z.number().int().min(1).max(240).optional().describe('Default 50, max 240') }
    }, wrap(async ({ timeout_seconds = 50 }, extra) => {
      const got = await store.waitFor(agent, timeout_seconds * 1000, extra && extra.signal);
      if (!got) return text(`No new messages after ${timeout_seconds}s. Call wait_for_messages again to keep listening.`);
      const batch = store.unreadFor(agent).slice(0, 50);
      store.markRead(agent, batch[batch.length - 1].seq);
      return { content: this._messagesContent(batch, true) };
    }));

    server.registerTool('read_history', {
      title: 'Read history',
      description: 'Read past messages of a conversation (already-read ones included).',
      inputSchema: {
        with: z.string().optional().describe('Agent name or "all". Omit for everything involving you.'),
        limit: z.number().int().min(1).max(200).optional(),
        before_seq: z.number().int().optional().describe('Page backwards: only messages with seq lower than this')
      }
    }, wrap(async (a) => {
      const w = a.with ? (store.resolveAgent(a.with) || a.with) : null;
      const msgs = store.history(agent, w, { limit: a.limit || 30, beforeSeq: a.before_seq });
      return text(msgs.length ? msgs.map(fmtMessage).join('\n\n') : 'No messages.');
    }));

    server.registerTool('get_attachment', {
      title: 'Get attachment',
      description: 'Fetch a file by attachment id. Images are returned viewable, text inline, other files as base64.',
      inputSchema: { attachment_id: z.string() }
    }, wrap(async ({ attachment_id }) => {
      const got = store.getAttachment(attachment_id);
      if (!got || !store.canSeeAttachment(agent, attachment_id)) return fail('No such attachment (it may have been pruned).');
      const { meta } = got;
      const s = this.getSettings();
      const dl = `Download: http://<relay-host>:${s.port}/files/${agent}/${meta.id}${s.requireKey ? '?key=<key>' : ''}`;
      if (/^image\//.test(meta.mime) && meta.size <= MAX_INLINE_IMAGE && meta.mime !== 'image/svg+xml') {
        return { content: [{ type: 'text', text: `${meta.name} (${meta.mime}, ${meta.size} bytes)` }, { type: 'image', data: got.read().toString('base64'), mimeType: meta.mime }] };
      }
      if (isTextMime(meta.mime) || meta.mime === 'image/svg+xml') {
        const buf = got.read();
        return text(`${meta.name} (${meta.mime}, ${meta.size} bytes)\n\n${buf.slice(0, 2 * 1024 * 1024).toString('utf8')}`);
      }
      if (meta.size > 20 * 1024 * 1024) return text(`${meta.name} is ${meta.size} bytes — too large to return inline. ${dl}`);
      return { content: [{ type: 'text', text: `${meta.name} (${meta.mime}, ${meta.size} bytes). ${dl}` }, { type: 'resource', resource: { uri: `relay://attachments/${meta.id}/${encodeURIComponent(meta.name)}`, mimeType: meta.mime, blob: got.read().toString('base64') } }] };
    }));

    server.registerTool('create_job', {
      title: 'Create job',
      description: 'Hand off a unit of work to another agent. Creates a tracked job ticket in the vault and notifies the assignee.',
      inputSchema: {
        to: z.string().describe('Assignee agent name, or "all" for whoever claims it first'),
        title: z.string().describe('Short title'),
        description: z.string().describe('Full instructions: goal, context, constraints, acceptance criteria, where to put results'),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        attachments: attachmentInput,
        attachment_ids: z.array(z.string()).optional()
      }
    }, wrap(async (a) => {
      const target = this._resolveTarget(agent, a.to);
      const atts = this._saveInputAttachments(agent, a.attachments, a.attachment_ids);
      const job = store.createJob({ from: agent, to: target, title: a.title, description: a.description, priority: a.priority, attachments: atts });
      return text(`Created job ${job.id} for ${target}. You'll get a message when it is updated.`);
    }));

    server.registerTool('list_jobs', {
      title: 'List jobs',
      description: 'List jobs. By default shows active jobs involving you.',
      inputSchema: {
        status: z.enum(JOB_STATUSES).optional(),
        scope: z.enum(['mine', 'assigned_to_me', 'created_by_me', 'all']).optional().describe('Default "mine"'),
        include_finished: z.boolean().optional()
      }
    }, wrap(async ({ status, scope = 'mine', include_finished = false }) => {
      let list = store.listJobs({ status, activeOnly: !include_finished && !status }).filter(j => this._jobVisible(j, agent));
      if (scope === 'mine') list = list.filter(j => j.to === agent || j.from === agent || j.to === BROADCAST);
      if (scope === 'assigned_to_me') list = list.filter(j => j.to === agent || (j.to === BROADCAST && (!j.claimedBy || j.claimedBy === agent)));
      if (scope === 'created_by_me') list = list.filter(j => j.from === agent);
      return text(list.length ? list.map(j => fmtJob(j)).join('\n') : 'No matching jobs.');
    }));

    server.registerTool('get_job', {
      title: 'Get job',
      description: 'Full details, activity log and result of a job.',
      inputSchema: { job_id: z.string() }
    }, wrap(async ({ job_id }) => {
      const j = store.getJob(job_id);
      if (!j || !this._jobVisible(j, agent)) return fail('No such job');
      const content = [{ type: 'text', text: fmtJob(j, true) }];
      for (const a of j.attachments) {
        const got = store.getAttachment(a.id);
        if (got && /^image\/(png|jpeg|gif|webp)$/.test(a.mime) && a.size <= MAX_INLINE_IMAGE) content.push({ type: 'image', data: got.read().toString('base64'), mimeType: a.mime });
      }
      return { content };
    }));

    server.registerTool('update_job', {
      title: 'Update job',
      description: 'Claim, progress, block, complete, fail or cancel a job, add a note, attach deliverables. The other party is notified.',
      inputSchema: {
        job_id: z.string(),
        status: z.enum(JOB_STATUSES).optional(),
        note: z.string().optional().describe('Progress note / question / reason'),
        result: z.string().optional().describe('Final result summary (use with status "done")'),
        attachments: attachmentInput,
        attachment_ids: z.array(z.string()).optional()
      }
    }, wrap(async (a) => {
      const job0 = store.getJob(a.job_id);
      if (!job0 || !this._jobVisible(job0, agent)) return fail('No such job');
      if (job0.to === BROADCAST && job0.claimedBy && job0.claimedBy !== agent && job0.from !== agent) return fail(`This job was claimed by ${job0.claimedBy}; only they or ${job0.from} can update it.`);
      if (a.status === 'claimed' && job0.to === BROADCAST && job0.claimedBy && job0.claimedBy !== agent) return fail(`Already claimed by ${job0.claimedBy}`);
      const atts = this._saveInputAttachments(agent, a.attachments, a.attachment_ids);
      const job = store.updateJob(a.job_id, agent, { status: a.status, note: a.note, result: a.result, attachments: atts });
      return text(`Job ${job.id} is now ${job.status}.`);
    }));

    server.registerTool('write_note', {
      title: 'Write vault note',
      description: 'Create/overwrite (or append to) a markdown note in the shared vault Notes folder. Supports [[wikilinks]].',
      inputSchema: { path: z.string().describe('e.g. "projects/website/decisions.md"'), content: z.string(), append: z.boolean().optional() }
    }, wrap(async ({ path: p, content, append }) => text(`Saved Notes/${store.writeNote(p, content, append)}`)));

    server.registerTool('read_note', {
      title: 'Read vault note',
      description: 'Read a markdown note from the shared vault.',
      inputSchema: { path: z.string() }
    }, wrap(async ({ path: p }) => { const t = store.readNote(p); return t == null ? fail('Note not found') : text(t); }));

    server.registerTool('list_notes', {
      title: 'List vault notes',
      description: 'List notes in the shared vault (optionally within a folder).',
      inputSchema: { folder: z.string().optional() }
    }, wrap(async ({ folder }) => { const l = store.listNotes(folder); return text(l.length ? l.map(n => `${n.path} (${n.size} B, ${fmtTime(n.modified)})`).join('\n') : 'No notes.'); }));

    server.registerTool('search_vault', {
      title: 'Search vault',
      description: 'Full-text search across notes, jobs and chat history.',
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(100).optional() }
    }, wrap(async ({ query, limit }) => {
      const hits = store.searchVault(query, limit || 30, agent).filter(h => h.type !== 'job' || this._jobVisible(store.getJob(h.id), agent));
      return text(hits.length ? hits.map(h => h.type === 'note' ? `[note] ${h.path}: …${h.snippet}…` : h.type === 'job' ? `[job] ${h.id} ${h.status} — ${h.title}` : `[msg #${h.seq}] ${h.from} → ${h.to} (${fmtTime(h.ts)}): …${h.snippet}…`).join('\n') : 'No results.');
    }));

    server.registerPrompt('check_inbox', {
      title: 'Check Agent Relay inbox',
      description: 'Check for new messages and jobs and act on them.'
    }, () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'Check Agent Relay: call check_messages and list_jobs(scope="assigned_to_me"). For each new job, claim it, do the work, and update it to done with a result. Reply to any messages that need an answer.' } }]
    }));

    server.registerPrompt('work_loop', {
      title: 'Agent Relay work loop',
      description: 'Stay on duty: keep waiting for messages and process jobs as they arrive.'
    }, () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'You are on duty for Agent Relay. Loop: call wait_for_messages; when something arrives, handle it (claim jobs, do the work, update_job to done with results, reply to messages); then call wait_for_messages again. Continue until I tell you to stop.' } }]
    }));

    return server;
  }
}

module.exports = { RelayServer, lanAddresses };
