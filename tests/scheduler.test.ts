import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "../src/scheduler.js";
import type { CronConfig } from "../src/types.js";
import cron from "node-cron";

vi.mock("node-cron");

function makeBridge(overrides: Record<string, any> = {}) {
    return {
        busy: false,
        command: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue("agent response"),
        ...overrides,
    } as any;
}

describe("Scheduler", () => {
    let cronDir: string;
    let scheduledCallbacks: Map<string, () => void>;
    let mockTasks: Map<string, { stop: ReturnType<typeof vi.fn> }>;

    beforeEach(async () => {
        vi.clearAllMocks();
        cronDir = await mkdtemp(join(tmpdir(), "cron-test-"));
        scheduledCallbacks = new Map();
        mockTasks = new Map();

        vi.mocked(cron.validate).mockReturnValue(true);
        vi.mocked(cron.schedule).mockImplementation((schedule, cb) => {
            const key = `${schedule}-${Math.random()}`;
            scheduledCallbacks.set(key, cb as () => void);
            const task = { stop: vi.fn() };
            mockTasks.set(key, task);
            return task as any;
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(cronDir, { recursive: true, force: true });
    });

    async function writeJob(name: string, content: string) {
        await writeFile(join(cronDir, `${name}.md`), content);
    }

    function getLastScheduledCallback() {
        const entries = [...scheduledCallbacks.entries()];
        return entries[entries.length - 1]?.[1];
    }

    it("loads all job files on start", async () => {
        await writeJob("morning", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);
        await writeJob("evening", `---
schedule: "0 17 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge();
        const config: CronConfig = { dir: cronDir };
        const scheduler = new Scheduler(config, bridge);
        await scheduler.start();

        expect(cron.schedule).toHaveBeenCalledTimes(2);
        expect(scheduler.getJobs().size).toBe(2);

        scheduler.stop();
    });

    it("skips disabled jobs", async () => {
        await writeJob("disabled", `---
schedule: "0 7 * * *"
enabled: false
steps:
  - compact
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        expect(scheduler.getJobs().size).toBe(0);

        scheduler.stop();
    });

    it("skips invalid job files gracefully", async () => {
        await writeJob("bad", "not a valid job file at all");
        await writeJob("good", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        expect(scheduler.getJobs().size).toBe(1);

        scheduler.stop();
    });

    it("ignores non-.md files", async () => {
        await writeFile(join(cronDir, "notes.txt"), "not a job");
        await writeJob("real", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        expect(scheduler.getJobs().size).toBe(1);

        scheduler.stop();
    });

    it("executes new-session step", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - new-session
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        const cb = getLastScheduledCallback()!;
        await cb();

        expect(bridge.command).toHaveBeenCalledWith("new_session");

        scheduler.stop();
    });

    it("executes compact step", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(bridge.command).toHaveBeenCalledWith("compact");

        scheduler.stop();
    });

    it("executes model step with fuzzy match", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - model: haiku
---`);

        const bridge = makeBridge({
            command: vi.fn().mockImplementation((type: string) => {
                if (type === "get_available_models") {
                    return Promise.resolve({
                        models: [
                            { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
                            { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
                        ],
                    });
                }
                return Promise.resolve(undefined);
            }),
        });

        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(bridge.command).toHaveBeenCalledWith("set_model", {
            provider: "anthropic",
            modelId: "claude-haiku-4-5",
        });

        scheduler.stop();
    });

    it("fails model step when no match found", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - model: nonexistent
  - compact
---`);

        const bridge = makeBridge({
            command: vi.fn().mockImplementation((type: string) => {
                if (type === "get_available_models") {
                    return Promise.resolve({ models: [] });
                }
                return Promise.resolve(undefined);
            }),
        });

        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        // Should not throw (caught internally), but compact should NOT run
        await getLastScheduledCallback()!();

        // Only get_available_models was called, not compact
        expect(bridge.command).toHaveBeenCalledTimes(1);
        expect(bridge.command).toHaveBeenCalledWith("get_available_models");

        scheduler.stop();
    });

    it("executes prompt step and emits response", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - prompt
---

Do the thing.`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        const responses: any[] = [];
        scheduler.on("response", (r: any) => responses.push(r));
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(bridge.sendMessage).toHaveBeenCalledWith("[CRON:test] Do the thing.");
        expect(responses).toHaveLength(1);
        expect(responses[0].response).toBe("agent response");
        expect(responses[0].job.name).toBe("test");

        scheduler.stop();
    });

    it("does not emit response for empty agent reply", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - prompt
---

Do the thing.`);

        const bridge = makeBridge({ sendMessage: vi.fn().mockResolvedValue("   ") });
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        const responses: any[] = [];
        scheduler.on("response", (r: any) => responses.push(r));
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(responses).toHaveLength(0);

        scheduler.stop();
    });

    it("executes reload step", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - reload
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(bridge.command).toHaveBeenCalledWith("prompt", { message: "/reload-runtime" });

        scheduler.stop();
    });

    it("executes steps in order", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - new-session
  - compact
  - reload
---`);

        const callOrder: Array<{ type: string; args?: any }> = [];
        const bridge = makeBridge({
            command: vi.fn().mockImplementation((type: string, args?: any) => {
                callOrder.push({ type, args });
                return Promise.resolve(undefined);
            }),
        });

        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(callOrder).toEqual([
            { type: "new_session", args: undefined },
            { type: "compact", args: undefined },
            { type: "prompt", args: { message: "/reload-runtime" } },
        ]);

        scheduler.stop();
    });

    it("aborts remaining steps on failure", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - new-session
  - compact
---`);

        const bridge = makeBridge({
            command: vi.fn().mockRejectedValueOnce(new Error("boom")),
        });

        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        // Should not throw
        await getLastScheduledCallback()!();

        // Only the first command was attempted
        expect(bridge.command).toHaveBeenCalledTimes(1);

        scheduler.stop();
    });

    it("skips job when bridge is busy", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge({ busy: true });
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(bridge.command).not.toHaveBeenCalled();

        scheduler.stop();
    });

    it("stops all cron tasks on stop()", async () => {
        await writeJob("a", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);
        await writeJob("b", `---
schedule: "0 17 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        expect(scheduler.getJobs().size).toBe(2);

        scheduler.stop();

        expect(scheduler.getJobs().size).toBe(0);
        for (const task of mockTasks.values()) {
            expect(task.stop).toHaveBeenCalled();
        }
    });

    it("handles missing cron directory gracefully", async () => {
        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: "/nonexistent/path" }, bridge);

        // Should not throw
        await scheduler.start();
        expect(scheduler.getJobs().size).toBe(0);

        scheduler.stop();
    });

    describe("hot reload", () => {
        it("picks up new job files", async () => {
            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            expect(scheduler.getJobs().size).toBe(0);

            await writeJob("new-job", `---
schedule: "0 12 * * *"
steps:
  - compact
---`);

            // Wait for debounce
            await new Promise((r) => setTimeout(r, 500));

            expect(scheduler.getJobs().size).toBe(1);

            scheduler.stop();
        });

        it("removes jobs when files are deleted", async () => {
            await writeJob("to-delete", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            expect(scheduler.getJobs().size).toBe(1);

            await unlink(join(cronDir, "to-delete.md"));

            // Wait for debounce
            await new Promise((r) => setTimeout(r, 500));

            expect(scheduler.getJobs().size).toBe(0);

            scheduler.stop();
        });

        it("reloads modified job files", async () => {
            await writeJob("mutable", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            const jobBefore = scheduler.getJobs().get("mutable")!;
            expect(jobBefore.definition.steps).toEqual([{ type: "compact" }]);

            // Modify the file
            await writeJob("mutable", `---
schedule: "0 7 * * *"
steps:
  - new-session
  - compact
---`);

            await new Promise((r) => setTimeout(r, 500));

            const jobAfter = scheduler.getJobs().get("mutable")!;
            expect(jobAfter.definition.steps).toEqual([
                { type: "new-session" },
                { type: "compact" },
            ]);

            scheduler.stop();
        });
    });
});
