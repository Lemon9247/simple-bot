import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ServerConfig } from "./types.js";
import * as logger from "./logger.js";

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
};

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export class HttpServer {
    private server: Server;
    private config: ServerConfig;
    private publicDir: string;
    private startTime: number;
    private routes = new Map<string, Map<string, RouteHandler>>();

    constructor(config: ServerConfig) {
        this.config = config;
        this.publicDir = config.publicDir
            ? resolve(config.publicDir)
            : resolve("public");
        this.startTime = Date.now();

        this.server = createServer((req, res) => this.handleRequest(req, res));
        this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));

        this.registerRoutes();
    }

    /** Expose the underlying http.Server for testing */
    get raw(): Server {
        return this.server;
    }

    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.config.port, () => {
                this.server.removeListener("error", reject);
                logger.info("HTTP server listening", { port: this.config.port });
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.server.closeAllConnections();
            }, 5000);
            this.server.close(() => {
                clearTimeout(timeout);
                logger.info("HTTP server stopped");
                resolve();
            });
            this.server.closeIdleConnections();
        });
    }

    private registerRoutes(): void {
        this.route("GET", "/api/ping", (_req, res) => {
            this.json(res, 200, { pong: true });
        });

        this.route("GET", "/api/status", (_req, res) => {
            this.json(res, 200, {
                ok: true,
                uptime: Math.floor((Date.now() - this.startTime) / 1000),
                startedAt: new Date(this.startTime).toISOString(),
            });
        });
    }

    private route(method: string, path: string, handler: RouteHandler): void {
        if (!this.routes.has(path)) {
            this.routes.set(path, new Map());
        }
        this.routes.get(path)!.set(method, handler);
    }

    private handleRequest(req: IncomingMessage, res: ServerResponse): void {
        const url = new URL(req.url ?? "/", `http://localhost`);
        const pathname = url.pathname;

        // API and attach routes require auth
        if (pathname.startsWith("/api/") || pathname === "/attach") {
            if (!this.authenticate(req)) {
                this.json(res, 401, { error: "Unauthorized" });
                return;
            }
        }

        // Check registered routes
        const methods = this.routes.get(pathname);
        if (methods) {
            const handler = methods.get(req.method ?? "GET");
            if (handler) {
                handler(req, res);
                return;
            }
            // Path exists but wrong method
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method Not Allowed" }));
            return;
        }

        // Static file serving for non-API paths
        if (!pathname.startsWith("/api/") && pathname !== "/attach") {
            this.serveStatic(pathname, res);
            return;
        }

        this.json(res, 404, { error: "Not Found" });
    }

    private handleUpgrade(req: IncomingMessage, socket: import("node:net").Socket, _head: Buffer): void {
        const url = new URL(req.url ?? "/", `http://localhost`);

        if (url.pathname !== "/attach") {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
        }

        if (!this.authenticate(req)) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }

        // WebSocket upgrade skeleton — accept the connection and immediately close
        // Full implementation deferred to P6
        const acceptKey = req.headers["sec-websocket-key"];
        if (!acceptKey) {
            socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            socket.destroy();
            return;
        }

        const hash = createHash("sha1")
            .update(acceptKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
            .digest("base64");

        socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${hash}\r\n` +
            "\r\n"
        );

        logger.info("WebSocket connected at /attach (skeleton)");

        // Send a close frame (opcode 0x8) after a short delay
        setTimeout(() => {
            if (!socket.destroyed) {
                // WebSocket close frame: FIN + opcode 8, payload length 2, status 1000 (normal)
                const closeFrame = Buffer.from([0x88, 0x02, 0x03, 0xe8]);
                socket.write(closeFrame);
                socket.end();
            }
        }, 100);
    }

    private authenticate(req: IncomingMessage): boolean {
        const auth = req.headers["authorization"];
        if (!auth) return false;

        const parts = auth.split(" ");
        if (parts.length !== 2 || parts[0] !== "Bearer") return false;

        return parts[1] === this.config.token;
    }

    private serveStatic(pathname: string, res: ServerResponse): void {
        // Default to index.html for root
        const filePath = pathname === "/"
            ? join(this.publicDir, "index.html")
            : join(this.publicDir, pathname);

        // Prevent directory traversal
        const resolved = resolve(filePath);
        if (!resolved.startsWith(this.publicDir)) {
            this.json(res, 403, { error: "Forbidden" });
            return;
        }

        if (!existsSync(resolved) || !statSync(resolved).isFile()) {
            this.json(res, 404, { error: "Not Found" });
            return;
        }

        const ext = extname(resolved);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

        res.writeHead(200, { "Content-Type": contentType });
        createReadStream(resolved).pipe(res);
    }

    private json(res: ServerResponse, status: number, body: unknown): void {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
    }
}
