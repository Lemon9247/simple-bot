import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { VaultFiles, VaultPathError, VaultNotFoundError } from "../src/vault/files.js";

const TMP_DIR = join(import.meta.dirname!, "__test_vault__");

function makeVault(): VaultFiles {
    return new VaultFiles(TMP_DIR);
}

describe("VaultFiles", () => {
    beforeEach(() => {
        mkdirSync(TMP_DIR, { recursive: true });
    });

    afterEach(() => {
        rmSync(TMP_DIR, { recursive: true, force: true });
    });

    // ─── Read ─────────────────────────────────────────────

    describe("readFile", () => {
        it("reads an existing file", async () => {
            writeFileSync(join(TMP_DIR, "hello.md"), "# Hello");
            const vault = makeVault();
            const result = await vault.readFile("hello.md");
            expect(result.content).toBe("# Hello");
            expect(result.mimeType).toBe("text/markdown");
        });

        it("returns correct mime type for JSON files", async () => {
            writeFileSync(join(TMP_DIR, "data.json"), "{}");
            const vault = makeVault();
            const result = await vault.readFile("data.json");
            expect(result.mimeType).toBe("application/json");
        });

        it("returns text/plain for unknown extensions", async () => {
            writeFileSync(join(TMP_DIR, "readme.xyz"), "stuff");
            const vault = makeVault();
            const result = await vault.readFile("readme.xyz");
            expect(result.mimeType).toBe("text/plain");
        });

        it("throws VaultNotFoundError for non-existent file", async () => {
            const vault = makeVault();
            await expect(vault.readFile("nope.md")).rejects.toThrow(VaultNotFoundError);
        });

        it("reads files in subdirectories", async () => {
            mkdirSync(join(TMP_DIR, "sub"), { recursive: true });
            writeFileSync(join(TMP_DIR, "sub", "nested.md"), "nested content");
            const vault = makeVault();
            const result = await vault.readFile("sub/nested.md");
            expect(result.content).toBe("nested content");
        });
    });

    // ─── Write ────────────────────────────────────────────

    describe("writeFile", () => {
        it("writes a new file", async () => {
            const vault = makeVault();
            await vault.writeFile("new.md", "new content");
            const result = await vault.readFile("new.md");
            expect(result.content).toBe("new content");
        });

        it("overwrites an existing file", async () => {
            writeFileSync(join(TMP_DIR, "existing.md"), "old");
            const vault = makeVault();
            await vault.writeFile("existing.md", "new");
            const result = await vault.readFile("existing.md");
            expect(result.content).toBe("new");
        });

        it("creates parent directories as needed", async () => {
            const vault = makeVault();
            await vault.writeFile("deep/nested/dir/file.md", "deep content");
            const result = await vault.readFile("deep/nested/dir/file.md");
            expect(result.content).toBe("deep content");
        });
    });

    // ─── Delete ───────────────────────────────────────────

    describe("deleteFile", () => {
        it("deletes an existing file", async () => {
            writeFileSync(join(TMP_DIR, "doomed.md"), "bye");
            const vault = makeVault();
            await vault.deleteFile("doomed.md");
            await expect(vault.readFile("doomed.md")).rejects.toThrow(VaultNotFoundError);
        });

        it("throws VaultNotFoundError for non-existent file", async () => {
            const vault = makeVault();
            await expect(vault.deleteFile("ghost.md")).rejects.toThrow(VaultNotFoundError);
        });
    });

    // ─── List ─────────────────────────────────────────────

    describe("listFiles", () => {
        it("lists files in the vault root", async () => {
            writeFileSync(join(TMP_DIR, "a.md"), "");
            writeFileSync(join(TMP_DIR, "b.txt"), "");
            const vault = makeVault();
            const entries = await vault.listFiles();
            expect(entries).toHaveLength(2);
            expect(entries[0]).toEqual({ name: "a.md", path: "a.md", type: "file" });
            expect(entries[1]).toEqual({ name: "b.txt", path: "b.txt", type: "file" });
        });

        it("lists directories and their children recursively", async () => {
            mkdirSync(join(TMP_DIR, "notes"), { recursive: true });
            writeFileSync(join(TMP_DIR, "notes", "idea.md"), "");
            writeFileSync(join(TMP_DIR, "root.md"), "");
            const vault = makeVault();
            const entries = await vault.listFiles();

            // Directories come first
            expect(entries[0].name).toBe("notes");
            expect(entries[0].type).toBe("dir");
            expect(entries[0].children).toHaveLength(1);
            expect(entries[0].children![0].name).toBe("idea.md");
            expect(entries[1].name).toBe("root.md");
        });

        it("lists files in a subdirectory when dir is specified", async () => {
            mkdirSync(join(TMP_DIR, "sub"), { recursive: true });
            writeFileSync(join(TMP_DIR, "sub", "file.md"), "");
            writeFileSync(join(TMP_DIR, "root.md"), "");
            const vault = makeVault();
            const entries = await vault.listFiles("sub");
            expect(entries).toHaveLength(1);
            expect(entries[0].name).toBe("file.md");
        });

        it("skips hidden files and directories", async () => {
            writeFileSync(join(TMP_DIR, ".hidden"), "");
            mkdirSync(join(TMP_DIR, ".git"), { recursive: true });
            writeFileSync(join(TMP_DIR, "visible.md"), "");
            const vault = makeVault();
            const entries = await vault.listFiles();
            expect(entries).toHaveLength(1);
            expect(entries[0].name).toBe("visible.md");
        });

        it("returns empty array for empty directory", async () => {
            const vault = makeVault();
            const entries = await vault.listFiles();
            expect(entries).toEqual([]);
        });

        it("throws for non-existent directory", async () => {
            const vault = makeVault();
            await expect(vault.listFiles("nope")).rejects.toThrow(VaultNotFoundError);
        });
    });

    // ─── Search ───────────────────────────────────────────

    describe("search filtering", () => {
        it("filters files by name substring (case-insensitive)", async () => {
            writeFileSync(join(TMP_DIR, "meeting-notes.md"), "");
            writeFileSync(join(TMP_DIR, "todo.md"), "");
            writeFileSync(join(TMP_DIR, "NOTES.md"), "");
            const vault = makeVault();
            const entries = await vault.listFiles(undefined, "notes");
            expect(entries).toHaveLength(2);
            const names = entries.map((e) => e.name);
            expect(names).toContain("meeting-notes.md");
            expect(names).toContain("NOTES.md");
        });

        it("includes directories that contain matching files", async () => {
            mkdirSync(join(TMP_DIR, "docs"), { recursive: true });
            writeFileSync(join(TMP_DIR, "docs", "readme.md"), "");
            writeFileSync(join(TMP_DIR, "other.txt"), "");
            const vault = makeVault();
            const entries = await vault.listFiles(undefined, "readme");
            expect(entries).toHaveLength(1);
            expect(entries[0].type).toBe("dir");
            expect(entries[0].children![0].name).toBe("readme.md");
        });

        it("returns empty array when no files match", async () => {
            writeFileSync(join(TMP_DIR, "hello.md"), "");
            const vault = makeVault();
            const entries = await vault.listFiles(undefined, "zzzzz");
            expect(entries).toEqual([]);
        });
    });

    // ─── Path Traversal Protection ────────────────────────

    describe("path traversal protection", () => {
        it("rejects ../ in path", async () => {
            const vault = makeVault();
            await expect(vault.readFile("../etc/passwd")).rejects.toThrow(VaultPathError);
        });

        it("rejects ../../ in path", async () => {
            const vault = makeVault();
            await expect(vault.readFile("../../etc/passwd")).rejects.toThrow(VaultPathError);
        });

        it("rejects path with .. component in middle", async () => {
            const vault = makeVault();
            await expect(vault.readFile("sub/../../../etc/passwd")).rejects.toThrow(VaultPathError);
        });

        it("rejects write with path traversal", async () => {
            const vault = makeVault();
            await expect(vault.writeFile("../outside.txt", "bad")).rejects.toThrow(VaultPathError);
        });

        it("rejects delete with path traversal", async () => {
            const vault = makeVault();
            await expect(vault.deleteFile("../outside.txt")).rejects.toThrow(VaultPathError);
        });

        it("rejects symlinks that resolve outside the vault", async () => {
            // Create a symlink inside the vault that points outside
            symlinkSync("/tmp", join(TMP_DIR, "escape-link"));
            const vault = makeVault();
            await expect(vault.readFile("escape-link/something")).rejects.toThrow(VaultPathError);
        });
    });
});
