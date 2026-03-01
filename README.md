# Nest

A self-hosted agent server with a shared workspace.

Your AI agent lives in a markdown vault you can browse, edit, and draw in — from any device with a browser. Deploy once, access from anywhere.

## Architecture

```
┌────────────────────────────────────────┐
│  nest daemon (systemd)                 │
│                                        │
│  ┌──────────┐  ┌──────────┐            │
│  │ Matrix   │  │ Discord  │  listeners │
│  │ listener │  │ listener │            │
│  └────┬─────┘  └────┬─────┘            │
│       └──────┬───────┘                 │
│       ┌──────▼──────┐                  │
│       │   bridge    │  track origin    │
│       └──────┬──────┘                  │
│              │ stdin/stdout (JSON-RPC)  │
│       ┌──────▼──────┐                  │
│       │  pi (one)   │←──→ vault/       │
│       └─────────────┘                  │
│                                        │
│  HTTP server                           │
│  ├── /              → web workspace    │
│  ├── /api/chat      → WebSocket        │
│  ├── /api/files/*   → vault CRUD       │
│  └── /api/git/*     → git operations   │
└────────────────────────────────────────┘
```

## Quick Start

```bash
npm install
cp config.example.yaml config.yaml
# Edit config.yaml with your settings
npm run dev
```

## Configuration

Copy `config.example.yaml` and edit:

- `pi.cwd` — working directory for the pi agent
- `security.allowed_users` — who can talk to the agent
- `server.port` / `server.token` — HTTP server settings
- `discord.token` / `matrix.*` — optional chat listeners

## Development

```bash
npm run dev          # start with tsx
npm test             # run tests
npm run build        # compile TypeScript
```

## Deployment

### Native (systemd)

```bash
./scripts/install.sh
systemctl --user start nest
```

### Docker

```bash
cp docker-compose.example.yml docker-compose.yml
# Edit docker-compose.yml
docker compose up -d
```

## License

MIT
