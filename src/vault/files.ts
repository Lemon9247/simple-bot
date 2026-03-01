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

const TEXT_EXTENSIONS = new Set([
    ".md", ".txt", ".json", ".yaml", ".yml",
    ".html", ".css", ".js", ".ts", ".svg",
    ".excalidraw",
]);

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

        // Check that the real path (following symlinks) stays inside the vault.
        // Walk up to the nearest existing ancestor to catch symlinked directories.
        await this.verifyRealPath(resolved, userPath);

        return resolved;
    }

    /** Verify that the real filesystem path stays inside the vault */
    private async verifyRealPath(targetPath: string, userPath: string): Promise<void> {
        // Try realpath on the target itself first
        try {
            const real = await realpath(targetPath);
            if (!real.startsWith(this.root + sep) && real !== this.root) {
                throw new VaultPathError(`Symlink resolves outside vault: ${userPath}`);
            }
            return;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                throw err;
            }
        }

        // File doesn't exist — check the nearest existing parent
        let parent = dirname(targetPath);
        while (parent !== this.root && parent.startsWith(this.root)) {
            try {
                const real = await realpath(parent);
                if (!real.startsWith(this.root + sep) && real !== this.root) {
                    throw new VaultPathError(`Symlink resolves outside vault: ${userPath}`);
                }
                return;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw err;
                }
            }
            parent = dirname(parent);
        }
    }

    async readFile(relativePath: string): Promise<{ content: string; mimeType: string; encoding?: string }> {
        const fullPath = await this.resolveSafe(relativePath);

        try {
            // Check if path is a directory before attempting to read
            const stat = await lstat(fullPath);
            if (stat.isDirectory()) {
                throw new VaultPathError(`Path is a directory, not a file: ${relativePath}`);
            }

            const ext = extname(fullPath).toLowerCase();
            const mimeType = MIME_TYPES[ext] ?? "text/plain";
            const isText = TEXT_EXTENSIONS.has(ext) || !MIME_TYPES[ext];

            if (isText) {
                const content = await fsReadFile(fullPath, "utf-8");
                return { content, mimeType };
            } else {
                const buffer = await fsReadFile(fullPath);
                return { content: buffer.toString("base64"), mimeType, encoding: "base64" };
            }
        } catch (err) {
            if (err instanceof VaultPathError) throw err;
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
