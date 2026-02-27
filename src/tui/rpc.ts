import { EventEmitter } from "node:events";

export interface RpcClientEvents {
    event: [event: any];
    connected: [];
    disconnected: [];
}

/**
 * WebSocket RPC client for connecting to the simple-bot daemon.
 * Uses Node 22's native WebSocket global.
 * Sends JSON commands, receives RPC responses + bridge event stream.
 * Auto-reconnects on disconnect.
 */
export class RpcClient extends EventEmitter<RpcClientEvents> {
    private ws: WebSocket | null = null;
    private url: string;
    private pending = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>();
    private shouldReconnect = true;
    private reconnectTimer?: ReturnType<typeof setTimeout>;

    constructor(host: string, port: number, token: string) {
        super();
        this.url = `ws://${host}:${port}/attach?token=${encodeURIComponent(token)}`;
    }

    get connected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    async connect(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(this.url);
            this.ws = ws;

            const onOpen = () => {
                cleanup();
                this.emit("connected");
                resolve();
            };

            const onError = (ev: Event) => {
                cleanup();
                reject(new Error("WebSocket connection failed"));
            };

            const onClose = () => {
                cleanup();
                reject(new Error("WebSocket closed before open"));
            };

            const cleanup = () => {
                ws.removeEventListener("open", onOpen);
                ws.removeEventListener("error", onError);
                ws.removeEventListener("close", onClose);
                // Attach persistent handlers
                ws.addEventListener("message", (ev) => this.handleMessage(ev.data as string));
                ws.addEventListener("close", () => this.handleClose());
                ws.addEventListener("error", () => {}); // prevent unhandled
            };

            ws.addEventListener("open", onOpen);
            ws.addEventListener("error", onError);
            ws.addEventListener("close", onClose);
        });
    }

    disconnect(): void {
        this.shouldReconnect = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.rejectAllPending(new Error("Disconnected"));
    }

    /** Send an RPC command and wait for the response */
    async send(type: string, params: Record<string, unknown> = {}): Promise<any> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("Not connected");
        }
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws!.send(JSON.stringify({ id, type, ...params }));
        });
    }

    private handleMessage(raw: string): void {
        let msg: any;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        // RPC response to a command we sent
        if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.success) {
                resolve(msg.data);
            } else {
                reject(new Error(msg.error ?? "RPC error"));
            }
            return;
        }

        // Bridge event — forward to listeners
        this.emit("event", msg);
    }

    private handleClose(): void {
        this.ws = null;
        this.rejectAllPending(new Error("Connection closed"));
        this.emit("disconnected");

        if (this.shouldReconnect) {
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = undefined;
            try {
                await this.connect();
            } catch {
                if (this.shouldReconnect) {
                    this.scheduleReconnect();
                }
            }
        }, 2000);
    }

    private rejectAllPending(err: Error): void {
        for (const [, { reject }] of this.pending) reject(err);
        this.pending.clear();
    }
}
