import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceFiles, FilePathError, FileNotFoundError, VaultFiles, VaultPathError, VaultNotFoundError } from "../src/vault/files.js";

const TMP_DIR = join(import.meta.dirname!, "__test_vault__");
const ROOT_NAME = "test";

function makeFiles(): WorkspaceFiles {
    return new WorkspaceFiles({ [ROOT_NAME]: TMP_DIR });
}

describe("WorkspaceFiles", () => {
    beforeEach(() => {
        mkdirSync(TMP_DIR, { recursive: true });
    });

    afterEach(() => {
        rmSync(TMP_DIR, { recursive: true, force: true });
    });

    // ─── Backward compat aliases ──────────────────────────

    describe("backward compatibility", () => {
        it("VaultFiles is an alias for WorkspaceFiles", () => {
            expect(VaultFiles).toBe(WorkspaceFiles);
        });

        it("VaultPathError is an alias for FilePathError", () => {
            expect(VaultPathError).toBe(FilePathError);
        });

        it("VaultNotFoundError is an alias for FileNotFoundError", () => {
            expect(VaultNotFoundError).toBe(FileNotFoundError);
        });
    });

    // ─── Roots ────────────────────────────────────────────

    describe("roots", () => {
        it("returns configured root names", () => {
            const files = new WorkspaceFiles({ vault: "/tmp/a", sketches: "/tmp/b" });
            expect(files.getRootNames().sort()).toEqual(["sketches", "vault"]);
        });

        it("throws FilePathError for unknown root", async () => {
            const files = makeFiles();
            await expect(files.readFile("unknown", "file.md")).rejects.toThrow(FilePathError);
            await expect(files.readFile("unknown", "file.md")).rejects.toThrow("Unknown root");
        });
    });

    // ─── Read ─────────────────────────────────────────────

    describe("readFile", () => {
        it("reads an existing file", async () => {
            writeFileSync(join(TMP_DIR, "hello.md"), "# Hello");
            const files = makeFiles();
            const result = await files.readFile(ROOT_NAME, "hello.md");
            expect(result.content).toBe("# Hello");
            expect(result.mimeType).toBe("text/markdown");
        });

        it("returns correct mime type for JSON files", async () => {
            writeFileSync(join(TMP_DIR, "data.json"), "{}");
            const files = makeFiles();
            const result = await files.readFile(ROOT_NAME, "data.json");
            expect(result.mimeType).toBe("application/json");
        });

        it("returns text/plain for unknown extensions", async () => {
            writeFileSync(join(TMP_DIR, "readme.xyz"), "stuff");
            const files = makeFiles();
            const result = await files.readFile(ROOT_NAME, "readme.xyz");
            expect(result.mimeType).toBe("text/plain");
        });

        it("throws FileNotFoundError for non-existent file", async () => {
            const files = makeFiles();
            await expect(files.readFile(ROOT_NAME, "nope.md")).rejects.toThrow(FileNotFoundError);
        });

        it("reads files in subdirectories", async () => {
            mkdirSync(join(TMP_DIR, "sub"), { recursive: true });
            writeFileSync(join(TMP_DIR, "sub", "nested.md"), "nested content");
            const files = makeFiles();
            const result = await files.readFile(ROOT_NAME, "sub/nested.md");
            expect(result.content).toBe("nested content");
        });

        it("returns base64 encoding for binary files", async () => {
            const pngBytes = Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ]);
            writeFileSync(join(TMP_DIR, "image.png"), pngBytes);
            const files = makeFiles();
            const result = await files.readFile(ROOT_NAME, "image.png");
            expect(result.mimeType).toBe("image/png");
            expect(result.encoding).toBe("base64");
            expect(result.content).toBe(pngBytes.toString("base64"));
        });

        it("throws FilePathError when reading a directory", async () => {
            mkdirSync(join(TMP_DIR, "mydir"), { recursive: true });
            const files = makeFiles();
            await expect(files.readFile(ROOT_NAME, "mydir")).rejects.toThrow(FilePathError);
        });
    });

    // ─── Write ────────────────────────────────────────────

    describe("writeFile", () => {
        it("writes a new file", async () => {
            const files = makeFiles();
            await files.writeFile(ROOT_NAME, "new.md", "new content");
            const result = await files.readFile(ROOT_NAME, "new.md");
            expect(result.content).toBe("new content");
        });

        it("overwrites an existing file", async () => {
            writeFileSync(join(TMP_DIR, "existing.md"), "old");
            const files = makeFiles();
            await files.writeFile(ROOT_NAME, "existing.md", "new");
            const result = await files.readFile(ROOT_NAME, "existing.md");
            expect(result.content).toBe("new");
        });

        it("creates parent directories as needed", async () => {
            const files = makeFiles();
            await files.writeFile(ROOT_NAME, "deep/nested/dir/file.md", "deep content");
            const result = await files.readFile(ROOT_NAME, "deep/nested/dir/file.md");
            expect(result.content).toBe("deep content");
        });
    });

    // ─── Delete ───────────────────────────────────────────

    describe("deleteFile", () => {
        it("deletes an existing file", async () => {
            writeFileSync(join(TMP_DIR, "doomed.md"), "bye");
            const files = makeFiles();
            await files.deleteFile(ROOT_NAME, "doomed.md");
            await expect(files.readFile(ROOT_NAME, "doomed.md")).rejects.toThrow(FileNotFoundError);
        });

        it("throws FileNotFoundError for non-existent file", async () => {
            const files = makeFiles();
            await expect(files.deleteFile(ROOT_NAME, "ghost.md")).rejects.toThrow(FileNotFoundError);
        });
    });

    // ─── List ─────────────────────────────────────────────

    describe("listFiles", () => {
        it("lists files in the root", async () => {
            writeFileSync(join(TMP_DIR, "a.md"), "");
            writeFileSync(join(TMP_DIR, "b.txt"), "");
            const files = makeFiles();
            const entries = await files.listFiles(ROOT_NAME);
            expect(entries).toHaveLength(2);
            expect(entries[0]).toEqual({ name: "a.md", path: "a.md", type: "file" });
            expect(entries[1]).toEqual({ name: "b.txt", path: "b.txt", type: "file" });
        });

        it("lists directories and their children recursively", async () => {
            mkdirSync(join(TMP_DIR, "notes"), { recursive: true });
            writeFileSync(join(TMP_DIR, "notes", "idea.md"), "");
            writeFileSync(join(TMP_DIR, "root.md"), "");
            const files = makeFiles();
            const entries = await files.listFiles(ROOT_NAME);

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
            const files = makeFiles();
            const entries = await files.listFiles(ROOT_NAME, "sub");
            expect(entries).toHaveLength(1);
            expect(entries[0].name).toBe("file.md");
        });

        it("skips hidden files and directories", async () => {
            writeFileSync(join(TMP_DIR, ".hidden"), "");
            mkdirSync(join(TMP_DIR, ".git"), { recursive: true });
            writeFileSync(join(TMP_DIR, "visible.md"), "");
            const files = makeFiles();
            const entries = await files.listFiles(ROOT_NAME);
            expect(entries).toHaveLength(1);
            expect(entries[0].name).toBe("visible.md");
        });

        it("returns empty array for empty directory", async () => {
            const files = makeFiles();
            const entries = await files.listFiles(ROOT_NAME);
            expect(entries).toEqual([]);
        });

        it("throws for non-existent directory", async () => {
            const files = makeFiles();
            await expect(files.listFiles(ROOT_NAME, "nope")).rejects.toThrow(FileNotFoundError);
        });
    });

    // ─── Search ───────────────────────────────────────────

    describe("search filtering", () => {
        it("filters files by name substring (case-insensitive)", async () => {
            writeFileSync(join(TMP_DIR, "meeting-notes.md"), "");
            writeFileSync(join(TMP_DIR, "todo.md"), "");
            writeFileSync(join(TMP_DIR, "NOTES.md"), "");
            const files = makeFiles();
            const entries = await files.listFiles(ROOT_NAME, undefined, "notes");
            expect(entries).toHaveLength(2);
            const names = entries.map((e) => e.name);
            expect(names).toContain("meeting-notes.md");
            expect(names).toContain("NOTES.md");
        });

        it("includes directories that contain matching files", async () => {
            mkdirSync(join(TMP_DIR, "docs"), { recursive: true });
            writeFileSync(join(TMP_DIR, "docs", "readme.md"), "");
            writeFileSync(join(TMP_DIR, "other.txt"), "");
            const files = makeFiles();
            const entries = await files.listFiles(ROOT_NAME, undefined, "readme");
            expect(entries).toHaveLength(1);
            expect(entries[0].type).toBe("dir");
            expect(entries[0].children![0].name).toBe("readme.md");
        });

        it("returns empty array when no files match", async () => {
            writeFileSync(join(TMP_DIR, "hello.md"), "");
            const files = makeFiles();
            const entries = await files.listFiles(ROOT_NAME, undefined, "zzzzz");
            expect(entries).toEqual([]);
        });
    });

    // ─── Move ──────────────────────────────────────────────

    describe("moveFile", () => {
        it("moves a file to a new name", async () => {
            writeFileSync(join(TMP_DIR, "old.md"), "content");
            const files = makeFiles();
            await files.moveFile(ROOT_NAME, "old.md", "new.md");
            await expect(files.readFile(ROOT_NAME, "old.md")).rejects.toThrow(FileNotFoundError);
            const result = await files.readFile(ROOT_NAME, "new.md");
            expect(result.content).toBe("content");
        });

        it("moves a file to a subdirectory, creating parents", async () => {
            writeFileSync(join(TMP_DIR, "file.md"), "deep");
            const files = makeFiles();
            await files.moveFile(ROOT_NAME, "file.md", "a/b/c/file.md");
            const result = await files.readFile(ROOT_NAME, "a/b/c/file.md");
            expect(result.content).toBe("deep");
        });

        it("throws FileNotFoundError for non-existent source", async () => {
            const files = makeFiles();
            await expect(files.moveFile(ROOT_NAME, "ghost.md", "dest.md")).rejects.toThrow(FileNotFoundError);
        });

        it("rejects path traversal in source", async () => {
            const files = makeFiles();
            await expect(files.moveFile(ROOT_NAME, "../../etc/passwd", "dest.md")).rejects.toThrow(FilePathError);
        });

        it("rejects path traversal in destination", async () => {
            writeFileSync(join(TMP_DIR, "safe.md"), "data");
            const files = makeFiles();
            await expect(files.moveFile(ROOT_NAME, "safe.md", "../../etc/evil")).rejects.toThrow(FilePathError);
        });

        it("rejects moving a directory", async () => {
            mkdirSync(join(TMP_DIR, "mydir"), { recursive: true });
            const files = makeFiles();
            await expect(files.moveFile(ROOT_NAME, "mydir", "otherdir")).rejects.toThrow(FilePathError);
        });
    });

    // ─── Raw Read ─────────────────────────────────────────

    describe("readFileRaw", () => {
        it("returns raw buffer and mime type for binary files", async () => {
            const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
            writeFileSync(join(TMP_DIR, "image.png"), pngBytes);
            const files = makeFiles();
            const result = await files.readFileRaw(ROOT_NAME, "image.png");
            expect(result.mimeType).toBe("image/png");
            expect(Buffer.compare(result.buffer, pngBytes)).toBe(0);
        });

        it("returns application/octet-stream for unknown extensions", async () => {
            writeFileSync(join(TMP_DIR, "data.bin"), "binary");
            const files = makeFiles();
            const result = await files.readFileRaw(ROOT_NAME, "data.bin");
            expect(result.mimeType).toBe("application/octet-stream");
        });

        it("throws FileNotFoundError for non-existent file", async () => {
            const files = makeFiles();
            await expect(files.readFileRaw(ROOT_NAME, "nope.png")).rejects.toThrow(FileNotFoundError);
        });
    });

    // ─── Path Traversal Protection ────────────────────────

    describe("path traversal protection", () => {
        it("rejects ../ in path", async () => {
            const files = makeFiles();
            await expect(files.readFile(ROOT_NAME, "../etc/passwd")).rejects.toThrow(FilePathError);
        });

        it("rejects ../../ in path", async () => {
            const files = makeFiles();
            await expect(files.readFile(ROOT_NAME, "../../etc/passwd")).rejects.toThrow(FilePathError);
        });

        it("rejects path with .. component in middle", async () => {
            const files = makeFiles();
            await expect(files.readFile(ROOT_NAME, "sub/../../../etc/passwd")).rejects.toThrow(FilePathError);
        });

        it("rejects write with path traversal", async () => {
            const files = makeFiles();
            await expect(files.writeFile(ROOT_NAME, "../outside.txt", "bad")).rejects.toThrow(FilePathError);
        });

        it("rejects delete with path traversal", async () => {
            const files = makeFiles();
            await expect(files.deleteFile(ROOT_NAME, "../outside.txt")).rejects.toThrow(FilePathError);
        });

        it("rejects symlinks that resolve outside the root", async () => {
            symlinkSync("/tmp", join(TMP_DIR, "escape-link"));
            const files = makeFiles();
            await expect(files.readFile(ROOT_NAME, "escape-link/something")).rejects.toThrow(FilePathError);
        });
    });

    // ─── Multiple Roots ───────────────────────────────────

    describe("multiple roots", () => {
        const TMP_DIR_B = join(import.meta.dirname!, "__test_root_b__");

        beforeEach(() => {
            mkdirSync(TMP_DIR_B, { recursive: true });
        });

        afterEach(() => {
            rmSync(TMP_DIR_B, { recursive: true, force: true });
        });

        it("reads from different roots independently", async () => {
            writeFileSync(join(TMP_DIR, "shared.md"), "from root A");
            writeFileSync(join(TMP_DIR_B, "shared.md"), "from root B");

            const files = new WorkspaceFiles({ alpha: TMP_DIR, beta: TMP_DIR_B });
            const a = await files.readFile("alpha", "shared.md");
            const b = await files.readFile("beta", "shared.md");
            expect(a.content).toBe("from root A");
            expect(b.content).toBe("from root B");
        });

        it("writes to correct root", async () => {
            const files = new WorkspaceFiles({ alpha: TMP_DIR, beta: TMP_DIR_B });
            await files.writeFile("beta", "new.md", "beta content");

            const result = await files.readFile("beta", "new.md");
            expect(result.content).toBe("beta content");

            // Should not exist in alpha
            await expect(files.readFile("alpha", "new.md")).rejects.toThrow(FileNotFoundError);
        });

        it("path traversal cannot cross between roots", async () => {
            const files = new WorkspaceFiles({ alpha: TMP_DIR, beta: TMP_DIR_B });
            writeFileSync(join(TMP_DIR_B, "secret.md"), "secret");

            // Even though beta exists, alpha shouldn't be able to reach it
            await expect(files.readFile("alpha", "../__test_root_b__/secret.md")).rejects.toThrow(FilePathError);
        });
    });
});
