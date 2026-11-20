'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log/main');
const { VaultStore, BROADCAST, channelFor } = require('./store');
const { RelayServer } = require('./mcpServer');
const { Retention } = require('./retention');
const { Settings } = require('./settings');
const { Updater } = require('./updater');

log.initialize();
log.transports.file.maxSize = 5 * 1024 * 1024;
Object.assign(console, log.functions);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('com.trendlinepros.agentrelay');

let win = null, tray = null, store = null, relay = null, retention = null, settings = null, updater = null;
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
    { type: 'separator' },
    { label: 'Quit (stops MCP server)', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
}

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

async function restartServices() {
  if (retention) retention.stop();
  if (relay) await relay.stop();
  if (store) store.saveStateNow();
  await startServices();
  send('relay:reset');
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
    return snapshot();
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
