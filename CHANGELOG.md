# Changelog

All notable changes to RemoteBridge are documented here. All four workspace packages
(`@remotebridge/shared`, `@remotebridge/server`, `@remotebridge/web`, `@remotebridge/desktop`)
are currently pinned at `1.0.0`; this file starts tracking changes from the 2026-06
comprehensive code review (`.full-review/05-final-report.md`) onward.

## [Unreleased]

Fixes from the 2026-06 comprehensive code review, in the order they were applied.

### Security

- **httpOnly cookie tokens — localStorage XSS hardening** (02a-S11): `accessToken` and
  `refreshToken` are no longer stored in `localStorage`. `POST /auth/connect` and
  `POST /auth/refresh` now set `rb_access` (2h) and `rb_refresh` (30d) as
  `HttpOnly; SameSite=Strict; Path=/` cookies (`Secure` added when `NODE_ENV=production`),
  making them invisible to any XSS payload. A new `GET /auth/ws-ticket` endpoint
  (rate-limited 20/min) authenticates via `rb_access` cookie (or `Authorization` header for
  the desktop/legacy path) and returns a 30-second single-use ticket stored in a new
  `apps/server/src/ws/tickets.ts` in-memory store (nanoid(32), auto-cleanup every 60s). The
  web client's `WebSocketManager.connect()` is now `async`: it fetches the ticket first, handles
  a `401` by calling `refreshAccessToken()` and retrying once, then builds a
  `?ticket=<ticket>&type=client` WS URL. The server's WS handshake branches: client +
  ticket → `redeemTicket()` → populate meta; token present → existing JWT path (desktop Host
  / legacy). `apps/server/src/utils/jwt.ts` gains `extractTokenFromRequest()` (tries
  `Authorization` header first, falls back to `rb_access` cookie) used in message-history
  routes. `apps/web/src/lib/api.ts` is rewritten: `withCredentials: true` on the axios
  instance (cookies auto-sent), `refreshAccessToken()` returns `Promise<void>` (no token
  in body), and the 401 interceptor handles session expiry with `POST /auth/logout`. The web
  store (`app-store.ts`) no longer holds or persists tokens — only `sessionId` + `hostInfo`
  remain in localStorage. `apps/web/test/useWebSocket.test.ts` fully updated: mocks
  `api.get` for ticket fetch, `sessionId`-based guards replace `accessToken` checks, and all
  test assertions updated for the async ticket-based connect flow. Test environment upgraded
  to `happy-dom` (added to `apps/web/package.json` devDependencies; configured via
  `vitest.config.ts`) so localStorage and other browser globals are available.
- **Host JWT rotation protocol** (02a-S13): `JWT_CONFIG.HOST_TOKEN_EXPIRY` shortened from
  `'365d'` to `'90d'`; `JWT_CONFIG.HOST_TOKEN_ROTATION_THRESHOLD_DAYS: 30` added to
  `packages/shared/src/security.ts`. New relay endpoint `POST /auth/host-token-refresh`
  (`apps/server/src/routes/auth.ts`): verifies the current host JWT signature, signs a new
  90-day token with the same `hostId`, and returns `{ token, expiresAt }`. New desktop
  module `apps/desktop/src/main/token-rotator.ts` decodes the JWT `exp` field without
  verification (`Buffer.from(parts[1], 'base64url')`, no `jsonwebtoken` import added to
  desktop), checks remaining days against the threshold, and POSTs to
  `/auth/host-token-refresh` when `days ≤ 30`. The rotation runs 30s after
  `app.whenReady()` (waiting for the relay connection to stabilize) and then daily. Wired
  in `apps/desktop/src/main/index.ts`; `stopTokenRotator()` is called on `window-all-closed`.
  IPC `host:get-token-expiry-days` exposes the remaining days to the renderer (settings
  page). Covered by `apps/server/test/host-token-refresh.test.ts` (4 tests: valid token →
  new token + expiresAt, hostId preserved, no-token → 401 MISSING_TOKEN, forged token →
  401 INVALID_TOKEN; uses a directly-signed synthetic token to avoid the rate-limited
  `register-host` endpoint).
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
- **Download/preview tokens now enforced against the requesting clientId** (P2 / 02a-S10):
  `packages/shared/src/ws-types.ts::CmdFetchFilePayload` gains `clientId?: string`.
  `apps/server/src/routes/proxy.ts::tunnelFromHost()` now forwards the session's `clientId`
  in the `CMD_FETCH_FILE` payload it sends to the Host. The Host's
  `apps/desktop/src/main/ws-client/file-tunnel.ts::CMD_FETCH_FILE` handler now calls
  `validateDownloadToken(token, payload.clientId)`, activating the previously dead-code
  `CLIENT_MISMATCH` guard in `token-manager.ts`. Previously, any client who obtained a
  valid download token (even one issued for a different clientId) could fetch the
  corresponding file over the WS tunnel.
- **Host credentials encrypted at rest via Electron `safeStorage`** (P2 / 02a-S13-adjacent):
  `apps/desktop/src/main/config/store.ts` now encrypts `hostSecret` and `hostToken` using
  `electron.safeStorage` (OS-backed: DPAPI on Windows, Keychain on macOS, libsecret on
  Linux) before writing to `electron-store`. Reads transparently decrypt. Existing plaintext
  values in already-written configs are returned as-is and re-encrypted on next write
  (auto-migration, no manual action). When `safeStorage.isEncryptionAvailable()` returns
  `false` (rare — headless / no keychain), values are stored plaintext as before.
  `hostId` is not encrypted (non-secret identifier). No new dependency —
  `safeStorage` is built into Electron 28.
- **02a-S11 review follow-up: body-token removal, proxy cookie fix, `/auth/refresh` rate
  limit**: a multi-reviewer code review of the httpOnly cookie migration found three issues
  fixed immediately:
  1. `POST /auth/connect` was still returning `accessToken`/`refreshToken` in the JSON body
  alongside setting the `httpOnly` cookie — an XSS payload could read the response before
  `app-store.ts` processed it, exfiltrating the 30-day refresh token. Body now returns only
  `{ sessionId, hostInfo }`; `ConnectResponse` in `packages/shared` shrunk to match. The web
  client already destructured only `sessionId`/`hostInfo`, so no web change was needed.
  Server test suite (`helpers.ts`, `e2e.test.ts`, `messages-auth.test.ts`,
  `security-logs.test.ts`) now reads tokens from `Set-Cookie` instead of the body, and the
  `e2e` connect test asserts cookie attributes (HttpOnly, SameSite=Strict, Max-Age).
  2. `apps/server/src/routes/proxy.ts::authenticateClient()` was still `extractTokenFromHeader`
  (Bearer-only) post-migration — the web client switched to `credentials:'include'` with no
  `Authorization` header, so remote proxy downloads/previews silently 401'd for any non-local
  deployment. Switched to `extractTokenFromRequest` (header-first, `rb_access` cookie fallback),
  with a new cookie-auth proxy test in `session-flows.test.ts`.
  3. `POST /auth/refresh` had no rate limit — the only auth route without one, despite minting
  fresh tokens from a 30-day credential. Added the same per-IP limit as every other auth route.
- **`apps/server/src/routes/security-logs.ts`: GET routes switched to cookie-compatible
  extraction**: `GET /security-logs`, `/security-logs/events`, and `/access-logs` used
  `extractTokenFromHeader` (Bearer-only), but all three explicitly accept client tokens via
  `resolveScopedHostId()`. Post-02a-S11 the web client has no JS-readable token to set as an
  `Authorization` header, so the security audit page always got 401 "缺少认证令牌". Switched
  to `extractTokenFromRequest` (header-first, `rb_access` cookie fallback) on these three
  GET routes; `POST /security-logs` left on Bearer-only (structurally Host-exclusive, verify
  by `verifyHostToken`). Covered by a new cookie-auth test in `security-logs.test.ts`.
- **`useWebSocket.ts`: concurrent `connect()` calls now collapse into a single connection**:
  `WebSocketManager.connect()`'s re-entrancy guard only checked `this.ws`, which isn't
  assigned until *after* `await this.fetchWsTicket()` resolves. React StrictMode
  (`next.config.mjs`, `reactStrictMode: true`) deliberately double-invokes mount effects
  in dev, so two `connect()` calls raced past the guard, each fetching its own ticket and
  opening its own WebSocket — the Host received two `CLIENT_JOINED` notifications per
  connect, producing double desktop OS notifications. Added an in-flight `connectPromise`
  so concurrent calls await the same attempt. Covered by a new regression test that fires
  two un-awaited `connect()` calls and asserts only one `api.get` and one WebSocket instance.

### Added

- **Electron auto-update and code-signing pipeline** (P1-23): new
  `apps/desktop/src/main/updater.ts` wires `electron-updater` events into a typed
  `UpdateStatus` union pushed to the renderer via IPC `event:update-status`. IPC handlers
  `updater:get-status`, `updater:check`, `updater:download`, and `updater:install` are
  registered, with a 10s delayed silent check on packaged startup. `apps/desktop/App.tsx`
  shows a non-blocking `UpdateBanner` component (available / downloading-with-progress /
  downloaded-ready-to-install / error states). `apps/desktop/electron-builder.config.ts`
  gains a `publish` block targeting GitHub Releases (`owner`/`repo` from CI env vars);
  code-signing env vars (`WIN_CSC_LINK`, `APPLE_ID`, etc.) are documented in comments but
  require real certificates to activate. New `.github/workflows/release.yml` triggers on
  `v*` tags, builds on Windows/macOS/Linux via a matrix, and uploads release artifacts.
  Preload (`apps/desktop/src/preload/index.ts`) exposes `getUpdateStatus`, `checkForUpdates`,
  `downloadUpdate`, `installUpdate`, `onUpdateStatus` and the `UpdateStatus` type.
- **httpOnly cookie token design doc** (02a-S11): `docs/httponly-cookie-token-design.md`
  documents the full migration path from localStorage to httpOnly cookies for
  `accessToken`/`refreshToken`. See the Security section entry for 02a-S11 for the full
  implementation details. Status: **implemented**.
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

- **File uploads now persist in message history on both ends**: previously `CMD_UPLOAD_FILE_CHUNK`
  was pure relay with no write to the server `messages` table; the desktop Host saved the file
  to disk but never called `db.insertMessage()`. File transfers left zero trace in either
  persistence layer — neither end's message center ever showed a file-send record.
  `apps/server/src/ws/handler.ts` now persists a `type: 'file'` row (keyed by `uploadId`,
  `direction: 'client_to_host', content: fileName`) on every `RESP_UPLOAD_ACK`, and
  `apps/desktop/src/main/ws-client/handlers.ts` does the same into its local `local_messages`
  table right after the file write succeeds. `apps/server/src/db/schema.ts` and
  `packages/shared/src/api-types.ts` widen the `messages.type` union to include `'file'`
  (no DDL change — the raw SQLite `CREATE TABLE` had no CHECK constraint, only Drizzle's
  TS-level enum did). `apps/web/src/store/app-store.ts::loadMessageHistory()` backfills
  `fileName`/`uploadStatus: 'completed'` for `type: 'file'` history rows so reloaded file
  bubbles show the filename. Covered by `session-flows.test.ts`.
- **`GET /messages/client/history` no longer hides messages from revoked sessions**: the
  aggregation query previously filtered sessions by `isNull(sessions.revokedAt)`, so revoking
  any session in a client↔host pair permanently erased that session's entire message history
  from every future view. Revocation kills a token's ability to authenticate — it doesn't mean
  the conversation during that session stops being real. Filter removed. Confirmed with the
  live DB: a revoked session's 3 messages were missing from the endpoint's response, now
  restored. Covered by a new cross-session revocation test in `session-flows.test.ts`.
- **Web message bubble: client-to-host timestamp text was invisible**:
  `apps/web/src/app/dashboard/messages/page.tsx` — the `isMe` bubble background is solid
  `bg-primary`; the timestamp used `text-primary/70` (same hue, just translucent) instead
  of `text-white/70` (matching the message body's `text-white`). Changed to `text-white/70`.

- **Desktop packaged app: `Cannot find module 'conf'` at runtime** (build-infra): pnpm's
  virtual-store junction structure (`node_modules/.pnpm/…`) is not followed correctly by
  Electron's module resolver inside a packaged ASAR. Transitive dependencies (e.g. `conf`,
  a dep of `electron-store`) are not reachable via standard Node.js resolution from inside
  the ASAR. Fixed by bundling all pure-JS production deps into `dist/main/index.js` via
  Vite/Rollup: `externalizeDepsPlugin` in `apps/desktop/electron.vite.config.ts` now
  excludes (i.e. bundles) `@remotebridge/shared`, `axios`, `electron-log`, `electron-store`,
  `electron-updater`, `fastify`, `nanoid`, and `ws`. Only `better-sqlite3` (native `.node`
  file) remains external, handled by the `dlopen` hook. The main bundle grew from ~65 KB to
  ~2.4 MB; this is expected and acceptable. `commonjsOptions.include` was also added to the
  main build (same reason as the renderer fix above: `@remotebridge/shared`'s CJS
  `__exportStar` is not statically analyzable by Rollup without it).

- **Desktop Windows installer build** (build-infra): Three fixes required for
  `pnpm --filter @remotebridge/desktop package:win` to produce a valid NSIS installer on
  Windows:
  1. `electron-builder.config.ts` converted to `electron-builder.config.js` (CommonJS) —
     electron-builder 24.x requires `ts-node` to execute TypeScript configs; without it the
     config was silently ignored (defaulting to wrong output dir, missing `files` pattern,
     ignoring `npmRebuild: false`).
  2. `electron.vite.config.ts` renderer build gains `commonjsOptions: { include:
     [/packages[\\/]shared[\\/]dist/, /node_modules/] }` — Rollup's CJS plugin only
     processes `/node_modules/` by default, so `packages/shared/dist/index.js` (a workspace
     package) was treated as ESM; `__exportStar` re-exports (e.g. `EVENT_TYPE_LABELS`,
     `EVENT_TYPE_COLORS`) could not be statically analyzed, causing a build error.
  3. `package:win/mac/linux` scripts in `apps/desktop/package.json` now pass
     `--config=electron-builder.config.js` explicitly so the config is always found
     regardless of working directory.
  `npmRebuild: false` + `extraResources: [{ from: '../../.cache/better_sqlite3.electron.node',
  to: '.cache/better_sqlite3.electron.node' }]` are set in the JS config: the `dlopen` hook
  in `electron-binding.ts` redirects `better-sqlite3` loads to the Electron-built prebuilt,
  so electron-builder doesn't need to rebuild the native module; `extraResources` places the
  prebuilt into `resources/.cache/` so the path-traversal hook finds it in packaged apps.

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
- **Structured logging replaces `console.*` across all three runtime packages** (P1-1):
  all 61 `console.log`/`console.error`/`console.warn` call sites identified in
  `docs/observability-logging-design.md` are now leveled, structured calls. `apps/server`
  (15 sites) gets a new `apps/server/src/utils/logger.ts` exporting a standalone `pino()`
  instance with `level: process.env.LOG_LEVEL ?? 'info'`, matching `index.ts`'s Fastify
  `logger.level` so both stay in sync; used in `db/client.ts` (including before `app`
  exists), `ws/relay.ts`, `ws/handler.ts`, `routes/proxy.ts`, and `routes/auth.ts`.
  `apps/desktop` (35 sites) adds `electron-log@5.4.4` and a new
  `apps/desktop/src/main/logger.ts` wrapping `electron-log/main`, with both
  `log.transports.file.level`/`log.transports.console.level` set from `LOG_LEVEL`; used
  throughout `src/main/` (`index.ts`, `electron-binding.ts`, `file-server/`, `ipc/`,
  `ws-client/`, `security/audit-logger.ts`). `apps/web` (11 sites) adds a thin
  `apps/web/src/lib/logger.ts` whose `debug`/`info` no-op when
  `NODE_ENV === 'production'` while `warn`/`error` always pass through; used in
  `store/app-store.ts`, `hooks/useWebSocket.ts`, `components/previews/FilePreview.tsx`,
  and the messages/security dashboard pages. Also fixes the two correctness issues named
  in the design doc: the leftover debug `console.log`s in
  `ws/relay.ts::notifyAndDisconnectClient` are now `logger.debug`, and the
  emoji-prefixed pre-`app`-exists logs in `db/client.ts` (`📦`/`✅`/`🧹`) are now plain
  `logger.info` calls with structured fields (e.g. `{securityLogs, messages}` for the
  retention-cleanup counts). No behavior change beyond log format/destination. Verified
  via shared rebuild, clean `tsc --noEmit` on all three packages, and the full server
  (60/60), desktop (19/19), and web (9/9) vitest suites.
- **WS file tunnel now streams non-empty chunks as binary WS frames** (P1-12): per
  `docs/file-tunnel-binary-framing-design.md`, each non-empty 256KB chunk of
  `CMD_FETCH_FILE`'s response is now a single self-describing **binary** WS frame
  instead of a base64-encoded JSON `RESP_FILE_CHUNK` — eliminating the
  `Buffer → base64 string → JSON.stringify` encode and
  `JSON.parse → Buffer.from(base64)` decode on both the desktop main process and the
  relay (~2.3x allocation overhead, ~1s cumulative blocking CPU per 500MB transfer per
  `.full-review/05-final-report.md`). New shared codec
  `packages/shared/src/file-tunnel-codec.ts` exports `encodeFileChunkFrame`/
  `decodeFileChunkFrame`: a small fixed header (version, eof/hasMeta flags,
  `transferId`, `seq`, and — only on `seq === 0` — `totalSize`/`rangeStart`/`rangeEnd`/
  `contentType`/`fileName`) immediately followed by the raw chunk bytes. `RelayClient`
  gains `sendRaw(buffer: Buffer): boolean` (`apps/desktop/src/main/ws-client/client.ts`),
  calling `this.ws.send(buffer)` directly (binary auto-detected for `Buffer` payloads);
  `ws-client/file-tunnel.ts` uses it for non-empty chunks instead of
  `client.send({..., data: chunk.toString('base64')})`. On the relay,
  `ws/handler.ts`'s WS `message` handler branches on `ws`'s `isBinary` flag:
  `isBinary === true` → `decodeFileChunkFrame` → new `resolveFileTunnelBinaryFrame`
  (`ws/file-tunnel.ts`); `isBinary === false` → the existing `JSON.parse` →
  `resolveFileTunnelMessage` (unchanged, still handles the empty-file
  `data: '', eof: true` case and `RESP_FILE_ERROR`, both of which remain JSON). Both
  paths normalize to the same `{ data: Buffer, ... }` shape, so
  `routes/proxy.ts::tunnelFromHost`'s `onChunk` needs no branching —
  `raw.write(chunk.data)` either way, preserving Range/206. Backward compatible: a Host
  that predates this change keeps working via the `isBinary === false` path with no
  version negotiation (relevant given P1-23, no desktop auto-update yet). Documented in
  `docs/adr/ADR-004-file-tunnel-framing.md` (status: Accepted, as built). Covered by
  `packages/shared/test/file-tunnel-codec.test.ts` (7 unit tests, header round-trip +
  meta presence/absence) and 3 new `apps/server/test/session-flows.test.ts` cases (full
  download / Range download / preview, all over the binary path), plus the updated
  `apps/desktop/test/file-tunnel.test.ts` (decodes `sendRaw`'s frames via
  `decodeFileChunkFrame`).
- **`JWT_CONFIG` is now a const-asserted type; `as any` casts removed from `jwt.ts`** (P2 / 01a-M1):
  `packages/shared/src/security.ts::JWT_CONFIG` (token expiry strings) gains `as const` so
  `'2h'`/`'30d'`/`'365d'` are literal types rather than `string`. The three `as any` casts
  for `expiresIn` in `apps/server/src/utils/jwt.ts` (`signHostToken`, `signClientAccessToken`,
  `signClientRefreshToken`) are removed — `jsonwebtoken` now infers the correct overload.
- **`ConnectionMeta` stored in a `WeakMap`, not on the WebSocket object** (P2 / 04a-B7):
  `apps/server/src/ws/connection-registry.ts` replaces the `(ws as any).__meta` property-bag
  pattern with a module-level `WeakMap<WebSocket, ConnectionMeta>` and exports typed
  `getConnMeta(ws)`/`setConnMeta(ws, meta)` accessors. All call sites in `ws/handler.ts`
  (7 occurrences) and `ws/relay.ts` (1 occurrence) updated. Eliminates `as any` casts and
  makes metadata GC-safe (entries are automatically collected when the WebSocket is closed
  and dereferenced).
- **`ALLOWED_ORIGINS` now warned at startup in production** (P2 / 04b-DC8, partial):
  `apps/server/src/utils/secrets.ts::validateJwtSecrets()` now logs a warning when
  `NODE_ENV=production` and `ALLOWED_ORIGINS` is unset or `'*'`. This is a non-fatal
  warning (not a startup refusal) — a misconfigured `ALLOWED_ORIGINS` in production means
  the deployed web client is CORS-blocked, not a security vulnerability per se. See
  `docs/runbook.md` for the recommended value.
- **Web relay URL defaults centralized into `apps/web/src/lib/env.ts`** (P2 / 04b-DC8):
  `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` fallbacks (`'http://localhost:3001/api/v1'`
  and `'ws://localhost:3001/ws'`) were inlined in four separate files (`lib/api.ts`,
  `hooks/useWebSocket.ts`, `hooks/usePreview.ts`, `lib/download-manager.ts`). All four now
  import `RELAY_API_URL`/`RELAY_WS_URL` from a single new `apps/web/src/lib/env.ts`.
- **`/auth/connect` response now reports live host-online status** (P2 / 01b-M4):
  `apps/server/src/routes/auth.ts`'s `POST /auth/connect` previously hardcoded
  `online: true` in the response, independent of whether the Host's WebSocket was actually
  connected. Now calls `isHostOnline(matchedHost.id)` from `ws/connection-registry.ts`,
  matching the behaviour already used by `GET /hosts/:hostId/status`.
- **Messages capped at 500 most-recent in the web client** (P2 / 02b-M1):
  `apps/web/src/store/app-store.ts`'s `loadMessageHistory` merge and the real-time
  `MSG_TEXT` arrival path both now cap the `messages` array to the 500 most-recent entries
  (`slice(-500)`), preventing unbounded memory growth during long sessions.
- **Download-manager blob-URL and anchor-removal delays increased** (P2 / 01a-L10):
  `apps/web/src/lib/download-manager.ts` increases the `URL.revokeObjectURL` delay from
  60 s to 300 s (giving the browser time to start the download before the object URL is
  revoked) and the `document.body.removeChild(a)` delay from 100 ms to 1 s (ensuring the
  synthetic anchor click registers before DOM removal).
- **`ipc/messages.ts` static import replaces CJS `require`** (P2 / 04a-B8):
  `apps/desktop/src/main/ipc/messages.ts` used `const { WSMessageType } = require('@remotebridge/shared')`
  inside an otherwise static-import file. Replaced with `import { WSMessageType } from '@remotebridge/shared'`.
- **`turbo.json` `dev` task now depends on `^build`** (P2 / 04a-B10):
  The `dev` task in `turbo.json` gains `"dependsOn": ["^build"]`, so `pnpm dev` at the
  monorepo root correctly builds `@remotebridge/shared` before starting `apps/server`,
  `apps/web`, and `apps/desktop` in watch mode. Previously a clean checkout's first
  `pnpm dev` could race and start apps before `packages/shared/dist/` existed.

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

## [1.1.8] — 2026-06-22

### Security

- **httpOnly cookie token migration** (02a-S11): web client `accessToken`/`refreshToken`
  moved from `localStorage` to `HttpOnly; SameSite=Strict` cookies, eliminating XSS token
  exfiltration. WS auth now uses 30s single-use tickets (`GET /auth/ws-ticket`). See the
  [Unreleased] Security section for the full implementation details.

## [1.1.7] — 2026-06-21

### Added / Fixed

- **移除默认菜单栏**（`apps/desktop/src/main/index.ts`）：`Menu.setApplicationMenu(null)` 在启动时立即清除 Electron 附带的 File/Edit/View/Window/Help 菜单栏，使界面更简洁。Edit 菜单的剪切/复制/粘贴操作由 OS/Chromium 层的键盘快捷键原生支持，无需菜单；Window 最小化/关闭由标题栏按钮保留。
- **开发模式 DevTools 快捷键保留**（`apps/desktop/src/main/window.ts`）：菜单栏移除后，开发模式下通过监听 `before-input-event` 拦截 F12 / Ctrl+Shift+I，保持调试入口可用，替代原 View → Developer Tools 菜单项。
- **设置页新增「关于」区块**（`apps/desktop/src/renderer/pages/Settings.tsx`）：迁移原 Help 菜单的版本信息功能。通过 `getSystemInfo()` IPC 展示应用版本、Electron 版本、Node.js 版本、Chromium 版本、操作系统版本和主机名。
- **生产环境 Docker 加固**（`docker-compose.yml`、`apps/server/Dockerfile`、`apps/web/Dockerfile`、`Caddyfile`、`apps/server/src/index.ts`、`apps/web/next.config.mjs`）：
  - `trustProxy: true` + `bodyLimit: 1 MB`：修复限流按真实 IP 计数失效问题，防止大 payload；
  - 两个 Dockerfile 均创建非 root 运行用户（uid 1001），减小容器被攻破时的爆炸半径；
  - Web 容器新增 `HEALTHCHECK`，`docker-compose.yml` 的 `depends_on` 改为 `condition: service_healthy`，避免 Caddy 在 Next.js 就绪前转发请求；
  - `deploy.resources.limits` 限制 CPU/内存，`security_opt: no-new-privileges:true`，日志驱动加 `max-size`/`max-file` 防磁盘撑满；
  - `Caddyfile` 补全 HSTS、X-Content-Type-Options、X-Frame-Options、Referrer-Policy、Permissions-Policy 安全头，隐藏 Server 版本信息；
  - `next.config.mjs` 补全 X-Content-Type-Options、X-Frame-Options、Referrer-Policy、Permissions-Policy，与 Caddy 形成双层防御。

## [1.1.6] — 2026-06-21

### Fixed / Improved

- **Security audit log: each event type now has a distinct badge color** (`packages/shared/src/security-log-ui.ts`): `EVENT_TYPE_COLORS` previously mapped three types (`ACCESS_DOWNLOAD`, `ACCESS_PREVIEW`, `ACCESS`) to the same blue palette. All eight event types now get unique, high-contrast color pairs for both light and dark themes: red (`AUTH_FAIL`), orange (`BLOCKED_PATH`), yellow (`REVOKE`), slate (`PIN_EXPIRED`), green (`SESSION_CREATED`), blue (`ACCESS_DOWNLOAD`), violet (`ACCESS_PREVIEW`), cyan (`ACCESS`). Consumed by both desktop `SecurityLogs.tsx` and web `security/page.tsx` via the shared constant.
- **Desktop message center: host message timestamp unreadable** (`apps/desktop/src/renderer/pages/Messages.tsx`): host-sent bubbles use `bg-primary text-white`; the timestamp `<p>` used `text-primary/70`, making it invisible against the dark blue background. Changed to `text-white/60` so the time is legible.
- **Desktop connected clients: button contrast and semantics** (`apps/desktop/src/renderer/pages/Clients.tsx`): the 客户端列表 / 活动日志 tab buttons and 刷新 button had `hover:bg-secondary` identical to their resting background — no visual hover feedback. Fixed to `hover:bg-muted`. The 信任 button (untrusted state) changed from `bg-success/20 text-success` to a solid `bg-success text-white`; the 吊销 button changed from `bg-destructive/20 text-destructive` to solid `bg-destructive text-white` — both now produce sufficient contrast ratio and clear affordance.
- **Remove input-box separator line in both message centers** (`apps/desktop/src/renderer/pages/Messages.tsx`, `apps/web/src/app/dashboard/messages/page.tsx`): the `border-t border-border` above the chat input created a visual gap line between the message list and the input row. Removed from both apps so the boundary is visually seamless.
- **Web settings page: content area left-aligned to sidebar** (`apps/web/src/app/dashboard/settings/page.tsx`): the content wrapper used `max-w-2xl mx-auto` which pushed it to the center of the main area. Removed `mx-auto` so the content aligns flush against the left sidebar.

## [1.1.5] — 2026-06-21

### Added / Fixed

- **Device history panel on connect page** (`apps/web/src/app/page.tsx`): the connect page now uses a two-column layout — a `w-72/w-80` left panel showing up to 8 previously connected host cards (name, OS, last-connected timestamp) and a right panel with the PIN form. Clicking a history card shows a toast reminding the user to generate a new PIN on that host.
- **Default theme changed to light; flash-of-dark eliminated** (`apps/web/src/lib/theme.ts`, `apps/web/src/app/layout.tsx`): `getSavedTheme()` now defaults to `'light'` instead of `'dark'`. A blocking inline script in `<head>` applies the saved theme class before React hydration, preventing the dark-to-light flash that occurred when the browser rendered the HTML with no class and React then added it.
- **Real-time shared directory sync to web client** (`packages/shared/src/ws-types.ts`, `apps/desktop/src/main/ipc/dirs.ts`, `apps/server/src/ws/handler.ts`, `apps/web/src/hooks/useWebSocket.ts`): added `HOST_DIRS_UPDATED` WS message type. The desktop IPC handlers for `dirs:add`, `dirs:remove`, `dirs:update-permission`, and `dirs:save-alias` now call `pushDirsUpdated()` after each change, which broadcasts a `HOST_DIRS_UPDATED` message through the relay to all connected web clients. The web `useWebSocket` handler re-calls `listAllowed()` on receipt when at the root view.
- **Directory access permission badges in file browser** (`packages/shared/src/ws-types.ts`, `apps/desktop/src/main/ws-client/dir-handlers.ts`, `apps/web/src/components/FileList.tsx`, `apps/web/src/app/dashboard/files/page.tsx`): `FileEntry` now carries `permission?: 'readonly' | 'download'`. The desktop `CMD_LIST_ALLOWED` handler populates it from the stored whitelist entry. `FileList` renders a permission column (eye/download badge) when `isRootView` is true. Real-time permission updates flow through the `HOST_DIRS_UPDATED` mechanism above.

## [1.1.4] — 2026-06-21

### Fixed

- **PDF preview too small in modal — now opens in Chrome's native full-screen PDF reader** (`apps/web/src/components/previews/FilePreview.tsx`): PDF files previously rendered inside a `max-w-5xl max-h-[90vh]` modal iframe, giving an insufficient viewport for multi-column PDFs. `FilePreview` now detects `effectiveCategory === 'pdf'` and, once `previewUrl` is set, calls `window.open(previewUrl, '_blank', 'noopener')` and closes the modal immediately — Chrome opens its built-in PDF reader at full window size with zoom/page controls. `PdfViewer.tsx` and its dynamic import are no longer used by `FilePreview`; the component is kept for potential future embedding use.
- **Plain-text (.txt) preview "TypeError: Failed to fetch" in React 18 StrictMode** (`apps/web/src/hooks/usePreview.ts`, `apps/web/src/components/previews/TextViewer.tsx`): React 18 StrictMode (active in `next dev`) double-invokes effects — the cleanup of the first mount called `clearPreview()` → `URL.revokeObjectURL()` on the blob URL before `TextViewer`'s `useEffect` could `fetch()` it, producing "TypeError: Failed to fetch". Fixed by eliminating the blob URL entirely for text files: `usePreview` now reads `blob.arrayBuffer()` immediately in the `.then()` callback and stores the result as `rawBytes: Uint8Array` in React state (`previewUrl` stays `null` for text). `TextViewer` receives `rawBytes` as a prop instead of a `url` string — BOM detection and encoding (UTF-8 / GBK / UTF-16) is applied synchronously on the prop, with no secondary `fetch()`. Image and PDF files are unaffected and continue to use blob URLs.

## [1.1.3] — 2026-06-21

### Fixed

- **PDF preview still blocked by Chrome after 1.1.2** (`apps/web/src/components/previews/PdfViewer.tsx`): Chrome's built-in PDF viewer is implemented as a browser extension (`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai`) and cannot load inside any sandboxed iframe — even `allow-scripts allow-same-origin`. Removed the `sandbox` attribute entirely; blob URLs are inherently same-origin and content always originates from the user's own token-authenticated Host.
- **Plain-text (.txt) files not rendering in preview**: `TextViewer.tsx` previously called `response.text()` which decodes the blob as UTF-8, garbling Windows Notepad files saved as UTF-16 LE ("Unicode" mode) or GBK/ANSI (traditional Chinese Windows default). The loader now reads via `response.arrayBuffer()`, detects UTF-8 BOM (EF BB BF), UTF-16 LE BOM (FF FE), and UTF-16 BE BOM (FE FF) automatically, and strips the BOM before decoding. A three-way encoding selector (UTF-8 / GBK / UTF-16) is added to the toolbar so users can manually re-decode ANSI/GBK files that carry no BOM.

## [1.1.2] — 2026-06-21

### Fixed

- **PDF files >10MB now open as preview instead of triggering download**: `apps/desktop/src/main/ws-client/dir-handlers.ts` exempts `.pdf` from the 10 MB `PREVIEW_MAX_SIZE` guard in both `CMD_LIST_DIR` (`isPreviewable` flag) and `CMD_REQUEST_PREVIEW` (size check), since Chrome's built-in PDF renderer streams content rather than loading the whole file into memory first.
- **Duplicate clients in desktop client list and Messages sidebar**: `GET /hosts/:hostId/clients` (`apps/server/src/routes/hosts.ts`) now filters `revokedAt IS NULL` correctly via Drizzle's `isNull()` (the `and()` call previously received only one condition, so revoked sessions appeared in the list), and deduplicates by `clientId` keeping the most-recently-active session when a physical device has reconnected multiple times via PIN.
- **Preview modal no longer closes on backdrop click** (`apps/web/src/components/previews/FilePreview.tsx`): backdrop `onClick` handler removed; only the × button and ESC key close the modal.
- **Relay now forwards `CMD_UPLOAD_FILE_CHUNK` / `RESP_UPLOAD_ACK` / `RESP_UPLOAD_ERROR`**: handler switch in `apps/server/src/ws/handler.ts` now routes these upload message types, preventing silent frame drops.
- **IPC listener accumulation in desktop preload** (`apps/desktop/src/preload/index.ts`): each `on*` subscription now calls `ipcRenderer.removeAllListeners(channel)` before `ipcRenderer.on()`, preventing listeners from stacking on every React effect re-run.
- **Message ordering in desktop Messages page**: `getMessageHistory` returns rows `ORDER BY created_at DESC`; the rendered chat now reverses the mapped array on load and `.sort()`s `filteredMessages`, so conversations display oldest-at-top consistently even after the component remounts.
- **PDF preview blocked by Chrome ("该页面已被Chrome屏蔽")**: `PdfViewer.tsx` iframe `sandbox` changed from `"allow-scripts"` to `"allow-scripts allow-same-origin"` — Chrome 89+ requires `allow-same-origin` to activate its built-in PDF renderer; the blob URL is already scoped to our origin, so no additional trust boundary is opened.
- **Unsupported file types auto-downloading without user confirmation**: `handleFileClick` in `apps/web/src/app/dashboard/files/page.tsx` previously called `requestDownload` directly for non-previewable files. It now always opens `FilePreview`; `FilePreview.tsx` checks `localCategory === 'unknown'` up-front and renders `UnsupportedViewer` immediately (download button visible, no network request) — downloads only happen when the user explicitly clicks the download button.
- **Web client shows no message history after reconnecting or PIN-refreshing**: added `GET /messages/client/history` endpoint (`apps/server/src/routes/messages.ts`) that reads `clientId` + `hostId` from the client JWT and aggregates messages across all non-revoked sessions for that pair. `apps/web/src/store/app-store.ts::loadMessageHistory` now calls this endpoint (replacing the session-scoped `/messages/:sessionId` call) and sorts the merged history+real-time array by timestamp.
- **Desktop UI contrast improvements**: incoming message bubbles use `bg-secondary border border-border text-foreground` (was nearly invisible against the chat background); the send button disabled state uses `opacity-40` (was `bg-secondary`, indistinguishable from enabled); the selected-session highlight uses `bg-primary text-primary-foreground font-medium` (was low-contrast); dark-mode `--secondary` and `--border` CSS variables raised to perceptually distinct values.

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

- **01a-M5** — Three divergent message-type shapes: server DB (`id, session_id, direction,
  content, type, sender_id, ...`), desktop DB (`local_messages`, slightly different columns),
  and web store (inline `{ id, content, direction, type, timestamp }` object). A shared
  type would require aligning all three schemas. Maintenance/drift risk, not a current
  functional bug; deferred.
- **01b-M2 / 01a-M10** — Drizzle schema in `db/schema.ts` and raw DDL in
  `db/client.ts::initDatabase()` are a dual source of truth. Accepted trade-off per CLAUDE.md
  (P3-16 removed drizzle-kit migrations; Drizzle is type-safe queries only, not migration
  authority).

All P3/Low items from `.full-review/05-final-report.md` are addressed (P3-1 through
P3-18). All P1 items are addressed (P1-1 structured logging, P1-12 binary file-tunnel
framing, P1-23 auto-update pipeline, and the rest in Fixed above). The "test/doc gaps"
(#19) and relay room-state (P1-7) items are also done. All P2 items are fixed — Tracks
A–F in Security/Fixed above plus 02a-S13 (Host JWT rotation) and 02a-S11 (httpOnly cookie
tokens, implemented in the Unreleased section above).