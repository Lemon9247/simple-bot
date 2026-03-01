import { describe, it, expect, afterEach, vi } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { Bridge } from "../src/bridge.js";
import { createMockProcess } from "./helpers.js";
import type { Config, SessionConfig } from "../src/types.js";

const baseConfig: Config = {
    pi: { cwd: "/tmp" },
    security: { allowed_users: ["@willow:athena"] },
};

function makeBridgeFactory() {
    const bridges: Bridge[] = [];
    const factory = (opts: any) => {
        const { spawnFn } = createMockProcess("ok");
        const bridge = new Bridge({ ...opts, spawnFn });
        bridges.push(bridge);
        return bridge;
    };
    return { factory, bridges };
}

describe("SessionManager", () => {
    let sm: SessionManager;

    afterEach(async () => {
        await sm?.stopAll();
    });

    // ─── T4: Backward compat ─────────────────────────────────

    describe("backward compatibility (no sessions block)", () => {
        it("synthesizes a single 'main' session from config.pi", () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            const names = sm.getSessionNames();
            expect(names).toEqual(["main"]);
            expect(sm.getDefaultSessionName()).toBe("main");
        });

        it("routes everything to main when no routing configured", () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            expect(sm.resolveSession("discord", "123")).toBe("main");
            expect(sm.resolveSession("matrix", "#room:server")).toBe("main");
        });
    });

    // ─── T1: Named sessions ─────────────────────────────────

    describe("named sessions", () => {
        it("creates sessions from config.sessions", () => {
            const { factory } = makeBridgeFactory();
            const config: Config = {
                ...baseConfig,
                sessions: {
                    main: { pi: { cwd: "/home/user" } },
                    work: { pi: { cwd: "/home/user/work" } },
                },
            };
            sm = new SessionManager(config, factory);

            const names = sm.getSessionNames();
            expect(names).toContain("main");
            expect(names).toContain("work");
            expect(names).toHaveLength(2);
        });

        it("starts a session and returns its bridge", async () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            const bridge = await sm.startSession("main");
            expect(bridge).toBeInstanceOf(Bridge);
            expect(bridge.running).toBe(true);

            const info = sm.getSessionInfo("main");
            expect(info?.state).toBe("running");
        });

        it("getSession returns null for non-running session", () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            expect(sm.getSession("main")).toBeNull();
        });

        it("getSession returns bridge for running session", async () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            await sm.startSession("main");
            const bridge = sm.getSession("main");
            expect(bridge).toBeInstanceOf(Bridge);
        });

        it("stopSession stops a running session", async () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            await sm.startSession("main");
            expect(sm.getSessionInfo("main")?.state).toBe("running");

            await sm.stopSession("main");
            expect(sm.getSessionInfo("main")?.state).toBe("idle");
            expect(sm.getSession("main")).toBeNull();
        });

        it("stopSession is safe to call on idle session", async () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            await sm.stopSession("main"); // should not throw
        });

        it("throws on unknown session name", async () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            await expect(sm.startSession("nonexistent")).rejects.toThrow("Unknown session");
            await expect(sm.stopSession("nonexistent")).rejects.toThrow("Unknown session");
            await expect(sm.getOrStartSession("nonexistent")).rejects.toThrow("Unknown session");
        });

        it("stopAll stops all running sessions", async () => {
            const { factory } = makeBridgeFactory();
            const config: Config = {
                ...baseConfig,
                sessions: {
                    main: { pi: { cwd: "/tmp/a" } },
                    work: { pi: { cwd: "/tmp/b" } },
                },
            };
            sm = new SessionManager(config, factory);

            await sm.startSession("main");
            await sm.startSession("work");
            expect(sm.getSessionInfo("main")?.state).toBe("running");
            expect(sm.getSessionInfo("work")?.state).toBe("running");

            await sm.stopAll();
            expect(sm.getSessionInfo("main")?.state).toBe("idle");
            expect(sm.getSessionInfo("work")?.state).toBe("idle");
        });
    });

    // ─── T5: Lazy spawn ──────────────────────────────────────

    describe("lazy spawn", () => {
        it("sessions start in idle state", () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            const info = sm.getSessionInfo("main");
            expect(info?.state).toBe("idle");
            expect(info?.bridge).toBeNull();
        });

        it("getOrStartSession lazily starts an idle session", async () => {
            const { factory, bridges } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            expect(bridges).toHaveLength(0); // no bridge created yet

            const bridge = await sm.getOrStartSession("main");
            expect(bridge).toBeInstanceOf(Bridge);
            expect(bridges).toHaveLength(1); // now created
            expect(sm.getSessionInfo("main")?.state).toBe("running");
        });

        it("getOrStartSession returns existing bridge for running session", async () => {
            const { factory, bridges } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            const bridge1 = await sm.getOrStartSession("main");
            const bridge2 = await sm.getOrStartSession("main");
            expect(bridge1).toBe(bridge2);
            expect(bridges).toHaveLength(1); // only one bridge created
        });
    });

    // ─── Routing ─────────────────────────────────────────────

    describe("routing", () => {
        it("routes by platform", () => {
            const { factory } = makeBridgeFactory();
            const config: Config = {
                ...baseConfig,
                sessions: {
                    main: { pi: { cwd: "/tmp/a" } },
                    work: { pi: { cwd: "/tmp/b" } },
                },
                routing: {
                    rules: [
                        { match: { platform: "discord" }, session: "work" },
                    ],
                    default: "main",
                },
            };
            sm = new SessionManager(config, factory);

            expect(sm.resolveSession("discord", "123")).toBe("work");
            expect(sm.resolveSession("matrix", "#room")).toBe("main");
        });

        it("routes by channel", () => {
            const { factory } = makeBridgeFactory();
            const config: Config = {
                ...baseConfig,
                sessions: {
                    main: { pi: { cwd: "/tmp/a" } },
                    work: { pi: { cwd: "/tmp/b" } },
                },
                routing: {
                    rules: [
                        { match: { channel: "789" }, session: "work" },
                    ],
                    default: "main",
                },
            };
            sm = new SessionManager(config, factory);

            expect(sm.resolveSession("discord", "789")).toBe("work");
            expect(sm.resolveSession("discord", "123")).toBe("main");
        });

        it("routes by platform + channel combo", () => {
            const { factory } = makeBridgeFactory();
            const config: Config = {
                ...baseConfig,
                sessions: {
                    main: { pi: { cwd: "/tmp/a" } },
                    work: { pi: { cwd: "/tmp/b" } },
                },
                routing: {
                    rules: [
                        { match: { platform: "discord", channel: "789" }, session: "work" },
                    ],
                    default: "main",
                },
            };
            sm = new SessionManager(config, factory);

            expect(sm.resolveSession("discord", "789")).toBe("work");
            expect(sm.resolveSession("discord", "123")).toBe("main");
            expect(sm.resolveSession("matrix", "789")).toBe("main");
        });

        it("first matching rule wins", () => {
            const { factory } = makeBridgeFactory();
            const config: Config = {
                ...baseConfig,
                sessions: {
                    main: { pi: { cwd: "/tmp/a" } },
                    work: { pi: { cwd: "/tmp/b" } },
                    dev: { pi: { cwd: "/tmp/c" } },
                },
                routing: {
                    rules: [
                        { match: { channel: "789" }, session: "work" },
                        { match: { platform: "discord" }, session: "dev" },
                    ],
                    default: "main",
                },
            };
            sm = new SessionManager(config, factory);

            // Channel match wins over platform match
            expect(sm.resolveSession("discord", "789")).toBe("work");
            // Only platform match
            expect(sm.resolveSession("discord", "other")).toBe("dev");
        });

        it("uses defaultSession from config", () => {
            const { factory } = makeBridgeFactory();
            const config: Config = {
                ...baseConfig,
                sessions: {
                    main: { pi: { cwd: "/tmp/a" } },
                    work: { pi: { cwd: "/tmp/b" } },
                },
                defaultSession: "work",
            };
            sm = new SessionManager(config, factory);

            expect(sm.getDefaultSessionName()).toBe("work");
            expect(sm.resolveSession("any", "any")).toBe("work");
        });

        it("routing.default overrides defaultSession", () => {
            const { factory } = makeBridgeFactory();
            const config: Config = {
                ...baseConfig,
                sessions: {
                    main: { pi: { cwd: "/tmp/a" } },
                    work: { pi: { cwd: "/tmp/b" } },
                },
                defaultSession: "main",
                routing: {
                    rules: [],
                    default: "work",
                },
            };
            sm = new SessionManager(config, factory);

            expect(sm.getDefaultSessionName()).toBe("work");
        });
    });

    // ─── Events ──────────────────────────────────────────────

    describe("events", () => {
        it("emits session:event when bridge emits event", async () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            const events: any[] = [];
            sm.on("session:event", (name: string, event: any) => {
                events.push({ name, event });
            });

            const bridge = await sm.startSession("main");
            // Bridge events are emitted when it receives data from pi.
            // The mock process emits events on prompt — just check we wired it up.
            await bridge.sendMessage("test");
            await new Promise((r) => setTimeout(r, 30));

            // Should have received events like agent_start, message_update, agent_end
            expect(events.length).toBeGreaterThan(0);
            expect(events[0].name).toBe("main");
        });
    });

    // ─── T6: Idle timeout ────────────────────────────────────

    describe("idle timeout", () => {
        it("stops session after idle timeout", async () => {
            vi.useFakeTimers();
            const { factory } = makeBridgeFactory();
            const config: Config = {
                ...baseConfig,
                sessions: {
                    main: { pi: { cwd: "/tmp" }, idleTimeoutMinutes: 5 },
                },
            };
            sm = new SessionManager(config, factory);

            await sm.startSession("main");
            expect(sm.getSessionInfo("main")?.state).toBe("running");

            // Advance past the timeout
            await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);

            expect(sm.getSessionInfo("main")?.state).toBe("idle");
            vi.useRealTimers();
        });

        it("resets idle timer on activity", async () => {
            vi.useFakeTimers();
            const { factory } = makeBridgeFactory();
            const config: Config = {
                ...baseConfig,
                sessions: {
                    main: { pi: { cwd: "/tmp" }, idleTimeoutMinutes: 5 },
                },
            };
            sm = new SessionManager(config, factory);

            await sm.startSession("main");

            // Advance 4 minutes
            await vi.advanceTimersByTimeAsync(4 * 60_000);
            expect(sm.getSessionInfo("main")?.state).toBe("running");

            // Record activity (resets timer)
            sm.recordActivity("main");

            // Advance another 4 minutes — should still be running
            await vi.advanceTimersByTimeAsync(4 * 60_000);
            expect(sm.getSessionInfo("main")?.state).toBe("running");

            // Advance past the full timeout from last activity
            await vi.advanceTimersByTimeAsync(2 * 60_000);
            expect(sm.getSessionInfo("main")?.state).toBe("idle");
            vi.useRealTimers();
        });

        it("no timeout when idleTimeoutMinutes not set", async () => {
            vi.useFakeTimers();
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            await sm.startSession("main");

            // Advance a long time
            await vi.advanceTimersByTimeAsync(60 * 60_000);
            expect(sm.getSessionInfo("main")?.state).toBe("running");
            vi.useRealTimers();
        });
    });

    // ─── Error handling (review P0) ──────────────────────────

    describe("error handling", () => {
        it("recovers to idle state when bridge factory throws", async () => {
            const factory = () => {
                throw new Error("Spawn failed");
            };
            sm = new SessionManager(baseConfig, factory);

            await expect(sm.startSession("main")).rejects.toThrow("Spawn failed");
            expect(sm.getSessionInfo("main")?.state).toBe("idle");
            expect(sm.getSessionInfo("main")?.bridge).toBeNull();
        });

        it("recovers to idle state when bridge.start() throws", async () => {
            const factory = (opts: any) => {
                const { spawnFn } = createMockProcess("ok");
                const bridge = new Bridge({ ...opts, spawnFn });
                // Override start to throw
                bridge.start = () => { throw new Error("Start failed"); };
                return bridge;
            };
            sm = new SessionManager(baseConfig, factory);

            await expect(sm.startSession("main")).rejects.toThrow("Start failed");
            expect(sm.getSessionInfo("main")?.state).toBe("idle");
            expect(sm.getSessionInfo("main")?.bridge).toBeNull();
        });

        it("getOrStartSession times out when session stuck in starting", async () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            // Manually set state to "starting" to simulate stuck session
            const info = sm.getSessionInfo("main")!;
            info.state = "starting";

            vi.useFakeTimers();

            // Catch the rejection eagerly so it doesn't become unhandled
            // during fake timer advancement
            let caughtError: Error | null = null;
            const promise = sm.getOrStartSession("main").catch((err) => { caughtError = err; });

            // Advance past 30s timeout
            await vi.advanceTimersByTimeAsync(31_000);
            await promise;

            vi.useRealTimers();

            // Reset state so afterEach cleanup works
            info.state = "idle";

            expect(caughtError).not.toBeNull();
            expect(caughtError!.message).toContain("start timeout");
        });

        it("concurrent startSession calls don't create duplicate bridges", async () => {
            const { factory, bridges } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            // Call concurrently — second should get the same bridge
            const [bridge1, bridge2] = await Promise.all([
                sm.getOrStartSession("main"),
                sm.getOrStartSession("main"),
            ]);

            expect(bridge1).toBe(bridge2);
            expect(bridges).toHaveLength(1);
        });

        it("stopAll continues when one session fails to stop", async () => {
            const { factory } = makeBridgeFactory();
            const config: Config = {
                ...baseConfig,
                sessions: {
                    main: { pi: { cwd: "/tmp/a" } },
                    work: { pi: { cwd: "/tmp/b" } },
                },
            };
            sm = new SessionManager(config, factory);

            await sm.startSession("main");
            await sm.startSession("work");

            // Make "main" session's bridge.stop() throw
            const mainBridge = sm.getSession("main")!;
            const origStop = mainBridge.stop.bind(mainBridge);
            mainBridge.stop = async () => {
                await origStop();
                throw new Error("Stop failed");
            };

            // stopAll should not throw — should handle the error and continue
            await sm.stopAll();

            // Both sessions should be idle regardless
            expect(sm.getSessionInfo("main")?.state).toBe("idle");
            expect(sm.getSessionInfo("work")?.state).toBe("idle");
        });

        it("logs stop errors in stopSession", async () => {
            const { factory } = makeBridgeFactory();
            sm = new SessionManager(baseConfig, factory);

            await sm.startSession("main");

            const mainBridge = sm.getSession("main")!;
            const origStop = mainBridge.stop.bind(mainBridge);
            mainBridge.stop = async () => {
                await origStop();
                throw new Error("Stop error");
            };

            // Should not throw — error is caught and logged
            await sm.stopSession("main");
            expect(sm.getSessionInfo("main")?.state).toBe("idle");
            expect(sm.getSessionInfo("main")?.bridge).toBeNull();
        });
    });
});
