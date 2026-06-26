# Review Scope

## Target

Comprehensive review of the entire RemoteBridge monorepo: a relay-server-architected remote file access system consisting of an Electron desktop "Host" agent, a Fastify relay server, a Next.js web client, and a shared protocol/security package.

## Files

### `packages/shared/src` — protocol contract (6 files)
- `index.ts`, `ws-types.ts`, `api-types.ts`, `security.ts`, `file-utils.ts`, `ws-types-preview.ts` (unused scratch, per CLAUDE.md)

### `apps/server/src` — Relay Server, Fastify + @fastify/websocket (16 files)
- `index.ts`
- `db/client.ts`, `db/schema.ts`
- `routes/auth.ts`, `routes/hosts.ts`, `routes/messages.ts`, `routes/proxy.ts`, `routes/security-logs.ts`
- `utils/cors.ts`, `utils/jwt.ts`, `utils/pin.ts`
- `ws/handler.ts`, `ws/relay.ts`, `ws/rooms.ts`, `ws/file-tunnel.ts`, `ws/pending-requests.ts`

### `apps/server/test` — vitest + manual verification scripts (8 files)
- `e2e.test.ts`
- `manual-relay-roundtrip.mjs`, `manual-host-reconnect.mjs`, `manual-file-tunnel.mjs`, `manual-message-history.mjs`, `manual-live-host.mjs`, `manual-settings-hot-reload.mjs`, `manual-trust-revoke.mjs`

### `apps/desktop/src` — Electron Host agent (28 files)
- `main/index.ts`, `main/window.ts`, `main/tray.ts`, `main/electron-binding.ts`
- `main/config/store.ts`
- `main/db/client.ts`, `main/db/schema.ts`
- `main/security/path-guard.ts`, `main/security/audit-logger.ts`
- `main/file-server/server.ts`, `main/file-server/token-manager.ts`
- `main/ws-client/client.ts`, `main/ws-client/handlers.ts`, `main/ws-client/dir-handlers.ts`, `main/ws-client/file-tunnel.ts`
- `main/ipc/auth.ts`, `main/ipc/clients.ts`, `main/ipc/dirs.ts`, `main/ipc/messages.ts`, `main/ipc/settings.ts`
- `preload/index.ts`
- `renderer/main.tsx`, `renderer/App.tsx`, `renderer/theme.ts`
- `renderer/pages/Clients.tsx`, `renderer/pages/Messages.tsx`, `renderer/pages/SecurityLogs.tsx`, `renderer/pages/Settings.tsx`

### `apps/web/src` — Next.js 14 App Router client (23 files)
- `app/layout.tsx`, `app/page.tsx`
- `app/dashboard/layout.tsx`, `app/dashboard/page.tsx`
- `app/dashboard/files/page.tsx`, `app/dashboard/messages/page.tsx`, `app/dashboard/security/page.tsx`, `app/dashboard/settings/page.tsx`
- `components/Breadcrumb.tsx`, `components/DownloadPanel.tsx`, `components/FileList.tsx`
- `components/previews/FilePreview.tsx`, `components/previews/ImageViewer.tsx`, `components/previews/PdfViewer.tsx`, `components/previews/TextViewer.tsx`, `components/previews/UnsupportedViewer.tsx`
- `components/ui/Skeleton.tsx`
- `hooks/useWebSocket.ts`, `hooks/usePreview.ts`
- `lib/api.ts`, `lib/download-manager.ts`, `lib/theme.ts`
- `store/app-store.ts`

**Total**: ~81 files, ~12,151 LOC across the 4 packages' `src/`.

## Reference docs available to agents
- `CLAUDE.md` — architecture overview, security model, protocol-routing contract, room management split (relay.ts vs rooms.ts)
- `docs/code-review-report.md` — June 2026 prior review (P0–P2 fixes already applied; some "结构性风险（遗留）" items are stale per CLAUDE.md)
- `prd.md`, `RemoteBridge-ARCHITECTURE.md` (Chinese design docs, ADRs)

## Flags

- Security Focus: no (but security model is explicitly called out as "load-bearing" in CLAUDE.md — agents should weight it heavily regardless)
- Performance Critical: no
- Strict Mode: no
- Framework: TypeScript / pnpm + Turborepo monorepo — Fastify relay server, Next.js 14 (App Router) web client, Electron 28 desktop host (React + Zustand), shared protocol package

## Review Phases

1. Code Quality & Architecture
2. Security & Performance
3. Testing & Documentation
4. Best Practices & Standards
5. Consolidated Report
