import { loadConfig } from "./config.js";
import { Daemon } from "./daemon.js";
import * as logger from "./logger.js";

const configPath = process.argv[2] ?? "config.yaml";
const config = loadConfig(configPath);
const daemon = new Daemon(config);

const shutdown = () => {
    daemon.stop().then(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

daemon.start().catch((err) => {
    logger.error("Failed to start", { error: String(err) });
    process.exit(1);
});
