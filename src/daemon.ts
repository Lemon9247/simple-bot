import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Bridge } from "./bridge.js";
import type { ImageContent } from "./bridge.js";
import { commandMap } from "./commands.js";
import type { DaemonRef } from "./commands.js";
import { Tracker } from "./tracker.js";
import type { Config, Listener, IncomingMessage, MessageOrigin, ToolCallInfo, ToolEndInfo, JobDefinition, OutgoingFile, Attachment } from "./types.js";
import type { Scheduler } from "./scheduler.js";
import { HttpServer } from "./server.js";
import * as logger from "./logger.js";
import { cleanupInbox, saveToInbox } from "./inbox.js";
import { compressImage } from "./image.js";

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

export class Daemon implements DaemonRef {
    private config: Config;
    private bridge: Bridge;
    private listeners: Listener[] = [];
    private scheduler?: Scheduler;
    private httpServer?: HttpServer;
    private tracker: Tracker;
    private stopping = false;
    private commandRunning = false;
    private rateLimits = new Map<string, number[]>();
    private lastUserInteractionTime = 0;
    private startedAt = Date.now();
    private thinkingEnabled = false;

    constructor(config: Config, bridge?: Bridge, scheduler?: Scheduler) {
        this.config = config;
        this.bridge = bridge ?? new Bridge({
            cwd: config.pi.cwd,
            command: config.pi.command,
            args: config.pi.args,
        });
        this.scheduler = scheduler;
        this.tracker = new Tracker(config.tracking);

        if (config.server) {
            this.httpServer = new HttpServer(config.server);
        }
    }

    getLastUserInteractionTime(): number {
        return this.lastUserInteractionTime;
    }

    getUptime(): number {
        return Date.now() - this.startedAt;
    }

    getSchedulerStatus(): { total: number; enabled: number; names: string[] } {
        if (!this.scheduler) return { total: 0, enabled: 0, names: [] };
        const jobs = this.scheduler.getJobs();
        const names: string[] = [];
        let enabled = 0;
        for (const [name, active] of jobs) {
            names.push(name);
            if (active.definition.enabled) enabled++;
        }
        return { total: names.length, enabled, names };
    }

    getThinkingEnabled(): boolean {
        return this.thinkingEnabled;
    }

    setThinkingEnabled(enabled: boolean): void {
        this.thinkingEnabled = enabled;
    }

    getUsageStats(): {
        today: { inputTokens: number; outputTokens: number; cost: number; messageCount: number };
        week: { cost: number };
    } | null {
        const today = this.tracker.today();
        const week = this.tracker.week();
        return { today, week: { cost: week.cost } };
    }

    setScheduler(scheduler: Scheduler): void {
        this.scheduler = scheduler;
    }

    addListener(listener: Listener): void {
        this.listeners.push(listener);
    }

    getTracker(): Tracker {
        return this.tracker;
    }

    async start(): Promise<void> {
        this.bridge.start();
        this.bridge.on("exit", (code: number) => {
            if (this.stopping) return;
            logger.error("Pi exited unexpectedly, shutting down", { code });
            this.stop().then(() => process.exit(1));
        });

        // Load persisted usage log before processing events
        await this.tracker.loadLog();

        // Track usage on every agent_end event
        this.bridge.on("event", (event: any) => {
            if (event.type === "agent_end") {
                this.recordUsage(event);
            }
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

        if (this.httpServer) {
            await this.httpServer.start();
        }

        logger.info("simple-bot started", { listeners: this.listeners.length });
    }

    async stop(): Promise<void> {
        this.stopping = true;
        if (this.httpServer) {
            await this.httpServer.stop();
        }
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

        this.lastUserInteractionTime = Date.now();

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
                await command.execute({ args: parsed.args, bridge: this.bridge, reply, daemon: this });
            } catch (err) {
                logger.error("Command failed", { command: parsed.name, error: String(err) });
                await reply(`❌ Command failed: ${String(err)}`);
            } finally {
                this.commandRunning = false;
            }
            return;
        }

        // Process attachments: images → base64 for pi, others → inbox paths
        const { images, fileLines } = await this.processAttachments(msg.attachments);

        let promptText = `[${msg.platform} ${msg.channel}] ${msg.sender}: ${msg.text}`;
        if (fileLines.length > 0) {
            promptText += "\n" + fileLines.join("\n");
        }

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
            this.bridge.steer(promptText);
            return;
        }

        // Show typing indicator while the agent is working
        const typingInterval = this.startTyping(listener, origin);

        // Accumulate files from the `attach` tool during this response
        const pendingFiles: OutgoingFile[] = [];
        const pendingReads: Promise<void>[] = [];

        try {
            const response = await this.bridge.sendMessage(promptText, {
                images: images.length > 0 ? images : undefined,
                onToolStart: (info) => {
                    if (!listener) return;
                    const summary = formatToolCall(info);
                    listener.send(origin, summary).catch((err) => {
                        logger.error("Failed to send tool update", { error: String(err) });
                    });
                },
                onToolEnd: (info: ToolEndInfo) => {
                    if (info.toolName === "attach" && !info.isError && info.result?.details) {
                        const filePath = info.result.details.path;
                        if (typeof filePath === "string") {
                            pendingReads.push(
                                this.queueAttachFile(filePath, info.result.details.filename, pendingFiles),
                            );
                        }
                    }
                },
                onText: (text) => {
                    if (!listener) return;
                    listener.send(origin, text).catch((err) => {
                        logger.error("Failed to send intermediate text", { error: String(err) });
                    });
                },
            });

            if (!response) return;

            // Wait for any pending file reads before sending
            await Promise.all(pendingReads);

            if (listener) {
                await listener.send(origin, response, pendingFiles.length > 0 ? pendingFiles : undefined);
            }
        } catch (err) {
            logger.error("Failed to process message", { error: String(err) });
        } finally {
            clearInterval(typingInterval);
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

    private recordUsage(event: any): void {
        // Extract usage data from agent_end event if available
        const usage = event.usage ?? event.stats ?? {};
        const model = usage.model ?? event.model ?? "unknown";
        const inputTokens = usage.inputTokens ?? usage.input_tokens ?? 0;
        const outputTokens = usage.outputTokens ?? usage.output_tokens ?? 0;
        const contextSize = usage.contextSize ?? usage.context_size ?? usage.totalTokens ?? usage.total_tokens ?? 0;

        // If event has no usage data at all, query get_state for context size
        if (contextSize === 0 && this.bridge.running) {
            this.bridge.command("get_state").then((state: any) => {
                const ctxSize = state?.contextSize ?? state?.context_size ?? state?.totalTokens ?? 0;
                const recorded = this.tracker.record({ model, inputTokens, outputTokens, contextSize: ctxSize });
                logger.info("Usage recorded (via get_state)", {
                    model: recorded.model,
                    inputTokens: recorded.inputTokens,
                    outputTokens: recorded.outputTokens,
                    contextSize: recorded.contextSize,
                    cost: recorded.cost.toFixed(6),
                    compaction: recorded.compaction,
                });
            }).catch((err: Error) => {
                // Still record with zero context if get_state fails
                const recorded = this.tracker.record({ model, inputTokens, outputTokens, contextSize: 0 });
                logger.warn("Usage recorded without context size", {
                    model: recorded.model,
                    inputTokens: recorded.inputTokens,
                    outputTokens: recorded.outputTokens,
                    cost: recorded.cost.toFixed(6),
                    error: String(err),
                });
            });
            return;
        }

        const recorded = this.tracker.record({ model, inputTokens, outputTokens, contextSize });
        logger.info("Usage recorded", {
            model: recorded.model,
            inputTokens: recorded.inputTokens,
            outputTokens: recorded.outputTokens,
            contextSize: recorded.contextSize,
            cost: recorded.cost.toFixed(6),
            compaction: recorded.compaction,
        });
    }

    private async processAttachments(
        attachments?: Attachment[],
    ): Promise<{ images: ImageContent[]; fileLines: string[] }> {
        const images: ImageContent[] = [];
        const fileLines: string[] = [];

        if (!attachments || attachments.length === 0) {
            return { images, fileLines };
        }

        // Clean up old inbox files (non-blocking)
        cleanupInbox().catch((err) => {
            logger.error("Inbox cleanup failed", { error: String(err) });
        });

        for (const att of attachments) {
            if (att.base64 && att.contentType.startsWith("image/")) {
                const compressed = att.data
                    ? await compressImage(att.data, att.contentType)
                    : null;
                if (compressed && !compressed.ok) {
                    // Image couldn't be compressed — include as text warning
                    fileLines.push(`[${compressed.reason}]`);
                } else if (compressed && compressed.ok) {
                    images.push({
                        type: "image",
                        data: compressed.base64,
                        mimeType: compressed.mimeType,
                    });
                } else {
                    // null = already fits, use original
                    images.push({
                        type: "image",
                        data: att.base64,
                        mimeType: att.contentType,
                    });
                }
            } else if (att.data) {
                const saved = await saveToInbox(att.filename, att.data);
                if (saved) {
                    fileLines.push(`[Attached file: ${saved} (${att.contentType}, ${att.size} bytes)]`);
                }
            }
        }

        return { images, fileLines };
    }

    private async queueAttachFile(
        filePath: string,
        filename: string | undefined,
        pendingFiles: OutgoingFile[],
    ): Promise<void> {
        try {
            const data = await readFile(filePath);
            pendingFiles.push({
                data,
                filename: filename ?? basename(filePath),
            });
        } catch (err) {
            logger.error("Failed to read attach file", { path: filePath, error: String(err) });
        }
    }

    private startTyping(listener: Listener | undefined, origin: MessageOrigin): ReturnType<typeof setInterval> {
        const send = () => {
            listener?.sendTyping?.(origin).catch((err) => {
                logger.error("Failed to send typing indicator", { error: String(err) });
            });
        };
        send(); // fire immediately
        return setInterval(send, 8_000); // refresh every 8s (Discord typing lasts ~10s)
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
