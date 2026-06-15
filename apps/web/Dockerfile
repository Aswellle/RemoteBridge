# Multi-stage build for the RemoteBridge web client (@remotebridge/web),
# using Next.js `output: 'standalone'`. Build from the monorepo root:
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://your-domain.com/api/v1 \
#     --build-arg NEXT_PUBLIC_WS_URL=wss://your-domain.com/ws .

FROM node:20-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

# ---- deps: install only what @remotebridge/web needs (incl. shared) ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN pnpm install --frozen-lockfile --filter @remotebridge/web...

# ---- builder: compile shared, then build the Next.js app ----
FROM deps AS builder
# Baked into the client bundle at build time - point these at the public
# hostname that Caddy terminates TLS for (see Caddyfile / docker-compose.yml).
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @remotebridge/shared build \
    && pnpm --filter @remotebridge/web build

# ---- runner: minimal runtime image (standalone Next.js output) ----
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
