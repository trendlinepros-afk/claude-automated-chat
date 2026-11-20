'use strict';
/**
 * Retention: prunes old markdown chat files on a schedule and when system
 * (or process) memory gets tight.
 */
const os = require('os');
const { dayOf } = require('./store');

class Retention {
  constructor(store, getSettings, log = console) {
    this.store = store;
    this.getSettings = getSettings;
    this.log = log;
    this.lastRun = null;
    this.lastMemoryPrune = null;
    this.history = [];
  }

  start() {
    this.stop();
    const s = this.getSettings();
    const hours = Math.max(0.25, Number(s.pruneIntervalHours) || 1);
    this.scheduleTimer = setInterval(() => this.runScheduled(), hours * 3600 * 1000);
    this.memTimer = setInterval(() => this.checkMemory(), 60 * 1000);
    setTimeout(() => { this.runScheduled(); this.checkMemory(); }, 5000);
  }

  stop() { clearInterval(this.scheduleTimer); clearInterval(this.memTimer); }

  _record(kind, detail) {
    const e = { ts: Date.now(), kind, detail };
    this.history.unshift(e);
    this.history = this.history.slice(0, 50);
    this.log.info(`[retention] ${kind}: ${detail}`);
    this.store.emit('retention', e);
  }

  /** Delete chat files older than retentionDays, and finished jobs older than that too. */
  runScheduled() {
    const s = this.getSettings();
    this.lastRun = Date.now();
    const days = Number(s.retentionDays) || 0;
    if (days <= 0) return { files: 0, messages: 0 };
    const cutoffDay = dayOf(Date.now() - days * 86400000);
    let files = 0, messages = 0, jobs = 0;
    for (const e of this.store.chatFiles()) {
      if (e.day < cutoffDay) { messages += this.store.removeChatFile(e); files++; }
    }
    const cutoffTs = Date.now() - days * 86400000;
    for (const j of this.store.listJobs()) {
      if (['done', 'failed', 'cancelled'].includes(j.status) && j.updated < cutoffTs) { this.store.deleteJob(j.id); jobs++; }
    }
    const atts = this.store.cleanupAttachmentDirs(cutoffDay);
    if (files || jobs || atts) {
      this._record('schedule', `removed ${files} chat file(s), ${messages} message(s), ${jobs} finished job(s), ${atts} attachment(s) older than ${days} day(s)`);
      this.store.emit('reset');
    }
    return { files, messages, jobs, atts };
  }

  memoryStatus() {
    const total = os.totalmem(), free = os.freemem();
    const mu = process.memoryUsage();
    return {
      systemUsedPercent: Math.round(((total - free) / total) * 1000) / 10,
      systemTotalMB: Math.round(total / 1048576),
      systemFreeMB: Math.round(free / 1048576),
      processRssMB: Math.round(mu.rss / 1048576),
      heapUsedMB: Math.round(mu.heapUsed / 1048576)
    };
  }

  _overLimits() {
    const s = this.getSettings();
    const m = this.memoryStatus();
    const reasons = [];
    if (s.memoryThresholdPercent > 0 && m.systemUsedPercent >= s.memoryThresholdPercent) reasons.push(`system memory ${m.systemUsedPercent}% ≥ ${s.memoryThresholdPercent}%`);
    if (s.maxProcessMemoryMB > 0 && m.processRssMB >= s.maxProcessMemoryMB) reasons.push(`app memory ${m.processRssMB}MB ≥ ${s.maxProcessMemoryMB}MB`);
    if (s.maxMessagesInMemory > 0 && this.store.messages.length > s.maxMessagesInMemory) reasons.push(`${this.store.messages.length} messages > ${s.maxMessagesInMemory}`);
    return reasons;
  }

  /** Prune oldest chat files while over memory limits. Never deletes today's files. */
  checkMemory() {
    const reasons = this._overLimits();
    if (!reasons.length) return 0;
    const s = this.getSettings();
    const today = dayOf(Date.now());
    const keepDays = Math.max(0, Number(s.memoryPruneKeepDays) || 1);
    const protectFrom = dayOf(Date.now() - (keepDays - 1) * 86400000);
    let files = 0, messages = 0;
    const maxFilesPerPass = 25;
    for (const e of this.store.chatFiles()) {
      if (e.day >= protectFrom || e.day >= today) break;
      messages += this.store.removeChatFile(e); files++;
      if (global.gc) global.gc();
      if (files >= maxFilesPerPass || !this._overLimits().length) break;
    }
    if (files) {
      this.store.cleanupAttachmentDirs(protectFrom);
      this.lastMemoryPrune = Date.now();
      this._record('memory', `${reasons.join('; ')} → removed ${files} oldest chat file(s) (${messages} messages)`);
      this.store.emit('reset');
    }
    return files;
  }
}

module.exports = { Retention };
