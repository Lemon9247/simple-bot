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

const LOG_BUFFER_CAPACITY = 200;
const logBuffer: LogEntry[] = [];

/** Return a copy of recent log entries (oldest first, up to 200). */
export function getLogBuffer(): LogEntry[] {
    return [...logBuffer];
}

/** Clear the log buffer (for testing). */
export function clearLogBuffer(): void {
    logBuffer.length = 0;
}

export function log(level: LogLevel, message: string, data?: LogData): void {
    const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...data,
    };

    // Push to ring buffer
    if (logBuffer.length >= LOG_BUFFER_CAPACITY) {
        logBuffer.shift();
    }
    logBuffer.push(entry);

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
