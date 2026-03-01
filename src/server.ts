import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { writeFileSync } from "node:fs";
import type { ServerConfig, WebhookHandler, ActivityEntry } from "./types.js";
import type { ConfigWatcher } from "./config-watcher.js";
import { redactConfig, mergeConfig, serializeConfig, loadConfig } from "./config.js";
import * as logger from "./logger.js";

export interface SessionStateInfo {
    name: string;
    state: string;
    model?: string;
    contextSize?: number;
    lastActivity?: number;
}

export interface DashboardProvider {
    getUptime(): number;
    getStartedAt(): number;
    getModel(): string;
    getContextSize(): number;
    getListenerCount(): number;
    getCronJobs(): Array<{ name: string; schedule: string; enabled: boolean }>;
    getUsage(): {
        today: { inputTokens: number; outputTokens: number; cost: number; messageCount: number };
        week: { cost: number };
        contextSize: number;
    };
    getActivity(): ActivityEntry[];
    getLogs(): Array<{ timestamp: string; level: string; message: string; [key: string]: unknown }>;
    getSessionNames(): string[];
    getSessionState(name: string): SessionStateInfo | null;
    getUsageBySession(name: string): {
        today: { inputTokens: number; outputTokens: number; cost: number; messageCount: number };
    } | null;
}

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

const WEBHOOK_RATE_WINDOW_MS = 60_000;
const WEBHOOK_RATE_MAX = 10;
const WEBHOOK_GLOBAL_RATE_MAX = 30;
const WEBHOOK_GLOBAL_BUCKET = "__global__";

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export type WsRpcHandler = (message: { type: string; [key: string]: unknown }) => Promise<any>;

export class HttpServer {
    private server: Server;
    private config: ServerConfig;
    private publicDir: string;
    private startTime: number;
    private routes = new Map<string, Map<string, RouteHandler>>();
    private webhookHandler?: WebhookHandler;
    private configWatcher?: ConfigWatcher;
    private configPath?: string;
    private webhookRateLimits = new Map<string, number[]>();
    private dashboard: DashboardProvider | null;
    private wss: WebSocketServer;
    private wsClients = new Set<WebSocket>();
    private wsHandler?: WsRpcHandler;

    constructor(config: ServerConfig, dashboard?: DashboardProvider) {
        this.config = config;
        this.dashboard = dashboard ?? null;
        this.publicDir = config.publicDir
            ? resolve(config.publicDir)
            : resolve("public");
        this.startTime = Date.now();

        this.server = createServer((req, res) => this.handleRequest(req, res));
        this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
        this.wss = new WebSocketServer({ noServer: true });

        this.registerRoutes();
    }

    /** Expose the underlying http.Server for testing */
    get raw(): Server {
        return this.server;
    }

    /** Number of connected WebSocket clients */
    get wsClientCount(): number {
        return this.wsClients.size;
    }

    /** Set the handler for incoming WebSocket RPC commands */
    setWsHandler(handler: WsRpcHandler): void {
        this.wsHandler = handler;
    }

    /** Broadcast a bridge event to all connected WebSocket clients */
    broadcastEvent(event: any): void {
        if (this.wsClients.size === 0) return;
        const data = JSON.stringify(event);
        for (const client of this.wsClients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        }
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
        // Close all WebSocket connections first
        for (const client of this.wsClients) {
            client.close(1001, "Server shutting down");
        }
        this.wsClients.clear();

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

    setWebhookHandler(handler: WebhookHandler): void {
        this.webhookHandler = handler;
    }

    setConfigWatcher(watcher: ConfigWatcher, configPath: string): void {
        this.configWatcher = watcher;
        this.configPath = configPath;
    }

    private registerRoutes(): void {
        this.route("GET", "/api/ping", (_req, res) => {
            this.json(res, 200, { pong: true });
        });

        this.route("GET", "/api/status", (_req, res) => {
            if (this.dashboard) {
                this.json(res, 200, {
                    ok: true,
                    uptime: Math.floor(this.dashboard.getUptime() / 1000),
                    startedAt: new Date(this.dashboard.getStartedAt()).toISOString(),
                    model: this.dashboard.getModel(),
                    contextSize: this.dashboard.getContextSize(),
                    listenerCount: this.dashboard.getListenerCount(),
                    sessions: this.dashboard.getSessionNames(),
                });
            } else {
                this.json(res, 200, {
                    ok: true,
                    uptime: Math.floor((Date.now() - this.startTime) / 1000),
                    startedAt: new Date(this.startTime).toISOString(),
                });
            }
        });

        this.route("GET", "/api/sessions", (_req, res) => {
            if (!this.dashboard) {
                this.json(res, 200, { sessions: [] });
                return;
            }
            const names = this.dashboard.getSessionNames();
            const sessions = names.map((name) => {
                try {
                    const state = this.dashboard!.getSessionState(name);
                    const usage = this.dashboard!.getUsageBySession(name);
                    return {
                        name,
                        state: state?.state ?? "unknown",
                        model: state?.model,
                        contextSize: state?.contextSize,
                        lastActivity: state?.lastActivity,
                        today: usage?.today ?? null,
                    };
                } catch (err) {
                    logger.warn("Failed to get session info", { name, error: String(err) });
                    return { name, state: "error", model: null, contextSize: null, lastActivity: null, today: null };
                }
            });
            this.json(res, 200, { sessions });
        });

        this.route("GET", "/api/cron", (_req, res) => {
            if (!this.dashboard) {
                this.json(res, 200, { jobs: [] });
                return;
            }
            this.json(res, 200, { jobs: this.dashboard.getCronJobs() });
        });

        this.route("GET", "/api/usage", (req, res) => {
            if (!this.dashboard) {
                this.json(res, 200, {
                    today: { inputTokens: 0, outputTokens: 0, cost: 0, messageCount: 0 },
                    week: { cost: 0 },
                    contextSize: 0,
                });
                return;
            }

            // Support ?session=<name> for per-session usage
            const url = new URL(req.url ?? "/", "http://localhost");
            const sessionParam = url.searchParams.get("session");
            if (sessionParam && this.dashboard.getUsageBySession) {
                const sessionUsage = this.dashboard.getUsageBySession(sessionParam);
                if (!sessionUsage) {
                    this.json(res, 404, { error: `Unknown session: ${sessionParam}` });
                    return;
                }
                this.json(res, 200, { today: sessionUsage.today, session: sessionParam });
                return;
            }

            this.json(res, 200, this.dashboard.getUsage());
        });

        this.route("GET", "/api/activity", (_req, res) => {
            if (!this.dashboard) {
                this.json(res, 200, { entries: [] });
                return;
            }
            this.json(res, 200, { entries: this.dashboard.getActivity() });
        });

        this.route("GET", "/api/logs", (_req, res) => {
            if (!this.dashboard) {
                this.json(res, 200, { entries: [] });
                return;
            }
            this.json(res, 200, { entries: this.dashboard.getLogs() });
        });

        // ─── Config API ────────────────────────────────────────────

        this.route("GET", "/api/config", (_req, res) => {
            if (!this.configWatcher) {
                this.json(res, 503, { error: "Config watcher not configured" });
                return;
            }
            const config = this.configWatcher.getCurrentConfig();
            this.json(res, 200, redactConfig(config));
        });

        this.route("POST", "/api/config", async (req, res) => {
            if (!this.configWatcher || !this.configPath) {
                this.json(res, 503, { error: "Config watcher not configured" });
                return;
            }

            let body: Record<string, unknown>;
            try {
                body = await this.readJsonBody(req);
            } catch {
                this.json(res, 400, { error: "Invalid JSON body" });
                return;
            }

            if (!body || typeof body !== "object" || Array.isArray(body)) {
                this.json(res, 400, { error: "Body must be a JSON object" });
                return;
            }

            try {
                const current = this.configWatcher.getCurrentConfig();
                const merged = mergeConfig(current, body);

                // Validate by round-tripping through loadConfig-style validation
                // Write to file first, then let the watcher pick up the change
                const yamlStr = serializeConfig(merged);
                writeFileSync(this.configPath, yamlStr, "utf-8");

                // Validate the written file can be loaded (catches env var issues etc.)
                loadConfig(this.configPath);

                logger.info("Config updated via API", { sections: Object.keys(body) });
                this.json(res, 200, { ok: true, config: redactConfig(merged) });
            } catch (err) {
                logger.error("Config API update failed", { error: String(err) });
                this.json(res, 400, { error: "Invalid config format. Check server logs for details." });
            }
        });

        this.route("POST", "/api/webhook", async (req, res) => {
            if (!this.webhookHandler) {
                this.json(res, 503, { error: "Webhook handler not configured" });
                return;
            }

            let body: any;
            try {
                body = await this.readJsonBody(req);
            } catch {
                this.json(res, 400, { error: "Invalid JSON body" });
                return;
            }

            if (!body || typeof body.message !== "string" || !body.message.trim()) {
                this.json(res, 400, { error: "Missing required field: message" });
                return;
            }

            // Validate session exists BEFORE rate limiting so invalid
            // sessions don't consume rate limit quota
            if (body.session && typeof body.session === "string" && this.dashboard) {
                const validSessions = this.dashboard.getSessionNames();
                if (!validSessions.includes(body.session)) {
                    this.json(res, 400, { error: `Unknown session: ${body.session}` });
                    return;
                }
            }

            // Global rate limit first (prevents bypass via many source values)
            if (this.isWebhookRateLimited(WEBHOOK_GLOBAL_BUCKET, WEBHOOK_GLOBAL_RATE_MAX)) {
                this.json(res, 429, { error: "Rate limit exceeded" });
                return;
            }

            // Per-source rate limit
            const rateBucket = body.source ?? "webhook";
            if (this.isWebhookRateLimited(rateBucket, WEBHOOK_RATE_MAX)) {
                this.json(res, 429, { error: "Rate limit exceeded" });
                return;
            }

            try {
                const result = await this.webhookHandler({
                    message: body.message,
                    notify: body.notify,
                    source: body.source,
                    session: body.session,
                });

                const status = result.queued ? 202 : 200;
                this.json(res, status, result);
            } catch (err) {
                logger.error("Webhook handler error", { error: String(err) });
                this.json(res, 500, { error: "Internal server error" });
            }
        });
    }

    private route(method: string, path: string, handler: RouteHandler): void {
        if (!this.routes.has(path)) {
            this.routes.set(path, new Map());
        }
        this.routes.get(path)!.set(method, handler);
    }

    private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
                try {
                    const result = handler(req, res);
                    if (result instanceof Promise) {
                        await result;
                    }
                } catch (err) {
                    logger.error("Route handler error", { path: pathname, error: String(err) });
                    if (!res.headersSent) {
                        this.json(res, 500, { error: "Internal server error" });
                    }
                }
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

    private handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
        const url = new URL(req.url ?? "/", `http://localhost`);

        if (url.pathname !== "/attach") {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
        }

        // Auth: bearer token via Authorization header or ?token= query param
        const queryToken = url.searchParams.get("token");
        if (!this.authenticate(req) && queryToken !== this.config.token) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }

        this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wsClients.add(ws);
            logger.info("WebSocket client connected at /attach");

            // Keep-alive: ping every 30s so proxies/NAT don't drop idle connections.
            // The ws package handles pong responses automatically.
            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.ping();
            }, 30_000);

            ws.on("message", async (rawData) => {
                let msg: any;
                try {
                    msg = JSON.parse(rawData.toString());
                } catch {
                    this.wsSend(ws, { type: "error", error: "Invalid JSON" });
                    return;
                }

                if (!msg.type) {
                    this.wsSend(ws, { id: msg.id, type: "response", success: false, error: "Missing type" });
                    return;
                }

                if (!this.wsHandler) {
                    this.wsSend(ws, { id: msg.id, type: "response", success: false, error: "No handler configured" });
                    return;
                }

                try {
                    const { id, type, ...params } = msg;
                    const result = await this.wsHandler({ type, ...params });
                    this.wsSend(ws, { id, type: "response", success: true, data: result });
                } catch (err) {
                    this.wsSend(ws, { id: msg.id, type: "response", success: false, error: String(err) });
                }
            });

            ws.on("close", () => {
                clearInterval(pingInterval);
                this.wsClients.delete(ws);
                logger.info("WebSocket client disconnected");
            });

            ws.on("error", (err) => {
                clearInterval(pingInterval);
                logger.error("WebSocket client error", { error: String(err) });
                this.wsClients.delete(ws);
            });
        });
    }

    /** Send JSON to a WebSocket client if still open */
    private wsSend(ws: WebSocket, data: any): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
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

    private readJsonBody(req: IncomingMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            let data = "";
            req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
            req.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error("Invalid JSON"));
                }
            });
            req.on("error", reject);
        });
    }

    private isWebhookRateLimited(bucket: string, max: number): boolean {
        const now = Date.now();
        const timestamps = this.webhookRateLimits.get(bucket) ?? [];
        const recent = timestamps.filter((t) => now - t < WEBHOOK_RATE_WINDOW_MS);

        if (recent.length >= max) {
            this.webhookRateLimits.set(bucket, recent);
            return true;
        }

        recent.push(now);
        this.webhookRateLimits.set(bucket, recent);
        return false;
    }

    private json(res: ServerResponse, status: number, body: unknown): void {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
    }
}
