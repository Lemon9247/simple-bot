import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { Listener, IncomingMessage, MessageOrigin } from "../src/types.js";

export interface MockToolCall {
    toolName: string;
    args: Record<string, any>;
}

/**
 * Creates a fake child process that speaks pi's RPC protocol.
 * Responds to follow_up/prompt with a canned agent response.
 * Optionally emits tool_execution_start events before the response.
 */
export function createMockProcess(responseText = "Hello world!", toolCalls?: MockToolCall[]) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const proc = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        pid: 99999,
        exitCode: null as number | null,
        kill: vi.fn(function (this: any) {
            this.exitCode = 0;
            process.nextTick(() => this.emit("exit", 0, "SIGTERM"));
        }),
    });

    // Simulate pi RPC behavior
    stdin.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n").filter(Boolean);
        for (const line of lines) {
            let cmd: any;
            try {
                cmd = JSON.parse(line);
            } catch {
                continue;
            }

            // Build response data for specific commands
            let responseData: any = undefined;
            if (cmd.type === "compact") {
                responseData = { summary: "Compacted.", tokensBefore: 50000 };
            } else if (cmd.type === "get_available_models") {
                responseData = {
                    models: [
                        { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
                        { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
                    ],
                };
            } else if (cmd.type === "get_state") {
                responseData = {
                    model: { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
                    contextTokens: 45200,
                };
            } else if (cmd.type === "set_model_config") {
                responseData = {};
            }

            // Acknowledge the command
            stdout.write(
                JSON.stringify({
                    id: cmd.id,
                    type: "response",
                    command: cmd.type,
                    success: true,
                    ...(responseData !== undefined ? { data: responseData } : {}),
                }) + "\n"
            );

            // Simulate agent processing for message commands
            if (cmd.type === "follow_up" || cmd.type === "prompt") {
                stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");

                // Emit tool events if provided
                if (toolCalls) {
                    for (const tc of toolCalls) {
                        const toolCallId = `tc-${Math.random().toString(36).slice(2, 10)}`;
                        stdout.write(
                            JSON.stringify({
                                type: "tool_execution_start",
                                toolCallId,
                                toolName: tc.toolName,
                                args: tc.args,
                            }) + "\n"
                        );
                        stdout.write(
                            JSON.stringify({
                                type: "tool_execution_end",
                                toolCallId,
                                toolName: tc.toolName,
                                isError: false,
                            }) + "\n"
                        );
                    }
                }

                stdout.write(
                    JSON.stringify({
                        type: "message_update",
                        assistantMessageEvent: { type: "text_delta", delta: responseText },
                    }) + "\n"
                );
                stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
            }
        }
    });

    const spawnFn = () => proc as any;
    return { proc, stdin, stdout, stderr, spawnFn };
}

/**
 * A mock listener for testing the daemon.
 */
export class MockListener implements Listener {
    readonly name: string;
    private handler: ((msg: IncomingMessage) => void) | null = null;
    sent: Array<{ origin: MessageOrigin; text: string }> = [];

    constructor(name = "test") {
        this.name = name;
    }

    async connect() {}
    async disconnect() {}

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.handler = handler;
    }

    async send(origin: MessageOrigin, text: string): Promise<void> {
        this.sent.push({ origin, text });
    }

    /** Simulate an incoming message */
    receive(msg: IncomingMessage): void {
        this.handler?.(msg);
    }
}
