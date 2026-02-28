import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { Config } from "./types.js";

export function loadConfig(path: string): Config {
    const raw = readFileSync(path, "utf-8");
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const resolved = resolveEnvVars(parsed);
    validate(resolved);
    return resolved as Config;
}

function resolveEnvVars(obj: unknown): unknown {
    if (typeof obj === "string" && obj.startsWith("env:")) {
        const name = obj.slice(4);
        const value = process.env[name];
        if (!value) throw new Error(`Environment variable ${name} not set`);
        return value;
    }
    if (Array.isArray(obj)) return obj.map(resolveEnvVars);
    if (obj && typeof obj === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = resolveEnvVars(value);
        }
        return result;
    }
    return obj;
}

function validate(config: unknown): asserts config is Config {
    const c = config as Record<string, any>;
    if (!c.pi?.cwd) throw new Error("config: pi.cwd is required");
    if (!Array.isArray(c.security?.allowed_users) || c.security.allowed_users.length === 0) {
        throw new Error("config: security.allowed_users must have at least one entry");
    }
    if (c.cron) {
        if (!c.cron.dir || typeof c.cron.dir !== "string") {
            throw new Error("config: cron.dir is required and must be a string");
        }
    }
    if (c.server) {
        if (typeof c.server.port !== "number" || c.server.port < 1 || c.server.port > 65535) {
            throw new Error("config: server.port must be a number between 1 and 65535");
        }
        if (!c.server.token || typeof c.server.token !== "string") {
            throw new Error("config: server.token is required");
        }
    }
    validateSessions(c);
    validateRouting(c);
}

function validateSessions(c: Record<string, any>): void {
    if (!c.sessions) return;
    if (typeof c.sessions !== "object" || Array.isArray(c.sessions)) {
        throw new Error("config: sessions must be an object mapping session names to configs");
    }
    for (const [name, session] of Object.entries(c.sessions)) {
        const s = session as Record<string, any>;
        if (!s?.pi?.cwd) {
            throw new Error(`config: sessions.${name}.pi.cwd is required`);
        }
    }
    if (c.defaultSession && typeof c.defaultSession === "string") {
        if (!c.sessions[c.defaultSession]) {
            throw new Error(`config: defaultSession '${c.defaultSession}' not found in sessions`);
        }
    }
}

function validateRouting(c: Record<string, any>): void {
    if (!c.routing) return;
    const routing = c.routing;
    if (typeof routing !== "object" || Array.isArray(routing)) {
        throw new Error("config: routing must be an object with rules and default");
    }
    // Determine available session names
    const sessionNames = c.sessions
        ? new Set(Object.keys(c.sessions))
        : new Set(["main"]);

    if (routing.default && typeof routing.default === "string") {
        if (!sessionNames.has(routing.default)) {
            throw new Error(`config: routing.default '${routing.default}' not found in sessions`);
        }
    }
    if (routing.rules) {
        if (!Array.isArray(routing.rules)) {
            throw new Error("config: routing.rules must be an array");
        }
        for (let i = 0; i < routing.rules.length; i++) {
            const rule = routing.rules[i];
            if (!rule.session || typeof rule.session !== "string") {
                throw new Error(`config: routing.rules[${i}].session is required`);
            }
            if (!sessionNames.has(rule.session)) {
                throw new Error(`config: routing.rules[${i}].session '${rule.session}' not found in sessions`);
            }
            if (!rule.match || typeof rule.match !== "object") {
                throw new Error(`config: routing.rules[${i}].match is required`);
            }
        }
    }
}
