/**
 * Nest command extension — exposes nest bot commands as pi tools.
 *
 * The agent can call nest commands directly (reboot, model, compress, etc.)
 * without relying on a user to type `bot!command` in chat.
 *
 * Requires NEST_URL and SERVER_TOKEN environment variables.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const NEST_URL = process.env.NEST_URL ?? "http://127.0.0.1:8484";
const NEST_TOKEN = process.env.SERVER_TOKEN ?? "";

async function runCommand(command: string, args?: string, session?: string): Promise<{ ok: boolean; replies: string[]; error?: string }> {
    const res = await fetch(`${NEST_URL}/api/command`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${NEST_TOKEN}`,
        },
        body: JSON.stringify({ command, args, session }),
    });
    return res.json() as any;
}

async function listCommands(): Promise<string[]> {
    const res = await fetch(`${NEST_URL}/api/commands`, {
        headers: { "Authorization": `Bearer ${NEST_TOKEN}` },
    });
    const data = await res.json() as any;
    return data.commands ?? [];
}

export default function (pi: ExtensionAPI) {
    // ─── Generic command tool ────────────────────────────

    pi.registerTool({
        name: "nest_command",
        label: "Nest Command",
        description:
            "Execute a nest bot command. Use this to manage sessions, switch models, " +
            "reboot after writing plugins, compress context, etc. " +
            "Call with no arguments to list available commands.",
        parameters: Type.Object({
            command: Type.Optional(Type.String({ description: "Command name (e.g. 'reboot', 'model', 'compress'). Omit to list available commands." })),
            args: Type.Optional(Type.String({ description: "Arguments to pass to the command" })),
            session: Type.Optional(Type.String({ description: "Target session (defaults to current)" })),
        }),
        async execute(_id, params) {
            if (!params.command) {
                const cmds = await listCommands();
                return {
                    content: [{ type: "text" as const, text: `Available nest commands: ${cmds.join(", ")}` }],
                };
            }

            const result = await runCommand(params.command, params.args, params.session);
            const text = result.ok
                ? result.replies.join("\n") || `Command '${params.command}' completed.`
                : `Error: ${result.error}`;

            return { content: [{ type: "text" as const, text }] };
        },
    });

    // ─── Convenience tools for common operations ─────────

    pi.registerTool({
        name: "nest_reboot",
        label: "Reboot Session",
        description: "Reboot the nest session. Use after writing or modifying plugins or extensions.",
        parameters: Type.Object({
            session: Type.Optional(Type.String({ description: "Target session (defaults to current)" })),
        }),
        async execute(_id, params) {
            const result = await runCommand("reboot", params.session ?? "", params.session);
            return { content: [{ type: "text" as const, text: result.replies.join("\n") || "Rebooted." }] };
        },
    });

    pi.registerTool({
        name: "nest_model",
        label: "Switch Model",
        description: "Switch the AI model for the current session. Call with no model to list available models.",
        parameters: Type.Object({
            model: Type.Optional(Type.String({ description: "Model name or ID to switch to. Omit to list available." })),
        }),
        async execute(_id, params) {
            const result = await runCommand("model", params.model ?? "");
            return { content: [{ type: "text" as const, text: result.replies.join("\n") }] };
        },
    });

    pi.registerTool({
        name: "nest_compress",
        label: "Compress Context",
        description: "Compress the conversation context to free up token space.",
        parameters: Type.Object({
            instructions: Type.Optional(Type.String({ description: "Custom compression instructions" })),
        }),
        async execute(_id, params) {
            const result = await runCommand("compress", params.instructions ?? "");
            return { content: [{ type: "text" as const, text: result.replies.join("\n") }] };
        },
    });
}
