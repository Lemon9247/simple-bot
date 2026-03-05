import { writeFileSync, copyFileSync, renameSync } from "node:fs";
import yaml from "js-yaml";
import type { Bridge } from "./bridge.js";
import type { ConfigWatcher } from "./config-watcher.js";
import type { SessionManager } from "./session-manager.js";
import { redactConfig, serializeConfig, loadConfig } from "./config.js";
import type { Config } from "./types.js";

export interface DaemonRef {
    getUptime(): number;
    getSchedulerStatus(): { total: number; enabled: number; names: string[] };
    getThinkingEnabled(sessionName?: string): boolean;
    setThinkingEnabled(sessionName: string, enabled: boolean): void;
    getContextSize(): number;
    getUsageStats(): {
        today: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost: number; messageCount: number };
        week: { cost: number };
    } | null;
    getConfigWatcher?(): ConfigWatcher | undefined;
    getConfigPath?(): string | undefined;
}

export interface CommandContext {
    args: string;
    bridge: Bridge;
    reply: (text: string) => Promise<void>;
    daemon?: DaemonRef;
    sessionName?: string;
    sessionManager?: SessionManager;
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
    async execute({ args, bridge, reply, sessionName, sessionManager }) {
        const target = args.trim();

        if (!target) {
            // bot!reboot — reboot the resolved session for this channel
            const name = sessionName ?? "main";
            await reply(`🔄 Rebooting session **${name}**...`);
            await bridge.restart();
            await reply(`✅ Session **${name}** rebooted.`);
            return;
        }

        if (!sessionManager) {
            // Fallback: no session manager, just reboot the current bridge
            await reply("🔄 Rebooting pi process...");
            await bridge.restart();
            await reply("✅ Rebooted.");
            return;
        }

        if (target.toLowerCase() === "all") {
            // bot!reboot all — reboot all sessions
            const names = sessionManager.getSessionNames();
            const running = names.filter((n) => sessionManager.getSession(n) !== null);
            if (running.length === 0) {
                await reply("ℹ️ No sessions are currently running.");
                return;
            }
            await reply(`🔄 Rebooting ${running.length} session(s)...`);
            const results: string[] = [];
            for (const name of running) {
                try {
                    await sessionManager.stopSession(name);
                    await sessionManager.getOrStartSession(name);
                    results.push(`✅ **${name}**`);
                } catch (err) {
                    results.push(`❌ **${name}**: ${String(err)}`);
                }
            }
            await reply(results.join("\n"));
            return;
        }

        // bot!reboot <name> — reboot a specific session
        const names = sessionManager.getSessionNames();
        const targetLower = target.toLowerCase();
        const matchedName = names.find((n) => n.toLowerCase() === targetLower);
        if (!matchedName) {
            await reply(`❌ Unknown session: \`${target}\`. Available: ${names.join(", ")}`);
            return;
        }
        await reply(`🔄 Rebooting session **${matchedName}**...`);
        try {
            await sessionManager.stopSession(matchedName);
            await sessionManager.getOrStartSession(matchedName);
            await reply(`✅ Session **${matchedName}** rebooted.`);
        } catch (err) {
            await reply(`❌ Failed to reboot session **${matchedName}**: ${String(err)}`);
        }
    },
};

export const statusCommand: Command = {
    name: "status",
    async execute({ bridge, reply, daemon, sessionName, sessionManager }) {
        const uptimeStr = daemon ? formatUptime(daemon.getUptime()) : "unknown";

        // Get model from get_state RPC, context from usage tracker
        let modelName = "unknown";
        let contextTokens = "?";
        try {
            const state = await bridge.command("get_state");
            if (state?.model?.id) modelName = state.model.id;
            else if (state?.model?.name) modelName = state.model.name;
        } catch {
            // pi not responding — use defaults
        }
        if (daemon) {
            const ctx = daemon.getContextSize();
            if (ctx > 0) contextTokens = `~${Math.round(ctx / 1000)}k`;
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
                const outK = `${Math.round(stats.today.outputTokens / 1000)}k`;
                const cacheR = `${Math.round(stats.today.cacheReadTokens / 1000)}k`;
                usageLine = `📊 today: ${costStr} | ${outK} out | ${cacheR} cached | ${stats.today.messageCount} msgs`;
            }
        }

        const lines = [
            `🪹 nest | uptime ${uptimeStr} | model ${modelName}`,
            `💬 context: ${contextTokens} tokens`,
        ];
        if (usageLine) lines.splice(1, 0, usageLine);
        if (cronLine) lines.splice(usageLine ? 2 : 1, 0, cronLine.trim());

        // Show session info when multiple sessions are configured
        if (sessionManager) {
            const names = sessionManager.getSessionNames();
            if (names.length > 1) {
                const currentSession = sessionName ?? sessionManager.getDefaultSessionName();
                const sessionLines: string[] = [];
                for (const name of names) {
                    const info = sessionManager.getSessionInfo(name);
                    const stateIcon = info?.state === "running" ? "🟢" : info?.state === "starting" ? "🟡" : "⚪";
                    const currentMarker = name === currentSession ? " ← this channel" : "";
                    let sessionDetail = `  ${stateIcon} **${name}**${currentMarker}`;

                    // Get per-session model/context if running
                    if (info?.state === "running" && info.bridge) {
                        try {
                            const sessionState = await info.bridge.command("get_state");
                            const sModel = sessionState?.model?.name ?? "unknown";
                            const sCtx = sessionState?.contextTokens != null
                                ? `~${Math.round(sessionState.contextTokens / 1000)}k`
                                : "?";
                            sessionDetail += ` | ${sModel} | ${sCtx} tokens`;
                        } catch {
                            sessionDetail += " | (not responding)";
                        }
                    }

                    sessionLines.push(sessionDetail);
                }
                lines.push("");
                lines.push(`📡 Sessions (${names.length}):`);
                lines.push(...sessionLines);
            }
        }

        await reply(lines.join("\n"));
    },
};

export const thinkCommand: Command = {
    name: "think",
    async execute({ args, bridge, reply, daemon, sessionName }) {
        if (!daemon) {
            await reply("❌ Daemon reference not available.");
            return;
        }
        const name = sessionName ?? "main";
        const arg = args.toLowerCase().trim();
        if (arg === "on" || arg === "off") {
            const level = arg === "on" ? "medium" : "off";
            try {
                await bridge.command("set_thinking_level", { level });
                daemon.setThinkingEnabled(name, arg === "on");
                const label = arg === "on" ? `**enabled** (${level})` : "**disabled**";
                await reply(`🧠 Extended thinking ${label} for session **${name}**.`);
            } catch (err) {
                await reply(`❌ Failed to set thinking level: ${String(err)}`);
            }
        } else if (["minimal", "low", "medium", "high"].includes(arg)) {
            try {
                await bridge.command("set_thinking_level", { level: arg });
                daemon.setThinkingEnabled(name, true);
                await reply(`🧠 Extended thinking set to **${arg}** for session **${name}**.`);
            } catch (err) {
                await reply(`❌ Failed to set thinking level: ${String(err)}`);
            }
        } else {
            const state = daemon.getThinkingEnabled(name) ? "on" : "off";
            await reply(`🧠 Extended thinking is currently **${state}** for session **${name}**.\nUsage: \`bot!think on|off|minimal|low|medium|high\``);
        }
    },
};

export const configCommand: Command = {
    name: "config",
    async execute({ args, reply, daemon }) {
        const watcher = daemon?.getConfigWatcher?.();
        if (!watcher) {
            await reply("❌ Config watcher not available.");
            return;
        }

        const config = watcher.getCurrentConfig();
        const parts = args.trim().split(/\s+/).filter(Boolean);

        // bot!config — show full config (redacted)
        if (parts.length === 0) {
            const redacted = redactConfig(config);
            const yamlStr = yaml.dump(redacted, { lineWidth: -1, noRefs: true, sortKeys: true });
            await reply(`📋 **Current config:**\n\`\`\`yaml\n${yamlStr}\`\`\``);
            return;
        }

        const section = parts[0];
        const configAny = config as unknown as Record<string, unknown>;

        // bot!config <section> — show specific section
        if (parts.length === 1) {
            const sectionValue = configAny[section];
            if (sectionValue === undefined) {
                const available = Object.keys(configAny).join(", ");
                await reply(`❌ Unknown section: \`${section}\`\nAvailable: ${available}`);
                return;
            }

            // Redact the full config first, then extract the section
            const redacted = redactConfig(config) as Record<string, unknown>;
            const redactedSection = redacted[section];
            const yamlStr = yaml.dump({ [section]: redactedSection }, { lineWidth: -1, noRefs: true });
            await reply(`📋 **${section}:**\n\`\`\`yaml\n${yamlStr}\`\`\``);
            return;
        }

        // bot!config <section> <key> <value> — update a value
        if (parts.length >= 3) {
            const key = parts[1];
            const rawValue = parts.slice(2).join(" ");

            const configPath = daemon?.getConfigPath?.();
            if (!configPath) {
                await reply("❌ Config path not available.");
                return;
            }

            // Parse value: try JSON first (for booleans, numbers, arrays), fall back to string
            let parsedValue: unknown;
            try {
                parsedValue = JSON.parse(rawValue);
            } catch {
                parsedValue = rawValue;
            }

            try {
                // Build the update
                const currentSection = configAny[section];
                const updatedSection = currentSection && typeof currentSection === "object" && !Array.isArray(currentSection)
                    ? { ...(currentSection as Record<string, unknown>), [key]: parsedValue }
                    : { [key]: parsedValue };

                const merged = { ...structuredClone(config), [section]: updatedSection } as Config;
                const yamlStr = serializeConfig(merged);

                // Atomic write: write to temp, validate, rename
                const tmpPath = `${configPath}.tmp`;
                writeFileSync(tmpPath, yamlStr, "utf-8");
                try {
                    loadConfig(tmpPath);
                } catch (validationErr) {
                    // Clean up temp file on validation failure
                    try { renameSync(tmpPath, `${configPath}.failed`); } catch { /* ignore */ }
                    throw new Error(`Config validation failed: ${String(validationErr)}`);
                }
                renameSync(tmpPath, configPath);

                await reply(`✅ Updated \`${section}.${key}\` = \`${rawValue}\``);
            } catch (err) {
                await reply(`❌ Failed to update config: ${String(err)}`);
            }
            return;
        }

        // bot!config <section> <key> — show specific key
        if (parts.length === 2) {
            const key = parts[1];
            const sectionValue = configAny[section];

            if (!sectionValue || typeof sectionValue !== "object") {
                await reply(`❌ Section \`${section}\` not found or is not an object.`);
                return;
            }

            const redacted = redactConfig(config) as Record<string, unknown>;
            const redactedSection = redacted[section] as Record<string, unknown> | undefined;
            const value = redactedSection?.[key];

            if (value === undefined) {
                const available = Object.keys(sectionValue as Record<string, unknown>).join(", ");
                await reply(`❌ Key \`${key}\` not found in \`${section}\`.\nAvailable: ${available}`);
                return;
            }

            const display = typeof value === "object" ? JSON.stringify(value) : String(value);
            await reply(`📋 \`${section}.${key}\` = \`${display}\``);
            return;
        }
    },
};

// Register the new commands
commands.push(rebootCommand, statusCommand, thinkCommand, configCommand);
for (const cmd of [rebootCommand, statusCommand, thinkCommand, configCommand]) {
    commandMap.set(cmd.name, cmd);
}
