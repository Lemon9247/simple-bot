import { useState, useEffect, useCallback } from "react";
import { fetchFiles } from "../api";
import type { VaultFileEntry } from "../api";

interface FileBrowserProps {
    selectedFile: string | null;
    onFileSelect: (path: string) => void;
}

export default function FileBrowser({ selectedFile, onFileSelect }: FileBrowserProps) {
    const [entries, setEntries] = useState<VaultFileEntry[]>([]);
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);

    const loadFiles = useCallback(async (searchQuery?: string) => {
        setLoading(true);
        try {
            const res = await fetchFiles(undefined, searchQuery || undefined);
            setEntries(res.entries || []);
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadFiles();
    }, [loadFiles]);

    useEffect(() => {
        const timeout = setTimeout(() => {
            loadFiles(search);
        }, 300);
        return () => clearTimeout(timeout);
    }, [search, loadFiles]);

    const toggleDir = (path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    };

    const renderEntry = (entry: VaultFileEntry, depth: number): React.ReactNode => {
        const isDir = entry.type === "dir";
        const isExpanded = expanded.has(entry.path);

        return (
            <div key={entry.path}>
                <div
                    className={`tree-item ${selectedFile === entry.path ? "selected" : ""}`}
                    style={{ "--depth": depth } as React.CSSProperties}
                    onClick={() => {
                        if (isDir) {
                            toggleDir(entry.path);
                        } else {
                            onFileSelect(entry.path);
                        }
                    }}
                >
                    <span className={`tree-icon ${isDir ? "dir" : ""}`}>
                        {isDir ? (isExpanded ? "▼" : "▶") : "📄"}
                    </span>
                    <span className="tree-name">{entry.name}</span>
                </div>
                {isDir && isExpanded && entry.children && (
                    entry.children.map((child) => renderEntry(child, depth + 1))
                )}
            </div>
        );
    };

    return (
        <>
            <div className="sidebar-header">
                <input
                    className="sidebar-search"
                    type="text"
                    placeholder="Search files…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
            </div>
            <div className="file-tree">
                {loading && entries.length === 0 ? (
                    <div className="empty-state">Loading…</div>
                ) : entries.length === 0 ? (
                    <div className="empty-state">No files found</div>
                ) : (
                    entries.map((entry) => renderEntry(entry, 0))
                )}
            </div>
        </>
    );
}
