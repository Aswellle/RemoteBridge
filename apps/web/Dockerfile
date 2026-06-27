# Multi-stage build for the RemoteBridge web client (@remotebridge/web),
# using Next.js `output: 'standalone'`. Build from the monorepo root:
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://your-domain.com/api/v1 \
#     --build-arg NEXT_PUBLIC_WS_URL=wss://your-domain.com/ws .

FROM node:26-bookworm-slim AS base
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

# 创建非 root 运行用户
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000

USER nextjs

# 健康检查：Next.js 启动后 / 路由应返回 < 500
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
