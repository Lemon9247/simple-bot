import { useState, useEffect } from "react";
import FileBrowser from "./FileBrowser";
import Dashboard from "./Dashboard";
import FileViewer from "./FileViewer";
import Chat from "./Chat";

export default function Layout() {
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [chatOpen, setChatOpen] = useState(true);
    const [mobileOverlay, setMobileOverlay] = useState<"sidebar" | "chat" | null>(null);
    const [isMobile, setIsMobile] = useState(
        typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches
    );

    useEffect(() => {
        const mediaQuery = window.matchMedia("(max-width: 768px)");
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mediaQuery.addEventListener("change", handler);
        return () => mediaQuery.removeEventListener("change", handler);
    }, []);

    const handleFileSelect = (path: string) => {
        setSelectedFile(path);
        if (isMobile) setMobileOverlay(null);
    };

    const handleBack = () => {
        setSelectedFile(null);
    };

    const handleWikiLink = (target: string) => {
        // Resolve wiki-link: try with .md extension
        const path = target.endsWith(".md") ? target : `${target}.md`;
        setSelectedFile(path);
    };

    const toggleSidebar = () => {
        if (isMobile) {
            setMobileOverlay(mobileOverlay === "sidebar" ? null : "sidebar");
        } else {
            setSidebarOpen(!sidebarOpen);
        }
    };

    const toggleChat = () => {
        if (isMobile) {
            setMobileOverlay(mobileOverlay === "chat" ? null : "chat");
        } else {
            setChatOpen(!chatOpen);
        }
    };

    return (
        <div className="workspace">
            <div className="top-bar">
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <button
                        className={`toggle-btn ${sidebarOpen || mobileOverlay === "sidebar" ? "active" : ""}`}
                        onClick={toggleSidebar}
                        title="Toggle file browser"
                    >
                        ☰ Files
                    </button>
                    <h1><span>nest</span></h1>
                </div>
                <div className="top-bar-right">
                    <button
                        className={`toggle-btn ${chatOpen || mobileOverlay === "chat" ? "active" : ""}`}
                        onClick={toggleChat}
                        title="Toggle chat"
                    >
                        💬 Chat
                    </button>
                </div>
            </div>

            <div className="main-area">
                {/* Sidebar */}
                {(sidebarOpen || mobileOverlay === "sidebar") && (
                    <div className={`sidebar ${mobileOverlay === "sidebar" ? "open" : ""}`}>
                        <FileBrowser
                            selectedFile={selectedFile}
                            onFileSelect={handleFileSelect}
                        />
                    </div>
                )}

                {/* Main content */}
                <div className="content">
                    <div className="content-inner">
                        {selectedFile ? (
                            <FileViewer
                                path={selectedFile}
                                onBack={handleBack}
                                onWikiLink={handleWikiLink}
                            />
                        ) : (
                            <Dashboard />
                        )}
                    </div>
                </div>

                {/* Chat */}
                {(chatOpen || mobileOverlay === "chat") && (
                    <div className={`chat-panel ${mobileOverlay === "chat" ? "open" : ""}`}>
                        <Chat />
                    </div>
                )}

                {/* Mobile overlay backdrop */}
                {mobileOverlay && (
                    <div className="overlay" onClick={() => setMobileOverlay(null)} />
                )}
            </div>
        </div>
    );
}
