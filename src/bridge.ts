import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface BridgeOptions {
    cwd: string;
    command?: string;
    args?: string[];
    spawnFn?: typeof spawn;
}

interface Pending {
    resolve: (data: any) => void;
    reject: (err: Error) => void;
}

export class Bridge extends EventEmitter {
    private proc: ChildProcess | null = null;
    private buffer = "";
    private responseText = "";
    private responseQueue: Pending[] = [];
    private rpcPending = new Map<string, Pending>();
    private opts: BridgeOptions;

    constructor(opts: BridgeOptions) {
        super();
        this.opts = opts;
    }

    start(): void {
        const cmd = this.opts.command ?? "pi";
        const args = this.opts.args ?? ["--mode", "rpc", "--continue"];
        const doSpawn = this.opts.spawnFn ?? spawn;

        this.proc = doSpawn(cmd, args, {
            cwd: this.opts.cwd,
            stdio: ["pipe", "pipe", "pipe"],
        });

        this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk.toString()));
        this.proc.stderr!.on("data", (chunk: Buffer) => {
            console.error(`[pi] ${chunk.toString().trim()}`);
        });
        this.proc.on("exit", (code, signal) => {
            this.rejectAll(new Error(`Pi exited (code=${code}, signal=${signal})`));
            this.emit("exit", code, signal);
        });
        this.proc.on("error", (err) => {
            this.rejectAll(err);
            this.emit("error", err);
        });
    }

    sendMessage(text: string): Promise<string> {
        if (!this.proc?.stdin?.writable) {
            return Promise.reject(new Error("Pi process not running"));
        }
        return new Promise((resolve, reject) => {
            const entry: Pending = { resolve, reject };
            this.responseQueue.push(entry);
            this.rpc("follow_up", { message: text }).catch((err) => {
                const idx = this.responseQueue.indexOf(entry);
                if (idx >= 0) this.responseQueue.splice(idx, 1);
                reject(err);
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.proc) return;
        const p = this.proc;
        this.proc = null;
        p.kill("SIGTERM");
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                p.kill("SIGKILL");
                resolve();
            }, 5000);
            p.on("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    get running(): boolean {
        return this.proc !== null && this.proc.exitCode === null;
    }

    private rpc(type: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = randomUUID();
        const line = JSON.stringify({ id, type, ...params });
        return new Promise((resolve, reject) => {
            this.rpcPending.set(id, { resolve, reject });
            this.proc!.stdin!.write(line + "\n");
        });
    }

    private onData(data: string): void {
        this.buffer += data;
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                this.onEvent(JSON.parse(line));
            } catch {
                // not JSON, skip
            }
        }
    }

    private onEvent(event: any): void {
        // RPC response to a command we sent
        if (event.type === "response" && event.id && this.rpcPending.has(event.id)) {
            const pending = this.rpcPending.get(event.id)!;
            this.rpcPending.delete(event.id);
            event.success ? pending.resolve(event.data) : pending.reject(new Error(event.error ?? "RPC error"));
            return;
        }

        // Accumulate assistant text deltas
        if (event.type === "message_update") {
            const delta = event.assistantMessageEvent;
            if (delta?.type === "text_delta") {
                this.responseText += delta.delta;
            }
        }

        // Agent done — resolve oldest queued promise
        if (event.type === "agent_end") {
            const text = this.responseText.trim();
            this.responseText = "";
            const next = this.responseQueue.shift();
            if (next) next.resolve(text);
        }

        this.emit("event", event);
    }

    private rejectAll(err: Error): void {
        for (const { reject } of this.responseQueue) reject(err);
        this.responseQueue = [];
        for (const [, { reject }] of this.rpcPending) reject(err);
        this.rpcPending.clear();
    }
}
