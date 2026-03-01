#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── Types ──────────────────────────────────────────────────

interface Config {
    name: string;
    apiKey: string;
    serverToken: string;
    mode: "docker" | "native";
    domain: string;
    discord: boolean;
    discordToken: string;
    allowedUser: string;
}

interface Flags {
    name?: string;
    docker?: boolean;
    domain?: string;
    discord?: boolean;
    matrix?: boolean;
}

// ── Argument parsing ───────────────────────────────────────

function parseArgs(argv: string[]): Flags {
    const args = argv.slice(2);
    const flags: Flags = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--docker") {
            flags.docker = true;
        } else if (arg === "--no-docker") {
            flags.docker = false;
        } else if (arg === "--domain" && i + 1 < args.length) {
            flags.domain = args[++i];
        } else if (arg === "--discord") {
            flags.discord = true;
        } else if (arg === "--matrix") {
            flags.matrix = true;
        } else if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        } else if (!arg.startsWith("-") && !flags.name) {
            flags.name = arg;
        }
    }

    return flags;
}

function printUsage(): void {
    console.log(`
Usage: create-nest <name> [flags]

Create a new Nest agent deployment.

Arguments:
  name              Project directory name (required)

Flags:
  --docker          Use Docker deployment (default)
  --no-docker       Use native deployment
  --domain <domain> Domain for HTTPS (enables Caddy)
  --discord         Enable Discord integration
  --help, -h        Show this help
`);
}

// ── Prompts ────────────────────────────────────────────────

function createInterface(): readline.Interface {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
    });
}

function askMasked(rl: readline.Interface, question: string): Promise<string> {
    return new Promise((resolve) => {
        // Close the normal interface temporarily so we can control raw mode
        const stdout = process.stdout;
        stdout.write(question);

        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        if (stdin.isTTY) {
            stdin.setRawMode(true);
        }
        stdin.resume();

        let input = "";

        const onData = (data: Buffer): void => {
            const char = data.toString();

            if (char === "\n" || char === "\r" || char === "\r\n") {
                // Enter pressed
                stdin.removeListener("data", onData);
                if (stdin.isTTY) {
                    stdin.setRawMode(wasRaw ?? false);
                }
                stdout.write("\n");
                resolve(input.trim());
            } else if (char === "\u0003") {
                // Ctrl+C
                stdout.write("\n");
                process.exit(1);
            } else if (char === "\u007f" || char === "\b") {
                // Backspace
                if (input.length > 0) {
                    input = input.slice(0, -1);
                    stdout.write("\b \b");
                }
            } else if (char.length === 1 && char >= " ") {
                input += char;
                stdout.write("*");
            }
        };

        stdin.on("data", onData);
    });
}

async function collectConfig(flags: Flags): Promise<Config> {
    const rl = createInterface();

    try {
        // Project name (required, already parsed from args)
        const name = flags.name ?? await ask(rl, "Project name: ");
        if (!name) {
            console.error("Error: project name is required");
            process.exit(1);
        }

        // Validate name
        if (/[/\\<>:"|?*]/.test(name) || name.startsWith(".")) {
            console.error("Error: invalid project name");
            process.exit(1);
        }

        // API key (required, masked)
        rl.close();
        const apiKey = await askMasked(createInterface(), "Enter your Anthropic API key: ");
        if (!apiKey) {
            console.error("Error: API key is required");
            process.exit(1);
        }

        const rl2 = createInterface();

        // Deployment mode
        let mode: "docker" | "native";
        if (flags.docker === true) {
            mode = "docker";
        } else if (flags.docker === false) {
            mode = "native";
        } else {
            const modeAnswer = await ask(rl2, "Deployment mode? (docker/native) [docker]: ");
            mode = modeAnswer === "native" ? "native" : "docker";
        }

        // Domain (only for docker mode)
        let domain = "localhost";
        if (mode === "docker") {
            if (flags.domain) {
                domain = flags.domain;
            } else {
                const domainAnswer = await ask(rl2, "Domain for HTTPS (leave empty for local only): ");
                if (domainAnswer) {
                    domain = domainAnswer;
                }
            }
        }

        // Discord
        let discord = flags.discord ?? false;
        let discordToken = "";
        if (!flags.discord) {
            const discordAnswer = await ask(rl2, "Enable Discord? (y/N): ");
            discord = discordAnswer.toLowerCase() === "y";
        }
        if (discord) {
            rl2.close();
            discordToken = await askMasked(createInterface(), "Enter Discord bot token: ");
            const rl3 = createInterface();
            const allowedUser = await ask(rl3, "Your username (for security allowlist): ");
            const serverToken = crypto.randomBytes(32).toString("hex");
            rl3.close();

            return {
                name, apiKey, serverToken, mode, domain,
                discord, discordToken, allowedUser,
            };
        }

        // Allowed user
        const allowedUser = await ask(rl2, "Your username (for security allowlist): ");

        // Generate server token
        const serverToken = crypto.randomBytes(32).toString("hex");

        rl2.close();

        return {
            name, apiKey, serverToken, mode, domain,
            discord, discordToken, allowedUser,
        };
    } catch {
        rl.close();
        throw new Error("Prompt cancelled");
    }
}

// ── Template processing ────────────────────────────────────

function fillTemplate(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replaceAll(`{{${key}}}`, value);
    }
    return result;
}

function getScaffoldDir(): string {
    const thisFile = fileURLToPath(import.meta.url);
    const thisDir = path.dirname(thisFile);
    // When running from dist/, scaffold is at ../scaffold/
    // When running from src/, scaffold is at ../scaffold/
    const scaffoldDir = path.resolve(thisDir, "..", "scaffold");
    if (fs.existsSync(scaffoldDir)) {
        return scaffoldDir;
    }
    // Fallback: check two levels up (for npx installs)
    const alt = path.resolve(thisDir, "..", "..", "scaffold");
    if (fs.existsSync(alt)) {
        return alt;
    }
    throw new Error(`Cannot find scaffold templates at ${scaffoldDir}`);
}

// ── Scaffold logic ─────────────────────────────────────────

function scaffold(config: Config): void {
    const projectDir = path.resolve(process.cwd(), config.name);

    // Check if directory already exists
    if (fs.existsSync(projectDir)) {
        console.error(`Error: directory '${config.name}' already exists`);
        process.exit(1);
    }

    const scaffoldDir = getScaffoldDir();
    const isDocker = config.mode === "docker";
    const hasDomain = config.domain !== "localhost";

    // Template variables
    const vars: Record<string, string> = {
        API_KEY: config.apiKey,
        SERVER_TOKEN: config.serverToken,
        DOMAIN: config.domain,
        PI_CWD: isDocker ? "/home/agent" : path.resolve(projectDir, "vault"),
        VAULT_PATH: isDocker ? "/vault" : "./vault",
        ALLOWED_USER: config.allowedUser,
    };

    // 1. Create project directory
    fs.mkdirSync(projectDir, { recursive: true });

    // 2. Create vault with welcome.md
    const vaultDir = path.join(projectDir, "vault");
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.copyFileSync(
        path.join(scaffoldDir, "vault", "welcome.md"),
        path.join(vaultDir, "welcome.md"),
    );

    // 3. Process and write config.yaml
    let configTemplate = fs.readFileSync(
        path.join(scaffoldDir, "config.template.yaml"),
        "utf-8",
    );

    // If Discord enabled, uncomment the discord section
    if (config.discord) {
        configTemplate = configTemplate.replace(
            "# Uncomment to enable Discord:\n# discord:\n#     token: \"env:DISCORD_TOKEN\"",
            "discord:\n    token: \"env:DISCORD_TOKEN\"",
        );
    }

    fs.writeFileSync(
        path.join(projectDir, "config.yaml"),
        fillTemplate(configTemplate, vars),
    );

    // 4. Process and write .env
    let envTemplate = fs.readFileSync(
        path.join(scaffoldDir, "env.template"),
        "utf-8",
    );

    // If Discord enabled, uncomment the discord token line and fill it
    if (config.discord && config.discordToken) {
        envTemplate = envTemplate.replace(
            "# DISCORD_TOKEN=your-discord-bot-token",
            `DISCORD_TOKEN=${config.discordToken}`,
        );
    }

    fs.writeFileSync(
        path.join(projectDir, ".env"),
        fillTemplate(envTemplate, vars),
    );

    // 5. Process docker-compose (docker mode only)
    if (isDocker) {
        let composeTemplate = fs.readFileSync(
            path.join(scaffoldDir, "docker-compose.template.yml"),
            "utf-8",
        );

        // If domain provided, uncomment the Caddy sidecar
        if (hasDomain) {
            composeTemplate = composeTemplate
                // Remove comment markers from Caddy service
                .replace(
                    /    # caddy:\n    #     image/,
                    "    caddy:\n        image",
                )
                .replace(
                    /    #     restart: unless-stopped\n    #     ports:\n    #         - "80:80"\n    #         - "443:443"\n    #     volumes:\n    #         - .\/Caddyfile:\/etc\/caddy\/Caddyfile:ro\n    #         - caddy-data:\/data\n    #         - caddy-config:\/config\n    #     networks:\n    #         - isolated/,
                    '        restart: unless-stopped\n        ports:\n            - "80:80"\n            - "443:443"\n        volumes:\n            - ./Caddyfile:/etc/caddy/Caddyfile:ro\n            - caddy-data:/data\n            - caddy-config:/config\n        networks:\n            - isolated',
                )
                // Uncomment caddy volumes
                .replace("    # caddy-data:", "    caddy-data:")
                .replace("    # caddy-config:", "    caddy-config:");
        }

        fs.writeFileSync(
            path.join(projectDir, "docker-compose.yml"),
            composeTemplate,
        );
    }

    // 6. Process Caddyfile (if domain is set)
    if (isDocker && hasDomain) {
        const caddyTemplate = fs.readFileSync(
            path.join(scaffoldDir, "Caddyfile.template"),
            "utf-8",
        );
        fs.writeFileSync(
            path.join(projectDir, "Caddyfile"),
            fillTemplate(caddyTemplate, vars),
        );
    }

    // 7. Generate .gitignore
    fs.writeFileSync(
        path.join(projectDir, ".gitignore"),
        ".env\nnode_modules/\n",
    );

    // 8. Init git repo
    try {
        execSync("git init", { cwd: projectDir, stdio: "pipe" });
        execSync("git add .", { cwd: projectDir, stdio: "pipe" });
        execSync('git commit -m "Initial nest setup"', {
            cwd: projectDir,
            stdio: "pipe",
        });
    } catch {
        // Git init is best-effort — don't fail if git isn't installed
        console.log("Note: git init skipped (git not available)");
    }

    // 9. Print success message
    printSuccess(config);
}

// ── Output ─────────────────────────────────────────────────

function printSuccess(config: Config): void {
    const isDocker = config.mode === "docker";
    const hasDomain = config.domain !== "localhost";

    console.log(`
✅ Nest created in ./${config.name}/

Next steps:`);

    if (isDocker) {
        console.log(`  cd ${config.name}
  docker compose up -d`);
    } else {
        console.log(`  cd ${config.name}
  npm install
  npm start`);
    }

    const url = hasDomain
        ? `https://${config.domain}`
        : "http://localhost:8484";

    console.log(`
Web workspace: ${url}
Token: ${config.serverToken}

Paste the token into the workspace to connect.
Keep it safe — it's your only authentication.
`);
}

// ── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("🪺 create-nest\n");

    const flags = parseArgs(process.argv);
    const config = await collectConfig(flags);
    scaffold(config);
}

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
