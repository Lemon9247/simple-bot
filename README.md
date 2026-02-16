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
