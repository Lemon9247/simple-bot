import { MatrixClient, SimpleFsStorageProvider } from "matrix-bot-sdk";
import type { Listener, IncomingMessage, MessageOrigin, OutgoingFile } from "../types.js";

export class MatrixListener implements Listener {
    readonly name = "matrix";
    private client: MatrixClient;
    private userId: string;
    private messageHandler?: (msg: IncomingMessage) => void;

    constructor(homeserver: string, user: string, token: string, storagePath = "matrix-bot.json") {
        this.userId = user;
        const storage = new SimpleFsStorageProvider(storagePath);
        this.client = new MatrixClient(homeserver, token, storage);
    }

    async connect(): Promise<void> {
        this.client.on("room.message", async (roomId: string, event: any) => {
            if (!this.messageHandler) return;
            
            // Only process m.room.message events with m.text msgtype
            if (event.type !== "m.room.message") return;
            if (event.content?.msgtype !== "m.text") return;
            
            // Ignore messages from the bot itself
            if (event.sender === this.userId) return;
            
            const msg: IncomingMessage = {
                platform: "matrix",
                channel: roomId,
                sender: event.sender,
                text: event.content.body,
            };
            
            this.messageHandler(msg);
        });

        await this.client.start();
    }

    async disconnect(): Promise<void> {
        await this.client.stop();
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler;
    }

    async sendTyping(origin: MessageOrigin): Promise<void> {
        await this.client.setTyping(origin.channel, true, 15_000);
    }

    async send(origin: MessageOrigin, text: string, _files?: OutgoingFile[]): Promise<void> {
        // TODO: Matrix file upload support (future work)
        await this.client.sendText(origin.channel, text);
    }
}
