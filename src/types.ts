export interface Attachment {
    url: string;
    filename: string;
    contentType: string;
    size: number;
    data?: Buffer;
    base64?: string;
}

export interface OutgoingFile {
    data: Buffer;
    filename: string;
}

export interface IncomingMessage {
    platform: string;
    channel: string;
    sender: string;
    text: string;
    attachments?: Attachment[];
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
    send(origin: MessageOrigin, text: string, files?: OutgoingFile[]): Promise<void>;
}

export interface ToolCallInfo {
    toolName: string;
    args: Record<string, any>;
}

export interface ToolEndInfo {
    toolName: string;
    toolCallId: string;
    result?: {
        content: Array<{ type: string; text?: string }>;
        details?: Record<string, any>;
    };
    isError: boolean;
}

export interface Config {
    pi: {
        cwd: string;
        command?: string;
        args?: string[];
        extensions?: string[];
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
    gracePeriodMs?: number;
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
    gracePeriodMs?: number;  // per-job override; undefined = use global default
    body: string;
}
