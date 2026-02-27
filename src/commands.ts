import type { Bridge } from "./bridge.js";

export interface DaemonRef {
    getUptime(): number;
    getSchedulerStatus(): { total: number; enabled: number; names: string[] };
    getThinkingEnabled(): boolean;
    setThinkingEnabled(enabled: boolean): void;
    getUsageStats(): {
        today: { inputTokens: number; outputTokens: number; cost: number; messageCount: number };
        week: { cost: number };
    } | null;
}

export interface CommandContext {
    args: string;
    bridge: Bridge;
    reply: (text: string) => Promise<void>;
    daemon?: DaemonRef;
}

export interface Command {
    name: string;
    interrupts?: boolean;
    execute(ctx: CommandContext): Promise<void>;
}

export const commands: Command[] = [
    {
        name: "abort",
        interrupts: true,
        async execute({ bridge, reply }) {
            await bridge.command("abort");
            await reply("⏹️ Aborted.");
        },
    },
    {
        name: "compress",
        async execute({ args, bridge, reply }) {
            await reply("🗜️ Compressing context...");
            const result = await bridge.command("compact", args ? { customInstructions: args } : {});
            const before = result?.tokensBefore ?? "?";
            await reply(`✅ Compressed. Tokens before: ${before}`);
        },
    },
    {
        name: "new",
        interrupts: true,
        async execute({ bridge, reply }) {
            await bridge.command("new_session");
            await reply("🆕 Started a new session.");
        },
    },
    {
        name: "reload",
        interrupts: true,
        async execute({ bridge, reply }) {
            await reply("🔄 Reloading extensions...");
            await bridge.command("prompt", { message: "/reload-runtime" });
            await reply("✅ Extensions reloaded.");
        },
    },
    {
        name: "model",
        async execute({ args, bridge, reply }) {
            if (!args) {
                const [modelsResult, stateResult] = await Promise.all([
                    bridge.command("get_available_models"),
                    bridge.command("get_state"),
                ]);
                const models: any[] = modelsResult?.models ?? [];
                const current = stateResult?.model;
                if (models.length === 0) {
                    await reply("No models available.");
                } else {
                    const currentLine = current
                        ? `**Current model:** ${current.name} (\`${current.provider}/${current.id}\`)`
                        : "**Current model:** unknown";
                    const list = models
                        .map((m: any) => `• \`${m.provider}/${m.id}\` — ${m.name}`)
                        .join("\n");
                    await reply(`${currentLine}\n\n**Available models:**\n${list}\n\nUse \`bot!model <name>\` to switch.`);
                }
            } else {
                const result = await bridge.command("get_available_models");
                const models: any[] = result?.models ?? [];
                const query = args.toLowerCase();
                const match = models.find(
                    (m: any) =>
                        m.id.toLowerCase().includes(query) ||
                        m.name.toLowerCase().includes(query) ||
                        `${m.provider}/${m.id}`.toLowerCase().includes(query),
                );
                if (!match) {
                    await reply(`❌ No model matching \`${args}\`. Use \`bot!model\` to list available models.`);
                } else {
                    await bridge.command("set_model", { provider: match.provider, modelId: match.id });
                    await reply(`✅ Switched to **${match.name}** (\`${match.provider}/${match.id}\`).`);
                }
            }
        },
    },
];

function formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (parts.length === 0) parts.push(`${minutes}m`);
    return parts.join(" ");
}

export const commandMap = new Map<string, Command>(
    commands.map((c) => [c.name, c]),
);

// --- Additional commands that need daemon access ---

export const rebootCommand: Command = {
    name: "reboot",
    interrupts: true,
    async execute({ bridge, reply }) {
        await reply("🔄 Rebooting pi process...");
        await bridge.restart();
        await reply("✅ Rebooted.");
    },
};

export const statusCommand: Command = {
    name: "status",
    async execute({ bridge, reply, daemon }) {
        const uptimeStr = daemon ? formatUptime(daemon.getUptime()) : "unknown";

        // Get model and context info via get_state RPC (P3-T4)
        let modelName = "unknown";
        let contextTokens = "?";
        try {
            const state = await bridge.command("get_state");
            if (state?.model?.name) modelName = state.model.name;
            if (state?.contextTokens != null) contextTokens = `~${Math.round(state.contextTokens / 1000)}k`;
        } catch {
            // pi not responding — use defaults
        }

        let cronLine = "";
        if (daemon) {
            const cron = daemon.getSchedulerStatus();
            if (cron.total > 0) {
                cronLine = `\n⏰ cron: ${cron.total} jobs (${cron.enabled} enabled)`;
            }
        }

        let usageLine = "";
        if (daemon) {
            const stats = daemon.getUsageStats();
            if (stats && stats.today.messageCount > 0) {
                const costStr = `$${stats.today.cost.toFixed(2)}`;
                const inK = `${Math.round(stats.today.inputTokens / 1000)}k`;
                const outK = `${Math.round(stats.today.outputTokens / 1000)}k`;
                usageLine = `📊 today: ${costStr} | ${inK} in / ${outK} out | ${stats.today.messageCount} msgs`;
            }
        }

        const lines = [
            `🟢 simple-bot | uptime ${uptimeStr} | model ${modelName}`,
            `💬 context: ${contextTokens} tokens`,
        ];
        if (usageLine) lines.splice(1, 0, usageLine);
        if (cronLine) lines.splice(usageLine ? 2 : 1, 0, cronLine.trim());

        await reply(lines.join("\n"));
    },
};

export const thinkCommand: Command = {
    name: "think",
    async execute({ args, bridge, reply, daemon }) {
        if (!daemon) {
            await reply("❌ Daemon reference not available.");
            return;
        }
        const arg = args.toLowerCase().trim();
        if (arg === "on") {
            try {
                await bridge.command("set_model_config", { thinking: true });
                daemon.setThinkingEnabled(true);
                await reply("🧠 Extended thinking **enabled**.");
            } catch (err) {
                await reply(`❌ Failed to enable thinking: ${String(err)}`);
            }
        } else if (arg === "off") {
            try {
                await bridge.command("set_model_config", { thinking: false });
                daemon.setThinkingEnabled(false);
                await reply("🧠 Extended thinking **disabled**.");
            } catch (err) {
                await reply(`❌ Failed to disable thinking: ${String(err)}`);
            }
        } else {
            const state = daemon.getThinkingEnabled() ? "on" : "off";
            await reply(`🧠 Extended thinking is currently **${state}**.\nUsage: \`bot!think on|off\``);
        }
    },
};

// Register the new commands
commands.push(rebootCommand, statusCommand, thinkCommand);
for (const cmd of [rebootCommand, statusCommand, thinkCommand]) {
    commandMap.set(cmd.name, cmd);
}
