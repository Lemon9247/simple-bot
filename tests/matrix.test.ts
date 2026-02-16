import { describe, it, expect, vi, beforeEach } from "vitest";
import { MatrixListener } from "../src/listeners/matrix.js";
import type { IncomingMessage } from "../src/types.js";

// Mock matrix-bot-sdk
const mockClient = {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue(undefined),
};

vi.mock("matrix-bot-sdk", () => {
    class MockMatrixClient {
        on = mockClient.on;
        start = mockClient.start;
        stop = mockClient.stop;
        sendText = mockClient.sendText;
    }

    class MockSimpleFsStorageProvider {}

    return {
        MatrixClient: MockMatrixClient,
        SimpleFsStorageProvider: MockSimpleFsStorageProvider,
    };
});

describe("MatrixListener", () => {
    let listener: MatrixListener;

    beforeEach(() => {
        vi.clearAllMocks();
        listener = new MatrixListener("https://athena.local", "@hades:athena", "fake-token");
    });

    it("implements the Listener interface with name='matrix'", () => {
        expect(listener.name).toBe("matrix");
        expect(listener.connect).toBeDefined();
        expect(listener.disconnect).toBeDefined();
        expect(listener.onMessage).toBeDefined();
        expect(listener.send).toBeDefined();
    });

    it("connects and starts the Matrix client", async () => {
        await listener.connect();
        expect(mockClient.on).toHaveBeenCalledWith("room.message", expect.any(Function));
        expect(mockClient.start).toHaveBeenCalled();
    });

    it("calls onMessage handler when a text message is received", async () => {
        const handler = vi.fn();
        listener.onMessage(handler);
        await listener.connect();

        // Get the registered event handler
        const messageHandler = mockClient.on.mock.calls.find(
            (call: any[]) => call[0] === "room.message"
        )?.[1];
        expect(messageHandler).toBeDefined();

        // Simulate an incoming message
        const event = {
            type: "m.room.message",
            sender: "@willow:athena",
            content: {
                msgtype: "m.text",
                body: "Hello Hades!",
            },
        };

        await messageHandler("!room123:athena", event);

        expect(handler).toHaveBeenCalledWith({
            platform: "matrix",
            channel: "!room123:athena",
            sender: "@willow:athena",
            text: "Hello Hades!",
        });
    });

    it("ignores messages from the bot itself", async () => {
        const handler = vi.fn();
        listener.onMessage(handler);
        await listener.connect();

        const messageHandler = mockClient.on.mock.calls.find(
            (call: any[]) => call[0] === "room.message"
        )?.[1];

        // Simulate a message from the bot's own user ID
        const event = {
            type: "m.room.message",
            sender: "@hades:athena",
            content: {
                msgtype: "m.text",
                body: "I'm talking to myself",
            },
        };

        await messageHandler("!room123:athena", event);

        expect(handler).not.toHaveBeenCalled();
    });

    it("ignores non-text message types", async () => {
        const handler = vi.fn();
        listener.onMessage(handler);
        await listener.connect();

        const messageHandler = mockClient.on.mock.calls.find(
            (call: any[]) => call[0] === "room.message"
        )?.[1];

        // Image message
        const imageEvent = {
            type: "m.room.message",
            sender: "@willow:athena",
            content: {
                msgtype: "m.image",
                body: "image.png",
            },
        };

        await messageHandler("!room123:athena", imageEvent);

        // State event
        const stateEvent = {
            type: "m.room.member",
            sender: "@willow:athena",
            content: {},
        };

        await messageHandler("!room123:athena", stateEvent);

        expect(handler).not.toHaveBeenCalled();
    });

    it("sends messages to the correct room", async () => {
        await listener.send(
            { platform: "matrix", channel: "!room456:athena" },
            "Test response"
        );

        expect(mockClient.sendText).toHaveBeenCalledWith("!room456:athena", "Test response");
    });

    it("disconnects and stops the Matrix client", async () => {
        await listener.disconnect();
        expect(mockClient.stop).toHaveBeenCalled();
    });

    it("does not crash if handler is not registered before message arrives", async () => {
        await listener.connect();

        const messageHandler = mockClient.on.mock.calls.find(
            (call: any[]) => call[0] === "room.message"
        )?.[1];

        const event = {
            type: "m.room.message",
            sender: "@willow:athena",
            content: {
                msgtype: "m.text",
                body: "No handler registered",
            },
        };

        // Should not throw
        await expect(messageHandler("!room123:athena", event)).resolves.toBeUndefined();
    });
});
