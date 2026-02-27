import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HttpServer } from "../src/server.js";
import { RpcClient } from "../src/tui/rpc.js";
import { ChatDisplay } from "../src/tui/chat.js";
import { Footer } from "../src/tui/footer.js";
import type { ServerConfig } from "../src/types.js";

const TEST_TOKEN = "integration-token";

function makeConfig(): ServerConfig {
    return { port: 0, token: TEST_TOKEN };
}

function getAddr(server: HttpServer): { host: string; port: number } {
    const addr = server.raw.address();
    if (typeof addr === "string" || !addr) throw new Error("No address");
    return { host: "127.0.0.1", port: addr.port };
}

/**
 * Simulate a bridge event flow: agent_start → text deltas → tool → more text → agent_end
 */
function simulateBridgeResponse(server: HttpServer): void {
    server.broadcastEvent({ type: "agent_start" });
    server.broadcastEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Let me " },
    });
    server.broadcastEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "check that." },
    });
    server.broadcastEvent({
        type: "tool_execution_start",
        toolName: "read",
        args: { path: "src/server.ts" },
    });
    server.broadcastEvent({
        type: "tool_execution_end",
        toolName: "read",
        isError: false,
    });
    server.broadcastEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "\nDone!" },
    });
    server.broadcastEvent({ type: "agent_end" });
}

// ─── Integration: Server + RPC + Components ───────────────────

describe("TUI integration", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("full event flow updates chat and footer correctly", async () => {
        // Set up RPC handler that simulates a prompt response
        server.setWsHandler(async (msg) => {
            if (msg.type === "prompt") {
                // Simulate async response after the RPC ack
                setTimeout(() => simulateBridgeResponse(server), 10);
                return null; // RPC ack
            }
            if (msg.type === "get_state") {
                return { model: { name: "claude-sonnet" }, contextTokens: 8000 };
            }
            return null;
        });

        const { host, port } = getAddr(server);
        const rpc = new RpcClient(host, port, TEST_TOKEN);
        const chat = new ChatDisplay();
        const footer = new Footer();

        // Wire events like client.ts does
        rpc.on("event", (event: any) => {
            switch (event.type) {
                case "agent_start":
                    footer.setStatus("streaming");
                    break;
                case "message_update": {
                    const delta = event.assistantMessageEvent;
                    if (delta?.type === "text_delta") {
                        chat.appendText(delta.delta);
                    }
                    break;
                }
                case "tool_execution_start":
                    chat.addToolStart(event.toolName, event.args ?? {});
                    break;
                case "tool_execution_end":
                    chat.addToolEnd(event.toolName, event.isError ?? false);
                    break;
                case "agent_end":
                    chat.endStream();
                    footer.setStatus("idle");
                    break;
            }
        });

        await rpc.connect();

        // Get initial state
        const state = await rpc.send("get_state");
        footer.setModel(state.model.name);
        footer.setContextTokens(state.contextTokens);

        // Verify initial state
        expect(footer.render(80).join("")).toContain("claude-sonnet");
        expect(footer.render(80).join("")).toContain("8k");

        // Send a prompt
        chat.addUserMessage("Check the server");
        await rpc.send("prompt", { message: "Check the server" });

        // Wait for all events to arrive
        await new Promise((r) => setTimeout(r, 200));

        // Verify chat state
        expect(chat.streaming).toBe(false);
        const rendered = chat.render(80).join("\n");
        expect(rendered).toContain("Let me check that.");
        expect(rendered).toContain("Done!");
        expect(rendered).toContain("read");

        // Footer should be idle after agent_end
        expect(footer.render(80).join("")).toContain("idle");

        rpc.disconnect();
    });

    it("multiple clients receive the same events", async () => {
        server.setWsHandler(async () => null);

        const { host, port } = getAddr(server);
        const rpc1 = new RpcClient(host, port, TEST_TOKEN);
        const rpc2 = new RpcClient(host, port, TEST_TOKEN);

        const events1: any[] = [];
        const events2: any[] = [];
        rpc1.on("event", (e) => events1.push(e));
        rpc2.on("event", (e) => events2.push(e));

        await rpc1.connect();
        await rpc2.connect();

        server.broadcastEvent({ type: "agent_start" });
        server.broadcastEvent({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "shared" },
        });

        await new Promise((r) => setTimeout(r, 100));

        expect(events1).toHaveLength(2);
        expect(events2).toHaveLength(2);
        expect(events1[0].type).toBe("agent_start");
        expect(events2[1].assistantMessageEvent.delta).toBe("shared");

        rpc1.disconnect();
        rpc2.disconnect();
    });

    it("thinking events update footer status", async () => {
        const { host, port } = getAddr(server);
        const rpc = new RpcClient(host, port, TEST_TOKEN);
        const footer = new Footer();

        rpc.on("event", (event: any) => {
            if (event.type === "message_update") {
                const delta = event.assistantMessageEvent;
                if (delta?.type === "thinking_delta") {
                    footer.setStatus("thinking");
                }
            }
        });

        await rpc.connect();

        server.broadcastEvent({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
        });

        await new Promise((r) => setTimeout(r, 50));
        expect(footer.render(80).join("")).toContain("thinking");

        rpc.disconnect();
    });
});
