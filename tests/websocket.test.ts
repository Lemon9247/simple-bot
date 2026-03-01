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

function wsUrl(server: HttpServer): string {
    const { host, port } = baseUrl(server);
    return `ws://${host}:${port}/attach`;
}

/** Connect and authenticate via first-message auth, returns the authenticated WebSocket */
async function connectAndAuth(server: HttpServer, token?: string): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl(server));
    await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
            ws.send(JSON.stringify({ type: "auth", token: token ?? TEST_TOKEN }));
        };
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data as string);
            if (msg.type === "auth_ok") {
                ws.onmessage = null;
                resolve();
            } else if (msg.type === "error") {
                reject(new Error(msg.error));
            }
        };
        ws.onerror = () => reject(new Error("Connection failed"));
    });
    return ws;
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

    it("connects with valid token via first-message auth", async () => {
        const ws = await connectAndAuth(server);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        expect(server.wsClientCount).toBe(1);
        ws.close();
    });

    it("rejects connection with wrong token", async () => {
        const ws = new WebSocket(wsUrl(server));
        const error = await new Promise<string>((resolve) => {
            ws.onopen = () => {
                ws.send(JSON.stringify({ type: "auth", token: "wrong-token" }));
            };
            ws.onmessage = (ev) => {
                const msg = JSON.parse(ev.data as string);
                if (msg.type === "error") resolve(msg.error);
            };
            ws.onclose = () => resolve("closed");
        });
        expect(error).toBe("Unauthorized");
    });

    it("tracks client count on connect/disconnect", async () => {
        expect(server.wsClientCount).toBe(0);

        const ws1 = await connectAndAuth(server);
        expect(server.wsClientCount).toBe(1);

        const ws2 = await connectAndAuth(server);
        expect(server.wsClientCount).toBe(2);

        ws1.close();
        await new Promise<void>((resolve) => { ws1.onclose = () => resolve(); });
        await new Promise((r) => setTimeout(r, 50));
        expect(server.wsClientCount).toBe(1);

        ws2.close();
        await new Promise<void>((resolve) => { ws2.onclose = () => resolve(); });
        await new Promise((r) => setTimeout(r, 50));
        expect(server.wsClientCount).toBe(0);
    });

    it("receives broadcast events", async () => {
        const ws = await connectAndAuth(server);

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
        const ws1 = await connectAndAuth(server);
        const ws2 = await connectAndAuth(server);

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

    it("does not broadcast to unauthenticated connections", async () => {
        // Connect but don't authenticate
        const unauthWs = new WebSocket(wsUrl(server));
        await new Promise<void>((resolve) => { unauthWs.onopen = () => resolve(); });

        // Connect and authenticate
        const authWs = await connectAndAuth(server);

        const unauthReceived: any[] = [];
        const authReceived: any[] = [];
        unauthWs.onmessage = (ev) => unauthReceived.push(JSON.parse(ev.data as string));
        authWs.onmessage = (ev) => authReceived.push(JSON.parse(ev.data as string));

        server.broadcastEvent({ type: "test", data: "secret" });

        await new Promise((r) => setTimeout(r, 50));
        expect(authReceived).toHaveLength(1);
        expect(unauthReceived).toHaveLength(0);

        unauthWs.close();
        authWs.close();
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

        const ws = await connectAndAuth(server);

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

        const ws = await connectAndAuth(server);

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
        const ws = await connectAndAuth(server);

        const response = await new Promise<any>((resolve) => {
            ws.onmessage = (ev) => resolve(JSON.parse(ev.data as string));
            ws.send("not json");
        });

        expect(response.type).toBe("error");
        expect(response.error).toContain("Invalid JSON");

        ws.close();
    });

    it("rejects messages without type field", async () => {
        const ws = await connectAndAuth(server);

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

        const ws = await connectAndAuth(server);

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
        const ws = await connectAndAuth(server);

        const response = await new Promise<any>((resolve) => {
            ws.onmessage = (ev) => resolve(JSON.parse(ev.data as string));
            ws.send(JSON.stringify({ id: "req-5", type: "anything" }));
        });

        expect(response.success).toBe(false);
        expect(response.error).toContain("No handler");

        ws.close();
    });
});

// ─── Auth Tests ───────────────────────────────────────────────

describe("WebSocket first-message auth", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("accepts valid token via first message", async () => {
        const ws = await connectAndAuth(server);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        expect(server.wsClientCount).toBe(1);
        ws.close();
    });

    it("rejects empty token", async () => {
        const ws = new WebSocket(wsUrl(server));
        const closed = await new Promise<boolean>((resolve) => {
            ws.onopen = () => {
                ws.send(JSON.stringify({ type: "auth", token: "" }));
            };
            ws.onclose = () => resolve(true);
            ws.onerror = () => {};
        });
        expect(closed).toBe(true);
        expect(server.wsClientCount).toBe(0);
    });

    it("rejects non-auth first message", async () => {
        const ws = new WebSocket(wsUrl(server));
        const error = await new Promise<string>((resolve) => {
            ws.onopen = () => {
                ws.send(JSON.stringify({ type: "get_state" }));
            };
            ws.onmessage = (ev) => {
                const msg = JSON.parse(ev.data as string);
                if (msg.type === "error") resolve(msg.error);
            };
            ws.onclose = () => resolve("closed");
        });
        expect(error).toBe("Unauthorized");
    });
});
