# Setup

## Requirements

- **Node.js 22+**
- **pi** — `npm install -g @mariozechner/pi-coding-agent`
- **Docker** (optional, for sandbox mode)

## Quick Start

```bash
git clone <repo-url> nest && cd nest
npm install
npx nest init              # interactive setup wizard
npx nest start             # start the gateway
```

The wizard creates a workspace at `~/.nest/<name>/` with:
- `config.yaml` — sessions, plugins, server, cron
- `plugins/` — seeded with discord, commands, dashboard, webhook
- `.pi/agent/` — isolated pi config (models, sessions)
- Docker files (if sandbox enabled) — `Dockerfile`, `docker-compose.yml`, `entrypoint.sh`

## Docker Sandbox

When the wizard asks about sandbox mode, say yes to get Docker isolation with nix inside the container. The agent can install arbitrary dependencies via `nix-env` and they persist across container rebuilds.

```bash
npx nest init              # enable sandbox in the wizard
npx nest start             # runs docker compose up -d --build
npx nest stop              # runs docker compose down
npx nest attach            # attach pi TUI from the host
```

The wizard generates `Dockerfile`, `docker-compose.yml`, and `entrypoint.sh` in your workspace. **These are your files** — edit them directly for custom networking, volumes, or security.

## Rootless Docker

If you're running rootless Docker (recommended for security), the container needs to run as `root` internally — rootless Docker maps container UID 0 to your host user, so this is safe. The wizard asks about this and sets `user: "0:0"` in `docker-compose.yml`.

Without rootless Docker running as root in the container is **not recommended**. Use `user: "1000:1000"` or similar instead.

## LAN Isolation

The sandbox can block access to private networks (RFC1918) via iptables, preventing the agent from reaching LAN services. The wizard prompts for:

- **Enable LAN isolation** — blocks 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
- **Allowed addresses** — whitelist specific LAN services (e.g. a local SearXNG instance)

This requires `NET_ADMIN` capability (added to `docker-compose.yml`). The entrypoint drops `NET_ADMIN` after applying rules so the agent process can't undo them.

You can also set `NEST_LAN_ALLOW=addr1,addr2` as an environment variable for dynamic allowlisting, or `NEST_NO_FIREWALL=1` to skip all rules.

## Bare Metal

For deployments without Docker:

```bash
npm install
npx nest init              # skip sandbox in the wizard
npx nest start             # runs the kernel directly
```

Or with systemd:

```bash
cp systemd/nest.service ~/.config/systemd/user/
systemctl --user enable --now nest
```
