import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const tmpDir = join(import.meta.dirname, ".tmp");
const tmpFile = (name: string) => join(tmpDir, name);

beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("loadConfig", () => {
    it("parses a valid YAML config", () => {
        writeFileSync(
            tmpFile("config.yaml"),
            `
pi:
    cwd: /home/test
security:
    allowed_users:
        - "@willow:athena"
`
        );

        const config = loadConfig(tmpFile("config.yaml"));
        expect(config.pi.cwd).toBe("/home/test");
        expect(config.security.allowed_users).toEqual(["@willow:athena"]);
    });

    it("resolves env: references", () => {
        process.env.TEST_TOKEN = "secret123";
        writeFileSync(
            tmpFile("config.yaml"),
            `
pi:
    cwd: /home/test
matrix:
    homeserver: https://athena.local
    user: "@hades:athena"
    token: "env:TEST_TOKEN"
security:
    allowed_users:
        - "@willow:athena"
`
        );

        const config = loadConfig(tmpFile("config.yaml"));
        expect(config.matrix?.token).toBe("secret123");
        delete process.env.TEST_TOKEN;
    });

    it("throws on missing env var", () => {
        writeFileSync(
            tmpFile("config.yaml"),
            `
pi:
    cwd: /home/test
matrix:
    token: "env:NONEXISTENT_VAR"
security:
    allowed_users:
        - "@willow:athena"
`
        );

        expect(() => loadConfig(tmpFile("config.yaml"))).toThrow("NONEXISTENT_VAR");
    });

    it("throws when pi.cwd is missing", () => {
        writeFileSync(
            tmpFile("config.yaml"),
            `
security:
    allowed_users:
        - "@willow:athena"
`
        );

        expect(() => loadConfig(tmpFile("config.yaml"))).toThrow("pi.cwd is required");
    });

    it("throws when allowed_users is empty", () => {
        writeFileSync(
            tmpFile("config.yaml"),
            `
pi:
    cwd: /home/test
security:
    allowed_users: []
`
        );

        expect(() => loadConfig(tmpFile("config.yaml"))).toThrow("allowed_users");
    });

    it("parses optional sections", () => {
        writeFileSync(
            tmpFile("config.yaml"),
            `
pi:
    cwd: /home/test
    command: /usr/local/bin/pi
    args: ["--mode", "rpc"]
security:
    allowed_users:
        - "@willow:athena"
cron:
    dir: /home/test/cron.d
    default_notify: "#hades:athena"
`
        );

        const config = loadConfig(tmpFile("config.yaml"));
        expect(config.pi.command).toBe("/usr/local/bin/pi");
        expect(config.cron?.dir).toBe("/home/test/cron.d");
        expect(config.cron?.default_notify).toBe("#hades:athena");
    });

    it("validates cron.dir is required when cron is present", () => {
        writeFileSync(
            tmpFile("config.yaml"),
            `
pi:
    cwd: /home/test
security:
    allowed_users:
        - "@willow:athena"
cron:
    default_notify: "#hades:athena"
`
        );

        expect(() => loadConfig(tmpFile("config.yaml"))).toThrow("cron.dir is required");
    });
});
