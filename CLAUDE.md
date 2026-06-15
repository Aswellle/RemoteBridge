# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RemoteBridge is a remote file access system using a **relay server architecture**: an Electron desktop app (the "Host") on a user's PC connects *outbound* to a public Relay Server over WebSocket; a Next.js web client connects to the same relay and the relay forwards messages between them via session-keyed rooms. The Host never exposes ports to the internet. `使用说明书.md` (Chinese) is the operations manual (service startup order, desktop run, full feature walkthrough, verified against v1.0.0). `docs/code-review-report.md` is a June 2026 full-codebase review — its P0–P2 fixes are all in the current code, but its "结构性风险（遗留）" list is partially stale (revoked-session WS check, pending-requests registry, separate refresh secret, and persistent clientId were fixed after it was written); trust the code over that list. A second, separate 2026-06 review (`.full-review/05-final-report.md`) is tracked item-by-item in `CHANGELOG.md`, which is actively maintained and includes a "Known issues / not yet fixed" section — prefer `CHANGELOG.md` over either raw review report for current fix status. Three `docs/*-design.md`/`*-plan.md` files — `observability-logging-design.md` (P1-1, structured logging), `file-tunnel-binary-framing-design.md` (P1-12, binary WS framing for the file tunnel, evolves "ADR-004"), and `test-and-doc-gaps-plan.md` (#19, test/doc gaps) — are now status: **implemented** (see each doc's status header and `CHANGELOG.md`'s Fixed section); read the relevant one for design rationale before extending that area further rather than redesigning from scratch. `docs/relay-room-state-design.md` (P1-7) is status: **implemented** and documents the `connection-registry.ts`/`relay.ts` split described below. Code comments are largely in Chinese.

## Commands

pnpm workspace + Turborepo monorepo. After `pnpm install`, **build the shared package first** — all apps import `@remotebridge/shared` from its compiled `dist/`:

```sh
pnpm --filter @remotebridge/shared build   # required before running/typechecking apps
pnpm dev          # turbo dev — all packages (server: tsx watch, web: next dev :3000, desktop: electron-vite)
pnpm build        # turbo build (dependsOn ^build, so shared builds first)
pnpm lint         # only apps/web has a lint script (next lint)
```

First-time bootstrap (install + build shared in one step) is scripted: `bash scripts/setup.sh`. To run the relay in production mode (`tsc` build then `node dist/index.js`): `bash scripts/deploy-server.sh`.

Per-package (use `--filter`):

```sh
pnpm --filter @remotebridge/server dev          # relay server, default port 3001 (RELAY_PORT)
pnpm --filter @remotebridge/web dev             # web client on :3000
pnpm --filter @remotebridge/desktop dev         # Electron host app
pnpm --filter @remotebridge/desktop package:win # electron-builder packaging (also :mac, :linux)
```

**Desktop native module gotcha**: Electron 28 and Node 22 require different `better-sqlite3` native builds, and both server and desktop symlink the **same** pnpm store copy. The primary fix is a `process.dlopen` hook (`apps/desktop/src/main/electron-binding.ts`, imported first in `main/index.ts`): when running under Electron it redirects better-sqlite3 loads to a prebuilt Electron binary cached at repo root `.cache/better_sqlite3.electron.node`, so the pnpm-store copy can stay Node-built for the server. If that cache file is missing, fall back to `scripts/dev-desktop.ps1` (PowerShell) — it runs `npx electron-rebuild -f -w better-sqlite3` in `apps/desktop` before `pnpm dev`; the rebuild overwrites the shared binary, so afterwards the server needs `pnpm rebuild better-sqlite3` (and the rebuilt `.node` can be copied into `.cache/` to restore the hook). A NODE_MODULE_VERSION mismatch error means the binary being loaded was built for the other runtime.

### Tests

All four packages (`@remotebridge/shared`, `@remotebridge/server`, `@remotebridge/desktop`, `@remotebridge/web`) have vitest suites (`pnpm --filter <pkg> test` / `test:watch`); `.github/workflows/ci.yml` builds, lints, typechecks, and runs all four on every push/PR.

`apps/server`'s suite (`test/**/*.test.ts`) is the largest, targeting a relay at `localhost:3099` (override with `API_BASE` / `WS_BASE` env vars). `vitest.config.ts`'s `globalSetup` (`test/global-setup.ts`, P1-15) auto-spawns a relay on `:3099` with a temp `RB_DATA_DIR` if one isn't already running, and tears it down after — so `pnpm --filter @remotebridge/server test` works standalone in a clean checkout. If a relay is already healthy on `:3099` (e.g. started manually per below), globalSetup reuses it instead of spawning its own:

```sh
# optional: terminal 1 — run against your own relay instance instead of the auto-spawned one
$env:RELAY_PORT=3099; pnpm --filter @remotebridge/server dev
# terminal 2 (or standalone, no terminal 1 needed):
pnpm --filter @remotebridge/server test                  # vitest run
pnpm --filter @remotebridge/server test:watch
npx vitest run -t "test name"                            # single test (run from apps/server)
```

Root-level `test-e2e.js` is legacy — migrated to `apps/server/test/e2e.test.ts`, kept for reference only.

The other three packages' suites are smaller and focused, and run independently of the server's relay: `packages/shared` (`test/file-utils.test.ts`, `test/security.test.ts`), `apps/desktop` (`test/path-guard.test.ts`, `test/token-manager.test.ts`, `test/file-tunnel.test.ts` — the last covers `CMD_FETCH_FILE`'s backpressure loop), and `apps/web` (`test/useWebSocket.test.ts`, covering `WebSocketManager`'s connect/reconnect/backoff state machine, exported from `useWebSocket.ts` for testability).

`apps/server/test/manual-*.mjs` are standalone verification scripts (not vitest), in three groups:
- `manual-file-tunnel`, `manual-host-reconnect`, `manual-message-history`, `manual-relay-roundtrip`, `manual-rest-fallback-routing` — these flows now have vitest equivalents in `relay-roundtrip.test.ts`/`session-flows.test.ts` (P1-14, sharing `test/helpers.ts`); the `.mjs` scripts remain for ad-hoc debugging against a live relay (`node test/manual-<name>.mjs` against `localhost:3099`).
- `manual-live-host.mjs` — full-chain check against a real desktop Host on the default relay (`127.0.0.1:3001`); requires `ACCESS_TOKEN`/`SESSION_ID` env vars and a whitelisted `RB_TEST_DIR`.
- `manual-trust-revoke.mjs` / `manual-settings-hot-reload.mjs` — CDP-driven: require Electron launched with `--remote-debugging-port=9222` and an active web client session, and drive the real renderer UI (trust/revoke, settings hot-reload).

### Database (server)

**Important**: The server creates tables via raw `sqlite.exec(CREATE TABLE ...)` in `apps/server/src/db/client.ts::initDatabase()` — NOT through Drizzle migrations. The Drizzle ORM schema in `db/schema.ts` provides type-safe query builders but is only a reference definition. The `db:generate`/`db:migrate` drizzle-kit scripts were removed (P3-16) since the running server never reads generated migrations; `drizzle-kit` is kept only as a devDependency for `db:studio`. The database location uses `RB_DATA_DIR` env var (defaults to `~/.remotebridge/data/remotebridge.db`) — the `DATABASE_URL` in `.env.example` is read only by drizzle-kit's config file, not by the server runtime.

```sh
pnpm --filter @remotebridge/server db:studio      # drizzle-kit studio (browser-based DB viewer)
```

### Windows note

The `clean` scripts use `rm -rf` and the `scripts/*.sh` files (`setup.sh`, `deploy-server.sh`) are bash — run them via Git Bash / the Bash tool, not PowerShell. The one PowerShell helper is `scripts/dev-desktop.ps1` (the native-module rebuild fallback above).

## Architecture

### Workspace layout

- `packages/shared` — **the protocol contract**. `WSMessageType` enum + payload interfaces (`ws-types.ts`), REST API types (`api-types.ts`), path security validation with OS-specific system dir blacklists and JWT/rate-limit config constants (`security.ts`), file utility functions (`file-utils.ts`), and shared security-log display metadata (`security-log-ui.ts`: `EVENT_TYPE_LABELS`/`EVENT_TYPE_COLORS`, each `satisfies Record<SecurityLog['eventType'], string>` so a new event type fails the build until both maps are updated — consumed by `apps/desktop`'s and `apps/web`'s security log pages). (`ws-types-preview.ts` is commented-out scratch already merged into `ws-types.ts` — not exported, ignore it.) Compiled to `dist/`; consumers import the build output, so **rebuild shared after editing it** (or run its `dev` tsc --watch).
- `apps/server` — Relay Server (Fastify + `@fastify/websocket`). REST routes under `/api/v1` (`routes/`: auth, hosts, messages, security-logs, proxy). `ws/handler.ts` + `ws/connection-registry.ts` + `ws/relay.ts` implement room management (Host↔Client mapping per session) and message forwarding — the relay stores no files, it only routes `WSMessage`s by `sessionId`. SQLite via better-sqlite3 with Drizzle for type-safe queries (`db/`). Stateful rooms live in memory → single instance only (accepted trade-off, see ADR-005: restart self-heals via both ends' unlimited reconnect + host-reconnect room rebuild). CORS policy is defined once in `utils/cors.ts` and consumed in two places: the `@fastify/cors` registration in `index.ts`, and `corsHeadersFor()` in `routes/proxy.ts` — the proxy's tunnel responses use `reply.hijack()`, which bypasses the CORS plugin's hooks, so headers are added manually there. Change CORS policy only in `utils/cors.ts`.

#### Room state vs. message relay: connection-registry.ts and relay.ts

`ws/connection-registry.ts` is the sole owner of room state (the `hostSockets`/`clientSockets`/`sessionRooms` Maps and `ConnectionMeta` are private to this module) — it provides registration (`registerHost`/`unregisterHost`/`registerClient`/`unregisterClient`, each returning a boolean used as a reconnect-race guard: only remove if the registered socket still matches the caller's), lookups (`getHostSocket`/`getClientSocket`/`isHostOnline`/`isClientOnline`/`getClientHost`/`getHostClients`/`getRoomInfo`), iteration (`forEachHost`/`forEachClient`/`forEachClientOfHost`), and room rebinding for host-reconnect (`rebindClientToHost`, `clearHostClients`, `clearAll`).

`ws/relay.ts` is the unified message-sending layer built on top of `connection-registry.ts`: `sendWSMessage` (serialization, using `nanoid()` for message IDs), `relayToHost`/`relayToClient`/`relayMessage` (Client↔Host routing), `notifyHost`/`notifyAndDisconnectClient`, and `sendToClient`/`sendToHost`/`broadcastToHostClients`. It's called from `handler.ts`'s message loop, proxy routes, and REST routes (`routes/messages.ts`, `routes/auth.ts`, `routes/hosts.ts`) that need to push WS messages outside the handler flow — there's a single send-layer module now, no handler-vs-REST split (the former `ws/rooms.ts` was merged into these two files; treat any reference to it as stale).

**Routing fields contract** (relay forwarding is not fully opaque): `relayMessage` (Client→Host) injects `clientId`, `sessionId`, `senderId`, `senderType`, and `messageId` (dedup key for both ends' message persistence) into the message **payload** — Host handlers receive only the payload, never the top-level `WSMessage` fields. Host `RESP_*` replies must echo `clientId`/`sessionId` back in the payload (`withRouting()` in `apps/desktop/src/main/ws-client/dir-handlers.ts`), because Host→Client routing reads `payload.clientId` — a response without it is silently dropped, no error returned. The `RelayRoutingFields` interface in `ws-types.ts` codifies this; new CMD/RESP payload types should extend it.

A second exception: when the relay itself sends a CMD_* to the Host (proxy routes), it registers the `requestId` in `ws/pending-requests.ts` **before** sending; `handler.ts` checks each RESP_* against that registry first and, on a match, consumes the response server-side instead of relaying it to the Client.

- `apps/desktop` — Electron Host agent. All business logic is in the **main process** (`src/main/`): `ws-client/` connects to the relay and `handlers.ts`/`dir-handlers.ts` answer CMD_* messages; `file-server/` runs a local Fastify HTTP server on `127.0.0.1` serving downloads validated by single-use expiring tokens (`token-manager.ts`); `security/path-guard.ts` enforces access control (whitelist + system blacklist + recursive-permission check); `db/` is local SQLite (allowed_directories, connected_clients, download_tokens, local_messages, access_logs). Renderer (`src/renderer/`, React + Zustand) talks to main only via IPC handlers in `src/main/ipc/` exposed through `src/preload/`. Persistent host identity (hostId, hostSecret, hostToken, relay URLs) is stored via `electron-store` in `config/store.ts` — this is separate from the local SQLite DB. The host sends its own PINGs every 5s (separate from the relay's 30s heartbeat) for RTT measurement (`ws-client/client.ts`).
- `apps/web` — Next.js 14 App Router client. `/` is the PIN connect page; `/dashboard/*` is the authenticated area (files, messages, security, settings). `hooks/useWebSocket.ts` + `store/app-store.ts` (Zustand) manage the relay connection. Download responses are consumed exclusively by `lib/download-manager.ts` (proxy-URL rewrite + authenticated streaming with real progress); previews by `hooks/usePreview.ts` (proxy content fetched into blob URLs because `<img>`/`<iframe>` can't send the Authorization header). Previewable files are capped at 10MB (desktop-side limit in `dir-handlers.ts`). Don't add per-component `RESP_DOWNLOAD_*` listeners — duplicate handlers re-trigger downloads with the Host's unreachable 127.0.0.1 URL. Nearly every component is `'use client'` (`src/app/layout.tsx` is the sole server component) — this is deliberate, not an oversight (P1-17): the dashboard is a WebSocket-driven SPA with no server-fetchable data, so React Server Components would have nothing to render server-side.

### Core flows

- **Auth**: Host registers with relay via `POST /auth/register-host` → generates an 8-char PIN (bcrypt-hashed, expiring) via `POST /auth/generate-pin`. PIN uses a confusion-avoiding character set (no 0/O/I/1/l). Client posts PIN + persistent `clientId` (localStorage UUID) to `POST /auth/connect` → relay issues JWT access (2h) + refresh (30d, separate signing key + `use:'refresh'` claim) tokens and creates a DB session. WS connections authenticate via `?token=...&type=host|client` query params. Host identity persists in `electron-store` and reconnects automatically on restart. Refresh tokens are dual-validated (separate JWT secret + use claim) and cannot be used as access tokens.

  ```mermaid
  sequenceDiagram
      participant Host as Desktop Host
      participant Relay
      participant Client as Web Client

      Host->>Relay: POST /auth/register-host
      Relay->>Host: hostId + JWT
      Host->>Relay: POST /auth/generate-pin
      Relay->>Host: PIN (8-char, bcrypt-hashed, expiring)
      Note over Host,Client: PIN shared out-of-band
      Client->>Relay: POST /auth/connect (PIN + clientId)
      Relay->>Client: access JWT (2h) + refresh JWT (30d)
      Host->>Relay: WS connect (?token=...&type=host)
      Client->>Relay: WS connect (?token=...&type=client)
  ```

- **File ops**: Client sends `CMD_LIST_ALLOWED` / `CMD_LIST_DIR` / `CMD_REQUEST_PREVIEW` / `CMD_REQUEST_DOWNLOAD` over WS → relay forwards to the Host in the same room → Host validates the path (whitelist + system blacklist + recursive-permission), responds with `RESP_*`. Downloads return a token URL served by the Host's local file server (`127.0.0.1` only; HTTP Range / resume supported). Since the web client can't reach that address remotely, it rewrites to the relay's `routes/proxy.ts`, which fetches the content over a **WS file tunnel** (`CMD_FETCH_FILE`, see ADR-004): proxy obtains a single-use token via `CMD_REQUEST_*`, Host validates token + whitelist and streams 256KB chunks with backpressure (4MB send buffer high-water mark, polling every 50ms). Non-empty chunks are sent as self-describing **binary** WS frames (P1-12: `packages/shared/src/file-tunnel-codec.ts`'s `encodeFileChunkFrame`/`decodeFileChunkFrame`, via `RelayClient.sendRaw()`); an empty file is still a single JSON `RESP_FILE_CHUNK` (`data: ''`, `eof: true`), and `RESP_FILE_ERROR` is always JSON. The relay branches on `ws`'s `isBinary` flag (`ws/handler.ts`) into `resolveFileTunnelBinaryFrame`/`resolveFileTunnelMessage` (`ws/file-tunnel.ts`), both normalizing to `{ data: Buffer, ... }` so `routes/proxy.ts` writes `chunk.data` into the HTTP response unconditionally, preserving Range/206. Tunnel frames are relay↔host only — never forwarded to clients, and neither path reaches the pending-requests registry or normal client routing.
- **Heartbeat**: Relay PING/PONG every 30s (60s timeout → close); host-side sends its own PINGs every 5s for RTT measurement; reconnect with exponential backoff (1s–30s, unlimited); relay broadcasts `HOST_ONLINE`/`HOST_OFFLINE`. The host's WS client differentiates between code 4001 (auth failure → stop reconnecting, trigger re-registration) and other codes (→ unlimited reconnect).

### REST API routes

All under `/api/v1` prefix:

- `auth/register-host` — Host registration, returns hostId + JWT (rate-limited per-IP, 5/min)
- `auth/generate-pin` — Host generates PIN code (rate-limited per-host, 5/min; default 5-min expiry when `expiresIn` omitted)
- `auth/connect` — Client connects via PIN (rate-limited per-IP, 10/min)
- `auth/refresh` — Refresh access token (separate JWT secret + `use: 'refresh'` claim)
- `auth/revoke/:sessionId` — Host revokes a session via **DELETE** (sends SESSION_REVOKED WS message + force-disconnects client with code 4003). Revocation needs the sessionId (exposed in `hosts/:hostId/clients`), not the clientId.
- `hosts/:hostId/status` — Query Host online status (from in-memory room map; host or client token, scoped to the token's own host)
- `hosts/:hostId/clients` — List connected clients for a Host
- `messages/:sessionId` — GET for message history (paginated, with `since` timestamp filter), POST for REST fallback send; both return `403 SESSION_REVOKED` once the session's `revokedAt` is set, regardless of caller
- `security-logs` — GET with pagination/eventType/clientId/date filters; `GET /events` for event type list
- `access-logs` — GET filtered access logs (BLOCKED_PATH events only)
- `proxy/download/:sessionId` — Proxy download via WS file tunnel (authenticated, Range-aware)
- `proxy/preview/:sessionId` — Proxy preview via WS file tunnel (authenticated, Range-aware)

### Security model (load-bearing — don't weaken)

Every file path is validated twice: against the user's **directory whitelist** AND the **system blacklist** (`packages/shared/src/security.ts` defines blocked system dirs per OS; `apps/desktop/src/main/security/path-guard.ts` applies it with an additional recursive-permission check). Validation uses `path.resolve()` normalization and prefix-plus-separator matching to block traversal and `/home/user` vs `/home/user2` prefix attacks. In `dir-handlers.ts`, file downloads additionally check `permission !== 'download'` at the whitelist-entry level to distinguish read-only from downloadable directories. All access attempts (allowed and blocked) go through `audit-logger.ts` (writes to both local DB and relay security-logs endpoint — HTTP POST, fire-and-forget). Download tokens are single-use UUIDs with 30-min expiry (stored in local SQLite `download_tokens` table), validated once at the HTTP file server (`/download`, `/preview`) and again (via DB lookup) in the WS tunnel handler (`CMD_FETCH_FILE`). The relay rejects WebSocket connections using refresh tokens (check for `use: 'refresh'` claim) and validates sessions against `revokedAt` in DB ("session revoked" close code 4003).

Client-side hardening: `apps/web/next.config.mjs` sets a CSP response header (`object-src 'none'`, `frame-ancestors 'none'`, `frame-src 'self' blob:`, `base-uri 'self'`, `form-action 'self'`), and `PdfViewer.tsx`'s preview iframe uses `sandbox="allow-scripts"` (no `allow-same-origin`) so a `.pdf`-disguised HTML/JS payload served from a `blob:` URL can't read this app's storage/cookies. `apps/desktop/src/main/window.ts` runs the Electron renderer with `sandbox: true`, applies a `RENDERER_CSP` via `onHeadersReceived`, denies all `window.open()`/`target=_blank`, and restricts `will-navigate` to the app's own renderer origin.

### Protocol changes

Adding a message type touches at minimum: `packages/shared/src/ws-types.ts` (enum + payload types) → rebuild shared → handler in `apps/desktop/src/main/ws-client/handlers.ts` or `dir-handlers.ts` (if host-handled) → sender/consumer in `apps/web/src/hooks/` → relay routing code usually needs no change, but new CMD/RESP payload types must extend `RelayRoutingFields` and host responses must echo routing via `withRouting()` (see the routing fields contract above) or responses are silently dropped. If the relay itself must await the Host's response, wire it through `ws/pending-requests.ts` like the proxy routes do.

## Environment

Copy `.env.example` for server config. The server reads these at startup:

```
RELAY_PORT              # default 3001
RELAY_HOST              # default 0.0.0.0
JWT_SECRET              # access token signing key
JWT_REFRESH_SECRET      # refresh token signing key (separate)
ALLOWED_ORIGINS         # CORS (comma-separated origins)
RATE_LIMIT_MAX          # default 10 (per-window max requests)
RATE_LIMIT_WINDOW       # default 60000 (rate limit window in ms)
RB_DATA_DIR             # database directory (optional; defaults to ~/.remotebridge/data)
NODE_ENV                # set to 'production' to enforce JWT secret strength at startup (see Deployment)
```

The web client uses Next.js public env vars (prefixed `NEXT_PUBLIC_`):

```
NEXT_PUBLIC_API_URL     # Relay REST API, default http://localhost:3001/api/v1
NEXT_PUBLIC_WS_URL      # Relay WS endpoint, default ws://localhost:3001/ws
```

The desktop app overrides relay URLs via `electron-store` (set via renderer settings UI); fallback env vars:

```
RELAY_URL               # default ws://127.0.0.1:3001/ws
RELAY_API               # default http://127.0.0.1:3001/api/v1
```

Desktop defaults use `127.0.0.1`, not `localhost`: Node/Electron resolves `localhost` to `::1` while the relay listens IPv4-only, so `localhost` URLs make the host's first auto-connect fail with `EACCES ::1:3001`.

## Deployment

Production deployment is via Docker Compose (`docker-compose.yml`, all services `restart: unless-stopped`):

- `server` — built from `apps/server/Dockerfile` (multi-stage: installs with `python3`/`make`/`g++` so `better-sqlite3` can fall back to source compilation, builds `shared` then `server`, then a minimal `node:20-bookworm-slim` runner with `RB_DATA_DIR=/data` as a volume). Healthcheck hits `GET /health`.
- `web` — built from `apps/web/Dockerfile` (Next.js `output: 'standalone'`). `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` are **build args**, inlined into the client bundle at image-build time — changing them requires rebuilding the image, not just restarting the container.
- `caddy` — TLS-terminating reverse proxy (`Caddyfile`): `/api/*`, `/health`, `/ws*` → `server`, everything else → `web`. Set `DOMAIN` for automatic Let's Encrypt; defaults to `localhost` with Caddy's self-signed local CA for testing.

Bare-metal alternative: `deploy/systemd/remotebridge-server.service` (`Restart=on-failure`, runs `node dist/index.js` from a tree built by `scripts/deploy-server.sh`).

In both paths, `validateJwtSecrets()` (`apps/server/src/utils/secrets.ts`) runs at startup and refuses to start under `NODE_ENV=production` if `JWT_SECRET`/`JWT_REFRESH_SECRET` are missing, default, <32 chars, equal to each other, or refresh-derived-from-access — generate both independently with `openssl rand -base64 48`.

`docs/runbook.md` (Chinese) is the relay-ops runbook: crash recovery (both deployment paths self-heal via their restart policies plus ADR-005's reconnect/room-rebuild — in-flight transfers resume via HTTP Range, in-flight messages recover via `messageId` dedup + REST fallback), `register-host` abuse mitigation (the rate limits above), and rollback with DB-compatibility notes. `GET /health` reports a DB write-probe result, row counts for `hosts`/`sessions`/`messages`/`security_logs`, and DB file size — a 90-day retention job keeps the latter two tables bounded.
