# Phase 1: Code Quality & Architecture Review

Full detail: `01a-code-quality.md` (28 findings) and `01b-architecture.md` (10 findings + cross-cutting analysis). This file consolidates the Critical/High findings and summarizes the rest.

## Code Quality Findings (01a)

### Critical

**C1 — Multiple `Math.random()` ID generators compromise deduplication guarantees**
`apps/server/src/ws/relay.ts:168-170`, `apps/desktop/src/main/ws-client/client.ts:233-235`, `apps/web/src/hooks/useWebSocket.ts:249-251`. Three independent `Math.random().toString(36)` ID generators are used for WS message `id` fields that double as DB dedup keys, while `shared/security.ts::generatePin()` correctly uses `crypto.getRandomValues`. Fix: add `generateSecureId()` to shared (crypto-based) and use it in all three places.

### High

| ID | Finding | Location |
|----|---------|----------|
| H1 | `console.log/error/warn` scattered across ~40+ production paths instead of structured (pino/electron-log) logging | `ws/relay.ts`, `ws/handler.ts:326`, `db/client.ts`, `routes/proxy.ts`, desktop `ws-client/*`, `security/audit-logger.ts`, web `useWebSocket.ts` |
| H2 | `usePreview` attaches a per-request raw `message` listener with no cancellation of prior requests — listener/timeout leak on rapid preview switching or unmount | `apps/web/src/hooks/usePreview.ts:72` |
| H3 | `dir-handlers.ts` duplicates and diverges from `shared/file-utils.ts`'s `PREVIEWABLE_TYPES`/`isPreviewableFile`/`getFileCategory` — host and web client can disagree on what's previewable | `apps/desktop/src/main/ws-client/dir-handlers.ts:426-447` vs `packages/shared/src/file-utils.ts` |
| H4 | `notifyAndDisconnectClient` returns `void` and only `console.log/error`s — callers (session revocation) can't detect a failed disconnect | `apps/server/src/ws/relay.ts:143-165` |
| H5 | Desktop `client.ts::send()` silently drops messages when WS not OPEN, no queue/return value — especially dangerous for `RESP_FILE_CHUNK` (truncated downloads with no error) | `apps/desktop/src/main/ws-client/client.ts:150-160` |
| H6 | `/access-logs` uses an inline ad-hoc host-only auth check while the adjacent `/security-logs/events` uses `resolveScopedHostId()` — inconsistent auth pattern between neighboring endpoints | `apps/server/src/routes/security-logs.ts:160-196` vs `209-281` |

### Medium (10) / Low (10) — summary by theme

- **Type safety**: `as any` forest around `(ws as any).__meta` connection metadata (M1) — recommend a typed `socket-meta.ts` accessor.
- **DRY violations**: duplicated proxy download/preview handler logic (M9), duplicated `formatFileSize`/`formatSize` (L3), duplicated PIN-expiry constant (M6), duplicated pagination query construction (covered again in 01b L4).
- **Schema drift risk**: no migration/version-check mechanism for `CREATE TABLE IF NOT EXISTS` (M10) — overlaps with 01b's M2.
- **Readability**: over-engineered `generatePin` buffer sizing (M2); `O(n²)`-ish dedup Set rebuild in `app-store.ts::loadMessageHistory` (M3); `direction` field semantics on host `MSG_TEXT` persistence (M7); routing-field contract violation logged nowhere (M8, overlaps 01b H1/Cross-Cutting).
- **Frontend robustness**: `download-manager.ts` anchor-element removal race with async save dialogs (M4); blob URL revoked after fixed 60s timeout (L10); message type fragmentation across shared/app-store/desktop schema (M5).
- **Stale TODOs / dead code**: `rooms.ts::getRoomInfo` `hostName` always `''` (L1, overlaps 01b L2); stale `CLIENT_JOINED` TODO in `auth.ts:272` (L2).
- **Shutdown/startup robustness**: unhandled `app.close()` rejection before `process.exit(0)` (L5); silent `electron-binding.ts` dlopen fallback (L6); `initDatabase()` called at module scope on desktop (L8); `localStorage` host-info sync across tabs (L9); `verifyAccessToken` used where `verifyToken`/host-only check would suffice (L7).

---

## Architecture Findings (01b)

### Critical

**C1 — Host audit logging targets a non-existent relay endpoint (`POST /security-logs` doesn't exist)**
`apps/desktop/src/main/security/audit-logger.ts:32` POSTs every access/security event to `${relayApi}/security-logs`, but `apps/server/src/routes/security-logs.ts` registers **GET only**. Every host-originated audit POST 404s and is swallowed by the fire-and-forget catch. Consequence: `BLOCKED_PATH` events are **never written by anyone**, so `GET /access-logs` is permanently empty, and the relay-side security dashboard is non-functional for all host-side events — directly contradicting CLAUDE.md's "load-bearing" audit-trail description.

**C2 — `messages.ts` REST routes use `verifyToken` instead of `verifyAccessToken`, allowing refresh tokens to act as access tokens**
`apps/server/src/routes/messages.ts:6,32,136`. Every other authenticated REST route (`hosts.ts`, `proxy.ts`, `auth.ts`, `security-logs.ts`) was migrated to `verifyAccessToken` (rejects `use:'refresh'`). `messages.ts` was missed — a partial regression of the prior review's §2.1 fix. A 30-day refresh token can read full message history and inject messages via REST, bypassing the 2h access-token lifetime.

### High

| ID | Finding | Location |
|----|---------|----------|
| H1 | `relay.ts`/`rooms.ts` split has fractured into **three** independent serialization paths (relay.ts `generateId`+sessionId; rooms.ts `nanoid`+no sessionId; per-endpoint `send()`). The REST message-send fallback (`messages.ts:201` → `sendToHost`) does **not** inject `sessionId`/`senderType`/`messageId` per `RelayRoutingFields`, so REST-sent messages get a different dedup key than WS-sent ones — reintroducing the duplication bug the routing contract was meant to prevent. | `ws/relay.ts:22-32,168`, `ws/rooms.ts:71-114`, `routes/messages.ts:201-215` |
| H2 | Room state (`hostSockets`/`clientSockets`/`sessionRooms`) is module-private in `handler.ts`, **push-injected** into `relay.ts` via `initRelay()`, while `rooms.ts` **pull-imports** the same Maps directly from `handler.ts` — circular import, temporal coupling (relay fns crash if `initRelay` hasn't run), and the single-instance trade-off (ADR-005) is now structural rather than a deployment choice. | `ws/handler.ts:21-23,43`, `ws/relay.ts:6-19`, `ws/rooms.ts:4` |
| H3 | Shared `AccessLog.action` union (`'LIST_DIR'\|'DOWNLOAD'\|'PREVIEW'`) and `SecurityLog.eventType` don't include values the host actually emits (`LIST_ALLOWED`, `TUNNEL_FETCH`, `ACCESS`) — only compiles because emission sites type `action` as bare `string`. Contract rot: types describe an older reality than the code. (The `ACCESS`/schema-enum mismatch and C1's missing endpoint mask each other.) | `packages/shared/src/api-types.ts:134,141-148` vs `dir-handlers.ts:62`, `file-tunnel.ts:57,75` |

### Medium (4) / Low (5) — summary

- **M1**: Host `path-guard.ts` uses the **raw static** `SYSTEM_BLOCKED_DIRS[platform]` and never calls shared `getWindowsBlockedDirs()` — Windows hosts don't blacklist `%APPDATA%`/`%LOCALAPPDATA%` even though the shared validator does. Also, `getWindowsBlockedDirs()` itself **mutates** the shared module-level array via `base.push(...)` — a latent purity bug that grows the blacklist on repeated calls.
- **M2**: Drizzle `schema.ts` and hand-written `CREATE TABLE` DDL in `db/client.ts` are two unsynced sources of truth (server and desktop both); desktop additionally uses `as any` on every DB read, so security-critical `permission`/`is_active`/`recursive` flow through path-guard untyped. (Overlaps 01a M10.)
- **M3**: `usePreview.ts` reproduces the per-request raw-listener anti-pattern the server's `pending-requests.ts` registry was built to eliminate — the web client has two different response-dispatch architectures (preview vs. download, the latter via the correct centralized `useWebSocket` switch).
- **M4**: Three different "host online" notions disagree — `/auth/connect` hardcodes `hostInfo.online: true` regardless of actual WS liveness, while `hosts/:id/status` and the proxy correctly check the room map.
- **L1–L5**: debug `console.*` in `notifyAndDisconnectClient`; dead `hostName` TODO in `getRoomInfo` (same as 01a L1); `await`ed fire-and-forget access-log write delays proxy hot path; duplicated pagination query construction in `messages.ts`; `RespFileChunkPayload` redundantly resends `contentType`/`fileName`/`totalSize` on every chunk.

### Cross-cutting (from 01b)

- The `RelayRoutingFields`/`withRouting()` contract is enforced by convention, not by the type system or send boundary — `sendToClient`/`sendToHost` accept any `Partial<WSMessage>` (root cause of H1).
- Auth is the most-duplicated, least-abstracted server concern: every route hand-rolls the same ~15-line extract→verify→401→type-check block; the one place it drifted (`messages.ts`) is C2. A `requireHost`/`requireClient` Fastify preHandler would make that class of bug impossible.
- What's genuinely solid and should be preserved: the outbound-only relay-room topology; the dual path-validation algorithm (`resolve` + separator-prefix matching) in `shared/security.ts`; the WS file-tunnel backpressure design (ADR-004); the server-side `pending-requests.ts` registry pattern; persistent host identity reuse; reconnect/auth-recovery state machines on both ends.

---

## Critical Issues for Phase 2 Context

**Security-relevant (feed to 2A):**
- 01b-C1: Relay-side security audit log is broken by contract — `POST /security-logs` doesn't exist, so `BLOCKED_PATH` (the most security-relevant event type) is never recorded server-side. Treat the "load-bearing" audit trail claim in CLAUDE.md as currently false for host-originated events.
- 01b-C2: `messages.ts` GET/POST routes accept refresh tokens as access tokens (missed migration to `verifyAccessToken`) — a real auth bypass, partial regression of a previously-fixed P1.
- 01b-H3 / 01a's `ACCESS` eventType mismatch: shared `AccessLog`/`SecurityLog` enums don't match emitted values — check whether this masks any other validation gaps in the security-log pipeline.
- 01b-M1: Host `path-guard.ts` doesn't blacklist `%APPDATA%`/`%LOCALAPPDATA%` on Windows (shared validator does but isn't used) — combined with a recursive whitelist entry on `C:\Users\<name>`, this exposes credential stores/browser profiles. Also flag the `getWindowsBlockedDirs()` array-mutation bug as a correctness issue independent of security.
- 01a-C1: Non-cryptographic `Math.random()` IDs used as dedup/session-routing keys — assess collision/predictability risk in the auth and message-routing paths.

**Performance-relevant (feed to 2B):**
- 01a-H2: `usePreview` listener/timeout leak on rapid requests or unmount — potential memory growth in long sessions.
- 01a-H5: Desktop `send()` silently drops file-tunnel chunks under brief disconnects — truncated downloads with no retry/backpressure-correct error path.
- 01a-M3: `app-store.ts::loadMessageHistory` rebuilds a `Set` of all message IDs on every history load — O(n·m) for long-running sessions.
- 01b-H1/H2: Three divergent serialization paths and module-singleton room-state — assess whether this creates redundant work or contention under load, beyond the correctness issues already noted.
