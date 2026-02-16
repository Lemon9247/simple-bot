import { Bridge } from "./bridge.js";
import type { Config, Listener, IncomingMessage, MessageOrigin } from "./types.js";

export class Daemon {
    private config: Config;
    private bridge: Bridge;
    private listeners: Listener[] = [];
    private stopping = false;

    constructor(config: Config, bridge?: Bridge) {
        this.config = config;
        this.bridge = bridge ?? new Bridge({
            cwd: config.pi.cwd,
            command: config.pi.command,
            args: config.pi.args,
        });
    }

    addListener(listener: Listener): void {
        this.listeners.push(listener);
    }

    async start(): Promise<void> {
        this.bridge.start();
        this.bridge.on("exit", (code: number) => {
            if (this.stopping) return;
            console.error(`Pi exited unexpectedly (code=${code}), shutting down`);
            this.stop().then(() => process.exit(1));
        });

        for (const listener of this.listeners) {
            listener.onMessage((msg) => this.handleMessage(msg));
            await listener.connect();
        }

        console.log(`simple-bot started (${this.listeners.length} listener(s))`);
    }

    async stop(): Promise<void> {
        this.stopping = true;
        for (const listener of this.listeners) {
            await listener.disconnect().catch(() => {});
        }
        await this.bridge.stop();
    }

    private async handleMessage(msg: IncomingMessage): Promise<void> {
        if (!this.config.security.allowed_users.includes(msg.sender)) {
            console.log(`Ignored message from ${msg.sender}`);
            return;
        }

        const formatted = `[${msg.platform} ${msg.channel}] ${msg.sender}: ${msg.text}`;

        try {
            const response = await this.bridge.sendMessage(formatted);
            if (!response) return;

            const origin: MessageOrigin = {
                platform: msg.platform,
                channel: msg.channel,
            };

            const listener = this.listeners.find((l) => l.name === msg.platform);
            if (listener) {
                await listener.send(origin, response);
            }
        } catch (err) {
            console.error(`Failed to process message:`, err);
        }
    }
}
