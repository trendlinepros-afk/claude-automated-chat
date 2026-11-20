'use strict';
// Run the relay without Electron (useful for testing / Linux).  node scripts/headless.js [vaultDir] [port]
const path = require('path');
const { VaultStore } = require('../src/store');
const { RelayServer } = require('../src/mcpServer');
const { Retention } = require('../src/retention');
const { Settings } = require('../src/settings');

const vault = path.resolve(process.argv[2] || './.relay-test/vault');
const settings = new Settings(path.join(path.dirname(vault), 'settings.json'), vault);
if (process.argv[3]) settings.update({ port: Number(process.argv[3]) });
const store = new VaultStore(settings.get().vaultPath, { operatorName: settings.get().operatorName }).init();
const server = new RelayServer(store, () => settings.get());
const retention = new Retention(store, () => settings.get());
server.start().then(st => {
  const s = settings.get();
  console.log(st.running ? `Agent Relay headless on port ${s.port}. MCP: http://localhost:${s.port}/mcp/<Agent>?key=${s.accessKey}` : st.error);
  retention.start();
});
process.on('SIGINT', () => { store.saveStateNow(); process.exit(0); });
module.exports = { store, server, settings };
