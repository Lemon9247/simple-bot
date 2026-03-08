/**
 * UI tools extension for nest.
 *
 * Provides the `attach` tool for sending files and images to users
 * via the block protocol. Works across all platforms.
 *
 * Requires NEST_URL and SERVER_TOKEN environment variables.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const NEST_URL = process.env.NEST_URL ?? "http://127.0.0.1:8484";
const NEST_TOKEN = process.env.SERVER_TOKEN ?? "";

const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};

const MIME: Record<string, string> = {
    ...IMAGE_MIME,
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".mp4": "video/mp4", ".webm": "video/webm",
    ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
    ".json": "application/json", ".csv": "text/csv", ".zip": "application/zip",
    ".tar": "application/x-tar", ".gz": "application/gzip",
};

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "attach",
        label: "Attach File",
        description:
            "Send a file to the user. Images display inline, other files are sent " +
            "as downloadable attachments. Works across all platforms (Discord, CLI, etc.).",
        parameters: Type.Object({
            path: Type.String({ description: "Absolute path to the file" }),
            filename: Type.Optional(Type.String({ description: "Override the display filename" })),
            caption: Type.Optional(Type.String({ description: "Caption or description" })),
        }),
        async execute(_id, params) {
            const data = await readFile(params.path);
            const ext = extname(params.path).toLowerCase();
            const mimeType = MIME[ext] ?? "application/octet-stream";
            const filename = params.filename ?? basename(params.path);
            const isImage = ext in IMAGE_MIME;
            const kind = isImage ? "image" : "file";
            const sizeKB = Math.round(data.length / 1024);

            const fallback = isImage
                ? `[Image: ${filename}${params.caption ? ` — ${params.caption}` : ""}]`
                : `[File: ${filename} (${sizeKB}KB)${params.caption ? ` — ${params.caption}` : ""}]`;

            const form = new FormData();
            form.set("session", "default");
            form.set("id", `${kind}-${Date.now()}`);
            form.set("kind", kind);
            form.set("filename", filename);
            form.set("mimeType", mimeType);
            form.set("fallback", fallback);
            form.set("file", new Blob([data]), filename);

            const res = await fetch(`${NEST_URL}/api/block/upload`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${NEST_TOKEN}` },
                body: form,
            });
            const result = await res.json() as { ok: boolean; error?: string };

            const action = isImage ? "Displayed" : "Sent";
            return {
                content: [{ type: "text" as const, text: result.ok ? `${action} ${filename}` : `Failed: ${result.error}` }],
            };
        },
    });
}
