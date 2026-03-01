# Nest Security Model

## Authentication

All API and WebSocket routes require a **Bearer token** passed via the `Authorization` header. The token is configured in `config.yaml` under `server.token`.

WebSocket clients at `/attach` can authenticate two ways:
- **Header auth**: `Authorization: Bearer <token>` on the upgrade request (TUI/programmatic clients).
- **First-message auth**: send `{ "type": "auth", "token": "<token>" }` within 5 seconds of connecting (browser clients). Unauthenticated connections are closed after the timeout.

The `/health` endpoint is exempt from authentication — it returns `{ "status": "ok" }` for Docker healthchecks and load balancer probes.

## Rate Limiting

**Auth failures**: Per-IP rate limiting tracks failed authentication attempts. After 10 failures within 60 seconds, **all** requests from that IP receive `429 Too Many Requests` — not just auth attempts. The window expires naturally.

**Webhooks**: Per-source rate limiting (10 requests/minute per source, 30 requests/minute globally) prevents webhook abuse.

## Path Traversal Protection

All vault file operations are jailed to the configured vault root. The server resolves paths with `realpath` and rejects any path that escapes the vault directory — including `..` traversal, absolute paths, and symlinks pointing outside the vault. Violations return `403 Forbidden`.

## CORS

CORS headers are optional, configured via `server.cors.origin` in `config.yaml`. When set, all API responses include `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, and `Access-Control-Allow-Headers`. Preflight `OPTIONS` requests return `204`.

For same-origin deployments (workspace served by Nest itself), CORS is not needed and is disabled by default.

## Deployment Modes

### Container (recommended for internet-facing)

Docker + Caddy reverse proxy with automatic TLS via Let's Encrypt.

**Architecture**: Caddy terminates TLS on ports 80/443 and reverse-proxies to Nest on the internal Docker network. Nest never directly faces the internet.

**Container hardening**:
- `iptables` rules in the entrypoint block all RFC1918/link-local traffic — the agent can reach the public internet but not the LAN.
- IPv6 disabled to prevent link-local/ULA address leaks.
- `NET_ADMIN` capability dropped after iptables setup via `setpriv`.
- `--no-new-privileges` prevents privilege escalation.
- Nix available for user-space package management via a persistent `/nix` volume — the agent can install tools without modifying the base image.

**Setup**: See `docker-compose.example.yml` and `examples/caddy/Caddyfile`.

### Native (localhost / trusted network)

Run Nest directly on the host. Suitable for local development or behind an existing reverse proxy.

- Token auth protects all API routes.
- No TLS by default — bring your own reverse proxy (nginx, Caddy, etc.) for TLS termination.
- Rate limiting still applies.

## Threat Model

| Threat | Impact | Mitigation |
|--------|--------|------------|
| Stolen auth token | High — full RCE via pi | TLS (container mode), rate limiting |
| Path traversal | High — read/write outside vault | Vault path jailing, symlink rejection |
| WebSocket hijack | High — impersonate user | Token auth on WS upgrade + first-message |
| Brute-force token | Medium — gain access | Per-IP rate limiting (10 attempts/60s) |
| MITM on HTTP | High — steal token | TLS via Caddy reverse proxy |
| LAN access from agent | Medium — lateral movement | iptables blocking in container entrypoint |
