// ─── Token Management ─────────────────────────────────────────

const TOKEN_KEY = "sb-token";

export function getToken(): string {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
    sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
    sessionStorage.removeItem(TOKEN_KEY);
}

/** Check hash fragment for token (/#token=xxx), store it, clean URL */
export function extractHashToken(): string | null {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const token = params.get("token");
    if (token) {
        setToken(token);
        window.history.replaceState({}, "", window.location.pathname);
        return token;
    }
    return null;
}

// ─── Fetch Wrapper ────────────────────────────────────────────

async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const token = getToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
        const res = await fetch(path, {
            ...init,
            signal: controller.signal,
            headers: {
                ...init?.headers,
                Authorization: `Bearer ${token}`,
                ...(init?.body ? { "Content-Type": "application/json" } : {}),
            },
        });
        clearTimeout(timeout);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new ApiError(res.status, body?.error ?? res.statusText);
        }
        return res.json();
    } catch (err) {
        clearTimeout(timeout);
        if (err instanceof DOMException && err.name === "AbortError") {
            throw new ApiError(0, "Request timed out — server may be unreachable");
        }
        throw err;
    }
}

export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
        this.name = "ApiError";
    }
}

// ─── API Functions ────────────────────────────────────────────

export function fetchPing(): Promise<{ pong: boolean }> {
    return apiFetch("/api/ping");
}

export function fetchStatus(): Promise<{
    ok: boolean;
    uptime: number;
    model: string;
    contextSize: number;
    listenerCount: number;
    sessions: string[];
}> {
    return apiFetch("/api/status");
}

export interface SessionInfo {
    name: string;
    state: string;
    model?: string;
    contextSize?: number;
    lastActivity?: number;
    today?: { inputTokens: number; outputTokens: number; cost: number; messageCount: number } | null;
}

export function fetchSessions(): Promise<{ sessions: SessionInfo[] }> {
    return apiFetch("/api/sessions");
}

export function fetchCron(): Promise<{
    jobs: Array<{ name: string; schedule: string; enabled: boolean }>;
}> {
    return apiFetch("/api/cron");
}

export function fetchUsage(): Promise<{
    today: { inputTokens: number; outputTokens: number; cost: number; messageCount: number };
    week: { cost: number };
    contextSize: number;
}> {
    return apiFetch("/api/usage");
}

export function fetchActivity(): Promise<{
    entries: Array<{
        sender: string;
        platform: string;
        channel: string;
        timestamp: number;
        responseTimeMs: number;
    }>;
}> {
    return apiFetch("/api/activity");
}

export function fetchLogs(): Promise<{
    entries: Array<{ timestamp: string; level: string; message: string; [key: string]: unknown }>;
}> {
    return apiFetch("/api/logs");
}

// ─── Vault API ────────────────────────────────────────────────

export interface VaultFileEntry {
    name: string;
    path: string;
    type: "file" | "dir";
    children?: VaultFileEntry[];
}

export function fetchFiles(dir?: string, search?: string): Promise<{ entries: VaultFileEntry[] }> {
    const params = new URLSearchParams();
    if (dir) params.set("dir", dir);
    if (search) params.set("search", search);
    const qs = params.toString();
    return apiFetch(`/api/files${qs ? `?${qs}` : ""}`);
}

export function fetchFile(path: string): Promise<{ content: string; binary?: boolean }> {
    return apiFetch(`/api/files/${encodeURIComponent(path)}`);
}

export function putFile(path: string, content: string): Promise<{ ok: boolean; path: string }> {
    return apiFetch(`/api/files/${encodeURIComponent(path)}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
    });
}

export function deleteFile(path: string): Promise<{ ok: boolean; path: string }> {
    return apiFetch(`/api/files/${encodeURIComponent(path)}`, {
        method: "DELETE",
    });
}

export function moveFile(from: string, to: string): Promise<{ ok: boolean; from: string; to: string }> {
    return apiFetch("/api/files/move", {
        method: "POST",
        body: JSON.stringify({ from, to }),
    });
}

/** Build a URL for the raw file endpoint (for image src, etc.) */
export function rawFileUrl(path: string): string {
    return `/api/files/${encodeURIComponent(path)}?raw=true`;
}

export function fetchGitLog(limit?: number): Promise<{
    entries: Array<{ hash: string; author: string; date: string; message: string }>;
}> {
    const qs = limit ? `?limit=${limit}` : "";
    return apiFetch(`/api/git/log${qs}`);
}

export function postGitSync(message?: string): Promise<{ ok: boolean; committed: boolean; pushed: boolean }> {
    return apiFetch("/api/git/sync", {
        method: "POST",
        body: JSON.stringify(message ? { message } : {}),
    });
}
