# simple-bot: homebrew always-on agent

A thin daemon that bridges chat platforms (Discord, Matrix) to [pi](https://github.com/mariozechner/pi-coding-agent) instances via stdin/stdout JSON-RPC. Includes a web dashboard, cron scheduler, inbound webhooks, usage tracking, and multi-session support.

One agent. One account. One self.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  simple-bot daemon                                               │
│                                                                  │
│  ┌──────────┐  ┌──────────┐                    ┌──────────────┐  │
│  │ Discord  │  │ Matrix   │  listeners         │ HTTP server  │  │
│  │ listener │  │ listener │                    │  :8484       │  │
│  └────┬─────┘  └────┬─────┘                    │              │  │
│       └──────┬──────┘                          │ /api/*  REST │  │
│       ┌──────▼──────┐                          │ /attach  WS  │  │
│       │   daemon    │◄─────────────────────────│ /   dashboard│  │
│       │             │                          └──────────────┘  │
│       │  commands   │  ┌───────────┐  ┌─────────────┐           │
│       │  tracker    │  │ scheduler │  │ config      │           │
│       │  activity   │  │ (cron)    │  │ watcher     │           │
│       └──────┬──────┘  └───────────┘  └─────────────┘           │
│              │                                                   │
│       ┌──────▼──────────────┐                                    │
│       │  session manager    │                                    │
│       │                     │                                    │
│       │  ┌───────┐ ┌─────┐ │  stdin/stdout JSON-RPC             │
│       │  │ main  │ │ ... │ │  (one pi process per session)      │
│       │  └───────┘ └─────┘ │                                    │
│       └─────────────────────┘                                    │
└──────────────────────────────────────────────────────────────────┘
```

Messages arrive from listeners, get routed through the daemon to the appropriate session's pi bridge, and responses are sent back to the originating platform/channel.

## Quick Start

```bash
# Copy example files
cp Dockerfile.example Dockerfile
cp docker-compose.example.yml docker-compose.yml
cp scripts/entrypoint.example.sh scripts/entrypoint.sh
cp config.example.yaml config.yaml

# Edit config.yaml with your tokens and settings
# Create .env with at minimum:
#   DISCORD_TOKEN=...
#   CLAUDE_CODE_OAUTH_TOKEN=...

# Build and run
docker compose up -d --build
```

> **⚠️ Designed for rootless Docker.** The container uses `user: "0:0"` and `CAP_NET_ADMIN` for firewall setup — safe under rootless Docker where UID 0 maps to your unprivileged host user. **Do not run with rootful Docker** unless you understand the implications.

## Configuration

All config lives in `config.yaml`. Tokens support `"env:VAR_NAME"` syntax to read from environment variables.

```yaml
pi:
    cwd: /home/wren                      # Working directory for pi
    extensions:
        - /app/extensions/attach.ts      # Baked into Docker image

discord:
    token: "env:DISCORD_TOKEN"

security:
    allowed_users:
        - "username"                     # Only these users can talk to the bot

server:                                  # Optional — enables HTTP server + dashboard
    port: 8484
    token: "env:SERVER_TOKEN"            # Bearer token for API auth
    publicDir: /app/public               # Dashboard SPA location

cron:                                    # Optional — enables scheduled jobs
    dir: /home/wren/cron.d
    default_notify: "123456789"          # Discord channel ID or Matrix room
    gracePeriodMs: 5000                  # Skip jobs if user message within last N ms
```

### Platforms

| Platform | Config key | Required fields |
|----------|-----------|-----------------|
| Discord | `discord` | `token` |
| Matrix | `matrix` | `homeserver`, `user`, `token` |

Both can be active simultaneously. The daemon routes responses back to whichever platform the message came from.

## Bot Commands

Commands are sent as chat messages prefixed with `bot!`.

| Command | Description |
|---------|-------------|
| `bot!status` | Show uptime, model, context usage, cron status, today's cost |
| `bot!model` | List available models |
| `bot!model <name>` | Switch model (fuzzy match) |
| `bot!think` | Show current thinking level |
| `bot!think on\|off` | Enable/disable extended thinking (`on` = medium) |
| `bot!think minimal\|low\|medium\|high` | Set specific thinking level |
| `bot!new` | Start a fresh context window |
| `bot!compress [instructions]` | Compact current context |
| `bot!abort` | Stop current generation |
| `bot!reload` | Reload pi extensions |
| `bot!reboot` | Restart the pi process for this channel's session |
| `bot!reboot all` | Restart all sessions |
| `bot!reboot <name>` | Restart a specific session |
| `bot!config` | Show current config (tokens redacted) |
| `bot!config <section>` | Show a config section |
| `bot!config <section> <key> <value>` | Hot-update a config value |

## File & Attachment Support

### Inbound (User → Agent)

| Type | Handling |
|------|----------|
| Images (`image/*`) | Base64-encoded, sent to pi's vision via RPC `images` field |
| Other files | Saved to `/tmp/wren-inbox/`, path appended to prompt. Cleaned up after 1 hour |
| Files > 25MB | Skipped |

Oversized images are automatically compressed (via sharp) before sending to the API.

### Outbound (Agent → User)

The agent has an `attach` tool (pi extension at `/app/extensions/attach.ts`). Calling `attach({ path: "/path/to/file" })` queues the file to be sent as a Discord attachment with the response.

### Custom Emotes

The Discord listener caches guild emojis on connect. `:emote_name:` patterns in outgoing messages are replaced with Discord's `<:name:id>` format when a match is found.

## HTTP Server & Dashboard

Enable the `server` section in config to get an HTTP API and web dashboard.

### Dashboard

The dashboard is a dark-themed SPA at the server root (`http://host:port/`). It shows:

- **Status** — uptime, model, listener count, context gauge
- **Sessions** — per-session state, model, cost (multi-session only)
- **Usage** — today/week cost, message count, token throughput, context window usage
- **Cron** — job names, schedules, enabled status
- **Activity** — recent messages with sender, platform, response time
- **Logs** — live log stream

Auth: enter the server token in the input field, or navigate to `http://host:port/#token=xxx` (hash fragment, never sent to server).

Polling intervals: 5s for activity/sessions, 15s for status/usage/cron/logs.

### REST API

All endpoints require `Authorization: Bearer <token>` header.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/ping` | Health check → `{ pong: true }` |
| `GET` | `/api/status` | Uptime, model, context size, sessions |
| `GET` | `/api/sessions` | Per-session state, model, context, cost |
| `GET` | `/api/usage` | Token usage and cost (today/week). `?session=<name>` for per-session |
| `GET` | `/api/cron` | Cron job list with schedules and enabled status |
| `GET` | `/api/activity` | Recent message activity buffer |
| `GET` | `/api/logs` | Recent log entries |
| `GET` | `/api/config` | Current config (tokens redacted) |
| `POST` | `/api/config` | Hot-update config values. Body: `{ "<section>.<key>": value }` |
| `POST` | `/api/webhook` | Inbound webhook (see [Webhooks](#webhooks)) |

### WebSocket

Connect to `ws://host:port/attach` with Bearer auth header or `?token=xxx` query param. Receives:

- All bridge events (message_start, message_end, tool_execution_*, agent_start, agent_end, etc.)
- RPC: send `{ type: "send_message", message: "...", session: "name" }` to talk to a session

Used by the TUI client for real-time interaction.

## Webhooks

`POST /api/webhook` accepts inbound messages from external systems.

```json
{
    "message": "Deploy completed for v1.2.3",
    "source": "ci-pipeline",
    "notify": "123456789"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `message` | yes | Text to send to the agent |
| `source` | no | Label for the webhook source (shown in prompt prefix) |
| `notify` | no | Room to post the response (Discord channel ID or Matrix room) |

Rate limited: 10 requests per source per minute, 30 global per minute.

If the agent is busy, the message is queued and the response is sent when ready (`{ ok: true, queued: true }`).

## Cron Jobs

The scheduler runs jobs defined as markdown files in the configured cron directory.

### Job Format

```markdown
---
schedule: "0 7,12,17 * * *"
steps:
  - new-session
  - model: claude-haiku-4-5
  - prompt
  - compact
notify: "123456789"
enabled: true
---

The prompt body goes here. Only sent when `prompt` appears in steps.
```

### Frontmatter

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `schedule` | yes | — | Cron expression ([node-cron](https://github.com/node-cron/node-cron) format) |
| `steps` | yes | — | Ordered list of operations |
| `notify` | no | config default | Room to post response. `"none"` to suppress |
| `enabled` | no | `true` | Set `false` to disable without deleting |
| `gracePeriodMs` | no | config default | Per-job override for user interaction grace period |

### Steps

| Step | What it does |
|------|-------------|
| `new-session` | Start a fresh context window |
| `compact` | Compress the current context |
| `model: <query>` | Switch model (fuzzy match) |
| `prompt` | Send the markdown body to the agent |
| `reload` | Reload pi extensions |

Steps execute in order. If one fails, remaining steps are skipped. Jobs are skipped entirely if the agent is busy (user conversation or another job) — a grace period (`gracePeriodMs`) prevents jobs from interrupting recent user interactions.

### Directory Structure

Jobs can be organized in subdirectories. The job name is the relative path minus `.md`:

```
cron.d/
├── daily-cleanup.md              → "daily-cleanup"
├── morning/
│   ├── checklist.md              → "morning/checklist"
│   └── greeting.md               → "morning/greeting"
└── maintenance/
    └── weekly/
        └── prune.md              → "maintenance/weekly/prune"
```

### Hot Reload

The scheduler watches the cron directory recursively. Add, edit, or delete `.md` files and the scheduler picks up changes within seconds.

## Sessions

The daemon supports multiple isolated pi sessions. Each session has its own pi process, context window, and conversation history.

Sessions are configured in `config.yaml` under a `sessions` key, or run as a single default `main` session if not configured. The session manager handles lifecycle (start/stop), routing (which channel talks to which session), and idle timeouts.

Use `bot!reboot <name>` to restart a specific session, or `bot!reboot all` for everything.

## Usage Tracking

The daemon tracks per-message token usage and cost from pi's `message_end` events:

- **Input tokens**: prompt tokens (input + cache read + cache write)
- **Output tokens**: completion tokens
- **Context size**: total tokens the model saw (`totalTokens` from usage)
- **Cost**: reported directly by pi (per-model, per-message)

Data is stored in a ring buffer (in-memory) and optionally persisted to a JSONL file. The dashboard and `bot!status` command both read from this tracker.

## Config Hot-Reload

The `ConfigWatcher` monitors `config.yaml` for changes. Some settings can be updated without restarting:

- Config changes are diffed and classified as hot-reloadable or restart-required
- Hot-reloadable changes are applied immediately
- `bot!config <section> <key> <value>` writes changes atomically (tmp → validate → rename)

## Development

```bash
npm install
npx tsc              # compile
npm test             # run tests (390 tests across 22 files)
```

Tests use vitest. Node 22+ required.

## Source Layout

```
src/
├── main.ts              # Entry point — load config, wire everything, start
├── daemon.ts            # Core orchestrator — message routing, commands, usage, activity
├── bridge.ts            # Spawns and communicates with pi via stdin/stdout JSON-RPC
├── session-manager.ts   # Multi-session lifecycle (start/stop/route/idle timeout)
├── commands.ts          # bot! command definitions and dispatch
├── server.ts            # HTTP server — REST API, WebSocket, static dashboard
├── scheduler.ts         # Cron job scheduler with hot-reload file watching
├── job.ts               # Cron job parser (markdown frontmatter + body)
├── tracker.ts           # Token usage & cost tracking (ring buffer + JSONL)
├── config.ts            # Config loading, validation, diffing, merging
├── config-watcher.ts    # File watcher for config hot-reload
├── logger.ts            # Structured JSON logger with in-memory buffer
├── chunking.ts          # Discord message splitting with code block awareness
├── image.ts             # Image compression for oversized attachments
├── inbox.ts             # Temporary file storage for non-image attachments
├── types.ts             # Shared type definitions
├── listeners/
│   ├── discord.ts       # Discord.js listener
│   └── matrix.ts        # Matrix SDK listener
├── extensions/
│   └── attach.ts        # Pi extension — `attach` tool for outbound files
├── tui/                 # Terminal UI client (connects via WebSocket)
│   ├── main.ts          # TUI entry point
│   ├── client.ts        # WebSocket client + UI setup
│   ├── rpc.ts           # WebSocket RPC client
│   ├── chat.ts          # Chat display component
│   ├── commands.ts      # TUI slash commands
│   ├── footer.ts        # Status footer
│   └── theme.ts         # TUI color theme
└── public/
    └── index.html       # Dashboard SPA
```
