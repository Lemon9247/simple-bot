import { Client, Intents, MessageAttachment } from "discord.js";
import type { Listener, IncomingMessage, MessageOrigin, Attachment, OutgoingFile } from "../types.js";
import * as logger from "../logger.js";

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB

async function downloadAttachment(url: string, maxSize: number): Promise<Buffer | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxSize) return null;
        return buf;
    } catch (err) {
        logger.error("Failed to download attachment", { url, error: String(err) });
        return null;
    }
}

export class DiscordListener implements Listener {
    readonly name = "discord";
    private client: Client;
    private token: string;
    private messageHandler?: (msg: IncomingMessage) => void;
    private emojiCache = new Map<string, { id: string; animated: boolean }>();

    constructor(token: string) {
        this.token = token;
        this.client = new Client({
            intents: [
                Intents.FLAGS.GUILDS,
                Intents.FLAGS.GUILD_MESSAGES,
                Intents.FLAGS.MESSAGE_CONTENT,
                Intents.FLAGS.DIRECT_MESSAGES,
                Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
            ],
        });
    }

    async connect(): Promise<void> {
        this.client.on("messageCreate", async (message) => {
            if (!this.messageHandler) return;
            if (message.author.bot) return;

            logger.info("Discord message received", {
                sender: message.author.username,
                channel: message.channelId,
                attachments: message.attachments.size,
            });

            // Download and classify attachments
            const attachments: Attachment[] = [];
            for (const [, att] of message.attachments) {
                if (att.size > MAX_ATTACHMENT_SIZE) {
                    logger.warn("Skipping oversized attachment", {
                        name: att.name,
                        size: att.size,
                    });
                    continue;
                }

                const contentType = att.contentType ?? "application/octet-stream";
                const data = await downloadAttachment(att.url, MAX_ATTACHMENT_SIZE);
                if (!data) continue;

                const attachment: Attachment = {
                    url: att.url,
                    filename: att.name ?? "attachment",
                    contentType,
                    size: data.length,
                    data,
                };

                if (contentType.startsWith("image/")) {
                    attachment.base64 = data.toString("base64");
                }

                attachments.push(attachment);
            }

            const msg: IncomingMessage = {
                platform: "discord",
                channel: message.channelId,
                sender: message.author.username,
                text: message.content,
                attachments: attachments.length > 0 ? attachments : undefined,
            };

            this.messageHandler(msg);
        });

        this.client.on("emojiUpdate", () => {
            this.buildEmojiCache();
        });

        this.client.on("error", (err) => {
            logger.error("Discord client error", { error: String(err) });
        });

        // Wait for ready, not just login
        await new Promise<void>((resolve, reject) => {
            this.client.once("ready", (c) => {
                logger.info("Discord connected", {
                    user: c.user.tag,
                    guilds: c.guilds.cache.map((g: any) => g.name),
                });
                this.buildEmojiCache();
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

    async send(origin: MessageOrigin, text: string, files?: OutgoingFile[]): Promise<void> {
        const channel = await this.client.channels.fetch(origin.channel);
        if (!channel?.isText() || !("send" in channel)) return;

        const resolvedText = this.resolveEmotes(text);

        const discordFiles = files?.map(
            (f) => new MessageAttachment(f.data, f.filename),
        );

        if (discordFiles && discordFiles.length > 0) {
            await (channel as any).send({ content: resolvedText || undefined, files: discordFiles });
        } else {
            await (channel as any).send(resolvedText);
        }
    }

    /** Replace :emote_name: with Discord emoji format using guild cache */
    private resolveEmotes(text: string): string {
        if (this.emojiCache.size === 0) return text;
        return text.replace(/:([a-zA-Z0-9_]+):/g, (match, name: string) => {
            const emoji = this.emojiCache.get(name);
            if (!emoji) return match; // not a guild emoji, leave as-is
            return emoji.animated ? `<a:${name}:${emoji.id}>` : `<:${name}:${emoji.id}>`;
        });
    }

    private buildEmojiCache(): void {
        this.emojiCache.clear();
        for (const [, guild] of this.client.guilds.cache) {
            for (const [, emoji] of guild.emojis.cache) {
                if (emoji.name) {
                    this.emojiCache.set(emoji.name, {
                        id: emoji.id,
                        animated: emoji.animated ?? false,
                    });
                }
            }
        }
        logger.info("Emoji cache built", { count: this.emojiCache.size });
    }
}
