import { Bridge } from "./bridge.js";
import type { Config, Listener, IncomingMessage, MessageOrigin, ToolCallInfo } from "./types.js";
import type { Heartbeat } from "./heartbeat.js";
import * as logger from "./logger.js";

const MAX_MESSAGE_LENGTH = 4000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 10;

const SLASH_COMMANDS = ["abort", "compress", "new", "model", "reload"] as const;
type SlashCommand = typeof SLASH_COMMANDS[number];

function formatToolCall(info: ToolCallInfo): string {
    const { toolName, args } = info;
    switch (toolName) {
        case "read":
            return `📖 Reading \`${args?.path ?? "file"}\``;
        case "bash": {
            const cmd = String(args?.command ?? "");
            const firstLine = cmd.split("\n")[0];
            const display = firstLine.length > 80
                ? firstLine.slice(0, 80) + "…"
                : firstLine;
            return `⚡ \`${display}\``;
        }
        case "edit":
            return `✏️ Editing \`${args?.path ?? "file"}\``;
        case "write":
            return `📝 Writing \`${args?.path ?? "file"}\``;
        default:
            return `🔧 ${toolName}`;
    }
}

export class Daemon {
    private config: Config;
    private bridge: Bridge;
    private listeners: Listener[] = [];
    private heartbeat?: Heartbeat;
    private stopping = false;
    private rateLimits = new Map<string, number[]>();

    constructor(config: Config, bridge?: Bridge, heartbeat?: Heartbeat) {
        this.config = config;
        this.bridge = bridge ?? new Bridge({
            cwd: config.pi.cwd,
            command: config.pi.command,
            args: config.pi.args,
        });
        this.heartbeat = heartbeat;
    }

    addListener(listener: Listener): void {
        this.listeners.push(listener);
    }

    async start(): Promise<void> {
        this.bridge.start();
        this.bridge.on("exit", (code: number) => {
            if (this.stopping) return;
            logger.error("Pi exited unexpectedly, shutting down", { code });
            this.stop().then(() => process.exit(1));
        });

        for (const listener of this.listeners) {
            listener.onMessage((msg) => this.handleMessage(msg));
            await listener.connect();
        }

        if (this.heartbeat) {
            this.heartbeat.on("response", (response: string) => this.handleHeartbeatResponse(response));
            this.heartbeat.start();
        }

        logger.info("simple-bot started", { listeners: this.listeners.length });
    }

    async stop(): Promise<void> {
        this.stopping = true;
        if (this.heartbeat) {
            this.heartbeat.stop();
        }
        for (const listener of this.listeners) {
            await listener.disconnect().catch(() => {});
        }
        await this.bridge.stop();
    }

    private parseSlashCommand(text: string): { command: SlashCommand; args: string } | null {
        if (!text.startsWith("/")) return null;
        const [rawCommand, ...rest] = text.slice(1).trim().split(/\s+/);
        const command = rawCommand?.toLowerCase() as SlashCommand;
        if (!SLASH_COMMANDS.includes(command)) return null;
        return { command, args: rest.join(" ") };
    }

    private async handleSlashCommand(
        command: SlashCommand,
        args: string,
        origin: MessageOrigin,
        listener: Listener | undefined,
    ): Promise<void> {
        const reply = async (text: string) => {
            if (listener) await listener.send(origin, text).catch(() => {});
        };

        try {
            switch (command) {
                case "abort": {
                    await this.bridge.command("abort");
                    await reply("⏹️ Aborted.");
                    break;
                }

                case "compress": {
                    await reply("🗜️ Compressing context...");
                    const result = await this.bridge.command("compact", args ? { customInstructions: args } : {});
                    const before = result?.tokensBefore ?? "?";
                    await reply(`✅ Compressed. Tokens before: ${before}`);
                    break;
                }

                case "new": {
                    await this.bridge.command("new_session");
                    await reply("🆕 Started a new session.");
                    break;
                }

                case "reload": {
                    await reply("🔄 Reloading extensions...");
                    // Send /reload-runtime as a prompt — it's an extension command,
                    // which executes immediately in RPC mode without going to the LLM
                    const response = await this.bridge.sendMessage("/reload-runtime");
                    await reply(response || "✅ Extensions reloaded.");
                    break;
                }

                case "model": {
                    if (!args) {
                        // List available models
                        const result = await this.bridge.command("get_available_models");
                        const models: any[] = result?.models ?? [];
                        if (models.length === 0) {
                            await reply("No models available.");
                        } else {
                            const list = models
                                .map((m: any) => `• \`${m.provider}/${m.id}\` — ${m.name}`)
                                .join("\n");
                            await reply(`**Available models:**\n${list}\n\nUse \`/model <name>\` to switch.`);
                        }
                    } else {
                        // Find and switch to matching model
                        const result = await this.bridge.command("get_available_models");
                        const models: any[] = result?.models ?? [];
                        const query = args.toLowerCase();
                        const match = models.find(
                            (m: any) =>
                                m.id.toLowerCase().includes(query) ||
                                m.name.toLowerCase().includes(query) ||
                                `${m.provider}/${m.id}`.toLowerCase().includes(query),
                        );
                        if (!match) {
                            await reply(`❌ No model matching \`${args}\`. Use \`/model\` to list available models.`);
                        } else {
                            await this.bridge.command("set_model", { provider: match.provider, modelId: match.id });
                            await reply(`✅ Switched to **${match.name}** (\`${match.provider}/${match.id}\`).`);
                        }
                    }
                    break;
                }
            }
        } catch (err) {
            logger.error("Slash command failed", { command, error: String(err) });
            await reply(`❌ Command failed: ${String(err)}`);
        }
    }

    private async handleMessage(msg: IncomingMessage): Promise<void> {
        if (!this.config.security.allowed_users.includes(msg.sender)) {
            logger.info("Ignored message from unauthorized user", { sender: msg.sender });
            return;
        }

        if (msg.text.length > MAX_MESSAGE_LENGTH) {
            logger.warn("Dropped oversized message", {
                sender: msg.sender,
                length: msg.text.length,
                max: MAX_MESSAGE_LENGTH,
            });
            return;
        }

        if (this.isRateLimited(msg.sender)) {
            logger.warn("Rate limited user", { sender: msg.sender });
            return;
        }

        const origin: MessageOrigin = {
            platform: msg.platform,
            channel: msg.channel,
        };
        const listener = this.listeners.find((l) => l.name === msg.platform);

        // Handle slash commands before passing to the agent
        const slash = this.parseSlashCommand(msg.text);
        if (slash) {
            logger.info("Handling slash command", { command: slash.command, sender: msg.sender });
            await this.handleSlashCommand(slash.command, slash.args, origin, listener);
            return;
        }

        const formatted = `[${msg.platform} ${msg.channel}] ${msg.sender}: ${msg.text}`;

        // If the agent is mid-chain, steer instead of queuing a new prompt
        if (this.bridge.busy) {
            logger.info("Steering active agent", { sender: msg.sender });
            this.bridge.steer(formatted);
            return;
        }

        try {
            const response = await this.bridge.sendMessage(formatted, {
                onToolStart: (info) => {
                    if (!listener) return;
                    const summary = formatToolCall(info);
                    listener.send(origin, summary).catch((err) => {
                        logger.error("Failed to send tool update", { error: String(err) });
                    });
                },
                onText: (text) => {
                    if (!listener) return;
                    listener.send(origin, text).catch((err) => {
                        logger.error("Failed to send intermediate text", { error: String(err) });
                    });
                },
            });

            if (!response) return;

            if (listener) {
                await listener.send(origin, response);
            }
        } catch (err) {
            logger.error("Failed to process message", { error: String(err) });
        }
    }

    private async handleHeartbeatResponse(response: string): Promise<void> {
        if (!this.config.heartbeat) return;

        const notifyRoom = this.config.heartbeat.notify_room;
        const [platform, channel] = this.parseRoomId(notifyRoom);

        if (!platform || !channel) {
            logger.error("Invalid notify_room format", { notifyRoom });
            return;
        }

        const origin: MessageOrigin = { platform, channel };
        const listener = this.listeners.find((l) => l.name === platform);

        if (listener) {
            try {
                await listener.send(origin, response);
            } catch (err) {
                logger.error("Failed to send heartbeat response", { error: String(err) });
            }
        } else {
            logger.error("No listener found for platform", { platform });
        }
    }

    private parseRoomId(roomId: string): [string | null, string | null] {
        if (roomId.startsWith("#") && roomId.includes(":")) {
            return ["matrix", roomId];
        } else if (/^\d+$/.test(roomId)) {
            return ["discord", roomId];
        }
        return [null, null];
    }

    private isRateLimited(sender: string): boolean {
        const now = Date.now();
        const timestamps = this.rateLimits.get(sender) ?? [];
        const recent = timestamps.filter((t) => now - t < RATE_WINDOW_MS);

        if (recent.length >= RATE_MAX_PER_WINDOW) {
            this.rateLimits.set(sender, recent);
            return true;
        }

        recent.push(now);
        this.rateLimits.set(sender, recent);
        return false;
    }
}
