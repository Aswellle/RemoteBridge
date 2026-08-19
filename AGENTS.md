# Repository Guidelines

RemoteBridge is a relay-based remote file-access system. An Electron **desktop host** makes an outbound WebSocket connection to a cloud **relay server**, and a **web client** connects to the same relay — no inbound ports, no VPN, no port forwarding. Pairing is done with a short-lived 8-digit PIN.

```
Web browser  ──────►  Relay server  ◄──────  Desktop host
 (Next.js)          (Fastify + WS)         (Electron)
```

All four packages share protocol types from `@remotebridge/shared`.

---

## Architecture & Data Flow

### Packages (pnpm workspace + Turborepo)

|Package|Path|Role|
|---|---|---|
|`shared`|`packages/shared`|WS message types, REST API types, path-security utils, file-tunnel codec, JWT/rate-limit config constants|
|`server`|`apps/server`|Fastify relay — auth, routing, file proxy/tunnel, SQLite (Drizzle), security logs|
|`web`|`apps/web`|Next.js 14 App Router client — Zustand store, WS manager, file browser/download UI|
|`desktop`|`apps/desktop`|Electron 28 host — WS client to relay, local Fastify file server, auto-updater, embedded local relay|

### Connection flow

1. `POST /auth/register-host` → host row + Host JWT
2. `POST /auth/generate-pin` → 8-char PIN (bcrypt hash, 5 min TTL), shown out-of-band to user
3. `POST /auth/connect` (PIN) → client access JWT (2 h) + refresh JWT (30 d) set as **httpOnly cookies** (`rb_access`, `rb_refresh`, `SameSite=Strict`)
4. Both sides open WebSocket (`?type=host` / `?type=client`); relay routes by `sessionId` room

### File transfer

- **Download/preview:** web → relay issues `CMD_REQUEST_DOWNLOAD/PREVIEW` → host responds `RESP_*_READY` → relay hijacks HTTP reply and streams `CMD_FETCH_FILE` binary frames (256 KB chunks, backpressure, Range preserved for resume)
- **Upload (web → host):** chunked through WS relay
- **Binary framing:** non-empty chunks use self-describing binary WS frames (`file-tunnel-codec.ts`, ADR-004); empty/error stay JSON

### Security model

- Path allowlist (user config) + system-sensitive-blocklist (`security.ts`)
- One-time UUID download tokens bound to `clientId`, 30 min TTL
- Access/refresh JWTs signed with **independent** keys; refresh token has `use:'refresh'` claim (rejected on WS)
- WS auth via 30 s single-use ticket (`GET /auth/ws-ticket`) so tokens never appear in URLs (ADR `httponly-cookie-token-design.md`)
- Electron renderer: `sandbox: true`, strict CSP, sandboxed iframe for PDF preview

### State

- **Relay:** in-memory single-instance room state (`connection-registry.ts`, ADR-005); restart self-heals via reconnect
- **Web:** Zustand store (`app-store.ts`) + `electron-store`-style localStorage for session metadata and host history
- **Desktop:** `electron-store` (config) + `better-sqlite3` (download tokens, auth)

---

## Key Directories

```
packages/shared/src
  ws-types.ts            WS message type enums (WSMessageType) + payload interfaces
  ws-types-preview.ts    preview-specific message types
  file-tunnel-codec.ts   binary frame encode/decode (version, flags, transferId, seq)
  security.ts            path allowlist/blocklist validation
  api-types.ts           REST DTOs
  file-utils.ts          file-category + size helpers
apps/server/src
  index.ts               Fastify bootstrap, plugin/route registration, /health
  routes/                auth, hosts, messages, security-logs, proxy (REST API)
  ws/                    handler (WS lifecycle), relay (routing), connection-registry,
                         file-tunnel, pending-requests, tickets
  db/                    schema.ts (Drizzle), client.ts (init, retention job)
  utils/                 pin, jwt, secrets (startup validation), logger (pino), cors
apps/web/src
  store/app-store.ts     Zustand store (AppState) — central client state machine
  hooks/useWebSocket.ts  WS manager (connect, reconnect, backoff, revoke handling)
  hooks/usePreview.ts    file preview via proxy Blob URL
  lib/api.ts             axios REST client
  lib/download-manager.ts HTTP Range / resume downloader
  components/            FileList, DownloadPanel, Breadcrumb, previews/
apps/desktop/src
  main/index.ts          Electron bootstrap, IPC registration, tray, file server, updater
  main/ipc/              auth, dirs, clients, messages, settings handlers
  main/ws-client/        relay WS client
  main/file-server/      local Fastify file server + token manager
  main/local-relay.ts    embedded relay start/stop (GUI-managed)
  main/updater.ts        electron-updater (GitHub Releases)
  preload/index.ts       contextBridge-exposed IPC
  renderer/              React UI (pages, App.tsx ~41 KB, theme, styles)
```

---

## Development Commands

```bash
# Bootstrap (one-time)
bash scripts/setup.sh                   # pnpm install + build shared

# Env setup
cp apps/server/.env.example apps/server/.env
# edit .env: JWT_SECRET, JWT_REFRESH_SECRET (openssl rand -base64 48 ×2), ALLOWED_ORIGINS

# Dev (hot reload all)
pnpm dev                                # relay :3002, web :3000, Electron window
pnpm --filter @remotebridge/server dev  # relay only
pnpm --filter @remotebridge/web dev     # web only
pnpm --filter @remotebridge/desktop dev # desktop only

# Build
pnpm build                              # turbo build (all)
pnpm --filter @remotebridge/shared build  # needed after shared edits

# Lint
pnpm lint
```

### Desktop native module note

`better-sqlite3` must compile against the **Electron** ABI, not system Node. If desktop crashes with `NODE_MODULE_VERSION` mismatch:

```powershell
# Windows — recompile then caches binary to .cache/better_sqlite3.electron.node
.\scripts\dev-desktop.ps1
```

```sh
# macOS / Linux
cd apps/desktop && npx @electron/rebuild -f -w better-sqlite3 && cd ../..
```

---

## Testing & QA

Vitest v2 across all four packages. Run per-package:

```bash
pnpm --filter @remotebridge/shared test
pnpm --filter @remotebridge/server test     # auto-spawns relay on :3099 via test/global-setup.ts
pnpm --filter @remotebridge/desktop test
pnpm --filter @remotebridge/web test        # happy-dom env
```

### Server test infrastructure

- `apps/server/test/global-setup.ts` — reuses an existing healthy relay on `:3099` (e.g. dev instance), else spawns `tsx src/index.ts` with temp `RB_DATA_DIR` and raised rate limits (`RL_REGISTER_MAX=100`, `RL_AUTH_MAX=100`); tears down on exit
- `apps/server/test/helpers.ts` — `post()`, `postWithCookies()`, `openWs()`, `createSession()` (register→pin→connect), `waitForMessage()`, `waitForClose()`
- Server tests use **ordered** `it()` blocks with file-level mutable state (intentional, not concurrent)
- `rate-limit.test.ts` spawns its own dedicated relay on a free port for real limit testing

### Test files (18 automated)

|Package|Files|
|---|---|
|server|e2e, relay-roundtrip, session-flows, rate-limit, auth-cookie, startup-secrets, security-logs, messages-auth, host-token-refresh|
|web|useWebSocket (reconnect, revoke, backoff)|
|desktop|(vitest config present)|
|shared|(coverage enforced here)|

Coverage: only `packages/shared` has coverage wired (`test:coverage`). No root-level turbo `test` task.

---

## Code Conventions & Patterns

### Shared package is the contract

- `@remotebridge/shared` is imported by server, web, and desktop. Edit it first, then `pnpm --filter @remotebridge/shared build` before other packages see changes.
- WS message types live in `ws-types.ts`; extend the `WSMessageType` enum rather than ad-hoc strings.
- Binary frame changes must follow `file-tunnel-codec.ts` version/flags scheme (ADR-004).

### Server (Fastify + Drizzle)

- Routes are plugin functions registered under `/api/v1`. Each route file exports a single `async (app) =>` function.
- Rate limiting: `@fastify/rate-limit` with `global: false`, per-route overrides from shared `RATE_LIMIT_CONFIG`.
- Logging: pino via `utils/logger.ts` — **no** `console.*` (ADR `observability-logging-design.md`).
- JWT: `utils/jwt.ts` signs/verifies; `utils/secrets.ts` validates strength at startup in production.
- File proxy uses `reply.hijack()` for raw streaming; manual CORS headers via `corsHeadersFor()`.

### Web (Next.js 14 + Zustand)

- State: single `useAppStore` (Zustand, `store/app-store.ts`). WS manager is separate (`hooks/useWebSocket.ts`).
- API client: `lib/api.ts` (axios). WS URL from `NEXT_PUBLIC_WS_URL` (build-time embedded — requires rebuild to change).
- Security: tokens are **httpOnly cookies** — never read or store tokens in JS. Session metadata only in localStorage.
- StrictMode-safe: WS connect must collapse concurrent calls.

### Desktop (Electron 28 + electron-vite)

- Main/renderer/preload split. `electron-binding.ts` **must** be the first import (redirects `better_sqlite3` `.node` path via `Module._resolveFilename` hook).
- IPC: handlers registered in `main/ipc/*`, exposed to renderer through `preload/index.ts` `contextBridge`.
- Auto-updater: `electron-updater` against GitHub Releases (`main/updater.ts`).
- Local relay: bundled via `scripts/bundle-relay.mjs` (esbuild → single CJS under `resources/relay`), managed from Settings UI.

### Cross-cutting

- **Path validation:** always through shared `security.ts` allowlist + blocklist before any filesystem access.
- **Error handling:** server uses Fastify error replies; desktop wraps and surfaces via IPC; web surfaces via `sonner` toasts + store error state.
- **Logging:** server=pino, desktop=electron-log, web=thin console wrapper (`lib/logger.ts`).

---

## Important Files

|File|Purpose|
|---|---|
|`packages/shared/src/ws-types.ts`|Single source of truth for all WS message types|
|`packages/shared/src/file-tunnel-codec.ts`|Binary frame wire format|
|`packages/shared/src/security.ts`|Path allowlist/blocklist|
|`apps/server/src/index.ts`|Relay entry point, `/health`, graceful shutdown|
|`apps/server/src/routes/auth.ts`|PIN, register, connect, refresh, WS ticket|
|`apps/server/src/routes/proxy.ts`|File download/preview proxy + tunnel streaming|
|`apps/server/src/ws/handler.ts`|WS connection lifecycle, room routing|
|`apps/server/src/db/schema.ts`|Drizzle schema (hosts, sessions, messages, security_logs, download_tokens)|
|`apps/web/src/store/app-store.ts`|Central client state machine|
|`apps/web/src/hooks/useWebSocket.ts`|WS connection manager (reconnect, revoke, backoff)|
|`apps/desktop/src/main/index.ts`|Electron bootstrap + IPC registration|
|`apps/desktop/src/main/local-relay.ts`|Embedded relay lifecycle|
|`apps/desktop/electron.vite.config.ts`|Build config (native module externals, CJS interop, pre-bundle shared)|
|`apps/web/next.config.mjs`|Security headers (CSP, X-Frame-Options, etc.), standalone output|
|`.github/workflows/ci.yml`|CI: build → typecheck → lint → test|
|`docker-compose.yml`|server + web + Caddy (auto TLS via `DOMAIN`)|
|`apps/desktop/electron-builder.config.js`|Installer config (win/mac/linux)|

---

## Runtime / Tooling Preferences

- **Node:** >= 20 (`engines` in root `package.json`)
- **Package manager:** pnpm 9.1.0 (`packageManager` field) — do not use npm/yarn
- **Monorepo orchestration:** Turborepo 1.x (`turbo.json`)
- **Build:** server/desktop use CommonJS output; web uses Next.js standalone output; shared must build before dependents
- **Runtime constraint:** `better-sqlite3` is a native module — must be compiled for the correct ABI (Node for server, Electron for desktop); the cached electron binary lives at `.cache/better_sqlite3.electron.node`
- **Vite interop:** `electron.vite.config.ts` sets `ignoreDynamicRequires: true` so `bindings()` dynamic `require` survives bundling; `optimizeDeps.include: ['@remotebridge/shared']` prevents ESM/CJS interop crash in dev

### Environment variables

Server (`apps/server/.env`): `JWT_SECRET`, `JWT_REFRESH_SECRET` (required, ≥32 chars), `ALLOWED_ORIGINS`, `RELAY_PORT` (3002), `RB_DATA_DIR`, `NODE_ENV` (production enforces secret strength).

Web (build-time): `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` — embedded at build, require rebuild to change.

---

## Design Decisions (ADRs)

Two accepted ADRs in `docs/adr/`:

- **ADR-004** — binary file-tunnel framing (no base64, versioned, backward-compatible via `isBinary` branch)
- **ADR-005** — in-memory single-instance room state (restart self-heals; single seam for future Redis; no horizontal scaling planned)

Other implemented design docs: httpOnly cookie token storage (`httponly-cookie-token-design.md`), observability/logging migration (`observability-logging-design.md`), room state consolidation (`relay-room-state-design.md`), file tunnel wire format (`file-tunnel-binary-framing-design.md`).

---

## Deploy

|Path|Method|
|---|---|
|**Docker Compose** (recommended)|`docker compose up -d` — server + web + Caddy (set `DOMAIN` for Let's Encrypt)|
|**Bare metal**|`bash scripts/deploy-server.sh` → `tsc` → systemd (`deploy/systemd/remotebridge-server.service`)|
|**Desktop installers**|`pnpm --filter @remotebridge/desktop package:win` (also `:mac`, `:linux`) — bundles relay via `bundle-relay.mjs` first|

Health check: `GET /health` returns relay status, DB writability probe, and per-table row counts.

Auto-update: desktop checks GitHub Releases on startup (electron-updater).

---

## Docs & Runbooks

- `README.md` (Chinese) / `README.en.md` (English) — user-facing
- `docs/runbook.md` (Chinese) — ops runbook: crash recovery (P1), register-host abuse (P2), rollback procedure, known limitations
- `docs/adr/` — architecture decision records
- `.full-review/` — periodic repo-wide review reports (latest `05-final-report.md`)
