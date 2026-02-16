import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { log, info, warn, error, type LogLevel } from "../src/logger.js";

describe("logger", () => {
    let stdoutData: string[] = [];
    let stderrData: string[] = [];
    let originalStdoutWrite: typeof process.stdout.write;
    let originalStderrWrite: typeof process.stderr.write;

    beforeEach(() => {
        stdoutData = [];
        stderrData = [];

        // Capture stdout
        originalStdoutWrite = process.stdout.write;
        process.stdout.write = ((chunk: any) => {
            stdoutData.push(chunk.toString());
            return true;
        }) as typeof process.stdout.write;

        // Capture stderr
        originalStderrWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            stderrData.push(chunk.toString());
            return true;
        }) as typeof process.stderr.write;
    });

    afterEach(() => {
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
    });

    it("outputs valid JSON with level, message, and timestamp", () => {
        log("info", "test message");

        expect(stdoutData).toHaveLength(1);
        const entry = JSON.parse(stdoutData[0]);

        expect(entry).toHaveProperty("timestamp");
        expect(entry).toHaveProperty("level", "info");
        expect(entry).toHaveProperty("message", "test message");
        expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });

    it("includes extra data fields", () => {
        log("info", "test", { user: "alice", count: 42 });

        const entry = JSON.parse(stdoutData[0]);
        expect(entry.user).toBe("alice");
        expect(entry.count).toBe(42);
    });

    it("info logs to stdout", () => {
        info("info message");

        expect(stdoutData).toHaveLength(1);
        expect(stderrData).toHaveLength(0);

        const entry = JSON.parse(stdoutData[0]);
        expect(entry.level).toBe("info");
        expect(entry.message).toBe("info message");
    });

    it("warn logs to stdout", () => {
        warn("warning message");

        expect(stdoutData).toHaveLength(1);
        expect(stderrData).toHaveLength(0);

        const entry = JSON.parse(stdoutData[0]);
        expect(entry.level).toBe("warn");
        expect(entry.message).toBe("warning message");
    });

    it("error logs to stderr", () => {
        error("error message");

        expect(stdoutData).toHaveLength(0);
        expect(stderrData).toHaveLength(1);

        const entry = JSON.parse(stderrData[0]);
        expect(entry.level).toBe("error");
        expect(entry.message).toBe("error message");
    });

    it("error includes data fields", () => {
        error("failed", { code: 500, reason: "timeout" });

        const entry = JSON.parse(stderrData[0]);
        expect(entry.level).toBe("error");
        expect(entry.message).toBe("failed");
        expect(entry.code).toBe(500);
        expect(entry.reason).toBe("timeout");
    });
});
