import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HttpServer } from "../src/server.js";
import { RpcClient } from "../src/tui/rpc.js";
import type { ServerConfig } from "../src/types.js";

const TEST_TOKEN = "tui-rpc-token";

function makeConfig(): ServerConfig {
    return { port: 0, token: TEST_TOKEN };
}

function getAddr(server: HttpServer): { host: string; port: number } {
    const addr = server.raw.address();
    if (typeof addr === "string" || !addr) throw new Error("No address");
    return { host: "127.0.0.1", port: addr.port };
}

// ─── RPC Client Tests ─────────────────────────────────────────

describe("RpcClient", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("connects and disconnects cleanly", async () => {
        const { host, port } = getAddr(server);
        const rpc = new RpcClient(host, port, TEST_TOKEN);

        expect(rpc.connected).toBe(false);
        await rpc.connect();
        expect(rpc.connected).toBe(true);

        rpc.disconnect();
        // After disconnect, connected should be false
        expect(rpc.connected).toBe(false);
    });

    it("sends RPC commands and receives responses", async () => {
        server.setWsHandler(async (msg) => {
            if (msg.type === "get_state") {
                return { model: { name: "claude-haiku" }, contextTokens: 2500 };
            }
            return null;
        });

        const { host, port } = getAddr(server);
        const rpc = new RpcClient(host, port, TEST_TOKEN);
        await rpc.connect();

        const result = await rpc.send("get_state");
        expect(result.model.name).toBe("claude-haiku");
        expect(result.contextTokens).toBe(2500);

        rpc.disconnect();
    });

    it("handles RPC errors", async () => {
        server.setWsHandler(async () => {
            throw new Error("test error");
        });

        const { host, port } = getAddr(server);
        const rpc = new RpcClient(host, port, TEST_TOKEN);
        await rpc.connect();

        await expect(rpc.send("fail")).rejects.toThrow("test error");

        rpc.disconnect();
    });

    it("receives broadcast events", async () => {
        const { host, port } = getAddr(server);
        const rpc = new RpcClient(host, port, TEST_TOKEN);
        await rpc.connect();

        const events: any[] = [];
        rpc.on("event", (event) => events.push(event));

        server.broadcastEvent({ type: "agent_start" });
        server.broadcastEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } });

        await new Promise((r) => setTimeout(r, 100));

        expect(events).toHaveLength(2);
        expect(events[0].type).toBe("agent_start");
        expect(events[1].type).toBe("message_update");

        rpc.disconnect();
    });

    it("rejects pending commands on disconnect", async () => {
        server.setWsHandler(async () => {
            // Never respond — simulate hanging
            return new Promise(() => {});
        });

        const { host, port } = getAddr(server);
        const rpc = new RpcClient(host, port, TEST_TOKEN);
        await rpc.connect();

        const promise = rpc.send("hang");
        rpc.disconnect();

        await expect(promise).rejects.toThrow("Disconnected");
    });

    it("emits connected and disconnected events", async () => {
        const { host, port } = getAddr(server);
        const rpc = new RpcClient(host, port, TEST_TOKEN);

        const events: string[] = [];
        rpc.on("connected", () => events.push("connected"));
        rpc.on("disconnected", () => events.push("disconnected"));

        await rpc.connect();
        expect(events).toContain("connected");

        rpc.disconnect();
        await new Promise((r) => setTimeout(r, 100));
        expect(events).toContain("disconnected");
    });

    it("throws when sending without connection", async () => {
        const rpc = new RpcClient("127.0.0.1", 1, TEST_TOKEN);
        await expect(rpc.send("test")).rejects.toThrow("Not connected");
    });

    it("sends multiple concurrent commands correctly", async () => {
        server.setWsHandler(async (msg) => {
            // Simulate varying response times
            const delay = msg.type === "fast" ? 10 : 50;
            await new Promise((r) => setTimeout(r, delay));
            return { type: msg.type };
        });

        const { host, port } = getAddr(server);
        const rpc = new RpcClient(host, port, TEST_TOKEN);
        await rpc.connect();

        const [r1, r2, r3] = await Promise.all([
            rpc.send("fast"),
            rpc.send("slow"),
            rpc.send("fast"),
        ]);

        expect(r1.type).toBe("fast");
        expect(r2.type).toBe("slow");
        expect(r3.type).toBe("fast");

        rpc.disconnect();
    });
});
