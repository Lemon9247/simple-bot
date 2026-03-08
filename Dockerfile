# ─── Nest: sandboxed agent gateway ───────────────────────────
# Multi-stage build: compile TypeScript, then run in a nix-enabled container.
# Nix is available for the agent to install arbitrary dependencies.

# ─── Stage 1: Build ─────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx tsc

# ─── Stage 2: Runtime ───────────────────────────────────────
FROM nixos/nix:latest AS runtime

# Install node + core tools in the nix environment
RUN nix-channel --update && \
    nix-env -iA nixpkgs.nodejs_22 nixpkgs.git nixpkgs.openssh nixpkgs.curl \
            nixpkgs.iproute2 nixpkgs.iptables nixpkgs.util-linux

WORKDIR /app

# Copy built nest from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/plugins ./plugins

# Entrypoint: LAN isolation + capability drop
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8484/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/cli.js", "start", "--config", "/config/config.yaml"]
