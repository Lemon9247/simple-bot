import type { Bridge } from "./bridge.js";

export interface CommandContext {
    args: string;
    bridge: Bridge;
    reply: (text: string) => Promise<void>;
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

export const commandMap = new Map<string, Command>(
    commands.map((c) => [c.name, c]),
);
