import { resolve, relative, sep } from "node:path";
import {
    readFile as fsReadFile,
    writeFile as fsWriteFile,
    unlink,
    mkdir,
    readdir,
    lstat,
    realpath,
} from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { VaultFileEntry } from "../types.js";

const MIME_TYPES: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".ts": "text/typescript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".excalidraw": "application/json",
};

export class VaultFiles {
    private root: string;

    constructor(vaultRoot: string) {
        this.root = resolve(vaultRoot);
    }

    /** Resolve a user-provided path and verify it's inside the vault */
    private async resolveSafe(userPath: string): Promise<string> {
        // Reject paths with .. components before resolution
        const normalized = relative(".", userPath);
        if (normalized.startsWith("..") || normalized.split(sep).includes("..")) {
            throw new VaultPathError(`Path traversal rejected: ${userPath}`);
        }

        const resolved = resolve(this.root, userPath);

        // Must be within vault root
        if (!resolved.startsWith(this.root + sep) && resolved !== this.root) {
            throw new VaultPathError(`Path outside vault: ${userPath}`);
        }

        // Check if the path exists and if so, verify symlinks resolve inside vault
        try {
            const stat = await lstat(resolved);
            if (stat.isSymbolicLink()) {
                const real = await realpath(resolved);
                if (!real.startsWith(this.root + sep) && real !== this.root) {
                    throw new VaultPathError(`Symlink resolves outside vault: ${userPath}`);
                }
            }
        } catch (err) {
            // File doesn't exist yet — that's fine for write operations
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                throw err;
            }
        }

        return resolved;
    }

    async readFile(relativePath: string): Promise<{ content: string; mimeType: string }> {
        const fullPath = await this.resolveSafe(relativePath);

        try {
            const content = await fsReadFile(fullPath, "utf-8");
            const ext = extname(fullPath).toLowerCase();
            const mimeType = MIME_TYPES[ext] ?? "text/plain";
            return { content, mimeType };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new VaultNotFoundError(`File not found: ${relativePath}`);
            }
            throw err;
        }
    }

    async writeFile(relativePath: string, content: string): Promise<void> {
        const fullPath = await this.resolveSafe(relativePath);

        // Create parent directories if needed
        await mkdir(dirname(fullPath), { recursive: true });
        await fsWriteFile(fullPath, content, "utf-8");
    }

    async deleteFile(relativePath: string): Promise<void> {
        const fullPath = await this.resolveSafe(relativePath);

        try {
            await unlink(fullPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new VaultNotFoundError(`File not found: ${relativePath}`);
            }
            throw err;
        }
    }

    async listFiles(dir?: string, search?: string): Promise<VaultFileEntry[]> {
        const targetDir = dir
            ? await this.resolveSafe(dir)
            : this.root;

        const entries = await this.buildTree(targetDir, this.root);

        if (search) {
            return this.filterTree(entries, search.toLowerCase());
        }

        return entries;
    }

    private async buildTree(dirPath: string, rootPath: string): Promise<VaultFileEntry[]> {
        let items: import("node:fs").Dirent[];
        try {
            items = await readdir(dirPath, { withFileTypes: true });
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new VaultNotFoundError(`Directory not found: ${relative(rootPath, dirPath)}`);
            }
            throw err;
        }

        // Sort: directories first, then alphabetically
        items.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });

        const result: VaultFileEntry[] = [];

        for (const item of items) {
            // Skip hidden files/dirs
            if (item.name.startsWith(".")) continue;

            const fullPath = resolve(dirPath, item.name);
            const relPath = relative(rootPath, fullPath);

            if (item.isDirectory()) {
                const children = await this.buildTree(fullPath, rootPath);
                result.push({
                    name: item.name,
                    path: relPath,
                    type: "dir",
                    children,
                });
            } else if (item.isFile()) {
                result.push({
                    name: item.name,
                    path: relPath,
                    type: "file",
                });
            }
        }

        return result;
    }

    private filterTree(entries: VaultFileEntry[], search: string): VaultFileEntry[] {
        const result: VaultFileEntry[] = [];

        for (const entry of entries) {
            if (entry.type === "dir" && entry.children) {
                const filteredChildren = this.filterTree(entry.children, search);
                if (filteredChildren.length > 0) {
                    result.push({ ...entry, children: filteredChildren });
                }
            } else if (entry.type === "file") {
                if (entry.name.toLowerCase().includes(search)) {
                    result.push(entry);
                }
            }
        }

        return result;
    }
}

export class VaultPathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VaultPathError";
    }
}

export class VaultNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VaultNotFoundError";
    }
}
