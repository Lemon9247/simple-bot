/**
 * Attach tool extension for Wren's Discord bridge.
 *
 * Registers an `attach` tool that the agent can call to send files
 * back to the Discord channel. The tool validates the file exists and
 * returns metadata; the actual Discord attachment is handled by the
 * service daemon which intercepts the tool_execution_end event.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";

const MIME_MAP: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".zip": "application/zip",
};

function guessMimeType(filename: string): string {
    const ext = extname(filename).toLowerCase();
    return MIME_MAP[ext] ?? "application/octet-stream";
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "attach",
        label: "Attach File",
        description:
            "Attach a file to the current Discord message. The file will be sent " +
            "as a Discord attachment alongside your text response. Call this tool " +
            "with the absolute path to a file you want to send. You can call it " +
            "multiple times to attach multiple files.",
        parameters: Type.Object({
            path: Type.String({ description: "Absolute path to the file to attach" }),
            filename: Type.Optional(
                Type.String({ description: "Override the filename shown in Discord (defaults to the original filename)" }),
            ),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const filePath = params.path.replace(/^@/, ""); // strip leading @ some models add

            try {
                const st = await stat(filePath);
                if (!st.isFile()) {
                    return {
                        content: [{ type: "text", text: `Error: ${filePath} is not a file` }],
                        details: { error: "not_a_file" },
                    };
                }

                const name = params.filename ?? basename(filePath);
                const mimeType = guessMimeType(name);
                const sizeKB = Math.round(st.size / 1024);

                return {
                    content: [{
                        type: "text",
                        text: `Queued attachment: ${name} (${mimeType}, ${sizeKB}KB). ` +
                            `The file will be sent to Discord with your response.`,
                    }],
                    details: {
                        path: filePath,
                        filename: name,
                        mimeType,
                        size: st.size,
                    },
                };
            } catch (err: any) {
                if (err.code === "ENOENT") {
                    return {
                        content: [{ type: "text", text: `Error: file not found: ${filePath}` }],
                        details: { error: "not_found" },
                    };
                }
                return {
                    content: [{ type: "text", text: `Error accessing file: ${String(err)}` }],
                    details: { error: String(err) },
                };
            }
        },
    });
}
