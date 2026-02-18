import { Bridge } from "./bridge.js";
import { commandMap } from "./commands.js";
import type { Config, Listener, IncomingMessage, MessageOrigin, ToolCallInfo, JobDefinition } from "./types.js";
import type { Scheduler } from "./scheduler.js";
import * as logger from "./logger.js";

const MAX_MESSAGE_LENGTH = 4000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 10;
const COMMAND_PREFIX = "bot!";

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
    private scheduler?: Scheduler;
    private stopping = false;
    private commandRunning = false;
    private rateLimits = new Map<string, number[]>();

    constructor(config: Config, bridge?: Bridge, scheduler?: Scheduler) {
        this.config = config;
        this.bridge = bridge ?? new Bridge({
            cwd: config.pi.cwd,
            command: config.pi.command,
            args: config.pi.args,
        });
        this.scheduler = scheduler;
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

        if (this.scheduler) {
            this.scheduler.on("response", ({ job, response }: { job: JobDefinition; response: string }) => {
                this.handleSchedulerResponse(job, response).catch((err) => {
                    logger.error("Unhandled error in scheduler response", { job: job.name, error: String(err) });
                });
            });
            await this.scheduler.start();
        }

        logger.info("simple-bot started", { listeners: this.listeners.length });
    }

    async stop(): Promise<void> {
        this.stopping = true;
        if (this.scheduler) {
            await this.scheduler.stop();
        }
        for (const listener of this.listeners) {
            await listener.disconnect().catch(() => {});
        }
        await this.bridge.stop();
    }

    private parseCommand(text: string): { name: string; args: string } | null {
        if (!text.toLowerCase().startsWith(COMMAND_PREFIX)) return null;
        const rest = text.slice(COMMAND_PREFIX.length).trim();
        if (!rest) return null;
        const [rawName, ...argParts] = rest.split(/\s+/);
        const name = rawName.toLowerCase();
        if (!commandMap.has(name)) return null;
        return { name, args: argParts.join(" ") };
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
        const reply = async (text: string) => {
            if (listener) await listener.send(origin, text).catch(() => {});
        };

        // Handle bot commands before passing to the agent
        const parsed = this.parseCommand(msg.text);
        if (parsed) {
            const command = commandMap.get(parsed.name)!;
            logger.info("Handling command", { command: parsed.name, sender: msg.sender });

            if (command.interrupts) {
                this.bridge.cancelPending(`Interrupted by bot!${parsed.name}`);
            }

            this.commandRunning = true;
            try {
                await command.execute({ args: parsed.args, bridge: this.bridge, reply });
            } catch (err) {
                logger.error("Command failed", { command: parsed.name, error: String(err) });
                await reply(`❌ Command failed: ${String(err)}`);
            } finally {
                this.commandRunning = false;
            }
            return;
        }

        const formatted = `[${msg.platform} ${msg.channel}] ${msg.sender}: ${msg.text}`;

        // If a command is running (e.g. compact), don't send prompts —
        // pi may drop them or leave the response queue dangling.
        if (this.commandRunning) {
            logger.info("Message deferred, command running", { sender: msg.sender });
            await reply("⏳ Hold on, running a command...");
            return;
        }

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

    private async handleSchedulerResponse(job: JobDefinition, response: string): Promise<void> {
        const notifyRoom = this.resolveNotify(job);
        if (!notifyRoom) return;

        const [platform, channel] = this.parseRoomId(notifyRoom);

        if (!platform || !channel) {
            logger.error("Invalid notify room format", { notifyRoom, job: job.name });
            return;
        }

        const origin: MessageOrigin = { platform, channel };
        const listener = this.listeners.find((l) => l.name === platform);

        if (listener) {
            try {
                await listener.send(origin, response);
            } catch (err) {
                logger.error("Failed to send cron job response", { job: job.name, error: String(err) });
            }
        } else {
            logger.error("No listener found for platform", { platform, job: job.name });
        }
    }

    private resolveNotify(job: JobDefinition): string | null {
        if (job.notify === "none") return null;
        if (job.notify) return job.notify;
        return this.config.cron?.default_notify ?? null;
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
