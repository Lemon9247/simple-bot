import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HttpServer } from "../src/server.js";
import type { ServerConfig } from "../src/types.js";

const TEST_TOKEN = "test-secret-token";
const TEST_PORT = 0; // Let OS assign a free port

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return {
        port: TEST_PORT,
        token: TEST_TOKEN,
        ...overrides,
    };
}

/** Helper: make an HTTP request and return status + body */
function fetch(
    url: string,
    options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
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
                        headers: res.headers as Record<string, string>,
                    }),
                );
            },
        );
        req.on("error", reject);
        req.end();
    });
}

/** Helper: make an HTTP request with a body */
function fetchWithBody(
    url: string,
    body: string,
    options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = request(
            {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                method: options.method ?? "POST",
                headers: options.headers ?? {},
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode!,
                        body: data,
                        headers: res.headers as Record<string, string>,
                    }),
                );
            },
        );
        req.on("error", reject);
        req.write(body);
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

// ─── Auth Tests ───────────────────────────────────────────────

describe("Token auth", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("rejects requests without Authorization header", async () => {
        const res = await fetch(`${baseUrl(server)}/api/ping`);
        expect(res.status).toBe(401);
        expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
    });

    it("rejects requests with wrong token", async () => {
        const res = await fetch(`${baseUrl(server)}/api/ping`, {
            headers: { Authorization: "Bearer wrong-token" },
        });
        expect(res.status).toBe(401);
    });

    it("rejects requests with malformed Authorization header", async () => {
        const res = await fetch(`${baseUrl(server)}/api/ping`, {
            headers: { Authorization: "Basic abc123" },
        });
        expect(res.status).toBe(401);
    });

    it("accepts requests with valid Bearer token", async () => {
        const res = await fetch(`${baseUrl(server)}/api/ping`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
    });
});

// ─── Route Tests ──────────────────────────────────────────────

describe("API routes", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("GET /api/ping returns { pong: true }", async () => {
        const res = await fetch(`${baseUrl(server)}/api/ping`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ pong: true });
    });

    it("GET /api/status returns health info", async () => {
        const res = await fetch(`${baseUrl(server)}/api/status`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.ok).toBe(true);
        expect(typeof body.uptime).toBe("number");
        expect(typeof body.startedAt).toBe("string");
    });

    it("POST /api/ping returns 405", async () => {
        const res = await fetch(`${baseUrl(server)}/api/ping`, {
            method: "POST",
            headers: authHeader(),
        });
        expect(res.status).toBe(405);
    });

    it("GET /api/nonexistent returns 404", async () => {
        const res = await fetch(`${baseUrl(server)}/api/nonexistent`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(404);
    });
});

// ─── Static File Serving ──────────────────────────────────────

describe("Static file serving", () => {
    let server: HttpServer;
    const tmpPublic = join(import.meta.dirname!, "__test_public__");

    beforeEach(async () => {
        mkdirSync(tmpPublic, { recursive: true });
        writeFileSync(join(tmpPublic, "index.html"), "<h1>Test</h1>");
        writeFileSync(join(tmpPublic, "style.css"), "body { color: red; }");
        server = new HttpServer(makeConfig({ publicDir: tmpPublic }));
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
        rmSync(tmpPublic, { recursive: true, force: true });
    });

    it("serves index.html at /", async () => {
        const res = await fetch(`${baseUrl(server)}/`);
        expect(res.status).toBe(200);
        expect(res.body).toContain("<h1>Test</h1>");
        expect(res.headers["content-type"]).toBe("text/html");
    });

    it("serves files by path", async () => {
        const res = await fetch(`${baseUrl(server)}/style.css`);
        expect(res.status).toBe(200);
        expect(res.body).toContain("color: red");
        expect(res.headers["content-type"]).toBe("text/css");
    });

    it("returns 404 for missing static files", async () => {
        const res = await fetch(`${baseUrl(server)}/missing.html`);
        expect(res.status).toBe(404);
    });

    it("blocks directory traversal (URL-normalized to 404)", async () => {
        // node:http normalizes /../.. to /, so the traversal resolves
        // within publicDir. The startsWith guard is defense-in-depth.
        const res = await fetch(`${baseUrl(server)}/../../../etc/passwd`);
        expect(res.status).toBe(404);
    });

    it("static routes do not require auth", async () => {
        const res = await fetch(`${baseUrl(server)}/`);
        expect(res.status).toBe(200);
    });
});

// ─── Lifecycle Tests ──────────────────────────────────────────

describe("Server lifecycle", () => {
    it("starts and stops cleanly", async () => {
        const server = new HttpServer(makeConfig());
        await server.start();

        const url = baseUrl(server);

        // Server is listening
        const res = await fetch(`${url}/api/ping`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);

        await server.stop();

        // Server is no longer listening — connection should fail
        await expect(
            fetch(`${url}/api/ping`, { headers: authHeader() }),
        ).rejects.toThrow();
    });

    it("uses port 0 to auto-assign", async () => {
        const server = new HttpServer(makeConfig({ port: 0 }));
        await server.start();
        const addr = server.raw.address();
        expect(addr).toBeTruthy();
        expect(typeof addr === "object" && addr!.port).toBeGreaterThan(0);
        await server.stop();
    });
});

// ─── WebSocket Upgrade Skeleton ───────────────────────────────

describe("WebSocket upgrade at /attach", () => {
    let server: HttpServer;

    beforeEach(async () => {
        server = new HttpServer(makeConfig());
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it("allows upgrade without auth (first-message auth required)", async () => {
        const addr = server.raw.address() as { port: number };
        const upgraded = await new Promise<boolean>((resolve, reject) => {
            const req = request(
                {
                    hostname: "127.0.0.1",
                    port: addr.port,
                    path: "/attach",
                    method: "GET",
                    headers: {
                        Upgrade: "websocket",
                        Connection: "Upgrade",
                        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
                        "Sec-WebSocket-Version": "13",
                    },
                },
                () => resolve(false),
            );
            req.on("upgrade", (_res, socket) => {
                socket.destroy();
                resolve(true);
            });
            req.on("error", reject);
            req.end();
        });
        expect(upgraded).toBe(true);
    });

    it("accepts upgrade with valid auth and completes handshake", async () => {
        const addr = server.raw.address() as { port: number };
        const upgraded = await new Promise<boolean>((resolve, reject) => {
            const req = request({
                hostname: "127.0.0.1",
                port: addr.port,
                path: "/attach",
                method: "GET",
                headers: {
                    Authorization: `Bearer ${TEST_TOKEN}`,
                    Upgrade: "websocket",
                    Connection: "Upgrade",
                    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
                    "Sec-WebSocket-Version": "13",
                },
            });
            req.on("upgrade", (_res, socket) => {
                socket.destroy();
                resolve(true);
            });
            req.on("response", () => resolve(false));
            req.on("error", reject);
            req.end();
        });
        expect(upgraded).toBe(true);
    });

    it("rejects upgrade on non-/attach paths", async () => {
        const addr = server.raw.address() as { port: number };
        const res = await new Promise<{ statusCode: number }>((resolve, reject) => {
            const req = request(
                {
                    hostname: "127.0.0.1",
                    port: addr.port,
                    path: "/other",
                    method: "GET",
                    headers: {
                        Authorization: `Bearer ${TEST_TOKEN}`,
                        Upgrade: "websocket",
                        Connection: "Upgrade",
                        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
                        "Sec-WebSocket-Version": "13",
                    },
                },
                (res) => resolve({ statusCode: res.statusCode! }),
            );
            req.on("error", reject);
            req.end();
        });
        expect(res.statusCode).toBe(404);
    });
});

// ─── Security Hardening (Phase 1) ────────────────────────────

describe("Security hardening (Phase 1)", () => {
    let server: HttpServer;
    const tmpPublic = join(import.meta.dirname!, "__test_security_public__");

    beforeEach(async () => {
        mkdirSync(tmpPublic, { recursive: true });
        writeFileSync(join(tmpPublic, "index.html"), "<h1>Security Test</h1>");
        server = new HttpServer(makeConfig({ publicDir: tmpPublic }));
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
        rmSync(tmpPublic, { recursive: true, force: true });
    });

    const EXPECTED_HEADERS = {
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
    };

    it("security headers present on API response", async () => {
        const res = await fetch(`${baseUrl(server)}/api/ping`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        for (const [header, value] of Object.entries(EXPECTED_HEADERS)) {
            expect(res.headers[header]).toBe(value);
        }
    });

    it("security headers present on static file response", async () => {
        const res = await fetch(`${baseUrl(server)}/`);
        expect(res.status).toBe(200);
        for (const [header, value] of Object.entries(EXPECTED_HEADERS)) {
            expect(res.headers[header]).toBe(value);
        }
    });

    it("body size limit: request under limit succeeds", async () => {
        // Set up a webhook handler so POST /api/webhook accepts bodies
        server.setWebhookHandler(async (msg) => ({ ok: true, queued: false }));
        const smallBody = JSON.stringify({ message: "hello", source: "test" });
        const res = await fetchWithBody(
            `${baseUrl(server)}/api/webhook`,
            smallBody,
            {
                headers: {
                    ...authHeader(),
                    "Content-Type": "application/json",
                },
            },
        );
        expect(res.status).toBeLessThan(413);
    });

    it("body size limit: request over limit returns 413", async () => {
        server.setWebhookHandler(async (msg) => ({ ok: true, queued: false }));
        // Create a body larger than 1MB
        const largeBody = "x".repeat(1_048_577 + 100);
        const res = await fetchWithBody(
            `${baseUrl(server)}/api/webhook`,
            largeBody,
            {
                headers: {
                    ...authHeader(),
                    "Content-Type": "application/json",
                },
            },
        );
        expect(res.status).toBe(413);
    });

    it("content-type validation: wrong type returns 415", async () => {
        server.setWebhookHandler(async (msg) => ({ ok: true, queued: false }));
        const res = await fetchWithBody(
            `${baseUrl(server)}/api/webhook`,
            "hello",
            {
                headers: {
                    ...authHeader(),
                    "Content-Type": "text/plain",
                },
            },
        );
        expect(res.status).toBe(415);
    });

    it("content-type validation: missing type accepted", async () => {
        server.setWebhookHandler(async (msg) => ({ ok: true, queued: false }));
        const body = JSON.stringify({ message: "hello", source: "test" });
        const res = await fetchWithBody(
            `${baseUrl(server)}/api/webhook`,
            body,
            {
                headers: authHeader(),
            },
        );
        // Should not be 415 — missing Content-Type is accepted
        expect(res.status).not.toBe(415);
    });

    it("timing-safe auth: valid token succeeds", async () => {
        const res = await fetch(`${baseUrl(server)}/api/ping`, {
            headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(res.status).toBe(200);
    });

    it("timing-safe auth: wrong token fails", async () => {
        const res = await fetch(`${baseUrl(server)}/api/ping`, {
            headers: { Authorization: "Bearer wrong-token-value" },
        });
        expect(res.status).toBe(401);
    });

    it("timing-safe auth: wrong length token fails", async () => {
        const res = await fetch(`${baseUrl(server)}/api/ping`, {
            headers: { Authorization: "Bearer x" },
        });
        expect(res.status).toBe(401);
    });
});
