import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as logger from "./logger.js";

const INBOX_DIR = "/tmp/wren-inbox";
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export async function saveToInbox(filename: string, data: Buffer): Promise<string | null> {
    try {
        await mkdir(INBOX_DIR, { recursive: true });
        const safeName = `${randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const filePath = join(INBOX_DIR, safeName);
        await writeFile(filePath, data);
        return filePath;
    } catch (err) {
        logger.error("Failed to save to inbox", { filename, error: String(err) });
        return null;
    }
}

export async function cleanupInbox(): Promise<void> {
    try {
        const files = await readdir(INBOX_DIR);
        const now = Date.now();
        for (const file of files) {
            const filePath = join(INBOX_DIR, file);
            const st = await stat(filePath);
            if (now - st.mtimeMs > MAX_AGE_MS) {
                await unlink(filePath);
                logger.info("Cleaned up inbox file", { path: filePath });
            }
        }
    } catch (err: any) {
        if (err.code === "ENOENT") return; // inbox doesn't exist yet
        throw err;
    }
}
