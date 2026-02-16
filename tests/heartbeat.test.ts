import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Heartbeat, parseInterval, isWithinActiveHours } from "../src/heartbeat.js";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

vi.mock("node:fs/promises");

describe("Heartbeat", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("starts and fires timer at correct interval", async () => {
        const mockBridge = {
            sendMessage: vi.fn().mockResolvedValue(""),
        } as any;

        const config = {
            enabled: true,
            interval: "30m",
            active_hours: "00:00-23:59",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        vi.mocked(readFile).mockResolvedValue("test checklist content");

        const heartbeat = new Heartbeat(config, mockBridge);
        heartbeat.start();

        // Should not fire immediately
        expect(mockBridge.sendMessage).not.toHaveBeenCalled();

        // Advance 30 minutes
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

        expect(mockBridge.sendMessage).toHaveBeenCalledWith("test checklist content");
        expect(mockBridge.sendMessage).toHaveBeenCalledTimes(1);

        // Advance another 30 minutes
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

        expect(mockBridge.sendMessage).toHaveBeenCalledTimes(2);

        heartbeat.stop();
    });

    it("respects active hours - sends during active hours", async () => {
        const mockBridge = {
            sendMessage: vi.fn().mockResolvedValue(""),
        } as any;

        const config = {
            enabled: true,
            interval: "1h",
            active_hours: "09:00-17:00",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        vi.mocked(readFile).mockResolvedValue("test content");

        // Set time to 12:00 (within active hours)
        vi.setSystemTime(new Date("2026-02-16T12:00:00"));

        const heartbeat = new Heartbeat(config, mockBridge);
        heartbeat.start();

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

        expect(mockBridge.sendMessage).toHaveBeenCalledWith("test content");

        heartbeat.stop();
    });

    it("respects active hours - skips outside active hours", async () => {
        const mockBridge = {
            sendMessage: vi.fn().mockResolvedValue(""),
        } as any;

        const config = {
            enabled: true,
            interval: "1h",
            active_hours: "09:00-17:00",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        vi.mocked(readFile).mockResolvedValue("test content");

        // Set time to 22:00 (outside active hours)
        vi.setSystemTime(new Date("2026-02-16T22:00:00"));

        const heartbeat = new Heartbeat(config, mockBridge);
        heartbeat.start();

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

        // Should not have sent message
        expect(mockBridge.sendMessage).not.toHaveBeenCalled();

        heartbeat.stop();
    });

    it("reads checklist file and sends contents", async () => {
        const mockBridge = {
            sendMessage: vi.fn().mockResolvedValue(""),
        } as any;

        const config = {
            enabled: true,
            interval: "1h",
            active_hours: "00:00-23:59",
            checklist: "/path/to/HEARTBEAT.md",
            notify_room: "#test:server",
        };

        const checklistContent = "# Heartbeat\n- Task 1\n- Task 2";
        vi.mocked(readFile).mockResolvedValue(checklistContent);

        const heartbeat = new Heartbeat(config, mockBridge);
        heartbeat.start();

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

        expect(readFile).toHaveBeenCalledWith("/path/to/HEARTBEAT.md", "utf-8");
        expect(mockBridge.sendMessage).toHaveBeenCalledWith(checklistContent);

        heartbeat.stop();
    });

    it("emits response event when bridge returns non-empty response", async () => {
        const mockBridge = {
            sendMessage: vi.fn().mockResolvedValue("Pi has something to say!"),
        } as any;

        const config = {
            enabled: true,
            interval: "1h",
            active_hours: "00:00-23:59",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        vi.mocked(readFile).mockResolvedValue("test content");

        const heartbeat = new Heartbeat(config, mockBridge);
        
        const responseHandler = vi.fn();
        heartbeat.on("response", responseHandler);

        heartbeat.start();

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

        expect(responseHandler).toHaveBeenCalledWith("Pi has something to say!");

        heartbeat.stop();
    });

    it("does not emit response event when bridge returns empty response", async () => {
        const mockBridge = {
            sendMessage: vi.fn().mockResolvedValue("   "),
        } as any;

        const config = {
            enabled: true,
            interval: "1h",
            active_hours: "00:00-23:59",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        vi.mocked(readFile).mockResolvedValue("test content");

        const heartbeat = new Heartbeat(config, mockBridge);
        
        const responseHandler = vi.fn();
        heartbeat.on("response", responseHandler);

        heartbeat.start();

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

        expect(responseHandler).not.toHaveBeenCalled();

        heartbeat.stop();
    });

    it("stops timer when stop() is called", async () => {
        const mockBridge = {
            sendMessage: vi.fn().mockResolvedValue(""),
        } as any;

        const config = {
            enabled: true,
            interval: "1h",
            active_hours: "00:00-23:59",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        vi.mocked(readFile).mockResolvedValue("test content");

        const heartbeat = new Heartbeat(config, mockBridge);
        heartbeat.start();

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(mockBridge.sendMessage).toHaveBeenCalledTimes(1);

        heartbeat.stop();

        // Advance more time - should not fire again
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(mockBridge.sendMessage).toHaveBeenCalledTimes(1);
    });
});

describe("parseInterval", () => {
    it("parses hours correctly", () => {
        expect(parseInterval("4h")).toBe(4 * 60 * 60 * 1000);
        expect(parseInterval("1h")).toBe(60 * 60 * 1000);
        expect(parseInterval("24h")).toBe(24 * 60 * 60 * 1000);
    });

    it("parses minutes correctly", () => {
        expect(parseInterval("30m")).toBe(30 * 60 * 1000);
        expect(parseInterval("1m")).toBe(60 * 1000);
        expect(parseInterval("90m")).toBe(90 * 60 * 1000);
    });

    it("parses combined hours and minutes", () => {
        expect(parseInterval("1h30m")).toBe(90 * 60 * 1000);
        expect(parseInterval("2h15m")).toBe(135 * 60 * 1000);
    });

    it("throws error on invalid format", () => {
        expect(() => parseInterval("invalid")).toThrow("Invalid interval format");
        expect(() => parseInterval("")).toThrow("Invalid interval format");
        expect(() => parseInterval("4")).toThrow("Invalid interval format");
    });
});

describe("isWithinActiveHours", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns true when time is within active hours", () => {
        // Set time to 12:00
        vi.setSystemTime(new Date("2026-02-16T12:00:00"));
        expect(isWithinActiveHours("08:00-23:00")).toBe(true);
    });

    it("returns false when time is before active hours", () => {
        // Set time to 06:00
        vi.setSystemTime(new Date("2026-02-16T06:00:00"));
        expect(isWithinActiveHours("08:00-23:00")).toBe(false);
    });

    it("returns false when time is after active hours", () => {
        // Set time to 23:30
        vi.setSystemTime(new Date("2026-02-16T23:30:00"));
        expect(isWithinActiveHours("08:00-23:00")).toBe(false);
    });

    it("returns true when time is exactly at start of active hours", () => {
        // Set time to 08:00
        vi.setSystemTime(new Date("2026-02-16T08:00:00"));
        expect(isWithinActiveHours("08:00-23:00")).toBe(true);
    });

    it("returns true when time is exactly at end of active hours", () => {
        // Set time to 23:00
        vi.setSystemTime(new Date("2026-02-16T23:00:00"));
        expect(isWithinActiveHours("08:00-23:00")).toBe(true);
    });

    it("handles edge case of all-day active hours", () => {
        // Set time to 03:00
        vi.setSystemTime(new Date("2026-02-16T03:00:00"));
        expect(isWithinActiveHours("00:00-23:59")).toBe(true);
    });

    it("throws error on invalid format", () => {
        expect(() => isWithinActiveHours("invalid")).toThrow("Invalid active_hours format");
        expect(() => isWithinActiveHours("08:00")).toThrow("Invalid active_hours format");
    });
});
