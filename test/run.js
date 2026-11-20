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

  await a.close(); await b.close();
  await srv.stop();
  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
