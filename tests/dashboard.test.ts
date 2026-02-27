import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request } from "node:http";
import { HttpServer, type DashboardProvider } from "../src/server.js";
import type { ServerConfig, ActivityEntry } from "../src/types.js";

const TEST_TOKEN = "test-secret-token";

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return {
        port: 0,
        token: TEST_TOKEN,
        ...overrides,
    };
}

/** Helper: make an HTTP request and return status + parsed JSON body */
function fetchJson(
    url: string,
    options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
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
                let raw = "";
                res.on("data", (chunk) => (raw += chunk));
                res.on("end", () => {
                    try {
                        resolve({ status: res.statusCode!, body: JSON.parse(raw) });
                    } catch {
                        resolve({ status: res.statusCode!, body: raw });
                    }
                });
            },
        );
        req.on("error", reject);
        req.end();
    });
}

function authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${TEST_TOKEN}` };
}

function baseUrl(server: HttpServer): string {
    const addr = server.raw.address();
    if (typeof addr === "string" || !addr) throw new Error("No address");
    return `http://127.0.0.1:${addr.port}`;
}

// ─── Mock DashboardProvider ───────────────────────────────────

function makeMockProvider(overrides: Partial<DashboardProvider> = {}): DashboardProvider {
    return {
        getUptime: () => 120_000, // 2 minutes in ms
        getStartedAt: () => Date.now() - 120_000,
        getModel: () => "claude-sonnet-4-5",
        getContextSize: () => 45_000,
        getListenerCount: () => 2,
        getCronJobs: () => [
            { name: "morning-check", schedule: "0 9 * * *", enabled: true },
            { name: "weekly-report", schedule: "0 0 * * 1", enabled: false },
        ],
        getUsage: () => ({
            today: { inputTokens: 15000, outputTokens: 5000, cost: 0.12, messageCount: 8 },
            week: { cost: 0.85 },
            contextSize: 45_000,
        }),
        getActivity: () => [
            {
                sender: "alice",
                platform: "discord",
                channel: "123456",
                timestamp: Date.now() - 60_000,
                responseTimeMs: 3200,
            },
            {
                sender: "bob",
                platform: "matrix",
                channel: "#general:example.com",
                timestamp: Date.now() - 30_000,
                responseTimeMs: 1800,
            },
        ],
        getLogs: () => [
            { timestamp: "2026-02-27T12:00:00.000Z", level: "info", message: "Bot started" },
            { timestamp: "2026-02-27T12:01:00.000Z", level: "warn", message: "Rate limit hit", sender: "alice" },
        ],
        ...overrides,
    };
}

// ─── Dashboard API Tests ──────────────────────────────────────

describe("Dashboard API: /api/status (expanded)", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig(), makeMockProvider());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("returns expanded status with model, context, listeners", async () => {
        const { status, body } = await fetchJson(`${baseUrl(server)}/api/status`, {
            headers: authHeader(),
        });
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(typeof body.uptime).toBe("number");
        expect(body.uptime).toBe(120); // 120_000ms / 1000
        expect(body.model).toBe("claude-sonnet-4-5");
        expect(body.contextSize).toBe(45_000);
        expect(body.listenerCount).toBe(2);
        expect(typeof body.startedAt).toBe("string");
    });

    it("requires auth", async () => {
        const { status } = await fetchJson(`${baseUrl(server)}/api/status`);
        expect(status).toBe(401);
    });
});

describe("Dashboard API: /api/status (no provider)", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("falls back to basic status without provider", async () => {
        const { status, body } = await fetchJson(`${baseUrl(server)}/api/status`, {
            headers: authHeader(),
        });
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(typeof body.uptime).toBe("number");
        expect(body.model).toBeUndefined();
        expect(body.contextSize).toBeUndefined();
    });
});

describe("Dashboard API: /api/cron", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig(), makeMockProvider());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("returns job list with name, schedule, enabled", async () => {
        const { status, body } = await fetchJson(`${baseUrl(server)}/api/cron`, {
            headers: authHeader(),
        });
        expect(status).toBe(200);
        expect(body.jobs).toHaveLength(2);
        expect(body.jobs[0]).toEqual({
            name: "morning-check",
            schedule: "0 9 * * *",
            enabled: true,
        });
        expect(body.jobs[1]).toEqual({
            name: "weekly-report",
            schedule: "0 0 * * 1",
            enabled: false,
        });
    });

    it("requires auth", async () => {
        const { status } = await fetchJson(`${baseUrl(server)}/api/cron`);
        expect(status).toBe(401);
    });

    it("returns empty jobs without provider", async () => {
        const noProviderServer = new HttpServer(makeConfig());
        await noProviderServer.start();
        const { body } = await fetchJson(`${baseUrl(noProviderServer)}/api/cron`, {
            headers: authHeader(),
        });
        expect(body.jobs).toEqual([]);
        await noProviderServer.stop();
    });
});

describe("Dashboard API: /api/usage", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig(), makeMockProvider());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("returns today/week cost, tokens, message count, context", async () => {
        const { status, body } = await fetchJson(`${baseUrl(server)}/api/usage`, {
            headers: authHeader(),
        });
        expect(status).toBe(200);
        expect(body.today.inputTokens).toBe(15000);
        expect(body.today.outputTokens).toBe(5000);
        expect(body.today.cost).toBe(0.12);
        expect(body.today.messageCount).toBe(8);
        expect(body.week.cost).toBe(0.85);
        expect(body.contextSize).toBe(45_000);
    });

    it("requires auth", async () => {
        const { status } = await fetchJson(`${baseUrl(server)}/api/usage`);
        expect(status).toBe(401);
    });

    it("returns zeros without provider", async () => {
        const noProviderServer = new HttpServer(makeConfig());
        await noProviderServer.start();
        const { body } = await fetchJson(`${baseUrl(noProviderServer)}/api/usage`, {
            headers: authHeader(),
        });
        expect(body.today.cost).toBe(0);
        expect(body.week.cost).toBe(0);
        expect(body.contextSize).toBe(0);
        await noProviderServer.stop();
    });
});

describe("Dashboard API: /api/activity", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig(), makeMockProvider());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("returns recent activity entries", async () => {
        const { status, body } = await fetchJson(`${baseUrl(server)}/api/activity`, {
            headers: authHeader(),
        });
        expect(status).toBe(200);
        expect(body.entries).toHaveLength(2);
        expect(body.entries[0].sender).toBe("alice");
        expect(body.entries[0].platform).toBe("discord");
        expect(typeof body.entries[0].timestamp).toBe("number");
        expect(body.entries[0].responseTimeMs).toBe(3200);
        expect(body.entries[1].sender).toBe("bob");
    });

    it("requires auth", async () => {
        const { status } = await fetchJson(`${baseUrl(server)}/api/activity`);
        expect(status).toBe(401);
    });

    it("returns empty entries without provider", async () => {
        const noProviderServer = new HttpServer(makeConfig());
        await noProviderServer.start();
        const { body } = await fetchJson(`${baseUrl(noProviderServer)}/api/activity`, {
            headers: authHeader(),
        });
        expect(body.entries).toEqual([]);
        await noProviderServer.stop();
    });
});

describe("Dashboard API: /api/logs", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig(), makeMockProvider());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("returns log entries with timestamp, level, message", async () => {
        const { status, body } = await fetchJson(`${baseUrl(server)}/api/logs`, {
            headers: authHeader(),
        });
        expect(status).toBe(200);
        expect(body.entries).toHaveLength(2);
        expect(body.entries[0].level).toBe("info");
        expect(body.entries[0].message).toBe("Bot started");
        expect(body.entries[1].level).toBe("warn");
        expect(body.entries[1].message).toBe("Rate limit hit");
        expect(body.entries[1].sender).toBe("alice"); // extra field preserved
    });

    it("requires auth", async () => {
        const { status } = await fetchJson(`${baseUrl(server)}/api/logs`);
        expect(status).toBe(401);
    });

    it("returns empty entries without provider", async () => {
        const noProviderServer = new HttpServer(makeConfig());
        await noProviderServer.start();
        const { body } = await fetchJson(`${baseUrl(noProviderServer)}/api/logs`, {
            headers: authHeader(),
        });
        expect(body.entries).toEqual([]);
        await noProviderServer.stop();
    });
});

// ─── Log Buffer Tests ─────────────────────────────────────────

describe("Log ring buffer", () => {
    it("captures log entries and respects capacity", async () => {
        // Import dynamically to avoid polluting other tests
        const logger = await import("../src/logger.js");
        logger.clearLogBuffer();

        logger.info("test message 1");
        logger.warn("test message 2", { extra: "data" });
        logger.error("test message 3");

        const buffer = logger.getLogBuffer();
        expect(buffer).toHaveLength(3);
        expect(buffer[0].level).toBe("info");
        expect(buffer[0].message).toBe("test message 1");
        expect(buffer[1].level).toBe("warn");
        expect(buffer[1].message).toBe("test message 2");
        expect((buffer[1] as any).extra).toBe("data");
        expect(buffer[2].level).toBe("error");
        expect(buffer[2].message).toBe("test message 3");

        // Returned array is a copy
        buffer.push({ timestamp: "x", level: "info", message: "injected" });
        expect(logger.getLogBuffer()).toHaveLength(3);

        logger.clearLogBuffer();
        expect(logger.getLogBuffer()).toHaveLength(0);
    });
});

// ─── Tracker.currentModel() Tests ─────────────────────────────

describe("Tracker.currentModel()", () => {
    it("returns 'unknown' when empty", async () => {
        const { Tracker } = await import("../src/tracker.js");
        const t = new Tracker();
        expect(t.currentModel()).toBe("unknown");
    });

    it("returns model from most recent event", async () => {
        const { Tracker } = await import("../src/tracker.js");
        const t = new Tracker();
        t.record({ model: "gpt-4o", inputTokens: 100, outputTokens: 50, contextSize: 1000 });
        t.record({ model: "claude-sonnet-4-5", inputTokens: 200, outputTokens: 100, contextSize: 2000 });
        expect(t.currentModel()).toBe("claude-sonnet-4-5");
    });
});

// ─── HTTP Integration Tests (T21) ─────────────────────────────
// Consolidated tests: auth + valid JSON + response shape for all dashboard endpoints

describe("Dashboard HTTP integration", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig(), makeMockProvider());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    const endpoints = ["/api/status", "/api/cron", "/api/usage", "/api/activity", "/api/logs"];

    for (const endpoint of endpoints) {
        it(`${endpoint} returns 401 without auth`, async () => {
            const { status, body } = await fetchJson(`${baseUrl(server)}${endpoint}`);
            expect(status).toBe(401);
            expect(body.error).toBe("Unauthorized");
        });

        it(`${endpoint} returns valid JSON with auth`, async () => {
            const { status, body } = await fetchJson(`${baseUrl(server)}${endpoint}`, {
                headers: authHeader(),
            });
            expect(status).toBe(200);
            expect(body).toBeDefined();
            expect(typeof body).toBe("object");
        });
    }

    it("/api/status response has required fields", async () => {
        const { body } = await fetchJson(`${baseUrl(server)}/api/status`, {
            headers: authHeader(),
        });
        expect(body).toMatchObject({
            ok: true,
            model: expect.any(String),
            contextSize: expect.any(Number),
            listenerCount: expect.any(Number),
            uptime: expect.any(Number),
            startedAt: expect.any(String),
        });
    });

    it("/api/usage response has required fields", async () => {
        const { body } = await fetchJson(`${baseUrl(server)}/api/usage`, {
            headers: authHeader(),
        });
        expect(body).toMatchObject({
            today: {
                inputTokens: expect.any(Number),
                outputTokens: expect.any(Number),
                cost: expect.any(Number),
                messageCount: expect.any(Number),
            },
            week: { cost: expect.any(Number) },
            contextSize: expect.any(Number),
        });
    });

    it("/api/cron response has jobs array", async () => {
        const { body } = await fetchJson(`${baseUrl(server)}/api/cron`, {
            headers: authHeader(),
        });
        expect(Array.isArray(body.jobs)).toBe(true);
        expect(body.jobs[0]).toMatchObject({
            name: expect.any(String),
            schedule: expect.any(String),
            enabled: expect.any(Boolean),
        });
    });

    it("/api/activity response has entries array", async () => {
        const { body } = await fetchJson(`${baseUrl(server)}/api/activity`, {
            headers: authHeader(),
        });
        expect(Array.isArray(body.entries)).toBe(true);
        expect(body.entries[0]).toMatchObject({
            sender: expect.any(String),
            platform: expect.any(String),
            channel: expect.any(String),
            timestamp: expect.any(Number),
            responseTimeMs: expect.any(Number),
        });
    });

    it("/api/logs response has entries array", async () => {
        const { body } = await fetchJson(`${baseUrl(server)}/api/logs`, {
            headers: authHeader(),
        });
        expect(Array.isArray(body.entries)).toBe(true);
        expect(body.entries[0]).toMatchObject({
            timestamp: expect.any(String),
            level: expect.any(String),
            message: expect.any(String),
        });
    });
});

// ─── Method-not-allowed on new routes ─────────────────────────

describe("Dashboard API: method restrictions", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig(), makeMockProvider());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    for (const route of ["/api/cron", "/api/usage", "/api/activity", "/api/logs"]) {
        it(`POST ${route} returns 405`, async () => {
            const { status } = await fetchJson(`${baseUrl(server)}${route}`, {
                method: "POST",
                headers: authHeader(),
            });
            expect(status).toBe(405);
        });
    }
});
