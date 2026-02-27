import { ProcessTerminal, TUI, Editor, Spacer, matchesKey, Key } from "@mariozechner/pi-tui";
import { RpcClient } from "./rpc.js";
import { ChatDisplay } from "./chat.js";
import { Footer, type TuiStatus } from "./footer.js";
import { editorTheme, ansi } from "./theme.js";
import { handleSlashCommand } from "./commands.js";

export interface TuiClientOptions {
    host: string;
    port: number;
    token: string;
    watch?: boolean;
}

/**
 * Main TUI client application.
 * Connects to the daemon via WebSocket, renders chat with pi-tui components.
 */
export async function startTuiClient(opts: TuiClientOptions): Promise<void> {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);

    const chat = new ChatDisplay();
    const footer = new Footer();

    // Build layout: chat (scrollable) + optional editor + footer
    tui.addChild(chat);

    let editor: Editor | null = null;
    if (!opts.watch) {
        tui.addChild(new Spacer(1));
        editor = new Editor(tui, editorTheme, { paddingX: 1 });
        tui.addChild(editor);
    }
    tui.addChild(footer);

    const rpc = new RpcClient(opts.host, opts.port, opts.token);

    // ─── Shutdown ─────────────────────────────────────────────
    let exiting = false;
    function shutdown(): void {
        if (exiting) return;
        exiting = true;
        rpc.disconnect();
        tui.stop();
        process.exit(0);
    }

    // ─── RPC event handling ───────────────────────────────────
    rpc.on("event", (event: any) => {
        handleBridgeEvent(event, chat, footer);
        tui.requestRender();
    });

    rpc.on("disconnected", () => {
        footer.setStatus("disconnected");
        chat.addSystemMessage(ansi.yellow("⚠ Disconnected from daemon. Reconnecting..."));
        tui.requestRender();
    });

    rpc.on("connected", () => {
        footer.setStatus("idle");
        tui.requestRender();
    });

    // ─── Editor submit ────────────────────────────────────────
    if (editor) {
        editor.onSubmit = async (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return;

            // Slash commands
            if (trimmed.startsWith("/")) {
                const handled = await handleSlashCommand(trimmed, {
                    rpc, chat, footer, tui, shutdown,
                });
                if (handled) {
                    editor!.setText("");
                    tui.requestRender();
                    return;
                }
            }

            // Regular message
            chat.addUserMessage(trimmed);
            editor!.setText("");
            editor!.addToHistory(trimmed);
            tui.requestRender();

            try {
                await rpc.send("prompt", { message: trimmed, streamingBehavior: "followUp" });
            } catch (err) {
                chat.addSystemMessage(ansi.red(`Failed to send: ${err}`));
                tui.requestRender();
            }
        };
    }

    // ─── Global key handlers ──────────────────────────────────
    tui.addInputListener((data: string) => {
        // Escape during streaming → abort
        if (matchesKey(data, Key.escape)) {
            if (chat.streaming) {
                rpc.send("abort").catch(() => {});
                chat.addSystemMessage(ansi.yellow("⏹️ Aborted."));
                chat.endStream();
                footer.setStatus("idle");
                tui.requestRender();
                return { consume: true };
            }
            return undefined;
        }

        // Ctrl+D → quit
        if (matchesKey(data, Key.ctrl("d"))) {
            shutdown();
            return { consume: true };
        }

        return undefined;
    });

    // ─── Connect ──────────────────────────────────────────────
    footer.setStatus("connecting");
    tui.start();
    if (editor) tui.setFocus(editor);
    tui.requestRender();

    try {
        await rpc.connect();
        footer.setStatus("idle");

        // Fetch initial state
        try {
            const state = await rpc.send("get_state");
            if (state?.model?.name) footer.setModel(state.model.name);
            if (state?.contextTokens != null) footer.setContextTokens(state.contextTokens);
        } catch {}

        if (opts.watch) {
            chat.addSystemMessage(ansi.dim("📺 Watch mode — read-only monitoring"));
        } else {
            chat.addSystemMessage(ansi.dim("Connected. Type a message or /quit to exit."));
        }
    } catch (err) {
        footer.setStatus("disconnected");
        chat.addSystemMessage(ansi.red(`Failed to connect: ${err}`));
    }

    tui.requestRender();
}

// ─── Bridge event handler ─────────────────────────────────────

function handleBridgeEvent(event: any, chat: ChatDisplay, footer: Footer): void {
    switch (event.type) {
        case "agent_start":
            footer.setStatus("streaming");
            break;

        case "message_update": {
            const delta = event.assistantMessageEvent;
            if (!delta) break;

            if (delta.type === "text_delta") {
                footer.setStatus("streaming");
                chat.appendText(delta.delta);
            } else if (delta.type === "thinking_delta") {
                footer.setStatus("thinking");
            }
            break;
        }

        case "tool_execution_start":
            chat.addToolStart(event.toolName ?? "unknown", event.args ?? {});
            break;

        case "tool_execution_end":
            chat.addToolEnd(event.toolName ?? "unknown", event.isError ?? false);
            break;

        case "agent_end":
            chat.endStream();
            footer.setStatus("idle");
            // Refresh context token count
            break;

        case "auto_compaction_start":
            chat.addSystemMessage(ansi.dim("🗜️ Auto-compacting context..."));
            break;

        case "auto_compaction_end":
            chat.addSystemMessage(ansi.dim("✅ Context compacted."));
            break;
    }
}
