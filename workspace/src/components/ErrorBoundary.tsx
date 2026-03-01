import { Component, type ReactNode } from "react";

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false, error: null };

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        console.error("ErrorBoundary caught:", error, info.componentStack);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100vh",
                    background: "#0a0a0a",
                    color: "#e0e0e0",
                    fontFamily: "system-ui, sans-serif",
                    gap: "1rem",
                    padding: "2rem",
                    textAlign: "center",
                }}>
                    <h2 style={{ color: "#ff6b6b", margin: 0 }}>Something went wrong</h2>
                    <p style={{ color: "#888", maxWidth: "480px" }}>
                        {this.state.error?.message || "An unexpected error occurred."}
                    </p>
                    <button
                        onClick={() => window.location.reload()}
                        style={{
                            padding: "0.5rem 1.5rem",
                            background: "#2a2a2a",
                            color: "#e0e0e0",
                            border: "1px solid #444",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontSize: "0.9rem",
                        }}
                    >
                        Reload
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
