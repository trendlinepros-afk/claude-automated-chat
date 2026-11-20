'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('relay', {
  snapshot: () => ipcRenderer.invoke('relay:snapshot'),
  channel: (ch, opts) => ipcRenderer.invoke('relay:channel', ch, opts),
  channelFor: (a, b) => ipcRenderer.invoke('relay:channelFor', a, b),
  send: (payload) => ipcRenderer.invoke('relay:send', payload),
  markRead: () => ipcRenderer.invoke('relay:markRead'),
  updateJob: (id, patch) => ipcRenderer.invoke('relay:updateJob', id, patch),
  deleteJob: (id) => ipcRenderer.invoke('relay:deleteJob', id),
  saveSettings: (patch) => ipcRenderer.invoke('relay:saveSettings', patch),
  regenKey: () => ipcRenderer.invoke('relay:regenKey'),
  pickVault: () => ipcRenderer.invoke('relay:pickVault'),
  openVault: () => ipcRenderer.invoke('relay:openVault'),
  openLogs: () => ipcRenderer.invoke('relay:openLogs'),
  openAttachment: (id) => ipcRenderer.invoke('relay:openAttachment', id),
  attachmentData: (id) => ipcRenderer.invoke('relay:attachmentData', id),
  pruneNow: () => ipcRenderer.invoke('relay:pruneNow'),
  clearHistory: () => ipcRenderer.invoke('relay:clearHistory'),
  checkUpdates: () => ipcRenderer.invoke('relay:checkUpdates'),
  installUpdate: () => ipcRenderer.invoke('relay:installUpdate'),
  copy: (t) => ipcRenderer.invoke('relay:copy', t),
  setTheme: (t) => ipcRenderer.invoke('relay:setTheme', t),
  saveCa: () => ipcRenderer.invoke('relay:saveCa'),
  firewall: () => ipcRenderer.invoke('relay:firewall'),
  setBackupPassword: (pw) => ipcRenderer.invoke('relay:setBackupPassword', pw),
  backupNow: (password) => ipcRenderer.invoke('relay:backupNow', password || null),
  setBackupSchedule: (o) => ipcRenderer.invoke('relay:setBackupSchedule', o),
  listBackups: () => ipcRenderer.invoke('relay:listBackups'),
  pickFolder: (title) => ipcRenderer.invoke('relay:pickFolder', title),
  restoreBackup: (dir, restoreSettings, password, confirmed) => ipcRenderer.invoke('relay:restoreBackup', dir, restoreSettings, password || null, !!confirmed),
  onMessage: on('relay:message'),
  onAgents: on('relay:agents'),
  onJobs: on('relay:jobs'),
  onReset: on('relay:reset'),
  onUpdate: on('relay:update'),
  onRetention: on('relay:retention'),
  onTrayBackup: on('relay:trayBackup')
});
