import { useState, useEffect, useRef, useCallback } from "react";
import { getToken } from "../api";

interface ChatMessage {
    id: string;
    role: "user" | "agent";
    content: string;
    streaming?: boolean;
}

// Escape HTML entities to prevent XSS
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Minimal inline markdown: bold, italic, code, code blocks
function renderInlineMarkdown(text: string): string {
    const escaped = escapeHtml(text);
    return escaped
        // Code blocks
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        // Inline code
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // Bold
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // Italic
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        // Line breaks
        .replace(/\n/g, '<br/>');
}

export default function Chat() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [connected, setConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const idCounter = useRef(0);
    const mountedRef = useRef(true);

    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [messages, scrollToBottom]);

    const connect = useCallback(() => {
        const token = getToken();
        if (!token) return;

        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${proto}//${window.location.host}/attach`);
        wsRef.current = ws;

        ws.onopen = () => {
            // Send auth as first message instead of query param
            ws.send(JSON.stringify({ type: "auth", token }));
        };

        ws.onclose = () => {
            if (!mountedRef.current) return;
            setConnected(false);
            wsRef.current = null;
            // Reconnect after 3 seconds
            reconnectTimer.current = setTimeout(connect, 3000);
        };

        ws.onerror = () => {
            ws.close();
        };

        ws.onmessage = (event) => {
            if (!mountedRef.current) return;
            try {
                const data = JSON.parse(event.data);
                if (data.type === "auth_ok") {
                    setConnected(true);
                    return;
                }
                if (data.type === "error" && !connected) {
                    // Auth failed — don't reconnect with same token
                    ws.close();
                    return;
                }
                handleWsMessage(data);
            } catch {
                // ignore malformed messages
            }
        };
    }, []);

    useEffect(() => {
        connect();
        return () => {
            mountedRef.current = false;
            clearTimeout(reconnectTimer.current);
            wsRef.current?.close();
        };
    }, [connect]);

    const handleWsMessage = (data: any) => {
        if (!mountedRef.current) return;
        if (data.type === "content_block_delta" && data.delta?.text) {
            // Streaming text delta — append to current agent message
            setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === "agent" && last.streaming) {
                    return [
                        ...prev.slice(0, -1),
                        { ...last, content: last.content + data.delta.text },
                    ];
                }
                // Start a new streaming message
                return [
                    ...prev,
                    {
                        id: `agent-${idCounter.current++}`,
                        role: "agent",
                        content: data.delta.text,
                        streaming: true,
                    },
                ];
            });
        } else if (data.type === "message_end") {
            // Finalize streaming
            setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === "agent" && last.streaming) {
                    return [...prev.slice(0, -1), { ...last, streaming: false }];
                }
                return prev;
            });
        } else if (data.type === "response" && data.id) {
            // RPC response — ignore (handled by promise in send)
        } else if (data.type === "text" || data.type === "message") {
            // Full text message from agent
            setMessages((prev) => [
                ...prev,
                {
                    id: `agent-${idCounter.current++}`,
                    role: "agent",
                    content: data.text || data.content || JSON.stringify(data),
                    streaming: false,
                },
            ]);
        }
    };

    const sendMessage = () => {
        const text = input.trim();
        if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const id = `msg-${idCounter.current++}`;

        // Add user message to chat
        setMessages((prev) => [
            ...prev,
            { id, role: "user", content: text },
        ]);

        // Send via WebSocket RPC
        wsRef.current.send(JSON.stringify({
            id,
            type: "send_message",
            text,
        }));

        setInput("");
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    return (
        <>
            <div className="chat-header">
                <span>Chat</span>
                <div className="chat-status">
                    <span className={`status-dot ${connected ? "ok" : ""}`} />
                    <span>{connected ? "Connected" : "Disconnected"}</span>
                </div>
            </div>
            <div className="chat-messages">
                {messages.length === 0 && (
                    <div className="empty-state">Send a message to start chatting</div>
                )}
                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={`chat-msg ${msg.role}`}
                        dangerouslySetInnerHTML={{
                            __html: renderInlineMarkdown(msg.content),
                        }}
                    />
                ))}
                <div ref={messagesEndRef} />
            </div>
            <div className="chat-input-area">
                <textarea
                    className="chat-input"
                    placeholder={connected ? "Type a message…" : "Connecting…"}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={!connected}
                    rows={1}
                />
                <button
                    className="chat-send-btn"
                    onClick={sendMessage}
                    disabled={!connected || !input.trim()}
                >
                    Send
                </button>
            </div>
        </>
    );
}
