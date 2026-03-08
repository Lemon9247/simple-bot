# Nest

Minimal agent gateway. Sessions, plugins, cron, HTTP.

Nest manages pi sessions, loads plugins, runs cron jobs, handles config, and serves HTTP. Everything else — listeners, commands, dashboards, middleware — is a plugin.

## Quick Start

```bash
npm install
npx nest init          # setup wizard
npx nest start         # start the gateway
npx nest attach        # connect TUI
```

## Architecture

```
┌─────────────────────────────────────────────┐
│                 NEST KERNEL                  │
│                                              │
│  Bridge (pi RPC)    Session Manager          │
│  Plugin Loader      Scheduler (cron)         │
│  HTTP Server        Usage Tracker            │
└──────────────────────┬──────────────────────┘
                       │ NestAPI
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
   discord/         cli/          dashboard/
   commands/        webhook/      your-plugin/
```

Plugins are subdirectories with `nest.ts` (server-side) and/or `pi.ts` (agent-side tools). Each plugin owns its own npm dependencies.

```
plugins/
  discord/          # Discord bot + interactive tools
    nest.ts         # Listener, message routing
    pi.ts           # discord_confirm, discord_select
    package.json    # discord.js
  cli/              # WebSocket listener for TUI
    nest.ts
    package.json    # ws
  core/pi.ts        # Agent tools: nest_command, attach
  commands/nest.ts  # Bot commands
  dashboard/nest.ts # Web dashboard + API
  webhook/nest.ts   # HTTP webhook
```

## File Structure

```
nest/
├── src/                   # Kernel
│   ├── cli.ts             # CLI: init/start/attach/status
│   ├── kernel.ts          # Core orchestration
│   ├── bridge.ts          # RPC pipe to pi
│   ├── session-manager.ts # Sessions + broadcast routing
│   ├── plugin-loader.ts   # jiti-based plugin scanner
│   ├── server.ts          # HTTP + WebSocket
│   ├── types.ts           # All interfaces
│   └── ...
├── plugins/               # Stock plugins (copied to workspace by init)
└── docs/                  # Detailed documentation
```

## Docs

- **[Setup](docs/setup.md)** — requirements, quick start, Docker sandbox, bare metal
- **[Architecture](docs/architecture.md)** — sessions, message routing, broadcast, cron
- **[Plugins](docs/plugins.md)** — plugin structure, NestAPI reference, interfaces, examples
- **[Blocks](docs/blocks.md)** — block protocol, interactive prompts, WebSocket protocol
- **[CLI](docs/cli.md)** — commands, workspaces, attach, sandbox
- **[Config](docs/config.md)** — config reference, env vars, plugin config convention
