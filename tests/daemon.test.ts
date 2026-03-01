import { describe, it, expect, afterEach, vi } from "vitest";
import { Bridge } from "../src/bridge.js";
import { SessionManager } from "../src/session-manager.js";
import { Daemon } from "../src/daemon.js";
import { createMockProcess, MockListener } from "./helpers.js";
import type { Config } from "../src/types.js";

const baseConfig: Config = {
    pi: { cwd: "/tmp" },
    security: { allowed_users: ["@willow:athena"] },
};

/** Create a SessionManager with a mock bridge factory for testing */
function createTestSessionManager(config: Config, responseText = "Pi says hello!", toolCalls?: any[]) {
    const { spawnFn } = createMockProcess(responseText, toolCalls);
    const sm = new SessionManager(config, (opts) => new Bridge({ ...opts, spawnFn }));
    return sm;
}

/** Create a SessionManager with a raw mock process for fine-grained control */
function createRawTestSessionManager(config: Config) {
    const { proc, stdin, stdout } = createMockProcess();
    stdin.removeAllListeners("data");
    const spawnFn = () => proc as any;
    const sm = new SessionManager(config, (opts) => new Bridge({ ...opts, spawnFn }));
    return { sm, proc, stdin, stdout };
}

describe("Daemon", () => {
    let daemon: Daemon;

    afterEach(async () => {
        await daemon?.stop();
    });

    it("routes a message from listener through pi and back", async () => {
        const sm = createTestSessionManager(baseConfig, "Pi says hello!");
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("matrix");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "matrix",
            channel: "#general",
            sender: "@willow:athena",
            text: "hey hades",
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toBe("Pi says hello!");
        expect(listener.sent[0].origin).toEqual({
            platform: "matrix",
            channel: "#general",
        });
    });

    it("ignores messages from unauthorized users", async () => {
        const sm = createTestSessionManager(baseConfig, "should not see this");
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("matrix");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "matrix",
            channel: "#general",
            sender: "@stranger:evil.org",
            text: "hack the planet",
        });

        await new Promise((r) => setTimeout(r, 50));
        expect(listener.sent).toHaveLength(0);
    });

    it("routes responses to the correct listener", async () => {
        const sm = createTestSessionManager(baseConfig, "response");
        daemon = new Daemon(baseConfig, sm);

        const matrix = new MockListener("matrix");
        const discord = new MockListener("discord");
        daemon.addListener(matrix);
        daemon.addListener(discord);
        await daemon.start();

        matrix.receive({
            platform: "matrix",
            channel: "#hades",
            sender: "@willow:athena",
            text: "hello",
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(matrix.sent).toHaveLength(1);
        expect(discord.sent).toHaveLength(0);
    });

    it("forwards tool call summaries to the listener", async () => {
        const toolCalls = [
            { toolName: "read", args: { path: "src/main.ts" } },
            { toolName: "bash", args: { command: "npm test" } },
        ];
        const sm = createTestSessionManager(baseConfig, "All tests pass!", toolCalls);
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("matrix");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "matrix",
            channel: "#general",
            sender: "@willow:athena",
            text: "run the tests",
        });

        await new Promise((r) => setTimeout(r, 50));

        // Tool summaries + final response
        expect(listener.sent).toHaveLength(3);
        expect(listener.sent[0].text).toBe("📖 Reading `src/main.ts`");
        expect(listener.sent[1].text).toBe("⚡ `npm test`");
        expect(listener.sent[2].text).toBe("All tests pass!");
    });

    it("sends intermediate text as separate messages before tool calls", async () => {
        const { sm, stdin, stdout } = createRawTestSessionManager(baseConfig);
        stdin.on("data", (chunk: Buffer) => {
            const lines = chunk.toString().split("\n").filter(Boolean);
            for (const line of lines) {
                let cmd: any;
                try { cmd = JSON.parse(line); } catch { continue; }

                stdout.write(
                    JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true }) + "\n"
                );

                if (cmd.type === "prompt") {
                    stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
                    stdout.write(JSON.stringify({
                        type: "message_update",
                        assistantMessageEvent: { type: "text_delta", delta: "Let me look at that." },
                    }) + "\n");
                    stdout.write(JSON.stringify({
                        type: "tool_execution_start",
                        toolCallId: "tc-1",
                        toolName: "read",
                        args: { path: "config.ts" },
                    }) + "\n");
                    stdout.write(JSON.stringify({
                        type: "tool_execution_end",
                        toolCallId: "tc-1",
                        toolName: "read",
                        isError: false,
                    }) + "\n");
                    stdout.write(JSON.stringify({
                        type: "message_update",
                        assistantMessageEvent: { type: "text_delta", delta: "Found the issue!" },
                    }) + "\n");
                    stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
                }
            }
        });

        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("matrix");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "matrix",
            channel: "#general",
            sender: "@willow:athena",
            text: "check the config",
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(3);
        expect(listener.sent[0].text).toBe("Let me look at that.");
        expect(listener.sent[1].text).toBe("📖 Reading `config.ts`");
        expect(listener.sent[2].text).toBe("Found the issue!");
    });

    it("steers instead of queuing when bridge is busy", async () => {
        const { sm, stdin, stdout } = createRawTestSessionManager(baseConfig);

        const commands: any[] = [];
        let resolveFirst: (() => void) | null = null;

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
                    resolveFirst = () => {
                        stdout.write(JSON.stringify({
                            type: "message_update",
                            assistantMessageEvent: { type: "text_delta", delta: "response" },
                        }) + "\n");
                        stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
                    };
                }
            }
        });

        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("matrix");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "matrix",
            channel: "#general",
            sender: "@willow:athena",
            text: "do the thing",
        });

        await new Promise((r) => setTimeout(r, 20));

        listener.receive({
            platform: "matrix",
            channel: "#general",
            sender: "@willow:athena",
            text: "actually do this instead",
        });

        await new Promise((r) => setTimeout(r, 20));

        const steerCmd = commands.find((c) => c.type === "steer");
        expect(steerCmd).toBeDefined();
        expect(steerCmd.message).toContain("actually do this instead");

        const prompts = commands.filter((c) => c.type === "prompt");
        expect(prompts).toHaveLength(1);

        resolveFirst!();
        await new Promise((r) => setTimeout(r, 20));
    });

    it("handles bot!abort command", async () => {
        const sm = createTestSessionManager(baseConfig, "ok");
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "bot!abort",
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toContain("Aborted");
    });

    it("handles bot!compress command", async () => {
        const sm = createTestSessionManager(baseConfig, "ok");
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "bot!compress",
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(2);
        expect(listener.sent[0].text).toContain("Compressing");
        expect(listener.sent[1].text).toContain("50000");
    });

    it("handles bot!new command", async () => {
        const sm = createTestSessionManager(baseConfig, "ok");
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "bot!new",
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toContain("new session");
    });

    it("handles bot!model with no args — lists available models", async () => {
        const sm = createTestSessionManager(baseConfig, "ok");
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "bot!model",
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toContain("Claude Opus 4.5");
        expect(listener.sent[0].text).toContain("Claude Sonnet 4");
    });

    it("handles bot!model <name> — switches to matching model", async () => {
        const sm = createTestSessionManager(baseConfig, "ok");
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "bot!model sonnet",
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toContain("Claude Sonnet 4");
    });

    it("handles bot!model with unknown name", async () => {
        const sm = createTestSessionManager(baseConfig, "ok");
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "bot!model gpt-99",
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toContain("No model matching");
    });

    it("handles bot!reload command", async () => {
        const sm = createTestSessionManager(baseConfig, "ok");
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "bot!reload",
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(2);
        expect(listener.sent[0].text).toContain("Reloading");
        expect(listener.sent[1].text).toContain("Extensions reloaded");
    });

    it("does not send bot commands to pi as prompts", async () => {
        const { sm, stdin } = createRawTestSessionManager(baseConfig);

        // Re-add the standard response handler
        const { stdout } = createMockProcess("ok");
        const commands: any[] = [];
        stdin.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().split("\n").filter(Boolean)) {
                let cmd: any;
                try { cmd = JSON.parse(line); } catch { continue; }
                commands.push(cmd);
                // Need to respond to RPC
                const proc = sm.getSession("main") as any;
            }
        });

        // Actually use the simpler approach - create fresh
        const sm2 = createTestSessionManager(baseConfig, "ok");
        daemon = new Daemon(baseConfig, sm2);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "bot!abort",
        });

        await new Promise((r) => setTimeout(r, 50));

        // The abort command should be handled directly, not sent as a prompt
        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toContain("Aborted");
    });

    it("passes unknown bot! prefixed messages to pi as regular messages", async () => {
        const sm = createTestSessionManager(baseConfig, "ok");
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "bot!unknownthing",
        });

        await new Promise((r) => setTimeout(r, 50));

        // Unknown commands are passed through as regular messages
        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toBe("ok");
    });

    it("command prefix is case-insensitive", async () => {
        const sm = createTestSessionManager(baseConfig, "ok");
        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "discord",
            channel: "123",
            sender: "@willow:athena",
            text: "Bot!Abort",
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toContain("Aborted");
    });

    it("formats messages with platform context", async () => {
        const { sm, stdin, stdout } = createRawTestSessionManager(baseConfig);
        const commands: any[] = [];
        stdin.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().split("\n").filter(Boolean)) {
                let cmd: any;
                try { cmd = JSON.parse(line); } catch { continue; }
                commands.push(cmd);
                stdout.write(
                    JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true }) + "\n"
                );
                if (cmd.type === "prompt") {
                    stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
                    stdout.write(JSON.stringify({
                        type: "message_update",
                        assistantMessageEvent: { type: "text_delta", delta: "ok" },
                    }) + "\n");
                    stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
                }
            }
        });

        daemon = new Daemon(baseConfig, sm);

        const listener = new MockListener("matrix");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "matrix",
            channel: "#general",
            sender: "@willow:athena",
            text: "what's up?",
        });

        await new Promise((r) => setTimeout(r, 50));

        const followUp = commands.find((c) => c.type === "prompt");
        expect(followUp).toBeDefined();
        expect(followUp.message).toBe("[matrix #general] @willow:athena: what's up?");
    });

    // ─── Session routing tests ───────────────────────────────

    it("routes messages to correct session via routing rules", async () => {
        const config: Config = {
            ...baseConfig,
            sessions: {
                main: { pi: { cwd: "/tmp/main" } },
                work: { pi: { cwd: "/tmp/work" } },
            },
            routing: {
                rules: [{ match: { channel: "work-channel" }, session: "work" }],
                default: "main",
            },
        };

        const startedSessions: string[] = [];
        const sm = new SessionManager(config, (opts) => {
            const { spawnFn } = createMockProcess("ok");
            startedSessions.push(opts.cwd);
            return new Bridge({ ...opts, spawnFn });
        });

        daemon = new Daemon(config, sm);
        const listener = new MockListener("discord");
        daemon.addListener(listener);
        await daemon.start();

        listener.receive({
            platform: "discord",
            channel: "work-channel",
            sender: "@willow:athena",
            text: "work stuff",
        });

        await new Promise((r) => setTimeout(r, 50));

        // Should have started the "work" session (cwd /tmp/work)
        expect(startedSessions).toContain("/tmp/work");
        expect(listener.sent).toHaveLength(1);
    });
});
