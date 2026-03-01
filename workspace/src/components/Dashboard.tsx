import { useState, useEffect, useRef, useCallback } from "react";
import { fetchStatus, fetchSessions, fetchCron, fetchUsage, fetchActivity, fetchLogs } from "../api";
import type { SessionInfo } from "../api";

const CONTEXT_WINDOW = 200000;
const REFRESH_FAST = 5000;
const REFRESH_SLOW = 15000;

// ─── Helpers (same as existing dashboard) ─────────────────────

function formatUptime(seconds: number | null | undefined): string {
    if (seconds == null) return "—";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function formatTokens(n: number | null | undefined): string {
    if (n == null || n === 0) return "0";
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
}

function gaugeColor(pct: number): string {
    if (pct < 50) return "var(--green)";
    if (pct < 75) return "var(--yellow)";
    if (pct < 90) return "var(--orange)";
    return "var(--red)";
}

function timeAgo(ts: number): string {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Component ────────────────────────────────────────────────

export default function Dashboard() {
    const [status, setStatus] = useState<any>(null);
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [cronJobs, setCronJobs] = useState<any[]>([]);
    const [usage, setUsage] = useState<any>(null);
    const [activity, setActivity] = useState<any[]>([]);
    const [logs, setLogs] = useState<any[]>([]);
    const logRef = useRef<HTMLDivElement>(null);

    const refreshStatus = useCallback(async () => {
        try { setStatus(await fetchStatus()); } catch { /* ignore */ }
    }, []);

    const refreshSessions = useCallback(async () => {
        try {
            const d = await fetchSessions();
            setSessions(d.sessions || []);
        } catch { /* ignore */ }
    }, []);

    const refreshCron = useCallback(async () => {
        try {
            const d = await fetchCron();
            setCronJobs(d.jobs || []);
        } catch { /* ignore */ }
    }, []);

    const refreshUsage = useCallback(async () => {
        try { setUsage(await fetchUsage()); } catch { /* ignore */ }
    }, []);

    const refreshActivity = useCallback(async () => {
        try {
            const d = await fetchActivity();
            setActivity(d.entries || []);
        } catch { /* ignore */ }
    }, []);

    const refreshLogs = useCallback(async () => {
        try {
            const d = await fetchLogs();
            setLogs(d.entries || []);
        } catch { /* ignore */ }
    }, []);

    useEffect(() => {
        // Initial fetch
        refreshStatus();
        refreshSessions();
        refreshCron();
        refreshUsage();
        refreshActivity();
        refreshLogs();

        // Fast polling: activity + sessions
        const fastTimers = [
            setInterval(refreshActivity, REFRESH_FAST),
            setInterval(refreshSessions, REFRESH_FAST),
        ];

        // Slow polling: everything else
        const slowTimers = [
            setInterval(refreshStatus, REFRESH_SLOW),
            setInterval(refreshUsage, REFRESH_SLOW),
            setInterval(refreshCron, REFRESH_SLOW),
            setInterval(refreshLogs, REFRESH_SLOW),
        ];

        return () => {
            [...fastTimers, ...slowTimers].forEach(clearInterval);
        };
    }, [refreshStatus, refreshSessions, refreshCron, refreshUsage, refreshActivity, refreshLogs]);

    // Auto-scroll logs
    useEffect(() => {
        const el = logRef.current;
        if (!el) return;
        const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        if (isNearBottom) {
            el.scrollTop = el.scrollHeight;
        }
    }, [logs]);

    const ctx = status?.contextSize || usage?.contextSize || 0;
    const ctxPct = Math.min(100, Math.round((ctx / CONTEXT_WINDOW) * 100));

    return (
        <div className="dashboard-grid">
            {/* Sessions Panel — hidden if single session */}
            {sessions.length > 1 && (
                <div className="panel">
                    <h2>Sessions</h2>
                    {sessions.map((s) => {
                        const stateClass = ["running", "idle", "starting", "stopping", "error"].includes(s.state)
                            ? s.state : "unknown";
                        const costStr = s.today && s.today.cost > 0 ? `$${s.today.cost.toFixed(4)}` : "";
                        const actStr = s.lastActivity ? timeAgo(s.lastActivity) : "";
                        return (
                            <div className="session-item" key={s.name}>
                                <span className="session-name">{s.name}</span>
                                <span className={`session-state ${stateClass}`}>{s.state}</span>
                                {actStr && <span className="session-activity">{actStr}</span>}
                                {costStr && <span className="session-cost">{costStr}</span>}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Status Panel */}
            <div className="panel">
                <h2>Status</h2>
                <div className="stat-row">
                    <span className="stat-label">Uptime</span>
                    <span className="stat-value">{formatUptime(status?.uptime)}</span>
                </div>
                <div className="stat-row">
                    <span className="stat-label">Model</span>
                    <span className="stat-value">{status?.model || "—"}</span>
                </div>
                <div className="stat-row">
                    <span className="stat-label">Listeners</span>
                    <span className="stat-value">{status?.listenerCount ?? "—"}</span>
                </div>
                <div className="context-gauge">
                    <div className="stat-row">
                        <span className="stat-label">Context</span>
                        <span className="stat-value">{ctxPct}%</span>
                    </div>
                    <div className="bar-track">
                        <div
                            className="bar-fill"
                            style={{ width: `${ctxPct}%`, background: gaugeColor(ctxPct) }}
                        />
                    </div>
                    <div className="bar-label">
                        <span>{formatTokens(ctx)}</span>
                        <span>{formatTokens(CONTEXT_WINDOW)}</span>
                    </div>
                </div>
            </div>

            {/* Cron Panel */}
            <div className="panel">
                <h2>Cron Jobs</h2>
                {cronJobs.length === 0 ? (
                    <div className="empty-state">No cron jobs</div>
                ) : (
                    <table>
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Schedule</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {cronJobs.map((j) => (
                                <tr key={j.name}>
                                    <td>{j.name}</td>
                                    <td><code>{j.schedule}</code></td>
                                    <td>
                                        <span className={`badge ${j.enabled ? "badge-on" : "badge-off"}`}>
                                            {j.enabled ? "enabled" : "disabled"}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Usage Panel */}
            <div className="panel">
                <h2>Usage</h2>
                <div className="usage-grid">
                    <div className="usage-card">
                        <div className="label">Today Cost</div>
                        <div className="value cost">${usage?.today?.cost?.toFixed(4) ?? "0.00"}</div>
                    </div>
                    <div className="usage-card">
                        <div className="label">Week Cost</div>
                        <div className="value cost">${usage?.week?.cost?.toFixed(4) ?? "0.00"}</div>
                    </div>
                    <div className="usage-card">
                        <div className="label">Messages Today</div>
                        <div className="value">{usage?.today?.messageCount ?? 0}</div>
                    </div>
                    <div className="usage-card">
                        <div className="label">Tokens (in/out)</div>
                        <div className="value">
                            {formatTokens(usage?.today?.inputTokens)} / {formatTokens(usage?.today?.outputTokens)}
                        </div>
                    </div>
                </div>
            </div>

            {/* Activity Panel */}
            <div className="panel">
                <h2>Recent Activity</h2>
                <div className="activity-list">
                    {activity.length === 0 ? (
                        <div className="empty-state">No recent activity</div>
                    ) : (
                        [...activity].reverse().map((e, i) => (
                            <div className="activity-item" key={i}>
                                <span className="activity-sender">{e.sender}</span>
                                <span className="activity-platform">{e.platform}</span>
                                <span className="activity-time">{timeAgo(e.timestamp)}</span>
                                <span className="activity-rt">{e.responseTimeMs}ms</span>
                            </div>
                        ))
                    )}
                </div>
            </div>

            {/* Logs Panel */}
            <div className="panel log-panel">
                <h2>Logs</h2>
                <div className="log-container" ref={logRef}>
                    {logs.length === 0 ? (
                        <div className="empty-state">No log entries</div>
                    ) : (
                        logs.map((e, i) => {
                            const ts = e.timestamp ? e.timestamp.slice(11, 19) : "";
                            const lvl = e.level || "info";
                            const extras = Object.keys(e)
                                .filter((k) => !["timestamp", "level", "message"].includes(k))
                                .map((k) => `${k}=${JSON.stringify(e[k])}`)
                                .join(" ");
                            return (
                                <div className="log-entry" key={i}>
                                    <span className="log-ts">{ts}</span>{" "}
                                    <span className={`log-level ${lvl}`}>{lvl.toUpperCase()}</span>{" "}
                                    <span className="log-msg">{e.message}</span>
                                    {extras && <> <span className="log-ts">{extras}</span></>}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
}
