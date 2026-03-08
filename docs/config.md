# Config

Nest uses a single `config.yaml`. The kernel validates its own sections; plugin sections are passed through as-is.

```yaml
# --- Kernel Config ---

instance:
    name: "wren"
    pluginsDir: "./plugins"        # default: ./plugins

sessions:
    wren:
        pi:
            cwd: /home/wren        # agent working directory

defaultSession: wren

server:
    port: 8484
    host: "127.0.0.1"             # bind address
    token: "env:SERVER_TOKEN"      # auth token (env: prefix reads from environment)

cron:
    dir: ./cron.d
    notify: discord                # comma-separated platform names

attach:
    host: 127.0.0.1               # WebSocket host for `nest attach`

# --- Plugin Config ---
# Plugins read their own sections. The kernel doesn't validate these.

discord:
    token: "env:DISCORD_TOKEN"
    notify: "123456789"            # channel ID for cron/system notifications
    allowed_users:                 # restrict who can interact (omit = allow all)
        - "willow"
    channels:
        "123456789": "wren"        # channel ID → session name

dashboard:
    static: ./dashboard            # directory to serve static files from
```

## Environment Variables

Config values prefixed with `env:` are resolved from environment variables:

```yaml
discord:
    token: "env:DISCORD_TOKEN"     # reads process.env.DISCORD_TOKEN
```

For Docker, put secrets in `.env` next to `docker-compose.yml`.

## Plugin Config Convention

Each plugin reads `nest.config.<name>`. There's no schema validation — plugins define their own structure. Document your config in the plugin itself.

```typescript
export default function (nest: NestAPI): void {
    const config = nest.config.my_plugin as { apiKey: string } | undefined;
    if (!config?.apiKey) {
        nest.log.warn("my_plugin: missing config, skipping");
        return;
    }
    // ...
}
```
