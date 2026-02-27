import { describe, it, expect } from "vitest";
import { ChatDisplay } from "../src/tui/chat.js";

describe("ChatDisplay", () => {
    it("starts not streaming", () => {
        const chat = new ChatDisplay();
        expect(chat.streaming).toBe(false);
    });

    it("adds user message as child components", () => {
        const chat = new ChatDisplay();
        chat.addUserMessage("Hello");
        // Should have: Spacer + Text (label) + Markdown (content)
        expect(chat.children.length).toBe(3);
    });

    it("tracks streaming state", () => {
        const chat = new ChatDisplay();
        expect(chat.streaming).toBe(false);

        chat.startStream();
        expect(chat.streaming).toBe(true);

        chat.endStream();
        expect(chat.streaming).toBe(false);
    });

    it("accumulates text deltas during streaming", () => {
        const chat = new ChatDisplay();
        chat.appendText("Hello ");
        expect(chat.streaming).toBe(true);

        chat.appendText("world");
        // Should have: Spacer + Text (label) + Markdown (content)
        expect(chat.children.length).toBe(3);

        // Render to check content includes accumulated text
        const lines = chat.render(80);
        const joined = lines.join("\n");
        expect(joined).toContain("Hello world");
    });

    it("adds system messages", () => {
        const chat = new ChatDisplay();
        const before = chat.children.length;
        chat.addSystemMessage("Connected.");
        expect(chat.children.length).toBe(before + 1);
    });

    it("adds tool call start and end indicators", () => {
        const chat = new ChatDisplay();
        const before = chat.children.length;
        chat.addToolStart("read", { path: "/etc/hosts" });
        expect(chat.children.length).toBe(before + 1);

        chat.addToolEnd("read", false);
        expect(chat.children.length).toBe(before + 2);
    });

    it("renders tool call with appropriate icon", () => {
        const chat = new ChatDisplay();
        chat.addToolStart("bash", { command: "ls -la" });
        const lines = chat.render(80);
        const joined = lines.join("\n");
        expect(joined).toContain("⚡");
        expect(joined).toContain("ls -la");
    });

    it("handles multiple messages in sequence", () => {
        const chat = new ChatDisplay();

        // User message
        chat.addUserMessage("What's 2+2?");

        // Assistant streams
        chat.startStream();
        chat.appendText("The answer is ");
        chat.appendText("4.");
        chat.endStream();

        // Another user message
        chat.addUserMessage("Thanks!");

        // Should have accumulated all components
        expect(chat.children.length).toBeGreaterThan(5);
        expect(chat.streaming).toBe(false);
    });
});
