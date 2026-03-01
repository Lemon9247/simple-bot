import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigWatcher } from "../src/config-watcher.js";
import { loadConfig, redactConfig, diffConfig, mergeConfig, serializeConfig } from "../src/config.js";
import type { Config, ConfigDiff } from "../src/types.js";

const tmpDir = join(import.meta.dirname, ".tmp-config-watcher");
const tmpFile = (name: string) => join(tmpDir, name);

function writeMinimalConfig(path: string, overrides: Record<string, unknown> = {}): void {
    const base = {
        pi: { cwd: "/home/test" },
        security: { allowed_users: ["@willow:athena"] },
        ...overrides,
    };
    writeFileSync(path, serializeConfig(base as Config), "utf-8");
}

function makeConfig(overrides: Record<string, unknown> = {}): Config {
    return {
        pi: { cwd: "/home/test" },
        security: { allowed_users: ["@willow:athena"] },
        ...overrides,
    } as Config;
}

beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

// ─── redactConfig ──────────────────────────────────────────

describe("redactConfig", () => {
    it("redacts discord token", () => {
        const config = makeConfig({ discord: { token: "my-secret-token" } });
        const redacted = redactConfig(config);
        expect(redacted.discord?.token).toBe("***");
    });

    it("redacts matrix token", () => {
        const config = makeConfig({
            matrix: { homeserver: "https://athena.local", user: "@hades:athena", token: "secret" },
        });
        const redacted = redactConfig(config);
        expect(redacted.matrix?.token).toBe("***");
        expect(redacted.matrix?.homeserver).toBe("https://athena.local");
    });

    it("redacts server token", () => {
        const config = makeConfig({
            server: { port: 8080, token: "auth-token" },
        });
        const redacted = redactConfig(config);
        expect(redacted.server?.token).toBe("***");
        expect(redacted.server?.port).toBe(8080);
    });

    it("leaves non-sensitive fields untouched", () => {
        const config = makeConfig();
        const redacted = redactConfig(config);
        expect(redacted.pi.cwd).toBe("/home/test");
        expect(redacted.security.allowed_users).toEqual(["@willow:athena"]);
    });

    it("handles config with no sensitive sections", () => {
        const config = makeConfig();
        const redacted = redactConfig(config);
        expect(redacted.discord).toBeUndefined();
        expect(redacted.matrix).toBeUndefined();
        expect(redacted.server).toBeUndefined();
    });
});

// ─── diffConfig ────────────────────────────────────────────

describe("diffConfig", () => {
    it("detects no changes for identical configs", () => {
        const config = makeConfig();
        const diff = diffConfig(config, structuredClone(config));
        expect(diff.changes).toHaveLength(0);
        expect(diff.hasRestartRequired).toBe(false);
        expect(diff.hasHotReloadable).toBe(false);
    });

    it("detects hot-reloadable change", () => {
        const old = makeConfig({ security: { allowed_users: ["@willow:athena"] } });
        const next = makeConfig({ security: { allowed_users: ["@willow:athena", "@friend:athena"] } });
        const diff = diffConfig(old, next);

        expect(diff.changes).toHaveLength(1);
        expect(diff.changes[0].section).toBe("security");
        expect(diff.changes[0].key).toBe("allowed_users");
        expect(diff.changes[0].hotReloadable).toBe(true);
        expect(diff.hasHotReloadable).toBe(true);
        expect(diff.hasRestartRequired).toBe(false);
    });

    it("detects restart-required change (discord.token)", () => {
        const old = makeConfig({ discord: { token: "old-token" } });
        const next = makeConfig({ discord: { token: "new-token" } });
        const diff = diffConfig(old, next);

        expect(diff.changes).toHaveLength(1);
        expect(diff.changes[0].section).toBe("discord");
        expect(diff.changes[0].key).toBe("token");
        expect(diff.changes[0].hotReloadable).toBe(false);
        expect(diff.hasRestartRequired).toBe(true);
    });

    it("detects restart-required change (server.port)", () => {
        const old = makeConfig({ server: { port: 8080, token: "tok" } });
        const next = makeConfig({ server: { port: 9090, token: "tok" } });
        const diff = diffConfig(old, next);

        const portChange = diff.changes.find((c) => c.key === "port");
        expect(portChange).toBeDefined();
        expect(portChange!.hotReloadable).toBe(false);
    });

    it("detects mixed hot-reloadable and restart-required changes", () => {
        const old = makeConfig({
            discord: { token: "old" },
            security: { allowed_users: ["@willow:athena"] },
        });
        const next = makeConfig({
            discord: { token: "new" },
            security: { allowed_users: ["@willow:athena", "@friend:athena"] },
        });
        const diff = diffConfig(old, next);

        expect(diff.changes.length).toBeGreaterThanOrEqual(2);
        expect(diff.hasRestartRequired).toBe(true);
        expect(diff.hasHotReloadable).toBe(true);
    });

    it("detects added sections", () => {
        const old = makeConfig();
        const next = makeConfig({ cron: { dir: "/home/test/cron.d" } });
        const diff = diffConfig(old, next);

        expect(diff.changes.length).toBeGreaterThan(0);
        const cronChange = diff.changes.find((c) => c.section === "cron");
        expect(cronChange).toBeDefined();
        expect(cronChange!.hotReloadable).toBe(true);
    });

    it("detects removed sections", () => {
        const old = makeConfig({ cron: { dir: "/home/test/cron.d" } });
        const next = makeConfig();
        const diff = diffConfig(old, next);

        const cronChange = diff.changes.find((c) => c.section === "cron");
        expect(cronChange).toBeDefined();
    });

    it("classifies matrix credential changes as restart-required", () => {
        const old = makeConfig({
            matrix: { homeserver: "https://old.local", user: "@hades:old", token: "tok" },
        });
        const next = makeConfig({
            matrix: { homeserver: "https://new.local", user: "@hades:new", token: "newtok" },
        });
        const diff = diffConfig(old, next);

        for (const change of diff.changes) {
            expect(change.hotReloadable).toBe(false);
        }
    });
});

// ─── mergeConfig ───────────────────────────────────────────

describe("mergeConfig", () => {
    it("merges a partial update into existing config", () => {
        const base = makeConfig({ server: { port: 8080, token: "tok" } });
        const merged = mergeConfig(base, { server: { port: 9090 } });
        expect((merged.server as any).port).toBe(9090);
        expect((merged.server as any).token).toBe("tok");
    });

    it("adds new sections", () => {
        const base = makeConfig();
        const merged = mergeConfig(base, { cron: { dir: "/tmp/cron" } });
        expect(merged.cron?.dir).toBe("/tmp/cron");
    });

    it("replaces array values entirely", () => {
        const base = makeConfig({ security: { allowed_users: ["@a:x"] } });
        const merged = mergeConfig(base, { security: { allowed_users: ["@b:y"] } });
        expect(merged.security.allowed_users).toEqual(["@b:y"]);
    });

    it("does not mutate the original config", () => {
        const base = makeConfig();
        const original = structuredClone(base);
        mergeConfig(base, { pi: { cwd: "/new/path" } });
        expect(base.pi.cwd).toBe(original.pi.cwd);
    });
});

// ─── serializeConfig ───────────────────────────────────────

describe("serializeConfig", () => {
    it("round-trips through YAML", () => {
        const config = makeConfig({
            server: { port: 8080, token: "tok" },
            cron: { dir: "/tmp/cron" },
        });

        const yamlStr = serializeConfig(config);
        const path = tmpFile("roundtrip.yaml");
        writeFileSync(path, yamlStr, "utf-8");
        const loaded = loadConfig(path);

        expect(loaded.pi.cwd).toBe(config.pi.cwd);
        expect(loaded.server?.port).toBe(8080);
        expect(loaded.cron?.dir).toBe("/tmp/cron");
    });
});

// ─── ConfigWatcher ─────────────────────────────────────────

describe("ConfigWatcher", () => {
    it("returns current config", () => {
        const config = makeConfig();
        const watcher = new ConfigWatcher(tmpFile("config.yaml"), config);
        expect(watcher.getCurrentConfig()).toBe(config);
    });

    it("allows setting current config", () => {
        const config = makeConfig();
        const watcher = new ConfigWatcher(tmpFile("config.yaml"), config);
        const newConfig = makeConfig({ pi: { cwd: "/new" } });
        watcher.setCurrentConfig(newConfig);
        expect(watcher.getCurrentConfig()).toBe(newConfig);
    });

    it("emits reload event on manual reload", () => {
        const configPath = tmpFile("config.yaml");
        const config = makeConfig();
        writeMinimalConfig(configPath, { pi: { cwd: "/updated" } });

        const watcher = new ConfigWatcher(configPath, config);

        const events: Array<{ config: Config; diff: ConfigDiff }> = [];
        watcher.on("reload", (config, diff) => {
            events.push({ config, diff });
        });

        watcher.reloadFromDisk();

        expect(events).toHaveLength(1);
        expect(events[0].config.pi.cwd).toBe("/updated");
        expect(events[0].diff.changes.length).toBeGreaterThan(0);
    });

    it("emits error on invalid config file", () => {
        const configPath = tmpFile("bad.yaml");
        writeFileSync(configPath, "this is: [not valid: yaml: config", "utf-8");

        const config = makeConfig();
        const watcher = new ConfigWatcher(configPath, config);

        const errors: Error[] = [];
        watcher.on("error", (err) => errors.push(err));

        watcher.reloadFromDisk();

        expect(errors).toHaveLength(1);
        // Old config should be preserved
        expect(watcher.getCurrentConfig()).toBe(config);
    });

    it("does not emit reload when config is unchanged", () => {
        const configPath = tmpFile("config.yaml");
        const config = makeConfig();
        writeMinimalConfig(configPath);

        const watcher = new ConfigWatcher(configPath, config);

        const events: any[] = [];
        watcher.on("reload", (c, d) => events.push({ c, d }));

        watcher.reloadFromDisk();
        expect(events).toHaveLength(0);
    });

    it("start and stop work without errors", () => {
        const configPath = tmpFile("config.yaml");
        writeMinimalConfig(configPath);
        const config = makeConfig();

        const watcher = new ConfigWatcher(configPath, config);
        watcher.start();
        watcher.stop();
    });

    it("updates current config after successful reload", () => {
        const configPath = tmpFile("config.yaml");
        writeMinimalConfig(configPath, { pi: { cwd: "/new-path" } });

        const config = makeConfig();
        const watcher = new ConfigWatcher(configPath, config);
        watcher.reloadFromDisk();

        expect(watcher.getCurrentConfig().pi.cwd).toBe("/new-path");
    });

    it("file watcher detects changes", async () => {
        const configPath = tmpFile("config.yaml");
        writeMinimalConfig(configPath);
        const config = makeConfig();

        const watcher = new ConfigWatcher(configPath, config);

        const reloadPromise = new Promise<ConfigDiff>((resolve) => {
            watcher.on("reload", (_config, diff) => resolve(diff));
        });

        watcher.start();

        // Wait a tick then modify the file
        await new Promise((r) => setTimeout(r, 50));
        writeMinimalConfig(configPath, { pi: { cwd: "/changed" } });

        const diff = await Promise.race([
            reloadPromise,
            new Promise<null>((r) => setTimeout(() => r(null), 2000)),
        ]);

        watcher.stop();

        expect(diff).not.toBeNull();
        expect(diff!.changes.length).toBeGreaterThan(0);
        expect(watcher.getCurrentConfig().pi.cwd).toBe("/changed");
    });
});
