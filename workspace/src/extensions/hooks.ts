import { useEffect, useReducer, useContext, createContext } from "react";
import type { ExtensionRegistry } from "./registry";
import type {
    DashboardPanelConfig,
    ToolbarButtonConfig,
    SidebarSectionConfig,
    ViewConfig,
    FileViewerConfig,
    FileActionConfig,
} from "./types";

// ── Context ─────────────────────────────────────────────────

export const ExtensionRegistryContext = createContext<ExtensionRegistry | null>(null);

export function useExtensionRegistry(): ExtensionRegistry | null {
    return useContext(ExtensionRegistryContext);
}

// ── Shared subscription hook ────────────────────────────────

/**
 * Forces a re-render whenever the registry emits "change".
 *
 * Note: all hooks share a single "change" event, so adding a toolbar button
 * will re-render dashboard panels too. Per-category events (e.g. 'dashboard-change')
 * would fix this but are overkill at current scale.
 */
function useRegistryChange(registry: ExtensionRegistry | null): void {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

    useEffect(() => {
        if (!registry) return;
        const handler = () => forceUpdate();
        registry.addEventListener("change", handler);
        return () => registry.removeEventListener("change", handler);
    }, [registry]);
}

// ── Derived hooks ───────────────────────────────────────────

export function useDashboardPanels(): {
    panels: DashboardPanelConfig[];
    removedPanels: ReadonlySet<string>;
} {
    const registry = useExtensionRegistry();
    useRegistryChange(registry);

    if (!registry) return { panels: [], removedPanels: new Set() };
    return {
        panels: registry.getDashboardPanels(),
        removedPanels: registry.removedPanels,
    };
}

export function useToolbarButtons(): ToolbarButtonConfig[] {
    const registry = useExtensionRegistry();
    useRegistryChange(registry);
    return registry?.getToolbarButtons() ?? [];
}

export function useSidebarSections(): SidebarSectionConfig[] {
    const registry = useExtensionRegistry();
    useRegistryChange(registry);
    return registry?.getSidebarSections() ?? [];
}

export function useFileViewer(path: string): FileViewerConfig | null {
    const registry = useExtensionRegistry();
    useRegistryChange(registry);
    return registry?.getFileViewer(path) ?? null;
}

export function useFileActions(path: string): FileActionConfig[] {
    const registry = useExtensionRegistry();
    useRegistryChange(registry);
    return registry?.getFileActions(path) ?? [];
}

export function useExtensionViews(): ViewConfig[] {
    const registry = useExtensionRegistry();
    useRegistryChange(registry);
    return registry?.getViews() ?? [];
}
