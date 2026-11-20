'use strict';
/**
 * Backup & restore of the vault + settings to a folder (typically a network share,
 * e.g. \\NAS\Backups\AgentRelay). Each backup is a timestamped folder:
 *   AgentRelay-Backup-YYYYMMDD-HHMMSS/
 *     manifest.json
 *     settings.json
 *     vault/...
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PREFIX = 'AgentRelay-Backup-';

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function dirStats(dir) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs); else { files++; bytes += fs.statSync(abs).size; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

/**
 * Connect to a Windows share with explicit credentials (`net use`). Resolves {ok, message}.
 * Uses execFile (no shell), so user/password are passed as literal arguments.
 */
function netUse(root, user, pass, execFileImpl) {
  const execFile = execFileImpl || require('child_process').execFile;
  return new Promise(resolve => {
    if (process.platform !== 'win32' && !execFileImpl) return resolve({ ok: true, message: 'not windows' });
    if (!root || !user) return resolve({ ok: true, message: 'no credentials' });
    execFile('net', ['use', root, String(pass || ''), `/user:${user}`, '/persistent:no'], { windowsHide: true, timeout: 30000 }, (err, out, errOut) => {
      const msg = String(errOut || out || (err && err.message) || '').trim();
      // 1219 = already connected to this server (possibly with other credentials); 85 = name already in use.
      if (!err || /\b(1219|85)\b/.test(msg)) return resolve({ ok: true, message: msg || 'connected' });
      resolve({ ok: false, message: msg.replace(/\s+/g, ' ').slice(0, 300) });
    });
  });
}

/** Extract "\\server\share" from a UNC path, or null. */
function uncRoot(p) {
  const m = String(p || '').match(/^\\\\([^\\/]+)[\\/]([^\\/]+)/);
  return m ? `\\\\${m[1]}\\${m[2]}` : null;
}

class BackupManager {
  /**
   * @param {object} deps
   *   getSettings(): settings object
   *   getVaultPath(): current vault path
   *   flush(): persist in-memory state before copying
   *   stopServices(): Promise   (before restore)
   *   startServices(): Promise  (after restore)
   *   applySettings(patch)      (restore settings)
   *   connectShare(target): Promise  optional, e.g. `net use` with credentials
   *   appVersion: string
   *   log
   */
  constructor(deps) {
    this.d = deps;
    this.log = deps.log || console;
    this.state = { running: false, lastBackup: null, lastResult: null, lastError: null };
    this.timer = null;
  }

  configure() {
    clearInterval(this.timer);
    const s = this.d.getSettings();
    const hours = Number(s.backupIntervalHours) || 0;
    if (s.backupPath && hours > 0) {
      this.timer = setInterval(() => this.backup('scheduled').catch(() => {}), hours * 3600 * 1000);
      // Catch up if the last backup is overdue (e.g. after a restart).
      const last = s.lastBackupAt || 0;
      if (Date.now() - last > hours * 3600 * 1000) setTimeout(() => this.backup('scheduled').catch(() => {}), 60 * 1000);
    }
  }

  stop() { clearInterval(this.timer); }

  async _target() {
    const s = this.d.getSettings();
    const target = String(s.backupPath || '').trim();
    if (!target) throw new Error('No backup folder configured. Set a network share path in Settings → Backup.');
    if (!path.isAbsolute(target) && !uncRoot(target)) throw new Error('Backup folder must be an absolute path or a UNC path like \\\\server\\share\\folder');
    const vault = path.resolve(this.d.getVaultPath());
    const resolved = path.resolve(target);
    if (resolved === vault || resolved.startsWith(vault + path.sep)) throw new Error('The backup folder cannot be inside the vault');
    let shareMsg = '';
    if (this.d.connectShare) {
      const r = await this.d.connectShare(target);
      if (r && r.ok === false) shareMsg = ` (net use: ${r.message})`;
    }
    try {
      fs.mkdirSync(target, { recursive: true });
      const probe = path.join(target, `.write-test-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    } catch (e) {
      const why = { EACCES: 'access denied', EPERM: 'access denied', ENOENT: 'path not found', UNKNOWN: 'share unreachable or access denied', EBUSY: 'busy' }[e.code] || e.code || e.message;
      throw new Error(`Cannot write to ${target}: ${why}${shareMsg}. Check the path, that the share is online, and the share credentials.`);
    }
    return target;
  }

  async backup(reason = 'manual') {
    if (this.state.running) throw new Error('A backup or restore is already running');
    this.state.running = true;
    const started = Date.now();
    try {
      const target = await this._target();
      this.d.flush && this.d.flush();
      const name = PREFIX + stamp();
      const tmp = path.join(target, name + '.partial');
      const final = path.join(target, name);
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      const vault = this.d.getVaultPath();
      fs.cpSync(vault, path.join(tmp, 'vault'), { recursive: true, force: true, errorOnExist: false });
      const settings = Object.assign({}, this.d.getSettings());
      delete settings.backupPasswordEnc; // never copy credentials to the share
      fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(settings, null, 2));
      const st = dirStats(path.join(tmp, 'vault'));
      const manifest = { app: 'agent-relay', version: this.d.appVersion, created: new Date().toISOString(), host: os.hostname(), reason, files: st.files, bytes: st.bytes, vaultPath: vault };
      fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
      fs.renameSync(tmp, final); // only complete backups get the final name
      const pruned = this._prune(target);
      this.state.lastBackup = Date.now();
      this.state.lastResult = `Backed up ${st.files} files (${Math.ceil(st.bytes / 1024)} KB) to ${final} in ${((Date.now() - started) / 1000).toFixed(1)}s${pruned ? `; removed ${pruned} old backup(s)` : ''}`;
      this.state.lastError = null;
      this.d.applySettings && this.d.applySettings({ lastBackupAt: this.state.lastBackup }, true);
      this.log.info('[backup] ' + this.state.lastResult);
      return { ok: true, path: final, manifest, message: this.state.lastResult };
    } catch (e) {
      this.state.lastError = `Backup failed: ${e.message}`;
      this.log.error('[backup] ' + e.message);
      throw e;
    } finally {
      this.state.running = false;
    }
  }

  _prune(target) {
    const keep = Math.max(1, Number(this.d.getSettings().backupKeep) || 10);
    const list = this._listDirs(target);
    let n = 0;
    for (const b of list.slice(keep)) { try { fs.rmSync(b.path, { recursive: true, force: true }); n++; } catch (e) { this.log.error('[backup] prune ' + e.message); } }
    // Remove stale partial folders older than a day.
    for (const f of fs.readdirSync(target)) {
      if (f.startsWith(PREFIX) && f.endsWith('.partial')) {
        const abs = path.join(target, f);
        try { if (Date.now() - fs.statSync(abs).mtimeMs > 86400000) fs.rmSync(abs, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
    return n;
  }

  _listDirs(target) {
    if (!fs.existsSync(target)) return [];
    return fs.readdirSync(target)
      .filter(f => f.startsWith(PREFIX) && !f.endsWith('.partial'))
      .map(f => {
        const abs = path.join(target, f);
        let manifest = null;
        try { manifest = JSON.parse(fs.readFileSync(path.join(abs, 'manifest.json'), 'utf8')); } catch { /* not a valid backup */ }
        return { name: f, path: abs, manifest };
      })
      .filter(b => b.manifest)
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  async list() {
    const target = await this._target();
    return this._listDirs(target);
  }

  static validate(dir) {
    if (!dir || typeof dir !== 'string') throw new Error('No backup folder given');
    const m = path.join(dir, 'manifest.json');
    if (!fs.existsSync(m) || !fs.existsSync(path.join(dir, 'vault'))) throw new Error('That folder is not an Agent Relay backup (manifest.json / vault missing)');
    const manifest = JSON.parse(fs.readFileSync(m, 'utf8'));
    if (manifest.app !== 'agent-relay') throw new Error('Backup manifest is not from Agent Relay');
    return manifest;
  }

  /**
   * Restore a backup folder. Current vault is moved aside to "<vault>.pre-restore-<stamp>".
   * @param {string} dir backup folder
   * @param {{restoreSettings?: boolean}} opts
   */
  async restore(dir, opts = {}) {
    if (this.state.running) throw new Error('A backup or restore is already running');
    if (this.d.connectShare) await this.d.connectShare(dir);
    const manifest = BackupManager.validate(dir);
    this.state.running = true;
    let stopped = false;
    try {
      const vault = this.d.getVaultPath();
      // Copy to a staging folder first so a failing network copy never destroys the live vault.
      const staging = `${vault}.restoring`;
      fs.rmSync(staging, { recursive: true, force: true });
      fs.cpSync(path.join(dir, 'vault'), staging, { recursive: true });
      await this.d.stopServices(); stopped = true;
      const aside = `${vault}.pre-restore-${stamp()}`;
      if (fs.existsSync(vault)) fs.renameSync(vault, aside);
      try { fs.renameSync(staging, vault); } catch (e) { if (fs.existsSync(aside)) fs.renameSync(aside, vault); throw e; }
      if (opts.restoreSettings) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
          // Keep machine-specific values from the current install.
          for (const k of ['vaultPath', 'backupPath', 'backupUser', 'backupPasswordEnc', 'lastBackupAt']) delete s[k];
          this.d.applySettings && this.d.applySettings(s);
        } catch (e) { this.log.error('[backup] settings restore skipped: ' + e.message); }
      }
      await this.d.startServices(); stopped = false;
      this.state.lastResult = `Restored backup from ${manifest.created} (${manifest.files} files). Previous data kept at ${aside}`;
      this.state.lastError = null;
      this.log.info('[backup] ' + this.state.lastResult);
      return { ok: true, message: this.state.lastResult, previous: aside };
    } catch (e) {
      this.state.lastError = `Restore failed: ${e.message}`;
      this.log.error('[backup] restore ' + e.message);
      if (stopped) { try { await this.d.startServices(); } catch { /* ignore */ } }
      throw e;
    } finally {
      this.state.running = false;
    }
  }
}

module.exports = { BackupManager, uncRoot, netUse, PREFIX };
