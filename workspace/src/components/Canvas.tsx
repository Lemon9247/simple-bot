import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Excalidraw, serializeAsJSON, THEME } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { putFile } from "../api";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

interface CanvasProps {
    initialData: string;
    filePath: string;
    onDirtyChange?: (dirty: boolean) => void;
}

type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "error";

/** Debounce delay for auto-save (ms) */
const SAVE_DEBOUNCE = 2000;

export default function Canvas({ initialData, filePath, onDirtyChange }: CanvasProps) {
    const [saveStatus, setSaveStatus] = useState<SaveStatus>("clean");
    const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savingRef = useRef(false);
    const pendingRef = useRef(false);
    const filePathRef = useRef(filePath);
    const abortRef = useRef(false);
    const lastElementsHashRef = useRef("");

    // Keep filePath ref current
    useEffect(() => {
        filePathRef.current = filePath;
    }, [filePath]);

    // Notify parent of dirty state
    useEffect(() => {
        onDirtyChange?.(saveStatus === "dirty");
    }, [saveStatus, onDirtyChange]);

    // Cleanup timers on unmount; abort in-flight saves
    useEffect(() => {
        abortRef.current = false;
        return () => {
            abortRef.current = true;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        };
    }, []);

    // Ctrl+S to force immediate save
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                if (debounceRef.current) clearTimeout(debounceRef.current);
                doSaveRef.current();
            }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, []);

    const doSave = useCallback(async () => {
        if (!excalidrawAPI || abortRef.current) return;
        if (savingRef.current) {
            pendingRef.current = true;
            return;
        }

        savingRef.current = true;
        setSaveStatus("saving");

        try {
            const elements = excalidrawAPI.getSceneElements();
            const appState = excalidrawAPI.getAppState();
            const files = excalidrawAPI.getFiles();
            const json = serializeAsJSON(elements, appState, files, "local");

            await putFile(filePathRef.current, json);
            if (abortRef.current) return;
            setSaveStatus("saved");

            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => setSaveStatus("clean"), 2000);
        } catch {
            if (!abortRef.current) setSaveStatus("error");
        } finally {
            savingRef.current = false;
            // If a save was requested while we were saving, do it now
            if (pendingRef.current) {
                pendingRef.current = false;
                await doSave();
            }
        }
    }, [excalidrawAPI]);

    const doSaveRef = useRef(doSave);
    useEffect(() => { doSaveRef.current = doSave; }, [doSave]);

    const handleChange = useCallback((elements: readonly any[]) => {
        // Fingerprint by element count + versions to ignore appState-only changes
        // (pointer, selection, scroll) that fire onChange constantly
        const hash = elements
            .filter((e: any) => !e.isDeleted)
            .map((e: any) => `${e.id}:${e.version}`)
            .join(",");
        if (hash === lastElementsHashRef.current) return;
        lastElementsHashRef.current = hash;

        setSaveStatus("dirty");
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            doSaveRef.current();
        }, SAVE_DEBOUNCE);
    }, []); // No dependencies — stable reference

    // Parse initial data for Excalidraw
    const parsedInitial = useMemo(() => {
        try {
            const data = JSON.parse(initialData);
            const isObj = (v: unknown): v is Record<string, unknown> =>
                typeof v === "object" && v !== null && !Array.isArray(v);
            const elements = Array.isArray(data.elements) ? data.elements : [];
            // Seed the hash so opening doesn't trigger an immediate save
            lastElementsHashRef.current = elements
                .filter((e: any) => !e.isDeleted)
                .map((e: any) => `${e.id}:${e.version}`)
                .join(",");
            return {
                elements,
                appState: {
                    ...(isObj(data.appState) ? data.appState : {}),
                    viewBackgroundColor: data.appState?.viewBackgroundColor || "#0d1117",
                },
                files: isObj(data.files) ? data.files : undefined,
            };
        } catch {
            return {
                elements: [],
                appState: { viewBackgroundColor: "#0d1117" },
            };
        }
    }, [initialData]);

    const saveIndicator = () => {
        switch (saveStatus) {
            case "dirty": return <span className="canvas-save-indicator dirty">● Unsaved</span>;
            case "saving": return <span className="canvas-save-indicator saving">Saving…</span>;
            case "saved": return <span className="canvas-save-indicator saved">✓ Saved</span>;
            case "error": return <span className="canvas-save-indicator error">Save failed</span>;
            default: return null;
        }
    };

    return (
        <div className="canvas-wrapper">
            <div className="canvas-save-overlay">
                {saveIndicator()}
            </div>
            <Excalidraw
                initialData={parsedInitial}
                theme={THEME.DARK}
                onChange={handleChange}
                excalidrawAPI={(api) => setExcalidrawAPI(api)}
            />
        </div>
    );
}
