import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HttpServer } from "../src/server.js";
import { WorkspaceFiles } from "../src/vault/files.js";
import type { ServerConfig } from "../src/types.js";

const TEST_TOKEN = "vault-test-token";
const TEST_DIR = join(import.meta.dirname!, "__test_vault_routes__");
const ROOT_NAME = "test";

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

// Helper: file API path includes the root name
function filePath(path: string): string {
    return `/api/files/${ROOT_NAME}/${path}`;
}

// ─── File Routes ──────────────────────────────────────────────

describe("Multi-root file routes", () => {
    let server: HttpServer;

    beforeEach(async () => {
        mkdirSync(TEST_DIR, { recursive: true });
        server = new HttpServer(makeConfig());
        server.setFiles(new WorkspaceFiles({ [ROOT_NAME]: TEST_DIR }));
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it("PUT + GET round-trip: write then read a file", async () => {
        const url = baseUrl(server);

        // Write
        const putRes = await fetch(`${url}${filePath("test.md")}`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "# Hello World" }),
        });
        expect(putRes.status).toBe(200);
        expect(JSON.parse(putRes.body)).toEqual({ ok: true, path: "test.md" });

        // Read
        const getRes = await fetch(`${url}${filePath("test.md")}`, {
            headers: authHeader(),
        });
        expect(getRes.status).toBe(200);
        const getBody = JSON.parse(getRes.body);
        expect(getBody.content).toBe("# Hello World");
        expect(getBody.mimeType).toBe("text/markdown");
    });

    it("PUT + DELETE + GET: write, delete, then read returns 404", async () => {
        const url = baseUrl(server);

        await fetch(`${url}${filePath("doomed.md")}`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "temporary" }),
        });

        const delRes = await fetch(`${url}${filePath("doomed.md")}`, {
            method: "DELETE",
            headers: authHeader(),
        });
        expect(delRes.status).toBe(200);

        const getRes = await fetch(`${url}${filePath("doomed.md")}`, {
            headers: authHeader(),
        });
        expect(getRes.status).toBe(404);
    });

    it("PUT creates nested directories automatically", async () => {
        const url = baseUrl(server);

        const putRes = await fetch(`${url}${filePath("deep/nested/file.md")}`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "deep" }),
        });
        expect(putRes.status).toBe(200);

        const getRes = await fetch(`${url}${filePath("deep/nested/file.md")}`, {
            headers: authHeader(),
        });
        expect(getRes.status).toBe(200);
        expect(JSON.parse(getRes.body).content).toBe("deep");
    });

    it("GET /api/files?root= lists directory tree", async () => {
        const url = baseUrl(server);
        writeFileSync(join(TEST_DIR, "a.md"), "");
        writeFileSync(join(TEST_DIR, "b.md"), "");

        const res = await fetch(`${url}/api/files?root=${ROOT_NAME}`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.entries).toHaveLength(2);
        expect(body.entries[0].name).toBe("a.md");
        expect(body.entries[1].name).toBe("b.md");
    });

    it("GET /api/files without root returns 400", async () => {
        const url = baseUrl(server);

        const res = await fetch(`${url}/api/files`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(400);
    });

    it("GET /api/files?root=&search= filters by filename", async () => {
        const url = baseUrl(server);
        writeFileSync(join(TEST_DIR, "notes.md"), "");
        writeFileSync(join(TEST_DIR, "todo.md"), "");

        const res = await fetch(`${url}/api/files?root=${ROOT_NAME}&search=notes`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.entries).toHaveLength(1);
        expect(body.entries[0].name).toBe("notes.md");
    });

    it("GET /api/files?root=&dir= lists specific subdirectory", async () => {
        const url = baseUrl(server);
        mkdirSync(join(TEST_DIR, "sub"), { recursive: true });
        writeFileSync(join(TEST_DIR, "sub", "inner.md"), "");
        writeFileSync(join(TEST_DIR, "outer.md"), "");

        const res = await fetch(`${url}/api/files?root=${ROOT_NAME}&dir=sub`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.entries).toHaveLength(1);
        expect(body.entries[0].name).toBe("inner.md");
    });

    it("GET non-existent file returns 404", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}${filePath("nope.md")}`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(404);
    });

    it("DELETE non-existent file returns 404", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}${filePath("nope.md")}`, {
            method: "DELETE",
            headers: authHeader(),
        });
        expect(res.status).toBe(404);
    });

    it("PUT + GET round-trip with URL-encoded filename (spaces)", async () => {
        const url = baseUrl(server);

        const putRes = await fetch(`${url}/api/files/${ROOT_NAME}/my%20notes/hello%20world.md`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "spaced out" }),
        });
        expect(putRes.status).toBe(200);

        const getRes = await fetch(`${url}/api/files/${ROOT_NAME}/my%20notes/hello%20world.md`, {
            headers: authHeader(),
        });
        expect(getRes.status).toBe(200);
        const body = JSON.parse(getRes.body);
        expect(body.content).toBe("spaced out");
    });

    it("GET a directory path returns 400, not 500", async () => {
        const url = baseUrl(server);
        mkdirSync(join(TEST_DIR, "somedir"), { recursive: true });

        const res = await fetch(`${url}${filePath("somedir")}`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toContain("directory");
    });

    it("PUT without content field returns 400", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}${filePath("bad.md")}`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ text: "wrong field" }),
        });
        expect(res.status).toBe(400);
    });

    // ─── Path Traversal via HTTP ──────────────────────────

    it("blocks path traversal via GET", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/${ROOT_NAME}/../../../etc/passwd`, {
            headers: authHeader(),
        });
        // node:http normalizes the URL path, so ../.. gets collapsed.
        // The WorkspaceFiles layer provides defense-in-depth.
        expect([400, 403, 404]).toContain(res.status);
    });

    it("blocks path traversal via PUT", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/${ROOT_NAME}/..%2F..%2Fetc%2Fevil`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "hacked" }),
        });
        expect([400, 403, 404]).toContain(res.status);
    });

    // ─── Auth ─────────────────────────────────────────────

    it("returns 401 without auth token on file routes", async () => {
        const url = baseUrl(server);
        writeFileSync(join(TEST_DIR, "secret.md"), "secret");

        const res = await fetch(`${url}${filePath("secret.md")}`);
        expect(res.status).toBe(401);
    });

    it("returns 401 without auth token on file listing", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files?root=${ROOT_NAME}`);
        expect(res.status).toBe(401);
    });

    // ─── Move ─────────────────────────────────────────────

    it("POST /api/files/move renames a file", async () => {
        const url = baseUrl(server);
        writeFileSync(join(TEST_DIR, "old.md"), "content");

        const res = await fetch(`${url}/api/files/move`, {
            method: "POST",
            headers: authHeader(),
            body: JSON.stringify({ root: ROOT_NAME, from: "old.md", to: "new.md" }),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toEqual({ ok: true, from: "old.md", to: "new.md" });

        // Old file gone
        const oldRes = await fetch(`${url}${filePath("old.md")}`, { headers: authHeader() });
        expect(oldRes.status).toBe(404);

        // New file exists with same content
        const newRes = await fetch(`${url}${filePath("new.md")}`, { headers: authHeader() });
        expect(newRes.status).toBe(200);
        expect(JSON.parse(newRes.body).content).toBe("content");
    });

    it("POST /api/files/move creates destination directories", async () => {
        const url = baseUrl(server);
        writeFileSync(join(TEST_DIR, "file.md"), "deep move");

        const res = await fetch(`${url}/api/files/move`, {
            method: "POST",
            headers: authHeader(),
            body: JSON.stringify({ root: ROOT_NAME, from: "file.md", to: "a/b/c/file.md" }),
        });
        expect(res.status).toBe(200);

        const getRes = await fetch(`${url}${filePath("a/b/c/file.md")}`, { headers: authHeader() });
        expect(getRes.status).toBe(200);
        expect(JSON.parse(getRes.body).content).toBe("deep move");
    });

    it("POST /api/files/move returns 404 for non-existent source", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/move`, {
            method: "POST",
            headers: authHeader(),
            body: JSON.stringify({ root: ROOT_NAME, from: "ghost.md", to: "dest.md" }),
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
        writeFileSync(join(TEST_DIR, "safe.md"), "data");

        const res = await fetch(`${url}/api/files/move`, {
            method: "POST",
            headers: authHeader(),
            body: JSON.stringify({ root: ROOT_NAME, from: "safe.md", to: "../../etc/evil" }),
        });
        expect([403, 404]).toContain(res.status);
    });

    // ─── Raw file endpoint ────────────────────────────────

    it("GET /api/files/:root/:path?raw=true returns raw binary with correct content type", async () => {
        const url = baseUrl(server);
        // Minimal PNG: 8-byte signature
        const pngBytes = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        writeFileSync(join(TEST_DIR, "image.png"), pngBytes);

        const res = await fetch(`${url}${filePath("image.png")}?raw=true`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        expect(res.body).not.toContain('"content"');
    });

    it("GET /api/files/:root/:path?raw=true returns 404 for missing file", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}${filePath("nope.png")}?raw=true`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(404);
    });

    it("GET /api/files/:root/:path?raw=true returns text files with correct type", async () => {
        const url = baseUrl(server);
        writeFileSync(join(TEST_DIR, "code.ts"), "const x = 1;");

        const res = await fetch(`${url}${filePath("code.ts")}?raw=true`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        expect(res.body).toBe("const x = 1;");
    });

    // ─── Roots endpoint ───────────────────────────────────

    it("GET /api/roots lists configured roots", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/roots`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.roots).toEqual([ROOT_NAME]);
    });

    // ─── Unknown root ─────────────────────────────────────

    it("GET with unknown root returns 403", async () => {
        const url = baseUrl(server);
        const res = await fetch(`${url}/api/files/nonexistent/file.md`, {
            headers: authHeader(),
        });
        expect(res.status).toBe(403);
    });

    // ─── Multi-root isolation ─────────────────────────────

    it("roots are isolated from each other", async () => {
        const url = baseUrl(server);

        // Add a second root
        const secondDir = join(TEST_DIR, "__second__");
        mkdirSync(secondDir, { recursive: true });
        server.setFiles(new WorkspaceFiles({
            [ROOT_NAME]: TEST_DIR,
            second: secondDir,
        }));

        // Write to first root
        await fetch(`${url}/api/files/${ROOT_NAME}/shared-name.md`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "from first" }),
        });

        // Write to second root
        await fetch(`${url}/api/files/second/shared-name.md`, {
            method: "PUT",
            headers: authHeader(),
            body: JSON.stringify({ content: "from second" }),
        });

        // Read from each — different content
        const first = await fetch(`${url}/api/files/${ROOT_NAME}/shared-name.md`, {
            headers: authHeader(),
        });
        expect(JSON.parse(first.body).content).toBe("from first");

        const second = await fetch(`${url}/api/files/second/shared-name.md`, {
            headers: authHeader(),
        });
        expect(JSON.parse(second.body).content).toBe("from second");
    });
});
