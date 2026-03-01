import { useState, useEffect, useCallback } from "react";
import { getToken, setToken, extractHashToken, fetchPing } from "../api";

interface AuthProps {
    onAuthenticated: () => void;
}

export default function Auth({ onAuthenticated }: AuthProps) {
    const [input, setInput] = useState("");
    const [error, setError] = useState("");
    const [checking, setChecking] = useState(false);

    const tryConnect = useCallback(async () => {
        const token = getToken();
        if (!token) return;
        setChecking(true);
        setError("");
        try {
            const res = await fetchPing();
            if (res.pong) {
                onAuthenticated();
            }
        } catch {
            setError("Authentication failed");
        } finally {
            setChecking(false);
        }
    }, [onAuthenticated]);

    useEffect(() => {
        // Check hash fragment first
        const hashToken = extractHashToken();
        if (hashToken) {
            tryConnect();
            return;
        }
        // Then check sessionStorage
        if (getToken()) {
            setInput("••••••••");
            tryConnect();
        }
    }, [tryConnect]);

    const handleConnect = () => {
        const val = input.trim();
        if (val && val !== "••••••••") {
            setToken(val);
        }
        tryConnect();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") handleConnect();
    };

    return (
        <div className="auth-screen">
            <h1><span>nest</span> workspace</h1>
            <div className="auth-form">
                <input
                    type="password"
                    placeholder="API token (or use /#token=xxx)"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    autoFocus
                />
                <button onClick={handleConnect} disabled={checking}>
                    {checking ? "Connecting…" : "Connect"}
                </button>
            </div>
            {error && <div className="auth-error">{error}</div>}
        </div>
    );
}
