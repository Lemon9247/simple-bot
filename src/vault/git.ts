import { resolve } from "node:path";
import { execFile } from "node:child_process";

export interface GitLogEntry {
    hash: string;
    message: string;
}

export interface GitSyncResult {
    committed: boolean;
    pushed: boolean;
}

export class VaultGit {
    private cwd: string;

    constructor(vaultRoot: string) {
        this.cwd = resolve(vaultRoot);
    }

    async log(limit: number = 20): Promise<GitLogEntry[]> {
        let stdout: string;
        try {
            stdout = await this.run("git", ["log", "--oneline", `-${limit}`]);
        } catch (err) {
            // Empty repo — git log exits 128 with "does not have any commits yet"
            const msg = String(err);
            if (msg.includes("does not have any commits yet") || msg.includes("bad default revision")) {
                return [];
            }
            throw err;
        }
        if (!stdout.trim()) return [];

        return stdout
            .trim()
            .split("\n")
            .map((line) => {
                const spaceIdx = line.indexOf(" ");
                if (spaceIdx === -1) return { hash: line, message: "" };
                return {
                    hash: line.slice(0, spaceIdx),
                    message: line.slice(spaceIdx + 1),
                };
            });
    }

    async sync(message?: string): Promise<GitSyncResult> {
        const commitMsg = message || `vault sync ${new Date().toISOString()}`;
        const result: GitSyncResult = { committed: false, pushed: false };

        // Stage all changes
        await this.run("git", ["add", "."]);

        // Commit — may fail if nothing to commit
        try {
            await this.run("git", ["commit", "-m", commitMsg]);
            result.committed = true;
        } catch (err) {
            // "nothing to commit" is not an error
            const msg = String(err);
            if (msg.includes("nothing to commit") || msg.includes("nothing added to commit")) {
                return result;
            }
            throw err;
        }

        // Push — may fail if no remote configured
        try {
            await this.run("git", ["push"]);
            result.pushed = true;
        } catch {
            // No remote or push failed — not a fatal error
        }

        return result;
    }

    private run(command: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(command, args, { cwd: this.cwd, timeout: 30_000 }, (err, stdout, stderr) => {
                if (err) {
                    const output = [stderr, stdout, err.message].filter(Boolean).join("\n");
                    reject(new Error(`${command} ${args.join(" ")} failed: ${output}`));
                    return;
                }
                resolve(stdout);
            });
        });
    }
}
