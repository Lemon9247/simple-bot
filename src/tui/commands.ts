import type { TUI, SelectItem } from "@mariozechner/pi-tui";
import { SelectList } from "@mariozechner/pi-tui";
import type { RpcClient } from "./rpc.js";
import type { ChatDisplay } from "./chat.js";
import type { Footer } from "./footer.js";
import { selectListTheme, ansi } from "./theme.js";

interface CommandContext {
    rpc: RpcClient;
    chat: ChatDisplay;
    footer: Footer;
    tui: TUI;
    shutdown: () => void;
}

interface TuiCommand {
    name: string;
    description: string;
    execute: (ctx: CommandContext, args: string) => Promise<void>;
}

const commands: TuiCommand[] = [
    {
        name: "quit",
        description: "Disconnect and exit",
        async execute({ shutdown }) {
            shutdown();
        },
    },
    {
        name: "new",
        description: "Start a new session",
        async execute({ rpc, chat }) {
            await rpc.send("new_session");
            chat.addSystemMessage("🆕 Started a new session.");
        },
    },
    {
        name: "compact",
        description: "Compact context",
        async execute({ rpc, chat, footer }) {
            chat.addSystemMessage("🗜️ Compacting context...");
            const result = await rpc.send("compact");
            const before = result?.tokensBefore ?? "?";
            chat.addSystemMessage(`✅ Compacted. Tokens before: ${before}`);
            // Refresh state after compaction
            try {
                const state = await rpc.send("get_state");
                if (state?.contextTokens != null) footer.setContextTokens(state.contextTokens);
            } catch {}
        },
    },
    {
        name: "model",
        description: "Switch model",
        async execute({ rpc, chat, footer, tui }) {
            try {
                const [modelsResult, stateResult] = await Promise.all([
                    rpc.send("get_available_models"),
                    rpc.send("get_state"),
                ]);
                const models: any[] = modelsResult?.models ?? [];
                const currentId = stateResult?.model?.id;

                if (models.length === 0) {
                    chat.addSystemMessage("No models available.");
                    return;
                }

                const items: SelectItem[] = models.map((m: any) => ({
                    value: JSON.stringify({ provider: m.provider, id: m.id }),
                    label: m.name ?? m.id,
                    description: `${m.provider}/${m.id}${m.id === currentId ? " (current)" : ""}`,
                }));

                const list = new SelectList(items, Math.min(items.length, 12), selectListTheme);
                const overlay = tui.showOverlay(list, {
                    width: "60%",
                    maxHeight: "50%",
                    anchor: "center",
                });

                list.onSelect = async (item) => {
                    overlay.hide();
                    tui.hideOverlay();
                    try {
                        const { provider, id } = JSON.parse(item.value);
                        await rpc.send("set_model", { provider, modelId: id });
                        footer.setModel(item.label);
                        chat.addSystemMessage(`✅ Switched to ${item.label}`);
                    } catch (err) {
                        chat.addSystemMessage(`❌ Failed to switch model: ${err}`);
                    }
                    tui.requestRender();
                };

                list.onCancel = () => {
                    overlay.hide();
                    tui.hideOverlay();
                    tui.requestRender();
                };

                tui.setFocus(list);
                tui.requestRender();
            } catch (err) {
                chat.addSystemMessage(`❌ Failed to load models: ${err}`);
            }
        },
    },
    {
        name: "session",
        description: "Show current session name",
        async execute({ rpc, chat }) {
            const name = rpc.getSession() ?? "(default)";
            chat.addSystemMessage(`📎 Session: ${name}`);
        },
    },
    {
        name: "stats",
        description: "Show session stats",
        async execute({ rpc, chat }) {
            try {
                const stats = await rpc.send("get_session_stats");
                const lines = ["📊 **Session Stats**"];
                if (stats?.inputTokens != null) {
                    lines.push(`  Input tokens: ${stats.inputTokens.toLocaleString()}`);
                }
                if (stats?.outputTokens != null) {
                    lines.push(`  Output tokens: ${stats.outputTokens.toLocaleString()}`);
                }
                if (stats?.cost != null) {
                    lines.push(`  Cost: $${stats.cost.toFixed(4)}`);
                }
                if (stats?.turns != null) {
                    lines.push(`  Turns: ${stats.turns}`);
                }
                chat.addSystemMessage(lines.join("\n"));
            } catch (err) {
                chat.addSystemMessage(`❌ Failed to get stats: ${err}`);
            }
        },
    },
];

const commandMap = new Map(commands.map((c) => [c.name, c]));

/**
 * Try to handle a slash command. Returns true if it was a recognized command.
 */
export async function handleSlashCommand(
    input: string,
    ctx: CommandContext,
): Promise<boolean> {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return false;

    const [rawName, ...argParts] = trimmed.slice(1).split(/\s+/);
    const name = rawName.toLowerCase();
    const cmd = commandMap.get(name);

    if (!cmd) {
        ctx.chat.addSystemMessage(
            ansi.dim(`Unknown command: /${name}. Available: ${commands.map((c) => "/" + c.name).join(", ")}`),
        );
        return true;
    }

    try {
        await cmd.execute(ctx, argParts.join(" "));
    } catch (err) {
        ctx.chat.addSystemMessage(`❌ Command failed: ${err}`);
    }
    ctx.tui.requestRender();
    return true;
}
