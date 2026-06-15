# Changelog

All notable changes to RemoteBridge are documented here. All four workspace packages
(`@remotebridge/shared`, `@remotebridge/server`, `@remotebridge/web`, `@remotebridge/desktop`)
are currently pinned at `1.0.0`; this file starts tracking changes from the 2026-06
comprehensive code review (`.full-review/05-final-report.md`) onward.

## [Unreleased]

Fixes from the 2026-06 comprehensive code review, in the order they were applied.

### Security

- **Revoked/expired session check on message history** (P0-1): `GET`/`POST /messages/:sessionId`
  now validate the access token with `verifyAccessToken` (was signature-only `verifyToken`,
  which also accepted refresh tokens) and reject requests where the session's `revokedAt`
  is set with `403 SESSION_REVOKED`. Previously a 30-day refresh token, or a token belonging
  to an already-revoked session, could still read/write message history.
- **Predictable message IDs replaced with cryptographic randomness** (P0-3): the
  `Math.random().toString(36)` ID generator used as the `messageId` dedup key in
  `apps/server/src/ws/relay.ts`, `apps/desktop/src/main/ws-client/client.ts`, and
  `apps/web/src/hooks/useWebSocket.ts` was replaced with `nanoid()` (server/desktop) /
  `crypto.randomUUID()` (web), matching the pattern already used elsewhere in `apps/web`.
- **Windows system-directory blacklist now includes `%APPDATA%`/`%LOCALAPPDATA%`** (P0-12):
  `apps/desktop/src/main/security/path-guard.ts` now calls the shared
  `getBlockedDirsForPlatform()` (which derives `%APPDATA%`/`%LOCALAPPDATA%` at runtime for
  win32) instead of reading the static `SYSTEM_BLOCKED_DIRS` table directly. Also fixed
  `getWindowsBlockedDirs()` to return a fresh array each call instead of mutating the
  shared exported array via repeated `.push()`. Closes a credential-exfiltration path for
  any recursive `download`-permission share rooted at `C:\Users\<name>`.
- **JWT secret strength enforced at startup in production** (P0-6): added
  `apps/server/src/utils/secrets.ts::validateJwtSecrets()`, called from `index.ts` before
  the server binds. When `NODE_ENV=production`, the server now refuses to start if
  `JWT_SECRET`/`JWT_REFRESH_SECRET` are missing, equal to the dev defaults, shorter than
  32 characters, equal to each other, or if `JWT_REFRESH_SECRET` is derived from
  `JWT_SECRET` (the old `${JWT_SECRET}-refresh` fallback). `.env.example` was rewritten
  with `openssl rand -base64 48` generation guidance, an `RB_DATA_DIR` entry, and the
  `RELAY_PORT` default corrected from `443` to `3001` (TLS termination is documented as a
  reverse-proxy concern, see Operations below).
- **CSP headers + sandboxed PDF preview iframe in `apps/web`** (P1-10): `next.config.mjs`
  now sets a `Content-Security-Policy` response header via `headers()`, with
  `object-src 'none'`, `frame-ancestors 'none'`, `frame-src 'self' blob:`,
  `base-uri 'self'`, and `form-action 'self'` (`script-src`/`style-src` keep
  `'unsafe-inline'`/`'unsafe-eval'` for Next.js dev-mode Fast Refresh; tightening to a
  nonce-based CSP is follow-up work). `PdfViewer.tsx`'s preview iframe now sets
  `sandbox="allow-scripts"` (no `allow-same-origin`), so a file disguised as `.pdf` that is
  actually HTML/JS served from a `blob:` URL runs in an opaque origin and cannot read this
  app's `localStorage`/cookies.
- **Electron renderer hardening: sandbox, CSP, navigation guards, window-open handler**
  (P1-11): `apps/desktop/src/main/window.ts` now sets `sandbox: true` in `webPreferences`
  (the preload script only uses `contextBridge`/`ipcRenderer`, both available under
  sandbox), applies a `RENDERER_CSP` (`default-src 'self'`, `connect-src 'self'`,
  `object-src 'none'`, `frame-src 'none'`, `base-uri 'none'`, `form-action 'none'`) via
  `onHeadersReceived` (relaxed for the dev server with `'unsafe-eval'`/HMR origins), denies
  all `window.open()`/`target=_blank` via `setWindowOpenHandler`, and restricts
  `will-navigate` to the app's own renderer URL (dev server origin, or the packaged
  `file://renderer/index.html`).

### Added

- **Host audit-log ingestion endpoint** (P0-2 / P1-8): added `POST /api/v1/security-logs`,
  which validates the Host JWT and the `eventType` against a `VALID_EVENT_TYPES` allowlist
  before inserting into `security_logs`. Previously `apps/desktop/src/main/security/audit-logger.ts`
  POSTed every `BLOCKED_PATH`/`ACCESS`/`TUNNEL_FETCH` event to this endpoint, which only
  supported `GET` and silently 404'd (fire-and-forget), making `GET /access-logs`
  permanently empty. As part of this fix, `SecurityLog['eventType']` and
  `AccessLog['action']` in `packages/shared/src/api-types.ts` were extended to include the
  values actually emitted (`LIST_ALLOWED`, `TUNNEL_FETCH`, `ACCESS`, `ACCESS_DOWNLOAD`,
  `ACCESS_PREVIEW`), closing a log-forging gap where a forged Host token could previously
  inject arbitrary `eventType` strings (the union was unenforced `string`).
- **`/health` reports real DB status and table sizes** (P1-21): `GET /health` now calls
  `getHealthStats()` (`apps/server/src/db/client.ts`), which performs a write probe and
  returns row counts for `hosts`/`sessions`/`messages`/`security_logs` plus the database
  file size in bytes. Returns `503` with `status: 'error'` if the write probe fails.
  Combined with the new indexes and retention job below, this gives operators an early
  signal before unbounded table growth becomes an outage.
- **Indexes and 90-day retention job for `messages`/`security_logs`** (P0-5): added
  `idx_messages_session_created` and `idx_security_logs_host_created` to
  `apps/server/src/db/client.ts::initDatabase()`, and a daily `startRetentionJob()` that
  deletes rows older than 90 days from both tables (mirrors the existing
  `rateLimitCleaner` pattern in `routes/auth.ts`).
- **Rate limiting via `@fastify/rate-limit`** (P1-9 / P1-18): registered
  `@fastify/rate-limit` (previously an unused dependency) with `global: false`, and applied
  per-route limits via `config.rateLimit` to `POST /auth/register-host` (5/min/IP — closes
  P1-9's unauthenticated host-row-creation DoS), `POST /auth/generate-pin` (5/min/host, via
  a custom `keyGenerator`), and `POST /auth/connect` (10/min/IP). Replaces the hand-rolled
  in-memory limiter.
- **Production deployment: Docker Compose + systemd unit** (P0-11): added a multi-stage
  `apps/server/Dockerfile`, root `docker-compose.yml` (server + web + Caddy reverse proxy
  with automatic TLS via Let's Encrypt / local self-signed CA), a `Caddyfile`, and
  `deploy/systemd/remotebridge-server.service` (`Restart=on-failure`) for bare-metal
  deployment without Docker. `scripts/deploy-server.sh` previously ended in a bare
  foreground `node dist/index.js` with no restart-on-crash; ADR-005's "restart self-heals"
  reasoning now has automatic-restart infrastructure to back it.
- **Operations runbook** (P1-22): added `docs/runbook.md`, covering relay-crash recovery
  (auto-restart via the P0-11 Docker Compose/systemd units, `/health` checks, and a
  troubleshooting checklist), `register-host` abuse detection and mitigation (building on
  P1-9/P1-18's rate limits), and a rollback procedure with database-compatibility notes
  (building on P1-16's versioning). `使用说明书.md` §8 continues to cover client-side/local-dev
  issues only; this runbook is relay-ops-specific.
- **GitHub Actions CI workflow** (P0-10): added `.github/workflows/ci.yml`, running on push
  to `main` and on pull requests. Steps: `pnpm install --frozen-lockfile` → build
  `@remotebridge/shared` → `pnpm build` (turbo, all 4 packages) → `pnpm --filter
  @remotebridge/web lint` → `tsc --noEmit` for shared/server/desktop/web → `pnpm test` for
  shared/server/desktop. The server test step relies on P1-15's vitest `globalSetup`
  (auto-spawns a relay on `:3099`), so it needs no live relay in CI. Wiring up the desktop
  typecheck step surfaced a real bug: `apps/desktop/package.json`'s `@types/react` /
  `@types/react-dom` were declared as `^18.2.0` but had resolved to a mismatched
  `18.3.30`/`18.2.0` pair, diverging from `apps/web`'s pinned `18.2.0` and causing
  `apps/web`'s `next build` typecheck to fail on JSX component types (`Breadcrumb` "cannot
  be used as a JSX component"). Both are now pinned to exact `18.2.0`, matching `apps/web`.

### Fixed

- **Relay room-state consolidated into `ws/connection-registry.ts`** (P1-7): the three
  module-level Maps (`hostSockets`, `clientSockets`, `sessionRooms`) and the
  `ConnectionMeta` interface moved out of `apps/server/src/ws/handler.ts` into a new
  `ws/connection-registry.ts`, the sole owner of room state with no raw `Map` exports.
  `ws/relay.ts` now imports the registry directly (`initRelay()` and its push-injection
  call site are gone — any module can call `relay.ts` functions in any order).
  `ws/rooms.ts` is deleted: its read helpers (`getRoomInfo`/`RoomInfo`, `isHostOnline`,
  `isClientOnline`, `getClientHost`, `getHostClients`) moved into
  `connection-registry.ts`, and its send helpers (`sendToClient`, `sendToHost`,
  `broadcastToHostClients`) moved into `relay.ts` alongside `sendWSMessage`.
  `routes/proxy.ts`, `routes/hosts.ts`, `routes/messages.ts`, and `routes/auth.ts` now
  import from `connection-registry.ts`/`relay.ts` directly — the dynamic
  `await import('../ws/rooms')` / `await import('../ws/relay')` workarounds in
  `hosts.ts`/`auth.ts` are gone. The host-disconnect/reconnect-race guards
  (`if (hostSockets.get(meta.id) !== socket) return`) are now
  `unregisterHost`/`unregisterClient`'s boolean return value. Two additions beyond
  `docs/relay-room-state-design.md`'s proposed API: `forEachHost`/`forEachClient` (for the
  heartbeat loop, host-reconnect rebuild, and `relayToClient`'s sessionId-fallback lookup)
  and `clearHostClients(hostId): string[]` (host-disconnect cleanup, returning affected
  `clientId`s so `handler.ts` can send `HOST_OFFLINE` while the registry stays
  send-agnostic) — both documented in the design doc's new "Deviations from the proposed
  API" section, which is now marked **implemented**. Pure internal refactor, no
  wire-format/API impact. Verified with `tsc --noEmit` (clean) and the full server vitest
  suite (51/51).
- **Added WS file-tunnel backpressure test; unblocked `apps/desktop`'s vitest suite**
  (P0-9): added `apps/desktop/test/file-tunnel.test.ts`, covering
  `ws-client/file-tunnel.ts`'s `CMD_FETCH_FILE` handler — the last untested part of P0-9
  (the 4MB send-buffer high-water-mark / 50ms backpressure polling). Mocks `./client`,
  `../db/client`, `../security/audit-logger`, `../file-server/token-manager`, and
  `../file-server/server`, against a real temp file validated by the real `validatePath`.
  Two cases: (1) the backpressure loop polls `getBufferedAmount()` until the send buffer
  drains before the first chunk is sent, and the streamed `RESP_FILE_CHUNK` frames
  reassemble to the original file with correct `seq`/`eof`; (2) if the connection drops
  while backpressured, the read stream is destroyed and no chunks or error frames are
  sent. P0-9 is now fully covered (see Testing below for the other two parts).
  Also fixed `apps/desktop/vitest.config.ts`, which previously crashed
  `pnpm --filter @remotebridge/desktop test` entirely with `Cannot find module
  'picocolors'` — Vite's CSS plugin was loading `apps/desktop/postcss.config.js` (→
  `tailwindcss` → `picocolors`, missing from the pnpm store) during config resolution,
  unrelated to any test file. Setting `css: { postcss: {} }` makes Vite treat the PostCSS
  config as inline-and-empty, so `postcss-load-config` is never invoked. Config-only
  change, no `node_modules`/lockfile mutation. All 19 tests across `apps/desktop`'s 3 test
  files now pass, closing the "`apps/desktop` vitest suite could not be verified" gap noted
  in the P1-20 entry below (the separate `apps/web` `Cannot find module 'next'` issue is
  unrelated and still open).
- **Desktop `CMD_LIST_DIR` now bounds `fs.stat` concurrency** (P1-13):
  `apps/desktop/src/main/ws-client/dir-handlers.ts`'s `CMD_LIST_DIR` handler previously
  issued an unbounded `Promise.all(entries.map(... fs.stat ...))` — for a directory with
  thousands of entries on a network/spinning-disk drive, this fired thousands of
  concurrent `stat` syscalls before `RESP_DIR_LIST` could resolve. Added a small
  `mapWithConcurrency()` helper (chunks of `STAT_CONCURRENCY = 64`, processed
  sequentially, no new dependency) and used it in place of the bare `Promise.all`.
  Behavior and output shape are unchanged (still filters `null` entries from `stat`
  failures); only the in-flight concurrency is now bounded. `CMD_LIST_ALLOWED`'s
  `Promise.all` over the whitelist (a small, admin-managed list) was left as-is.
- **Consolidated `EVENT_TYPE_LABELS`/`EVENT_TYPE_COLORS` into `@remotebridge/shared`**
  (P1-20): `apps/desktop/src/renderer/pages/SecurityLogs.tsx` and
  `apps/web/src/app/dashboard/security/page.tsx` previously each defined their own
  `EVENT_TYPE_LABELS`/`EVENT_TYPE_COLORS` maps for `SecurityLog['eventType']`, with
  diverging colors and only 6 of the 8 union members covered (missing
  `ACCESS_DOWNLOAD`/`ACCESS_PREVIEW`, emitted by `apps/server/src/routes/proxy.ts`'s
  download/preview proxy logging). Both maps now live in the new
  `packages/shared/src/security-log-ui.ts`, typed `satisfies Record<SecurityLog['eventType'], string>`
  so a future `eventType` addition fails the shared package's build until both maps are
  updated. Both consumer files now import from `@remotebridge/shared` and index with
  `as keyof typeof EVENT_TYPE_LABELS`/`EVENT_TYPE_COLORS` (the `satisfies` form drops the
  generic `string` index signature `Record<string, string>` had, under `strict: true`),
  preserving the original `|| fallback` for unrecognized values. Since the moved
  `EVENT_TYPE_COLORS` strings are literal Tailwind classes, both
  `apps/desktop/tailwind.config.ts` and `apps/web/tailwind.config.ts` add
  `../../packages/shared/src/**/*.{ts,tsx}` to their `content` globs so these classes are
  still generated. Verified: `@remotebridge/shared` builds clean, `apps/desktop`
  `tsc --noEmit` clean. `apps/web` `tsc --noEmit` and `apps/desktop`'s vitest suite could
  not be verified — both fail on a pre-existing, unrelated environment issue (the shared
  pnpm store's `next`/`picocolors` package directories are missing under
  `node_modules/.pnpm/`, producing `Cannot find module 'next'`/`'picocolors'` errors
  before this change's files are even reached).
- **Desktop `ws-client/client.ts::send()` now returns whether the message was actually
  sent** (P1-4): previously returned `void` and silently dropped messages when the WS
  wasn't `OPEN`. Now returns `boolean` and logs a `console.warn` (with the message type
  and `readyState`) on drop. `ws-client/file-tunnel.ts`'s `CMD_FETCH_FILE` chunk-streaming
  loop checks the return value — if a `RESP_FILE_CHUNK` send fails mid-transfer (socket
  dropped between the backpressure check and the send), it now destroys the read stream
  and aborts immediately instead of continuing to read and base64-encode chunks for a
  connection that's gone. No queueing/buffering added — drops remain drops, just
  observable now.
- **`notifyAndDisconnectClient` now reports success/failure** (P1-3):
  `apps/server/src/ws/relay.ts::notifyAndDisconnectClient` returned `void`, so the session
  revoke handler (`routes/auth.ts`) couldn't tell whether the Client was actually notified
  and disconnected (vs. already offline). It now returns `boolean` — `false` when the
  client isn't in `clientSockets` or its socket isn't `OPEN` (both already logged via
  `console.error`), `true` once the notify message is sent and the close is scheduled. The
  revoke handler logs a `console.warn` when `notified` is `false`, while the DB-side
  revocation (already applied beforehand) is unaffected either way. Verified with the full
  server vitest suite (51/51).
- **Documented `apps/web`'s near-universal `'use client'` usage as deliberate** (P1-17):
  `apps/web/src/app/layout.tsx` is the only server component in the app — every other
  page/component is `'use client'`. This was previously undocumented and looked like an
  oversight. Added a sentence to `CLAUDE.md`'s `apps/web` architecture description
  explaining that the dashboard is a WebSocket-driven SPA with no server-fetchable data,
  so React Server Components would have nothing to render server-side and the
  `'use client'` boundary is intentional. No code changes.
- **Removed unused `zustand` dependency from `apps/desktop`** (P1-19):
  `apps/desktop/package.json` declared `zustand ^4.5.0`, but it was never imported —
  `App.tsx` prop-drills 13 `useState` calls and duplicates 10s polling across 3 pages
  instead. Removed the unused dependency (`pnpm install` re-synced `pnpm-lock.yaml`,
  `-2` packages). Migrating the prop-drilling/polling pattern to a Zustand store
  (mirroring `apps/web`'s `app-store.ts`) remains a larger follow-up not attempted here.
- **`cleanExpiredTokens()` is now actually called** (P0-4): wired into
  `apps/desktop/src/main/index.ts` as an hourly `setInterval(...).unref()`, mirroring the
  `rateLimitCleaner`/retention-job pattern. Previously the function existed and was
  exported but never imported, so `download_tokens` grew without bound.
- **Consolidated file-category/extension classification** (P0-7): `apps/web/src/components/FileList.tsx`
  and `apps/desktop/src/main/ws-client/dir-handlers.ts` now import `getFileCategory` (and
  `isPreviewableFile`) from `@remotebridge/shared` instead of maintaining independent
  extension lists, removing the divergence between the Host's previewability decision and
  the web client's local fallback classification.
- **`usePreview.ts` stale-error overwrite and listener leak** (P1-2):
  `apps/web/src/hooks/usePreview.ts` now tracks a `cleanupRef` for the in-flight request's
  message listener and timeout, invoked at the start of each `requestPreview()` call and
  from `clearPreview()`. The `RESP_PREVIEW_ERROR` branch now checks
  `currentRequestIdRef` before applying the error (previously only the
  `RESP_PREVIEW_READY` branch had this guard), so a stale error response from a superseded
  request can no longer overwrite the current preview's state. Also guards the
  proxy-fetch `.then(blob => ...)` continuation against a superseded request, preventing
  an orphaned (unrevoked) blob URL.
- **REST message-send fallback now injects routing/dedup fields** (P1-6, partial):
  `POST /messages/:sessionId`'s WS push (`apps/server/src/routes/messages.ts`) previously
  called `sendToHost`/`sendToClient` with a payload missing `messageId`, `senderType`,
  `clientId`, and `sessionId` — the fields the normal WS relay path injects per
  `RelayRoutingFields`. This caused the desktop Host to persist the message under a
  different id than the server's `messages` row (no dedup), and the web client to render
  host-sent REST-fallback messages with the wrong `direction`. Both are now included, with
  `id`/`payload.messageId` set to the same id already written to the `messages` table.
  `ws/rooms.ts`'s `sendToClient`/`sendToHost`/`broadcastToHostClients` now delegate to
  `relay.ts::sendWSMessage` instead of a separate hand-rolled `JSON.stringify`, unifying
  two of the three serialization paths. The remaining architectural split (room state
  push-injected into `relay.ts` vs. pull-imported by `rooms.ts`, ADR-005's single-instance
  trade-off being structural) was scoped as a follow-up in
  `docs/relay-room-state-design.md` (P1-7) and has since been implemented — see the P1-7
  entry above.

- **`GET /access-logs` now uses `resolveScopedHostId()`** (P1-5):
  `apps/server/src/routes/security-logs.ts`'s `/access-logs` handler previously had its own
  inline host-only auth check (rejecting client tokens with `401 INVALID_TOKEN`), unlike the
  adjacent `/security-logs` and `/security-logs/events` routes which use the shared
  `resolveScopedHostId()` (host token → `payload.sub`, client token → `payload.hostId`).
  `/access-logs` now uses the same helper, so client tokens can read their host's access
  logs just like they can read its security logs.
- **`getRoomInfo()` now populates `hostName` from the database** (P3-7):
  `apps/server/src/ws/rooms.ts`'s `getRoomInfo()` previously left `hostName` as an empty
  string with a TODO. It now queries `hosts.name` via Drizzle and is `async`, matching the
  await pattern used everywhere else in `apps/server`. The function currently has no
  callers, but is now correct for future use.
- **Removed stale `CLIENT_JOINED` TODO comment** (P3-8): `POST /auth/connect` had a leftover
  `// TODO: notifyHost(...)` comment claiming the `CLIENT_JOINED` WS notification was
  unimplemented; it has in fact been implemented in `apps/server/src/ws/handler.ts` since an
  earlier change. Removed the dead comment.
- **`SIGINT`/`SIGTERM` shutdown no longer risks an unhandled rejection** (P3-9a):
  `apps/server/src/index.ts`'s signal handlers now call a shared `shutdown(signal)` helper
  that wraps `app.close()` in try/catch, logging and exiting with code `1` on failure instead
  of letting a rejected promise from `app.close()` escape uncaught.
- **Consolidated host-only JWT checks into `verifyHostToken()`** (P3-10a): added
  `apps/server/src/utils/jwt.ts::verifyHostToken()` (wraps `verifyToken()` and checks
  `payload.type === 'host'`). Replaces 4 duplicated
  `verifyAccessToken(token); if (payload.type !== 'host') throw ...` blocks in
  `routes/auth.ts` (generate-pin, revoke-session, and the `pinGenerateRateLimitKey`
  rate-limit key generator), `routes/hosts.ts` (`/hosts/:hostId/clients`), and
  `routes/security-logs.ts` (`POST /security-logs`). The client+host dual-scope checks in
  `hosts.ts`'s `/status` handler and `security-logs.ts`'s `resolveScopedHostId()` are
  unaffected (still use `verifyAccessToken`).
- **`/health` reports the real package version** (P3-18): `apps/server/src/index.ts`
  previously hardcoded `version: '1.0.0'` in both `/health` response branches. It now reads
  `apps/server/package.json`'s `version` field at startup and reports that instead, so the
  field tracks the actual deployed version.
- **`electron-binding.ts` now logs better-sqlite3 dlopen fallback failures** (P3-9b): the
  `catch {}` around the Electron-prebuilt-binary `dlopen` attempt was silent, so a corrupted
  or wrong-version `.cache/better_sqlite3.electron.node` would fall through to the
  pnpm-store (Node-built) binary with no clue why. Now logs a `console.warn` with the
  caught error's message before falling back.
- **Desktop `initDatabase()` moved out of module scope** (P3-9c):
  `apps/desktop/src/main/db/client.ts::initDatabase()` was previously invoked automatically
  at module-import time, before Electron's `app.whenReady()`. It's now exported and called
  explicitly as the first step inside `app.whenReady()` in `apps/desktop/src/main/index.ts`.
  `apps/desktop/test/token-manager.test.ts` now calls it explicitly too, since it can no
  longer rely on the import side effect to create the schema.
- **Removed dead `'use client'` directives from Electron renderer files** (P3-12):
  `apps/desktop/src/renderer/{App.tsx, pages/Messages.tsx, pages/Clients.tsx,
  pages/SecurityLogs.tsx}` are plain Vite/Electron-bundled React components, not Next.js
  App Router files — the directive had no effect and was presumably copy-pasted from
  `apps/web`.
- **Stopped leaking raw error strings (paths, Node error codes) to remote clients**
  (P3-2, CWE-209): `apps/desktop/src/main/ws-client/dir-handlers.ts`'s four `RESP_*_ERROR`
  catch blocks (`CMD_LIST_ALLOWED`, `CMD_LIST_DIR`, `CMD_REQUEST_DOWNLOAD`,
  `CMD_REQUEST_PREVIEW`) and `ws-client/file-tunnel.ts`'s `CMD_FETCH_FILE` handler
  previously sent `message: String(err)` — e.g. `ENOENT: ... 'C:\Users\<name>\...'` — back
  to the relay and on to the web client, aiding reconnaissance of the Host's filesystem
  layout. They now send generic localized messages (`'文件系统访问失败'` /
  `'服务器内部错误'`) and `console.error` the real error locally. On the relay side,
  `routes/proxy.ts`'s tunnel `onError` (`TUNNEL_ERROR`) and the download/preview routes'
  outer catches (`PROXY_ERROR`) similarly stopped echoing `err.message` to the HTTP
  response, logging it via `console.error` instead. Also genericized
  `db/client.ts::getHealthStats()`'s error field (consumed by the unauthenticated
  `/health` endpoint), which could otherwise leak the SQLite data directory path.
- **Documented `ALLOWED_ORIGINS` + TLS requirements for production** (P3-3): `使用说明书.md`'s
  Relay env var section and `.env.example` previously showed
  `ALLOWED_ORIGINS=http://localhost:3000,...` as the recommended value — which is also
  `utils/cors.ts`'s insecure fallback when the variable is unset, so a forgotten
  `ALLOWED_ORIGINS` would silently "work" in dev-like form. Both now use
  `https://your-domain.com` as the example and call out that `ALLOWED_ORIGINS` must be set
  explicitly in production (else the deployed web client is CORS-blocked), and that the
  relay must run behind TLS — PINs, JWT access/refresh tokens, and the Host secret
  returned by `register-host` all traverse this connection in plaintext otherwise.
- **Added a report-only `pnpm audit --prod` step to CI** (P3-17): `.github/workflows/ci.yml`
  now runs `pnpm audit --prod || true` right after dependency install, surfacing known
  vulnerabilities in the relay's production dependency tree (`jsonwebtoken`, `bcryptjs`,
  `better-sqlite3`, `ws`, `fastify`, etc.) in the job log without failing the build —
  `pnpm audit` can have false positives on dev-only deps, so this is informational until
  the project is ready to treat findings as blocking.
- **Removed dead `db:generate`/`db:migrate` drizzle-kit scripts** (P3-16): the server
  creates tables via raw `sqlite.exec(CREATE TABLE ...)` in
  `apps/server/src/db/client.ts::initDatabase()`, not Drizzle migrations — `db:generate`/
  `db:migrate` were never part of the deploy flow (already documented in CLAUDE.md) but
  remained as `package.json` scripts that could mislead a contributor into thinking a
  migration workflow exists. Removed both from `apps/server/package.json`; kept
  `db:studio` (and the `drizzle-kit` devDependency it needs) since the browser-based DB
  viewer has standalone value as a manual dev tool. `drizzle-orm`'s type-safe query
  builders in `db/schema.ts` remain in active use and are unaffected.
- **Added `engines.node` to root `package.json`** (P3-15): the monorepo previously had no
  `engines` field anywhere, despite the desktop/server's `better-sqlite3` native module
  being sensitive to the exact Node ABI version (see CLAUDE.md's `NODE_MODULE_VERSION`
  mismatch guidance). Added `"engines": { "node": ">=20" }` as advisory documentation of
  the supported Node range (the actual dev environment runs Node 22). Purely advisory —
  `engine-strict` was not enabled, so this does not change install/build behavior.
- **Documented why `ImageViewer.tsx` uses `<img>` instead of `next/image`** (P3-14):
  `apps/web/src/components/previews/ImageViewer.tsx` renders the preview via a plain
  `<img>` — correct as-is, not a bug: `url` is a `blob:` object URL (or a relay-proxy
  URL) which `next/image`'s optimizer doesn't support, and the viewer's pan/zoom/
  rotate/pinch-gesture logic needs a direct `<img>` DOM ref and CSS `transform`
  control that `next/image`'s `<span>`+`<img>` wrapper would complicate. Added a
  comment explaining this so a future codemod doesn't "fix" it into `next/image`. No
  behavior change.
- **Desktop renderer now uses `lucide-react` icons instead of hand-rolled inline SVGs**
  (P3-13): `apps/desktop/src/renderer/App.tsx` defined ~14 inline `<svg>` icon
  definitions (the `Icons` object plus 4 more inline in JSX) despite `lucide-react`
  already being a devDependency. Replaced with `Link2`, `FolderOpen`, `Users`,
  `MessageSquare`, `ShieldCheck`, `Settings`, `Copy`, `Check`, `Unlink`, `Plus`,
  `Pencil`, `Trash2`, `ArrowRight`, and `Monitor` from `lucide-react`, aligning the
  desktop nav's icon vocabulary with `apps/web`'s dashboard nav (which uses the same
  `FolderOpen`/`MessageSquare`/`ShieldCheck`/`Settings` for the equivalent items).
  Purely decorative icons (all of these sit next to a text label or `title` attribute)
  are marked `aria-hidden="true"`. No behavior change.
- **`RESP_FILE_CHUNK` no longer resends file metadata on every chunk** (P3-11):
  `RespFileChunkPayload` (`packages/shared/src/ws-types.ts`) previously carried
  `totalSize`/`rangeStart`/`rangeEnd`/`contentType`/`fileName` on every frame of a
  streamed file transfer, even though the consumer (`apps/server/src/routes/proxy.ts`'s
  `onChunk`) only reads these fields once, on the first chunk (`seq === 0`, guarded by
  `!headersSent`), to build the HTTP `Content-Type`/`Content-Length`/`Content-Range`/
  `Accept-Ranges` response headers. These five fields are now optional in the shared
  type (documented as first-frame-only); the desktop sender
  (`apps/desktop/src/main/ws-client/file-tunnel.ts`) only includes them on `seq === 0`
  via a conditional `meta` spread, and `proxy.ts` reads them with `?? 0` fallbacks
  (safe since `!headersSent` is only true for the first chunk). `fileName` on this
  payload was confirmed unused/dead on the consumer side — the real filename for
  `Content-Disposition` comes from `RESP_DOWNLOAD_READY`/`RESP_PREVIEW_READY` instead.
  Reduces redundant per-chunk payload size for large file transfers with no protocol
  behavior change. Verified via shared rebuild, clean desktop/server `tsc --noEmit`,
  and the server test suite (51/51 passing, including file-tunnel mock flows in
  `session-flows.test.ts`).
- **Documented `hostInfo` localStorage cross-tab limitation** (P3-10b):
  `apps/web/src/store/app-store.ts`'s `connect` action writes `hostInfo` to `localStorage`
  for session-restore on reload. If a user has multiple tabs connected to different Hosts,
  the last `connect` call's write wins in the shared `localStorage`, though each tab's own
  in-memory Zustand state remains correct for its own connection. Added an inline comment
  documenting this (review-assessed as low severity, single-instance-Relay scenario; no
  behavior change).
- **Paused desktop Messages client-list polling while window is hidden** (P3-6):
  `apps/desktop/src/renderer/pages/Messages.tsx`'s `loadClients()` `setInterval` (10s)
  previously kept polling the `listClients()` IPC handler even while the window was
  minimized to the tray. The interval callback and a new `visibilitychange` listener now
  skip/trigger the call based on `document.visibilityState`, refreshing immediately when
  the window becomes visible again.
- **Memoized `FileList` sort** (P3-5): `apps/web/src/components/FileList.tsx`'s
  `sortedEntries` (directories-first, then alphabetical) was recomputed via
  `[...entries].sort(...)` on every render, including re-renders triggered by unrelated
  state (e.g. download progress updates in a sibling panel). Now wrapped in
  `useMemo(() => ..., [entries])` so the sort only re-runs when the directory listing
  itself changes.
- **Preview viewers are now lazy-loaded with `next/dynamic`** (P3-4):
  `apps/web/src/components/previews/FilePreview.tsx` previously statically imported all
  four preview components (`ImageViewer`, `TextViewer`, `PdfViewer`,
  `UnsupportedViewer`), shipping all ~600 lines in the main `dashboard/files` bundle even
  though only one is ever rendered at a time. They're now wrapped with
  `dynamic(() => import(...), { ssr: false })`, establishing the lazy-load pattern before
  a heavier viewer (syntax highlighter, PDF.js) is added.

### Testing

- **`apps/server`'s vitest suite now spawns its own relay** (P1-15): added
  `test/global-setup.ts`, wired via `vitest.config.ts`'s `globalSetup`. It spawns
  `src/index.ts` (via `tsx`) with `RELAY_PORT=3099` and a temp `RB_DATA_DIR`, waits for
  `/health` to return `200`, runs the suite, then kills the process and removes the temp
  directory. If a relay is already healthy on `:3099` (the previously-documented manual
  workflow), it's reused instead — no port conflict. `pnpm --filter @remotebridge/server test`
  now works in a clean checkout with no manual setup.
- **`packages/shared` and `apps/desktop` now have vitest configs and unit tests** (P0-8):
  added `vitest.config.ts` to both packages plus `packages/shared/test/file-utils.test.ts`,
  `packages/shared/test/security.test.ts`, `apps/desktop/test/path-guard.test.ts`, and
  `apps/desktop/test/token-manager.test.ts`. Previously only `apps/server` had any
  automated tests, leaving `path-guard.ts` and `security.ts` — the project's core
  path-validation logic — with zero regression coverage.
- **5 manual WS verification scripts ported into the vitest suite** (P1-14):
  `manual-relay-roundtrip.mjs`, `manual-host-reconnect.mjs`, `manual-file-tunnel.mjs`,
  `manual-message-history.mjs`, and `manual-rest-fallback-routing.mjs` are now
  `test/relay-roundtrip.test.ts` (refresh-token WS rejection 4001, `CMD_LIST_DIR`
  `RelayRoutingFields` injection + `RESP_DIR_LIST` routing, `PING`/`PONG` id echo,
  session-revocation `SESSION_REVOKED`/4003, revoked-session WS/refresh rejection) and
  `test/session-flows.test.ts` (WS file tunnel download/Range/preview/error, bidirectional
  message persistence + dedup, REST-fallback routing-field injection, host-reconnect room
  rebuild), using `describe`/`it`/`expect` instead of `process.exit`. A new
  `test/helpers.ts` (`createSession`, `openWs`, `waitForMessage`, `waitForClose`) is shared
  across both. `session-flows.test.ts` groups 4 of the 5 scripts onto a single session to
  stay within `REGISTER_HOST_MAX` (5/min/IP) alongside the existing suite's register-host
  calls. `manual-live-host.mjs` (needs a real desktop Host with `ACCESS_TOKEN`/`SESSION_ID`)
  and `manual-settings-hot-reload.mjs`/`manual-trust-revoke.mjs` (CDP-driven, need a live
  Electron renderer) remain manual-only, now with comments explaining why.
- **`apps/web` WS reconnect/backoff tests** (P0-9, partial): added `apps/web/vitest.config.ts`,
  a `vitest` devDependency, and `test`/`test:watch` scripts (matching the
  `packages/shared`/`apps/server`/`apps/desktop` pattern), plus
  `apps/web/test/useWebSocket.test.ts` covering `WebSocketManager`'s connection lifecycle:
  idempotent `connect()`, normal close (code 1000, no reconnect), revoked close (4003 →
  `terminateSession`), auth-expired close (4001 → `refreshAccessToken()` then reconnect, or
  terminate on refresh failure), `disconnect()`, and the exponential reconnect backoff
  sequence (2s, 4s, 8s, 16s, 30s, capped at 30s). `WebSocketManager` in
  `apps/web/src/hooks/useWebSocket.ts` is now exported to make it directly testable. CI now
  runs `pnpm --filter @remotebridge/web test` as a final step. The other non-backpressure
  half of P0-9 — `token-manager.test.ts`'s `TOKEN_EXPIRED`/`TOKEN_USED`/`CLIENT_MISMATCH`
  branches — was already covered by P0-8's test additions; the prior "Known issues" note
  claiming otherwise was stale.

## [1.0.0] — Breaking changes shipped prior to this review (previously undocumented)

These changes were already present in the codebase at the start of the 2026-06 review but
had no changelog or migration notes (P1-16), despite being breaking relative to an
implicit "v0" protocol:

- **Refresh tokens use an independent signing secret.** `JWT_REFRESH_SECRET` is validated
  separately from `JWT_SECRET`, and refresh tokens carry a `use: 'refresh'` claim that
  access-token verification rejects. A refresh token can no longer be used directly as an
  access token, and a leaked access-token secret no longer compromises the 30-day refresh
  tokens (or vice versa).
- **Clients now have a persistent `clientId`.** The web client generates and stores a UUID
  in `localStorage` and sends it on every `POST /auth/connect`, rather than getting a
  fresh anonymous identity per session. This `clientId` is what session revocation and
  per-client security logs are keyed on.
- **Revoked sessions are enforced on the WebSocket layer.** `DELETE /auth/revoke/:sessionId`
  marks the session `revokedAt` in the DB, sends a `SESSION_REVOKED` WS message, and force-
  closes the client's WebSocket with close code `4003`. Any reconnect attempt with a token
  belonging to a revoked session is rejected at the WS handshake. Previously a revoked
  session's existing access token remained valid for its full 2-hour lifetime.

## Known issues / not yet fixed

Tracked from `.full-review/05-final-report.md`, in rough priority order. None of these are
regressions introduced by the fixes above.

- **P1-1** — `console.log`/`console.error` still used throughout
  `apps/server`/`apps/desktop`/`apps/web` instead of structured logging.
- **P1-12** — WS file tunnel base64 chunking still costs ~2.3x allocations per 256KB chunk.
- **P1-23** — Electron desktop has no auto-update or code-signing/distribution pipeline.
- **P2** — ~17 medium-priority items tracked in `.full-review/05-final-report.md`'s
  "Medium Priority (P2)" section (type-safety `as any` usage, token/session hardening,
  frontend perf, module/build hygiene, test/doc gaps, environment/ops). All ~16 P3/Low
  items from that report have been addressed — see P3-1 through P3-18 in Fixed above.
