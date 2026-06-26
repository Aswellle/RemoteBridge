# Performance & Scalability Review — RemoteBridge

**Reviewer role:** Performance Engineer
**Scope:** Full monorepo — `apps/server`, `apps/desktop`, `apps/web`, `packages/shared` (~81 files, ~12,151 LOC)
**Method:** Targeted read of DB layer, WS room/relay/rooms/file-tunnel pipeline, REST pagination routes, host file handlers, and frontend state/render paths, cross-referenced against the Phase-1 (code-quality/architecture) findings.

---

## Executive Summary

The system's core data paths (file tunnel, room routing, message persistence) are reasonably efficient for the documented single-instance, low-concurrency target (a handful of clients per host). The most consequential issues found are:

1. **Unbounded growth of three SQLite tables** (`download_tokens` on desktop, `security_logs` and `messages` on the relay) — the `cleanExpiredTokens()` function exists but is **never called anywhere** in the codebase, and there is no retention/pruning job for `security_logs`/`messages`. Over months of operation these tables grow without limit, degrading every `SELECT ... ORDER BY created_at DESC LIMIT`/`COUNT(*)` query (table scans get slower; `COUNT(*)` in `security-logs.ts` is a full scan with no covering index).
2. **The WS file tunnel's base64 chunking inflates memory and CPU ~37% per chunk** (256KB binary → ~342KB string) on both the Host and the Relay, multiplied by the in-flight chunk count permitted by the 4MB backpressure water-mark (~12 chunks resident at once = ~4.5MB extra string garbage churned per second on a fast LAN transfer).
3. **`usePreview.ts`'s per-request raw WS listener (01a-H2) is confirmed and quantified**: rapid file-list browsing can realistically stack 3-8 concurrent `message` listeners, each parsing every inbound WS frame (including large `RESP_DIR_LIST` payloads and base64 — though file-tunnel frames are filtered server-side, `RESP_DIR_LIST` is not) for up to 15 seconds each.
4. **`app-store.ts`'s `loadMessageHistory` Set-rebuild (01a-M3) is real but low-impact** at realistic volumes (hundreds–low thousands of messages); becomes a measurable per-call cost (~1-5ms) only past ~10k messages, which would require months of heavy chat usage in one session (the array itself is never paginated/virtualized, which is the bigger issue at that scale).
5. **`relay.ts`/`rooms.ts` split (01b-H1/H2)**: confirmed redundant serialization (3 separate `JSON.stringify` call sites with different ID generators), but the **GC/CPU cost is negligible** at realistic session counts (tens to low hundreds) — the map lookups are O(1) and the extra string allocations are sub-microsecond. The real cost is correctness/consistency (already covered in 01b), not raw throughput.
6. **No frontend code-splitting**: zero `next/dynamic` usage in `apps/web`; `PdfViewer`, `ImageViewer`, `TextViewer` and all preview components are bundled into the main dashboard chunk even though only one is shown at a time.
7. **`better-sqlite3` synchronous calls run directly in Fastify route handlers and Electron's main process** — individually these are sub-millisecond on small tables, but `security-logs.ts`'s `COUNT(*)` + paginated `SELECT` (2 sequential synchronous queries per request, no index on `(host_id, created_at)` beyond the primary key) will degrade linearly with table size since there's no pruning (see #1).

None of these are "the app falls over under load" — they are **latent degradation curves** that will surface gradually (weeks/months of uptime) given the single-instance, long-lived-process design. They are all addressable with localized, low-risk fixes.

---

## Findings

### CRITICAL

---

#### C1. `cleanExpiredTokens()` is dead code — `download_tokens` (desktop) grows unbounded forever

**Files:** `apps/desktop/src/main/file-server/token-manager.ts:94-97`, `apps/desktop/src/main/db/client.ts:99-101`

```ts
// token-manager.ts
export function cleanExpiredTokens(): number {
  const result = db.cleanExpiredTokens();
  return result.changes ?? 0;
}
```

A grep across the entire desktop source confirms `cleanExpiredTokens` is **exported but never imported or called** anywhere — not on an interval, not on app startup, not on shutdown. Every `CMD_REQUEST_DOWNLOAD`/`CMD_REQUEST_PREVIEW` inserts one row into `download_tokens` (30-min expiry, `expires_at` stored). Tokens are single-use (`download_count >= 1` after use) but **the row is never deleted** even after use or expiry.

**Performance impact:**
- Every `validateDownloadToken()` call (on every download/preview/tunnel fetch) does `SELECT * FROM download_tokens WHERE token = ?` — this is a primary-key lookup, so it stays O(1) via the B-tree index regardless of table size. The *direct* query cost doesn't degrade.
- However: unbounded row growth means **unbounded disk growth** of `local.db` (each row ~100-150 bytes; a host serving 50 downloads/day accumulates ~2,700 rows/year ≈ 300-400KB/year — modest but monotonic and literally never reclaimed even on VACUUM since SQLite doesn't auto-shrink without `VACUUM`).
- More importantly, this is a **silent dead-code signal** that the original design intended periodic cleanup (the function exists, is documented, has a comment about unit consistency) but the wiring was never completed — same class of bug as the C1 in 01b (host audit POST to a non-existent endpoint): a maintenance task was written but never scheduled.

**Recommendation:** Call `cleanExpiredTokens()` on an interval (e.g., hourly) from `apps/desktop/src/main/index.ts` after `app.whenReady()`, alongside the existing pattern in `apps/server/src/routes/auth.ts:18-26` (`rateLimitCleaner` with `setInterval(...).unref()`):

```ts
// apps/desktop/src/main/index.ts, after DB init
import { cleanExpiredTokens } from './file-server/token-manager';

const tokenCleanupTimer = setInterval(() => {
  const removed = cleanExpiredTokens();
  if (removed > 0) console.log(`[Cleanup] Removed ${removed} expired download tokens`);
}, 60 * 60 * 1000); // hourly
tokenCleanupTimer.unref?.();
```

---

#### C2. No retention/pruning for `security_logs` and `messages` on the relay — `COUNT(*)` and `ORDER BY ... LIMIT` queries degrade linearly with table age

**Files:** `apps/server/src/db/client.ts:25-76` (schema, no indexes beyond PK), `apps/server/src/routes/security-logs.ts:101-115`, `apps/server/src/routes/messages.ts:76-97`

The `security_logs` table accumulates a row for **every** `AUTH_FAIL`, `SESSION_CREATED`, `REVOKE`, `ACCESS_DOWNLOAD`, `ACCESS_PREVIEW` event (and would accumulate `BLOCKED_PATH`/`ACCESS` from the host too, if 01b-C1 were fixed). The `messages` table accumulates every chat message ever sent. **Neither table has any DELETE/archival path**, and **neither has a secondary index**:

```sql
-- db/client.ts initDatabase()
CREATE TABLE IF NOT EXISTS security_logs (
  id TEXT PRIMARY KEY, host_id TEXT REFERENCES hosts(id), client_id TEXT,
  event_type TEXT NOT NULL, detail TEXT, ip_address TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- No index on (host_id, created_at), (host_id, event_type), or (session_id, created_at) for messages
```

**Performance impact (quantified):**
- `GET /security-logs` runs **two sequential queries**: `SELECT COUNT(*) ... WHERE host_id = ?` then `SELECT * ... WHERE host_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`. Without an index on `host_id`, both are **full table scans** filtered by `host_id` — SQLite must visit every row in `security_logs` (across *all* hosts) to find matches. At 10K rows this is ~1-3ms (negligible); at 1M rows (a busy multi-host relay running for 1-2 years with several active hosts each generating ~50 download/preview events/day) this becomes **10-50ms per request**, run twice per page load, and the endpoint is polled by the desktop SecurityLogs UI on every page visit and "刷新" click.
- `OFFSET`-based pagination (`.offset((page - 1) * limit)`) is **O(offset + limit)** in SQLite — deep pages (e.g., page 500 of a 1M-row table) force SQLite to scan and discard 500×20=10,000 rows before returning the 20 requested. This is the classic offset-pagination cost, compounding the missing-index problem.
- `messages` table: `GET /messages/:sessionId` filters `WHERE session_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?` — same missing-index + offset-pagination pattern, but bounded per-session (a single session's message count is naturally capped by conversation length, so this is lower-severity than `security_logs`).

**Recommendation:**
1. Add indexes (cheapest fix, immediate win regardless of pruning):
```sql
CREATE INDEX IF NOT EXISTS idx_security_logs_host_created ON security_logs(host_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at DESC);
```
2. Add a retention job (mirroring the `rateLimitCleaner` pattern already in `auth.ts`):
```ts
// apps/server/src/index.ts or a new cron module
const RETENTION_DAYS = 90;
const logRetentionTimer = setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  sqlite.prepare('DELETE FROM security_logs WHERE created_at < ?').run(cutoff);
}, 24 * 60 * 60 * 1000);
logRetentionTimer.unref();
```
3. For `security-logs.ts`, consider switching to cursor-based pagination (`WHERE created_at < ?` keyed off the last row's timestamp) for deep pages — but given typical usage (recent-events dashboard), simple index + retention likely suffices.

---

### HIGH

---

#### H1. WS file tunnel base64 encoding inflates memory/CPU by ~37% per chunk, multiplied across the backpressure window

**Files:** `apps/desktop/src/main/ws-client/file-tunnel.ts:90-120`, `apps/server/src/ws/file-tunnel.ts` (relay-side consumption), `apps/server/src/routes/proxy.ts:91-99`

Confirmed mechanics: the host reads the file in `CHUNK_SIZE = 256 * 1024` (256KB) binary chunks via `createReadStream`, then:

```ts
client.send({
  type: WSMessageType.RESP_FILE_CHUNK,
  payload: {
    transferId, seq: seq++,
    data: (chunk as Buffer).toString('base64'),  // 256KB -> ~341.4KB string
    eof: sentBytes >= rangeLength,
    totalSize, rangeStart: start, rangeEnd: end, contentType, fileName,
  },
});
```

Base64 has a fixed **4/3 expansion ratio** (256KB → 341.33KB, ~33% larger; plus JSON string escaping overhead is negligible for base64's restricted alphabet). On the relay side (`apps/server/src/routes/proxy.ts:94`), the chunk is decoded back: `raw.write(Buffer.from(chunk.data, 'base64'))`.

**Quantified impact:**
- **Per chunk**: 256KB binary → ~341KB base64 string → JSON.stringify (adds the full message envelope + metadata fields, ~150 bytes) → sent over WS → JSON.parse on relay → `Buffer.from(..., 'base64')` decode back to 256KB. That's **2 full-buffer copies + 1 string allocation + 1 JSON serialize/deserialize cycle** per 256KB of actual file data — i.e., ~600KB of garbage-collectible allocations to move 256KB of payload (≈2.3x overhead).
- **Backpressure window**: `BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024` (4MB) is measured via `client.getBufferedAmount()` — this measures the **already-base64-encoded, JSON-serialized** bytes in the WS send buffer. At steady state, up to ~4MB of *encoded* data (≈3MB of actual file content, since 4MB encoded ÷ 1.333 ≈ 3MB raw) can be buffered = **~12 chunks** of 341KB each in flight before the host pauses reading.
- For a large file transfer (e.g., 500MB) on a fast LAN/localhost connection where the relay can drain faster than the host can read+encode, CPU time on `toString('base64')` (256KB at a time, ~2000 calls for 500MB) becomes the bottleneck. Base64 encoding 256KB in Node.js is roughly 0.3-0.8ms (V8-dependent); ~2000 chunks × 0.5ms ≈ **1 second of pure CPU spent on encoding alone** for a 500MB file, plus the symmetric decode cost on the relay. This runs on each side's **main/event-loop thread** — for the desktop Host, this is the **Electron main process**, which also handles all IPC to the renderer and all other WS message routing; a sustained large download will introduce periodic ~0.5ms blocking spikes that can cause IPC/UI jank during big transfers.

**Recommendation:**
- If the WS protocol could support binary frames (the `ws` library does support `ArrayBuffer`/`Buffer` sends alongside JSON text frames), switching `RESP_FILE_CHUNK` to a binary frame with a small JSON header frame preceding it would eliminate the base64 expansion entirely (33% bandwidth savings + no encode/decode CPU). This is a larger protocol change (binary framing alongside the existing JSON-text protocol) but would be the highest-leverage fix for large-file transfer performance.
- Shorter-term: increase `CHUNK_SIZE` (e.g., to 512KB-1MB) to amortize the per-chunk JSON envelope overhead (currently ~150 bytes of fixed metadata repeated every 256KB — at 1MB chunks this drops to ~0.015% overhead vs ~0.06% at 256KB; marginal but free). The backpressure water-mark would need proportional adjustment to keep total buffered memory bounded.
- Document the `~1s CPU cost for 500MB` as an expected cost in the architecture notes so it isn't mistaken for a bug during profiling.

---

#### H2. `usePreview.ts` per-request WS listener — confirmed and quantified accumulation pattern (extends 01a-H2)

**File:** `apps/web/src/hooks/usePreview.ts:72-183`

Verified the exact mechanics: every call to `requestPreview()` does:
```ts
const handleMessage = (event: MessageEvent) => { /* parses event.data, filters by requestId */ };
wsInstance.addEventListener('message', handleMessage);
// ... sends CMD_REQUEST_PREVIEW ...
const timeout = setTimeout(() => { /* ... */ wsInstance.removeEventListener('message', handleMessage); }, 15000);
```

The **only** cleanup paths are: (a) `RESP_PREVIEW_READY` received → `removeEventListener` called inline, (b) `RESP_PREVIEW_ERROR` received → same, (c) the 15s timeout fires → same. **There is no cancellation of a previous in-flight request when a new one starts** — `currentRequestIdRef.current = requestId` is updated, but the *old* `handleMessage` closure remains registered and will keep running until its own response/timeout.

**Quantified accumulation scenario:**
- A user in `apps/web/src/app/dashboard/files/page.tsx` clicks through a directory listing of, say, 10 previewable files in rapid succession (each click calls `setPreviewFile(...)` which mounts `FilePreview` → calls `requestPreview`). If each click happens within ~1-2 seconds (faster than the Host's typical preview-token round trip of 50-300ms over the relay, but the *response* for request N might arrive after request N+3 has already been sent if the Host is momentarily slow, e.g. during a large concurrent download saturating its WS send buffer per H1):
  - **Realistic accumulation: 3-8 concurrent listeners** during a burst of fast clicks on a host that's mildly loaded (e.g., serving a large download concurrently, which delays preview responses behind the 4MB-backpressure-gated file-tunnel frames on the *same* WS connection — though note file-tunnel frames are `RESP_FILE_CHUNK`/`RESP_FILE_ERROR` which are server-consumed and never reach the client's `wsInstance`, so in practice the client-side listener stacking is driven purely by preview-response latency, not file-tunnel traffic).
  - Each stacked listener calls `JSON.parse(event.data)` on **every** inbound WS message for up to 15 seconds — including `RESP_DIR_LIST` (which can be large: a directory with 500 entries × ~150 bytes/entry ≈ 75KB JSON), `PING`/`PONG`, `RESP_DOWNLOAD_READY`, etc. With N stacked listeners, every inbound frame is parsed N times redundantly.
  - **CPU cost**: `JSON.parse` on a 75KB payload is roughly 0.1-0.3ms. With 5 stacked listeners and a 75KB `RESP_DIR_LIST` arriving (e.g., user navigates to a new directory while previews are pending), that's **5 redundant parses ≈ 0.5-1.5ms** of main-thread work — not catastrophic for a single event, but every PING/PONG (every 30s from relay, every 5s RTT-probe... wait, RTT pings are host-side only, but the relay's 30s heartbeat PING is sent to clients too) and every other message during the 15s window incurs this multiplier.
  - **Memory**: each listener closure captures `wsInstance`, `sessionId`, `accessToken`, `filePath` (via `requestId`/`currentRequestIdRef` closure) — small (~1KB each including the closure scope chain), so 8 stacked listeners ≈ 8KB. Not a leak in the "OOM" sense, but a correctness bug: **stale closures can still call `setPreviewState` after the component has moved on to a different file**, causing the preview pane to flash/flicker with a previous file's content if request ordering races (mitigated partially by the `currentRequestIdRef.current !== requestId` check inside `applyReady`, but the error branches for `RESP_PREVIEW_ERROR` at line 130-139 have **no such guard** — a stale error can overwrite the current preview's error state).

**Verdict on severity**: Confirmed as a real issue under realistic "fast file browsing" usage, but the **performance** impact (redundant JSON.parse, a few KB of transient closures) is modest — **the correctness impact (stale error overwrites, flicker) is more user-visible than the CPU/memory cost**. Severity remains High primarily for correctness; performance contribution is Medium.

**Recommendation:** (as in 01a-H2) cancel the previous request's listener+timeout before registering a new one:
```ts
const cancelPreviousRef = useRef<(() => void) | null>(null);

const requestPreview = useCallback((filePath: string) => {
  cancelPreviousRef.current?.();  // remove stale listener + clear its timeout first
  // ... existing setup ...
  const cleanup = () => {
    clearTimeout(timeout);
    wsInstance.removeEventListener('message', handleMessage);
  };
  cancelPreviousRef.current = cleanup;
  // ... at end of handleMessage success/error branches, also call cleanup() not just removeEventListener
}, [wsInstance, sessionId, accessToken]);
```
This bounds the listener count to 1 at all times, eliminating both the redundant-parse cost and the stale-overwrite correctness bug in one change.

---

#### H3. Desktop `CMD_LIST_DIR` does a synchronous `fs.stat` per directory entry with unbounded `Promise.all` fan-out — large directories block the Electron main process

**File:** `apps/desktop/src/main/ws-client/dir-handlers.ts:151-177`

```ts
const entries = await fs.readdir(requestedPath, { withFileTypes: true });
const fileEntries = await Promise.all(
  entries.map(async (entry) => {
    const fullPath = path.join(requestedPath, entry.name);
    try {
      const stat = await fs.stat(fullPath);  // one stat() syscall per entry, all in parallel
      // ...
    } catch { return null; }
  })
);
```

While `fs.stat` here is the **async** (`fs/promises`) variant — not the synchronous `better-sqlite3` kind — `Promise.all` over `entries.map(...)` issues **all stat() calls concurrently with no concurrency limit**. For a directory with, say, 5,000 files (a `node_modules`, a media library, a Downloads folder), this fires **5,000 concurrent `fs.stat` syscalls** via libuv's threadpool (default size 4, configurable via `UV_THREADPOOL_SIZE`).

**Performance impact:**
- libuv's threadpool defaults to **4 threads**. 5,000 concurrent stat requests queue up behind 4 worker threads — the *wall-clock* time is still roughly `5000 / 4 × (per-stat latency)`, so for SSDs (~0.05-0.1ms/stat) this is ~60-125ms; for network drives / spinning disks (~5-10ms/stat) this balloons to **6-12 seconds** for one directory listing, during which the CMD_LIST_DIR handler is "in flight" (not blocking the event loop itself, since these are async, but the *Promise.all* doesn't resolve until all 5,000 complete — so the RESP_DIR_LIST is delayed by the slowest stat).
- Additionally, `Promise.all` allocates 5,000 pending promises + 5,000 result objects simultaneously — for very large directories this is a transient (5,000 × ~200 bytes ≈ 1MB) allocation spike, not severe but compounds with the base64 tunnel allocations (H1) if a download is concurrently in progress.
- The same unbounded-fan-out pattern repeats in `CMD_LIST_ALLOWED` (line 39-58, `allowedDirs.map(async (dir) => fs.stat(dir.path))`) but the whitelist is typically small (a handful of directories), so this instance is low-impact.

**Recommendation:** Cap concurrency with a small pool (e.g., `p-limit` or a hand-rolled batching loop) for `CMD_LIST_DIR`'s per-entry stat:
```ts
import pLimit from 'p-limit';
const limit = pLimit(32); // tune to ~2-8x UV_THREADPOOL_SIZE

const fileEntries = await Promise.all(
  entries.map((entry) => limit(async () => {
    const fullPath = path.join(requestedPath, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      // ...
    } catch { return null; }
  }))
);
```
This bounds in-flight syscalls, reduces the transient promise/array allocation, and (for slow filesystems) makes the *first* batch of results available sooner if a streaming response were ever introduced. Also consider increasing `UV_THREADPOOL_SIZE` (env var) if Host machines commonly browse network shares.

---

### MEDIUM

---

#### M1. `app-store.ts` `loadMessageHistory` Set-rebuild — confirmed O(n) per call, but unbounded `messages` array is the bigger latent issue (extends 01a-M3)

**File:** `apps/web/src/store/app-store.ts:449-465`

```ts
set((state) => {
  const existingIds = new Set(state.messages.map((m) => m.id));  // O(m) — m = current message count
  const newMessages = historyMessages.filter((m) => !existingIds.has(m.id)); // O(n)
  // ...
  return { messages: [...newMessages, ...state.messages] }; // O(n+m) array copy
});
```

**Quantified:**
- Each `loadMessageHistory(sessionId, page)` call fetches up to `limit=50` messages (hardcoded in `app-store.ts:435`, `params: { page, limit: 50 }`) and rebuilds a `Set` from the **entire** existing `messages` array.
- At **100 messages**: `Set` construction ≈ 100 iterations, negligible (<0.05ms).
- At **1,000 messages**: ≈1,000 iterations + a 1,000-entry `Set` allocation (~30-50KB for string-key Set overhead) — still sub-millisecond (<0.2ms), called only when the user scrolls back through history (not on every message).
- At **10,000 messages** (would require ~3-6 months of moderate daily chat usage in one continuously-open browser tab, since `messages` is never pruned/paginated and lives only in memory — a page refresh resets it to whatever `loadMessageHistory` re-fetches): Set construction ≈ 1-3ms, array spread `[...newMessages, ...state.messages]` copies 10,050 references ≈ another 0.5-1ms. **Total ~2-4ms per history-load call** — noticeable as a single dropped frame (16.6ms budget at 60fps) but not catastrophic, and history-loads are user-initiated (scroll-to-load-more), not per-render.
- **The bigger latent issue**: the `messages` array itself has **no upper bound and no virtualization**. `apps/desktop/src/renderer/pages/Messages.tsx` renders `filteredMessages.map((msg) => <MessageBubble key={msg.id} ... />)` directly into a scrollable `div` with **no virtualization** (no `react-window`/`react-virtual`). At 10,000 messages, React would mount 10,000 `MessageBubble` DOM subtrees — **this is the dominant cost**, likely 100s of ms of layout/paint and a large persistent DOM, vs the ~2-4ms Set-rebuild. The web client (`apps/web`) doesn't appear to have an equivalent always-visible message list component in the reviewed files, but the same risk applies to any chat UI rendering the full `messages` array.

**Verdict**: 01a-M3 is correct that it's "not O(n²) overall" and "not a real issue at hundreds-to-low-thousands" — confirmed. The Set-rebuild becomes a measurable (single-digit ms) cost only past ~10K messages, and by that point **unvirtualized DOM rendering of the full message list is the dominant performance problem**, not the Set construction.

**Recommendation:**
1. (Low priority, as 01a-M3 suggests) Maintain a persistent `seenMessageIds: Set<string>` alongside `messages` to avoid rebuilding — cheap insurance for future-proofing.
2. (Higher priority, new finding) If chat sessions are expected to be long-lived (desktop Messages.tsx has no pagination — it loads `getMessageHistory(200)` once and then appends indefinitely via the `onNewMessage` handler), add virtualization (`react-window`'s `FixedSizeList` or `VariableSizeList` for variable-height bubbles) to `Messages.tsx`'s message list, and/or cap the in-memory `messages` array (e.g., keep last 500, fetch older on scroll-up) to bound both render cost and memory.

---

#### M2. `relay.ts`/`rooms.ts` triple-serialization — confirmed redundant but negligible at realistic scale (extends 01b-H1/H2)

**Files:** `apps/server/src/ws/relay.ts:22-32,168-170`, `apps/server/src/ws/rooms.ts:71-114`, `apps/desktop/src/main/ws-client/client.ts:150-160`, `apps/web/src/hooks/useWebSocket.ts:224-234`

Confirmed: there are (at least) **3 independent `JSON.stringify`-based send implementations** server-side alone (`relay.ts::sendWSMessage`, and `rooms.ts`'s three `send*` functions each inline their own `JSON.stringify`), plus each client/host endpoint has its own `send()` doing the same. Each constructs a fresh object literal and calls `JSON.stringify` independently — `generateId()` (Math.random-based, ~30 chars) vs `nanoid()` (21 chars) produce different ID string lengths/allocations but both are sub-microsecond.

**Quantified assessment of "redundant serialization work, GC pressure, lookup overhead under concurrent load":**
- **Serialization cost**: `JSON.stringify` on a typical WS message (a `RESP_DIR_LIST` with ~50 entries ≈ 7.5KB, or a `MSG_TEXT` ≈ 200 bytes) costs roughly 0.01-0.1ms. Even at **100 concurrent sessions** each sending ~1 message/second, that's 100 stringify calls/sec ≈ 1-10ms/sec of *total* CPU — across the whole Node process, this is **<1% of a single core**. The "three paths" issue does not multiply this — each message is serialized exactly once by whichever path handles it; there's no *double*-serialization of the same message.
- **GC pressure**: each `sendWSMessage`/`sendToClient`/`sendToHost` call allocates one new object (the frame) + one string (the JSON). At 100 msg/sec this is 200 short-lived allocations/sec — well within V8's young-generation GC capacity (which handles millions of short-lived objects/sec). Not measurable as a GC pause contributor at any realistic RemoteBridge session count (the system is designed for "a user's PC" + a handful of remote clients, not thousands of concurrent sessions).
- **Map lookup overhead**: `hostSockets.get(hostId)`, `clientSockets.get(clientId)`, `sessionRooms.get(clientId)`/`.forEach()` are all O(1) or O(n) over the **session count**, not global state. `relayToClient`'s fallback path (`clientSockets.forEach(...)` to find by `sessionId` when `clientId` is absent) is O(n) over connected clients — at realistic scale (tens of clients per relay instance), this is microseconds. At hundreds of clients, still sub-millisecond.

**Verdict**: The architectural concerns in 01b-H1/H2 (correctness, maintainability, multi-instance seam) stand on their own merits, but **there is no measurable performance/scalability penalty from the three-path split at the concurrency levels this system targets** (single relay instance, "a user's PC" + remote clients — realistically 1-50 concurrent sessions). This would only become a performance concern if the relay were scaled to thousands of concurrent sessions, at which point the **O(n) `clientSockets.forEach()` fallback in `relayToClient`** (relay.ts:58-65) would become the first bottleneck (linear scan on every Host→Client message that lacks `clientId`), not the serialization redundancy itself.

**Recommendation:** No urgent performance action. If the 01b-H1 refactor (`RoomRegistry` + unified `sendFrame`) is undertaken for correctness reasons, ensure the unified primitive **avoids the `clientSockets.forEach()` linear scan** by always requiring `clientId` (already the documented contract via `RelayRoutingFields`) — this turns the one O(n) path into O(1) as a side effect of the correctness fix.

---

#### M3. `security-logs.ts` and `messages.ts` REST routes run synchronous-backed Drizzle queries directly in the Fastify handler — fine today, but no connection/queue isolation

**Files:** `apps/server/src/routes/security-logs.ts:101-115`, `apps/server/src/routes/messages.ts:76-97`, `apps/server/src/db/client.ts:15-22`

`better-sqlite3` is **synchronous by design** — every `db.select()...` call (via Drizzle's better-sqlite3 driver) blocks the Node.js event loop for the duration of the query. Confirmed: there's a single shared `sqlite` connection (`apps/server/src/db/client.ts:15`, `new Database(dbPath)`), wrapped by Drizzle, used by every route handler directly — no worker thread, no query queue.

**Performance impact:**
- For small/indexed queries (a few ms even on large tables with proper indexes), this blocking is imperceptible — better-sqlite3 is chosen specifically because it's *faster* than async sqlite3 bindings for small/medium queries, and the synchronous model avoids the overhead of promise microtask scheduling for sub-millisecond operations.
- **However**, combined with M2/C2 (missing indexes + unbounded table growth), a `COUNT(*)` full-table-scan on a multi-million-row `security_logs` table could take **tens to low-hundreds of milliseconds**. During that time, **the entire Fastify event loop is blocked** — no other request (including WS message handling for the relay's room routing, which shares the same process/event loop) can be processed. This is the actual mechanism by which C2's missing indexes become a *concurrency* problem, not just a latency problem: a slow security-logs query from one host's dashboard delays WS heartbeat PINGs and CMD/RESP routing for **all** hosts/clients on the relay.

**Recommendation:** Primarily mitigated by fixing C2 (indexes + retention keep all queries in the sub-millisecond range, where synchronous blocking is a non-issue). If query times ever need to exceed ~5-10ms routinely (e.g., complex analytics), consider `better-sqlite3`'s ability to run on a worker thread via a wrapper, but this is **not warranted today** — the fix is to keep queries fast via C2, not to add async complexity.

---

### LOW

---

#### L1. No frontend code-splitting — all preview viewers bundled into the main dashboard chunk

**Files:** `apps/web/src/components/previews/FilePreview.tsx`, `ImageViewer.tsx` (270 lines), `PdfViewer.tsx` (114 lines), `TextViewer.tsx` (156 lines), `UnsupportedViewer.tsx`

A grep for `next/dynamic` across `apps/web/src` returns zero matches. `FilePreview.tsx` (which dispatches to `ImageViewer`/`PdfViewer`/`TextViewer`/`UnsupportedViewer` based on file category) statically imports all four viewers, so all ~600 lines of viewer code (plus their dependencies — `lucide-react` icons, etc.) ship in the initial `dashboard/files` page bundle even though a user viewing the file list (without opening any preview) never executes this code.

**Performance impact:** Modest — these are small React components with no heavy third-party dependencies (no `pdf.js`, no `monaco-editor`; `PdfViewer` uses a plain `<iframe>` to the browser's native PDF renderer, `TextViewer`/`ImageViewer` presumably use native `<img>`/`<pre>`). The bundle-size cost is likely in the **single-digit KB** range after minification/gzip — not a major contributor to time-to-interactive. Flagged as Low because the *pattern* (no lazy loading anywhere in the app) means if a heavier viewer (e.g., a syntax-highlighting library, a real PDF.js renderer) is added later, it would also ship unconditionally.

**Recommendation:** For the current viewer set, this is not urgent. As a forward-looking pattern, wrap `FilePreview`'s dynamic dispatch in `next/dynamic` with `ssr: false`:
```tsx
const ImageViewer = dynamic(() => import('./ImageViewer'));
const PdfViewer = dynamic(() => import('./PdfViewer'));
const TextViewer = dynamic(() => import('./TextViewer'));
```
This becomes important if/when a heavier preview library (syntax highlighter, PDF.js, video player) is introduced — establish the pattern now so it's a non-event later.

---

#### L2. `FileList.tsx` re-sorts the entire entry array on every render with no memoization

**File:** `apps/web/src/components/FileList.tsx:42-46`

```tsx
export default function FileList({ entries, onDirClick, onFileClick, loading }: FileListProps) {
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });
  // ...
}
```

`[...entries].sort(...)` runs on **every render** of `FileList`, not just when `entries` changes. `Array.prototype.sort` is O(n log n); `localeCompare` is relatively expensive (locale-aware string comparison, can be 10-50x slower than a simple `<` comparison) — for a directory with 500 entries, `localeCompare`-based sort is roughly **0.5-2ms** per call.

**Performance impact:** `FilesPage` (the parent) re-renders on any Zustand store change — e.g., every `updateDownload()` call during an active download (which fires on a 200ms-throttled progress update per `download-manager.ts:117-126`). If a download is in progress while the file list is visible, `FileList` re-sorts its (unchanged) 500-entry array **every ~200ms** for the duration of the download — ~2-10ms of redundant `sort()`/`localeCompare()` work every 200ms, i.e., roughly **1-5% of a render cycle's budget** repeatedly during downloads. Not severe, but easily eliminated.

**Recommendation:**
```tsx
import { useMemo } from 'react';
// ...
const sortedEntries = useMemo(() => [...entries].sort((a, b) => {
  if (a.type === 'dir' && b.type !== 'dir') return -1;
  if (a.type !== 'dir' && b.type === 'dir') return 1;
  return a.name.localeCompare(b.name);
}), [entries]);
```
Also note `FileList` itself isn't wrapped in `React.memo`, so it re-renders whenever `FilesPage` re-renders (e.g., on download progress ticks) even though `entries`/`onDirClick`/`onFileClick`/`loading` are unchanged — `React.memo(FileList)` combined with stable callback references (`useCallback` for `handleDirClick`/`handleFileClick` in `FilesPage`) would eliminate the re-render entirely, making the `useMemo` above belt-and-suspenders.

---

#### L3. Desktop `Messages.tsx` and `Clients.tsx`-style pages poll every 10 seconds regardless of visibility

**File:** `apps/desktop/src/renderer/pages/Messages.tsx:51-66`

```tsx
useEffect(() => {
  let alive = true;
  async function loadClients() {
    try {
      const list = await window.electronAPI.listClients();
      // ...
    } catch (err) { /* ... */ }
  }
  loadClients();
  const timer = setInterval(loadClients, 10000);
  return () => { alive = false; clearInterval(timer); };
}, []);
```

A 10-second poll for the connected-clients list runs as long as the `Messages` page component is mounted, including when the Electron window is minimized/unfocused (Electron doesn't pause renderer timers when the window loses focus by default, unlike browser tabs which throttle `setInterval` in background tabs). Each poll is an IPC round-trip (`listClients` → main process → `db.getConnectedClients()` — a synchronous SQLite query on `connected_clients WHERE revoked_at IS NULL`, typically a tiny table).

**Performance impact:** Negligible in absolute terms (a small SQLite query + IPC round-trip every 10s ≈ <1ms of work every 10,000ms = 0.01% duty cycle). Flagged as Low purely for completeness — this is the kind of polling that's individually harmless but, combined with similar patterns on other pages (if `Clients.tsx`/`SecurityLogs.tsx` poll similarly when visible), contributes to background CPU wake-ups that matter for laptop battery life on an always-running desktop agent. `SecurityLogs.tsx` (reviewed) does **not** poll — it's fetch-on-demand (page/filter changes), which is the better pattern.

**Recommendation:** If Electron's `BrowserWindow` visibility can be checked (`document.visibilityState` works in renderer processes too), gate the interval:
```tsx
const timer = setInterval(() => {
  if (document.visibilityState === 'visible') loadClients();
}, 10000);
```
Or use `requestIdleCallback`/IPC push (main process notifies renderer on `CLIENT_JOINED`/`CLIENT_LEFT` WS events, which it already receives — `handlers.ts` could push these directly instead of relying on the renderer to poll).

---

## Summary Table

| ID | Severity | Area | Impact (quantified) | Fix complexity |
|----|----------|------|----------------------|-----------------|
| C1 | Critical | Desktop DB | `download_tokens` rows never deleted — unbounded disk growth, dead cleanup code | Trivial (wire existing function to an interval) |
| C2 | Critical | Relay DB | `security_logs`/`messages` no indexes + no retention → `COUNT(*)`/`ORDER BY` degrade linearly with table age; blocks event loop during scan | Low (add 2 indexes + 1 retention job) |
| H1 | High | File tunnel | Base64 chunking = ~2.3x allocation overhead per 256KB chunk; ~1s CPU for 500MB transfer on main/Electron thread | Medium-High (binary framing) / Low (tune chunk size) |
| H2 | High | Web preview | Confirmed 3-8 stacked WS listeners under fast browsing; redundant JSON.parse + stale-overwrite correctness bug | Low (cancel-previous pattern) |
| H3 | High | Desktop dir listing | Unbounded `Promise.all` fan-out of `fs.stat` — 5K-entry dir ≈ 6-12s on slow disks behind 4 libuv threads | Low (add `p-limit`) |
| M1 | Medium | Web/desktop messages | Set-rebuild ~2-4ms at 10K messages; unvirtualized message list is the dominant cost at that scale | Low (Set) / Medium (virtualization) |
| M2 | Medium | Relay WS routing | 3-path serialization confirmed but <1% CPU at realistic scale; O(n) `forEach` fallback is the real scaling edge | None urgent |
| M3 | Medium | Relay DB/event loop | Synchronous better-sqlite3 blocks event loop during slow (unindexed) queries — mitigated by fixing C2 | Covered by C2 |
| L1 | Low | Web bundle | No `next/dynamic` for preview viewers — small impact today, pattern risk for future heavy viewers | Low |
| L2 | Low | Web FileList | Unmemoized `sort()`+`localeCompare()` on every render, ~2-10ms repeated during downloads | Trivial (`useMemo`) |
| L3 | Low | Desktop renderer | 10s polling regardless of window visibility — negligible CPU, battery-life consideration | Trivial |

---

## Cross-Cutting Observations

- **The system is well-suited to its stated scale** (a personal PC + a handful of remote clients, single relay instance). Most "scalability" findings (M2 especially) only matter at concurrency levels the architecture explicitly doesn't target (ADR-005 accepts single-instance).
- **The recurring pattern across both this review and 01b's C1**: functions/endpoints that *look* complete (cleanup jobs, retention logic, audit endpoints) but are **never wired up** — `cleanExpiredTokens()` (C1 here) and the missing `POST /security-logs` (01b-C1) are the same class of "half-finished maintenance task" bug. A useful systemic fix beyond the individual findings: grep for exported-but-uncalled functions in `db/client.ts` and `file-server/token-manager.ts` as part of CI (e.g., `ts-prune` or `knip`) to catch this class of issue going forward.
- **The file tunnel's backpressure design (4MB high-water, 50ms poll) is sound** and correctly bounds memory regardless of file size — H1's finding is about CPU/allocation *overhead per byte*, not unbounded memory growth, which the existing design already prevents.
- **Frontend re-render discipline is generally good** (Zustand selective subscriptions, `useMemo` already used in `Messages.tsx` for `filteredMessages`) — L2's `FileList` is the one notable gap, easily fixed.

---

## Priority-Ordered Remediation

1. **C1** — Wire `cleanExpiredTokens()` to an hourly interval in desktop `main/index.ts` (5-line fix, eliminates unbounded `download_tokens` growth).
2. **C2** — Add `(host_id, created_at)` and `(session_id, created_at)` indexes to `security_logs`/`messages`; add a 90-day retention `DELETE` on an interval. This also resolves M3 (event-loop blocking) as a side effect.
3. **H3** — Add `p-limit`-bounded concurrency to `CMD_LIST_DIR`'s per-entry `fs.stat` fan-out (protects slow/network-drive directory listings).
4. **H2** — Implement the cancel-previous-listener pattern in `usePreview.ts` (fixes both the listener accumulation and the stale-error-overwrite correctness bug in one change).
5. **H1** — Document the base64 CPU/memory overhead as expected behavior; consider chunk-size tuning (low-risk) now, binary framing (higher-risk protocol change) as a future optimization if large-file transfers become common.
6. **L2** — Add `useMemo` to `FileList`'s sort (trivial, eliminates redundant work during downloads).
7. **M1, L1, L3** — Low priority; address opportunistically (virtualize `Messages.tsx` if/when chat volume grows, add `next/dynamic` to preview viewers if a heavier viewer is introduced, gate desktop polling on visibility).

---

## Key Files Referenced (absolute paths)

- `D:\AI\remotebridge\apps\desktop\src\main\file-server\token-manager.ts`
- `D:\AI\remotebridge\apps\desktop\src\main\db\client.ts`
- `D:\AI\remotebridge\apps\server\src\db\client.ts`
- `D:\AI\remotebridge\apps\server\src\routes\security-logs.ts`
- `D:\AI\remotebridge\apps\server\src\routes\messages.ts`
- `D:\AI\remotebridge\apps\desktop\src\main\ws-client\file-tunnel.ts`
- `D:\AI\remotebridge\apps\server\src\ws\file-tunnel.ts`
- `D:\AI\remotebridge\apps\server\src\routes\proxy.ts`
- `D:\AI\remotebridge\apps\web\src\hooks\usePreview.ts`
- `D:\AI\remotebridge\apps\desktop\src\main\ws-client\dir-handlers.ts`
- `D:\AI\remotebridge\apps\web\src\store\app-store.ts`
- `D:\AI\remotebridge\apps\desktop\src\renderer\pages\Messages.tsx`
- `D:\AI\remotebridge\apps\server\src\ws\relay.ts`, `D:\AI\remotebridge\apps\server\src\ws\rooms.ts`
- `D:\AI\remotebridge\apps\web\src\components\FileList.tsx`
- `D:\AI\remotebridge\apps\web\src\lib\download-manager.ts`
- `D:\AI\remotebridge\apps\web\src\components\previews\` (FilePreview.tsx, ImageViewer.tsx, PdfViewer.tsx, TextViewer.tsx, UnsupportedViewer.tsx)
