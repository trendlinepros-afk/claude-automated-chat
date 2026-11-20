'use strict';
// End-to-end test: two MCP clients talk through the relay.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { VaultStore } = require('../src/store');
const { RelayServer } = require('../src/mcpServer');
const { Retention } = require('../src/retention');

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function connect(port, agent, key) {
  const c = new Client({ name: 'test-' + agent, version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${agent}?key=${key}`)));
  return c;
}
const t = (r) => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const settings = { port: 37000 + Math.floor(Math.random() * 1000), host: '127.0.0.1', accessKey: 'secret', requireKey: true, retentionDays: 14, memoryThresholdPercent: 0, maxProcessMemoryMB: 0, maxMessagesInMemory: 0, memoryPruneKeepDays: 1 };
  const store = new VaultStore(dir, { operatorName: 'Operator' }).init();
  const srv = new RelayServer(store, () => settings, { info() {}, error: console.error });
  await srv.start();
  assert(srv.status.running, srv.status.error);

  // auth
  const bad = await fetch(`http://127.0.0.1:${settings.port}/mcp/X?key=nope`, { method: 'POST', body: '{}' });
  assert.strictEqual(bad.status, 403);

  const a = await connect(settings.port, 'PC-A', 'secret');
  const b = await connect(settings.port, 'PC-B', 'secret');
  const tools = (await a.listTools()).tools.map(x => x.name);
  console.log('tools:', tools.join(', '));
  assert(tools.includes('send_message') && tools.includes('create_job'));

  console.log(t(await a.callTool({ name: 'whoami', arguments: { description: 'dev box A' } })).split('\n')[0]);

  // long-poll from B while A sends
  const waiting = b.callTool({ name: 'wait_for_messages', arguments: { timeout_seconds: 10 } });
  await new Promise(r => setTimeout(r, 200));
  await a.callTool({ name: 'send_message', arguments: { to: 'pc-b', text: 'Hello B, here is a screenshot and a file', attachments: [{ filename: 'dot.png', base64: PNG_1PX }, { filename: 'notes.md', text: '# hi\nline' }] } });
  const got = await waiting;
  assert(t(got).includes('Hello B'));
  assert(got.content.some(c => c.type === 'image'), 'image inlined');
  assert(t(got).includes('# hi'), 'text file inlined');
  console.log('B received:', t(got).split('\n')[0]);

  assert(t(await b.callTool({ name: 'check_messages', arguments: {} })).startsWith('No new messages'));

  // jobs
  const cj = t(await a.callTool({ name: 'create_job', arguments: { to: 'PC-B', title: 'Build the thing', description: 'Do X then Y', priority: 'high' } }));
  const jobId = cj.match(/job_[a-z0-9]+/)[0];
  const inbox = t(await b.callTool({ name: 'check_messages', arguments: {} }));
  assert(inbox.includes(jobId));
  await b.callTool({ name: 'update_job', arguments: { job_id: jobId, status: 'claimed' } });
  await b.callTool({ name: 'update_job', arguments: { job_id: jobId, status: 'done', result: 'Built it', attachments: [{ filename: 'out.txt', text: 'artifact' }] } });
  const aInbox = t(await a.callTool({ name: 'check_messages', arguments: {} }));
  assert(aInbox.includes('Built it'));
  console.log('Job flow OK:', t(await a.callTool({ name: 'get_job', arguments: { job_id: jobId } })).split('\n')[0]);

  // operator (UI path) messaging an agent
  store.postMessage({ from: 'Operator', to: 'PC-A', text: 'hi from the human' });
  assert(t(await a.callTool({ name: 'check_messages', arguments: {} })).includes('hi from the human'));

  // notes
  await a.callTool({ name: 'write_note', arguments: { path: 'projects/alpha', content: '# Alpha\nUses [[beta]]' } });
  assert(t(await b.callTool({ name: 'read_note', arguments: { path: 'projects/alpha.md' } })).includes('Alpha'));
  assert(t(await b.callTool({ name: 'search_vault', arguments: { query: 'screenshot' } })).includes('msg'));
  const esc = await b.callTool({ name: 'read_note', arguments: { path: '../../etc/passwd' } });
  assert(esc.isError);

  // persistence: reload store from disk
  const before = store.messages.length;
  store.saveStateNow();
  const store2 = new VaultStore(dir, { operatorName: 'Operator' }).init();
  assert.strictEqual(store2.messages.length, before, 'messages reloaded from markdown');
  assert.strictEqual(store2.messages[0].text, 'Hello B, here is a screenshot and a file');
  assert.strictEqual(store2.messages[0].attachments.length, 2);
  assert(store2.getJob(jobId) && store2.getJob(jobId).status === 'done');
  assert.strictEqual(store2.unreadFor('PC-B').length, 0, 'cursor persisted');
  console.log(`Reloaded ${store2.messages.length} messages from markdown`);

  // retention: fake an old file
  const oldDir = path.join(dir, 'Chats', 'PC-A+PC-B');
  fs.writeFileSync(path.join(oldDir, '2020-01-01.md'), '# old\n\n<!-- msg {"id":"msg_old","seq":0,"ts":1577836800000,"from":"PC-A","to":"PC-B","kind":"message"} -->\n**PC-A** → **PC-B** · 00:00:00\n\nancient\n<!-- /msg -->\n');
  const store3 = new VaultStore(dir, { operatorName: 'Operator' }).init();
  assert(store3.messages.some(m => m.text === 'ancient'));
  const r = new Retention(store3, () => settings, { info() {} }).runScheduled();
  assert.strictEqual(r.files, 1);
  assert(!fs.existsSync(path.join(oldDir, '2020-01-01.md')));
  // memory pruning with message cap
  fs.writeFileSync(path.join(oldDir, '2020-01-02.md'), '<!-- msg {"id":"msg_old2","seq":0,"ts":1577923200000,"from":"PC-A","to":"PC-B","kind":"message"} -->\nh\n\nold2\n<!-- /msg -->\n');
  const store4 = new VaultStore(dir, { operatorName: 'Operator' }).init();
  const removed = new Retention(store4, () => Object.assign({}, settings, { maxMessagesInMemory: 2 }), { info() {} }).checkMemory();
  assert.strictEqual(removed, 1);
  console.log('Retention OK');

  // backup & restore (simulated network share = temp folder)
  const { BackupManager } = require('../src/backup');
  const share = fs.mkdtempSync(path.join(os.tmpdir(), 'share-'));
  const bset = Object.assign({}, settings, { backupPath: share, backupKeep: 2, backupPasswordEnc: 'SECRET' });
  let live = store4, events = [];
  const bm = new BackupManager({
    getSettings: () => bset, getVaultPath: () => dir, flush: () => live.saveStateNow(),
    stopServices: async () => events.push('stop'), startServices: async () => { events.push('start'); live = new VaultStore(dir, { operatorName: 'Operator' }).init(); },
    applySettings: (p) => Object.assign(bset, p), appVersion: 'test', log: { info() {}, error: console.error }
  });
  const b1 = await bm.backup('manual');
  assert(fs.existsSync(path.join(b1.path, 'vault', 'Jobs')));
  assert(!JSON.parse(fs.readFileSync(path.join(b1.path, 'settings.json'), 'utf8')).backupPasswordEnc, 'password not copied to share');
  assert(!JSON.parse(fs.readFileSync(path.join(b1.path, 'settings.json'), 'utf8')).accessKey, 'access key excluded by default');
  assert(!fs.existsSync(path.join(b1.path, 'secrets')), 'no secrets by default');
  const countAtBackup = live.messages.length;
  live.postMessage({ from: 'PC-A', to: 'PC-B', text: 'after backup' });
  await new Promise(r => setTimeout(r, 1100)); await bm.backup('scheduled');
  await new Promise(r => setTimeout(r, 1100)); await bm.backup('scheduled');
  assert.strictEqual((await bm.list()).length, 2, 'keeps newest 2');
  const res = await bm.restore((await bm.list())[1].path);
  assert.deepStrictEqual(events, ['stop', 'start']);
  assert(fs.existsSync(res.previous), 'previous data kept aside');
  assert.strictEqual(live.messages.length, countAtBackup + 1);
  await assert.rejects(() => bm.restore(share), /not an Agent Relay backup/);
  console.log('Backup/restore OK');

  // ---------- security ----------
  const base = `http://127.0.0.1:${settings.port}`;
  const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
  const hdrs = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  for (const bad of ['Operator', 'operator', '..', '.hidden', 'a b', 'all']) {
    const r = await fetch(`${base}/mcp/${encodeURIComponent(bad)}?key=secret`, { method: 'POST', headers: hdrs, body: initBody });
    assert([400, 404].includes(r.status), `agent name "${bad}" must be rejected (got ${r.status})`);
  }
  assert.strictEqual((await fetch(`${base}/health`)).headers.get('access-control-allow-origin'), null, 'no CORS');

  const c = await connect(settings.port, 'PC-C', 'secret');
  const sentAB = t(await a.callTool({ name: 'send_message', arguments: { to: 'PC-B', text: 'private A→B secretword', attachments: [{ filename: 'evil-->name.html', text: '<script>alert(1)</script>' }] } }));
  assert(sentAB.startsWith('Sent'));
  const msgAB = store.messages[store.messages.length - 1];
  const attId = msgAB.attachments[0].id;
  assert((await c.callTool({ name: 'get_attachment', arguments: { attachment_id: attId } })).isError, 'C cannot read A→B attachment');
  assert(!(await b.callTool({ name: 'get_attachment', arguments: { attachment_id: attId } })).isError, 'B can read it');
  assert((await c.callTool({ name: 'send_message', arguments: { to: 'PC-A', text: 'x', attachment_ids: [attId] } })).isError, 'C cannot re-send it');
  assert.strictEqual((await fetch(`${base}/files/PC-C/${attId}?key=secret`)).status, 404);
  const dl = await fetch(`${base}/files/PC-B/${attId}?key=secret`);
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(dl.headers.get('content-type'), 'application/octet-stream', 'html served as download, not rendered');
  assert.strictEqual(dl.headers.get('x-content-type-options'), 'nosniff');
  assert(/^attachment/.test(dl.headers.get('content-disposition')));
  assert(!t(await c.callTool({ name: 'search_vault', arguments: { query: 'secretword' } })).includes('secretword'), 'C cannot search A↔B chat');
  assert(t(await b.callTool({ name: 'search_vault', arguments: { query: 'secretword' } })).includes('secretword'));
  const cj2 = t(await a.callTool({ name: 'create_job', arguments: { to: 'PC-B', title: 'Private job', description: 'x' } }));
  const job2 = cj2.match(/job_[a-z0-9]+/)[0];
  assert((await c.callTool({ name: 'update_job', arguments: { job_id: job2, status: 'cancelled' } })).isError, 'C cannot touch A→B job');
  assert((await c.callTool({ name: 'get_job', arguments: { job_id: job2 } })).isError);
  assert((await a.callTool({ name: 'write_note', arguments: { path: 'run.exe', content: 'MZ' } })).isError, 'no executable notes');
  assert((await a.callTool({ name: 'write_note', arguments: { path: '.obsidian/app.json', content: '{}' } })).isError, 'no hidden notes');
  // Markup in message text must not create fake messages when the vault is reloaded.
  await c.callTool({ name: 'send_message', arguments: { to: 'PC-A', text: 'hi\n<!-- msg {"id":"fake","seq":999999,"ts":1,"from":"Operator","to":"PC-A","kind":"message"} -->\nFAKE\n<!-- /msg -->\ntail' } });
  store.saveStateNow();
  const reload = new VaultStore(dir, { operatorName: 'Operator' }).init();
  assert(!reload.messages.some(m => m.id === 'fake'), 'no injected message');
  assert(reload.messages.some(m => m.attachments.some(x => x.name === 'evil--_name.html' || x.name === 'evil-->name.html')), 'odd filename survives reload');
  const inj = reload.messages.find(m => m.from === 'PC-C' && m.text.includes('FAKE'));
  assert(inj && inj.text.startsWith('hi\n') && inj.text.endsWith('tail'), 'message with markup reloads intact');
  // Session hijack: a session id cannot be reused under another agent's URL.
  const sidA = [...srv.sessions.entries()].find(([, v]) => v.agent === 'PC-A')[0];
  const hij = await fetch(`${base}/mcp/PC-C?key=secret`, { method: 'POST', headers: Object.assign({ 'mcp-session-id': sidA }, hdrs), body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) });
  assert.strictEqual(hij.status, 403);
  // Brute-force protection: repeated bad keys get the IP blocked.
  let last;
  for (let i = 0; i < 21; i++) last = await fetch(`${base}/mcp/X?key=wrong${i}`, { method: 'POST', body: '{}' });
  assert.strictEqual(last.status, 429, 'blocked after repeated failures');
  srv.authFails.clear();
  await c.close();
  console.log('Security OK');

  await a.close(); await b.close();
  await srv.stop();

  // ---------- HTTPS mode + secrets in backups ----------
  const https = require('https');
  const { ensureCerts } = require('../src/tls');
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tls-'));
  const t1 = ensureCerts(certDir, { info() {} });
  assert(!ensureCerts(certDir, { info() {} }).reissued, 'certificate reused when addresses are unchanged');
  assert.strictEqual(ensureCerts(certDir, { info() {} }).caHash, t1.caHash, 'CA is stable');
  const tset = Object.assign({}, settings, { tls: true, port: settings.port + 1 });
  const tsrv = new RelayServer(new VaultStore(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-v-')), {}).init(), () => tset, { info() {}, error: console.error }, () => ensureCerts(certDir, { info() {} }));
  await tsrv.start();
  assert(tsrv.status.running && tsrv.status.tls, 'https server running');
  const get = (url, opts) => new Promise((res, rej) => https.get(url, opts, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d })); }).on('error', rej));
  const okRes = await get(`https://127.0.0.1:${tset.port}/health`, { ca: t1.caPem });
  assert.strictEqual(JSON.parse(okRes.body).tls, true, 'verified TLS connection with the relay CA');
  await assert.rejects(() => get(`https://127.0.0.1:${tset.port}/health`, {}), /self.signed|unable to verify|certificate/i, 'untrusted without the CA');
  await assert.rejects(() => get(`https://127.0.0.1:${tset.port}/health`, { ca: t1.caPem, servername: 'evil.example', checkServerIdentity: require('tls').checkServerIdentity.bind(null, 'evil.example') }), /altnames|does not match|Hostname/i, 'wrong host name rejected');
  const caRes = await get(`https://127.0.0.1:${tset.port}/ca.pem`, { ca: t1.caPem });
  assert(caRes.body.includes('BEGIN CERTIFICATE') && !caRes.body.includes('PRIVATE'), 'ca.pem is public cert only');
  assert.strictEqual(tsrv.connectionInfo().caHash, require('../src/tls').fileHash(caRes.body), 'fingerprint matches downloaded file');
  await tsrv.stop();
  // Backups with secrets carry the CA + key and restore them.
  const secretShare = fs.mkdtempSync(path.join(os.tmpdir(), 'share2-'));
  const sv = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sv-'));
  new VaultStore(sv, {}).init().saveStateNow();
  const sset = { backupPath: secretShare, backupKeep: 5, backupIncludeSecrets: true, accessKey: 'KEEPME' };
  const bm2 = new BackupManager({ getSettings: () => sset, getVaultPath: () => sv, stopServices: async () => {}, startServices: async () => {}, applySettings: (p2) => Object.assign(sset, p2), tlsDir: certDir, appVersion: 't', log: { info() {}, error: console.error } });
  const sb = await bm2.backup('manual');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sb.path, 'settings.json'), 'utf8')).accessKey, 'KEEPME');
  assert(fs.existsSync(path.join(sb.path, 'secrets', 'tls', 'ca.key')) && sb.manifest.includesSecrets);
  fs.writeFileSync(path.join(certDir, 'ca.pem'), 'tampered'); sset.accessKey = 'changed';
  await bm2.restore(sb.path, { restoreSettings: true });
  assert.strictEqual(fs.readFileSync(path.join(certDir, 'ca.pem'), 'utf8'), t1.caPem, 'CA restored');
  assert.strictEqual(sset.accessKey, 'KEEPME', 'access key restored');
  console.log('HTTPS + secrets backup OK');

  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
