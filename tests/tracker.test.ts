import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tracker } from "../src/tracker.js";

/** Helper to create a minimal record call with cache fields defaulting to 0. */
function rec(tracker: Tracker, data: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    contextSize: number;
    cost?: number;
    sessionName?: string;
}) {
    return tracker.record({
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
        ...data,
    });
}

// ---------- Ring Buffer (P4-T1) ----------

describe("Ring buffer", () => {
    it("stores events up to capacity", () => {
        const tracker = new Tracker({ capacity: 5 });
        for (let i = 0; i < 5; i++) {
            rec(tracker, { model: "claude-sonnet-4", inputTokens: 100, outputTokens: 50, contextSize: 1000 });
        }
        expect(tracker.size).toBe(5);
    });

    it("overwrites oldest events when full", () => {
        const tracker = new Tracker({ capacity: 3 });
        for (let i = 1; i <= 5; i++) {
            rec(tracker, { model: "claude-sonnet-4", inputTokens: i * 100, outputTokens: 50, contextSize: 1000 });
        }
        expect(tracker.size).toBe(3);
        const events = tracker.query();
        // Should have events 3, 4, 5 (oldest 1, 2 overwritten)
        expect(events[0].inputTokens).toBe(300);
        expect(events[1].inputTokens).toBe(400);
        expect(events[2].inputTokens).toBe(500);
    });

    it("query returns events in oldest-first order", () => {
        const tracker = new Tracker({ capacity: 10 });
        rec(tracker, { model: "m1", inputTokens: 10, outputTokens: 5, contextSize: 100 });
        rec(tracker, { model: "m2", inputTokens: 20, outputTokens: 10, contextSize: 200 });
        rec(tracker, { model: "m3", inputTokens: 30, outputTokens: 15, contextSize: 300 });

        const events = tracker.query();
        expect(events.map((e) => e.model)).toEqual(["m1", "m2", "m3"]);
    });

    it("query with predicate filters events", () => {
        const tracker = new Tracker({ capacity: 10 });
        rec(tracker, { model: "a", inputTokens: 100, outputTokens: 50, contextSize: 1000 });
        rec(tracker, { model: "b", inputTokens: 200, outputTokens: 100, contextSize: 2000 });
        rec(tracker, { model: "a", inputTokens: 300, outputTokens: 150, contextSize: 3000 });

        const filtered = tracker.query((e) => e.model === "a");
        expect(filtered).toHaveLength(2);
        expect(filtered[0].inputTokens).toBe(100);
        expect(filtered[1].inputTokens).toBe(300);
    });

    it("uses default capacity of 1000", () => {
        const tracker = new Tracker();
        // Just verify it doesn't crash with many events
        for (let i = 0; i < 1200; i++) {
            rec(tracker, { model: "m", inputTokens: 1, outputTokens: 1, contextSize: 100 });
        }
        expect(tracker.size).toBe(1000);
    });
});

// ---------- Cost from API (replaces estimation) ----------

describe("Cost tracking", () => {
    it("uses API-provided cost directly", () => {
        const tracker = new Tracker();
        const event = rec(tracker, {
            model: "claude-sonnet-4",
            inputTokens: 1000,
            outputTokens: 500,
            contextSize: 5000,
            cost: 0.0105,
        });
        expect(event.cost).toBeCloseTo(0.0105);
    });

    it("defaults cost to 0 when not provided", () => {
        const tracker = new Tracker();
        const event = rec(tracker, {
            model: "unknown-model",
            inputTokens: 1000,
            outputTokens: 500,
            contextSize: 5000,
        });
        expect(event.cost).toBe(0);
    });

    it("cost is included in aggregation", () => {
        const tracker = new Tracker();
        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 1000, cost: 1.50 });
        rec(tracker, { model: "m", inputTokens: 200, outputTokens: 100, contextSize: 2000, cost: 2.50 });

        const summary = tracker.today();
        expect(summary.cost).toBeCloseTo(4.0);
    });
});

// ---------- Cache token tracking ----------

describe("Cache token tracking", () => {
    it("tracks cache read and write tokens separately", () => {
        const tracker = new Tracker({ capacity: 10 });
        const event = rec(tracker, {
            model: "m",
            inputTokens: 10,
            outputTokens: 50,
            cacheReadTokens: 5000,
            cacheWriteTokens: 1000,
            contextSize: 6060,
            cost: 0.05,
        });
        expect(event.inputTokens).toBe(10);
        expect(event.outputTokens).toBe(50);
        expect(event.cacheReadTokens).toBe(5000);
        expect(event.cacheWriteTokens).toBe(1000);
    });

    it("aggregates cache tokens in summaries", () => {
        const tracker = new Tracker({ capacity: 100 });
        rec(tracker, { model: "m", inputTokens: 5, outputTokens: 100, cacheReadTokens: 3000, cacheWriteTokens: 500, contextSize: 3605, cost: 0.01 });
        rec(tracker, { model: "m", inputTokens: 3, outputTokens: 200, cacheReadTokens: 4000, cacheWriteTokens: 300, contextSize: 4503, cost: 0.02 });

        const summary = tracker.today();
        expect(summary.inputTokens).toBe(8);
        expect(summary.outputTokens).toBe(300);
        expect(summary.cacheReadTokens).toBe(7000);
        expect(summary.cacheWriteTokens).toBe(800);
        expect(summary.cost).toBeCloseTo(0.03);
        expect(summary.messageCount).toBe(2);
    });
});

// ---------- Compaction Detection (P4-T5) ----------

describe("Compaction detection", () => {
    it("flags compaction when context drops >30%", () => {
        const tracker = new Tracker({ capacity: 10 });
        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        const event = rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 30_000 });
        expect(event.compaction).toBe(true);
    });

    it("does NOT flag compaction for small drops", () => {
        const tracker = new Tracker({ capacity: 10 });
        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        const event = rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 80_000 });
        expect(event.compaction).toBe(false);
    });

    it("does NOT flag compaction on first event", () => {
        const tracker = new Tracker({ capacity: 10 });
        const event = rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 50_000 });
        expect(event.compaction).toBe(false);
    });

    it("does NOT flag compaction when context is zero", () => {
        const tracker = new Tracker({ capacity: 10 });
        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        const event = rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 0 });
        expect(event.compaction).toBe(false);
    });

    it("correctly flags at the 30% boundary", () => {
        const tracker = new Tracker({ capacity: 10 });
        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        // Exactly 70% — not compaction (need < 70%)
        const noCompact = rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 70_000 });
        expect(noCompact.compaction).toBe(false);

        // Just under 70% — compaction
        const tracker2 = new Tracker({ capacity: 10 });
        rec(tracker2, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        const compact = rec(tracker2, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 69_999 });
        expect(compact.compaction).toBe(true);
    });

    it("exactly 70% of previous context does NOT trigger compaction", () => {
        const tracker = new Tracker({ capacity: 10 });
        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        const event = rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 70_000 });
        expect(event.compaction).toBe(false);
    });
});

// ---------- Aggregation (P4-T6) ----------

describe("Aggregation", () => {
    it("today() aggregates events from today (UTC)", () => {
        const tracker = new Tracker({ capacity: 100 });
        rec(tracker, { model: "m", inputTokens: 10, outputTokens: 500, cacheReadTokens: 1000, cacheWriteTokens: 200, contextSize: 5000, cost: 0.05 });
        rec(tracker, { model: "m", inputTokens: 5, outputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 300, contextSize: 8000, cost: 0.10 });

        const summary = tracker.today();
        expect(summary.inputTokens).toBe(15);
        expect(summary.outputTokens).toBe(1500);
        expect(summary.cacheReadTokens).toBe(3000);
        expect(summary.cacheWriteTokens).toBe(500);
        expect(summary.messageCount).toBe(2);
        expect(summary.cost).toBeCloseTo(0.15);
    });

    it("week() includes events from last 7 days", () => {
        const tracker = new Tracker({ capacity: 100 });
        rec(tracker, { model: "m", inputTokens: 5, outputTokens: 200, contextSize: 3000, cost: 0.03 });

        const summary = tracker.week();
        expect(summary.inputTokens).toBe(5);
        expect(summary.outputTokens).toBe(200);
        expect(summary.messageCount).toBe(1);
    });

    it("currentContext() returns latest context size", () => {
        const tracker = new Tracker({ capacity: 10 });
        expect(tracker.currentContext()).toBe(0);

        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 10_000 });
        expect(tracker.currentContext()).toBe(10_000);

        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 25_000 });
        expect(tracker.currentContext()).toBe(25_000);
    });

    it("empty tracker returns zero summary", () => {
        const tracker = new Tracker();
        const summary = tracker.today();
        expect(summary).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, messageCount: 0 });
    });
});

// ---------- JSONL Persistence (P4-T7) ----------

describe("JSONL persistence", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = join(tmpdir(), `tracker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it("writes events to JSONL file", async () => {
        const logPath = join(tmpDir, "usage.jsonl");
        const tracker = new Tracker({ usageLog: logPath });

        rec(tracker, { model: "claude-sonnet-4", inputTokens: 100, outputTokens: 50, contextSize: 5000, cost: 0.01 });

        await new Promise((r) => setTimeout(r, 100));

        const content = await readFile(logPath, "utf-8");
        const lines = content.trim().split("\n");
        expect(lines).toHaveLength(1);

        const event = JSON.parse(lines[0]);
        expect(event.model).toBe("claude-sonnet-4");
        expect(event.inputTokens).toBe(100);
        expect(event.outputTokens).toBe(50);
        expect(event.cacheReadTokens).toBe(0);
        expect(event.cacheWriteTokens).toBe(0);
    });

    it("appends multiple events", async () => {
        const logPath = join(tmpDir, "usage.jsonl");
        const tracker = new Tracker({ usageLog: logPath });

        rec(tracker, { model: "m1", inputTokens: 100, outputTokens: 50, contextSize: 1000 });
        rec(tracker, { model: "m2", inputTokens: 200, outputTokens: 100, contextSize: 2000 });

        await new Promise((r) => setTimeout(r, 150));

        const content = await readFile(logPath, "utf-8");
        const lines = content.trim().split("\n");
        expect(lines).toHaveLength(2);
    });

    it("loadLog() replays events from JSONL file", async () => {
        const logPath = join(tmpDir, "usage.jsonl");
        const now = Date.now();

        const events = [
            { timestamp: now - 1000, model: "m1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, contextSize: 5000, cost: 0.01, compaction: false },
            { timestamp: now - 500, model: "m2", inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, contextSize: 8000, cost: 0.02, compaction: false },
        ];
        await writeFile(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

        const tracker = new Tracker({ usageLog: logPath, capacity: 100 });
        await tracker.loadLog();

        expect(tracker.size).toBe(2);
        expect(tracker.currentContext()).toBe(8000);
    });

    it("loadLog() backfills cache fields from old log entries", async () => {
        const logPath = join(tmpDir, "usage.jsonl");
        const now = Date.now();

        // Old-format event without cache fields
        const events = [
            { timestamp: now - 1000, model: "m1", inputTokens: 5000, outputTokens: 200, contextSize: 5200, cost: 0.05, compaction: false },
        ];
        await writeFile(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

        const tracker = new Tracker({ usageLog: logPath, capacity: 100 });
        await tracker.loadLog();

        const loaded = tracker.query();
        expect(loaded[0].cacheReadTokens).toBe(0);
        expect(loaded[0].cacheWriteTokens).toBe(0);
    });

    it("loadLog() skips events older than retentionDays", async () => {
        const logPath = join(tmpDir, "usage.jsonl");
        const now = Date.now();
        const oldTimestamp = now - 60 * 86_400_000; // 60 days ago

        const events = [
            { timestamp: oldTimestamp, model: "old", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, contextSize: 1000, cost: 0.01, compaction: false },
            { timestamp: now - 1000, model: "recent", inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, contextSize: 2000, cost: 0.02, compaction: false },
        ];
        await writeFile(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

        const tracker = new Tracker({ usageLog: logPath, retentionDays: 30 });
        await tracker.loadLog();

        expect(tracker.size).toBe(1);
        const loaded = tracker.query();
        expect(loaded[0].model).toBe("recent");
    });

    it("loadLog() handles missing file gracefully", async () => {
        const logPath = join(tmpDir, "nonexistent.jsonl");
        const tracker = new Tracker({ usageLog: logPath });
        await tracker.loadLog();
        expect(tracker.size).toBe(0);
    });

    it("loadLog() skips malformed lines", async () => {
        const logPath = join(tmpDir, "usage.jsonl");
        const now = Date.now();
        const content = [
            JSON.stringify({ timestamp: now, model: "m1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, contextSize: 1000, cost: 0.01, compaction: false }),
            "this is not json",
            JSON.stringify({ timestamp: now, model: "m2", inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, contextSize: 2000, cost: 0.02, compaction: false }),
        ].join("\n") + "\n";
        await writeFile(logPath, content);

        const tracker = new Tracker({ usageLog: logPath });
        await tracker.loadLog();
        expect(tracker.size).toBe(2);
    });

    it("creates parent directories for log file", async () => {
        const logPath = join(tmpDir, "deep", "nested", "usage.jsonl");
        const tracker = new Tracker({ usageLog: logPath });

        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 1000 });

        await new Promise((r) => setTimeout(r, 150));

        const content = await readFile(logPath, "utf-8");
        expect(content.trim().length).toBeGreaterThan(0);
    });
});

// ---------- Per-session tracking (P8-T15) ----------

describe("Per-session tracking", () => {
    it("record() stores sessionName on event", () => {
        const tracker = new Tracker({ capacity: 10 });
        const event = rec(tracker, {
            model: "claude-sonnet-4",
            inputTokens: 100,
            outputTokens: 50,
            contextSize: 1000,
            sessionName: "work",
            cost: 0.01,
        });
        expect(event.sessionName).toBe("work");
    });

    it("record() omits sessionName when not provided", () => {
        const tracker = new Tracker({ capacity: 10 });
        const event = rec(tracker, {
            model: "claude-sonnet-4",
            inputTokens: 100,
            outputTokens: 50,
            contextSize: 1000,
        });
        expect(event.sessionName).toBeUndefined();
    });

    it("todayBySession() filters events by session name", () => {
        const tracker = new Tracker({ capacity: 100 });
        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 1000, sessionName: "main", cost: 0.01 });
        rec(tracker, { model: "m", inputTokens: 200, outputTokens: 100, contextSize: 2000, sessionName: "work", cost: 0.02 });
        rec(tracker, { model: "m", inputTokens: 300, outputTokens: 150, contextSize: 3000, sessionName: "main", cost: 0.03 });
        rec(tracker, { model: "m", inputTokens: 400, outputTokens: 200, contextSize: 4000, cost: 0.04 }); // no session

        const mainUsage = tracker.todayBySession("main");
        expect(mainUsage.inputTokens).toBe(400); // 100 + 300
        expect(mainUsage.outputTokens).toBe(200); // 50 + 150
        expect(mainUsage.messageCount).toBe(2);

        const workUsage = tracker.todayBySession("work");
        expect(workUsage.inputTokens).toBe(200);
        expect(workUsage.outputTokens).toBe(100);
        expect(workUsage.messageCount).toBe(1);
    });

    it("todayBySession() returns zeros for unknown session", () => {
        const tracker = new Tracker({ capacity: 10 });
        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 1000, sessionName: "main" });

        const result = tracker.todayBySession("nonexistent");
        expect(result).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, messageCount: 0 });
    });

    it("todayBySession() only counts today's events", () => {
        const tracker = new Tracker({ capacity: 100 });
        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 1000, sessionName: "main", cost: 0.01 });

        const result = tracker.todayBySession("main");
        expect(result.messageCount).toBe(1);
        expect(result.inputTokens).toBe(100);
    });

    it("today() still includes all sessions", () => {
        const tracker = new Tracker({ capacity: 100 });
        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 1000, sessionName: "main" });
        rec(tracker, { model: "m", inputTokens: 200, outputTokens: 100, contextSize: 2000, sessionName: "work" });

        const total = tracker.today();
        expect(total.inputTokens).toBe(300);
        expect(total.messageCount).toBe(2);
    });

    it("sessionName persists through JSONL round-trip", async () => {
        const logPath = join(tmpdir(), `tracker-session-${Date.now()}-${Math.random().toString(36).slice(2)}`, "usage.jsonl");
        const tracker = new Tracker({ usageLog: logPath, capacity: 10 });

        rec(tracker, { model: "m", inputTokens: 100, outputTokens: 50, contextSize: 1000, sessionName: "work" });

        await new Promise((r) => setTimeout(r, 150));

        const tracker2 = new Tracker({ usageLog: logPath, capacity: 10 });
        await tracker2.loadLog();

        const events = tracker2.query();
        expect(events).toHaveLength(1);
        expect(events[0].sessionName).toBe("work");

        await rm(join(logPath, ".."), { recursive: true, force: true });
    });
});

// ---------- Integration: record() end-to-end ----------

describe("record() integration", () => {
    it("returns a complete UsageEvent", () => {
        const tracker = new Tracker();
        const event = rec(tracker, {
            model: "claude-sonnet-4",
            inputTokens: 15,
            outputTokens: 800,
            cacheReadTokens: 1200,
            cacheWriteTokens: 285,
            contextSize: 20_000,
            cost: 0.0105,
        });

        expect(event.timestamp).toBeGreaterThan(0);
        expect(event.model).toBe("claude-sonnet-4");
        expect(event.inputTokens).toBe(15);
        expect(event.outputTokens).toBe(800);
        expect(event.cacheReadTokens).toBe(1200);
        expect(event.cacheWriteTokens).toBe(285);
        expect(event.contextSize).toBe(20_000);
        expect(event.cost).toBeCloseTo(0.0105);
        expect(event.compaction).toBe(false);
    });
});
