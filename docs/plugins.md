# Plugins

Each plugin is a subdirectory inside `plugins/` with up to two files:

- **`nest.ts`** — server-side: registers listeners, commands, middleware, routes
- **`pi.ts`** — agent-side: registers tools for the pi agent (auto-discovered)
- **`package.json`** — (optional) npm dependencies for the plugin

```
plugins/
  discord/
    nest.ts        # Discord bot, listener
    pi.ts          # discord_confirm, discord_select tools
    package.json   # discord.js
  cli/
    nest.ts        # WebSocket listener for TUI
    package.json   # ws
  core/
    pi.ts          # nest_command, attach tools
  commands/
    nest.ts        # Bot commands
  dashboard/
    nest.ts        # Web dashboard routes
  webhook/
    nest.ts        # HTTP webhook endpoint
```

## Loading

The plugin loader scans `plugins/` at startup using [jiti](https://github.com/unjs/jiti). Each subdirectory's `nest.ts` is loaded alphabetically. `pi.ts` files are auto-discovered by the session manager and passed to pi as extensions.

Plugins are TypeScript — no compilation step. Each plugin manages its own npm dependencies via its own `package.json` and `node_modules/`.

Type imports use `import type { ... } from "nest"` (resolved via jiti alias, erased at runtime). All runtime functionality comes through the `NestAPI` object.

## Hot Reload

- **`bot!reload`** — hot-reloads all `nest.ts` plugins (disconnects listeners, reimports, reconnects)
- **`bot!reboot`** — restarts the pi session (picks up new/changed `pi.ts` extensions)

## NestAPI Reference

The full API object passed to every `nest.ts` plugin:

```typescript
interface NestAPI {
    // --- Registration ---
    registerListener(listener: Listener): void;
    registerMiddleware(middleware: Middleware): void;
    registerCommand(name: string, command: Command): void;
    registerRoute(method: string, path: string, handler: RouteHandler): void;
    registerPrefixRoute(method: string, prefix: string, handler: RouteHandler): void;
    registerUpgrade(path: string, handler: (req, socket, head) => void): void;
    on(event: string, handler: (...args: any[]) => void): void;

    // --- Sessions ---
    sessions: {
        get(name: string): Bridge | null;
        getOrStart(name: string): Promise<Bridge>;
        stop(name: string): Promise<void>;
        list(): string[];
        getDefault(): string;
        recordActivity(name: string): void;
        attach(session: string, listener: Listener, origin: MessageOrigin): void;
        detach(session: string, listener: Listener): void;
        getListeners(session: string): Array<{ listener: Listener; origin: MessageOrigin }>;
        sendMessage(session: string, text: string): Promise<string>;
        broadcast(session: string, text: string, origin?: MessageOrigin,
                  kind?: "text" | "tool" | "stream", blocks?: Block[]): Promise<void>;
    };

    // --- Usage Tracking ---
    tracker: {
        record(event: UsageData): UsageEvent;
        today(): UsageSummary;
        todayBySession(name: string): UsageSummary;
        week(): { cost: number };
        currentModel(): string;
        currentContext(): number;
    };

    // --- Logging ---
    log: {
        info(msg: string, data?: Record<string, unknown>): void;
        warn(msg: string, data?: Record<string, unknown>): void;
        error(msg: string, data?: Record<string, unknown>): void;
        getBuffer(): Array<{ timestamp: string; level: string; message: string }>;
    };

    // --- Utilities ---
    utils: {
        splitMessage(text: string, maxLength?: number): string[];
    };

    // --- Config & Instance ---
    config: Config;
    instance: { name: string; dataDir: string };
}
```

### Registration Methods

| Method | What it registers |
|--------|-------------------|
| `registerListener(listener)` | Platform adapter (Discord, Telegram, IRC...) |
| `registerMiddleware(middleware)` | Message interceptor — transform, block, or log messages |
| `registerCommand(name, command)` | Bot command (`bot!name args`) |
| `registerRoute(method, path, handler)` | HTTP endpoint |
| `registerPrefixRoute(method, prefix, handler)` | Wildcard HTTP route (e.g. `/dashboard/*`) |
| `registerUpgrade(path, handler)` | WebSocket upgrade handler |
| `on(event, handler)` | Lifecycle hook |

### Lifecycle Events

| Event | Handler signature | When |
|-------|-------------------|------|
| `message_in` | `(msg: IncomingMessage) => void` | Message received from any listener |
| `message_out` | `(origin: MessageOrigin, text: string) => void` | Response sent |
| `session_start` | `(name: string) => void` | Pi session started |
| `session_stop` | `(name: string) => void` | Pi session stopped |
| `shutdown` | `() => void` | Nest is shutting down |

## Interfaces

### Listener

A platform adapter that sends and receives messages:

```typescript
interface Listener {
    readonly name: string;
    streaming?: boolean;              // opt-in to receive stream deltas
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    onMessage(handler: (msg: IncomingMessage) => void): void;
    send(origin: MessageOrigin, text: string, files?: OutgoingFile[],
         kind?: "text" | "tool" | "stream"): Promise<void>;
    sendTyping?(origin: MessageOrigin): Promise<void>;
    notifyOrigin?(): MessageOrigin | null;
    sendPrompt?(origin: MessageOrigin, block: Block): Promise<Record<string, unknown>>;
}
```

### Middleware

Intercepts messages before they reach pi:

```typescript
interface Middleware {
    readonly name: string;
    process(msg: IncomingMessage): Promise<IncomingMessage | null>;  // null = block
}
```

### Command

Bot command triggered by `bot!name`:

```typescript
interface Command {
    interrupts?: boolean;    // cancel pending pi work first?
    execute(ctx: CommandContext): Promise<void>;
}
```

### MessageOrigin

Identifies where a message came from:

```typescript
interface MessageOrigin {
    platform: string;        // "discord", "cli", etc.
    channel: string;         // channel ID, "*" for wildcard
}
```

## Plugin Config

Plugins read their own sections from `config.yaml`. The kernel passes the full config through — plugins grab what they need:

```yaml
# Plugin reads nest.config.discord
discord:
    token: "env:DISCORD_TOKEN"
    notify: "123456"
    channels:
        "123456": "wren"

# Plugin reads nest.config.my_plugin
my_plugin:
    whatever: "plugins decide their own schema"
```

## Writing a Server-Side Plugin

1. Create `plugins/<name>/nest.ts`
2. Export a default function that receives `NestAPI`
3. Use `import type { ... } from "nest"` for types
4. If you need npm packages, add a `package.json` and run `npm install`
5. `bot!reload` to load without restarting

```typescript
import type { NestAPI } from "nest";

export default function (nest: NestAPI): void {
    nest.registerRoute("GET", "/api/hello", (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ hello: "world" }));
    });
}
```

## Writing an Agent-Side Plugin

1. Create `plugins/<name>/pi.ts`
2. Export a default function that receives `ExtensionAPI`
3. Register tools the agent can call
4. `bot!reboot` to pick up changes

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "my_tool",
        label: "My Tool",
        description: "Does a thing",
        parameters: Type.Object({
            input: Type.String({ description: "The input" }),
        }),
        async execute(_id, params) {
            return { content: [{ type: "text", text: `Got: ${params.input}` }] };
        },
    });
}
```

## Examples

### Prompt Injection Guard

```typescript
import type { NestAPI } from "nest";

export default function (nest: NestAPI): void {
    const blocked = ["ignore previous instructions", "you are now"];

    nest.registerMiddleware({
        name: "injection-guard",
        async process(msg) {
            const lower = msg.text.toLowerCase();
            if (blocked.some(p => lower.includes(p))) {
                nest.log.warn("Blocked suspicious message", { sender: msg.sender });
                return null;
            }
            return msg;
        },
    });
}
```

### Listener Plugin

```typescript
import type { NestAPI, Listener } from "nest";

export default function (nest: NestAPI): void {
    const config = nest.config.telegram as { token: string; chatId: string } | undefined;
    if (!config) return;

    const listener: Listener = {
        name: "telegram",
        async connect() { /* ... */ },
        async disconnect() { /* ... */ },
        onMessage(handler) { /* ... */ },
        async send(origin, text) { /* ... */ },
    };

    nest.registerListener(listener);
    nest.sessions.attach(nest.sessions.getDefault(), listener, {
        platform: "telegram",
        channel: config.chatId,
    });
}
```

### Webhook Consumer

```typescript
import type { NestAPI } from "nest";

export default function (nest: NestAPI): void {
    nest.registerRoute("POST", "/api/notify", async (req, res) => {
        let data = "";
        for await (const chunk of req) data += chunk;
        const body = JSON.parse(data);

        const session = nest.sessions.getDefault();
        const response = await nest.sessions.sendMessage(session, body.message);
        await nest.sessions.broadcast(session, response);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, response }));
    });
}
```

## Agent Self-Modification

The agent can write new plugins at runtime:

1. User asks for a feature
2. Agent writes files to the plugins directory
3. Agent triggers `bot!reload` (server-side) or `bot!reboot` (agent-side)
4. Feature is live

The agent builds its own nervous system.
