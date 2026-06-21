# Multi-stage build for the RemoteBridge Relay Server (@remotebridge/server).
# Build from the monorepo root: docker build -f apps/server/Dockerfile .

FROM node:20-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

# ---- deps: install only what @remotebridge/server needs (incl. shared) ----
FROM base AS deps
# build-essential/python3 let better-sqlite3 fall back to source compilation
# if no prebuilt binary matches this image's platform/ABI.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN pnpm install --frozen-lockfile --filter @remotebridge/server...

# ---- builder: compile shared, then server ----
FROM deps AS builder
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @remotebridge/shared build \
    && pnpm --filter @remotebridge/server build

# ---- runner: minimal runtime image ----
FROM base AS runner
ENV NODE_ENV=production
ENV RB_DATA_DIR=/data

# 创建非 root 运行用户，减小容器被攻破时的爆炸半径
RUN addgroup --system --gid 1001 relaygroup \
    && adduser --system --uid 1001 --ingroup relaygroup relayuser \
    && mkdir -p /data \
    && chown relayuser:relaygroup /data

COPY --from=builder --chown=relayuser:relaygroup /app /app
WORKDIR /app/apps/server

VOLUME ["/data"]
EXPOSE 3001

USER relayuser
CMD ["node", "dist/index.js"]
