import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import cron from "node-cron";
import type { Bridge } from "./bridge.js";

export interface HeartbeatConfig {
    enabled: boolean;
    schedule: string;
    checklist: string;
    notify_room: string;
}

export class Heartbeat extends EventEmitter {
    private config: HeartbeatConfig;
    private bridge: Bridge;
    private task: cron.ScheduledTask | null = null;

    constructor(config: HeartbeatConfig, bridge: Bridge) {
        super();
        this.config = config;
        this.bridge = bridge;

        if (!cron.validate(this.config.schedule)) {
            throw new Error(`Invalid cron schedule: ${this.config.schedule}`);
        }
    }

    start(): void {
        if (this.task) return;

        this.task = cron.schedule(this.config.schedule, () => this.tick());
    }

    stop(): void {
        if (this.task) {
            this.task.stop();
            this.task = null;
        }
    }

    private async tick(): Promise<void> {
        try {
            const content = await readFile(this.config.checklist, "utf-8");
            const response = await this.bridge.sendMessage(content);

            if (response && response.trim()) {
                this.emit("response", response);
            }
        } catch (err) {
            console.error("Heartbeat tick failed:", err);
        }
    }
}
