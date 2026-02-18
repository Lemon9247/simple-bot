import { describe, it, expect } from "vitest";
import { parseJobContent, parseStep, parseSteps, JobParseError } from "../src/job.js";

describe("parseStep", () => {
    it("parses string steps", () => {
        expect(parseStep("new-session")).toEqual({ type: "new-session" });
        expect(parseStep("compact")).toEqual({ type: "compact" });
        expect(parseStep("prompt")).toEqual({ type: "prompt" });
        expect(parseStep("reload")).toEqual({ type: "reload" });
    });

    it("parses model step", () => {
        expect(parseStep({ model: "claude-haiku-4-5" })).toEqual({
            type: "model",
            model: "claude-haiku-4-5",
        });
    });

    it("rejects unknown string step", () => {
        expect(() => parseStep("unknown")).toThrow("Unknown step: unknown");
    });

    it("rejects invalid object step", () => {
        expect(() => parseStep({ foo: "bar" })).toThrow("Invalid step");
    });

    it("rejects non-string model value", () => {
        expect(() => parseStep({ model: 123 })).toThrow("Invalid step");
    });

    it("rejects array", () => {
        expect(() => parseStep([1, 2])).toThrow("Invalid step");
    });
});

describe("parseSteps", () => {
    it("parses a mixed steps array", () => {
        const raw = ["new-session", { model: "haiku" }, "prompt", "compact"];
        expect(parseSteps(raw)).toEqual([
            { type: "new-session" },
            { type: "model", model: "haiku" },
            { type: "prompt" },
            { type: "compact" },
        ]);
    });

    it("rejects non-array", () => {
        expect(() => parseSteps("prompt")).toThrow("steps must be an array");
    });
});

describe("parseJobContent", () => {
    it("parses a complete job file", () => {
        const content = `---
schedule: "0 7 * * *"
notify: "123456"
steps:
  - new-session
  - model: claude-haiku-4-5
  - prompt
  - compact
---

Do the morning checklist.`;

        const job = parseJobContent(content, "/home/wren/cron.d/morning.md");
        expect(job.name).toBe("morning");
        expect(job.schedule).toBe("0 7 * * *");
        expect(job.notify).toBe("123456");
        expect(job.enabled).toBe(true);
        expect(job.body).toBe("Do the morning checklist.");
        expect(job.steps).toEqual([
            { type: "new-session" },
            { type: "model", model: "claude-haiku-4-5" },
            { type: "prompt" },
            { type: "compact" },
        ]);
    });

    it("parses job with no notify (inherits default)", () => {
        const content = `---
schedule: "0 */6 * * *"
steps:
  - compact
---`;

        const job = parseJobContent(content, "/cron.d/compact.md");
        expect(job.notify).toBeNull();
    });

    it("parses notify: none", () => {
        const content = `---
schedule: "0 */6 * * *"
notify: none
steps:
  - compact
---`;

        const job = parseJobContent(content, "/cron.d/compact.md");
        expect(job.notify).toBe("none");
    });

    it("parses notify: false as none", () => {
        const content = `---
schedule: "0 */6 * * *"
notify: false
steps:
  - compact
---`;

        const job = parseJobContent(content, "/cron.d/compact.md");
        expect(job.notify).toBe("none");
    });

    it("parses enabled: false", () => {
        const content = `---
schedule: "0 7 * * *"
enabled: false
steps:
  - compact
---`;

        const job = parseJobContent(content, "/cron.d/disabled.md");
        expect(job.enabled).toBe(false);
    });

    it("defaults enabled to true", () => {
        const content = `---
schedule: "0 7 * * *"
steps:
  - compact
---`;

        const job = parseJobContent(content, "/cron.d/test.md");
        expect(job.enabled).toBe(true);
    });

    it("rejects missing schedule", () => {
        const content = `---
steps:
  - compact
---`;
        expect(() => parseJobContent(content, "test.md")).toThrow(JobParseError);
        expect(() => parseJobContent(content, "test.md")).toThrow("schedule is required");
    });

    it("rejects invalid cron expression", () => {
        const content = `---
schedule: "not a cron"
steps:
  - compact
---`;
        expect(() => parseJobContent(content, "test.md")).toThrow("invalid cron expression");
    });

    it("rejects missing steps", () => {
        const content = `---
schedule: "0 7 * * *"
---`;
        expect(() => parseJobContent(content, "test.md")).toThrow("steps is required");
    });

    it("rejects prompt step without body", () => {
        const content = `---
schedule: "0 7 * * *"
steps:
  - prompt
---`;
        expect(() => parseJobContent(content, "test.md")).toThrow("no body content");
    });

    it("allows prompt step with body", () => {
        const content = `---
schedule: "0 7 * * *"
steps:
  - prompt
---

Hello world`;
        const job = parseJobContent(content, "/cron.d/test.md");
        expect(job.body).toBe("Hello world");
    });

    it("allows no-prompt job without body", () => {
        const content = `---
schedule: "0 */6 * * *"
steps:
  - compact
---`;
        const job = parseJobContent(content, "/cron.d/compact.md");
        expect(job.body).toBe("");
    });

    it("derives job name from filename", () => {
        const content = `---
schedule: "0 7 * * *"
steps:
  - compact
---`;
        expect(parseJobContent(content, "/some/path/my-job.md").name).toBe("my-job");
    });
});
