import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock discord.js before importing
const mockOn = vi.fn();
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockFetch = vi.fn();

vi.mock("discord.js", () => ({
    Client: class MockClient {
        constructor() {
            (this as any).on = mockOn;
            (this as any).login = mockLogin;
            (this as any).destroy = mockDestroy;
            (this as any).channels = { fetch: mockFetch };
        }
    },
    GatewayIntentBits: {
        Guilds: 1,
        GuildMessages: 2,
        MessageContent: 4,
        DirectMessages: 8,
    },
    Events: {
        MessageCreate: "messageCreate",
    },
}));

import { DiscordListener } from "../src/listeners/discord.js";
import type { IncomingMessage } from "../src/types.js";

describe("DiscordListener", () => {
    let listener: DiscordListener;

    beforeEach(() => {
        vi.clearAllMocks();
        listener = new DiscordListener("fake-token", ["willow#1234"]);
    });

    it("has name 'discord'", () => {
        expect(listener.name).toBe("discord");
    });

    it("logs in on connect", async () => {
        await listener.connect();
        expect(mockLogin).toHaveBeenCalledWith("fake-token");
    });

    it("destroys client on disconnect", async () => {
        await listener.disconnect();
        expect(mockDestroy).toHaveBeenCalled();
    });

    it("registers messageCreate handler on connect", async () => {
        await listener.connect();
        expect(mockOn).toHaveBeenCalledWith("messageCreate", expect.any(Function));
    });

    it("invokes onMessage handler with correct fields", async () => {
        const received: IncomingMessage[] = [];
        listener.onMessage((msg) => received.push(msg));
        await listener.connect();

        const handler = mockOn.mock.calls.find((c) => c[0] === "messageCreate")?.[1];
        handler({
            author: { bot: false, tag: "willow#1234" },
            channelId: "12345",
            content: "hello hades",
        });

        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({
            platform: "discord",
            channel: "12345",
            sender: "willow#1234",
            text: "hello hades",
        });
    });

    it("ignores bot messages", async () => {
        const received: IncomingMessage[] = [];
        listener.onMessage((msg) => received.push(msg));
        await listener.connect();

        const handler = mockOn.mock.calls.find((c) => c[0] === "messageCreate")?.[1];
        handler({
            author: { bot: true, tag: "other-bot#0000" },
            channelId: "12345",
            content: "beep boop",
        });

        expect(received).toHaveLength(0);
    });

    it("filters by allowed users", async () => {
        const received: IncomingMessage[] = [];
        listener.onMessage((msg) => received.push(msg));
        await listener.connect();

        const handler = mockOn.mock.calls.find((c) => c[0] === "messageCreate")?.[1];
        handler({
            author: { bot: false, tag: "stranger#9999" },
            channelId: "12345",
            content: "hey",
        });

        expect(received).toHaveLength(0);
    });

    it("allows all users when allowedUsers is empty", async () => {
        const openListener = new DiscordListener("fake-token");
        const received: IncomingMessage[] = [];
        openListener.onMessage((msg) => received.push(msg));
        await openListener.connect();

        const handler = mockOn.mock.calls.find((c) => c[0] === "messageCreate")?.[1];
        handler({
            author: { bot: false, tag: "anyone#5555" },
            channelId: "12345",
            content: "hi",
        });

        expect(received).toHaveLength(1);
    });

    it("sends message to correct channel", async () => {
        const mockSend = vi.fn();
        mockFetch.mockResolvedValue({
            isTextBased: () => true,
            send: mockSend,
        });

        await listener.send({ platform: "discord", channel: "12345" }, "response text");

        expect(mockFetch).toHaveBeenCalledWith("12345");
        expect(mockSend).toHaveBeenCalledWith("response text");
    });
});
