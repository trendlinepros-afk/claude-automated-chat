'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  port: 3737,
  host: '0.0.0.0',
  accessKey: '',            // generated on first run; '' disables auth
  requireKey: true,
  tls: true,                // HTTPS with the app's own certificate authority
  operatorName: 'Operator',
  vaultPath: '',            // set on first run
  retentionDays: 14,        // 0 = keep forever
  pruneIntervalHours: 1,
  memoryThresholdPercent: 90,
  maxProcessMemoryMB: 1024,
  maxMessagesInMemory: 50000,
  memoryPruneKeepDays: 1,
  autoUpdate: true,
  autoInstallUpdates: true,
  launchAtStartup: true,
  startMinimized: false,
  closeToTray: true,
  notifications: true,
  theme: 'system',         // system | light | dark
  backupPath: '',           // e.g. \\\\NAS\\Backups\\AgentRelay
  backupUser: '',           // optional share credentials (DOMAIN\\user)
  backupPasswordEnc: '',    // encrypted with Windows DPAPI (safeStorage)
  backupIntervalHours: 24,  // 0 = manual only
  backupKeep: 10,
  backupIncludeSecrets: false, // include access key + TLS CA in backups (for restoring onto a new PC)
  backupEncrypt: false,         // encrypt scheduled backups with a password
  backupEncryptChosen: false,   // the user has answered "encrypt automatic backups?"
  backupSchedulePasswordEnc: '', // schedule password, locked with Windows DPAPI so unattended backups can run
  lastBackupAt: 0
};

class Settings {
  constructor(file, defaultVault) {
    this.file = file;
    this.data = Object.assign({}, DEFAULTS);
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); Object.assign(this.data, existing); } catch { /* first run */ }
    let changed = false;
    // Upgrades from versions without encryption keep plain HTTP so already-configured PCs keep working;
    // the Connect page then offers to turn encryption on. New installs are encrypted from the start.
    if (existing && existing.tls === undefined) { this.data.tls = false; changed = true; }
    // Upgrades that already had a backup schedule keep running it (unencrypted) until the user changes it.
    if (existing && existing.backupEncryptChosen === undefined && existing.backupPath) { this.data.backupEncryptChosen = true; changed = true; }
    if (!this.data.accessKey) { this.data.accessKey = crypto.randomBytes(16).toString('hex'); changed = true; }
    if (!this.data.vaultPath) { this.data.vaultPath = defaultVault; changed = true; }
    if (changed) this.save();
  }
  get() { return Object.assign({}, this.data); }
  update(patch) {
    for (const k of Object.keys(patch || {})) if (k in DEFAULTS) this.data[k] = patch[k];
    const num = (k, min, max) => {
      const v = Number(this.data[k]);
      this.data[k] = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : DEFAULTS[k];
    };
    this.data.port = Math.min(65535, Math.max(1, parseInt(this.data.port, 10) || DEFAULTS.port));
    num('retentionDays', 0, 3650); num('pruneIntervalHours', 0.25, 168); num('memoryThresholdPercent', 0, 99);
    num('maxProcessMemoryMB', 0, 65536); num('maxMessagesInMemory', 0, 10000000); num('memoryPruneKeepDays', 1, 365);
    num('backupIntervalHours', 0, 8760); num('backupKeep', 1, 1000);
    for (const k of ['requireKey', 'tls', 'backupIncludeSecrets', 'backupEncrypt', 'backupEncryptChosen', 'autoUpdate', 'autoInstallUpdates', 'launchAtStartup', 'startMinimized', 'closeToTray', 'notifications']) this.data[k] = !!this.data[k];
    if (!['system', 'light', 'dark'].includes(this.data.theme)) this.data.theme = 'system';
    this.data.host = String(this.data.host || '0.0.0.0').trim() || '0.0.0.0';
    this.save();
    return this.get();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, DEFAULTS };
