'use strict';
/**
 * Password-encrypted single-file archive for backups.
 *
 * File layout (backup.arenc):
 *   header  = "ARENC001" (8) | salt (16) | baseNonce (12) | chunkSize u32 (4) | scryptN u32 (4)
 *   chunks  = repeated: ciphertextLen u32 | ciphertext | GCM tag (16)
 *
 * - Key = scrypt(password, salt, 32 bytes). Nothing about the key is stored.
 * - Each chunk is AES-256-GCM with nonce = baseNonce XOR chunkIndex, and the header + chunk index
 *   + "final" flag as associated data — so chunks can't be reordered, swapped between files or
 *   truncated without detection. A wrong password fails on the first chunk.
 * - Plaintext stream is a tiny archive: [u32 pathLen][path][u64 size][bytes]... terminated by pathLen 0.
 *   File names are therefore encrypted too.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = Buffer.from('ARENC001');
const HEADER_LEN = 8 + 16 + 12 + 4 + 4;
const CHUNK = 1024 * 1024;
const SCRYPT_N = 1 << 16; // ~64 MB memory, ~0.3 s — slows down password guessing
const SCRYPT = { r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

class WrongPasswordError extends Error { constructor() { super('Wrong password (or the backup file is damaged)'); this.code = 'WRONG_PASSWORD'; } }

function deriveKey(password, salt, N) {
  if (!password) throw new Error('A password is required');
  return crypto.scryptSync(String(password).normalize('NFC'), salt, 32, Object.assign({ N }, SCRYPT));
}

function nonceFor(base, index) {
  const n = Buffer.from(base);
  const idx = Buffer.alloc(8); idx.writeBigUInt64BE(BigInt(index));
  for (let i = 0; i < 8; i++) n[4 + i] ^= idx[i];
  return n;
}

function aad(header, index, final) {
  const b = Buffer.alloc(9); b.writeBigUInt64BE(BigInt(index)); b[8] = final ? 1 : 0;
  return Buffer.concat([header, b]);
}

function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r); else if (e.isFile()) out.push({ rel: r, abs });
    }
  };
  walk(root, '');
  return out;
}

/**
 * Encrypt a set of files into outFile.
 * @param {{rel:string, abs:string}[]} entries  archive paths (forward slashes) and source files
 */
function encryptFiles(entries, outFile, password) {
  const salt = crypto.randomBytes(16), base = crypto.randomBytes(12);
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0); salt.copy(header, 8); base.copy(header, 24);
  header.writeUInt32BE(CHUNK, 36); header.writeUInt32BE(SCRYPT_N, 40);
  const key = deriveKey(password, salt, SCRYPT_N);
  const fd = fs.openSync(outFile, 'w');
  let index = 0, pending = [], pendingLen = 0, plainBytes = 0;
  const emit = (final) => {
    const plain = Buffer.concat(pending, pendingLen);
    const c = crypto.createCipheriv('aes-256-gcm', key, nonceFor(base, index));
    c.setAAD(aad(header, index, final));
    const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const len = Buffer.alloc(4); len.writeUInt32BE(ct.length);
    fs.writeSync(fd, len); fs.writeSync(fd, ct);
    index++; pending = []; pendingLen = 0;
  };
  const push = (buf) => {
    plainBytes += buf.length;
    while (buf.length) {
      const take = Math.min(CHUNK - pendingLen, buf.length);
      pending.push(buf.subarray(0, take)); pendingLen += take; buf = buf.subarray(take);
      if (pendingLen === CHUNK) emit(false);
    }
  };
  try {
    fs.writeSync(fd, header);
    for (const e of entries) {
      const p = Buffer.from(e.rel, 'utf8');
      const size = fs.statSync(e.abs).size;
      const h = Buffer.alloc(4 + p.length + 8);
      h.writeUInt32BE(p.length, 0); p.copy(h, 4); h.writeBigUInt64BE(BigInt(size), 4 + p.length);
      push(h);
      const rfd = fs.openSync(e.abs, 'r');
      try {
        const buf = Buffer.alloc(CHUNK); let n;
        while ((n = fs.readSync(rfd, buf, 0, CHUNK, null)) > 0) push(Buffer.from(buf.subarray(0, n)));
      } finally { fs.closeSync(rfd); }
    }
    push(Buffer.alloc(4)); // terminator: pathLen 0
    emit(true);
  } finally { fs.closeSync(fd); }
  return { files: entries.length, plainBytes, bytes: fs.statSync(outFile).size };
}

function safeTarget(outDir, rel) {
  if (!rel || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).some(s => s === '..')) throw new Error(`Unsafe path in archive: ${rel}`);
  const abs = path.resolve(outDir, rel);
  if (!abs.startsWith(path.resolve(outDir) + path.sep)) throw new Error(`Unsafe path in archive: ${rel}`);
  return abs;
}

/** Decrypt inFile into outDir (must be empty/new). Throws WrongPasswordError on bad password or tampering. */
function decryptToDir(inFile, outDir, password) {
  const fd = fs.openSync(inFile, 'r');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const header = Buffer.alloc(HEADER_LEN);
    if (fs.readSync(fd, header, 0, HEADER_LEN, null) !== HEADER_LEN || !header.subarray(0, 8).equals(MAGIC)) throw new Error('Not an encrypted Agent Relay backup');
    const salt = header.subarray(8, 24), base = header.subarray(24, 36);
    const chunkSize = header.readUInt32BE(36), N = header.readUInt32BE(40);
    if (chunkSize > 64 * 1024 * 1024 || N < 1024 || N > (1 << 20)) throw new Error('Backup header is invalid');
    const key = deriveKey(password, salt, N);

    // Streaming parser state
    let buf = Buffer.alloc(0), state = 'path', need = 4, curPath = null, remaining = 0, out = null, done = false, files = 0;
    const consume = () => {
      for (;;) {
        if (done) return;
        if (state === 'data') {
          if (!buf.length && remaining) return;
          const take = Math.min(remaining, buf.length);
          if (take) { fs.writeSync(out, buf.subarray(0, take)); buf = buf.subarray(take); remaining -= take; }
          if (remaining === 0) { fs.closeSync(out); out = null; files++; state = 'path'; need = 4; continue; }
          return;
        }
        if (buf.length < need) return;
        if (state === 'path') {
          const len = buf.readUInt32BE(0);
          if (len === 0) { done = true; buf = buf.subarray(4); return; }
          if (len > 4096) throw new Error('Backup archive is corrupt');
          state = 'name'; need = 4 + len + 8; continue;
        }
        if (state === 'name') {
          const len = buf.readUInt32BE(0);
          curPath = buf.subarray(4, 4 + len).toString('utf8');
          remaining = Number(buf.readBigUInt64BE(4 + len));
          buf = buf.subarray(need);
          const target = safeTarget(outDir, curPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          out = fs.openSync(target, 'w');
          state = 'data';
          if (remaining === 0) { fs.closeSync(out); out = null; files++; state = 'path'; need = 4; }
          continue;
        }
      }
    };

    // Read chunks by position: the final chunk is the one that ends exactly at end-of-file.
    const size = fs.fstatSync(fd).size;
    const lenBuf = Buffer.alloc(4);
    let pos = HEADER_LEN, index = 0, sawFinal = false;
    try {
      while (pos < size) {
        if (fs.readSync(fd, lenBuf, 0, 4, pos) !== 4) throw new WrongPasswordError();
        const ctLen = lenBuf.readUInt32BE(0);
        if (ctLen < 16 || ctLen > chunkSize + 16 || pos + 4 + ctLen > size) throw new WrongPasswordError();
        const ct = Buffer.alloc(ctLen);
        if (fs.readSync(fd, ct, 0, ctLen, pos + 4) !== ctLen) throw new WrongPasswordError();
        pos += 4 + ctLen;
        const final = pos === size;
        const d = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(base, index));
        d.setAAD(aad(header, index, final));
        d.setAuthTag(ct.subarray(ctLen - 16));
        let plain;
        try { plain = Buffer.concat([d.update(ct.subarray(0, ctLen - 16)), d.final()]); } catch { throw new WrongPasswordError(); }
        buf = buf.length ? Buffer.concat([buf, plain]) : plain;
        consume();
        index++;
        if (final) sawFinal = true;
      }
    } finally { if (out) { try { fs.closeSync(out); } catch { /* ignore */ } } }
    if (!sawFinal || !done) throw new WrongPasswordError();
    return { files };
  } finally { fs.closeSync(fd); }
}

module.exports = { encryptFiles, decryptToDir, listFiles, WrongPasswordError };
