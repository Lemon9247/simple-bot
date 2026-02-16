import { loadConfig } from "./config.js";
import { Daemon } from "./daemon.js";

const configPath = process.argv[2] ?? "config.yaml";
const config = loadConfig(configPath);
const daemon = new Daemon(config);

const shutdown = () => {
    daemon.stop().then(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

daemon.start().catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
});
