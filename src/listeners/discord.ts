import { Client, GatewayIntentBits, Events } from "discord.js";
import type { Listener, IncomingMessage, MessageOrigin } from "../types.js";
import * as logger from "../logger.js";

export class DiscordListener implements Listener {
    readonly name = "discord";
    private client: Client;
    private token: string;
    private messageHandler?: (msg: IncomingMessage) => void;

    constructor(token: string) {
        this.token = token;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
            ],
        });
    }

    async connect(): Promise<void> {
        this.client.on(Events.MessageCreate, (message) => {
            if (!this.messageHandler) return;
            if (message.author.bot) return;

            logger.info("Discord message received", {
                sender: message.author.username,
                channel: message.channelId,
            });

            const msg: IncomingMessage = {
                platform: "discord",
                channel: message.channelId,
                sender: message.author.username,
                text: message.content,
            };

            this.messageHandler(msg);
        });

        this.client.on(Events.Error, (err) => {
            logger.error("Discord client error", { error: String(err) });
        });

        // Wait for ready, not just login
        await new Promise<void>((resolve, reject) => {
            this.client.once(Events.ClientReady, (c) => {
                logger.info("Discord connected", {
                    user: c.user.tag,
                    guilds: c.guilds.cache.map((g) => g.name),
                });
                resolve();
            });
            this.client.login(this.token).catch(reject);
        });
    }

    async disconnect(): Promise<void> {
        await this.client.destroy();
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler;
    }

    async send(origin: MessageOrigin, text: string): Promise<void> {
        const channel = await this.client.channels.fetch(origin.channel);
        if (channel?.isTextBased() && "send" in channel) {
            await (channel as any).send(text);
        }
    }
}
