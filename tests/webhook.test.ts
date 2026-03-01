import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { request } from "node:http";
import { HttpServer } from "../src/server.js";
import type { ServerConfig, WebhookHandler, WebhookResult } from "../src/types.js";

const TEST_TOKEN = "webhook-test-token";

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return {
        port: 0,
        token: TEST_TOKEN,
        ...overrides,
    };
}

function baseUrl(server: HttpServer): string {
    const addr = server.raw.address();
    if (typeof addr === "string" || !addr) throw new Error("No address");
    return `http://127.0.0.1:${addr.port}`;
}

function authHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
    };
}

/** HTTP helper that supports a request body */
function fetch(
    url: string,
    options: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    } = {},
): Promise<{ status: number; body: string; json: () => any }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = request(
            {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                method: options.method ?? "GET",
                headers: options.headers ?? {},
            },
            (res) => {
                let body = "";
                res.on("data", (chunk) => (body += chunk));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode!,
                        body,
                        json: () => JSON.parse(body),
                    }),
                );
            },
        );
        req.on("error", reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ─── Webhook Auth ─────────────────────────────────────────────

describe("Webhook auth", () => {
    let server: HttpServer;
    const handler: WebhookHandler = async () => ({ ok: true, response: "test" });

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        server.setWebhookHandler(handler);
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("returns 401 without Authorization header", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "hello" }),
        });
        expect(res.status).toBe(401);
        expect(res.json()).toEqual({ error: "Unauthorized" });
    });

    it("returns 401 with wrong token", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: {
                Authorization: "Bearer wrong-token",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ message: "hello" }),
        });
        expect(res.status).toBe(401);
    });
});

// ─── Webhook Validation ───────────────────────────────────────

describe("Webhook validation", () => {
    let server: HttpServer;
    const handler: WebhookHandler = async () => ({ ok: true, response: "test" });

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        server.setWebhookHandler(handler);
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("returns 400 for missing message field", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ source: "test" }),
        });
        expect(res.status).toBe(400);
        expect(res.json()).toEqual({ error: "Missing required field: message" });
    });

    it("returns 400 for empty message", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "   " }),
        });
        expect(res.status).toBe(400);
    });

    it("returns 400 for non-string message", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: 42 }),
        });
        expect(res.status).toBe(400);
    });

    it("returns 400 for invalid JSON body", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: "not json",
        });
        expect(res.status).toBe(400);
        expect(res.json()).toEqual({ error: "Invalid JSON body" });
    });

    it("returns 405 for GET /api/webhook", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "GET",
            headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(res.status).toBe(405);
    });
});

// ─── Webhook Happy Path ───────────────────────────────────────

describe("Webhook sends message and returns response", () => {
    let server: HttpServer;
    let receivedReq: any;

    beforeEach(async () => {
        receivedReq = null;
        const handler: WebhookHandler = async (req) => {
            receivedReq = req;
            return { ok: true, response: "Agent says hello back" };
        };
        server = new HttpServer(makeConfig());
        server.setWebhookHandler(handler);
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("passes message to handler and returns 200 with response", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "deploy complete" }),
        });
        expect(res.status).toBe(200);
        const json = res.json();
        expect(json.ok).toBe(true);
        expect(json.response).toBe("Agent says hello back");
        expect(receivedReq.message).toBe("deploy complete");
    });

    it("passes source, notify, and session fields to handler", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
                message: "commit pushed",
                source: "github",
                notify: "123456789",
                session: "abc",
            }),
        });
        expect(res.status).toBe(200);
        expect(receivedReq.source).toBe("github");
        expect(receivedReq.notify).toBe("123456789");
        expect(receivedReq.session).toBe("abc");
    });
});

// ─── Webhook Queued (busy agent) ──────────────────────────────

describe("Webhook queue behavior", () => {
    let server: HttpServer;

    beforeEach(async () => {
        const handler: WebhookHandler = async () => ({
            ok: true,
            queued: true,
        });
        server = new HttpServer(makeConfig());
        server.setWebhookHandler(handler);
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("returns 202 when handler signals queued", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "queued message" }),
        });
        expect(res.status).toBe(202);
        const json = res.json();
        expect(json.ok).toBe(true);
        expect(json.queued).toBe(true);
    });
});

// ─── Webhook Rate Limiting ────────────────────────────────────

describe("Webhook rate limiting", () => {
    let server: HttpServer;
    let callCount: number;

    beforeEach(async () => {
        callCount = 0;
        const handler: WebhookHandler = async () => {
            callCount++;
            return { ok: true, response: "ok" };
        };
        server = new HttpServer(makeConfig());
        server.setWebhookHandler(handler);
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("returns 429 after exceeding 10 requests per minute", async () => {
        const url = `${baseUrl(server)}/api/webhook`;
        const body = JSON.stringify({ message: "test" });

        // First 10 should succeed
        for (let i = 0; i < 10; i++) {
            const res = await fetch(url, {
                method: "POST",
                headers: authHeaders(),
                body,
            });
            expect(res.status).toBe(200);
        }

        // 11th should be rate limited
        const res = await fetch(url, {
            method: "POST",
            headers: authHeaders(),
            body,
        });
        expect(res.status).toBe(429);
        expect(res.json()).toEqual({ error: "Rate limit exceeded" });
        // Handler should not have been called for the rate-limited request
        expect(callCount).toBe(10);
    });

    it("uses separate rate limit buckets per source", async () => {
        const url = `${baseUrl(server)}/api/webhook`;

        // 10 requests from "github"
        for (let i = 0; i < 10; i++) {
            const res = await fetch(url, {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify({ message: "test", source: "github" }),
            });
            expect(res.status).toBe(200);
        }

        // "github" is now rate limited
        const limited = await fetch(url, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "test", source: "github" }),
        });
        expect(limited.status).toBe(429);

        // But "deploy" source still works
        const other = await fetch(url, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "test", source: "deploy" }),
        });
        expect(other.status).toBe(200);
    });
});

// ─── Webhook Source Prefix ────────────────────────────────────

describe("Webhook source in prompt prefix", () => {
    let server: HttpServer;
    let receivedReq: any;

    beforeEach(async () => {
        const handler: WebhookHandler = async (req) => {
            receivedReq = req;
            return { ok: true, response: "ok" };
        };
        server = new HttpServer(makeConfig());
        server.setWebhookHandler(handler);
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("handler receives source field for labeling", async () => {
        await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "test", source: "home-assistant" }),
        });
        expect(receivedReq.source).toBe("home-assistant");
    });

    it("source is optional", async () => {
        await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "test" }),
        });
        expect(receivedReq.source).toBeUndefined();
    });
});

// ─── Webhook Session Validation (P8-T14) ──────────────────

describe("Webhook session validation", () => {
    let server: HttpServer;
    let receivedReq: any;

    beforeEach(async () => {
        receivedReq = null;
        const handler: WebhookHandler = async (req) => {
            receivedReq = req;
            return { ok: true, response: "ok" };
        };
        // Create server with a DashboardProvider that knows about sessions
        const mockProvider = {
            getUptime: () => 0,
            getStartedAt: () => Date.now(),
            getModel: () => "test",
            getContextSize: () => 0,
            getListenerCount: () => 0,
            getCronJobs: () => [],
            getUsage: () => ({ today: { inputTokens: 0, outputTokens: 0, cost: 0, messageCount: 0 }, week: { cost: 0 }, contextSize: 0 }),
            getActivity: () => [],
            getLogs: () => [],
            getSessionNames: () => ["main", "work"],
            getSessionState: () => null,
            getUsageBySession: () => null,
        };
        server = new HttpServer(makeConfig(), mockProvider as any);
        server.setWebhookHandler(handler);
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("accepts webhook with valid session name", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "test", session: "main" }),
        });
        expect(res.status).toBe(200);
        expect(receivedReq.session).toBe("main");
    });

    it("accepts webhook with another valid session", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "test", session: "work" }),
        });
        expect(res.status).toBe(200);
        expect(receivedReq.session).toBe("work");
    });

    it("rejects webhook with unknown session name", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "test", session: "nonexistent" }),
        });
        expect(res.status).toBe(400);
        expect(res.json().error).toContain("Unknown session");
        expect(receivedReq).toBeNull(); // handler should not have been called
    });

    it("accepts webhook without session field (uses default)", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "test" }),
        });
        expect(res.status).toBe(200);
        expect(receivedReq.session).toBeUndefined();
    });
});

// ─── Handler not configured ───────────────────────────────────

describe("Webhook without handler", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        // Not calling setWebhookHandler
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("returns 503 when no webhook handler is set", async () => {
        const res = await fetch(`${baseUrl(server)}/api/webhook`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ message: "test" }),
        });
        expect(res.status).toBe(503);
    });
});
