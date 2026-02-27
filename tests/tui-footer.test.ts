import { describe, it, expect } from "vitest";
import { Footer } from "../src/tui/footer.js";

describe("Footer", () => {
    it("renders with default state", () => {
        const footer = new Footer();
        const lines = footer.render(80);
        expect(lines.length).toBeGreaterThan(0);
        const text = lines.join("\n");
        expect(text).toContain("connecting");
        expect(text).toContain("unknown");
    });

    it("updates model name", () => {
        const footer = new Footer();
        footer.setModel("claude-sonnet");
        const text = footer.render(80).join("\n");
        expect(text).toContain("claude-sonnet");
    });

    it("updates status", () => {
        const footer = new Footer();
        footer.setStatus("streaming");
        const text = footer.render(80).join("\n");
        expect(text).toContain("streaming");
        expect(text).toContain("⟳");
    });

    it("shows context tokens when set", () => {
        const footer = new Footer();
        footer.setContextTokens(15000);
        const text = footer.render(80).join("\n");
        expect(text).toContain("15k");
    });

    it("shows idle status with green indicator", () => {
        const footer = new Footer();
        footer.setStatus("idle");
        const text = footer.render(80).join("\n");
        expect(text).toContain("idle");
        expect(text).toContain("●");
    });
});
