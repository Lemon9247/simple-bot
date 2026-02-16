import { Bridge } from "./bridge.js";
import type { Config, Listener, IncomingMessage, MessageOrigin } from "./types.js";
import type { Heartbeat } from "./heartbeat.js";

export class Daemon {
    private config: Config;
    private bridge: Bridge;
    private listeners: Listener[] = [];
    private heartbeat?: Heartbeat;
    private stopping = false;

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
            console.error(`Pi exited unexpectedly (code=${code}), shutting down`);
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

        console.log(`simple-bot started (${this.listeners.length} listener(s))`);
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

    private async handleHeartbeatResponse(response: string): Promise<void> {
        if (!this.config.heartbeat) return;

        const notifyRoom = this.config.heartbeat.notify_room;
        const [platform, channel] = this.parseRoomId(notifyRoom);

        if (!platform || !channel) {
            console.error(`Invalid notify_room format: ${notifyRoom}`);
            return;
        }

        const origin: MessageOrigin = { platform, channel };
        const listener = this.listeners.find((l) => l.name === platform);

        if (listener) {
            try {
                await listener.send(origin, response);
            } catch (err) {
                console.error(`Failed to send heartbeat response:`, err);
            }
        } else {
            console.error(`No listener found for platform: ${platform}`);
        }
    }

    private parseRoomId(roomId: string): [string | null, string | null] {
        // Parse formats like "#hades:athena" (matrix) or "1234567890" (discord)
        // For matrix: "#room:server" -> platform="matrix", channel="#room:server"
        // For discord: "1234567890" -> platform="discord", channel="1234567890"
        
        if (roomId.startsWith("#") && roomId.includes(":")) {
            return ["matrix", roomId];
        } else if (/^\d+$/.test(roomId)) {
            return ["discord", roomId];
        }
        
        return [null, null];
    }
}
