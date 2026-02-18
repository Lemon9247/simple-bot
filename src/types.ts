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
    cron?: CronConfig;
}

export interface CronConfig {
    dir: string;
    default_notify?: string;
}

export type Step =
    | { type: "new-session" }
    | { type: "compact" }
    | { type: "model"; model: string }
    | { type: "prompt" }
    | { type: "reload" };

export interface JobDefinition {
    name: string;
    file: string;
    schedule: string;
    steps: Step[];
    notify: string | "none" | null;  // null = inherit default
    enabled: boolean;
    body: string;
}
