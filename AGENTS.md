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

|`shared`|`packages/shared`|WS message types, REST API types, path-security utils, file-tunnel codec, JWT/rate-limit config constants, **protocol validators (V2)**, **range validation helpers (V2)**, **transfer engine model + base manager**|
|`server`|`apps/server`|Fastify relay — auth, routing, file proxy/tunnel, SQLite (Drizzle), security logs, **Transfer Engine registry (V2)**|
|`desktop`|`apps/desktop`|Electron 29 host — WS client to relay, local Fastify file server, auto-updater, embedded local relay, **per-transfer AbortController (V2)**|
|`web`|`apps/web`|Next.js 15 App Router client — Zustand store, WS manager, file browser/download UI, **active content isolation (V2)**|

### Connection flow

1. `POST /auth/register-host` → host row + Host JWT (90d)
2. `POST /auth/generate-pin` → 8-char PIN (bcrypt hash + HMAC index, 5 min TTL), shown out-of-band to user
3. `POST /auth/connect` (PIN) → client access JWT (2 h) + refresh JWT (30 d) set as **httpOnly cookies** (`rb_access`, `rb_refresh`, `SameSite=Strict`)
4. Both sides open WebSocket (`?type=host` with `Authorization: Bearer` / `?type=client` with 30s single-use ticket); relay routes by `sessionId` room

### File transfer

- **Download/preview:** web → relay issues `CMD_REQUEST_DOWNLOAD/PREVIEW` → host responds `RESP_*_READY` → relay hijacks HTTP reply and streams `CMD_FETCH_FILE` binary frames (256 KB chunks, 4 MB backpressure watermark, Range preserved for resume)
- **Upload (web → host):** chunked through WS relay using V2 binary frames
- **Binary framing:** non-empty chunks use self-describing binary WS frames (`file-tunnel-codec.ts`, ADR-004); empty/error stay JSON

### Security model

- Path allowlist (user config) + system-sensitive-blocklist (`security.ts`); blacklist checked BEFORE whitelist
- One-time UUID download tokens bound to `clientId`, 30 min TTL, SQLite-persisted
- Access/refresh JWTs signed with **independent** keys; refresh token has `use:'refresh'` claim (rejected on WS)
- WS auth via 30 s single-use ticket (`GET /auth/ws-ticket`) so tokens never appear in URLs (ADR `httponly-cookie-token-design.md`)
- Electron renderer: `sandbox: true`, strict CSP, sandboxed iframe for PDF preview
- Opaque `resourceId` registry (30 min TTL) so `filePath` never appears in URLs

### State

- **Relay:** in-memory single-instance room state (`connection-registry.ts`, ADR-005); restart self-heals via reconnect
- **Transfer Engine (V2):** in-memory transfer registry (`server/ws/file-tunnel.ts`) with per-transfer state machine, sequence/byte integrity validation, and session-scoped cancellation
- **Web:** Zustand store (`app-store.ts`) + store slices (`store/slices/`) + `electron-store`-style localStorage for session metadata and host history
- **Desktop:** `electron-store` (config with `safeStorage` encryption) + `better-sqlite3` (download tokens, auth); per-transfer `AbortController` registry (`desktop/ws-client/file-tunnel.ts`)

### Transfer Engine (V2 — RB-P0-01/02/03)

Protocol state machine:
```
CMD_FETCH_FILE → TRANSFER_ACCEPTED → STREAMING → COMPLETED
                                           ├── FAILED
                                           └── CANCELLED (via CMD_CANCEL_TRANSFER)
```

Key invariants:
- Each transfer has a unique `transferId` and explicit `TransferState` (PENDING → ACCEPTED → STREAMING → COMPLETED | FAILED | CANCELLED)
- Cancel is protocol-level (`CMD_CANCEL_TRANSFER`), idempotent, and propagates: browser close → Relay sends cancel → Host aborts disk read via `AbortController`
- Session revoke cancels all session-bound transfers before disconnecting client
- Sequence gaps and byte-count mismatches trigger `FAILED` state
- HTTP writable backpressure (`raw.write()` drain) propagates to Host disk read
- Audit log written on each cancellation (fire-and-forget to `security_logs`)

### Binary protocol framing

**Download direction** (Host→Relay, `file-tunnel-codec.ts`):
```
[0] version=1 | [1] flags (bit0=eof, bit1=hasMeta iff seq===0) | [2-3] transferIdLen u16BE
[...] transferId ASCII | [u32BE] seq
-- if hasMeta: totalSize u64BE, rangeStart u64BE, rangeEnd u64BE,
   contentTypeLen u16BE + UTF-8 bytes, fileNameLen u16BE + UTF-8 bytes
-- remaining bytes: raw chunk payload
```

**Upload direction** (Client→Relay→Host):
```
[0] version=1 | [1] flags (bit0=eof) | [2-3] transferIdLen u16BE | [...] transferId ASCII
[u32BE] seq | [u32BE] dataLen | [...] payload
```

Browser side hand-builds the same layout with `DataView` (no `Buffer` in browsers).

---

## Key Directories

### packages/shared/src
```
  index.ts                public barrel export
  ws-types.ts             WS message type enums (WSMessageType) + payload interfaces + TransferState enum
  ws-types-preview.ts     preview-specific message types
  file-tunnel-codec.ts    binary frame encode/decode (version, flags, transferId, seq)
  security.ts             path allowlist/blocklist validation, PIN generation, JWT/RATE_LIMIT config
  api-types.ts            REST DTOs (ApiResponse<T> envelope)
  file-utils.ts           file-category + size helpers
  ui-fonts.ts             shared font constants
  security-log-ui.ts      security log UI formatting helpers
  protocol/               V2: runtime WS-message validators (schemas.ts) + typed errors (errors.ts) + range validation
  transfer/               V2: TransferRecord model, ITransferManager interface, BaseTransferManager
```

### apps/server/src
```
  index.ts                Fastify bootstrap, plugin/route registration, /health, graceful shutdown
  routes/                 auth, hosts, messages, security-logs, proxy (REST API under /api/v1)
  ws/                     handler (WS lifecycle + dual auth), relay (routing + clientId/sessionId injection),
                          connection-registry (in-memory room state), file-tunnel (Transfer Engine state machine),
                          pending-requests (server-initiated CMD→RESP correlation), tickets (30s single-use)
  db/                     schema.ts (Drizzle: hosts, sessions, messages, security_logs), client.ts (init, retention)
  utils/                  pin (bcrypt + HMAC index), jwt (sign/verify), secrets (startup validation), logger (pino), cors
```

### apps/web/src
```
  app/                    Next.js App Router pages (dashboard, preview, files, messages, security, settings)
  store/app-store.ts      Zustand store (AppState) — central client state machine (actively used)
  store/slices/           P1-09 split stores: session, file, preview, message, transfer
  hooks/useWebSocket.ts   WS manager singleton (ticket connect, 401→refresh→retry, close-code handling)
  hooks/useFileStream.ts  file streaming hook
  hooks/usePreview.ts     file preview via proxy Blob URL (Range for >50MB)
  lib/api.ts              axios REST client (withCredentials, 401 deduped refresh)
  lib/download-manager.ts HTTP Range / resume downloader (sole RESP_DOWNLOAD_* consumer)
  lib/transfer/manager.ts WebTransferManager extends BaseTransferManager
  lib/logger.ts           thin console wrapper
  lib/env.ts              environment variable validation
  components/             FileList, DownloadPanel, Breadcrumb, previews/, ui/
```

### apps/desktop/src
```
  main/index.ts           Electron bootstrap, IPC registration, tray, file server, updater
  main/window.ts          BrowserWindow management (sandbox:true, CSP via onHeadersReceived)
  main/electron-binding.ts better-sqlite3 .node path hook (MUST be first import)
  main/token-rotator.ts   automatic host JWT rotation (≤30d remaining)
  main/tray.ts            system tray management
  main/ws-client/         relay WS client (client.ts, handlers.ts, dir-handlers.ts, file-tunnel.ts)
  main/file-server/       local Fastify file server (127.0.0.1) + token manager
  main/security/          path-guard.ts (symlink resolution, blacklist→whitelist, recursive permission), audit-logger.ts
  main/db/                better-sqlite3 client (allowed_directories, connected_clients, download_tokens, local_messages, access_logs)
  main/config/            electron-store configuration (safeStorage-encrypted secrets)
  main/local-relay.ts     embedded relay runner (utilityProcess.fork / spawn node)
  main/updater.ts         electron-updater (GitHub Releases)
  main/ipc/               auth, dirs, clients, messages, settings handlers
  preload/index.ts        contextBridge-exposed IPC (~40 invoke channels + 9 event:* push channels)
  renderer/               React UI (pages, App.tsx, theme, styles)
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

Vitest v2 across all four packages. No turbo test pipeline — run per-package:

```bash
# Per-package
pnpm --filter @remotebridge/shared test
pnpm --filter @remotebridge/server test      # auto-spawns relay on :3099 via test/global-setup.ts
pnpm --filter @remotebridge/web test         # happy-dom env
pnpm --filter @remotebridge/desktop test

# Watch mode
pnpm --filter @remotebridge/<pkg> test:watch
```

### Server test infrastructure

- `apps/server/test/global-setup.ts` — reuses an existing healthy relay on `:3099` (e.g. dev instance), else spawns `tsx src/index.ts` with temp `RB_DATA_DIR` and raised rate limits (`RL_REGISTER_MAX=100`, `RL_AUTH_MAX=100`); tears down on exit with Windows-aware retry (5× for ENOTEMPTY)
- `apps/server/test/helpers.ts` — `post()`, `postWithCookies()`, `openWs()`, `createSession()` (register→pin→connect), `waitForMessage()`, `waitForClose()`
- Server tests use **ordered** `it()` blocks with file-level mutable state (intentional, not concurrent)
- `rate-limit.test.ts`, `proxy-ratelimit.test.ts`, `session-lifetime.test.ts`, `startup-secrets.test.ts` spawn their **own isolated relay** on a free port for real limit testing

### Desktop test patterns

- `vi.hoisted(() => ({...}))` + `var` for module-level mutable mock state (survives `vi.mock` hoisting)
- Mocks relay client, db, electron `getPath`, path-guard, token-manager, logger
- `skipIf` for platform-specific tests (symlink needs Windows elevation/Dev Mode)

### Web test patterns

- `vi.mock` for `@/lib/api`, `@/store/app-store`, `@/lib/download-manager`, `sonner`
- Custom `MockWebSocket` class; `vi.stubGlobal('WebSocket', ...)`
- `vi.useFakeTimers()` + `advanceTimersByTimeAsync` for backoff tests

### Coverage

Only the **shared** package enforces coverage thresholds (v8: statements 65, branches 70, functions 80, lines 65). CI runs coverage for shared; server/web/desktop have no coverage gates.

|server|e2e, relay-roundtrip, session-flows, rate-limit, auth-cookie, startup-secrets, security-logs, messages-auth, host-token-refresh, pin-race, pin-hmac-bench, cors-whitelist, clientid-validation, proxy-ratelimit, session-lifetime|89|
|web|useWebSocket (reconnect, revoke, backoff), stores, preview-threshold, transfer-manager|20|
|desktop|file-server, handlers, path-guard, path-guard-v2, path-guard-symlink, upload-atomic, upload-streaming, upload-quota, range-validation, token-manager, file-tunnel, audit-log|66|
|shared|security, file-tunnel-codec, file-utils, protocol-schemas (V2), range-validation (V2), transfer-manager|56|

Recent fixes covered by tests: PIN atomic consumption (`pin-race.test.ts`), CORS whitelist (`cors-whitelist.test.ts`), upload quota enforcement (`upload-quota.test.ts`), path-guard symlink resolution (`path-guard-symlink.test.ts`), proxy rate limiting (`proxy-ratelimit.test.ts`), clientid validation (`clientid-validation.test.ts`), session lifetime expiry (`session-lifetime.test.ts`).
---

## Code Conventions & Patterns

### Shared package is the contract

- `@remotebridge/shared` is imported by server, web, and desktop. Edit it first, then `pnpm --filter @remotebridge/shared build` before other packages see changes.
- WS message types live in `ws-types.ts`; extend the `WSMessageType` enum rather than ad-hoc strings.
- Binary frame changes must follow `file-tunnel-codec.ts` version/flags scheme (ADR-004).
- **Protocol validation (V2):** all incoming JSON WS messages are validated via `validateMessage()` from `shared/protocol/schemas.ts` at the handler boundary; never use `payload: any` — use typed payloads from `ws-types.ts`.
- **Range validation (V2):** use shared `parseRangeHeader()` + `validateRangeAgainstSize()` for all Range header parsing; never silently clamp unsatisfiable ranges — return 416.

### Server (Fastify + Drizzle)

- Routes are plugin functions registered under `/api/v1`. Each route file exports a single `async (app) =>` function.
- Rate limiting: `@fastify/rate-limit` with `global: false`, per-route overrides from shared `RATE_LIMIT_CONFIG`.
- Logging: pino via `utils/logger.ts` — **no** `console.*` (ADR `observability-logging-design.md`).
- JWT: `utils/jwt.ts` signs/verifies; `utils/secrets.ts` validates strength at startup in production (≥32 chars, non-default, independent, non-derived).
- File proxy uses `reply.hijack()` for raw streaming; manual CORS headers via `corsHeadersFor()`.
- **Routing contract:** relay injects `clientId`/`sessionId`/`messageId` into payloads; hosts MUST echo `clientId`/`sessionId` back (withRouting helper) or responses cannot be routed.
- **Non-fatal fire-and-forget:** message persistence, audit logs, and toast triggers use `void promise.catch(log)` — persistence failure never blocks relay routing.
- RESP_FILE_* must never be relayed to clients; binary frames from hosts must never be forwarded raw.

### Web (Next.js 15 + Zustand)

- State: `useAppStore` (monolith, actively used) + `store/slices/` (split stores: session/file/preview/message/transfer). WS manager is a separate module singleton (`hooks/useWebSocket.ts`).
- StrictMode-safe: WS connect must collapse concurrent calls via `connectPromise` dedup.
- **Preview security (V2):** active content (html/htm/xhtml/svg) must be forced to attachment (`Content-Disposition: attachment; application/octet-stream`), never inline preview. All preview/download responses include `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Preview responses add `Content-Security-Policy: sandbox`.
- No `middleware.ts` — security headers centralized in `next.config.mjs` via `headers()`.

### Desktop (Electron 29 + electron-vite)

- Main/renderer/preload split. `electron-binding.ts` **must** be the first import (redirects `better_sqlite3` `.node` path via `Module._resolveFilename` hook).
- IPC: handlers registered in `main/ipc/*`, exposed to renderer through `preload/index.ts` `contextBridge`.
- IPC invoke channels namespaced `domain:action` (auth:, dirs:, clients:, messages:, settings:, relay-local:, updater:, system:, host:, upload:, logs:, notification:, relay:).
- Push channels `event:*` (client-joined/left, connection-status, new-message, session-revoked, file-received, update-status, local-relay-status/log). Preload auto-cleans listeners before re-subscribing.
- Auto-updater: `electron-updater` against GitHub Releases (`main/updater.ts`).
- Local relay: bundled via `apps/desktop/scripts/bundle-relay.mjs` (esbuild → single CJS under `resources/relay`), managed from Settings UI.

### Cross-cutting

- **Path validation (defense in depth, 3 layers):** (1) shared `validateDirectoryRequest` (platform-correct path semantics); (2) desktop `path-guard.ts` adds `realpathSync` symlink resolution + longest-match recursive permission; (3) every file-serving surface re-validates against the CURRENT whitelist — tokens are never trusted alone. Blacklist beats whitelist.
- **Error handling:** server uses Fastify error replies; desktop wraps and surfaces via IPC; web surfaces via `sonner` toasts + store error state. Protocol errors (`protocol/errors.ts`) are typed (InvalidEnvelopeError, InvalidPayloadError, InvalidBinaryFrameError) — treat as malformed input, never crash the socket.
- **Logging:** server=pino, desktop=electron-log, web=thin console wrapper (`lib/logger.ts`).
- **Tokens/credentials** never in URLs, response bodies (cookie path), or JS-readable storage.
- Comments and user-facing messages are predominantly Chinese; code identifiers are English.

---

## Important Files

|File|Purpose|
|---|---|
|`packages/shared/src/ws-types.ts`|Single source of truth for all WS message types|
|`packages/shared/src/file-tunnel-codec.ts`|Binary frame wire format|
|`packages/shared/src/security.ts`|Path allowlist/blocklist, PIN gen, JWT/RATE_LIMIT config|
|`packages/shared/src/protocol/schemas.ts`|V2: runtime WS-message validators (validateMessage, validatePayload)|
|`packages/shared/src/protocol/errors.ts`|V2: typed protocol errors (ProtocolError, InvalidEnvelopeError, InvalidPayloadError)|
|`packages/shared/src/transfer/model.ts`|V2: TransferRecord, ITransferManager, TransferEvent, defaults|
|`packages/shared/src/transfer/manager.ts`|V2: BaseTransferManager reference state machine|
|`apps/server/src/ws/file-tunnel.ts`|V2: Transfer Engine registry (begin/cancel/endFileTransfer, state machine, sequence/byte integrity)|
|`apps/server/src/ws/connection-registry.ts`|In-memory room state (4 Maps + WeakMap meta)|
|`apps/server/src/ws/handler.ts`|WS lifecycle, dual auth (ticket/JWT), heartbeat, message routing|
|`apps/server/src/ws/relay.ts`|Routing layer (clientId/sessionId/messageId injection)|
|`apps/desktop/src/main/ws-client/file-tunnel.ts`|V2: Host file tunnel with per-transfer AbortController cancellation|
|`apps/desktop/src/main/security/path-guard.ts`|Host-side validatePath (symlink resolution, blacklist→whitelist)|
|`apps/desktop/src/main/file-server/server.ts`|Local Fastify file server (127.0.0.1) with token auth|
|`apps/server/src/routes/auth.ts`|PIN, register, connect, refresh, WS ticket, host-token-refresh|
|`apps/server/src/routes/proxy.ts`|File download/preview proxy + tunnel streaming (reply.hijack)|
|`apps/server/src/db/schema.ts`|Drizzle schema (hosts, sessions, messages, security_logs)|
|`apps/web/src/store/app-store.ts`|Central client state machine (monolith)|
|`apps/web/src/hooks/useWebSocket.ts`|WS connection manager (reconnect, revoke, backoff, ticket auth)|
|`apps/desktop/src/main/index.ts`|Electron bootstrap + IPC registration|
|`apps/desktop/src/main/local-relay.ts`|Embedded relay lifecycle (utilityProcess.fork / spawn)|
|`apps/desktop/src/preload/index.ts`|contextBridge IPC (~40 invoke + 9 event channels)|
|`apps/desktop/electron.vite.config.ts`|Build config (native module externals, CJS interop, pre-bundle shared)|
|`apps/web/next.config.mjs`|Security headers (CSP, X-Frame-Options, etc.), standalone output, webpack fallbacks|
|`.github/workflows/ci.yml`|CI: build → typecheck → lint → test (windows matrix for desktop path-guard)|
|`docker-compose.yml`|server + web + Caddy (auto TLS via `DOMAIN`), ADR-005 replicas:1 guard|
|`apps/desktop/electron-builder.config.js`|Installer config (win/mac/linux), GitHub publish|

---

## Runtime / Tooling Preferences

- **Node:** >= 20 (`engines` in root `package.json`)
- **Package manager:** pnpm 9.1.0 (`packageManager` field) — do not use npm/yarn
- **Monorepo orchestration:** Turborepo 1.x (`turbo.json`)
- **Build:** server/desktop use CommonJS output; web uses Next.js standalone output; shared must build before dependents
- **Runtime constraint:** `better-sqlite3` is a native module — must be compiled for the correct ABI (Node for server, Electron for desktop); the cached electron binary lives at `.cache/better_sqlite3.electron.node`
- **Vite interop:** `electron.vite.config.ts` sets `ignoreDynamicRequires: true` so `bindings()` dynamic `require` survives bundling; `optimizeDeps.include: ['@remotebridge/shared']` prevents ESM/CJS interop crash in dev
- **Shared CJS/ESM boundary:** every consumer needs special handling — server via workspace+CJS tsc, web via `transpilePackages`+webpack fallbacks, desktop via `optimizeDeps`+explicit `dist` alias. This is the most fragile part of the build.

### Environment variables

Server (`apps/server/.env`): `JWT_SECRET`, `JWT_REFRESH_SECRET` (required, ≥32 chars, non-default, independent, non-derived in production), `ALLOWED_ORIGINS`, `RELAY_PORT` (3002), `RELAY_HOST`, `RB_DATA_DIR`, `NODE_ENV` (production enforces secret strength), `RATE_LIMIT_MAX` (10), `RATE_LIMIT_WINDOW` (60000), `LOG_LEVEL`, `RB_INSTANCE_ID`.

Web (build-time, public): `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` — embedded at build, require rebuild to change.

Desktop (runtime): `RELAY_URL`, `RELAY_API` (fallback ws/http://127.0.0.1:3002), `ELECTRON_RENDERER_URL` (dev), `LOG_LEVEL`.

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
|**Docker Compose** (recommended)|`docker compose up -d` — server + web + Caddy (set `DOMAIN` for Let's Encrypt). ADR-005 `replicas:1` guard on server.|
|**Bare metal**|`bash scripts/deploy-server.sh` → `tsc` → systemd (`deploy/systemd/remotebridge-server.service`, `Restart=on-failure`)|
|**Desktop installers**|`pnpm --filter @remotebridge/desktop package:win` (also `:mac`, `:linux`) — bundles relay via `bundle-relay.mjs` first|

Health check: `GET /health` returns relay status, DB writability probe, per-table row counts, `instance_id`.

Auto-update: desktop checks GitHub Releases on startup (electron-updater).

Crash recovery: Docker `restart: unless-stopped` / systemd `Restart=on-failure` + exponential backoff reconnect (1s→30s) + HTTP Range resume.

Rollback: `git checkout <prior-tag>` → `docker compose build` → `docker compose up -d`.

---

## Docs & Runbooks

- `README.md` (Chinese) / `README.en.md` (English) — user-facing quick-start
- `生产环境部署与使用指南.md` — **ops runbook**: VPS setup, crash recovery (§7.3), data retention (§7.4), health monitoring (§7.6), host JWT rotation (§7.7), ops cheatsheet (§8), FAQ (§9), security hardening (§10)
- `使用说明书.md` — end-user manual
- `CHANGELOG.md` — developer-facing version history
- `docs/adr/` — architecture decision records (template: `template.md`)
- `.full-review/` — periodic repo-wide review reports (latest `05-final-report.md`, 86 findings across P0–P3)
- `release-notes/TEMPLATE.md` — release-notes writing standard

### Git 提交规则

  - commit message 中禁止包含任何 `Co-Authored-By` 署名（包括但不限于 Claude、Anthropic、noreply@anthropic.com 等任何 AI 相关署名）

  - 所有提交仅保留用户本人的 git 作者信息（`用户名 <邮箱>`）

  - 创建 PR 时同样不添加任何 AI 合作者信息

### 仓库管理硬性规则（永远不可违反）

  - **禁止修改公共仓库的可见性**：不得将任何公开（public）仓库切换为私有（private）或内部（internal），即使是为了清除 contributor 缓存、刷新索引或其他任何原因。此操作会导致 star 和 fork 数据永久丢失。

  - **禁止通过 `gh repo edit --visibility` 切换任何仓库的可见性**：除非用户明确要求且已书面确认接受丢失 star/fork 的后果。

  - **禁止通过其他任何手段（API、浏览器设置等）修改仓库可见性**：本规则覆盖所有可能的可见性修改方式。
