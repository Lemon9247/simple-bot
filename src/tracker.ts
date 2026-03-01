import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { UsageEvent, TrackingConfig } from "./types.js";
import * as logger from "./logger.js";

/** Default per-million-token rates (input, output) */
const DEFAULT_RATES: Record<string, { input: number; output: number }> = {
    "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
    "claude-sonnet-4": { input: 3.0, output: 15.0 },
    "claude-haiku-4-5": { input: 0.8, output: 4.0 },
    "claude-opus-4": { input: 15.0, output: 75.0 },
    "gpt-4o": { input: 2.5, output: 10.0 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "o3": { input: 10.0, output: 40.0 },
    "o4-mini": { input: 1.1, output: 4.4 },
    "gemini-2.5-pro": { input: 1.25, output: 10.0 },
    "gemini-2.5-flash": { input: 0.15, output: 0.6 },
};

const MS_PER_DAY = 86_400_000;
const DEFAULT_CAPACITY = 1000;
const DEFAULT_RETENTION_DAYS = 30;

export interface UsageSummary {
    inputTokens: number;
    outputTokens: number;
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
    private readonly rates: Record<string, { input: number; output: number }>;
    private readonly usageLogPath: string | null;
    private readonly retentionDays: number;
    private lastContextSize = 0;

    constructor(config: TrackingConfig = {}) {
        this.capacity = config.capacity ?? DEFAULT_CAPACITY;
        this.rates = { ...DEFAULT_RATES, ...config.rates };
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
                if (event.timestamp >= cutoff) {
                    this.insertEvent(event);
                }
            } catch {
                // skip malformed lines
            }
        }

        logger.info("Loaded usage log", { events: this.count, path: this.usageLogPath });
    }

    /** Estimate cost for a given model and token counts. */
    estimateCost(model: string, inputTokens: number, outputTokens: number): number {
        const rate = this.rates[model];
        if (!rate) return 0;
        return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
    }

    /** Record a usage event. Fire-and-forget JSONL write if persistence enabled. */
    record(data: {
        model: string;
        inputTokens: number;
        outputTokens: number;
        contextSize: number;
        sessionName?: string;
    }): UsageEvent {
        const compaction = this.detectCompaction(data.contextSize);
        const cost = this.estimateCost(data.model, data.inputTokens, data.outputTokens);

        const event: UsageEvent = {
            timestamp: Date.now(),
            model: data.model,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            contextSize: data.contextSize,
            cost,
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

    /** The configured model rates. */
    get modelRates(): Record<string, { input: number; output: number }> {
        return this.rates;
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
        let cost = 0;
        let messageCount = 0;

        for (let i = 0; i < this.count; i++) {
            const idx = (this.head - this.count + i + this.capacity) % this.capacity;
            const event = this.buffer[idx];
            if (event && predicate(event)) {
                inputTokens += event.inputTokens;
                outputTokens += event.outputTokens;
                cost += event.cost;
                messageCount++;
            }
        }

        return { inputTokens, outputTokens, cost, messageCount };
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
