import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HttpServer } from "../src/server.js";
import { VaultFiles } from "../src/vault/files.js";
import { VaultGit } from "../src/vault/git.js";
import type { ServerConfig } from "../src/types.js";

const TEST_TOKEN = "vault-test-token";
const VAULT_DIR = join(import.meta.dirname!, "__test_vault_routes__");

function makeConfig(): ServerConfig {
    return { port: 0, token: TEST_TOKEN };
}

/** HTTP request helper that supports sending a body */
function fetch(
    url: string,
    options: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    } = {},
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = request(
            {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                method: options.method ?? "GET",
                headers: {
                    ...(options.headers ?? {}),
                    ...(options.body ? { "Content-Type": "application/json" } : {}),
                },
            },
            (res) => {
                let body = "";
                res.on("data", (chunk) => (body += chunk));
                res.on("end", () => resolve({ status: res.statusCode!, body }));
            },
        );
        req.on("error", reject);
        if (options.body) req.write(options.body);
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

// ─── File Routes ──────────────────────────────────────────────

describe("Vault file routes", () => {
    let server: HttpServer;

    beforeEach(async () => {
        mkdirSync(VAULT_DIR, { recursive: true });
        server = new HttpServer(makeConfig());
        server.setVault(new VaultFiles(VAULT_DIR), new VaultGit(VAULT_DIR));
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
        rmSync(VAULT_DIR, { recursive: true, force: true });
    });

    it("PUT + GET round-trip: write then read a file", async () => {
        const url = baseUrl(server);

        // Write
        const putRes = await fetch(`${url}/api/files/test.md`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "# Hello World" }),
        });
        expect(putRes.status).toBe(200);
        expect(JSON.parse(putRes.body)).toEqual({ ok: true, path: "test.md" });

        // Read
        const getRes = await fetch(`${url}/api/files/test.md`, {
            headers: authHeader(),
        });
        expect(getRes.status).toBe(200);
        const getBody = JSON.parse(getRes.body);
        expect(getBody.content).toBe("# Hello World");
        expect(getBody.mimeType).toBe("text/markdown");
    });

    it("PUT + DELETE + GET: write, delete, then read returns 404", async () => {
        const url = baseUrl(server);

        await fetch(`${url}/api/files/doomed.md`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "temporary" }),
        });

        const delRes = await fetch(`${url}/api/files/doomed.md`, {
            method: "DELETE",
            headers: authHeader(),
        });
        expect(delRes.status).toBe(200);

        const getRes = await fetch(`${url}/api/files/doomed.md`, {
            headers: authHeader(),
        });
        expect(getRes.status).toBe(404);
    });

    it("PUT creates nested directories automatically", async () => {
        const url = baseUrl(server);

        const putRes = await fetch(`${url}/api/files/deep/nested/file.md`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "deep" }),
        });
        expect(putRes.status).toBe(200);

        const getRes = await fetch(`${url}/api/files/deep/nested/file.md`, {
            headers: authHeader(),
        });
        expect(getRes.status).toBe(200);
        expect(JSON.parse(getRes.body).content).toBe("deep");
    });

    it("GET /api/files lists directory tree", async () => {
        const url = baseUrl(server);
        writeFileSync(join(VAULT_DIR, "a.md"), "");
        writeFileSync(join(VAULT_DIR, "b.md"), "");

        const res = await fetch(`${url}/api/files`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.entries).toHaveLength(2);
        expect(body.entries[0].name).toBe("a.md");
        expect(body.entries[1].name).toBe("b.md");
    });

    it("GET /api/files?search= filters by filename", async () => {
        const url = baseUrl(server);
        writeFileSync(join(VAULT_DIR, "notes.md"), "");
        writeFileSync(join(VAULT_DIR, "todo.md"), "");

        const res = await fetch(`${url}/api/files?search=notes`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.entries).toHaveLength(1);
        expect(body.entries[0].name).toBe("notes.md");
    });

    it("GET /api/files?dir= lists specific subdirectory", async () => {
        const url = baseUrl(server);
        mkdirSync(join(VAULT_DIR, "sub"), { recursive: true });
        writeFileSync(join(VAULT_DIR, "sub", "inner.md"), "");
        writeFileSync(join(VAULT_DIR, "outer.md"), "");

        const res = await fetch(`${url}/api/files?dir=sub`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.entries).toHaveLength(1);
        expect(body.entries[0].name).toBe("inner.md");
    });

    it("GET non-existent file returns 404", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/nope.md`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(404);
    });

    it("DELETE non-existent file returns 404", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/nope.md`, {
            method: "DELETE",
            headers: authHeader(),
        });
        expect(res.status).toBe(404);
    });

    it("PUT + GET round-trip with URL-encoded filename (spaces)", async () => {
        const url = baseUrl(server);

        const putRes = await fetch(`${url}/api/files/my%20notes/hello%20world.md`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "spaced out" }),
        });
        expect(putRes.status).toBe(200);

        const getRes = await fetch(`${url}/api/files/my%20notes/hello%20world.md`, {
            headers: authHeader(),
        });
        expect(getRes.status).toBe(200);
        const body = JSON.parse(getRes.body);
        expect(body.content).toBe("spaced out");
    });

    it("GET a directory path returns 400, not 500", async () => {
        const url = baseUrl(server);
        mkdirSync(join(VAULT_DIR, "somedir"), { recursive: true });

        const res = await fetch(`${url}/api/files/somedir`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toContain("directory");
    });

    it("PUT without content field returns 400", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/bad.md`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ text: "wrong field" }),
        });
        expect(res.status).toBe(400);
    });

    // ─── Path Traversal via HTTP ──────────────────────────

    it("blocks path traversal via GET", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/../../../etc/passwd`, {
            headers: authHeader(),
        });
        // node:http normalizes the URL path, so ../.. gets collapsed.
        // The VaultFiles layer provides defense-in-depth.
        expect([403, 404]).toContain(res.status);
    });

    it("blocks path traversal via PUT", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/..%2F..%2Fetc%2Fevil`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "hacked" }),
        });
        expect([403, 404]).toContain(res.status);
    });

    // ─── Auth ─────────────────────────────────────────────

    it("returns 401 without auth token on file routes", async () => {
        const url = baseUrl(server);
        writeFileSync(join(VAULT_DIR, "secret.md"), "secret");

        const res = await fetch(`${url}/api/files/secret.md`);
        expect(res.status).toBe(401);
    });

    it("returns 401 without auth token on file listing", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files`);
        expect(res.status).toBe(401);
    });

    // ─── Move ─────────────────────────────────────────────

    it("POST /api/files/move renames a file", async () => {
        const url = baseUrl(server);
        writeFileSync(join(VAULT_DIR, "old.md"), "content");

        const res = await fetch(`${url}/api/files/move`, {
            method: "POST",
            headers: authHeader(),
            body: JSON.stringify({ from: "old.md", to: "new.md" }),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toEqual({ ok: true, from: "old.md", to: "new.md" });

        // Old file gone
        const oldRes = await fetch(`${url}/api/files/old.md`, { headers: authHeader() });
        expect(oldRes.status).toBe(404);

        // New file exists with same content
        const newRes = await fetch(`${url}/api/files/new.md`, { headers: authHeader() });
        expect(newRes.status).toBe(200);
        expect(JSON.parse(newRes.body).content).toBe("content");
    });

    it("POST /api/files/move creates destination directories", async () => {
        const url = baseUrl(server);
        writeFileSync(join(VAULT_DIR, "file.md"), "deep move");

        const res = await fetch(`${url}/api/files/move`, {
            method: "POST",
            headers: authHeader(),
            body: JSON.stringify({ from: "file.md", to: "a/b/c/file.md" }),
        });
        expect(res.status).toBe(200);

        const getRes = await fetch(`${url}/api/files/a/b/c/file.md`, { headers: authHeader() });
        expect(getRes.status).toBe(200);
        expect(JSON.parse(getRes.body).content).toBe("deep move");
    });

    it("POST /api/files/move returns 404 for non-existent source", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/move`, {
            method: "POST",
            headers: authHeader(),
            body: JSON.stringify({ from: "ghost.md", to: "dest.md" }),
        });
        expect(res.status).toBe(404);
    });

    it("POST /api/files/move returns 400 for missing fields", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/move`, {
            method: "POST",
            headers: authHeader(),
            body: JSON.stringify({ from: "file.md" }),
        });
        expect(res.status).toBe(400);
    });

    it("POST /api/files/move blocks path traversal", async () => {
        const url = baseUrl(server);
        writeFileSync(join(VAULT_DIR, "safe.md"), "data");

        const res = await fetch(`${url}/api/files/move`, {
            method: "POST",
            headers: authHeader(),
            body: JSON.stringify({ from: "safe.md", to: "../../etc/evil" }),
        });
        expect([403, 404]).toContain(res.status);
    });

    // ─── Raw file endpoint ────────────────────────────────

    it("GET /api/files/<path>?raw=true returns raw binary with correct content type", async () => {
        const url = baseUrl(server);
        // Minimal PNG: 8-byte signature
        const pngBytes = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        writeFileSync(join(VAULT_DIR, "image.png"), pngBytes);

        const res = await fetch(`${url}/api/files/image.png?raw=true`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        // The body comes back as the raw bytes (our test helper reads as string,
        // but we can check status and that it's not JSON-wrapped)
        expect(res.body).not.toContain('"content"');
    });

    it("GET /api/files/<path>?raw=true returns 404 for missing file", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/nope.png?raw=true`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(404);
    });

    it("GET /api/files/<path>?raw=true returns text files with correct type", async () => {
        const url = baseUrl(server);
        writeFileSync(join(VAULT_DIR, "code.ts"), "const x = 1;");

        const res = await fetch(`${url}/api/files/code.ts?raw=true`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        expect(res.body).toBe("const x = 1;");
    });
});

// ─── Git Routes ───────────────────────────────────────────────

describe("Vault git routes", () => {
    let server: HttpServer;

    beforeEach(async () => {
        mkdirSync(VAULT_DIR, { recursive: true });
        execFileSync("git", ["init"], { cwd: VAULT_DIR });
        execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: VAULT_DIR });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: VAULT_DIR });

        server = new HttpServer(makeConfig());
        server.setVault(new VaultFiles(VAULT_DIR), new VaultGit(VAULT_DIR));
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
        rmSync(VAULT_DIR, { recursive: true, force: true });
    });

    it("GET /api/git/log returns commit history", async () => {
        const url = baseUrl(server);
        writeFileSync(join(VAULT_DIR, "file.md"), "content");
        execFileSync("git", ["add", "."], { cwd: VAULT_DIR });
        execFileSync("git", ["commit", "-m", "Test commit"], { cwd: VAULT_DIR });

        const res = await fetch(`${url}/api/git/log`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.entries).toHaveLength(1);
        expect(body.entries[0].message).toBe("Test commit");
        expect(body.entries[0].hash).toMatch(/^[0-9a-f]+$/);
    });

    it("GET /api/git/log?limit=1 respects limit", async () => {
        const url = baseUrl(server);
        writeFileSync(join(VAULT_DIR, "a.md"), "a");
        execFileSync("git", ["add", "."], { cwd: VAULT_DIR });
        execFileSync("git", ["commit", "-m", "First"], { cwd: VAULT_DIR });
        writeFileSync(join(VAULT_DIR, "b.md"), "b");
        execFileSync("git", ["add", "."], { cwd: VAULT_DIR });
        execFileSync("git", ["commit", "-m", "Second"], { cwd: VAULT_DIR });

        const res = await fetch(`${url}/api/git/log?limit=1`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.entries).toHaveLength(1);
        expect(body.entries[0].message).toBe("Second");
    });

    it("POST /api/git/sync commits changes", async () => {
        const url = baseUrl(server);
        // Need an initial commit first
        writeFileSync(join(VAULT_DIR, "init.md"), "init");
        execFileSync("git", ["add", "."], { cwd: VAULT_DIR });
        execFileSync("git", ["commit", "-m", "Initial"], { cwd: VAULT_DIR });

        // Write a new file, then sync
        writeFileSync(join(VAULT_DIR, "new.md"), "new content");

        const res = await fetch(`${url}/api/git/sync`, {
            method: "POST",
            headers: authHeader(),
            body: JSON.stringify({ message: "Sync via API" }),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.committed).toBe(true);

        // Verify the commit exists
        const logRes = await fetch(`${url}/api/git/log?limit=1`, {
            headers: authHeader(),
        });
        const logBody = JSON.parse(logRes.body);
        expect(logBody.entries[0].message).toBe("Sync via API");
    });

    it("POST /api/git/sync with nothing to commit", async () => {
        const url = baseUrl(server);
        writeFileSync(join(VAULT_DIR, "file.md"), "content");
        execFileSync("git", ["add", "."], { cwd: VAULT_DIR });
        execFileSync("git", ["commit", "-m", "Clean"], { cwd: VAULT_DIR });

        const res = await fetch(`${url}/api/git/sync`, {
            method: "POST",
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.committed).toBe(false);
    });

    it("GET /api/git/log returns empty array on empty repo", async () => {
        const url = baseUrl(server);

        const res = await fetch(`${url}/api/git/log`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.entries).toEqual([]);
    });

    it("returns 401 without auth on git routes", async () => {
        const url = baseUrl(server);

        const logRes = await fetch(`${url}/api/git/log`);
        expect(logRes.status).toBe(401);

        const syncRes = await fetch(`${url}/api/git/sync`, { method: "POST" });
        expect(syncRes.status).toBe(401);
    });
});
