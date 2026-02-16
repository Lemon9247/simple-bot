FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22-slim
RUN npm install -g @mariozechner/pi-coding-agent && \
    apt-get update && apt-get install -y git && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/
USER node
ENTRYPOINT ["node", "dist/main.js"]
CMD ["/config/config.yaml"]
