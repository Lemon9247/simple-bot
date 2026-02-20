import { describe, it, expect } from "vitest";
import { splitMessage } from "../src/chunking.js";

describe("splitMessage", () => {
    it("returns single chunk for short text", () => {
        const result = splitMessage("hello world");
        expect(result).toEqual(["hello world"]);
    });

    it("returns single chunk for text at exactly maxLen", () => {
        const text = "a".repeat(2000);
        const result = splitMessage(text);
        expect(result).toEqual([text]);
    });

    it("returns empty string as single chunk", () => {
        expect(splitMessage("")).toEqual([""]);
    });

    it("splits at paragraph boundary", () => {
        const para1 = "a".repeat(1500);
        const para2 = "b".repeat(1500);
        const text = para1 + "\n\n" + para2;

        const result = splitMessage(text);
        expect(result.length).toBe(2);
        expect(result[0]).toBe(para1 + "\n");
        expect(result[1]).toBe(para2);
        result.forEach((chunk) => expect(chunk.length).toBeLessThanOrEqual(2000));
    });

    it("splits at line boundary when no paragraph break", () => {
        const line1 = "a".repeat(1500);
        const line2 = "b".repeat(1500);
        const text = line1 + "\n" + line2;

        const result = splitMessage(text);
        expect(result.length).toBe(2);
        expect(result[0]).toBe(line1 + "\n");
        result.forEach((chunk) => expect(chunk.length).toBeLessThanOrEqual(2000));
    });

    it("splits at space when no line break available", () => {
        const word1 = "a".repeat(1500);
        const word2 = "b".repeat(1500);
        const text = word1 + " " + word2;

        const result = splitMessage(text);
        expect(result.length).toBe(2);
        expect(result[0]).toBe(word1 + " ");
        result.forEach((chunk) => expect(chunk.length).toBeLessThanOrEqual(2000));
    });

    it("hard cuts when no break point available", () => {
        const text = "a".repeat(5000);
        const result = splitMessage(text);
        expect(result.length).toBe(3);
        expect(result[0].length).toBe(2000);
        expect(result[1].length).toBe(2000);
        expect(result[2].length).toBe(1000);
    });

    it("handles multiple chunks", () => {
        const parts = Array.from({ length: 5 }, (_, i) => `${"x".repeat(1800)} part${i}`);
        const text = parts.join("\n\n");
        const result = splitMessage(text);
        expect(result.length).toBeGreaterThan(2);
        result.forEach((chunk) => expect(chunk.length).toBeLessThanOrEqual(2000));
    });

    it("respects custom maxLen", () => {
        const text = "hello world, this is a test";
        const result = splitMessage(text, 15);
        expect(result.length).toBeGreaterThan(1);
        result.forEach((chunk) => expect(chunk.length).toBeLessThanOrEqual(15));
    });

    // Code block tests
    describe("code blocks", () => {
        it("closes and reopens code fence when split inside block", () => {
            const code = "x\n".repeat(1500);
            const text = "before\n```typescript\n" + code + "```\nafter";

            const result = splitMessage(text);
            expect(result.length).toBeGreaterThan(1);

            // First chunk should end with closing fence
            expect(result[0]).toMatch(/```$/);
            // Second chunk should start with reopening fence
            expect(result[1]).toMatch(/^```typescript\n/);

            result.forEach((chunk) => expect(chunk.length).toBeLessThanOrEqual(2000));
        });

        it("preserves language tag across split", () => {
            const code = "y\n".repeat(1500);
            const text = "```python\n" + code + "```";

            const result = splitMessage(text);
            expect(result.length).toBeGreaterThan(1);
            expect(result[1]).toMatch(/^```python\n/);
        });

        it("handles code block with no language tag", () => {
            const code = "z\n".repeat(1500);
            const text = "```\n" + code + "```";

            const result = splitMessage(text);
            expect(result.length).toBeGreaterThan(1);
            expect(result[0]).toMatch(/```$/);
            expect(result[1]).toMatch(/^```\n/);
        });

        it("does not break short code blocks", () => {
            const text = "hello\n```js\nconsole.log('hi');\n```\ngoodbye";
            const result = splitMessage(text);
            expect(result).toEqual([text]);
        });

        it("handles multiple code blocks", () => {
            const block1 = "```js\n" + "a\n".repeat(500) + "```";
            const block2 = "```py\n" + "b\n".repeat(500) + "```";
            const text = block1 + "\n\n" + block2;

            const result = splitMessage(text);
            result.forEach((chunk) => expect(chunk.length).toBeLessThanOrEqual(2000));

            // Verify all fences are balanced in each chunk
            for (const chunk of result) {
                const fences = chunk.match(/^`{3,}/gm) ?? [];
                expect(fences.length % 2).toBe(0);
            }
        });
    });
});
