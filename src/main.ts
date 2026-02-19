import { loadConfig } from "./config.js";
import { Daemon } from "./daemon.js";
import { Bridge } from "./bridge.js";
import { Scheduler } from "./scheduler.js";
import * as logger from "./logger.js";

const configPath = process.argv[2] ?? "config.yaml";
const config = loadConfig(configPath);

// Build pi args, injecting extension flags
const piArgs = config.pi.args ?? ["--mode", "rpc", "--continue"];
if (config.pi.extensions) {
    for (const ext of config.pi.extensions) {
        piArgs.push("-e", ext);
    }
}

const bridge = new Bridge({
    cwd: config.pi.cwd,
    command: config.pi.command,
    args: piArgs,
});

const daemon = new Daemon(config, bridge);

const scheduler = config.cron
    ? new Scheduler(config.cron, bridge, () => daemon.getLastUserInteractionTime())
    : undefined;

if (scheduler) {
    daemon.setScheduler(scheduler);
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
