'use strict';
/**
 * Local certificate authority for encrypting relay traffic (HTTPS).
 *
 *  - A CA certificate is created once (10 years) and stays stable. Each dev PC trusts it once
 *    via NODE_EXTRA_CA_CERTS, so agents verify they are talking to *this* relay.
 *  - A server certificate signed by the CA covers localhost, the hostname and every current LAN IP.
 *    It is re-issued automatically when the IPs change or it nears expiry — no re-trust needed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

function lanNames() {
  const ips = new Set(['127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.add(a.address);
  }
  const host = os.hostname();
  const dns = new Set(['localhost', host, `${host}.local`].filter(Boolean).map(s => s.toLowerCase()));
  return { ips: [...ips].sort(), dns: [...dns].sort() };
}

function rsaPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privPem: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    pub: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' })),
    priv: forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }))
  };
}

function serial() { return '01' + crypto.randomBytes(15).toString('hex'); }

function writeSecret(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function createCA() {
  const k = rsaPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = k.pub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400000);
  const attrs = [{ name: 'commonName', value: `Agent Relay CA (${os.hostname()})` }, { name: 'organizationName', value: 'Agent Relay' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' }
  ]);
  cert.sign(k.priv, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: k.privPem };
}

function createServerCert(caCertPem, caKeyPem, names) {
  const ca = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const k = rsaPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = k.pub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 825 * 86400000);
  cert.setSubject([{ name: 'commonName', value: os.hostname() || 'agent-relay' }]);
  cert.setIssuer(ca.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [...names.dns.map(value => ({ type: 2, value })), ...names.ips.map(ip => ({ type: 7, ip }))] },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.generateSubjectKeyIdentifier().getBytes() }
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: k.privPem };
}

/** SHA-256 of the CA file exactly as saved on disk (matches PowerShell's Get-FileHash). */
function fileHash(pem) { return crypto.createHash('sha256').update(pem).digest('hex').toUpperCase(); }

/**
 * Make sure CA + server certificate exist and cover the current addresses.
 * @returns {{ caPem, cert, key, caFile, caHash, names, reissued }}
 */
function ensureCerts(dir, log = console) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  let reissued = false;
  if (!fs.existsSync(f('ca.pem')) || !fs.existsSync(f('ca.key'))) {
    const ca = createCA();
    writeSecret(f('ca.key'), ca.keyPem);
    fs.writeFileSync(f('ca.pem'), ca.certPem);
    for (const n of ['server.pem', 'server.key', 'server.json']) { try { fs.unlinkSync(f(n)); } catch { /* none */ } }
    log.info && log.info('[tls] created a new certificate authority');
  }
  const caPem = fs.readFileSync(f('ca.pem'), 'utf8');
  const caKey = fs.readFileSync(f('ca.key'), 'utf8');
  const names = lanNames();
  const want = JSON.stringify(names);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(f('server.json'), 'utf8')); } catch { /* none */ }
  const expiring = !meta || Date.now() > (meta.notAfter || 0) - 30 * 86400000;
  if (!meta || meta.names !== want || expiring || !fs.existsSync(f('server.pem')) || !fs.existsSync(f('server.key'))) {
    const s = createServerCert(caPem, caKey, names);
    writeSecret(f('server.key'), s.keyPem);
    fs.writeFileSync(f('server.pem'), s.certPem);
    fs.writeFileSync(f('server.json'), JSON.stringify({ names: want, notAfter: Date.now() + 825 * 86400000 }));
    reissued = true;
    log.info && log.info(`[tls] issued server certificate for ${[...names.dns, ...names.ips].join(', ')}`);
  }
  return { caPem, cert: fs.readFileSync(f('server.pem'), 'utf8'), key: fs.readFileSync(f('server.key'), 'utf8'), caFile: f('ca.pem'), caHash: fileHash(caPem), names, reissued };
}

module.exports = { ensureCerts, fileHash, lanNames };
