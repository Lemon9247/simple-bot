import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { VaultGit } from "../src/vault/git.js";

const TMP_DIR = join(import.meta.dirname!, "__test_git_vault__");

function initGitRepo(): void {
    mkdirSync(TMP_DIR, { recursive: true });
    execFileSync("git", ["init"], { cwd: TMP_DIR });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: TMP_DIR });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: TMP_DIR });
}

function addCommit(filename: string, content: string, message: string): void {
    writeFileSync(join(TMP_DIR, filename), content);
    execFileSync("git", ["add", "."], { cwd: TMP_DIR });
    execFileSync("git", ["commit", "-m", message], { cwd: TMP_DIR });
}

describe("VaultGit", () => {
    beforeEach(() => {
        initGitRepo();
    });

    afterEach(() => {
        rmSync(TMP_DIR, { recursive: true, force: true });
    });

    // ─── Log ──────────────────────────────────────────────

    describe("log", () => {
        it("returns empty array for repo with no commits", async () => {
            const git = new VaultGit(TMP_DIR);
            const entries = await git.log();
            expect(entries).toEqual([]);
        });

        it("parses commit log entries", async () => {
            addCommit("file1.md", "hello", "First commit");
            addCommit("file2.md", "world", "Second commit");
            const git = new VaultGit(TMP_DIR);
            const entries = await git.log();

            expect(entries).toHaveLength(2);
            expect(entries[0].message).toBe("Second commit");
            expect(entries[1].message).toBe("First commit");
            expect(entries[0].hash).toMatch(/^[0-9a-f]+$/);
        });

        it("respects limit parameter", async () => {
            addCommit("a.md", "a", "Commit A");
            addCommit("b.md", "b", "Commit B");
            addCommit("c.md", "c", "Commit C");
            const git = new VaultGit(TMP_DIR);
            const entries = await git.log(2);

            expect(entries).toHaveLength(2);
            expect(entries[0].message).toBe("Commit C");
            expect(entries[1].message).toBe("Commit B");
        });
    });

    // ─── Sync ─────────────────────────────────────────────

    describe("sync", () => {
        it("commits staged changes", async () => {
            addCommit("initial.md", "init", "Initial");
            writeFileSync(join(TMP_DIR, "new.md"), "new content");

            const git = new VaultGit(TMP_DIR);
            const result = await git.sync("Test sync");

            expect(result.committed).toBe(true);
            expect(result.pushed).toBe(false); // No remote

            const entries = await git.log(1);
            expect(entries[0].message).toBe("Test sync");
        });

        it("reports committed=false when nothing to commit", async () => {
            addCommit("file.md", "content", "Initial");

            const git = new VaultGit(TMP_DIR);
            const result = await git.sync();

            expect(result.committed).toBe(false);
            expect(result.pushed).toBe(false);
        });

        it("uses default message when none provided", async () => {
            addCommit("initial.md", "init", "Initial");
            writeFileSync(join(TMP_DIR, "auto.md"), "auto");

            const git = new VaultGit(TMP_DIR);
            const result = await git.sync();

            expect(result.committed).toBe(true);

            const entries = await git.log(1);
            expect(entries[0].message).toMatch(/^vault sync /);
        });

        it("handles push failure gracefully (no remote)", async () => {
            addCommit("initial.md", "init", "Initial");
            writeFileSync(join(TMP_DIR, "new.md"), "stuff");

            const git = new VaultGit(TMP_DIR);
            const result = await git.sync("Push test");

            expect(result.committed).toBe(true);
            expect(result.pushed).toBe(false);
        });
    });
});
