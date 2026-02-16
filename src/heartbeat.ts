import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { Bridge } from "./bridge.js";
import type { Config } from "./types.js";

export interface HeartbeatConfig {
    enabled: boolean;
    interval: string;
    active_hours: string;
    checklist: string;
    notify_room: string;
}

export class Heartbeat extends EventEmitter {
    private config: HeartbeatConfig;
    private bridge: Bridge;
    private timer: NodeJS.Timeout | null = null;

    constructor(config: HeartbeatConfig, bridge: Bridge) {
        super();
        this.config = config;
        this.bridge = bridge;
    }

    start(): void {
        if (this.timer) return;

        const intervalMs = parseInterval(this.config.interval);
        this.timer = setInterval(() => this.tick(), intervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async tick(): Promise<void> {
        // Check if we're within active hours
        if (!isWithinActiveHours(this.config.active_hours)) {
            return;
        }

        try {
            // Read checklist file
            const content = await readFile(this.config.checklist, "utf-8");
            
            // Send to bridge
            const response = await this.bridge.sendMessage(content);
            
            // If pi has something to say, emit it
            if (response && response.trim()) {
                this.emit("response", response);
            }
        } catch (err) {
            console.error("Heartbeat tick failed:", err);
        }
    }
}

/**
 * Parse interval string like '4h', '30m', '1h30m' into milliseconds
 */
export function parseInterval(interval: string): number {
    const regex = /(\d+)([hm])/g;
    let totalMs = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(interval)) !== null) {
        const value = parseInt(match[1], 10);
        const unit = match[2];

        if (unit === "h") {
            totalMs += value * 60 * 60 * 1000;
        } else if (unit === "m") {
            totalMs += value * 60 * 1000;
        }
    }

    if (totalMs === 0) {
        throw new Error(`Invalid interval format: ${interval}`);
    }

    return totalMs;
}

/**
 * Check if current time is within active hours window
 * Format: '08:00-23:00'
 */
export function isWithinActiveHours(activeHours: string): boolean {
    const [startStr, endStr] = activeHours.split("-");
    if (!startStr || !endStr) {
        throw new Error(`Invalid active_hours format: ${activeHours}`);
    }

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startHour, startMin] = startStr.split(":").map((s) => parseInt(s, 10));
    const [endHour, endMin] = endStr.split(":").map((s) => parseInt(s, 10));

    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}
