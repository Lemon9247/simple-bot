import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import FileBrowser from "./FileBrowser";
import Dashboard from "./Dashboard";
import FileViewer from "./FileViewer";
import Chat from "./Chat";
import { fetchFile } from "../api";

const Canvas = lazy(() => import("./Canvas"));

export default function Layout() {
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [chatOpen, setChatOpen] = useState(true);
    const [mobileOverlay, setMobileOverlay] = useState<"sidebar" | "chat" | null>(null);
    const [isMobile, setIsMobile] = useState(
        typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches
    );

    // Canvas state for .excalidraw files
    const [canvasData, setCanvasData] = useState<string | null>(null);
    const [canvasLoading, setCanvasLoading] = useState(false);
    const [canvasError, setCanvasError] = useState<string | null>(null);

    const isExcalidraw = selectedFile?.toLowerCase().endsWith(".excalidraw") ?? false;

    // Track dirty state from FileViewer / Canvas
    const dirtyRef = useRef(false);

    useEffect(() => {
        const mediaQuery = window.matchMedia("(max-width: 768px)");
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mediaQuery.addEventListener("change", handler);
        return () => mediaQuery.removeEventListener("change", handler);
    }, []);

    // Load .excalidraw file content when selected
    useEffect(() => {
        if (!selectedFile || !selectedFile.toLowerCase().endsWith(".excalidraw")) {
            setCanvasData(null);
            setCanvasError(null);
            return;
        }

        let cancelled = false;
        setCanvasLoading(true);
        setCanvasError(null);

        fetchFile(selectedFile)
            .then((res) => {
                if (!cancelled) {
                    setCanvasData(res.content);
                    setCanvasLoading(false);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setCanvasError(err.message || "Failed to load drawing");
                    setCanvasLoading(false);
                }
            });

        return () => { cancelled = true; };
    }, [selectedFile]);

    const confirmIfDirty = useCallback((): boolean => {
        if (!dirtyRef.current) return true;
        return window.confirm("You have unsaved changes. Discard?");
    }, []);

    const handleFileSelect = useCallback((path: string) => {
        if (path === selectedFile) return;
        if (!confirmIfDirty()) return;
        dirtyRef.current = false;
        setSelectedFile(path);
        if (isMobile) setMobileOverlay(null);
    }, [selectedFile, confirmIfDirty, isMobile]);

    const handleBack = useCallback(() => {
        if (!confirmIfDirty()) return;
        dirtyRef.current = false;
        setSelectedFile(null);
    }, [confirmIfDirty]);

    const handleWikiLink = useCallback((target: string) => {
        if (!confirmIfDirty()) return;
        dirtyRef.current = false;
        const path = target.endsWith(".md") ? target : `${target}.md`;
        setSelectedFile(path);
    }, [confirmIfDirty]);

    const handleDirtyChange = useCallback((dirty: boolean) => {
        dirtyRef.current = dirty;
    }, []);

    const handleFileCreated = useCallback((path: string) => {
        if (!confirmIfDirty()) return;
        dirtyRef.current = false;
        setSelectedFile(path);
    }, [confirmIfDirty]);

    const handleFileDeleted = useCallback((path: string) => {
        if (selectedFile === path) {
            dirtyRef.current = false;
            setSelectedFile(null);
        }
    }, [selectedFile]);

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
                            onFileCreated={handleFileCreated}
                            onFileDeleted={handleFileDeleted}
                        />
                    </div>
                )}

                {/* Main content */}
                <div className={`content ${isExcalidraw ? "content-canvas" : ""}`}>
                    {isExcalidraw && selectedFile ? (
                        canvasLoading ? (
                            <div className="content-inner">
                                <div className="empty-state">Loading drawing…</div>
                            </div>
                        ) : canvasError ? (
                            <div className="content-inner">
                                <div className="empty-state">Error: {canvasError}</div>
                            </div>
                        ) : canvasData !== null ? (
                            <Suspense fallback={
                                <div className="content-inner">
                                    <div className="empty-state">Loading canvas…</div>
                                </div>
                            }>
                                <Canvas
                                    key={selectedFile}
                                    initialData={canvasData}
                                    filePath={selectedFile}
                                    onDirtyChange={handleDirtyChange}
                                />
                            </Suspense>
                        ) : null
                    ) : (
                        <div className="content-inner">
                            {selectedFile ? (
                                <FileViewer
                                    path={selectedFile}
                                    onBack={handleBack}
                                    onWikiLink={handleWikiLink}
                                    onDirtyChange={handleDirtyChange}
                                />
                            ) : (
                                <Dashboard />
                            )}
                        </div>
                    )}
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
