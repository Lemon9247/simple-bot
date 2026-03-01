import { describe, it, expect, afterEach, vi } from "vitest";
import { Bridge } from "../src/bridge.js";
import { SessionManager } from "../src/session-manager.js";
import { Daemon } from "../src/daemon.js";
import { Scheduler } from "../src/scheduler.js";
import { createMockProcess, MockListener } from "./helpers.js";
import type { Config } from "../src/types.js";

const baseConfig: Config = {
    pi: { cwd: "/tmp" },
    security: { allowed_users: ["@willow:athena"] },
};

function sendCommand(listener: MockListener, text: string) {
    listener.receive({
        platform: "discord",
        channel: "123",
        sender: "@willow:athena",
        text,
    });
}

/** Wrap a pre-built Bridge in a SessionManager for testing */
function wrapBridge(config: Config, bridge: Bridge): SessionManager {
    return new SessionManager(config, (_opts) => bridge);
}

/** SpawnFn that creates a fresh mock process each call (needed for restart tests). */
function createRespawnableMockFn(responseText = "ok") {
    return () => createMockProcess(responseText).proc as any;
}

describe("bot!reboot", () => {
    let daemon: Daemon;

    afterEach(async () => {
        await daemon?.stop();
    });

    it("stops and restarts the pi process", async () => {
        const bridge = new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        sendCommand(listener, "bot!reboot");
        await new Promise((r) => setTimeout(r, 100));

        expect(listener.sent).toHaveLength(2);
        expect(listener.sent[0].text).toContain("Rebooting session");
        expect(listener.sent[0].text).toContain("main");
        expect(listener.sent[1].text).toContain("rebooted");

        // Bridge should still be running after reboot
        expect(bridge.running).toBe(true);
    });

    it("cancels pending messages (interrupts: true)", async () => {
        const { proc, stdin, stdout } = createMockProcess();
        stdin.removeAllListeners("data");

        let resolveAgent: (() => void) | null = null;
        const commands: any[] = [];

        stdin.on("data", (chunk: Buffer) => {
            const lines = chunk.toString().split("\n").filter(Boolean);
            for (const line of lines) {
                let cmd: any;
                try { cmd = JSON.parse(line); } catch { continue; }
                commands.push(cmd);

                stdout.write(
                    JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true }) + "\n"
                );

                if (cmd.type === "prompt") {
                    stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
                    // Hold the response — don't emit agent_end yet
                    resolveAgent = () => {
                        stdout.write(JSON.stringify({
                            type: "message_update",
                            assistantMessageEvent: { type: "text_delta", delta: "done" },
                        }) + "\n");
                        stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
                    };
                }
            }
        });

        const bridge = new Bridge({ cwd: "/tmp", spawnFn: () => proc as any });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        // Send a message that will be "in flight"
        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "do something slow",
        });

        await new Promise((r) => setTimeout(r, 20));
        expect(bridge.busy).toBe(true);

        // Now reboot — should cancel the pending message
        sendCommand(listener, "bot!reboot");
        await new Promise((r) => setTimeout(r, 100));

        const rebootMsgs = listener.sent.filter((s) =>
            s.text.includes("Rebooting") || s.text.includes("Rebooted")
        );
        expect(rebootMsgs.length).toBeGreaterThanOrEqual(1);
    });

    it("next message works after reboot", async () => {
        const bridge = new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        sendCommand(listener, "bot!reboot");
        await new Promise((r) => setTimeout(r, 100));

        // Send a normal message after reboot
        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "hello after reboot",
        });
        await new Promise((r) => setTimeout(r, 50));

        const afterReboot = listener.sent.filter((s) => s.text === "ok");
        expect(afterReboot).toHaveLength(1);
    });
});

describe("bot!status", () => {
    let daemon: Daemon;

    afterEach(async () => {
        await daemon?.stop();
    });

    it("shows uptime, model, and context info", async () => {
        const { spawnFn } = createMockProcess("ok");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        sendCommand(listener, "bot!status");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        const status = listener.sent[0].text;

        // Should contain the status indicator and uptime
        expect(status).toContain("🟢 simple-bot");
        expect(status).toContain("uptime");

        // Should contain model from get_state mock
        expect(status).toContain("Claude Sonnet 4");

        // Should contain context info from get_state mock (~45k)
        expect(status).toContain("~45k tokens");
    });

    it("shows cron info when scheduler has jobs", async () => {
        const { spawnFn } = createMockProcess("ok");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        const cronConfig = { dir: "/tmp/cron-test-" + Date.now() };
        const scheduler = new Scheduler(cronConfig, bridge);

        const sm = wrapBridge(baseConfig, bridge);
        daemon = new Daemon(baseConfig, sm);
        daemon.setScheduler(scheduler);

        const listener = new MockListener("discord");
        daemon.addListener(listener);

        // Mock the scheduler's getJobs to return some jobs
        vi.spyOn(scheduler, "getJobs").mockReturnValue(
            new Map([
                ["morning-checklist", { definition: { name: "morning-checklist", enabled: true } as any, task: {} as any }],
                ["daily-report", { definition: { name: "daily-report", enabled: true } as any, task: {} as any }],
                ["disabled-job", { definition: { name: "disabled-job", enabled: false } as any, task: {} as any }],
            ])
        );

        await daemon.start();

        sendCommand(listener, "bot!status");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        const status = listener.sent[0].text;
        expect(status).toContain("cron: 3 jobs (2 enabled)");
    });

    it("shows usage stats when tracker has events", async () => {
        const { spawnFn } = createMockProcess("ok");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        // Record usage events directly via the tracker
        const tracker = daemon.getTracker();
        tracker.record({ model: "claude-sonnet-4", inputTokens: 150_000, outputTokens: 80_000, contextSize: 45_000 });
        tracker.record({ model: "claude-sonnet-4", inputTokens: 300_000, outputTokens: 140_000, contextSize: 60_000 });

        sendCommand(listener, "bot!status");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        const status = listener.sent[0].text;

        // Should contain usage line with cost, tokens, and message count
        expect(status).toContain("📊 today:");
        expect(status).toContain("$");
        expect(status).toContain("in /");
        expect(status).toContain("out");
        expect(status).toContain("2 msgs");
    });

    it("gracefully handles get_state failure", async () => {
        const { proc, stdin, stdout } = createMockProcess();
        stdin.removeAllListeners("data");

        stdin.on("data", (chunk: Buffer) => {
            const lines = chunk.toString().split("\n").filter(Boolean);
            for (const line of lines) {
                let cmd: any;
                try { cmd = JSON.parse(line); } catch { continue; }

                if (cmd.type === "get_state") {
                    // Simulate RPC failure
                    stdout.write(
                        JSON.stringify({ id: cmd.id, type: "response", success: false, error: "Not available" }) + "\n"
                    );
                } else {
                    stdout.write(
                        JSON.stringify({ id: cmd.id, type: "response", success: true }) + "\n"
                    );
                }
            }
        });

        const bridge = new Bridge({ cwd: "/tmp", spawnFn: () => proc as any });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        sendCommand(listener, "bot!status");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        const status = listener.sent[0].text;
        // Should still work with fallback values
        expect(status).toContain("🟢 simple-bot");
        expect(status).toContain("model unknown");
        expect(status).toContain("? tokens");
    });
});

describe("bot!think", () => {
    let daemon: Daemon;

    afterEach(async () => {
        await daemon?.stop();
    });

    it("enables extended thinking", async () => {
        const { spawnFn } = createMockProcess("ok");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        sendCommand(listener, "bot!think on");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toContain("enabled");
        expect(listener.sent[0].text).toContain("🧠");
        expect(listener.sent[0].text).toContain("main");
    });

    it("disables extended thinking", async () => {
        const { spawnFn } = createMockProcess("ok");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        // Enable first, then disable
        sendCommand(listener, "bot!think on");
        await new Promise((r) => setTimeout(r, 50));

        sendCommand(listener, "bot!think off");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(2);
        expect(listener.sent[1].text).toContain("disabled");
        expect(listener.sent[1].text).toContain("main");
    });

    it("shows current state with no argument", async () => {
        const { spawnFn } = createMockProcess("ok");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        sendCommand(listener, "bot!think");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toContain("currently **off**");
        expect(listener.sent[0].text).toContain("main");
        expect(listener.sent[0].text).toContain("bot!think on|off");
    });

    it("tracks thinking state across calls", async () => {
        const { spawnFn } = createMockProcess("ok");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        sendCommand(listener, "bot!think on");
        await new Promise((r) => setTimeout(r, 50));

        sendCommand(listener, "bot!think");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(2);
        expect(listener.sent[1].text).toContain("currently **on**");
    });

    it("handles set_model_config RPC failure", async () => {
        const { proc, stdin, stdout } = createMockProcess();
        stdin.removeAllListeners("data");

        stdin.on("data", (chunk: Buffer) => {
            const lines = chunk.toString().split("\n").filter(Boolean);
            for (const line of lines) {
                let cmd: any;
                try { cmd = JSON.parse(line); } catch { continue; }

                if (cmd.type === "set_model_config") {
                    stdout.write(
                        JSON.stringify({ id: cmd.id, type: "response", success: false, error: "Not supported" }) + "\n"
                    );
                } else {
                    stdout.write(
                        JSON.stringify({ id: cmd.id, type: "response", success: true }) + "\n"
                    );
                }
            }
        });

        const bridge = new Bridge({ cwd: "/tmp", spawnFn: () => proc as any });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        sendCommand(listener, "bot!think on");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toContain("❌");
        expect(listener.sent[0].text).toContain("Failed to enable thinking");
    });
});

// ─── Session-aware command tests (T8-T10) ─────────────────────

/** Config with multiple sessions and routing rules */
const multiSessionConfig: Config = {
    pi: { cwd: "/tmp" },
    security: { allowed_users: ["@willow:athena"] },
    sessions: {
        main: { pi: { cwd: "/tmp/main" } },
        work: { pi: { cwd: "/tmp/work" } },
    },
    routing: {
        rules: [
            { match: { platform: "discord", channel: "456" }, session: "work" },
        ],
        default: "main",
    },
};

describe("bot!reboot (session-aware)", () => {
    let daemon: Daemon;

    afterEach(async () => {
        await daemon?.stop();
    });

    it("reboots a named session with bot!reboot <name>", async () => {
        const sm = new SessionManager(multiSessionConfig, () => {
            const bridge = new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
            return bridge;
        });
        daemon = new Daemon(multiSessionConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        // Start the work session first by sending a message to it
        await sm.getOrStartSession("work");

        sendCommand(listener, "bot!reboot work");
        await new Promise((r) => setTimeout(r, 150));

        const msgs = listener.sent.map((s) => s.text);
        expect(msgs.some((m) => m.includes("Rebooting session") && m.includes("work"))).toBe(true);
        expect(msgs.some((m) => m.includes("work") && m.includes("rebooted"))).toBe(true);
    });

    it("reboots all sessions with bot!reboot all", async () => {
        const sm = new SessionManager(multiSessionConfig, () => {
            return new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
        });
        daemon = new Daemon(multiSessionConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        // Start both sessions
        await sm.getOrStartSession("main");
        await sm.getOrStartSession("work");

        sendCommand(listener, "bot!reboot all");
        await new Promise((r) => setTimeout(r, 200));

        const msgs = listener.sent.map((s) => s.text);
        expect(msgs.some((m) => m.includes("Rebooting 2 session(s)"))).toBe(true);
        // Should have results for both sessions
        const resultMsg = msgs.find((m) => m.includes("main") && m.includes("work"));
        expect(resultMsg).toBeDefined();
    });

    it("reports error for unknown session name", async () => {
        const sm = new SessionManager(multiSessionConfig, () => {
            return new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
        });
        daemon = new Daemon(multiSessionConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        sendCommand(listener, "bot!reboot nonexistent");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toContain("Unknown session");
        expect(listener.sent[0].text).toContain("nonexistent");
    });

    it("reboots only running sessions with bot!reboot all", async () => {
        const sm = new SessionManager(multiSessionConfig, () => {
            return new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
        });
        daemon = new Daemon(multiSessionConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        // The daemon lazily starts "main" for the command bridge.
        // "work" is not started, so only "main" should be rebooted.
        sendCommand(listener, "bot!reboot all");
        await new Promise((r) => setTimeout(r, 200));

        const msgs = listener.sent.map((s) => s.text);
        expect(msgs.some((m) => m.includes("Rebooting 1 session(s)"))).toBe(true);
        expect(msgs.some((m) => m.includes("main"))).toBe(true);
    });

    it("bot!reboot ALL is case-insensitive", async () => {
        const sm = new SessionManager(multiSessionConfig, () => {
            return new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
        });
        daemon = new Daemon(multiSessionConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        await sm.getOrStartSession("main");

        sendCommand(listener, "bot!reboot ALL");
        await new Promise((r) => setTimeout(r, 200));

        const msgs = listener.sent.map((s) => s.text);
        expect(msgs.some((m) => m.includes("Rebooting"))).toBe(true);
    });

    it("bot!reboot matches session names case-insensitively", async () => {
        const sm = new SessionManager(multiSessionConfig, () => {
            return new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
        });
        daemon = new Daemon(multiSessionConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        await sm.getOrStartSession("work");

        sendCommand(listener, "bot!reboot Work");
        await new Promise((r) => setTimeout(r, 150));

        const msgs = listener.sent.map((s) => s.text);
        expect(msgs.some((m) => m.includes("Rebooting session") && m.includes("work"))).toBe(true);
    });
});

describe("bot!status (session-aware)", () => {
    let daemon: Daemon;

    afterEach(async () => {
        await daemon?.stop();
    });

    it("shows session list when multiple sessions configured", async () => {
        const sm = new SessionManager(multiSessionConfig, () => {
            return new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
        });
        daemon = new Daemon(multiSessionConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        // Start main session
        await sm.getOrStartSession("main");

        sendCommand(listener, "bot!status");
        await new Promise((r) => setTimeout(r, 100));

        expect(listener.sent).toHaveLength(1);
        const status = listener.sent[0].text;

        // Should show session section header
        expect(status).toContain("Sessions (2)");
        // Should show running indicator for main
        expect(status).toContain("🟢");
        expect(status).toContain("main");
        // Should show idle indicator for work
        expect(status).toContain("⚪");
        expect(status).toContain("work");
    });

    it("marks current channel's session", async () => {
        const sm = new SessionManager(multiSessionConfig, () => {
            return new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
        });
        daemon = new Daemon(multiSessionConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        sendCommand(listener, "bot!status");
        await new Promise((r) => setTimeout(r, 100));

        const status = listener.sent[0].text;
        // Channel 123 routes to "main" (default)
        expect(status).toContain("this channel");
    });

    it("does not show session list for single session config", async () => {
        const { spawnFn } = createMockProcess("ok");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, wrapBridge(baseConfig, bridge));

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        sendCommand(listener, "bot!status");
        await new Promise((r) => setTimeout(r, 50));

        const status = listener.sent[0].text;
        // Single session — no session list
        expect(status).not.toContain("Sessions");
    });
});

describe("bot!think (per-session)", () => {
    let daemon: Daemon;

    afterEach(async () => {
        await daemon?.stop();
    });

    it("thinking state is isolated per session", async () => {
        const sm = new SessionManager(multiSessionConfig, () => {
            return new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
        });
        daemon = new Daemon(multiSessionConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        // Enable thinking on main (channel 123 → main)
        sendCommand(listener, "bot!think on");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent[0].text).toContain("enabled");
        expect(listener.sent[0].text).toContain("main");

        // Check thinking on main
        expect(daemon.getThinkingEnabled("main")).toBe(true);
        // Work session should be unaffected
        expect(daemon.getThinkingEnabled("work")).toBe(false);
    });

    it("shows per-session thinking state in status", async () => {
        const sm = new SessionManager(multiSessionConfig, () => {
            return new Bridge({ cwd: "/tmp", spawnFn: createRespawnableMockFn() });
        });
        daemon = new Daemon(multiSessionConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        // Enable thinking on main
        sendCommand(listener, "bot!think on");
        await new Promise((r) => setTimeout(r, 50));

        // Check state
        sendCommand(listener, "bot!think");
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent[1].text).toContain("currently **on**");
        expect(listener.sent[1].text).toContain("main");
    });
});
