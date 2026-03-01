import { useRef, useEffect, useCallback } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";

interface EditorProps {
    content: string;
    onChange: (content: string) => void;
    filePath: string;
    onSave?: () => void;
    fileList?: string[];
}

/** Custom dark theme that matches nest's color scheme */
const nestTheme = EditorView.theme({
    "&": {
        backgroundColor: "#0d1117",
        color: "#e6edf3",
        fontSize: "0.88rem",
        height: "100%",
    },
    ".cm-content": {
        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        padding: "0.5rem 0",
        caretColor: "#58a6ff",
    },
    ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "#58a6ff",
    },
    ".cm-activeLine": {
        backgroundColor: "rgba(88, 166, 255, 0.06)",
    },
    ".cm-activeLineGutter": {
        backgroundColor: "rgba(88, 166, 255, 0.06)",
    },
    ".cm-gutters": {
        backgroundColor: "#161b22",
        color: "#484f58",
        border: "none",
        borderRight: "1px solid #30363d",
    },
    ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 0.5rem 0 0.25rem",
        minWidth: "2.5rem",
    },
    ".cm-selectionBackground, ::selection": {
        backgroundColor: "rgba(88, 166, 255, 0.2) !important",
    },
    ".cm-searchMatch": {
        backgroundColor: "rgba(210, 153, 34, 0.3)",
        outline: "1px solid rgba(210, 153, 34, 0.5)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "rgba(210, 153, 34, 0.5)",
    },
    ".cm-scroller": {
        overflow: "auto",
    },
    ".cm-tooltip": {
        backgroundColor: "#161b22",
        border: "1px solid #30363d",
        color: "#e6edf3",
    },
    ".cm-tooltip-autocomplete": {
        "& > ul > li[aria-selected]": {
            backgroundColor: "rgba(88, 166, 255, 0.15)",
            color: "#e6edf3",
        },
    },
    ".cm-panels": {
        backgroundColor: "#161b22",
        color: "#e6edf3",
    },
    ".cm-panels.cm-panels-top": {
        borderBottom: "1px solid #30363d",
    },
    ".cm-panel.cm-search": {
        padding: "0.35rem 0.5rem",
    },
    ".cm-panel.cm-search input, .cm-panel.cm-search button": {
        background: "#0d1117",
        border: "1px solid #30363d",
        color: "#e6edf3",
        borderRadius: "4px",
        padding: "0.15rem 0.4rem",
        fontSize: "0.82rem",
    },
    ".cm-panel.cm-search button:hover": {
        background: "#30363d",
    },
    ".cm-panel.cm-search label": {
        color: "#8b949e",
        fontSize: "0.82rem",
    },
    "&.cm-focused": {
        outline: "none",
    },
}, { dark: true });

/** Wiki-link autocomplete: triggers on [[ and suggests file paths */
function wikiLinkCompletion(fileList: string[]) {
    return (context: CompletionContext): CompletionResult | null => {
        // Look backwards for [[
        const line = context.state.doc.lineAt(context.pos);
        const textBefore = line.text.slice(0, context.pos - line.from);
        const match = textBefore.match(/\[\[([^\]|]*)$/);
        if (!match) return null;

        const query = match[1].toLowerCase();
        const from = context.pos - match[1].length;

        const options = fileList
            .filter((f) => f.endsWith(".md"))
            .map((f) => {
                // Strip .md for Obsidian-style links
                const label = f.replace(/\.md$/, "");
                return { label, apply: label + "]]" };
            })
            .filter((o) => o.label.toLowerCase().includes(query));

        return {
            from,
            options,
            filter: false,
        };
    };
}

export default function Editor({ content, onChange, filePath, onSave, fileList }: EditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);

    // Keep callback refs fresh without recreating the editor
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

    const createEditor = useCallback(() => {
        if (!containerRef.current) return;

        // Destroy previous instance
        if (viewRef.current) {
            viewRef.current.destroy();
            viewRef.current = null;
        }

        const extensions: Extension[] = [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            drawSelection(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            history(),
            highlightSelectionMatches(),
            nestTheme,
            oneDark,
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            EditorView.lineWrapping,
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    onChangeRef.current(update.state.doc.toString());
                }
            }),
            keymap.of([
                {
                    key: "Mod-s",
                    run: () => {
                        onSaveRef.current?.();
                        return true;
                    },
                },
                ...closeBracketsKeymap,
                ...defaultKeymap,
                ...searchKeymap,
                ...historyKeymap,
                indentWithTab,
            ]),
            autocompletion({
                override: fileList ? [wikiLinkCompletion(fileList)] : [],
                activateOnTyping: true,
            }),
            EditorState.tabSize.of(4),
        ];

        const state = EditorState.create({
            doc: content,
            extensions,
        });

        viewRef.current = new EditorView({
            state,
            parent: containerRef.current,
        });
    }, [filePath, fileList]);

    // Create/recreate editor when filePath changes
    useEffect(() => {
        createEditor();
        return () => {
            if (viewRef.current) {
                viewRef.current.destroy();
                viewRef.current = null;
            }
        };
    }, [createEditor]);

    // Update editor content when prop changes externally (without recreating)
    useEffect(() => {
        if (viewRef.current && content !== viewRef.current.state.doc.toString()) {
            viewRef.current.dispatch({
                changes: { from: 0, to: viewRef.current.state.doc.length, insert: content }
            });
        }
    }, [content]);

    return <div ref={containerRef} className="cm-editor-wrapper" />;
}
