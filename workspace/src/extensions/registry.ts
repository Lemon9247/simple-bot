import type {
    Disposable,
    DashboardPanelConfig,
    ToolbarButtonConfig,
    SidebarSectionConfig,
    ViewConfig,
    FileViewerConfig,
    FileActionConfig,
} from "./types";

export class ExtensionRegistry extends EventTarget {
    private panels = new Map<string, DashboardPanelConfig>();
    private buttons = new Map<string, ToolbarButtonConfig>();
    private sections = new Map<string, SidebarSectionConfig>();
    private views = new Map<string, ViewConfig>();
    private viewers = new Map<string, FileViewerConfig>();
    private actions = new Map<string, FileActionConfig>();
    private _removedPanels = new Set<string>();
    private styles = new Map<string, HTMLStyleElement>();
    private navigateCallback: ((viewId: string) => void) | null = null;

    private emit(): void {
        this.dispatchEvent(new Event("change"));
    }

    // ── Dashboard ───────────────────────────────────────────

    addDashboardPanel(config: DashboardPanelConfig): Disposable {
        this.panels.set(config.id, config);
        this.emit();
        return { dispose: () => { this.panels.delete(config.id); this.emit(); } };
    }

    getDashboardPanels(): DashboardPanelConfig[] {
        return [...this.panels.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    }

    removePanel(id: string): void {
        this._removedPanels.add(id);
        this.emit();
    }

    restorePanel(id: string): void {
        this._removedPanels.delete(id);
        this.emit();
    }

    get removedPanels(): ReadonlySet<string> {
        return this._removedPanels;
    }

    // ── Toolbar ─────────────────────────────────────────────

    addToolbarButton(config: ToolbarButtonConfig): Disposable {
        this.buttons.set(config.id, config);
        this.emit();
        return { dispose: () => { this.buttons.delete(config.id); this.emit(); } };
    }

    getToolbarButtons(): ToolbarButtonConfig[] {
        return [...this.buttons.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    }

    // ── Sidebar ─────────────────────────────────────────────

    addSidebarSection(config: SidebarSectionConfig): Disposable {
        this.sections.set(config.id, config);
        this.emit();
        return { dispose: () => { this.sections.delete(config.id); this.emit(); } };
    }

    getSidebarSections(): SidebarSectionConfig[] {
        return [...this.sections.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    }

    // ── Views ───────────────────────────────────────────────

    registerView(config: ViewConfig): Disposable {
        this.views.set(config.id, config);
        this.emit();
        return { dispose: () => { this.views.delete(config.id); this.emit(); } };
    }

    getViews(): ViewConfig[] {
        return [...this.views.values()];
    }

    getView(id: string): ViewConfig | undefined {
        return this.views.get(id);
    }

    // ── File Viewers ────────────────────────────────────────

    registerFileViewer(config: FileViewerConfig): Disposable {
        this.viewers.set(config.id, config);
        this.emit();
        return { dispose: () => { this.viewers.delete(config.id); this.emit(); } };
    }

    getFileViewer(path: string): FileViewerConfig | null {
        const ext = path.lastIndexOf(".") >= 0 ? path.slice(path.lastIndexOf(".")).toLowerCase() : "";
        for (const viewer of this.viewers.values()) {
            if (viewer.extensions && viewer.extensions.includes(ext)) return viewer;
            if (viewer.match && viewer.match(path)) return viewer;
        }
        return null;
    }

    // ── File Actions ────────────────────────────────────────

    registerFileAction(config: FileActionConfig): Disposable {
        this.actions.set(config.id, config);
        this.emit();
        return { dispose: () => { this.actions.delete(config.id); this.emit(); } };
    }

    getFileActions(path: string): FileActionConfig[] {
        if (!path) return [];
        return [...this.actions.values()].filter(
            (a) => !a.filter || a.filter(path)
        );
    }

    // ── Styles ──────────────────────────────────────────────

    injectStyle(id: string, css: string): Disposable {
        // Remove existing style with same id
        const existing = this.styles.get(id);
        if (existing) existing.remove();

        const el = document.createElement("style");
        el.dataset.extensionId = id;
        el.textContent = css;
        document.head.appendChild(el);
        this.styles.set(id, el);

        return {
            dispose: () => {
                el.remove();
                this.styles.delete(id);
            },
        };
    }

    // ── Navigation ───────────────────────────────────────────

    setNavigateCallback(cb: (viewId: string) => void): void {
        this.navigateCallback = cb;
    }

    navigate(viewId: string): void {
        if (this.navigateCallback) this.navigateCallback(viewId);
    }

    // ── Events ──────────────────────────────────────────────

    emitEvent(name: string, detail?: unknown): void {
        this.dispatchEvent(new CustomEvent(name, { detail }));
    }
}
