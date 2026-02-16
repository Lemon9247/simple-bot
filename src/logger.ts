export type LogLevel = "info" | "warn" | "error";

export interface LogData {
    [key: string]: unknown;
}

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    [key: string]: unknown;
}

export function log(level: LogLevel, message: string, data?: LogData): void {
    const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...data,
    };

    const output = level === "error" ? process.stderr : process.stdout;
    output.write(JSON.stringify(entry) + "\n");
}

export function info(message: string, data?: LogData): void {
    log("info", message, data);
}

export function warn(message: string, data?: LogData): void {
    log("warn", message, data);
}

export function error(message: string, data?: LogData): void {
    log("error", message, data);
}
