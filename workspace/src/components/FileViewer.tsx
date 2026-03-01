import { useState, useEffect, useMemo } from "react";
import { marked } from "marked";
import { fetchFile } from "../api";

interface FileViewerProps {
    path: string;
    onBack: () => void;
    onWikiLink: (target: string) => void;
}

export default function FileViewer({ path, onBack, onWikiLink }: FileViewerProps) {
    const [content, setContent] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);

        fetchFile(path)
            .then((res) => {
                if (!cancelled) {
                    setContent(res.content);
                    setLoading(false);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(err.message || "Failed to load file");
                    setLoading(false);
                }
            });

        return () => { cancelled = true; };
    }, [path]);

    const isMarkdown = path.endsWith(".md");

    const renderedHtml = useMemo(() => {
        if (!content || !isMarkdown) return "";

        // Replace wiki-links with clickable spans before markdown parsing
        const withWikiLinks = content.replace(
            /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
            (_match, target, display) => {
                const label = display || target;
                return `<a class="wiki-link" data-wiki-target="${encodeURIComponent(target)}">${label}</a>`;
            }
        );

        return marked.parse(withWikiLinks) as string;
    }, [content, isMarkdown]);

    const handleClick = (e: React.MouseEvent) => {
        const target = (e.target as HTMLElement).closest(".wiki-link") as HTMLElement | null;
        if (target) {
            e.preventDefault();
            const wikiTarget = decodeURIComponent(target.getAttribute("data-wiki-target") || "");
            if (wikiTarget) {
                onWikiLink(wikiTarget);
            }
        }
    };

    if (loading) {
        return (
            <div className="file-viewer">
                <div className="file-breadcrumb">
                    <button className="back-btn" onClick={onBack}>← Back</button>
                    <span className="file-path">{path}</span>
                </div>
                <div className="empty-state">Loading…</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="file-viewer">
                <div className="file-breadcrumb">
                    <button className="back-btn" onClick={onBack}>← Back</button>
                    <span className="file-path">{path}</span>
                </div>
                <div className="empty-state">Error: {error}</div>
            </div>
        );
    }

    return (
        <div className="file-viewer">
            <div className="file-breadcrumb">
                <button className="back-btn" onClick={onBack}>← Back</button>
                <span className="file-path">{path}</span>
            </div>
            {isMarkdown ? (
                <div
                    className="markdown-body"
                    dangerouslySetInnerHTML={{ __html: renderedHtml }}
                    onClick={handleClick}
                />
            ) : (
                <pre className="file-content-pre">{content}</pre>
            )}
        </div>
    );
}
