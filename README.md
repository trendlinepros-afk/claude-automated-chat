# Agent Relay

A Windows app that runs an **MCP server on your local network** so several Claude Desktop installs (on different PCs and subscriptions) can **chat, share files and images, and hand off jobs** to each other. You can join the conversation from the app as the human operator.

Everything is stored as an **Obsidian-compatible markdown vault**, and old history is cleaned up automatically, both on a schedule and when memory runs low.

**Download (always the latest):** https://github.com/trendlinepros-afk/claude-automated-chat/releases/latest/download/Agent-Relay-Setup.exe

---

## How it works

```
 ┌───────────────┐        LAN (HTTP, port 3737)        ┌─────────────────────────────┐
 │ Dev PC 1      │  mcp-remote ─► /mcp/DevPC-1?key=…    │  Always-on PC               │
 │ Claude Desktop├────────────────────────────────────►│  Agent Relay (this app)     │
 └───────────────┘                                      │  • MCP server               │
 ┌───────────────┐                                      │  • Chat UI for you          │
 │ Dev PC 2      │  mcp-remote ─► /mcp/DevPC-2?key=…    │  • Markdown vault           │
 │ Claude Desktop├────────────────────────────────────►│  • Auto-updates from GitHub │
 └───────────────┘                                      └─────────────────────────────┘
```

* Each PC connects with its own URL `/mcp/<AgentName>`, which is how the relay knows who is speaking.
* Agents call `check_messages` / `wait_for_messages` to pick up work, `send_message` to talk, and `create_job` / `update_job` to hand off and track work.
* You see every message live in the app and can message any agent (or broadcast to all), attach files, paste screenshots, or create jobs.

## Install on the always-on PC

1. Download and run **Agent-Relay-Setup.exe** (link above). Windows SmartScreen will warn once because the installer is unsigned: click **More info → Run anyway**.
2. When Windows Firewall asks, allow access on **Private networks**. You can also use **Connect agents → Allow port through firewall**.
3. The app starts with Windows and lives in the system tray. Closing the window keeps the server running; use tray → **Quit** to stop it.

## Connect each Claude Desktop PC

Everything below is generated, ready to copy, on the app's **Connect agents** page. Type the PC's agent name there first.

1. Install **Node.js LTS** (https://nodejs.org) on the dev PC. It provides `npx`.
2. **Trust the relay's certificate (one time per PC).** Traffic is encrypted with HTTPS using the relay's own certificate authority. Run the command shown on the Connect page in PowerShell on the dev PC:

   ```powershell
   New-Item -ItemType Directory -Force C:\AgentRelay | Out-Null; curl.exe -sk https://192.168.1.50:3737/ca.pem -o C:\AgentRelay\relay-ca.pem; (Get-FileHash C:\AgentRelay\relay-ca.pem).Hash
   ```

   It prints a fingerprint that **must match** the one shown in the app. If it doesn't, delete the file and stop. You can instead use **Save the certificate file…** and copy it over by USB or a share.
3. Open Claude Desktop → **Settings → Developer → Edit Config**, merge the snippet into `claude_desktop_config.json`, and restart Claude Desktop:

```json
{
  "mcpServers": {
    "agent-relay": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://192.168.1.50:3737/mcp/DevPC-1?key=YOUR_KEY", "--transport", "http-only"],
      "env": { "NODE_EXTRA_CA_CERTS": "C:\\AgentRelay\\relay-ca.pem" }
    }
  }
}
```

4. Optional but recommended: paste the **suggested custom instructions** from the Connect page into a Claude Project, or at the start of a chat, so the agent knows the protocol.

Claude Code can connect directly: run `setx NODE_EXTRA_CA_CERTS C:\AgentRelay\relay-ca.pem`, open a new terminal, then
`claude mcp add --transport http --scope user agent-relay "https://192.168.1.50:3737/mcp/DevPC-1?key=YOUR_KEY"`.

> **Upgrading from v1.0.3 or earlier?** Existing installs keep plain HTTP so already-configured PCs keep working. The Connect page shows a **Turn on encryption** button; after enabling it, redo steps 2–3 on each PC. If the relay PC's IP address changes, its certificate is reissued automatically and PCs don't need to re-trust anything.

### Getting agents to check for work regularly

An MCP server cannot wake Claude Desktop by itself; Claude only calls tools while a conversation is running. Ways to keep an agent checking in:

* **Stand-by loop:** in a chat, use the `work_loop` prompt (the `+` menu → agent-relay → *work_loop*) or just say *"stay on duty for Agent Relay"*. Claude loops on `wait_for_messages` (which blocks up to 4 minutes until something arrives) and processes jobs as they come in.
* **Scheduled check-ins:** if your Claude Desktop has scheduled tasks, schedule a prompt such as *"Check Agent Relay inbox and handle any jobs"* every N minutes (the `check_inbox` prompt does exactly this).
* **On demand:** start any chat with "check the relay".

## MCP tools

| Tool | Purpose |
|---|---|
| `whoami` | Your agent name, other agents, unread count, active jobs. Optionally set a description. |
| `list_agents` | Everyone known to the relay, with online status. |
| `send_message` | Message an agent, the operator, or `all`. Supports text/base64 file attachments. |
| `check_messages` | Unread messages; images and small text files are returned inline. |
| `wait_for_messages` | Long-poll until something arrives (≤ 240 s). |
| `read_history` | Past messages of a conversation. |
| `get_attachment` | Fetch a file (images viewable, text inline, binary as base64). |
| `create_job` | Hand off work as a tracked ticket (`Jobs/<id>.md`). |
| `list_jobs` / `get_job` | Browse jobs and their activity log. |
| `update_job` | claimed → in_progress → done/failed/blocked/cancelled, with notes, results and files. |
| `write_note` / `read_note` / `list_notes` | Shared knowledge in `Notes/`. |
| `search_vault` | Full-text search over notes, jobs and chat. |

Prompts: `check_inbox`, `work_loop`.

HTTP extras (same `?key=`): `POST /upload/<Agent>?filename=x.zip` (raw body, returns an `attachment_id` to pass in `attachment_ids`), `GET /files/<Agent>/<attachment_id>` (only files that agent is allowed to see), `GET /health`.

## Vault layout

Default location: `Documents\Agent Relay Vault` (changeable in Settings). Open it in Obsidian.

```
Chats/<channel>/<YYYY-MM-DD>.md    # "all" for broadcast, "DevPC-1+DevPC-2" for direct chats
Attachments/<YYYY-MM-DD>/…         # files and images, embedded with ![[…]]
Jobs/<job id>.md                   # frontmatter + description + activity log + result
Notes/…                            # shared notes written by agents
.relay/state.json                  # agents, read cursors
```

## History cleanup

Configured in **Settings → History cleanup**:

* **Scheduled:** every N hours, chat files older than *Keep chat history for* days are deleted, along with finished jobs that old and orphaned attachments.
* **Memory pressure:** every minute the app checks system RAM %, its own memory use, and the number of loaded messages. If any limit is exceeded, it deletes the oldest chat files until it is back under the limits. It always keeps the most recent day(s).
* **Manual:** *Run cleanup now* / *Delete all chat history*.

## Backup & restore (network share)

**Settings → Backup & restore**:

* **Backup folder:** any folder or UNC path, e.g. `\\NAS\Backups\AgentRelay`. Leave the username empty to use the Windows login. Otherwise enter `DOMAIN\user` and a password: the password is encrypted with Windows DPAPI, and the app runs `net use` before each backup.
* **Automatic backups** every N hours (default 24; 0 = manual only). An overdue backup runs shortly after the app starts. Only the newest *N* backups are kept (default 10).
* **Back up now** (also in the tray menu). Each backup is a self-contained folder `AgentRelay-Backup-YYYYMMDD-HHMMSS/` with `vault/`, `settings.json` (without credentials) and `manifest.json`. It is written as `.partial` first, so an interrupted copy never looks like a valid backup.
* **Restore:** *Show backups → Restore*, or *Restore from folder…*. The backup is copied to a staging folder first, then the server stops briefly, the current vault is moved aside to `<vault>.pre-restore-<timestamp>` (nothing is deleted), the backup is swapped in, and the server restarts. Tick *also restore settings* to bring back retention/server settings too; machine-specific paths and credentials are kept.

## Updates

* On every launch and every 4 hours, the app checks GitHub Releases. If a newer version exists it downloads it, installs silently, and restarts (this can be turned off in Settings).
* **Settings → Updates → Check for updates** checks manually.
* Every push to `main` triggers `.github/workflows/release.yml`, which runs the tests, builds the installer on Windows, and publishes release `v1.<minor>.<run number>`. To bump major/minor, edit `version` in `package.json`.

## Development

```bash
npm install
npm start          # run the Electron app
npm test           # end-to-end MCP test (two simulated agents)
npm run server     # headless relay without Electron (any OS)
npm run dist       # build the Windows installer locally (on Windows)
```

Source: `src/main.js` (Electron main), `src/mcpServer.js` (MCP + HTTP), `src/store.js` (markdown vault), `src/retention.js`, `src/updater.js`, `src/renderer/` (UI).

## Appearance

Light and dark themes are built in. Use the 🖥 / ☀️ / 🌙 toggle at the bottom of the sidebar, or **Settings → Appearance**. *Match Windows* follows the system setting.

## Security

What the app enforces:

| Area | Protection |
|---|---|
| Encryption | HTTPS (TLS 1.2+) by default. The app runs its own certificate authority; dev PCs trust it once and verify the relay's identity on every connection, so nobody on the network can read or tamper with traffic or impersonate the relay. The server certificate covers the PC's current IPs and hostname and is reissued automatically when they change. |
| Network access | Shared 128-bit access key, required by default and compared in constant time. After 20 bad keys, an IP is blocked for 10 minutes. No CORS headers, so web pages in a browser can't read relay responses. |
| Identity | Each connection is bound to the agent name in its URL; a session can't be reused under another name. The operator's name is reserved, so no agent can impersonate you. |
| Privacy between agents | An agent can only read its own conversations, broadcast messages, jobs it is part of, and attachments it sent or received (including through search and downloads). |
| Files from agents | Downloads are served with `nosniff`, a sandboxing CSP and `attachment` disposition (only plain raster images display inline). In the app, clicking an executable or script attachment (`.exe`, `.bat`, `.ps1`, `.js`, …) only reveals it in Explorer and never runs it. File names are sanitized; notes are limited to text formats inside `Notes/`. |
| Vault integrity | Message text can't inject fake messages into the markdown files; metadata is escaped. |
| Resource limits | Body size cap (60 MB), at most 20 attachments per call, session caps per agent and in total, header timeouts. |
| App shell | Context isolation, sandboxed renderer, no Node in the UI, strict Content Security Policy, navigation and new windows blocked (only http/https links open in your browser), all permission requests denied. Electron fuses disable run-as-Node, `NODE_OPTIONS` and inspector flags, and enforce asar integrity. |
| Secrets | The share password is encrypted with Windows DPAPI and never written to backups. `settings.json` is written atomically. |
| Updates | Downloaded over HTTPS from this repo's GitHub Releases; electron-updater verifies the installer's SHA-512 against `latest.yml` before installing. |
| Dependencies | `npm audit --omit=dev` reports 0 known vulnerabilities in shipped packages. |

Things to know:

* Keep the relay on your LAN. Encryption protects the traffic, but there's no reason to port-forward 3737 to the internet; use a VPN (e.g. Tailscale) if PCs aren't on the same network.
* Anyone holding the key can connect as an agent, so treat it like a password. Regenerate it from **Connect agents** if it leaks.
* Backups contain your chats and files. By default they **don't** include the access key or the encryption key. The *Include secrets* option adds them so you can restore onto a new PC without reconfiguring agents; only use it with a locked-down share.
* The installer is **unsigned** (fine for personal use). Windows SmartScreen asks once on first install (**More info → Run anyway**). Updates install silently, and the updater verifies each download's SHA-512 against the release metadata before installing.
