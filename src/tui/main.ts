#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { startTuiClient } from "./client.js";

function usage(): never {
    console.log(`nest TUI client

Usage: nest-tui [options]

Options:
  --host <addr>      Daemon host (default: localhost)
  --port <port>      Daemon port (default: 3001)
  --token <tok>      Auth token (or set SIMPLE_BOT_TOKEN env var)
  --session <name>   Target session (default: daemon default)
  --watch            Read-only monitoring mode (no editor)
  --help             Show this help

The token can also be read from config.yaml in the current directory.`);
    process.exit(0);
}

function parseArgs(argv: string[]): { host: string; port: number; token: string; session?: string; watch: boolean } {
    let host = "localhost";
    let port = 3001;
    let token = process.env.SIMPLE_BOT_TOKEN ?? "";
    let session: string | undefined;
    let watch = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case "--host":
                host = argv[++i] ?? host;
                break;
            case "--port":
                port = parseInt(argv[++i] ?? "3001", 10);
                break;
            case "--token":
                token = argv[++i] ?? token;
                break;
            case "--session":
                session = argv[++i] ?? undefined;
                break;
            case "--watch":
                watch = true;
                break;
            case "--help":
            case "-h":
                usage();
                break;
            default:
                console.error(`Unknown option: ${arg}`);
                process.exit(1);
        }
    }

    // Try config.yaml fallback for token and port
    if (!token || port === 3001) {
        const configPath = resolve("config.yaml");
        if (existsSync(configPath)) {
            try {
                const raw = readFileSync(configPath, "utf-8");
                // Minimal YAML parsing for server.token and server.port
                const tokenMatch = raw.match(/^\s*token:\s*["']?([^"'\n]+)["']?\s*$/m);
                const portMatch = raw.match(/^\s*port:\s*(\d+)\s*$/m);
                if (!token && tokenMatch) token = tokenMatch[1].trim();
                if (port === 3001 && portMatch) port = parseInt(portMatch[1], 10);
            } catch {}
        }
    }

    if (!token) {
        console.error("Error: --token is required (or set SIMPLE_BOT_TOKEN env var, or add to config.yaml)");
        process.exit(1);
    }

    return { host, port, token, session, watch };
}

const opts = parseArgs(process.argv.slice(2));

startTuiClient(opts).catch((err) => {
    console.error("TUI error:", err.message ?? err);
    process.exit(1);
});
