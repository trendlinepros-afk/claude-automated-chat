'use strict';
/**
 * Windows-only test of the one-paste setup script (run in CI under Windows PowerShell 5.1 and PowerShell 7).
 *  - merges into a config that already has other servers + non-MCP settings (and a trailing comma)
 *  - result must parse with strict JSON.parse (what Claude Desktop uses) and keep everything else
 *  - a config broken by pasting a whole snippet is left untouched and the bad lines are shown
 *  - the written entry actually connects through mcp-remote over verified HTTPS
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { VaultStore } = require('../src/store');
const { RelayServer } = require('../src/mcpServer');
const { ensureCerts } = require('../src/tls');
const { buildSetupScript } = require('../src/setupScript');

if (process.platform !== 'win32') { console.log('setup script test skipped (Windows only)'); process.exit(0); }

const shells = [['powershell.exe', 'Windows PowerShell 5.1'], ['pwsh.exe', 'PowerShell 7']];

// Must be asynchronous: the relay server under test runs in this same process.
function runPs(exe, scriptFile, env) {
  return new Promise((resolve) => {
    const e = Object.assign({}, process.env, env);
    // CI starts us from PowerShell 7, whose module path breaks Windows PowerShell 5.1; a user's window doesn't have it.
    if (exe === 'powershell.exe') { delete e.PSModulePath; delete e.PSMODULEPATH; for (const k of Object.keys(e)) if (k.toLowerCase() === 'psmodulepath') delete e[k]; }
    const child = spawn(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { env: e });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => child.kill(), 120000);
    child.on('close', code => { clearTimeout(t); resolve({ code, out }); });
  });
}

function mcpInitialize(entry) {
  // Launch the configured command exactly like Claude Desktop would and do an MCP handshake.
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, { env: Object.assign({}, process.env, entry.env || {}), shell: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('mcp-remote timed out\n' + err.slice(-2000))); }, 90000);
    child.stdout.on('data', d => {
      out += d;
      if (out.includes('"id":1') && out.includes('agent-relay')) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) + '\n');
      }
      if (out.includes('"id":2')) { clearTimeout(timer); child.kill(); resolve(out); }
    });
    child.stderr.on('data', d => { err += d; });
    setTimeout(() => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci', version: '1' } } }) + '\n'), 4000);
  });
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-setup-'));
  const certs = ensureCerts(path.join(work, 'tls'), { info() {} });
  const settings = { port: 3790, host: '0.0.0.0', tls: true, requireKey: true, accessKey: 'ci-key-0123456789' };
  const srv = new RelayServer(new VaultStore(path.join(work, 'vault'), {}).init(), () => settings, { info() {}, error: console.error }, () => ensureCerts(path.join(work, 'tls'), { info() {} }));
  await srv.start();
  assert(srv.status.running && srv.status.tls);
  const server = 'https://127.0.0.1:3790';
  const url = `${server}/mcp/CI-PC?key=${settings.accessKey}`;
  const caPath = path.join(work, 'client', 'relay-ca.pem');
  const script = buildSetupScript({ url, server, tls: true, caHash: certs.caHash, agent: 'CI-PC', caPath });

  for (const [exe, label] of shells) {
    console.log(`\n=== ${label} ===`);
    const dir = fs.mkdtempSync(path.join(work, 'run-'));
    const scriptFile = path.join(dir, 'setup.ps1');
    fs.writeFileSync(scriptFile, '\ufeff' + script);

    // 1) Existing config with other servers, other settings and a trailing comma (lenient parsers accept it).
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, '{\n  "preferences": { "theme": "dark", "list": ["only-one"] },\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users"] },\n  }\n}\n');
    const r1 = await runPs(exe, scriptFile, { AGENT_RELAY_CONFIG_PATHS: good });
    console.log(r1.out.trim());
    assert(/Relay reachable and certificate trusted/.test(r1.out), 'built-in connection test passes');
    const cfg = JSON.parse(fs.readFileSync(good, 'utf8').replace(/^\ufeff/, '')); // strict, like Claude Desktop
    assert(!fs.readFileSync(good)[0].toString(16).startsWith('ef'), 'no BOM written');
    assert.deepStrictEqual(cfg.preferences, { theme: 'dark', list: ['only-one'] }, 'other settings preserved (incl. 1-element array)');
    assert(cfg.mcpServers.filesystem && cfg.mcpServers.filesystem.args.length === 3, 'other server preserved');
    const entry = cfg.mcpServers['agent-relay'];
    assert.strictEqual(entry.command, 'npx');
    assert.deepStrictEqual(entry.args, ['-y', 'mcp-remote@latest', url, '--transport', 'http-only']);
    assert.strictEqual(entry.env.NODE_EXTRA_CA_CERTS, caPath);
    assert.strictEqual(fs.readFileSync(caPath, 'utf8'), certs.caPem, 'certificate downloaded + verified');
    assert(fs.readdirSync(dir).some(f => f.startsWith('good.json.bak-')), 'backup made');
    // Running it again is idempotent.
    await runPs(exe, scriptFile, { AGENT_RELAY_CONFIG_PATHS: good });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(good, 'utf8')).mcpServers['agent-relay'], entry);

    // 2) The exact mistake from the field: a whole { "mcpServers": ... } snippet pasted as a second object.
    const broken = path.join(dir, 'broken.json');
    const brokenText = '{\n  "preferences": {\n    "theme": "dark"\n  },\n{\n  "mcpServers": {\n    "agent-relay": { "command": "npx", "args": [] }\n  }\n}\n';
    fs.writeFileSync(broken, brokenText);
    const r2 = await runPs(exe, scriptFile, { AGENT_RELAY_CONFIG_PATHS: broken });
    console.log(r2.out.trim());
    assert.strictEqual(fs.readFileSync(broken, 'utf8'), brokenText, 'broken config left untouched');
    assert(/not valid JSON/.test(r2.out), 'explains the problem');
    assert(/\n\s+5: \{/.test(r2.out) || /Lines \d+-\d+/.test(r2.out), 'shows the offending lines');

    // 3) No config yet → created.
    const fresh = path.join(dir, 'new', 'claude_desktop_config.json');
    await runPs(exe, scriptFile, { AGENT_RELAY_CONFIG_PATHS: fresh });
    assert(JSON.parse(fs.readFileSync(fresh, 'utf8')).mcpServers['agent-relay'], 'fresh config created');

    // 4) Wrong fingerprint → stops before touching the config.
    const bad = path.join(dir, 'bad.ps1');
    fs.writeFileSync(bad, '\ufeff' + buildSetupScript({ url, server, tls: true, caHash: 'DEADBEEF', agent: 'CI-PC', caPath: path.join(dir, 'ca2.pem') }));
    const untouched = path.join(dir, 'untouched.json');
    fs.writeFileSync(untouched, '{"mcpServers":{}}');
    const r4 = await runPs(exe, bad, { AGENT_RELAY_CONFIG_PATHS: untouched });
    assert(/fingerprint does not match/.test(r4.out), 'fingerprint mismatch detected');
    assert.strictEqual(fs.readFileSync(untouched, 'utf8'), '{"mcpServers":{}}', 'config untouched on mismatch');
    assert(!fs.existsSync(path.join(dir, 'ca2.pem')), 'bad certificate removed');

    if (exe === 'powershell.exe') {
      // 5) The entry the script wrote really connects (npx mcp-remote → verified HTTPS → MCP).
      const out = await mcpInitialize(entry);
      assert(out.includes('You are \\"CI-PC\\"'), 'whoami over mcp-remote');
      console.log('Live MCP connection through the written config: OK');
    }
  }
  await srv.stop();
  console.log('\nSETUP SCRIPT TEST PASSED');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
