import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { UsageEvent, TrackingConfig } from "./types.js";
import * as logger from "./logger.js";

const MS_PER_DAY = 86_400_000;
const DEFAULT_CAPACITY = 1000;
const DEFAULT_RETENTION_DAYS = 30;

export interface UsageSummary {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    messageCount: number;
}

/**
 * Ring buffer that tracks usage events in memory with optional JSONL persistence.
 *
 * The buffer is a fixed-size array with a head pointer. When full, the oldest
 * entry is overwritten. This keeps memory bounded regardless of uptime.
 */
export class Tracker {
    private buffer: (UsageEvent | null)[];
    private head = 0;
    private count = 0;
    private readonly capacity: number;
    private readonly usageLogPath: string | null;
    private readonly retentionDays: number;
    private lastContextSize = 0;

    constructor(config: TrackingConfig = {}) {
        this.capacity = config.capacity ?? DEFAULT_CAPACITY;
        this.usageLogPath = config.usageLog ?? null;
        this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
        this.buffer = new Array(this.capacity).fill(null);
    }

    /** Load existing JSONL log on startup (only last retentionDays). */
    async loadLog(): Promise<void> {
        if (!this.usageLogPath) return;

        let raw: string;
        try {
            raw = await readFile(this.usageLogPath, "utf-8");
        } catch (err: any) {
            if (err.code === "ENOENT") return; // no log yet
            logger.error("Failed to read usage log", { path: this.usageLogPath, error: String(err) });
            return;
        }

        const cutoff = Date.now() - this.retentionDays * MS_PER_DAY;
        const lines = raw.split("\n").filter(Boolean);

        for (const line of lines) {
            try {
                const event = JSON.parse(line) as UsageEvent;
                // Backfill cache fields for old log entries
                if (event.cacheReadTokens == null) event.cacheReadTokens = 0;
                if (event.cacheWriteTokens == null) event.cacheWriteTokens = 0;
                if (event.timestamp >= cutoff) {
                    this.insertEvent(event);
                }
            } catch {
                // skip malformed lines
            }
        }

        logger.info("Loaded usage log", { events: this.count, path: this.usageLogPath });
    }

    /** Record a usage event. Fire-and-forget JSONL write if persistence enabled. */
    record(data: {
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        contextSize: number;
        cost: number;
        sessionName?: string;
    }): UsageEvent {
        const compaction = this.detectCompaction(data.contextSize);

        const event: UsageEvent = {
            timestamp: Date.now(),
            model: data.model,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            cacheReadTokens: data.cacheReadTokens,
            cacheWriteTokens: data.cacheWriteTokens,
            contextSize: data.contextSize,
            cost: data.cost,
            compaction,
            ...(data.sessionName ? { sessionName: data.sessionName } : {}),
        };

        this.insertEvent(event);

        // Fire-and-forget JSONL append
        if (this.usageLogPath) {
            this.appendToLog(event);
        }

        return event;
    }

    /** Aggregated usage for today (UTC). */
    today(): UsageSummary {
        const startOfDay = this.startOfDayUTC();
        return this.aggregate((e) => e.timestamp >= startOfDay);
    }

    /** Aggregated usage for today filtered by session name. */
    todayBySession(sessionName: string): UsageSummary {
        const startOfDay = this.startOfDayUTC();
        return this.aggregate((e) => e.timestamp >= startOfDay && e.sessionName === sessionName);
    }

    /** Aggregated usage for last 7 days. */
    week(): UsageSummary {
        const cutoff = Date.now() - 7 * MS_PER_DAY;
        return this.aggregate((e) => e.timestamp >= cutoff);
    }

    /** Update context size without recording a new usage event. */
    updateContextSize(contextSize: number, _sessionName?: string): void {
        if (contextSize > 0) {
            this.lastContextSize = contextSize;
        }
    }

    /** Latest context size from the most recent event. */
    currentContext(): number {
        return this.lastContextSize;
    }

    /** Model name from the most recent event. */
    currentModel(): string {
        if (this.count === 0) return "unknown";
        const idx = (this.head - 1 + this.capacity) % this.capacity;
        return this.buffer[idx]?.model ?? "unknown";
    }

    /** Return all events matching a predicate, ordered oldest-first. */
    query(predicate?: (e: UsageEvent) => boolean): UsageEvent[] {
        const results: UsageEvent[] = [];
        for (let i = 0; i < this.count; i++) {
            const idx = (this.head - this.count + i + this.capacity) % this.capacity;
            const event = this.buffer[idx];
            if (event && (!predicate || predicate(event))) {
                results.push(event);
            }
        }
        return results;
    }

    /** Number of events currently stored. */
    get size(): number {
        return this.count;
    }

    // --- internals ---

    private startOfDayUTC(): number {
        const now = new Date();
        return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    }

    private insertEvent(event: UsageEvent): void {
        this.buffer[this.head] = event;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity) this.count++;
        // Keep lastContextSize in sync with loaded events too
        if (event.contextSize > 0) {
            this.lastContextSize = event.contextSize;
        }
    }

    private detectCompaction(newContextSize: number): boolean {
        if (this.lastContextSize === 0 || newContextSize === 0) return false;
        // Flag compaction when context drops by more than 30%
        return newContextSize < this.lastContextSize * 0.7;
    }

    private aggregate(predicate: (e: UsageEvent) => boolean): UsageSummary {
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let cost = 0;
        let messageCount = 0;

        for (let i = 0; i < this.count; i++) {
            const idx = (this.head - this.count + i + this.capacity) % this.capacity;
            const event = this.buffer[idx];
            if (event && predicate(event)) {
                inputTokens += event.inputTokens;
                outputTokens += event.outputTokens;
                cacheReadTokens += (event.cacheReadTokens ?? 0);
                cacheWriteTokens += (event.cacheWriteTokens ?? 0);
                cost += event.cost;
                messageCount++;
            }
        }

        return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, messageCount };
    }

    private appendToLog(event: UsageEvent): void {
        const line = JSON.stringify(event) + "\n";
        mkdir(dirname(this.usageLogPath!), { recursive: true })
            .then(() => appendFile(this.usageLogPath!, line, "utf-8"))
            .catch((err) => {
                logger.error("Failed to write usage log", { error: String(err) });
            });
    }
}
