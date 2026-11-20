'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, dialog, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log/main');
const { VaultStore, BROADCAST, channelFor } = require('./store');
const { RelayServer } = require('./mcpServer');
const { Retention } = require('./retention');
const { Settings } = require('./settings');
const { Updater } = require('./updater');
const { BackupManager, uncRoot } = require('./backup');

log.initialize();
log.transports.file.maxSize = 5 * 1024 * 1024;
Object.assign(console, log.functions);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('com.trendlinepros.agentrelay');

let win = null, tray = null, store = null, relay = null, retention = null, settings = null, updater = null, backup = null;
app.isQuitting = false;

const ICON = path.join(__dirname, '..', 'build', 'icon.png');

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function createWindow() {
  const s = settings.get();
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: `Agent Relay ${app.getVersion()}`,
    icon: ICON,
    backgroundColor: '#0f1115',
    show: !s.startMinimized,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (!app.isQuitting && settings.get().closeToTray) { e.preventDefault(); win.hide(); }
  });
}

function showWindow() { if (!win) createWindow(); win.show(); if (win.isMinimized()) win.restore(); win.focus(); }

function createTray() {
  let img = nativeImage.createFromPath(ICON);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Agent Relay');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Agent Relay', click: showWindow },
    { label: 'Open vault folder', click: () => shell.openPath(settings.get().vaultPath) },
    { label: 'Check for updates', click: () => updater.check(true) },
    { label: 'Back up now', click: () => backup.backup('manual').then(r => toastNotify('Backup complete', r.message)).catch(e => toastNotify('Backup failed', e.message)) },
    { type: 'separator' },
    { label: 'Quit (stops MCP server)', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
}

function toastNotify(title, body) { if (Notification.isSupported()) new Notification({ title, body: String(body).slice(0, 200), icon: ICON }).show(); }

function applyLoginItem() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.get().launchAtStartup, args: ['--hidden'] });
}

function initStore() {
  const s = settings.get();
  store = new VaultStore(s.vaultPath, { operatorName: s.operatorName });
  store.on('error', e => log.error('[store] ' + (e.stack || e)));
  store.init();
  store.on('message', m => {
    send('relay:message', m);
    const op = settings.get().operatorName;
    if (settings.get().notifications && m.from !== op && (m.to === op || m.to === BROADCAST || m.kind === 'job') && Notification.isSupported()) {
      const visible = win && win.isVisible() && win.isFocused();
      if (!visible) {
        const n = new Notification({ title: `${m.from} → ${m.to}`, body: m.text.slice(0, 180), icon: ICON, silent: false });
        n.on('click', showWindow); n.show();
      }
    }
  });
  store.on('agents', a => send('relay:agents', a));
  store.on('jobs', j => send('relay:jobs', j));
  store.on('reset', () => send('relay:reset'));
  store.on('retention', e => send('relay:retention', e));
}

async function startServices() {
  initStore();
  relay = new RelayServer(store, () => settings.get(), log);
  await relay.start();
  retention = new Retention(store, () => settings.get(), log);
  retention.start();
}

async function stopServices() {
  if (retention) retention.stop();
  if (relay) await relay.stop();
  if (store) { store.saveStateNow(); store.removeAllListeners(); }
}

async function restartServices() {
  await stopServices();
  await startServices();
  send('relay:reset');
}

/** Connect to a network share with stored credentials (Windows `net use`). */
function connectShare(target) {
  const s = settings.get();
  const root = uncRoot(target);
  if (process.platform !== 'win32' || !root || !s.backupUser) return Promise.resolve();
  let pass = '';
  try { if (s.backupPasswordEnc) pass = safeStorage.decryptString(Buffer.from(s.backupPasswordEnc, 'base64')); } catch (e) { log.error('[backup] cannot decrypt password: ' + e.message); }
  const { execFile } = require('child_process');
  return new Promise(resolve => {
    execFile('net', ['use', root, pass, `/user:${s.backupUser}`, '/persistent:no'], { windowsHide: true, timeout: 30000 }, (err, _out, errOut) => {
      if (err && !/1219|already/i.test(String(errOut))) log.warn('[backup] net use: ' + String(errOut || err.message).trim());
      resolve();
    });
  });
}

function initBackup() {
  backup = new BackupManager({
    getSettings: () => settings.get(),
    getVaultPath: () => settings.get().vaultPath,
    flush: () => store && store.saveStateNow(),
    stopServices,
    startServices: async () => { await startServices(); send('relay:reset'); },
    applySettings: (patch) => settings.update(patch),
    connectShare,
    appVersion: app.getVersion(),
    log
  });
  backup.configure();
}

function snapshot() {
  const s = settings.get();
  return {
    version: app.getVersion(),
    settings: s,
    agents: store.listAgents(),
    jobs: store.listJobs(),
    channels: store.channels(),
    connection: relay.connectionInfo(),
    stats: store.stats(),
    memory: retention.memoryStatus(),
    retentionHistory: retention.history,
    updater: updater.state,
    backup: Object.assign({}, backup.state, { hasPassword: !!settings.get().backupPasswordEnc }),
    logFile: log.transports.file.getFile().path
  };
}

function registerIpc() {
  ipcMain.handle('relay:snapshot', () => snapshot());
  ipcMain.handle('relay:channel', (_e, channel, opts) => store.channelHistory(channel, opts || {}));
  ipcMain.handle('relay:send', (_e, { to, text, files, asJob, title, priority }) => {
    const op = settings.get().operatorName;
    const atts = (files || []).map(f => store.saveAttachment(f.name, Buffer.from(f.data, 'base64'), f.mime, op));
    if (asJob) return store.createJob({ from: op, to, title: title || text.split('\n')[0].slice(0, 80), description: text, priority, attachments: atts });
    const m = store.postMessage({ from: op, to, text, attachments: atts });
    if (to !== BROADCAST) store.markRead(op);
    return m;
  });
  ipcMain.handle('relay:markRead', () => store.markRead(settings.get().operatorName));
  ipcMain.handle('relay:updateJob', (_e, id, patch) => store.updateJob(id, settings.get().operatorName, patch));
  ipcMain.handle('relay:deleteJob', (_e, id) => store.deleteJob(id));
  ipcMain.handle('relay:channelFor', (_e, a, b) => channelFor(a, b));
  ipcMain.handle('relay:saveSettings', async (_e, patch) => {
    const before = settings.get();
    const after = settings.update(patch);
    applyLoginItem();
    const needsRestart = ['port', 'host', 'vaultPath', 'operatorName'].some(k => before[k] !== after[k]);
    if (needsRestart) await restartServices();
    else if (before.pruneIntervalHours !== after.pruneIntervalHours) retention.start();
    updater.configure();
    backup.configure();
    return snapshot();
  });
  ipcMain.handle('relay:setBackupPassword', (_e, pw) => {
    let enc = '';
    if (pw) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system');
      enc = safeStorage.encryptString(String(pw)).toString('base64');
    }
    settings.update({ backupPasswordEnc: enc });
    return snapshot();
  });
  ipcMain.handle('relay:backupNow', async () => {
    try { const r = await backup.backup('manual'); return { ok: true, message: r.message }; } catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('relay:listBackups', async () => {
    try { return { ok: true, backups: await backup.list() }; } catch (e) { return { ok: false, message: e.message, backups: [] }; }
  });
  ipcMain.handle('relay:pickFolder', async (_e, title) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: title || 'Choose folder' });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('relay:restoreBackup', async (_e, dir, restoreSettings) => {
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Cancel', 'Restore'], defaultId: 0, cancelId: 0,
      message: 'Restore this backup?',
      detail: `${dir}\n\nThe MCP server restarts briefly. Your current data is moved aside (not deleted) so you can undo.${restoreSettings ? '\nSettings will also be restored.' : ''}`
    });
    if (r.response !== 1) return { ok: false, cancelled: true };
    try { const res = await backup.restore(dir, { restoreSettings }); applyLoginItem(); return { ok: true, message: res.message }; } catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('relay:regenKey', async () => {
    settings.update({ accessKey: require('crypto').randomBytes(12).toString('hex') });
    return snapshot();
  });
  ipcMain.handle('relay:pickVault', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose vault folder' });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('relay:openVault', () => shell.openPath(settings.get().vaultPath));
  ipcMain.handle('relay:openLogs', () => shell.showItemInFolder(log.transports.file.getFile().path));
  ipcMain.handle('relay:openAttachment', (_e, id) => { const a = store.getAttachment(id); if (a) shell.openPath(a.abs); });
  ipcMain.handle('relay:attachmentData', (_e, id) => {
    const a = store.getAttachment(id);
    if (!a || a.meta.size > 15 * 1024 * 1024) return null;
    return `data:${a.meta.mime};base64,${a.read().toString('base64')}`;
  });
  ipcMain.handle('relay:pruneNow', () => { const r = retention.runScheduled(); retention.checkMemory(); return r; });
  ipcMain.handle('relay:clearHistory', async () => {
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Delete all chat history'], defaultId: 0, cancelId: 0, message: 'Delete all chat markdown files and attachments? Jobs and notes are kept.' });
    if (r.response !== 1) return false;
    store.clearAllHistory();
    return true;
  });
  ipcMain.handle('relay:checkUpdates', () => updater.check(true));
  ipcMain.handle('relay:installUpdate', () => updater.installNow());
  ipcMain.handle('relay:copy', (_e, t) => clipboard.writeText(String(t)));
  ipcMain.handle('relay:firewall', async () => {
    const port = settings.get().port;
    const { spawn } = require('child_process');
    const rule = `advfirewall firewall add rule name=AgentRelay-MCP-${port} dir=in action=allow protocol=TCP localport=${port} profile=any`;
    spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process netsh -Verb RunAs -WindowStyle Hidden -ArgumentList '${rule}'`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  });
}

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'), path.join(app.getPath('documents'), 'Agent Relay Vault'));
  updater = new Updater(() => settings.get(), log, (st) => send('relay:update', st), () => { app.isQuitting = true; });
  registerIpc();
  await startServices();
  initBackup();
  applyLoginItem();
  createTray();
  createWindow();
  if (process.argv.includes('--hidden')) win.hide();
  updater.configure();
  updater.check(false); // check on every launch; downloads + installs automatically
});

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('before-quit', () => { app.isQuitting = true; try { store && store.saveStateNow(); } catch { /* ignore */ } });
process.on('uncaughtException', e => log.error('[uncaught] ' + (e.stack || e)));
process.on('unhandledRejection', e => log.error('[unhandled] ' + (e && e.stack || e)));
