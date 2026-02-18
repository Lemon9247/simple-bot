import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Heartbeat } from "../src/heartbeat.js";
import { readFile } from "node:fs/promises";
import cron from "node-cron";

vi.mock("node:fs/promises");
vi.mock("node-cron");

describe("Heartbeat", () => {
    let scheduleCb: (() => void) | null;
    let mockTask: { stop: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.clearAllMocks();
        scheduleCb = null;
        mockTask = { stop: vi.fn() };

        vi.mocked(cron.validate).mockReturnValue(true);
        vi.mocked(cron.schedule).mockImplementation((_, cb) => {
            scheduleCb = cb as () => void;
            return mockTask as any;
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("validates cron expression on construction", () => {
        vi.mocked(cron.validate).mockReturnValue(false);

        const mockBridge = { sendMessage: vi.fn() } as any;
        const config = {
            enabled: true,
            schedule: "bad expression",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        expect(() => new Heartbeat(config, mockBridge)).toThrow("Invalid cron schedule");
    });

    it("schedules cron task on start", () => {
        const mockBridge = { sendMessage: vi.fn() } as any;
        const config = {
            enabled: true,
            schedule: "*/10 * * * *",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        const heartbeat = new Heartbeat(config, mockBridge);
        heartbeat.start();

        expect(cron.schedule).toHaveBeenCalledWith("*/10 * * * *", expect.any(Function));
    });

    it("reads checklist and sends to bridge when cron fires", async () => {
        const mockBridge = {
            sendMessage: vi.fn().mockResolvedValue(""),
        } as any;

        const config = {
            enabled: true,
            schedule: "0 7 * * *",
            checklist: "/path/to/HEARTBEAT.md",
            notify_room: "#test:server",
        };

        const checklistContent = "# Heartbeat\n- Task 1\n- Task 2";
        vi.mocked(readFile).mockResolvedValue(checklistContent);

        const heartbeat = new Heartbeat(config, mockBridge);
        heartbeat.start();

        // Simulate cron firing
        await scheduleCb!();

        expect(readFile).toHaveBeenCalledWith("/path/to/HEARTBEAT.md", "utf-8");
        expect(mockBridge.sendMessage).toHaveBeenCalledWith(checklistContent);
    });

    it("emits response event when bridge returns non-empty response", async () => {
        const mockBridge = {
            sendMessage: vi.fn().mockResolvedValue("Pi has something to say!"),
        } as any;

        const config = {
            enabled: true,
            schedule: "0 7 * * *",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        vi.mocked(readFile).mockResolvedValue("test content");

        const heartbeat = new Heartbeat(config, mockBridge);
        const responseHandler = vi.fn();
        heartbeat.on("response", responseHandler);
        heartbeat.start();

        await scheduleCb!();

        expect(responseHandler).toHaveBeenCalledWith("Pi has something to say!");
    });

    it("does not emit response event when bridge returns empty response", async () => {
        const mockBridge = {
            sendMessage: vi.fn().mockResolvedValue("   "),
        } as any;

        const config = {
            enabled: true,
            schedule: "0 7 * * *",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        vi.mocked(readFile).mockResolvedValue("test content");

        const heartbeat = new Heartbeat(config, mockBridge);
        const responseHandler = vi.fn();
        heartbeat.on("response", responseHandler);
        heartbeat.start();

        await scheduleCb!();

        expect(responseHandler).not.toHaveBeenCalled();
    });

    it("stops cron task when stop() is called", () => {
        const mockBridge = { sendMessage: vi.fn() } as any;
        const config = {
            enabled: true,
            schedule: "0 7 * * *",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        const heartbeat = new Heartbeat(config, mockBridge);
        heartbeat.start();
        heartbeat.stop();

        expect(mockTask.stop).toHaveBeenCalled();
    });

    it("does not start twice", () => {
        const mockBridge = { sendMessage: vi.fn() } as any;
        const config = {
            enabled: true,
            schedule: "0 7 * * *",
            checklist: "/tmp/test.md",
            notify_room: "#test:server",
        };

        const heartbeat = new Heartbeat(config, mockBridge);
        heartbeat.start();
        heartbeat.start();

        expect(cron.schedule).toHaveBeenCalledTimes(1);
    });
});
