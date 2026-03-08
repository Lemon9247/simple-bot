# CLI

```bash
nest init [name]             # create workspace (setup wizard)
nest start                   # start gateway
nest stop                    # stop sandboxed workspace
nest build                   # rebuild sandbox image
nest rebuild                 # stop + build + start
nest attach                  # attach TUI to running session
nest status                  # show workspace info
nest list                    # list known workspaces

# Options
nest -w wren start           # named workspace
nest -w wren attach          # attach to default session
nest -w wren -s bg attach    # attach to specific session
```

## Workspaces

A workspace is a self-contained directory. Default: `~/.nest/<name>/`.

```
~/.nest/wren/
├── config.yaml
├── plugins/
├── cron.d/
├── .usage.jsonl
└── .pi/agent/          ← isolated from ~/.pi/agent/
    ├── models.json
    ├── sessions/
    └── settings.json
```

`nest init` walks through:

1. **Instance name** — workspace path
2. **Agent working directory** — pi's cwd
3. **Model provider** — Anthropic, OpenAI, Google, etc.
4. **Session** — name and config
5. **Chat platforms** — Discord with token + channel mapping
6. **HTTP server** — port and auth token
7. **Cron** — scheduler directory

Workspaces are registered in `~/.nest/workspaces.json`.

## Pi Isolation

Each workspace has its own `.pi/agent/` for models, sessions, and settings — it **never touches `~/.pi/agent/`**. You can run pi standalone alongside nest without config conflicts.

## Sandbox

Sandbox mode uses Docker. `nest init` generates `Dockerfile`, `docker-compose.yml`, and `entrypoint.sh` — real Docker files you own and edit.

Detection: if `docker-compose.yml` exists, `nest start/stop/build` delegate to `docker compose`.

Features:
- **Nix** — agent can `nix-env -iA nixpkgs.foo`
- **Persistent nix store** — named volume survives rebuilds
- **LAN isolation** — iptables rules, configurable via `NEST_LAN_ALLOW`
- **Rootless Docker** — container root maps to host user

## Attach

`nest attach` connects a TUI to the running gateway via WebSocket. The CLI plugin handles the connection — the TUI is another listener, like Discord. Multiple clients can connect simultaneously.

```bash
nest -w wren attach              # default session
nest -w wren -s background attach
```

For Docker, set `attach.host` in config to the container's reachable address.
