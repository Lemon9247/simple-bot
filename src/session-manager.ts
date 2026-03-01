import { EventEmitter } from "node:events";
import { Bridge } from "./bridge.js";
import type { BridgeOptions } from "./bridge.js";
import type { Config, SessionConfig, RoutingRule, SessionState } from "./types.js";
import * as logger from "./logger.js";

export interface SessionInfo {
    name: string;
    state: SessionState;
    bridge: Bridge | null;
    config: SessionConfig;
    idleTimer: ReturnType<typeof setTimeout> | null;
    lastActivity: number;
}

/**
 * Manages named Bridge instances. Routes (platform, channel) pairs
 * to sessions via configurable routing rules. Supports lazy spawn
 * and idle timeout.
 */
export class SessionManager extends EventEmitter {
    private sessions = new Map<string, SessionInfo>();
    private routingRules: RoutingRule[] = [];
    private defaultSession: string;
    private bridgeFactory: (opts: BridgeOptions) => Bridge;

    constructor(config: Config, bridgeFactory?: (opts: BridgeOptions) => Bridge) {
        super();
        this.bridgeFactory = bridgeFactory ?? ((opts) => new Bridge(opts));
        this.defaultSession = config.defaultSession ?? "main";

        // Build routing rules
        if (config.routing) {
            this.routingRules = config.routing.rules ?? [];
            this.defaultSession = config.routing.default ?? this.defaultSession;
        }

        // Build session configs
        if (config.sessions) {
            for (const [name, sessionConfig] of Object.entries(config.sessions)) {
                this.sessions.set(name, {
                    name,
                    state: "idle",
                    bridge: null,
                    config: sessionConfig,
                    idleTimer: null,
                    lastActivity: 0,
                });
            }
        } else {
            // T4: Backward compat — synthesize a single "main" session from config.pi
            this.sessions.set("main", {
                name: "main",
                state: "idle",
                bridge: null,
                config: { pi: config.pi },
                idleTimer: null,
                lastActivity: 0,
            });
            this.defaultSession = "main";
        }
    }

    /**
     * Resolve (platform, channel) → session name via routing rules.
     * First matching rule wins; falls back to default.
     */
    resolveSession(platform: string, channel: string): string {
        for (const rule of this.routingRules) {
            const m = rule.match;
            if (m.platform && m.platform !== platform) continue;
            if (m.channel && m.channel !== channel) continue;
            return rule.session;
        }
        return this.defaultSession;
    }

    /**
     * Get a running session's bridge, starting it lazily if needed.
     * Returns the Bridge for the resolved session.
     */
    async getOrStartSession(name: string): Promise<Bridge> {
        const info = this.sessions.get(name);
        if (!info) {
            throw new Error(`Unknown session: ${name}`);
        }

        if (info.state === "running" && info.bridge) {
            this.resetIdleTimer(info);
            return info.bridge;
        }

        if (info.state === "starting") {
            // Wait for the bridge to become available (with timeout)
            return new Promise((resolve, reject) => {
                const startTime = Date.now();
                const TIMEOUT_MS = 30_000;
                const check = () => {
                    if (Date.now() - startTime > TIMEOUT_MS) {
                        reject(new Error(`Session ${name} start timeout after ${TIMEOUT_MS}ms`));
                        return;
                    }
                    if (info.state === "running" && info.bridge) {
                        this.resetIdleTimer(info);
                        resolve(info.bridge);
                    } else if (info.state === "idle" || info.state === "stopping") {
                        reject(new Error(`Session ${name} failed to start`));
                    } else {
                        setTimeout(check, 50);
                    }
                };
                setTimeout(check, 50);
            });
        }

        return this.startSession(name);
    }

    /**
     * Start a session's Bridge process.
     */
    async startSession(name: string): Promise<Bridge> {
        const info = this.sessions.get(name);
        if (!info) {
            throw new Error(`Unknown session: ${name}`);
        }

        if (info.state === "running" && info.bridge) {
            return info.bridge;
        }

        info.state = "starting";
        logger.info("Starting session", { session: name });

        let bridge: Bridge;
        try {
            bridge = this.bridgeFactory({
                cwd: info.config.pi.cwd,
                command: info.config.pi.command,
                args: info.config.pi.args,
            });

            // Set state to running BEFORE start() so exit handler
            // can't overwrite with stale state (race condition fix)
            info.bridge = bridge;
            info.state = "running";
            info.lastActivity = Date.now();

            bridge.start();
        } catch (err) {
            info.state = "idle";
            info.bridge = null;
            logger.error("Failed to start session bridge", { session: name, error: String(err) });
            throw err;
        }

        // Forward bridge events with session context
        bridge.on("exit", (code: number, signal?: string) => {
            logger.info("Session bridge exited", { session: name, code, signal });
            info.state = "idle";
            info.bridge = null;
            this.clearIdleTimer(info);
            this.emit("session:exit", name, code, signal);
        });

        bridge.on("event", (event: any) => {
            this.emit("session:event", name, event);
        });

        this.resetIdleTimer(info);
        logger.info("Session started", { session: name });
        return bridge;
    }

    /**
     * Stop a session's Bridge process.
     */
    async stopSession(name: string): Promise<void> {
        const info = this.sessions.get(name);
        if (!info) {
            throw new Error(`Unknown session: ${name}`);
        }

        if (!info.bridge || info.state === "idle" || info.state === "stopping") {
            return;
        }

        info.state = "stopping";
        this.clearIdleTimer(info);
        logger.info("Stopping session", { session: name });

        try {
            // Remove exit listener before intentional stop so it doesn't
            // re-emit session:exit with the wrong semantics
            info.bridge.removeAllListeners("exit");
            info.bridge.removeAllListeners("event");
            await info.bridge.stop();
        } catch (err) {
            logger.error("Error stopping session bridge", { session: name, error: String(err) });
        } finally {
            info.bridge = null;
            info.state = "idle";
            logger.info("Session stopped", { session: name });
        }
    }

    /**
     * Stop all sessions.
     */
    async stopAll(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const [name] of this.sessions) {
            promises.push(this.stopSession(name));
        }
        const results = await Promise.allSettled(promises);
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failures.length > 0) {
            logger.error("Some sessions failed to stop", {
                count: failures.length,
                errors: failures.map((f) => String(f.reason)),
            });
        }
    }

    /**
     * Get a session's Bridge if it exists and is running.
     * Does not start the session — use getOrStartSession for that.
     */
    getSession(name: string): Bridge | null {
        const info = this.sessions.get(name);
        if (!info || info.state !== "running") return null;
        return info.bridge;
    }

    /**
     * Get info about a specific session.
     */
    getSessionInfo(name: string): SessionInfo | undefined {
        return this.sessions.get(name);
    }

    /**
     * Get all session names.
     */
    getSessionNames(): string[] {
        return Array.from(this.sessions.keys());
    }

    /**
     * Get the default session name.
     */
    getDefaultSessionName(): string {
        return this.defaultSession;
    }

    /**
     * Get all sessions with their state.
     */
    getAllSessions(): Map<string, SessionInfo> {
        return new Map(this.sessions);
    }

    /**
     * Record activity on a session (resets idle timer).
     */
    recordActivity(name: string): void {
        const info = this.sessions.get(name);
        if (info) {
            info.lastActivity = Date.now();
            this.resetIdleTimer(info);
        }
    }

    // ─── Idle timeout management ──────────────────────────────

    private resetIdleTimer(info: SessionInfo): void {
        this.clearIdleTimer(info);

        const timeoutMinutes = info.config.idleTimeoutMinutes;
        if (!timeoutMinutes || timeoutMinutes <= 0) return;

        info.idleTimer = setTimeout(() => {
            if (info.state === "running" && info.bridge && !info.bridge.busy) {
                logger.info("Session idle timeout, stopping", {
                    session: info.name,
                    idleMinutes: timeoutMinutes,
                });
                this.stopSession(info.name).catch((err) => {
                    logger.error("Failed to stop idle session", {
                        session: info.name,
                        error: String(err),
                    });
                });
            } else if (info.bridge?.busy) {
                // Bridge is busy, reset the timer
                this.resetIdleTimer(info);
            }
        }, timeoutMinutes * 60_000);
    }

    private clearIdleTimer(info: SessionInfo): void {
        if (info.idleTimer) {
            clearTimeout(info.idleTimer);
            info.idleTimer = null;
        }
    }
}
