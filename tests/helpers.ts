import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { Listener, IncomingMessage, MessageOrigin } from "../src/types.js";

/**
 * Creates a fake child process that speaks pi's RPC protocol.
 * Responds to follow_up/prompt with a canned agent response.
 */
export function createMockProcess(responseText = "Hello world!") {
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

            // Acknowledge the command
            stdout.write(
                JSON.stringify({
                    id: cmd.id,
                    type: "response",
                    command: cmd.type,
                    success: true,
                }) + "\n"
            );

            // Simulate agent processing for message commands
            if (cmd.type === "follow_up" || cmd.type === "prompt") {
                stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
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
