import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import type { Config, ConfigDiff } from "./types.js";
import { loadConfig, diffConfig } from "./config.js";
import * as logger from "./logger.js";

const DEBOUNCE_MS = 300;

export interface ConfigWatcherEvents {
    reload: [config: Config, diff: ConfigDiff];
    error: [error: Error];
}

export class ConfigWatcher extends EventEmitter<ConfigWatcherEvents> {
    private configPath: string;
    private currentConfig: Config;
    private watcher: FSWatcher | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(configPath: string, initialConfig: Config) {
        super();
        this.configPath = configPath;
        this.currentConfig = initialConfig;
    }

    /** Start watching the config file for changes */
    start(): void {
        if (this.watcher) return;

        try {
            this.watcher = watch(this.configPath, (_eventType) => {
                this.debouncedReload();
            });
            logger.info("Config watcher started", { path: this.configPath });
        } catch (err) {
            logger.error("Failed to start config watcher", {
                path: this.configPath,
                error: String(err),
            });
        }
    }

    /** Stop watching */
    stop(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
            logger.info("Config watcher stopped");
        }
    }

    /** Get the current active config */
    getCurrentConfig(): Config {
        return this.currentConfig;
    }

    /** Manually trigger a config reload (used by HTTP API and bot commands after writing) */
    reloadFromDisk(): void {
        this.doReload();
    }

    /** Update the current config in memory (for hot-reloadable changes applied externally) */
    setCurrentConfig(config: Config): void {
        this.currentConfig = config;
    }

    private debouncedReload(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.doReload();
        }, DEBOUNCE_MS);
    }

    private doReload(): void {
        try {
            const newConfig = loadConfig(this.configPath);
            const diff = diffConfig(this.currentConfig, newConfig);

            if (diff.changes.length === 0) {
                logger.info("Config reloaded, no changes detected");
                return;
            }

            const oldConfig = this.currentConfig;
            this.currentConfig = newConfig;

            // Log what changed
            for (const change of diff.changes) {
                if (change.hotReloadable) {
                    logger.info("Config change (hot-reloadable)", {
                        section: change.section,
                        key: change.key,
                    });
                } else {
                    logger.warn("Config change requires restart", {
                        section: change.section,
                        key: change.key,
                    });
                }
            }

            this.emit("reload", newConfig, diff);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            logger.error("Config reload failed, keeping old config", {
                error: error.message,
            });
            this.emit("error", error);
        }
    }
}
