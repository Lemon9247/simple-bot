import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock discord.js before importing
const mockOn = vi.fn();
const mockOnce = vi.fn();
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockFetch = vi.fn();

vi.mock("discord.js", () => ({
    Client: class MockClient {
        constructor() {
            (this as any).on = mockOn;
            (this as any).once = mockOnce;
            (this as any).login = mockLogin;
            (this as any).destroy = mockDestroy;
            (this as any).channels = { fetch: mockFetch };
        }
    },
    Intents: {
        FLAGS: {
            GUILDS: 1,
            GUILD_MESSAGES: 2,
            MESSAGE_CONTENT: 4,
            DIRECT_MESSAGES: 8,
        },
    },
}));

vi.mock("../src/logger.js", () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));

import { DiscordListener } from "../src/listeners/discord.js";
import type { IncomingMessage } from "../src/types.js";

function connectListener(listener: DiscordListener): Promise<void> {
    // Trigger the ready callback when connect is called
    mockOnce.mockImplementation((_event: string, cb: Function) => {
        cb({ user: { tag: "test#0" }, guilds: { cache: { map: () => [] } } });
    });
    return listener.connect();
}

describe("DiscordListener", () => {
    let listener: DiscordListener;

    beforeEach(() => {
        vi.clearAllMocks();
        listener = new DiscordListener("fake-token");
    });

    it("has name 'discord'", () => {
        expect(listener.name).toBe("discord");
    });

    it("logs in on connect", async () => {
        await connectListener(listener);
        expect(mockLogin).toHaveBeenCalledWith("fake-token");
    });

    it("destroys client on disconnect", async () => {
        await listener.disconnect();
        expect(mockDestroy).toHaveBeenCalled();
    });

    it("registers messageCreate handler on connect", async () => {
        await connectListener(listener);
        expect(mockOn).toHaveBeenCalledWith("messageCreate", expect.any(Function));
    });

    it("invokes onMessage handler with correct fields", async () => {
        const received: IncomingMessage[] = [];
        listener.onMessage((msg) => received.push(msg));
        await connectListener(listener);

        const handler = mockOn.mock.calls.find((c) => c[0] === "messageCreate")?.[1];
        handler({
            author: { bot: false, username: "willow" },
            channelId: "12345",
            content: "hello hades",
        });

        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({
            platform: "discord",
            channel: "12345",
            sender: "willow",
            text: "hello hades",
        });
    });

    it("ignores bot messages", async () => {
        const received: IncomingMessage[] = [];
        listener.onMessage((msg) => received.push(msg));
        await connectListener(listener);

        const handler = mockOn.mock.calls.find((c) => c[0] === "messageCreate")?.[1];
        handler({
            author: { bot: true, username: "otherbot" },
            channelId: "12345",
            content: "beep boop",
        });

        expect(received).toHaveLength(0);
    });

    it("passes all non-bot messages through (daemon handles security)", async () => {
        const received: IncomingMessage[] = [];
        listener.onMessage((msg) => received.push(msg));
        await connectListener(listener);

        const handler = mockOn.mock.calls.find((c) => c[0] === "messageCreate")?.[1];
        handler({
            author: { bot: false, username: "stranger" },
            channelId: "12345",
            content: "hey",
        });

        expect(received).toHaveLength(1);
    });

    it("sends message to correct channel", async () => {
        const mockSend = vi.fn();
        mockFetch.mockResolvedValue({
            isText: () => true,
            send: mockSend,
        });

        await listener.send({ platform: "discord", channel: "12345" }, "response text");

        expect(mockFetch).toHaveBeenCalledWith("12345");
        expect(mockSend).toHaveBeenCalledWith("response text");
    });
});
