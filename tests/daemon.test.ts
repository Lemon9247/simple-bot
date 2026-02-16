import { describe, it, expect, afterEach, vi } from "vitest";
import { Bridge } from "../src/bridge.js";
import { Daemon } from "../src/daemon.js";
import { createMockProcess, MockListener } from "./helpers.js";
import type { Config } from "../src/types.js";

const baseConfig: Config = {
    pi: { cwd: "/tmp" },
    security: { allowed_users: ["@willow:athena"] },
};

describe("Daemon", () => {
    let daemon: Daemon;

    afterEach(async () => {
        await daemon?.stop();
    });

    it("routes a message from listener through pi and back", async () => {
        const { spawnFn } = createMockProcess("Pi says hello!");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, bridge);

        const listener = new MockListener("matrix");
        daemon.addListener(listener);
        await daemon.start();

        // Simulate incoming message
        listener.receive({
            platform: "matrix",
            channel: "#general",
            sender: "@willow:athena",
            text: "hey hades",
        });

        // Wait for async processing
        await new Promise((r) => setTimeout(r, 50));

        expect(listener.sent).toHaveLength(1);
        expect(listener.sent[0].text).toBe("Pi says hello!");
        expect(listener.sent[0].origin).toEqual({
            platform: "matrix",
            channel: "#general",
        });
    });

    it("ignores messages from unauthorized users", async () => {
        const { spawnFn } = createMockProcess("should not see this");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, bridge);

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
        const { spawnFn } = createMockProcess("response");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, bridge);

        const matrix = new MockListener("matrix");
        const discord = new MockListener("discord");
        daemon.addListener(matrix);
        daemon.addListener(discord);
        await daemon.start();

        // Send from matrix
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
        const { spawnFn } = createMockProcess("All tests pass!", toolCalls);
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, bridge);

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
        // Custom mock: text → tool → more text
        const { proc, stdin, stdout } = createMockProcess();
        stdin.removeAllListeners("data");
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

        const bridge = new Bridge({ cwd: "/tmp", spawnFn: () => proc as any });
        daemon = new Daemon(baseConfig, bridge);

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

        // Intermediate text, tool summary, final text
        expect(listener.sent).toHaveLength(3);
        expect(listener.sent[0].text).toBe("Let me look at that.");
        expect(listener.sent[1].text).toBe("📖 Reading `config.ts`");
        expect(listener.sent[2].text).toBe("Found the issue!");
    });

    it("steers instead of queuing when bridge is busy", async () => {
        // Slow mock — holds the first message in flight
        const { proc, stdin, stdout } = createMockProcess();
        stdin.removeAllListeners("data");

        const commands: any[] = [];
        let resolveFirst: (() => void) | null = null;

        stdin.on("data", (chunk: Buffer) => {
            const lines = chunk.toString().split("\n").filter(Boolean);
            for (const line of lines) {
                let cmd: any;
                try { cmd = JSON.parse(line); } catch { continue; }
                commands.push(cmd);

                // Acknowledge all RPCs
                stdout.write(
                    JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true }) + "\n"
                );

                if (cmd.type === "prompt") {
                    stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
                    // Hold — don't send agent_end until we say so
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

        const bridge = new Bridge({ cwd: "/tmp", spawnFn: () => proc as any });
        daemon = new Daemon(baseConfig, bridge);

        const listener = new MockListener("matrix");
        daemon.addListener(listener);
        await daemon.start();

        // First message — starts processing
        listener.receive({
            platform: "matrix",
            channel: "#general",
            sender: "@willow:athena",
            text: "do the thing",
        });

        await new Promise((r) => setTimeout(r, 20));

        // Second message while first is in flight — should steer
        listener.receive({
            platform: "matrix",
            channel: "#general",
            sender: "@willow:athena",
            text: "actually do this instead",
        });

        await new Promise((r) => setTimeout(r, 20));

        // Check commands sent to pi
        const steerCmd = commands.find((c) => c.type === "steer");
        expect(steerCmd).toBeDefined();
        expect(steerCmd.message).toContain("actually do this instead");

        // No second prompt should have been sent
        const prompts = commands.filter((c) => c.type === "prompt");
        expect(prompts).toHaveLength(1);

        // Resolve the first message
        resolveFirst!();
        await new Promise((r) => setTimeout(r, 20));
    });

    it("formats messages with platform context", async () => {
        const { spawnFn, stdin } = createMockProcess("ok");
        const bridge = new Bridge({ cwd: "/tmp", spawnFn });
        daemon = new Daemon(baseConfig, bridge);

        // Capture what gets sent to pi
        const commands: any[] = [];
        stdin.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().split("\n").filter(Boolean)) {
                try {
                    commands.push(JSON.parse(line));
                } catch {}
            }
        });

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
});
