import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tracker } from "../src/tracker.js";

// ---------- Ring Buffer (P4-T1) ----------

describe("Ring buffer", () => {
    it("stores events up to capacity", () => {
        const tracker = new Tracker({ capacity: 5 });
        for (let i = 0; i < 5; i++) {
            tracker.record({ model: "claude-sonnet-4", inputTokens: 100, outputTokens: 50, contextSize: 1000 });
        }
        expect(tracker.size).toBe(5);
    });

    it("overwrites oldest events when full", () => {
        const tracker = new Tracker({ capacity: 3 });
        for (let i = 1; i <= 5; i++) {
            tracker.record({ model: "claude-sonnet-4", inputTokens: i * 100, outputTokens: 50, contextSize: 1000 });
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
        tracker.record({ model: "m1", inputTokens: 10, outputTokens: 5, contextSize: 100 });
        tracker.record({ model: "m2", inputTokens: 20, outputTokens: 10, contextSize: 200 });
        tracker.record({ model: "m3", inputTokens: 30, outputTokens: 15, contextSize: 300 });

        const events = tracker.query();
        expect(events.map((e) => e.model)).toEqual(["m1", "m2", "m3"]);
    });

    it("query with predicate filters events", () => {
        const tracker = new Tracker({ capacity: 10 });
        tracker.record({ model: "a", inputTokens: 100, outputTokens: 50, contextSize: 1000 });
        tracker.record({ model: "b", inputTokens: 200, outputTokens: 100, contextSize: 2000 });
        tracker.record({ model: "a", inputTokens: 300, outputTokens: 150, contextSize: 3000 });

        const filtered = tracker.query((e) => e.model === "a");
        expect(filtered).toHaveLength(2);
        expect(filtered[0].inputTokens).toBe(100);
        expect(filtered[1].inputTokens).toBe(300);
    });

    it("uses default capacity of 1000", () => {
        const tracker = new Tracker();
        // Just verify it doesn't crash with many events
        for (let i = 0; i < 1200; i++) {
            tracker.record({ model: "m", inputTokens: 1, outputTokens: 1, contextSize: 100 });
        }
        expect(tracker.size).toBe(1000);
    });
});

// ---------- Cost Estimation (P4-T3) ----------

describe("Cost estimation", () => {
    it("calculates cost using default rates", () => {
        const tracker = new Tracker();
        // claude-sonnet-4: input 3.0/M, output 15.0/M
        const cost = tracker.estimateCost("claude-sonnet-4", 1_000_000, 1_000_000);
        expect(cost).toBeCloseTo(18.0); // 3 + 15
    });

    it("calculates cost for fractional token counts", () => {
        const tracker = new Tracker();
        // 500 input, 200 output for claude-sonnet-4
        const cost = tracker.estimateCost("claude-sonnet-4", 500, 200);
        // (500 * 3 + 200 * 15) / 1_000_000 = (1500 + 3000) / 1_000_000 = 0.0045
        expect(cost).toBeCloseTo(0.0045);
    });

    it("returns 0 for unknown models", () => {
        const tracker = new Tracker();
        expect(tracker.estimateCost("unknown-model", 1000, 500)).toBe(0);
    });

    it("uses custom rates when provided", () => {
        const tracker = new Tracker({
            rates: { "custom-model": { input: 10.0, output: 20.0 } },
        });
        const cost = tracker.estimateCost("custom-model", 1_000_000, 1_000_000);
        expect(cost).toBeCloseTo(30.0);
    });

    it("custom rates merge with defaults", () => {
        const tracker = new Tracker({
            rates: { "custom-model": { input: 5.0, output: 10.0 } },
        });
        // Default rate still works
        expect(tracker.estimateCost("claude-sonnet-4", 1_000_000, 0)).toBeCloseTo(3.0);
        // Custom rate works too
        expect(tracker.estimateCost("custom-model", 1_000_000, 0)).toBeCloseTo(5.0);
    });

    it("record() includes computed cost on the event", () => {
        const tracker = new Tracker();
        const event = tracker.record({
            model: "claude-sonnet-4",
            inputTokens: 1000,
            outputTokens: 500,
            contextSize: 5000,
        });
        // (1000*3 + 500*15) / 1_000_000 = (3000 + 7500) / 1_000_000 = 0.0105
        expect(event.cost).toBeCloseTo(0.0105);
    });
});

// ---------- Compaction Detection (P4-T5) ----------

describe("Compaction detection", () => {
    it("flags compaction when context drops >30%", () => {
        const tracker = new Tracker({ capacity: 10 });
        tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        const event = tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 30_000 });
        expect(event.compaction).toBe(true);
    });

    it("does NOT flag compaction for small drops", () => {
        const tracker = new Tracker({ capacity: 10 });
        tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        const event = tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 80_000 });
        expect(event.compaction).toBe(false);
    });

    it("does NOT flag compaction on first event", () => {
        const tracker = new Tracker({ capacity: 10 });
        const event = tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 50_000 });
        expect(event.compaction).toBe(false);
    });

    it("does NOT flag compaction when context is zero", () => {
        const tracker = new Tracker({ capacity: 10 });
        tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        const event = tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 0 });
        expect(event.compaction).toBe(false);
    });

    it("correctly flags at the 30% boundary", () => {
        const tracker = new Tracker({ capacity: 10 });
        tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        // Exactly 70% — not compaction (need < 70%)
        const noCompact = tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 70_000 });
        expect(noCompact.compaction).toBe(false);

        // Just under 70% — compaction
        const tracker2 = new Tracker({ capacity: 10 });
        tracker2.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        const compact = tracker2.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 69_999 });
        expect(compact.compaction).toBe(true);
    });

    it("exactly 70% of previous context does NOT trigger compaction", () => {
        // Boundary: newContextSize < lastContextSize * 0.7
        // 70_000 is NOT < 100_000 * 0.7 (70_000), so no compaction
        const tracker = new Tracker({ capacity: 10 });
        tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 100_000 });
        const event = tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 70_000 });
        expect(event.compaction).toBe(false);
    });
});

// ---------- Aggregation (P4-T6) ----------

describe("Aggregation", () => {
    it("today() aggregates events from today (UTC)", () => {
        const tracker = new Tracker({ capacity: 100 });

        // Record a few events (they'll all be "today")
        tracker.record({ model: "claude-sonnet-4", inputTokens: 1000, outputTokens: 500, contextSize: 5000 });
        tracker.record({ model: "claude-sonnet-4", inputTokens: 2000, outputTokens: 1000, contextSize: 8000 });

        const summary = tracker.today();
        expect(summary.inputTokens).toBe(3000);
        expect(summary.outputTokens).toBe(1500);
        expect(summary.messageCount).toBe(2);
        expect(summary.cost).toBeGreaterThan(0);
    });

    it("week() includes events from last 7 days", () => {
        const tracker = new Tracker({ capacity: 100 });
        tracker.record({ model: "claude-sonnet-4", inputTokens: 500, outputTokens: 200, contextSize: 3000 });

        const summary = tracker.week();
        expect(summary.inputTokens).toBe(500);
        expect(summary.outputTokens).toBe(200);
        expect(summary.messageCount).toBe(1);
    });

    it("currentContext() returns latest context size", () => {
        const tracker = new Tracker({ capacity: 10 });
        expect(tracker.currentContext()).toBe(0); // no events yet

        tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 10_000 });
        expect(tracker.currentContext()).toBe(10_000);

        tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 25_000 });
        expect(tracker.currentContext()).toBe(25_000);
    });

    it("empty tracker returns zero summary", () => {
        const tracker = new Tracker();
        const summary = tracker.today();
        expect(summary).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0, messageCount: 0 });
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

        tracker.record({ model: "claude-sonnet-4", inputTokens: 100, outputTokens: 50, contextSize: 5000 });

        // Wait for async write
        await new Promise((r) => setTimeout(r, 100));

        const content = await readFile(logPath, "utf-8");
        const lines = content.trim().split("\n");
        expect(lines).toHaveLength(1);

        const event = JSON.parse(lines[0]);
        expect(event.model).toBe("claude-sonnet-4");
        expect(event.inputTokens).toBe(100);
        expect(event.outputTokens).toBe(50);
    });

    it("appends multiple events", async () => {
        const logPath = join(tmpDir, "usage.jsonl");
        const tracker = new Tracker({ usageLog: logPath });

        tracker.record({ model: "m1", inputTokens: 100, outputTokens: 50, contextSize: 1000 });
        tracker.record({ model: "m2", inputTokens: 200, outputTokens: 100, contextSize: 2000 });

        await new Promise((r) => setTimeout(r, 150));

        const content = await readFile(logPath, "utf-8");
        const lines = content.trim().split("\n");
        expect(lines).toHaveLength(2);
    });

    it("loadLog() replays events from JSONL file", async () => {
        const logPath = join(tmpDir, "usage.jsonl");
        const now = Date.now();

        // Write some events manually
        const events = [
            { timestamp: now - 1000, model: "m1", inputTokens: 100, outputTokens: 50, contextSize: 5000, cost: 0.01, compaction: false },
            { timestamp: now - 500, model: "m2", inputTokens: 200, outputTokens: 100, contextSize: 8000, cost: 0.02, compaction: false },
        ];
        await writeFile(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

        const tracker = new Tracker({ usageLog: logPath, capacity: 100 });
        await tracker.loadLog();

        expect(tracker.size).toBe(2);
        expect(tracker.currentContext()).toBe(8000);
    });

    it("loadLog() skips events older than retentionDays", async () => {
        const logPath = join(tmpDir, "usage.jsonl");
        const now = Date.now();
        const oldTimestamp = now - 60 * 86_400_000; // 60 days ago

        const events = [
            { timestamp: oldTimestamp, model: "old", inputTokens: 100, outputTokens: 50, contextSize: 1000, cost: 0.01, compaction: false },
            { timestamp: now - 1000, model: "recent", inputTokens: 200, outputTokens: 100, contextSize: 2000, cost: 0.02, compaction: false },
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
        await tracker.loadLog(); // should not throw
        expect(tracker.size).toBe(0);
    });

    it("loadLog() skips malformed lines", async () => {
        const logPath = join(tmpDir, "usage.jsonl");
        const now = Date.now();
        const content = [
            JSON.stringify({ timestamp: now, model: "m1", inputTokens: 100, outputTokens: 50, contextSize: 1000, cost: 0.01, compaction: false }),
            "this is not json",
            JSON.stringify({ timestamp: now, model: "m2", inputTokens: 200, outputTokens: 100, contextSize: 2000, cost: 0.02, compaction: false }),
        ].join("\n") + "\n";
        await writeFile(logPath, content);

        const tracker = new Tracker({ usageLog: logPath });
        await tracker.loadLog();
        expect(tracker.size).toBe(2);
    });

    it("creates parent directories for log file", async () => {
        const logPath = join(tmpDir, "deep", "nested", "usage.jsonl");
        const tracker = new Tracker({ usageLog: logPath });

        tracker.record({ model: "m", inputTokens: 100, outputTokens: 50, contextSize: 1000 });

        await new Promise((r) => setTimeout(r, 150));

        const content = await readFile(logPath, "utf-8");
        expect(content.trim().length).toBeGreaterThan(0);
    });
});

// ---------- Integration: record() end-to-end ----------

describe("record() integration", () => {
    it("returns a complete UsageEvent", () => {
        const tracker = new Tracker();
        const event = tracker.record({
            model: "claude-sonnet-4",
            inputTokens: 1500,
            outputTokens: 800,
            contextSize: 20_000,
        });

        expect(event.timestamp).toBeGreaterThan(0);
        expect(event.model).toBe("claude-sonnet-4");
        expect(event.inputTokens).toBe(1500);
        expect(event.outputTokens).toBe(800);
        expect(event.contextSize).toBe(20_000);
        expect(event.cost).toBeGreaterThan(0);
        expect(event.compaction).toBe(false);
    });

    it("cost is included in aggregation", () => {
        const tracker = new Tracker();
        tracker.record({ model: "claude-sonnet-4", inputTokens: 1_000_000, outputTokens: 500_000, contextSize: 50_000 });

        const summary = tracker.today();
        // input: 1M * 3/M = $3.00, output: 500K * 15/M = $7.50, total = $10.50
        expect(summary.cost).toBeCloseTo(10.5);
    });
});
