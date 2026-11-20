'use strict';
/**
 * Real network-share test (Windows only, run in CI).
 * Expects env: SHARE_UNC (e.g. \\localhost\RelayBackup), SHARE_LOCAL (folder behind the share),
 * SHARE_USER, SHARE_PASS. The share must only be accessible to SHARE_USER.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { VaultStore } = require('../src/store');
const { BackupManager, netUse, uncRoot } = require('../src/backup');

const { SHARE_UNC, SHARE_LOCAL, SHARE_USER, SHARE_PASS } = process.env;
if (process.platform !== 'win32' || !SHARE_UNC) { console.log('SMB test skipped (needs Windows + SHARE_UNC)'); process.exit(0); }

const log = { info: (m) => console.log('  ' + m), error: (m) => console.log('  ERR ' + m), warn: (m) => console.log('  WARN ' + m) };
function disconnect() { try { execFileSync('net', ['use', uncRoot(SHARE_UNC), '/delete', '/y'], { stdio: 'ignore' }); } catch { /* not connected */ } }

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-smb-'));
  const vault = path.join(work, 'vault');
  let store = new VaultStore(vault, { operatorName: 'Operator' }).init();
  const att = store.saveAttachment('diagram.png', Buffer.alloc(300 * 1024, 7), 'image/png', 'PC-A');
  store.postMessage({ from: 'PC-A', to: 'PC-B', text: 'before backup', attachments: [att] });
  store.createJob({ from: 'PC-A', to: 'PC-B', title: 'SMB job', description: 'kept in backup' });
  store.writeNote('projects/smb.md', '# smb note');
  store.saveStateNow();
  const target = SHARE_UNC.replace(/\\+$/, '') + '\\AgentRelay';
  const settings = { backupPath: target, backupKeep: 3, backupUser: SHARE_USER };
  let pass = 'definitely-wrong-password';

  const bm = new BackupManager({
    getSettings: () => settings,
    getVaultPath: () => vault,
    flush: () => store.saveStateNow(),
    stopServices: async () => {},
    startServices: async () => { store = new VaultStore(vault, { operatorName: 'Operator' }).init(); },
    applySettings: (p) => Object.assign(settings, p),
    connectShare: (t) => netUse(uncRoot(t), settings.backupUser, pass),
    appVersion: 'ci', log
  });

  // 1) Without valid credentials the share must refuse us, with a readable error.
  disconnect();
  await assert.rejects(() => bm.backup('manual'), (e) => { console.log('  expected failure: ' + e.message); return /Cannot write/.test(e.message); });

  // 2) With the right credentials, backup succeeds over the real UNC path.
  disconnect();
  pass = SHARE_PASS;
  const r1 = await bm.backup('manual');
  console.log('  ' + r1.message);
  const name = path.basename(r1.path);
  const local = path.join(SHARE_LOCAL, 'AgentRelay', name);
  assert(fs.existsSync(path.join(local, 'manifest.json')), 'manifest landed on the share');
  assert(fs.existsSync(path.join(local, 'vault', 'Notes', 'projects', 'smb.md')), 'notes copied');
  assert.strictEqual(fs.readdirSync(path.join(local, 'vault', 'Attachments')).length, 1, 'attachments copied');
  assert(!fs.readdirSync(path.join(SHARE_LOCAL, 'AgentRelay')).some(f => f.endsWith('.partial')), 'no partial folders left');

  // 3) Change data, take more backups, check retention of backups on the share.
  store.postMessage({ from: 'PC-B', to: 'PC-A', text: 'after backup 1' });
  for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 1100)); await bm.backup('scheduled'); }
  const list = await bm.list();
  assert.strictEqual(list.length, 3, 'keeps newest 3 on the share');

  // 4) Restore the oldest remaining backup over SMB and verify content + safety copy.
  store.postMessage({ from: 'PC-A', to: 'PC-B', text: 'written after all backups' });
  const res = await bm.restore(list[list.length - 1].path);
  console.log('  ' + res.message);
  assert(store.messages.some(m => m.text === 'after backup 1'), 'restored data present');
  assert(!store.messages.some(m => m.text === 'written after all backups'), 'newer data replaced');
  assert(fs.existsSync(path.join(res.previous, 'Chats')), 'previous vault kept aside');
  assert(store.getAttachment(att.id), 'attachment restored');

  // 5) Restoring something that is not a backup is refused and leaves data alone.
  await assert.rejects(() => bm.restore(target), /not an Agent Relay backup/);

  // 6) Encrypted backup over the share: sealed file, wrong password refused, right password restores.
  store.postMessage({ from: 'PC-A', to: 'PC-B', text: 'encrypted over smb' });
  await new Promise(r => setTimeout(r, 1100));
  const enc = await bm.backup('manual', { password: 'smb-backup-pass' });
  console.log('  ' + enc.message);
  const encLocal = path.join(SHARE_LOCAL, 'AgentRelay', path.basename(enc.path));
  assert(fs.existsSync(path.join(encLocal, 'backup.arenc')) && !fs.existsSync(path.join(encLocal, 'vault')), 'only the sealed file on the share');
  assert(!fs.readFileSync(path.join(encLocal, 'backup.arenc')).includes(Buffer.from('encrypted over smb')), 'content not readable on the share');
  store.postMessage({ from: 'PC-A', to: 'PC-B', text: 'after encrypted backup' });
  await assert.rejects(() => bm.restore(enc.path, { password: 'wrong-password' }), e => e.code === 'WRONG_PASSWORD');
  assert(store.messages.some(m => m.text === 'after encrypted backup'), 'wrong password changed nothing');
  await bm.restore(enc.path, { password: 'smb-backup-pass' });
  assert(store.messages.some(m => m.text === 'encrypted over smb') && !store.messages.some(m => m.text === 'after encrypted backup'), 'encrypted restore over SMB');

  disconnect();
  console.log('\nSMB BACKUP TEST PASSED');
})().catch(e => { console.error(e); disconnect(); process.exit(1); });
