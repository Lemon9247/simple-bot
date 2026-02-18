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

## Deployment

Copy the example files and edit to taste:

```bash
cp Dockerfile.example Dockerfile
cp docker-compose.example.yml docker-compose.yml
cp scripts/entrypoint.example.sh scripts/entrypoint.sh
cp config.example.yaml config.yaml
```

> **⚠️ This is designed for rootless Docker.** The container runs as `user: "0:0"` and uses `CAP_NET_ADMIN` for firewall setup — this is safe under rootless Docker because UID 0 inside the container maps to your unprivileged host user. **Do not run this with rootful Docker** unless you understand the implications: the container would have real root privileges on the host.
