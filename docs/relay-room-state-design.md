# Relay room-state consolidation (P1-7 design pass)

> Status: **implemented**. `ws/connection-registry.ts` now owns `hostSockets`/
> `clientSockets`/`sessionRooms` and exposes the accessor API below (plus
> `forEachHost`/`forEachClient`/`clearHostClients`, added during implementation for the
> heartbeat loop, host-reconnect rebuild, and host-disconnect cleanup — see "Deviations
> from the proposed API" at the end of this document). `relay.ts` is the sole
> serialization layer and imports the registry directly (`initRelay()` removed). `rooms.ts`
> has been deleted; its helpers were relocated per the split described below. This
> document scopes the P1-7 finding from `.full-review/05-final-report.md` as a follow-up
> design pass, per the recommendation in that report (01b-H2). P1-6's concrete bug
> (dedup-key divergence on the REST message fallback) was fixed earlier — see "P1-6:
> already fixed" below — independently of this redesign, since it was a small, isolated
> correctness bug rather than part of the structural issue.

## Current state

Room state — `hostSockets` (hostId → WebSocket), `clientSockets` (clientId → WebSocket),
and `sessionRooms` (clientId → hostId) — is defined as three module-level `Map`s in
`apps/server/src/ws/handler.ts` and reaches its four other consumers through three
different patterns:

1. **`ws/relay.ts`** — receives the Maps via push-injection: `handler.ts` calls
   `initRelay({ hostSockets, clientSockets, sessionRooms })` once, inside
   `setupWebSocket()`. Until that call runs, every exported function in `relay.ts`
   (`sendWSMessage`, `relayToHost`, `relayToClient`, `relayMessage`, `notifyHost`,
   `notifyAndDisconnectClient`) would throw on the `undefined` module-level Maps.
2. **`ws/rooms.ts`** — pull-imports the same three Maps directly from `handler.ts`
   (`import { hostSockets, clientSockets, sessionRooms, ConnectionMeta } from './handler'`).
   This works because `handler.ts` declares them as module-level `const`s evaluated at
   import time (no temporal-coupling issue in practice for this path), but it means two
   different access patterns exist for the same state, and `handler.ts` must export
   internal room state for a sibling module to consume — `rooms.ts` and `relay.ts` are
   peers that should not need to know about each other's wiring.
3. **`routes/proxy.ts`** — pull-imports `hostSockets` (and the re-exported
   `sendWSMessage`) directly from `handler.ts` as well, a third access path into the same
   state from outside `ws/`.
4. **`routes/hosts.ts`** / **`routes/auth.ts`** — use dynamic `await import('../ws/rooms')`
   / `await import('../ws/relay')` for `isHostOnline`/`isClientOnline` and
   `notifyAndDisconnectClient`, avoiding a static import cycle but still reaching into
   `ws/` internals from `routes/`.

Three send-paths exist as a result: `relay.ts::sendWSMessage` (the primary envelope
serializer: `{ id, type, payload, timestamp, sessionId }`), `rooms.ts`'s
`sendToClient`/`sendToHost`/`broadcastToHostClients` (previously their own
`JSON.stringify`, now delegating to `sendWSMessage` — see "P1-6: already fixed"), and the
ad-hoc enrichment block inside `relay.ts::relayMessage` that injects `RelayRoutingFields`
(`clientId`, `sessionId`) plus `senderId`/`senderType`/`messageId` into `MSG_TEXT`/CMD/RESP
payloads.

## P1-6: already fixed (not part of this redesign)

The REST message-send fallback (`routes/messages.ts`'s `POST /messages/:sessionId`) called
`sendToHost`/`sendToClient` with a payload that omitted `messageId`, `senderType`,
`sessionId`, and (for the client-bound branch) `clientId` — the fields `relayMessage`
injects on the normal WS path. Concretely this caused two divergences once the REST
fallback fired:

- **Desktop** (`apps/desktop/src/main/ws-client/handlers.ts`'s `MSG_TEXT` handler) persists
  incoming messages with `id: payload.messageId || nanoid()`. Without `payload.messageId`,
  it generated a fresh id, so the same logical message ended up with two different row ids
  in the server's `messages` table vs. the desktop's local `local_messages` table.
- **Web** (`apps/web/src/hooks/useWebSocket.ts`'s `MSG_TEXT` handler) derives message
  `direction` from `message.senderType` / `payload.senderType`. Neither was set on the
  REST-fallback envelope, so a host-sent REST-fallback message rendered with
  `direction: 'client_to_host'` (wrong side of the chat).

Fixed by:

- `ws/rooms.ts`'s `sendToClient`/`sendToHost`/`broadcastToHostClients` now delegate to
  `relay.ts::sendWSMessage` instead of hand-rolling `JSON.stringify`, so the envelope
  honors a caller-supplied `id` and includes `sessionId` — unifying two of the three
  serialization paths.
- `routes/messages.ts` now passes `id: messageId` (the same id already written to the
  `messages` table) and a payload containing `messageId`, `senderType`, `clientId`, and
  `sessionId`, mirroring what `relayMessage` would have produced had the message gone over
  WS.

This leaves the `relayMessage` enrichment block as the one remaining place that
constructs this payload shape — itself part of the broader consolidation below, but no
longer a correctness bug.

## Problems this redesign addresses (P1-7)

1. **Inconsistent access patterns** for the same mutable state (push-injection vs.
   pull-import vs. cross-layer reach-through) make it hard to reason about
   initialization order and who's allowed to read/write the Maps.
2. **`ws/` internals leak into `routes/`** (`proxy.ts` imports `hostSockets` directly;
   `hosts.ts`/`auth.ts` dynamically import from `ws/rooms`/`ws/relay`), so "room state"
   isn't actually encapsulated by any module — it's just three exported `Map`s that
   everyone touches.
3. **ADR-005's single-instance trade-off is structural, not a deployment choice.**
   ADR-005 accepted in-memory room state on the basis that relay restarts self-heal via
   reconnect + host-reconnect room rebuild (see `docs/runbook.md` §1.1). But because the
   Maps are scattered raw exports threaded through 5 files with 3 different access
   patterns, there is no single seam where a future Redis-backed (or otherwise
   externalized) room registry could be substituted — every consumer would need
   individual changes.

## Proposed design

Introduce a single new module, **`ws/connection-registry.ts`**, that owns the three Maps
and exposes a small accessor API — no raw `Map` exports:

```ts
// ws/connection-registry.ts
export function registerHost(hostId: string, ws: WebSocket): void
export function unregisterHost(hostId: string, expected: WebSocket): boolean // false if already replaced (reconnect race)
export function getHostSocket(hostId: string): WebSocket | undefined
export function isHostOnline(hostId: string): boolean

export function registerClient(clientId: string, ws: WebSocket, hostId?: string): void
export function unregisterClient(clientId: string, expected: WebSocket): boolean
export function getClientSocket(clientId: string): WebSocket | undefined
export function isClientOnline(clientId: string): boolean

export function getClientHost(clientId: string): string | null
export function getHostClients(hostId: string): string[]
export function rebindClientToHost(clientId: string, hostId: string): void // host-reconnect room rebuild
export function forEachClientOfHost(hostId: string, fn: (clientId: string, ws: WebSocket) => void): void
export function clearAll(): void // onClose graceful shutdown
```

This module has **no dependencies on `relay.ts`, `rooms.ts`, or `handler.ts`** — it is the
new bottom of the dependency graph for room state. The reconnect-race guards currently
duplicated in `handler.ts`'s `close` handler (`if (hostSockets.get(meta.id) !== socket)
return`) become `unregisterHost`/`unregisterClient`'s return value.

Then:

- **`relay.ts`** becomes the sole serialization layer. It imports from
  `connection-registry.ts` instead of receiving Maps via `initRelay()` — `initRelay()` is
  deleted, removing the temporal-coupling hazard entirely (any module can call
  `relay.ts` functions at any time, in any order).
- **`rooms.ts` is deleted.** Its remaining unique read-only helpers (`getRoomInfo`,
  `isHostOnline`, `isClientOnline`, `getHostClients`, `getClientHost`) become thin
  wrappers in `connection-registry.ts` (already listed in the API above) or move directly
  into `relay.ts` if they're send-adjacent (`broadcastToHostClients`,
  `sendToClient`/`sendToHost`, which after the P1-6 fix are now one-line wrappers around
  `sendWSMessage` + a registry lookup).
- **`handler.ts`** keeps WS connection lifecycle (accept, auth, heartbeat, `close`/`error`
  handlers) and the `handleMessage` dispatch switch, but calls `connection-registry.ts` for
  all state reads/writes and `relay.ts` for all sends. It no longer exports
  `hostSockets`/`clientSockets`/`sessionRooms`.
- **`routes/proxy.ts`** imports `getHostSocket`/`isHostOnline` from
  `connection-registry.ts` and `sendWSMessage` from `relay.ts` — no more reach-through to
  `ws/handler.ts`.
- **`routes/hosts.ts`** and **`routes/auth.ts`** import `isHostOnline`/`isClientOnline` /
  `notifyAndDisconnectClient` the same way every other consumer does (static imports from
  `connection-registry.ts` / `relay.ts`) — the dynamic `await import(...)` workarounds can
  be removed once there's no cycle to avoid.

Resulting dependency direction (`→` = "imports from"):

```
handler.ts ─┬─→ connection-registry.ts
            └─→ relay.ts ──→ connection-registry.ts

routes/*.ts ──→ relay.ts / connection-registry.ts   (never → handler.ts)
```

No cycles, one access pattern, and `connection-registry.ts` is the single seam ADR-005
identifies as the future externalization point.

## Migration steps (incremental, each independently shippable)

1. Add `connection-registry.ts` with the API above, backed internally by the same three
   `Map`s (moved out of `handler.ts`). `handler.ts` re-exports them temporarily from
   `connection-registry.ts` to avoid a big-bang change to every import site.
2. Update `relay.ts` to import from `connection-registry.ts` directly; delete
   `initRelay()` and its call site in `handler.ts`.
3. Update `handler.ts`'s connect/close handlers and heartbeat loop to use the registry's
   accessor functions instead of direct `Map` methods; remove the temporary re-export.
4. Move `rooms.ts`'s remaining helpers into `connection-registry.ts`/`relay.ts` per the
   split above; update `routes/messages.ts`, `routes/hosts.ts` imports; delete `rooms.ts`.
5. Update `routes/proxy.ts` and `routes/auth.ts` to import from
   `connection-registry.ts`/`relay.ts` directly; remove the dynamic `await import(...)`
   indirection.

Each step keeps the build green and the WS protocol unchanged — this is a pure internal
refactor with no wire-format or API impact, so it can land as ordinary incremental PRs
rather than a single large change.

## Deviations from the proposed API (as implemented)

The implementation landed as a single pass rather than five incremental PRs (no
intermediate temporary re-exports were needed within one change). Three additions beyond
the API list above proved necessary:

- **`forEachHost(fn)`** / **`forEachClient(fn)`** — the heartbeat timer iterates *all*
  hosts/clients (not scoped to one room), and the host-reconnect rebuild must scan *all*
  `clientSockets` to find clients whose `__meta.hostId` matches the reconnecting host
  (`forEachClientOfHost` can't help here since `sessionRooms` hasn't been rebuilt yet —
  that's the thing being rebuilt). `relayToClient`'s sessionId-fallback lookup also uses
  `forEachClient`.
- **`clearHostClients(hostId): string[]`** — on host disconnect, `handler.ts` needs both
  to notify each affected client (`HOST_OFFLINE`) and remove their `sessionRooms` entries.
  `forEachClientOfHost` is read-only, so this variant removes the mappings and returns the
  affected `clientId`s, leaving the `sendWSMessage` notify call (a `relay.ts` concern) to
  `handler.ts`.

`getRoomInfo`/`RoomInfo` moved into `connection-registry.ts` as specified, including their
DB dependency (`db`/`hosts`/`eq`) — `connection-registry.ts`'s "no dependencies on
`relay.ts`/`rooms.ts`/`handler.ts`" constraint is about avoiding cycles with those three
files specifically, not a blanket ban on DB imports, and `db/client.ts` doesn't import
from `ws/*`. Note both remain unused outside `connection-registry.ts` itself (dead code
carried over from `rooms.ts`, where they were also unused) — preserved as-is since
removing them was out of scope for this refactor.
