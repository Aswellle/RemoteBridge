# RemoteBridge — Architectural Design & Structural Integrity Review

**Reviewer role:** Software Architect
**Scope:** Full monorepo (`packages/shared`, `apps/server`, `apps/desktop`, `apps/web`), ~81 source files
**Method:** Full read of the protocol contract, relay routing/WS layer, host agent, web client, plus cross-tier trace of the CMD/RESP routing contract and the security model.

## Executive Summary

The system is built on a genuinely sound macro-architecture: the outbound-only relay-room model is a clean, defensible answer to the "no inbound ports on the host" constraint; the dual-validation security model (whitelist + system blacklist + `resolve` + separator matching) is textbook; and the WS file-tunnel design (ADR-004) is a creative, correct solution to the 127.0.0.1 reachability problem. The June 2026 review's P0–P2 fixes are all present and the routing contract is now codified in `RelayRoutingFields`.

That said, the codebase carries real **structural debt** that the prior review either deferred or did not surface. The most consequential issues are: (1) a **broken audit trail** — the host fires every access event at a `POST /security-logs` endpoint **that does not exist**, so the relay-side security log is silently empty except for what the relay writes itself; (2) the documented **`relay.ts` / `rooms.ts` split has diverged into three independent serialization paths** with inconsistent ID generation and field handling, and the REST message-send path bypasses the routing-field contract entirely; (3) the **module-level singleton + injected-Map pattern** in the WS layer creates hidden temporal coupling and makes the single-instance constraint structural rather than incidental; and (4) several **type-contract violations** where the shared `AccessLog`/`SecurityLog` enums do not match what the host actually emits.

None of these are "the product doesn't work" — they are integrity issues that will bite during evolution, multi-instance scaling, or any audit/compliance requirement.

---

## Findings

### CRITICAL

---

#### C1. Host audit logging targets a non-existent relay endpoint — the relay-side security log is broken by contract

**Files:** `apps/desktop/src/main/security/audit-logger.ts:32`, `apps/server/src/routes/security-logs.ts` (entire file)

`audit-logger.ts` POSTs every access and security event to `${relayApi}/security-logs`:

```ts
await axios.post(`${getRelayApi()}/security-logs`, { eventType: 'ACCESS', clientId, action, path, status }, ...)
```

But `security-logs.ts` registers **only `GET` handlers** (`/security-logs`, `/security-logs/events`, `/access-logs`). A grep across `routes/` confirms there is no `POST /security-logs` anywhere. Every host-originated audit POST returns 404 and is swallowed by the fire-and-forget `catch`.

**Architectural impact:** The security model documented as "load-bearing" in CLAUDE.md states all access attempts "go through `audit-logger.ts` (writes to both local DB **and** relay security-logs endpoint)." That second leg is dead. The relay's `security_logs` table only ever contains what the *relay itself* inserts: `AUTH_FAIL`, `SESSION_CREATED`, `REVOKE`, `ACCESS_DOWNLOAD`/`ACCESS_PREVIEW` (proxy path only). **`BLOCKED_PATH` events are never written by anyone** — which means `GET /access-logs` (which filters `eventType = 'BLOCKED_PATH'`) returns an empty set permanently, and the host's path-block events (the single most security-relevant signal) exist only in the host's local SQLite, invisible to the relay-side security dashboard. This is a silent, total failure of the cross-tier audit contract.

**Recommendation:** Add a `POST /security-logs` route that authenticates the host JWT and maps the host's payload (`eventType`/`action`/`status`/`path`) into the `securityLogs` schema, normalizing `BLOCKED` statuses to `BLOCKED_PATH`. Add a contract test asserting a host-emitted blocked-path event is queryable via `GET /access-logs`. Until then, treat the relay security dashboard as non-functional for host-side events.

---

#### C2. `verifyToken` (not `verifyAccessToken`) on the message REST routes lets a refresh token act as an access token

**File:** `apps/server/src/routes/messages.ts:6,32,136`

Every other authenticated REST route was migrated to `verifyAccessToken` (which rejects `use:'refresh'`) — confirmed by grep: `hosts.ts`, `proxy.ts`, `auth.ts`, `security-logs.ts` all use `verifyAccessToken`. **`messages.ts` still uses the raw `verifyToken`** on both `GET /messages/:sessionId` and `POST /messages/:sessionId`.

**Architectural impact:** This re-opens, on one route family, exactly the vulnerability the prior review's §2.1 closed. A 30-day refresh token can read full message history and inject messages into a session via REST — bypassing the 2-hour access-token lifetime. It is a partial regression of a P1 fix that slipped through because the migration to `verifyAccessToken` was done route-by-route rather than via a shared auth pre-handler. The WS handler (`handler.ts:89`) also uses `verifyToken`, but compensates with an explicit `use === 'refresh'` check; `messages.ts` has no such compensation.

**Recommendation:** Replace `verifyToken` with `verifyAccessToken` in `messages.ts` (2 sites). Structurally, the deeper fix is **the absence of an auth abstraction**: every route re-implements the same 15-line `extractTokenFromHeader → verify → 401 → check type` block. Extract a Fastify `preHandler` / decorator (`requireClientOrHost`, `requireHost`) so token-class enforcement cannot drift per-route again. This single missed call is direct evidence that copy-paste auth is unsafe at this scale.

---

### HIGH

---

#### H1. The `relay.ts` / `rooms.ts` split has fractured into three serialization paths with inconsistent IDs and inconsistent routing-field handling

**Files:** `apps/server/src/ws/relay.ts:22-32,168` · `apps/server/src/ws/rooms.ts:71-114` · `apps/server/src/routes/messages.ts:201-215`

CLAUDE.md documents the relay.ts/rooms.ts overlap as "a source of inconsistency to be aware of." In practice it is worse than two paths — there are **three independent message-serialization implementations**, each re-deriving the wire frame by hand:

1. `relay.ts::sendWSMessage` — uses `generateId()` (`Math.random`), includes `sessionId`, omits `senderId`/`senderType` at top level unless caller set them.
2. `rooms.ts::sendToClient`/`sendToHost`/`broadcastToHostClients` — each independently `JSON.stringify` a frame with `nanoid()` IDs and **no `sessionId` field at all**.
3. `client.ts`/`useWebSocket.ts`/`app-store.ts` on the endpoints — each have their own `send()` doing the same stringify.

The concrete consequence is in `messages.ts:201`'s REST fallback: it calls `sendToHost(...)` with a payload of `{ content, senderId, clientId }` — but it does **not** inject `sessionId`/`senderType`/`messageId` into the payload the way `relay.ts::relayMessage` does (the documented `RelayRoutingFields` contract). So a message delivered to the host via the WS path and the same message delivered via the REST fallback arrive with **different payload shapes**. The host's `MSG_TEXT` handler reads `payload.sessionId` and `payload.messageId` for persistence/dedup (`handlers.ts:51-53`); via the REST path those are absent, so the host persists with a fresh nanoid and **the dedup key diverges** — the exact "same message, two IDs" duplication the relay-side `handler.ts` comment warns about, reintroduced on the REST leg.

**Architectural impact:** The routing-field contract (`RelayRoutingFields` + `withRouting()`) is only honored on one of the two send paths. The contract is "codified into the protocol" at the type level but **not enforced at the send boundary** — `sendToClient`/`sendToHost` accept `Partial<WSMessage>` and will happily ship a contract-violating frame. This is the structural root of the "overlapping functions, different callers" smell: the abstraction boundary is wrong. There should be one `serializeFrame()` and one set of `routeToClient`/`routeToHost` primitives, with the routing-field injection living *inside* them, not duplicated in `relayMessage` and skipped in `messages.ts`.

**Recommendation:** Collapse the three serialization paths into a single `frame.ts` (one `sendFrame(ws, partial)`); delete `rooms.ts`'s bespoke `send*` and have REST routes call the same `routeToClient`/`routeToHost` from `relay.ts`, moving routing-field enrichment *into* those functions so no caller can bypass it. Standardize on one ID generator (prefer `nanoid` everywhere — `Math.random`-based `generateId` in `relay.ts:168` is non-cryptographic and collision-prone for a dedup key). This directly resolves the documented inconsistency rather than just documenting it.

---

#### H2. WS room state uses module-level singletons + runtime Map injection, hard-wiring the single-instance constraint and creating temporal coupling

**Files:** `apps/server/src/ws/handler.ts:21-23,43` · `apps/server/src/ws/relay.ts:6-19` · `apps/server/src/ws/rooms.ts:4`

The three room Maps are module-private in `handler.ts`, then **injected at runtime** into `relay.ts` via `initRelay(...)`, while `rooms.ts` reaches *back into* `handler.ts` with a direct `import { hostSockets, clientSockets, sessionRooms } from './handler'`. So you have two different sharing mechanisms for the same three Maps (push-injection into relay, pull-import into rooms), plus a circular import (`handler` → `relay` for functions; `rooms` → `handler` for state; `handler` → `rooms` indirectly via `hosts.ts`/`messages.ts`).

**Architectural impact:**
- **Temporal coupling:** `relay.ts`'s functions throw/no-op if `initRelay` hasn't run. Any new caller of `relayToClient` before `setupWebSocket` runs gets undefined-Map crashes. The dependency on initialization order is invisible at the call site.
- **The single-instance constraint (ADR-005) is now structural, not a deployment choice.** Because room state is captured in module closures and shared by direct import, there is no seam to swap in a Redis/shared backing store. The accepted trade-off ("single instance") has hardened into "single instance is the only thing the code shape permits." Honest abstraction would put room state behind a `RoomRegistry` interface (in-memory impl today, pluggable later) — that's the difference between a documented trade-off and a painted-into-corner.
- **Mixed coupling directions:** `relay.ts` (lower-level routing) is injected *by* `handler.ts`, but `rooms.ts` (also lower-level) imports *from* `handler.ts`. There's no consistent dependency direction; `handler.ts` is simultaneously the composition root, the message loop, and the state owner.

**Recommendation:** Introduce a `RoomRegistry` class/module that owns the three Maps and exposes `getHost/getClient/setRoom/forEachClient/...`. Have `handler.ts`, `relay.ts`, and `rooms.ts` all depend on the registry (constructor injection or a single imported instance), eliminating both the `initRelay` push and the `rooms→handler` pull. This breaks the circular import, removes the temporal coupling, and creates the seam needed if multi-instance ever becomes a requirement.

---

#### H3. Type-contract violations between shared enums and host-emitted values

**Files:** `packages/shared/src/api-types.ts:141-148` (`AccessLog.action`) and `:134` (`SecurityLog.eventType`) vs. `apps/desktop/src/main/ws-client/dir-handlers.ts:62`, `file-tunnel.ts:57,75`

The shared `AccessLog.action` type is `'LIST_DIR' | 'DOWNLOAD' | 'PREVIEW'`. The host emits actions outside this union:
- `dir-handlers.ts:62` → `action: 'LIST_ALLOWED'`
- `file-tunnel.ts:57,75` → `action: 'TUNNEL_FETCH'`

Neither is in the type. It compiles only because `db.insertAccessLog` and `logAccess` type `action` as a bare `string` (`db/client.ts:104`, `audit-logger.ts:17`) — the shared contract type is **never actually applied** at the emission site, so the enum silently lies about the data's domain. Same class of issue: the relay's `securityLogs.eventType` schema enum (`schema.ts:61`) has no `'ACCESS'` member, yet `audit-logger.ts:34` POSTs `eventType: 'ACCESS'` — which would be rejected by the schema's CHECK/enum if the endpoint existed (see C1), so the two bugs mask each other.

**Architectural impact:** The "shared package is the protocol contract" principle is undermined when the contract types are defined but not enforced at the boundaries that produce/consume the data. A consumer reading `AccessLog.action` and exhaustively `switch`-ing over the union will silently miss `LIST_ALLOWED`/`TUNNEL_FETCH` rows. This is contract rot: the types describe an older reality than the code.

**Recommendation:** Either widen the shared `AccessLog.action` / `SecurityLog.eventType` unions to include `LIST_ALLOWED`, `TUNNEL_FETCH`, `ACCESS` (and `LIST_ALLOWED` status `OK`), or constrain the host to the existing vocabulary. Then **apply the shared type at the emission site** (`logAccess(event: { action: AccessLog['action']; ... })`) so the compiler enforces the contract instead of `string` defeating it. The shared package only earns its "contract" status if violations fail to compile.

---

### MEDIUM

---

#### M1. Host-side path-guard omits the Windows `%APPDATA%`/`%LOCALAPPDATA%` blacklist that the shared validator includes

**Files:** `apps/desktop/src/main/security/path-guard.ts:3,27,81` vs. `packages/shared/src/security.ts:46-55,90-93`

The shared `validateDirectoryRequest` resolves Windows special dirs at runtime via `getWindowsBlockedDirs()` (which appends `%APPDATA%`/`%LOCALAPPDATA%`). The host's `path-guard.ts` — the one that actually gates every file operation — imports the **raw static** `SYSTEM_BLOCKED_DIRS[platform]` and never calls `getWindowsBlockedDirs()`. So on Windows the host blocks `C:\Windows`, `Program Files`, etc., but **not** the user's `AppData` roaming/local dirs (which hold browser profiles, tokens, credential stores). If a user adds `C:\Users\me` to the whitelist with `recursive: true`, AppData becomes downloadable. The shared module has the correct logic; the load-bearing copy doesn't use it.

Two structural smells compound this: (a) the blacklist-matching logic is **duplicated three times** (`security.ts` twice, `path-guard.ts` twice) instead of the host delegating to the shared `validateDirectoryRequest`; (b) `getWindowsBlockedDirs()` **mutates the shared module-level array** via `base.push(...)` (`security.ts:51-52`) — every call appends again, so repeated calls grow the blacklist unboundedly and leak env values into the exported constant. That's a latent correctness/purity bug in the shared contract itself.

**Recommendation:** Have `path-guard.ts` delegate to the shared `validateDirectoryRequest` (which already does the right Windows resolution) instead of re-implementing matching against the raw constant. Fix `getWindowsBlockedDirs()` to build a fresh array (`return [...base, ...(appData ? [appData] : []), ...]`) rather than mutating the exported `SYSTEM_BLOCKED_DIRS.win32`. This both closes the AppData gap and removes the triplicated blacklist logic.

---

#### M2. Drizzle schema is a parallel, unenforced definition of the DB — two sources of truth that can silently diverge

**Files:** `apps/server/src/db/client.ts:28-73` (raw `CREATE TABLE`) vs. `apps/server/src/db/schema.ts` · same split on desktop (`db/client.ts` raw SQL ops vs. `db/schema.ts` `CREATE` strings, no Drizzle)

CLAUDE.md flags this, so it's a known trade-off, but from an integrity standpoint it deserves a finding: the running server creates tables from hand-written DDL in `initDatabase()`, while `schema.ts` (the type source for every query builder) is a *separate* hand-maintained description. There is no mechanism — not even a startup assertion — keeping them in sync. A column added to one and not the other produces either a runtime `no such column` (if schema leads) or a silently-unused type (if DDL leads). The desktop side is even looser: raw string SQL methods on a hand-rolled `db` object with `as any` casts at every call site (`getAllowedDirectories() as any[]`), so the schema types provide essentially zero safety to host file operations.

**Architectural impact:** The ORM is paying its full conceptual cost (a schema to maintain, query-builder indirection) while delivering only half its benefit (compile-time query types) and none of its safety net (migrations, drift detection). The `as any` casts on the host mean the security-critical `permission`/`is_active`/`recursive` fields flow through the path-guard as untyped data.

**Recommendation:** Pick one source of truth. Lowest-effort: keep raw DDL but add a startup self-check that introspects `PRAGMA table_info` and asserts it matches the Drizzle schema (fail fast on drift). Better: adopt drizzle-kit migrations as the actual DDL path so `schema.ts` *is* the source. On the host, define a typed row interface for `allowed_directories` and return it from `getAllowedDirectories()` so the path-guard consumes typed data, not `any[]`.

---

#### M3. `usePreview` adds a per-request raw WS `message` listener — the anti-pattern the relay's pending-requests registry was built to kill, reproduced on the client

**File:** `apps/web/src/hooks/usePreview.ts:72-145`

The server side deliberately replaced "attach a temporary `message` listener per request" with the centralized `pending-requests.ts` registry (and CLAUDE.md / the prior review celebrate this). But `usePreview.ts` does exactly the old thing on the client: each `requestPreview()` call `addEventListener('message', handleMessage)` on the shared `wsInstance`, filters by `requestId`, and removes it on response/timeout. Meanwhile *downloads* on the same client go through the centralized `useWebSocket` message switch → `download-manager`. So the web client has **two different response-dispatch architectures** for two nearly-identical request/response flows (preview vs. download).

**Architectural impact:** Inconsistent within one app, and the preview path has the failure modes the registry exists to prevent: if a response never arrives the listener is cleaned only by the 15s timeout; rapid preview switching transiently stacks listeners; and the listener parses *every* inbound frame. It also can't see the `wsInstance` swap on reconnect (the listener is bound to the old socket). The download path is the correct model.

**Recommendation:** Route `RESP_PREVIEW_READY`/`RESP_PREVIEW_ERROR` through the central `useWebSocket` switch into a `preview-manager` (mirroring `download-manager`), keyed by `requestId` against pending preview promises. One client-side dispatch architecture, matching the server's chosen pattern.

---

#### M4. Inconsistent host-online semantics: REST reports DB existence, room map reports liveness, and `ConnectResponse` hard-codes `online: true`

**Files:** `apps/server/src/routes/auth.ts:283` · `routes/hosts.ts:70` · `routes/proxy.ts:216-225`

Three different notions of "host online" coexist: `hosts/:id/status` correctly derives it from the in-memory room map (`isHostOnline`); the proxy correctly checks `hostSockets.get(hostId)`; but `/auth/connect` returns `hostInfo.online: true` **unconditionally** (`auth.ts:283`) regardless of whether the host actually has a live WS connection. A client can connect via PIN to a host whose agent process is down and be told it's online, then hit a `HOST_OFFLINE`/timeout on first `CMD_LIST_*`.

**Recommendation:** Compute `online` from the room map in `/auth/connect` too (import `isHostOnline`). Centralize "host liveness" as one function so the three call sites can't disagree.

---

### LOW

---

#### L1. `notifyAndDisconnectClient` contains `console.log`/`console.error` debug instrumentation in a production routing primitive
`relay.ts:151-163` logs raw client IDs and socket states on every revoke. Use the Fastify logger and drop the verbose per-step `console.log`s. (Minor info-leak + log-noise.)

#### L2. `hosts.ts` `RoomInfo.hostName` is a permanent `TODO: 从数据库获取` returning `''`
`rooms.ts:39`. The host name is available in the `hosts` table; the empty string propagates to any consumer of `getRoomInfo`. Either wire it or remove the dead field.

#### L3. Proxy access-log write is `await`ed inline before hijacking the response, on a fire-and-forget concern
`proxy.ts:254-266`. A slow `securityLogs` insert delays the start of every proxied download/preview. Since it's explicitly "fire-and-forget" semantically (wrapped in try/catch that ignores failure), don't `await` it on the hot path — kick it off and proceed to `tunnelFromHost`.

#### L4. `messages.ts` pagination builds the query twice (with/without `since`) instead of composing conditions
`messages.ts:76-95`. Duplicated `select().from().orderBy().limit().offset()` chains; compose `where(and(...conditions))` once. Cosmetic, but the duplication is exactly how the `since` branch could drift from the base branch.

#### L5. `RespFileChunkPayload` resends `contentType`/`fileName`/`totalSize` on every chunk
`ws-types.ts:152-167`, emitted in `file-tunnel.ts:106`. For a multi-hundred-chunk transfer this is redundant metadata per frame. Header fields belong on the first frame (or a separate `RESP_FILE_HEAD`) only. Low impact given base64 dominates frame size, but it's a protocol-design wart.

---

## Cross-Cutting Observations

**The routing-field contract is well-conceived but only half-enforced.** `RelayRoutingFields` + `withRouting()` is a good pattern, and the host's RESP path honors it consistently (`dir-handlers.ts` applies `withRouting` everywhere). The gap is that *enforcement lives in convention*, not in the type system or the send boundary: `sendToClient`/`sendToHost` accept any `Partial<WSMessage>`, and `messages.ts` proves a caller can and does ship a non-conforming frame (H1). The fix for H1 (enrichment inside the routing primitives) would make the contract structurally unbypassable.

**Auth is the most-duplicated and least-abstracted concern in the server.** The identical ~15-line token-extraction-and-verification block appears in every route, and the one place it drifted (`messages.ts`, C2) is a real vulnerability. This is the highest-leverage refactor: a single `requireHost`/`requireClient` preHandler would have made C2 impossible.

**The accepted "single instance" trade-off has leaked from deployment into code shape (H2).** It's the difference between "we run one instance" and "the code cannot run as more than one." A `RoomRegistry` seam keeps the trade-off a choice.

**What's genuinely good and should be preserved:** the relay-room topology and outbound-only host model; the dual path-validation algorithm in `security.ts` (resolve + `+ path.sep` prefix matching is correct and defends the documented `/home/user` vs `/home/user2` attack); the WS file-tunnel with real backpressure (`file-tunnel.ts` 4MB high-water + poll) and single-use token consumed inside the tunnel handler; the pending-requests registry (the server-side pattern the client should adopt per M3); persistent host identity reuse in `ensureHostRegisteredAndConnected`; and the disciplined reconnect/auth-recovery state machine on both ends.

---

## Priority-Ordered Remediation

1. **C1** — Implement `POST /security-logs`; the relay audit trail is currently broken by contract (no host events, no `BLOCKED_PATH` ever).
2. **C2** — Swap `verifyToken` → `verifyAccessToken` in `messages.ts`; then extract a shared auth preHandler so it can't recur.
3. **H3 / M1** — Reconcile the shared enums with emitted values and apply them at emission; route host path-validation through the shared `validateDirectoryRequest` and fix the `getWindowsBlockedDirs` mutation + AppData gap.
4. **H1** — Unify the three serialization paths into one `sendFrame` + `routeToClient/Host` with routing-field injection inside the primitive; standardize on `nanoid`.
5. **H2** — Introduce `RoomRegistry` to break the circular import / temporal coupling and create a multi-instance seam.
6. **M2–M4, L1–L5** — schema source-of-truth assertion, client preview-dispatch unification, host-online consistency, and the low-severity cleanups.

---

## Review Dimension Coverage Map

| Dimension | Primary findings |
|---|---|
| **Component boundaries / separation of concerns** | H2 (handler.ts is composition root + message loop + state owner), M3 (two response-dispatch architectures in one client), C1 (audit boundary severed) |
| **Dependency management** | H2 (circular import `handler`↔`rooms`, mixed push/pull Map sharing, temporal coupling on `initRelay`) |
| **API design** | C1 (missing endpoint), C2 (token-class enforcement gap), M4 (inconsistent `online` contract), L4/L5 (query duplication, per-frame metadata) |
| **Data model** | M2 (dual DDL/schema source of truth, untyped host rows), H3 (enum vs. emitted-value drift), L2 (dead `hostName` field) |
| **Design patterns / abstractions** | H1 (missing single serialization primitive), C2 (missing auth preHandler), H2 (missing `RoomRegistry` abstraction), M3 (registry pattern present on server, absent on client) |
| **Architectural consistency** | H1 (relay.ts/rooms.ts split → 3 paths, `RelayRoutingFields`/`withRouting` honored on one path only), M3 (client diverges from server's pending-request pattern), Cross-Cutting (contract enforced by convention not types) |

**Key files referenced (absolute paths):**
- `D:\AI\remotebridge\apps\desktop\src\main\security\audit-logger.ts`
- `D:\AI\remotebridge\apps\server\src\routes\security-logs.ts`
- `D:\AI\remotebridge\apps\server\src\routes\messages.ts`
- `D:\AI\remotebridge\apps\server\src\ws\relay.ts`, `D:\AI\remotebridge\apps\server\src\ws\rooms.ts`, `D:\AI\remotebridge\apps\server\src\ws\handler.ts`
- `D:\AI\remotebridge\apps\server\src\ws\pending-requests.ts`
- `D:\AI\remotebridge\packages\shared\src\security.ts`, `D:\AI\remotebridge\packages\shared\src\api-types.ts`
- `D:\AI\remotebridge\apps\desktop\src\main\security\path-guard.ts`
- `D:\AI\remotebridge\apps\desktop\src\main\ws-client\dir-handlers.ts`, `D:\AI\remotebridge\apps\desktop\src\main\ws-client\file-tunnel.ts`
- `D:\AI\remotebridge\apps\web\src\hooks\usePreview.ts`, `D:\AI\remotebridge\apps\web\src\lib\download-manager.ts`
