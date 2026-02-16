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
