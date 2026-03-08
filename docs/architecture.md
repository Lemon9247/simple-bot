# Architecture

Nest does five things: manages pi sessions, loads plugins, runs cron jobs, handles config, and serves HTTP. Everything else — listeners, commands, dashboards, middleware — is a plugin.

```
┌──────────────────────────────────────────────┐
│                 NEST KERNEL                  │
│                                              │
│  Bridge (pi RPC)    Session Manager          │
│  Plugin Loader      Scheduler (cron)         │
│  HTTP Server        Usage Tracker            │
│  Config (YAML)      Core Commands            │
└──────────────────────┬───────────────────────┘
                       │ NestAPI
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
   discord/         cli/          dashboard/
   commands/        webhook/      your-plugin/
```

## Sessions

Sessions are the central concept. Everything else attaches to them.

- **Sessions are independent pi processes** with their own conversation history
- **Listeners attach to sessions** — Discord, CLI, webhook are all views into a session
- **Multiple listeners on one session** — CLI and Discord both see the same conversation
- **Cron jobs target sessions** — output routes to listeners named in `cron.notify`

```
Session "wren"
  ├── pi process
  ├── Discord #general (attached)
  ├── CLI terminal (attached)
  └── Cron: morning (targets)

Session "background"
  ├── pi process
  └── Cron: dream (targets)
```

## Message Flow

```
Platform → Listener → Middleware → Kernel → Bridge → pi
                                                      │
pi response ← Bridge ← Kernel → broadcast to all listeners
```

1. User sends a message on a platform (Discord, CLI, webhook)
2. The listener plugin converts it to an `IncomingMessage`
3. Middleware can transform or block the message
4. The kernel sends it to the pi session via the bridge
5. pi streams back deltas, tool calls, and a final response
6. The kernel broadcasts each event to all listeners on the session

## Broadcast Kinds

Each broadcast carries a `kind` tag:

| Kind | Meaning |
|------|---------|
| `"stream"` | Streaming text delta (partial response) |
| `"tool"` | Tool call summary |
| `"text"` | Final complete response |

Listeners opt into streaming with `streaming = true`. Non-streaming listeners (like Discord) only receive `"text"` and `"tool"` events.

## Wildcard Channels

Listeners can attach with `channel: "*"` (wildcard). On broadcast:

- **Same platform** — resolves to the actual channel the message came from
- **Different platform** — skipped
- **No origin** (cron, webhook) — skipped; use `notifyOrigin()` instead

## Cron

Cron output doesn't go through normal broadcast. Each job specifies a `notify` field — a list of platform names. The kernel calls `notifyOrigin()` on each named listener to get the target channel.

```yaml
cron:
    dir: ./cron.d
    notify: discord

# Per-job override in cron.d/morning.md frontmatter:
# notify: discord, matrix
```
