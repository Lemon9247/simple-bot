import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import matter from "gray-matter";
import cron from "node-cron";
import type { JobDefinition, Step } from "./types.js";

export class JobParseError extends Error {
    constructor(file: string, reason: string) {
        super(`Invalid job file ${file}: ${reason}`);
        this.name = "JobParseError";
    }
}

export function parseStep(raw: unknown): Step {
    if (typeof raw === "string") {
        switch (raw) {
            case "new-session":
                return { type: "new-session" };
            case "compact":
                return { type: "compact" };
            case "prompt":
                return { type: "prompt" };
            case "reload":
                return { type: "reload" };
            default:
                throw new Error(`Unknown step: ${raw}`);
        }
    }

    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const entries = Object.entries(raw);
        const keys = Object.keys(raw);

        if (keys.includes("model")) {
            const value = (raw as Record<string, unknown>).model;
            if (typeof value !== "string") {
                throw new Error(`Step 'model' value must be a string, got ${typeof value}`);
            }
            if (keys.length > 1) {
                throw new Error(`Step 'model' has unexpected extra keys: ${keys.filter((k) => k !== "model").join(", ")}`);
            }
            return { type: "model", model: value };
        }
    }

    throw new Error(`Invalid step: ${JSON.stringify(raw)}`);
}

export function parseSteps(raw: unknown): Step[] {
    if (!Array.isArray(raw)) {
        throw new Error("steps must be an array");
    }
    return raw.map((step, i) => {
        try {
            return parseStep(step);
        } catch (err) {
            throw new Error(`step[${i}]: ${(err as Error).message}`);
        }
    });
}

export async function parseJobFile(filePath: string, baseDir?: string): Promise<JobDefinition> {
    const content = await readFile(filePath, "utf-8");
    return parseJobContent(content, filePath, baseDir);
}

export function parseJobContent(content: string, filePath: string, baseDir?: string): JobDefinition {
    const { data, content: body } = matter(content);

    const name = baseDir
        ? relative(baseDir, filePath).replace(/\.md$/, "").replace(/\\/g, "/")
        : basename(filePath, ".md");

    if (!data.schedule || typeof data.schedule !== "string") {
        throw new JobParseError(filePath, "schedule is required and must be a string");
    }

    if (!cron.validate(data.schedule)) {
        throw new JobParseError(filePath, `invalid cron expression: ${data.schedule}`);
    }

    if (!data.steps) {
        throw new JobParseError(filePath, "steps is required");
    }

    let steps: Step[];
    try {
        steps = parseSteps(data.steps);
    } catch (err) {
        throw new JobParseError(filePath, `invalid steps: ${(err as Error).message}`);
    }

    // Validate: prompt step requires a body
    const hasPromptStep = steps.some((s) => s.type === "prompt");
    if (hasPromptStep && !body.trim()) {
        throw new JobParseError(filePath, "steps include 'prompt' but file has no body content");
    }

    let notify: string | "none" | null = null;
    if (data.notify !== undefined) {
        if (data.notify === "none" || data.notify === false) {
            notify = "none";
        } else if (typeof data.notify === "string") {
            notify = data.notify;
        } else {
            throw new JobParseError(filePath, "notify must be a string, 'none', or omitted");
        }
    }

    if (data.enabled !== undefined && typeof data.enabled !== "boolean") {
        throw new JobParseError(filePath, "enabled must be a boolean");
    }
    const enabled = data.enabled !== false;

    let gracePeriodMs: number | undefined;
    if (data.gracePeriodMs !== undefined) {
        if (typeof data.gracePeriodMs !== "number" || data.gracePeriodMs < 0) {
            throw new JobParseError(filePath, "gracePeriodMs must be a non-negative number");
        }
        gracePeriodMs = data.gracePeriodMs;
    }

    let session: string | undefined;
    if (data.session !== undefined) {
        if (typeof data.session !== "string" || !data.session.trim()) {
            throw new JobParseError(filePath, "session must be a non-empty string");
        }
        const sessionName = data.session.trim();
        if (!/^[a-z0-9_-]+$/i.test(sessionName)) {
            throw new JobParseError(filePath, "session name must contain only letters, numbers, hyphens, and underscores");
        }
        session = sessionName;
    }

    return { name, file: filePath, schedule: data.schedule, steps, notify, enabled, gracePeriodMs, session, body: body.trim() };
}
