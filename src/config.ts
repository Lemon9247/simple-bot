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
}
