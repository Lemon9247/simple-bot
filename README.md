# simple-bot: homebrew always-on agent

A thin daemon that bridges Matrix, Discord etc to a single pi instance via RPC.

One agent. One account. One self.

## Why did you build this

Building your own agents is fun

## Architecture

```
┌────────────────────────────────────────┐
│  simple-bot daemon (systemd)           │
│                                        │
│  ┌──────────┐  ┌──────────┐            │
│  │ Matrix   │  │ Discord  │  listeners │
│  │ listener │  │ listener │            │
│  └────┬─────┘  └────┬─────┘            │
│       └──────┬──────┘                  │
│       ┌──────▼──────┐                  │
│       │   bridge    │  track origin    │
│       └──────┬──────┘                  │
│              │ stdin/stdout (JSON-RPC) │
│       ┌──────▼──────┐                  │
│       │  pi (one)   │                  │
│       └─────────────┘                  │
└────────────────────────────────────────┘
```

Matrix message → `follow_up` → pi responds → daemon posts to originating room.

The agent doesn't know it's talking to Matrix. It just receives prompts and does work.

## File & Attachment Support

### Inbound (Discord → Agent)

Users can attach files to Discord messages. The daemon:
- **Images** (`image/*`): base64-encoded and sent to pi's vision via the RPC `images` field
- **Other files** (audio, documents, etc.): saved to `/tmp/wren-inbox/` and the path is appended to the prompt. Cleaned up after 1 hour.
- Attachments over 25MB are skipped.

### Outbound (Agent → Discord)

The agent has an `attach` tool (registered by a pi extension baked into the Docker image at `/app/extensions/attach.ts`). Calling `attach({ path: "/path/to/file" })` queues the file to be sent as a Discord attachment with the response.

### Custom Emotes

The Discord listener builds an emoji cache from all guilds on connect. In outgoing messages, `:emote_name:` patterns are replaced with Discord's `<:name:id>` format if the name matches a guild emoji. Standard emoji names are left alone.

## Deployment

Copy the example files and edit to taste:

```bash
cp Dockerfile.example Dockerfile
cp docker-compose.example.yml docker-compose.yml
cp scripts/entrypoint.example.sh scripts/entrypoint.sh
cp config.example.yaml config.yaml
```

> **⚠️ This is designed for rootless Docker.** The container runs as `user: "0:0"` and uses `CAP_NET_ADMIN` for firewall setup — this is safe under rootless Docker because UID 0 inside the container maps to your unprivileged host user. **Do not run this with rootful Docker** unless you understand the implications: the container would have real root privileges on the host.

## Cron Jobs

The daemon includes a cron scheduler that runs jobs defined as markdown files. The agent can create, edit, and delete its own jobs at runtime.

### Config

```yaml
cron:
    dir: /home/wren/cron.d        # directory of job files
    default_notify: "123456789"   # room to post responses (Discord channel ID or Matrix room)
```

### Job files

Each `.md` file in the cron directory (or any subdirectory) is a job. The job name is derived from the relative path minus the `.md` extension. Subdirectories let you organize jobs by category:

```
cron.d/
├── daily-cleanup.md          → job name: "daily-cleanup"
├── morning/
│   ├── checklist.md          → job name: "morning/checklist"
│   └── greeting.md           → job name: "morning/greeting"
└── maintenance/
    └── weekly/
        └── prune.md          → job name: "maintenance/weekly/prune"
```

Files in the root directory keep their simple name (backward compatible).

```markdown
---
schedule: "0 7,12,17 * * *"
steps:
  - new-session
  - model: claude-haiku-4-5
  - prompt
  - compact
---

The prompt body goes here. Only sent when `prompt` appears in steps.
```

#### Frontmatter fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `schedule` | yes | — | Cron expression ([node-cron](https://github.com/node-cron/node-cron) format) |
| `steps` | yes | — | Ordered list of operations |
| `notify` | no | config default | Room to post response. `none` to suppress |
| `enabled` | no | `true` | Set `false` to disable without deleting |

#### Steps

| Step | What it does |
|------|-------------|
| `new-session` | Start a fresh context window |
| `compact` | Compress the current context |
| `model: <query>` | Switch model (fuzzy match against available models) |
| `prompt` | Send the markdown body to the agent |
| `reload` | Reload pi extensions |

Steps execute in order. If one fails, remaining steps are skipped. Jobs are skipped entirely if the agent is already busy (user conversation or another job).

### Hot reload

The scheduler watches the cron directory recursively for changes. Add, edit, or delete a `.md` file in any subdirectory and the scheduler picks it up within seconds — no restart needed.

### Notify resolution

1. Job has `notify: none` → silent
2. Job has `notify: "<room>"` → post to that room
3. Job has no `notify` → use `cron.default_notify` from config
4. Config has no `default_notify` → silent

### Examples

See [`examples/cron.d/`](examples/cron.d/) for sample job files.
