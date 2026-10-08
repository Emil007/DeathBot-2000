# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
# NOTE: no inline VOLUME for /app/data. Declaring it here auto-creates an
# anonymous volume that shadows bind mounts declared in docker-compose on
# older Docker daemons (20.10), so the bot would start with a fresh empty DB.
# Data persistence belongs in the compose file (volume: ./data:/app/data).
CMD ["node", "src/index.js"]
