import { describe, it, expect, afterEach } from "vitest";
import { Bridge } from "../src/bridge.js";
import type { ToolCallInfo } from "../src/types.js";
import { createMockProcess } from "./helpers.js";

describe("Bridge", () => {
    let bridge: Bridge;

    afterEach(async () => {
        await bridge?.stop();
    });

    it("sends a message and gets a response", async () => {
        const { spawnFn } = createMockProcess("Hello from pi!");
        bridge = new Bridge({ cwd: "/tmp", spawnFn });
        bridge.start();

        const response = await bridge.sendMessage("test message");
        expect(response).toBe("Hello from pi!");
    });

    it("handles multiple messages in order", async () => {
        let callCount = 0;
        const responses = ["First response", "Second response"];

        // Custom mock that returns different responses
        const { proc, stdin, stdout } = createMockProcess();
        // Override stdin handler
        stdin.removeAllListeners("data");
        stdin.on("data", (chunk: Buffer) => {
            const lines = chunk.toString().split("\n").filter(Boolean);
            for (const line of lines) {
                let cmd: any;
                try {
                    cmd = JSON.parse(line);
                } catch {
                    continue;
                }

                stdout.write(
                    JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true }) + "\n"
                );

                if (cmd.type === "prompt") {
                    const text = responses[callCount++] ?? "unexpected";
                    stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
                    stdout.write(
                        JSON.stringify({
                            type: "message_update",
                            assistantMessageEvent: { type: "text_delta", delta: text },
                        }) + "\n"
                    );
                    stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
                }
            }
        });

        bridge = new Bridge({ cwd: "/tmp", spawnFn: () => proc as any });
        bridge.start();

        const [r1, r2] = await Promise.all([
            bridge.sendMessage("first"),
            bridge.sendMessage("second"),
        ]);

        expect(r1).toBe("First response");
        expect(r2).toBe("Second response");
    });

    it("accumulates text deltas across multiple events", async () => {
        const { proc, stdin, stdout } = createMockProcess();
        stdin.removeAllListeners("data");
        stdin.on("data", (chunk: Buffer) => {
            const lines = chunk.toString().split("\n").filter(Boolean);
            for (const line of lines) {
                let cmd: any;
                try {
                    cmd = JSON.parse(line);
                } catch {
                    continue;
                }

                stdout.write(
                    JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true }) + "\n"
                );

                if (cmd.type === "prompt") {
                    stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
                    stdout.write(
                        JSON.stringify({
                            type: "message_update",
                            assistantMessageEvent: { type: "text_delta", delta: "Hello " },
                        }) + "\n"
                    );
                    stdout.write(
                        JSON.stringify({
                            type: "message_update",
                            assistantMessageEvent: { type: "text_delta", delta: "beautiful " },
                        }) + "\n"
                    );
                    stdout.write(
                        JSON.stringify({
                            type: "message_update",
                            assistantMessageEvent: { type: "text_delta", delta: "world!" },
                        }) + "\n"
                    );
                    stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
                }
            }
        });

        bridge = new Bridge({ cwd: "/tmp", spawnFn: () => proc as any });
        bridge.start();

        const response = await bridge.sendMessage("test");
        expect(response).toBe("Hello beautiful world!");
    });

    it("rejects pending messages when pi exits", async () => {
        const { proc, spawnFn } = createMockProcess();
        // Don't process stdin — simulate a hang then crash
        proc.stdin.removeAllListeners("data");

        bridge = new Bridge({ cwd: "/tmp", spawnFn });
        bridge.start();

        const promise = bridge.sendMessage("will fail");

        // Simulate pi crashing
        proc.exitCode = 1;
        proc.emit("exit", 1, null);

        await expect(promise).rejects.toThrow("Pi exited");
    });

    it("calls onToolStart for tool_execution_start events", async () => {
        const toolCalls = [
            { toolName: "read", args: { path: "src/main.ts" } },
            { toolName: "bash", args: { command: "npm test" } },
        ];
        const { spawnFn } = createMockProcess("Done!", toolCalls);
        bridge = new Bridge({ cwd: "/tmp", spawnFn });
        bridge.start();

        const received: ToolCallInfo[] = [];
        const response = await bridge.sendMessage("test", {
            onToolStart: (info) => received.push(info),
        });

        expect(response).toBe("Done!");
        expect(received).toHaveLength(2);
        expect(received[0]).toEqual({ toolName: "read", args: { path: "src/main.ts" } });
        expect(received[1]).toEqual({ toolName: "bash", args: { command: "npm test" } });
    });

    it("does not call onToolStart when no callback provided", async () => {
        const toolCalls = [{ toolName: "read", args: { path: "file.ts" } }];
        const { spawnFn } = createMockProcess("Done!", toolCalls);
        bridge = new Bridge({ cwd: "/tmp", spawnFn });
        bridge.start();

        // Should not throw — just ignores tool events
        const response = await bridge.sendMessage("test");
        expect(response).toBe("Done!");
    });

    it("flushes intermediate text before tool calls via onText", async () => {
        // Simulate: text → tool → more text (final)
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
                    // Intermediate text
                    stdout.write(JSON.stringify({
                        type: "message_update",
                        assistantMessageEvent: { type: "text_delta", delta: "Let me check..." },
                    }) + "\n");
                    // Tool fires — should flush text
                    stdout.write(JSON.stringify({
                        type: "tool_execution_start",
                        toolCallId: "tc-1",
                        toolName: "read",
                        args: { path: "file.ts" },
                    }) + "\n");
                    stdout.write(JSON.stringify({
                        type: "tool_execution_end",
                        toolCallId: "tc-1",
                        toolName: "read",
                        isError: false,
                    }) + "\n");
                    // Final text
                    stdout.write(JSON.stringify({
                        type: "message_update",
                        assistantMessageEvent: { type: "text_delta", delta: "All done!" },
                    }) + "\n");
                    stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
                }
            }
        });

        bridge = new Bridge({ cwd: "/tmp", spawnFn: () => proc as any });
        bridge.start();

        const flushed: string[] = [];
        const tools: ToolCallInfo[] = [];
        const response = await bridge.sendMessage("test", {
            onText: (text) => flushed.push(text),
            onToolStart: (info) => tools.push(info),
        });

        expect(flushed).toEqual(["Let me check..."]);
        expect(tools).toHaveLength(1);
        expect(tools[0].toolName).toBe("read");
        expect(response).toBe("All done!");
    });

    it("emits events from pi", async () => {
        const { spawnFn } = createMockProcess("test");
        bridge = new Bridge({ cwd: "/tmp", spawnFn });
        bridge.start();

        const events: any[] = [];
        bridge.on("event", (e) => events.push(e));

        await bridge.sendMessage("test");

        const types = events.map((e) => e.type);
        expect(types).toContain("agent_start");
        expect(types).toContain("message_update");
        expect(types).toContain("agent_end");
    });
});
