import { Client, GatewayIntentBits, Events } from "discord.js";
import type { Listener, IncomingMessage, MessageOrigin } from "../types.js";

export class DiscordListener implements Listener {
    readonly name = "discord";
    private client: Client;
    private token: string;
    private allowedUsers: string[];
    private messageHandler?: (msg: IncomingMessage) => void;

    constructor(token: string, allowedUsers: string[] = []) {
        this.token = token;
        this.allowedUsers = allowedUsers;
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

            // Filter by allowed users if configured
            if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(message.author.tag)) {
                return;
            }

            const msg: IncomingMessage = {
                platform: "discord",
                channel: message.channelId,
                sender: message.author.tag,
                text: message.content,
            };

            this.messageHandler(msg);
        });

        await this.client.login(this.token);
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
