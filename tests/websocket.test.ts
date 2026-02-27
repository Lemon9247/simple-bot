import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HttpServer } from "../src/server.js";
import type { ServerConfig } from "../src/types.js";

const TEST_TOKEN = "test-ws-token";

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return { port: 0, token: TEST_TOKEN, ...overrides };
}

function baseUrl(server: HttpServer): { host: string; port: number } {
    const addr = server.raw.address();
    if (typeof addr === "string" || !addr) throw new Error("No address");
    return { host: "127.0.0.1", port: addr.port };
}

function wsUrl(server: HttpServer, token?: string): string {
    const { host, port } = baseUrl(server);
    const tok = token ?? TEST_TOKEN;
    return `ws://${host}:${port}/attach?token=${encodeURIComponent(tok)}`;
}

// ─── WebSocket Connection Tests ───────────────────────────────

describe("WebSocket at /attach", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("connects with valid token in query param", async () => {
        const ws = new WebSocket(wsUrl(server));
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("Connection failed"));
        });
        expect(ws.readyState).toBe(WebSocket.OPEN);
        expect(server.wsClientCount).toBe(1);
        ws.close();
    });

    it("rejects connection with wrong token", async () => {
        const ws = new WebSocket(wsUrl(server, "wrong-token"));
        const closed = await new Promise<boolean>((resolve) => {
            ws.onopen = () => resolve(false);
            ws.onclose = () => resolve(true);
            ws.onerror = () => {}; // suppress
        });
        expect(closed).toBe(true);
    });

    it("tracks client count on connect/disconnect", async () => {
        expect(server.wsClientCount).toBe(0);

        const ws1 = new WebSocket(wsUrl(server));
        await new Promise<void>((resolve) => { ws1.onopen = () => resolve(); });
        expect(server.wsClientCount).toBe(1);

        const ws2 = new WebSocket(wsUrl(server));
        await new Promise<void>((resolve) => { ws2.onopen = () => resolve(); });
        expect(server.wsClientCount).toBe(2);

        ws1.close();
        await new Promise<void>((resolve) => { ws1.onclose = () => resolve(); });
        // Small delay for server to process
        await new Promise((r) => setTimeout(r, 50));
        expect(server.wsClientCount).toBe(1);

        ws2.close();
        await new Promise<void>((resolve) => { ws2.onclose = () => resolve(); });
        await new Promise((r) => setTimeout(r, 50));
        expect(server.wsClientCount).toBe(0);
    });

    it("receives broadcast events", async () => {
        const ws = new WebSocket(wsUrl(server));
        await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

        const received: any[] = [];
        ws.onmessage = (ev) => {
            received.push(JSON.parse(ev.data as string));
        };

        server.broadcastEvent({ type: "test_event", data: "hello" });

        await new Promise((r) => setTimeout(r, 50));
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({ type: "test_event", data: "hello" });

        ws.close();
    });

    it("broadcasts to all connected clients", async () => {
        const ws1 = new WebSocket(wsUrl(server));
        const ws2 = new WebSocket(wsUrl(server));
        await Promise.all([
            new Promise<void>((r) => { ws1.onopen = () => r(); }),
            new Promise<void>((r) => { ws2.onopen = () => r(); }),
        ]);

        const received1: any[] = [];
        const received2: any[] = [];
        ws1.onmessage = (ev) => received1.push(JSON.parse(ev.data as string));
        ws2.onmessage = (ev) => received2.push(JSON.parse(ev.data as string));

        server.broadcastEvent({ type: "ping", n: 1 });

        await new Promise((r) => setTimeout(r, 50));
        expect(received1).toHaveLength(1);
        expect(received2).toHaveLength(1);
        expect(received1[0]).toEqual({ type: "ping", n: 1 });
        expect(received2[0]).toEqual({ type: "ping", n: 1 });

        ws1.close();
        ws2.close();
    });
});

// ─── WebSocket RPC Tests ──────────────────────────────────────

describe("WebSocket RPC handler", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("routes commands to wsHandler and returns response", async () => {
        server.setWsHandler(async (msg) => {
            if (msg.type === "get_state") {
                return { model: { name: "test-model" }, contextTokens: 5000 };
            }
            return null;
        });

        const ws = new WebSocket(wsUrl(server));
        await new Promise<void>((r) => { ws.onopen = () => r(); });

        const response = await new Promise<any>((resolve) => {
            ws.onmessage = (ev) => {
                const msg = JSON.parse(ev.data as string);
                if (msg.type === "response") resolve(msg);
            };
            ws.send(JSON.stringify({ id: "req-1", type: "get_state" }));
        });

        expect(response.id).toBe("req-1");
        expect(response.success).toBe(true);
        expect(response.data.model.name).toBe("test-model");
        expect(response.data.contextTokens).toBe(5000);

        ws.close();
    });

    it("returns error when handler throws", async () => {
        server.setWsHandler(async () => {
            throw new Error("Pi process not running");
        });

        const ws = new WebSocket(wsUrl(server));
        await new Promise<void>((r) => { ws.onopen = () => r(); });

        const response = await new Promise<any>((resolve) => {
            ws.onmessage = (ev) => resolve(JSON.parse(ev.data as string));
            ws.send(JSON.stringify({ id: "req-2", type: "fail" }));
        });

        expect(response.id).toBe("req-2");
        expect(response.success).toBe(false);
        expect(response.error).toContain("Pi process not running");

        ws.close();
    });

    it("rejects invalid JSON", async () => {
        const ws = new WebSocket(wsUrl(server));
        await new Promise<void>((r) => { ws.onopen = () => r(); });

        const response = await new Promise<any>((resolve) => {
            ws.onmessage = (ev) => resolve(JSON.parse(ev.data as string));
            ws.send("not json");
        });

        expect(response.type).toBe("error");
        expect(response.error).toContain("Invalid JSON");

        ws.close();
    });

    it("rejects messages without type field", async () => {
        const ws = new WebSocket(wsUrl(server));
        await new Promise<void>((r) => { ws.onopen = () => r(); });

        const response = await new Promise<any>((resolve) => {
            ws.onmessage = (ev) => resolve(JSON.parse(ev.data as string));
            ws.send(JSON.stringify({ id: "req-3", data: "no type" }));
        });

        expect(response.success).toBe(false);
        expect(response.error).toContain("Missing type");

        ws.close();
    });

    it("strips id and type before forwarding to handler", async () => {
        let receivedMsg: any = null;
        server.setWsHandler(async (msg) => {
            receivedMsg = msg;
            return "ok";
        });

        const ws = new WebSocket(wsUrl(server));
        await new Promise<void>((r) => { ws.onopen = () => r(); });

        await new Promise<void>((resolve) => {
            ws.onmessage = () => resolve();
            ws.send(JSON.stringify({ id: "req-4", type: "prompt", message: "hello" }));
        });

        // Handler receives type (for routing) but not the client id
        expect(receivedMsg.type).toBe("prompt");
        expect(receivedMsg.message).toBe("hello");
        expect(receivedMsg.id).toBeUndefined();

        ws.close();
    });

    it("returns error when no handler is configured", async () => {
        // Don't set a handler
        const ws = new WebSocket(wsUrl(server));
        await new Promise<void>((r) => { ws.onopen = () => r(); });

        const response = await new Promise<any>((resolve) => {
            ws.onmessage = (ev) => resolve(JSON.parse(ev.data as string));
            ws.send(JSON.stringify({ id: "req-5", type: "anything" }));
        });

        expect(response.success).toBe(false);
        expect(response.error).toContain("No handler");

        ws.close();
    });
});

// ─── Auth Token via Query Param ───────────────────────────────

describe("WebSocket auth via query param", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("accepts token in query param", async () => {
        const { host, port } = baseUrl(server);
        const ws = new WebSocket(`ws://${host}:${port}/attach?token=${TEST_TOKEN}`);
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("Connection failed"));
        });
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
    });

    it("rejects empty token in query param", async () => {
        const { host, port } = baseUrl(server);
        const ws = new WebSocket(`ws://${host}:${port}/attach?token=`);
        const closed = await new Promise<boolean>((resolve) => {
            ws.onopen = () => resolve(false);
            ws.onclose = () => resolve(true);
            ws.onerror = () => {};
        });
        expect(closed).toBe(true);
    });
});
