import type { ExtensionRegistry } from "./registry";
import type { Disposable } from "./types";
import { getToken } from "../api";

export interface NestAPI {
    toolbar: {
        addButton(config: {
            id: string;
            label: string;
            title?: string;
            onClick: () => void;
            order?: number;
        }): Disposable;
    };
    sidebar: {
        addSection(config: {
            id: string;
            title: string;
            order?: number;
            render: (container: HTMLElement) => (() => void) | void;
        }): Disposable;
    };
    dashboard: {
        addPanel(config: {
            id: string;
            title: string;
            order?: number;
            render: (container: HTMLElement) => (() => void) | void;
        }): Disposable;
        removePanel(id: string): void;
        restorePanel(id: string): void;
    };
    views: {
        register(config: {
            id: string;
            title: string;
            render: (container: HTMLElement) => (() => void) | void;
        }): Disposable;
        navigate(viewId: string): void;
    };
    files: {
        registerViewer(config: {
            id: string;
            extensions?: string[];
            match?: (path: string) => boolean;
            render: (container: HTMLElement, context: {
                content: string;
                path: string;
                root: string;
            }) => (() => void) | void;
        }): Disposable;
        registerAction(config: {
            id: string;
            label: string;
            icon?: string;
            filter?: (path: string) => boolean;
            onClick: (path: string, root: string) => void;
        }): Disposable;
    };
    styles: {
        inject(css: string): Disposable;
        getTheme(): Record<string, string>;
    };
    api: {
        fetch(path: string, init?: RequestInit): Promise<Response>;
        fetchFile(root: string, path: string): Promise<{ content: string }>;
        saveFile(root: string, path: string, content: string): Promise<void>;
    };
    on(event: string, handler: (...args: unknown[]) => void): Disposable;
    state: {
        get(key: string): unknown;
        set(key: string, value: unknown): void;
    };
}

/** Navigate callback — set by the React layer so extensions can trigger view navigation */
let navigateCallback: ((viewId: string) => void) | null = null;

export function setNavigateCallback(cb: (viewId: string) => void): void {
    navigateCallback = cb;
}

export function createNestAPI(registry: ExtensionRegistry, extensionId: string): NestAPI {
    const statePrefix = `nest-ext-${extensionId}-`;
    let styleCounter = 0;

    return {
        toolbar: {
            addButton(config) {
                return registry.addToolbarButton({ ...config, id: `${extensionId}:${config.id}` });
            },
        },

        sidebar: {
            addSection(config) {
                return registry.addSidebarSection({ ...config, id: `${extensionId}:${config.id}` });
            },
        },

        dashboard: {
            addPanel(config) {
                return registry.addDashboardPanel({ ...config, id: `${extensionId}:${config.id}` });
            },
            removePanel(id: string) {
                registry.removePanel(id);
            },
            restorePanel(id: string) {
                registry.restorePanel(id);
            },
        },

        views: {
            register(config) {
                return registry.registerView({ ...config, id: `${extensionId}:${config.id}` });
            },
            navigate(viewId: string) {
                if (navigateCallback) navigateCallback(viewId);
            },
        },

        files: {
            registerViewer(config) {
                return registry.registerFileViewer({ ...config, id: `${extensionId}:${config.id}` });
            },
            registerAction(config) {
                return registry.registerFileAction({ ...config, id: `${extensionId}:${config.id}` });
            },
        },

        styles: {
            inject(css: string) {
                const id = `${extensionId}:style-${styleCounter++}`;
                return registry.injectStyle(id, css);
            },
            getTheme() {
                const styles = getComputedStyle(document.documentElement);
                const theme: Record<string, string> = {};
                for (const prop of [
                    "--bg", "--bg-secondary", "--bg-tertiary",
                    "--text", "--text-muted", "--border",
                    "--green", "--yellow", "--orange", "--red", "--blue",
                    "--accent", "--accent-hover",
                ]) {
                    theme[prop] = styles.getPropertyValue(prop).trim();
                }
                return theme;
            },
        },

        api: {
            async fetch(path: string, init?: RequestInit): Promise<Response> {
                const token = getToken();
                return globalThis.fetch(path, {
                    ...init,
                    headers: {
                        ...init?.headers,
                        Authorization: `Bearer ${token}`,
                    },
                });
            },
            async fetchFile(root: string, path: string): Promise<{ content: string }> {
                const token = getToken();
                const encoded = path.split("/").map(encodeURIComponent).join("/");
                const res = await globalThis.fetch(
                    `/api/files/${encodeURIComponent(root)}/${encoded}`,
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            },
            async saveFile(root: string, path: string, content: string): Promise<void> {
                const token = getToken();
                const encoded = path.split("/").map(encodeURIComponent).join("/");
                const res = await globalThis.fetch(
                    `/api/files/${encodeURIComponent(root)}/${encoded}`,
                    {
                        method: "PUT",
                        headers: {
                            Authorization: `Bearer ${token}`,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({ content }),
                    }
                );
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            },
        },

        on(event: string, handler: (...args: unknown[]) => void): Disposable {
            const listener = (e: Event) => {
                handler(...(e instanceof CustomEvent ? [e.detail] : []));
            };
            registry.addEventListener(event, listener);
            return {
                dispose: () => registry.removeEventListener(event, listener),
            };
        },

        state: {
            get(key: string): unknown {
                const raw = localStorage.getItem(statePrefix + key);
                if (raw === null) return undefined;
                try { return JSON.parse(raw); } catch { return raw; }
            },
            set(key: string, value: unknown): void {
                localStorage.setItem(statePrefix + key, JSON.stringify(value));
            },
        },
    };
}
