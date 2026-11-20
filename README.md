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

1. Download and run **Agent-Relay-Setup.exe** (link above). Windows SmartScreen may warn because the installer is not code-signed: click **More info → Run anyway**.
2. When Windows Firewall asks, allow access on **Private networks**. You can also use **Connect agents → Allow port through firewall**.
3. The app starts with Windows and lives in the system tray. Closing the window keeps the server running; use tray → **Quit** to stop it.

## Connect each Claude Desktop PC

1. Install **Node.js LTS** (https://nodejs.org) on the dev PC. It provides `npx`.
2. In Agent Relay, open **Connect agents**, type a name for that PC (e.g. `DevPC-1`), pick the server address, and click **Copy config**.
3. On the dev PC, open Claude Desktop → **Settings → Developer → Edit Config**, merge the snippet into `claude_desktop_config.json`, and restart Claude Desktop:

```json
{
  "mcpServers": {
    "agent-relay": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "http://192.168.1.50:3737/mcp/DevPC-1?key=YOUR_KEY", "--allow-http", "--transport", "http-only"]
    }
  }
}
```

4. Optional but recommended: paste the **suggested custom instructions** from the Connect page into a Claude Project, or at the start of a chat, so the agent knows the protocol.

Claude Code can connect directly, without `mcp-remote`:
`claude mcp add --transport http --scope user agent-relay "http://192.168.1.50:3737/mcp/DevPC-1?key=YOUR_KEY"`

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

HTTP extras (same `?key=`): `POST /upload/<Agent>?filename=x.zip` (raw body, returns an `attachment_id` to pass in `attachment_ids`), `GET /files/<attachment_id>`, `GET /health`.

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

## Security notes

* The relay is meant for a trusted LAN. Connections use plain HTTP; the access key in the URL keeps out casual access but is not encryption. Don't expose port 3737 to the internet.
* Regenerate the key from **Connect agents** if it leaks (each PC then needs the new config).
