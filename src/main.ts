import { loadConfig } from "./config.js";
import { Daemon } from "./daemon.js";
import { Bridge } from "./bridge.js";
import { SessionManager } from "./session-manager.js";
import { Scheduler } from "./scheduler.js";
import type { BridgeOptions } from "./bridge.js";
import * as logger from "./logger.js";

const configPath = process.argv[2] ?? "config.yaml";
const config = loadConfig(configPath);

// Bridge factory that injects extension flags into args
function createBridge(opts: BridgeOptions): Bridge {
    const sessionConfig = config.sessions
        ? Object.values(config.sessions).find(s => s.pi.cwd === opts.cwd)
        : undefined;
    const extensions = sessionConfig?.pi.extensions ?? config.pi.extensions;

    const args = [...(opts.args ?? ["--mode", "rpc", "--continue"])];
    if (extensions) {
        for (const ext of extensions) {
            args.push("-e", ext);
        }
    }

    return new Bridge({
        cwd: opts.cwd,
        command: opts.command,
        args,
    });
}

const sessionManager = new SessionManager(config, createBridge);
const daemon = new Daemon(config, sessionManager);

// For the scheduler, eagerly start the default session to get its bridge
if (config.cron) {
    (async () => {
        const defaultBridge = await sessionManager.getOrStartSession(
            sessionManager.getDefaultSessionName()
        );
        const scheduler = new Scheduler(
            config.cron!,
            defaultBridge,
            () => daemon.getLastUserInteractionTime()
        );
        daemon.setScheduler(scheduler);
    })().catch((err) => {
        logger.error("Failed to initialize scheduler", { error: String(err) });
    });
}

// Wire up configured listeners
if (config.matrix) {
    const { MatrixListener } = await import("./listeners/matrix.js");
    daemon.addListener(
        new MatrixListener(
            config.matrix.homeserver,
            config.matrix.user,
            config.matrix.token,
            config.matrix.storage_path,
        )
    );
}

if (config.discord) {
    const { DiscordListener } = await import("./listeners/discord.js");
    daemon.addListener(new DiscordListener(config.discord.token));
}

const shutdown = () => {
    daemon.stop().then(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

daemon.start().catch((err) => {
    logger.error("Failed to start", { error: String(err) });
    process.exit(1);
});
