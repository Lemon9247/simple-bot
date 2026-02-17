FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22

# Core tools pi expects
RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    curl \
    wget \
    jq \
    ripgrep \
    fd-find \
    fzf \
    tree \
    less \
    vim-tiny \
    # Build essentials for working on projects
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    # Networking
    ca-certificates \
    dnsutils \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) — install via official script so it survives rebuilds
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# pi coding agent
RUN npm install -g @mariozechner/pi-coding-agent

# simple-bot
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/

ENTRYPOINT ["node", "dist/main.js"]
CMD ["/config/config.yaml"]
