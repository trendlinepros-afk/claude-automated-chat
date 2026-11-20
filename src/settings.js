'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  port: 3737,
  host: '0.0.0.0',
  accessKey: '',            // generated on first run; '' disables auth
  requireKey: true,
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
  notifications: true
};

class Settings {
  constructor(file, defaultVault) {
    this.file = file;
    this.data = Object.assign({}, DEFAULTS);
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* first run */ }
    let changed = false;
    if (!this.data.accessKey) { this.data.accessKey = crypto.randomBytes(12).toString('hex'); changed = true; }
    if (!this.data.vaultPath) { this.data.vaultPath = defaultVault; changed = true; }
    if (changed) this.save();
  }
  get() { return Object.assign({}, this.data); }
  update(patch) {
    for (const k of Object.keys(patch || {})) if (k in DEFAULTS) this.data[k] = patch[k];
    this.data.port = Math.min(65535, Math.max(1, parseInt(this.data.port, 10) || DEFAULTS.port));
    this.save();
    return this.get();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { Settings, DEFAULTS };
