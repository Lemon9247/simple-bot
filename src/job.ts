import { readFile } from "node:fs/promises";
import { basename } from "node:path";
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
        if (entries.length === 1) {
            const [key, value] = entries[0];
            if (key === "model" && typeof value === "string") {
                return { type: "model", model: value };
            }
        }
    }

    throw new Error(`Invalid step: ${JSON.stringify(raw)}`);
}

export function parseSteps(raw: unknown): Step[] {
    if (!Array.isArray(raw)) {
        throw new Error("steps must be an array");
    }
    return raw.map(parseStep);
}

export async function parseJobFile(filePath: string): Promise<JobDefinition> {
    const content = await readFile(filePath, "utf-8");
    return parseJobContent(content, filePath);
}

export function parseJobContent(content: string, filePath: string): JobDefinition {
    const { data, content: body } = matter(content);

    const name = basename(filePath, ".md");

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

    const enabled = data.enabled !== false;

    return { name, file: filePath, schedule: data.schedule, steps, notify, enabled, body: body.trim() };
}
