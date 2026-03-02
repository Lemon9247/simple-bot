// ─── Core ─────────────────────────────────────────────────────

export interface Disposable {
    dispose(): void;
}

export type RenderFn = (container: HTMLElement) => (() => void) | void;

// ─── Registration Configs ─────────────────────────────────────

export interface DashboardPanelConfig {
    id: string;
    title: string;
    order?: number;
    render: RenderFn;
}

export interface ToolbarButtonConfig {
    id: string;
    label: string;
    title?: string;
    onClick: () => void;
    order?: number;
}

export interface SidebarSectionConfig {
    id: string;
    title: string;
    order?: number;
    render: RenderFn;
}

export interface ViewConfig {
    id: string;
    title: string;
    render: RenderFn;
}

export interface FileViewerConfig {
    id: string;
    extensions?: string[];
    match?: (path: string) => boolean;
    render: (container: HTMLElement, context: {
        content: string;
        path: string;
        root: string;
    }) => (() => void) | void;
}

export interface FileActionConfig {
    id: string;
    label: string;
    icon?: string;
    filter?: (path: string) => boolean;
    onClick: (path: string, root: string) => void;
}

// ─── Manifest (mirrors server type) ──────────────────────────

export interface ExtensionManifest {
    id: string;
    name: string;
    version: number;
    entry: string;
    styles?: string;
}
