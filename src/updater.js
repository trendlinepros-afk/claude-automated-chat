'use strict';
/**
 * Auto-update from GitHub Releases (electron-updater).
 * - Checks on every launch and every 4 hours.
 * - Downloads automatically, then installs silently and relaunches.
 */
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

class Updater {
  constructor(getSettings, log, onState, beforeQuit) {
    this.getSettings = getSettings;
    this.log = log;
    this.onState = onState;
    this.beforeQuit = beforeQuit;
    this.state = { status: 'idle', message: 'Not checked yet', version: app.getVersion(), available: null, progress: null, lastCheck: null };
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => this._set({ status: 'checking', message: 'Checking for updates…' }));
    autoUpdater.on('update-not-available', () => this._set({ status: 'current', message: `You're on the latest version (${app.getVersion()})`, lastCheck: Date.now() }));
    autoUpdater.on('update-available', (i) => this._set({ status: 'downloading', available: i.version, message: `Downloading version ${i.version}…`, lastCheck: Date.now() }));
    autoUpdater.on('download-progress', (p) => this._set({ status: 'downloading', progress: Math.round(p.percent), message: `Downloading ${this.state.available || ''}… ${Math.round(p.percent)}%` }));
    autoUpdater.on('update-downloaded', (i) => {
      this._set({ status: 'ready', available: i.version, progress: 100, message: `Version ${i.version} downloaded` });
      if (this.getSettings().autoInstallUpdates) {
        this._set({ message: `Installing ${i.version} and restarting in 10 seconds…` });
        setTimeout(() => this.installNow(), 10000);
      }
    });
    autoUpdater.on('error', (e) => this._set({ status: 'error', message: 'Update error: ' + ((e && e.message) || e).toString().split('\n')[0], lastCheck: Date.now() }));
  }

  _set(patch) { Object.assign(this.state, patch); this.onState && this.onState(this.state); }

  configure() {
    clearInterval(this.timer);
    if (this.getSettings().autoUpdate) this.timer = setInterval(() => this.check(false), CHECK_EVERY_MS);
  }

  async check(manual) {
    if (!app.isPackaged) {
      this._set({ status: 'dev', message: 'Updates are only available in the installed app (development build).' });
      return this.state;
    }
    if (!manual && !this.getSettings().autoUpdate) return this.state;
    if (this.state.status === 'ready') {
      if (manual) this.installNow();
      return this.state;
    }
    try { await autoUpdater.checkForUpdates(); } catch (e) { this._set({ status: 'error', message: 'Update check failed: ' + e.message }); }
    return this.state;
  }

  installNow() {
    if (this.state.status !== 'ready') return false;
    this.log.info('[updater] quitAndInstall');
    this.beforeQuit && this.beforeQuit();
    setImmediate(() => autoUpdater.quitAndInstall(true, true)); // silent install, relaunch afterwards
    return true;
  }
}

module.exports = { Updater };
