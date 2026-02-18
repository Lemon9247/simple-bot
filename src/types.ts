export interface IncomingMessage {
    platform: string;
    channel: string;
    sender: string;
    text: string;
}

export interface MessageOrigin {
    platform: string;
    channel: string;
}

export interface Listener {
    readonly name: string;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    onMessage(handler: (msg: IncomingMessage) => void): void;
    send(origin: MessageOrigin, text: string): Promise<void>;
}

export interface ToolCallInfo {
    toolName: string;
    args: Record<string, any>;
}

export interface Config {
    pi: {
        cwd: string;
        command?: string;
        args?: string[];
    };
    security: {
        allowed_users: string[];
    };
    matrix?: {
        homeserver: string;
        user: string;
        token: string;
        storage_path?: string;
    };
    discord?: {
        token: string;
    };
    heartbeat?: {
        enabled: boolean;
        schedule: string;
        checklist: string;
        notify_room: string;
    };
}
