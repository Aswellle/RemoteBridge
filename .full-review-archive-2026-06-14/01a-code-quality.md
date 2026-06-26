# Code Quality Findings

## Critical

### C1: Multiple `Math.random()` ID generators compromise deduplication guarantees
- **File:line**: `apps/server/src/ws/relay.ts:168-170`; `apps/desktop/src/main/ws-client/client.ts:233-235`; `apps/web/src/hooks/useWebSocket.ts:249-251`
- **Description**: Three separate ID generators use `Math.random().toString(36).substring(...)` in the relay, desktop host, and web client. The relay's `generateId()` is used for WS message `id` fields that serve as deduplication keys for message persistence (see handler.ts:317 `payload.messageId || message.id`). `Math.random()` is non-cryptographic and has a birthday-collision probability of roughly `(n^2)/(2 * 2^52)` -- for 10K messages per session this yields a ~1e-6 collision chance. While low, IDs must be unique across all sessions in one DB. The shared package's `generatePin()` (security.ts) correctly uses `crypto.getRandomValues` -- the same standard should apply to all deduplication-key generation. The desktop host and web client replicate the same `Math.random` pattern, adding no collision resistance.
- **Fix**: Extract a shared ID generator in `packages/shared/src/security.ts` using `crypto.getRandomValues` (already proven by `generatePin()`), and use it everywhere:

```typescript
// packages/shared/src/security.ts -- add:
export function generateSecureId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}
```

Then replace all three `generateId()` private methods with an import of `generateSecureId`.

---

## High

### H1: `console.log/error/warn` scattered across production server paths -- no structured logging
- **File:line**: `apps/server/src/ws/relay.ts:155,160,162`; `apps/server/src/ws/handler.ts:326`; `apps/server/src/db/client.ts:26,75`; `apps/server/src/routes/proxy.ts:274,372`; `apps/desktop/src/main/ws-client/client.ts:52,67,72,91`; `apps/desktop/src/main/ws-client/handlers.ts:13,20,44,59,68,77`; `apps/desktop/src/main/security/audit-logger.ts:25,45,70`; `apps/web/src/hooks/useWebSocket.ts:51,68` (+ ~20 more occurrences across desktop and web)
- **Description**: The relay server initializes Fastify with `logger: { level: 'info' }` but uses bare `console.log/error/warn` in approximately 40+ locations. These bypass the structured logging pipeline, making production log analysis inconsistent -- metrics (log volume, error rate, trace correlation) cannot aggregate console output alongside pino JSON. `handler.ts:326` uses `console.error('持久化消息失败:', err)` in one of the most critical code paths (message persistence). The desktop and web apps also use bare `console.*` for all diagnostics.
- **Fix**: On the server, replace all `console.*` calls with `app.log.*` / `fastify.log.*` / the imported `pino` logger. On the desktop, introduce a structured logger (e.g., `electron-log`) that writes to a file + console. On the web, use a conditional approach that silences in production or routes through a centralized logger.

```typescript
// In handler.ts, instead of:
// console.error('持久化消息失败:', err);
import { app } from '../index'; // or pass logger via dependency injection
// Use: fastify.log.error({ err, sessionId }, 'Message persistence failed');
```

### H2: No listener cleanup in `useWebSocket` handler's ad-hoc `addEventListener` -- memory leak on preview
- **File:line**: `apps/web/src/hooks/usePreview.ts:72`
- **Description**: `usePreview.requestPreview()` attaches an anonymous `handleMessage` via `wsInstance.addEventListener('message', handleMessage)`. The cleanup function (returned from the callback) removes this listener, but there are three failure modes: (a) the request completes normally and the timeout fires before cleanup, leaving the listener dangling for 14+ seconds; (b) the user navigates away before response arrives -- React unmounts the component but the `wsInstance` (shared WebSocket singleton) still holds the listener; (c) rapid successive preview requests (e.g., clicking through file list fast) create multiple concurrent listeners, each with its own timeout, all competing for the same `wsInstance.message` event.
- **Fix**: Use a registry pattern -- give each request a tracked AbortController and store them in a Map keyed by requestId. The shared `handleMessage` loop (in `useWebSocket.ts`) should check this registry before the blind switch-case. Alternatively, keep the existing approach but: (1) cancel previous request's timeout/listener before attaching a new one, (2) always call cleanup at the end of each handler branch (not just in the `error` path).

```typescript
// Minimal fix: cancel previous before new
const cancelPreviousRef = useRef<(() => void) | null>(null);
cancelPreviousRef.current?.(); // clean up old listener+timeout
cancelPreviousRef.current = doRequest(filePath);
```

### H3: Desktop `dir-handlers.ts` duplicates preview extension/type lists from `shared/file-utils.ts`
- **File:line**: `apps/desktop/src/main/ws-client/dir-handlers.ts:426-437` and `439-447`
- **Description**: `isPreviewableFile()` and `getFileCategory()` in `dir-handlers.ts` each contain hardcoded extension arrays that duplicate (and slightly diverge from) the `PREVIEWABLE_TYPES` constant in `packages/shared/src/file-utils.ts`. The desktop version includes additional extensions (`ini`, `rb`, `go`, `rs`, `java`, `c`, `cpp`, `h`, `env`, `gitignore`) not in the shared constants, while the shared module has `graphql`, `toml`, `fish`, `zsh`, `bash` not in the desktop copy. This means a file classified as previewable by the desktop Host may be rejected by the web client, or vice versa.
- **Fix**: The `PREVIEWABLE_TYPES` constant and the `isPreviewableFile`/`getFileCategory` functions in `shared/file-utils.ts` should be the single source of truth. Remove the duplicate helpers in `dir-handlers.ts` and import from `@remotebridge/shared`.

```typescript
// Remove these from dir-handlers.ts:
// function isPreviewableFile(ext: string, size: number) { ... }
// function getFileCategory(ext: string) { ... }

// Import from shared:
import { isPreviewableFile, getFileCategory } from '@remotebridge/shared';
// Note: the shared isPreviewableFile doesn't check size -- add size check at call site:
// if (isPreviewableFile(ext) && stat.size <= PREVIEW_MAX_SIZE) { ... }
```

### H4: `notifyAndDisconnectClient` uses `console.log/error` for critical disconnection path with no caller-facing error propagation
- **File:line**: `apps/server/src/ws/relay.ts:143-165`
- **Description**: The function logs connection state via `console.log` and `console.error` but returns `void`. If `sendWSMessage` succeeds but `close()` fails, the caller (`routes/auth.ts` revocation handler) has no way to know the client wasn't properly disconnected. The caller already wraps it in a try-catch (auth.ts:433-445), but that only catches import failures and throws from the function body -- not post-close errors.
- **Fix**: Return a result object. If the client socket is missing, return `{ notFound: true }` instead of just logging. The caller can then decide whether to retry or alert.

```typescript
export function notifyAndDisconnectClient(...): { success: boolean; reason?: string } {
  const clientWs = clientSockets.get(clientId);
  if (!clientWs) return { success: false, reason: 'client_not_found' };
  // ...
  return { success: true };
}
```

### H5: Desktop `client.ts` `send()` method silently drops messages when WS is not OPEN
- **File:line**: `apps/desktop/src/main/ws-client/client.ts:150-160`
- **Description**: The `send()` method checks `this.ws?.readyState === WebSocket.OPEN` and ignores messages if not. There is no buffer/queue, no return value, and no error callback. Any sender that calls `send()` during a brief disconnection window has no indication of failure. This is especially dangerous for `RESP_FILE_CHUNK` in `file-tunnel.ts` where a dropped chunk means a truncated download with no error surfacing on either side.
- **Fix**: Add a return value indicating success/failure. For critical paths (file tunnel chunks), buffer the message and flush on reconnect, or at minimum log a warning with context.

```typescript
send(message: Partial<WSMessage>): boolean {
  if (this.ws?.readyState === WebSocket.OPEN) {
    this.ws.send(...);
    return true;
  }
  console.warn(`Dropped message type=${message.type} -- not connected`);
  return false;
}
```

### H6: `security-logs.ts` event types route has unused `hostId` via scoping function but that's inconsistent with `access-logs` route
- **File:line**: `apps/server/src/routes/security-logs.ts:160-196` vs `209-281`
- **Description**: The `/security-logs/events` endpoint uses `resolveScopedHostId()` (which allows both host and client tokens). The `/access-logs` endpoint right below it (line 223-229) uses an inline `verifyAccessToken` with a hard `payload.type !== 'host'` check. These two adjacent endpoints use different auth patterns for no architectural reason -- a discrepancy that makes the auth model harder to audit.
- **Fix**: Standardize on `resolveScopedHostId()` for `/access-logs` as well, since `verifyAccessToken` already rejects refresh tokens. The scoping function is the single place for host-token-or-client-with-hostId logic.

```typescript
// Replace lines 223-231 of security-logs.ts:
let hostId: string;
try {
  hostId = resolveScopedHostId(token);
} catch {
  // ... error response
}
```

---

## Medium

### M1: Over-reliance on `as any` type assertions obscures type safety
- **File:line**: `apps/server/src/ws/handler.ts` (~16 `as any` usages); `apps/server/src/ws/relay.ts` (~3); `apps/server/src/routes/auth.ts` (~2); `apps/desktop/src/main/ws-client/dir-handlers.ts` (~5); `apps/desktop/src/main/file-server/server.ts` (~2)
- **Description**: The `__meta` property is attached to raw `ws.WebSocket` objects using `(socket as any).__meta`. This is a deliberate pattern for attaching connection metadata to WebSocket objects, but the current approach has no type guard or centralized accessor. Every consumer re-implements the `(ws as any).__meta` cast, and the `ConnectionMeta` interface is imported inconsistently across files. If `__meta` were ever renamed or its shape changed, the compiler would not catch it.
- **Fix**: Create a typed wrapper in `ws/socket-meta.ts`:

```typescript
// ws/socket-meta.ts
import { WebSocket } from 'ws';
export interface ConnectionMeta { type: 'host' | 'client'; id: string; ... }

const META_KEY = Symbol('connectionMeta');

export function setSocketMeta(socket: WebSocket, meta: ConnectionMeta): void {
  (socket as Record<symbol, ConnectionMeta>)[META_KEY] = meta;
}

export function getSocketMeta(socket: WebSocket): ConnectionMeta | undefined {
  return (socket as Record<symbol, ConnectionMeta>)[META_KEY];
}
```

Then all `(ws as any).__meta` casts become typed `getSocketMeta(ws)` calls. This is a one-time refactor with zero runtime cost.

### M2: `generatePin()` in `shared/security.ts` has a bias-guarantee comment but the implementation is needlessly complex
- **File:line**: `packages/shared/src/security.ts:125-139`
- **Description**: The rejection-sampling loop over-allocates a 16-byte buffer (`length * 2`) for PIN generation. The `maxValid` calculation `Math.floor(256 / PIN_CHARS.length) * PIN_CHARS.length` with length=31 produces `maxValid = 248`, meaning 8 out of 256 random byte values are rejected. The expected number of bytes consumed per PIN character is `256/248 = 1.032`, so a 8-byte PIN typically needs ~9 bytes from the buffer. The 16-byte buffer is 1.8x over-allocated. While functionally correct, the over-allocation and while-loop-with-nested-for-loop structure is hard to read.
- **Fix**: Use a simpler modulo-bias-resistant approach. Since the character set is 31 and we use rejection sampling, the logic is correct -- but a comment or a simpler helper would improve readability:

```typescript
export function generatePin(length: number = 8): string {
  const max = Math.floor(256 / PIN_CHARS.length) * PIN_CHARS.length; // 248
  const buf = new Uint8Array(length); // bias-adjusted: ~9 bytes needed for 8 chars
  crypto.getRandomValues(buf);
  let pin = '';
  let pos = 0;
  while (pin.length < length && pos < buf.length) {
    if (buf[pos] < max) pin += PIN_CHARS[buf[pos] % PIN_CHARS.length];
    pos++;
  }
  if (pin.length < length) return generatePin(length); // rare fallback
  return pin;
}
```

### M3: `app-store.ts` `loadMessageHistory` has `O(n^2)` duplicate check via Set construction on every history load
- **File:line**: `apps/web/src/store/app-store.ts:449-453`
- **Description**: The `loadMessageHistory` action creates `new Set(state.messages.map(m => m.id))` on each call to filter duplicates. As the message list grows to thousands of entries over a long session, this becomes `O(n*m)` where n=new messages and m=existing messages. The dedup logic is sound but the Set construction copies every existing message ID.
- **Fix**: Maintain a persistent `Set<string>` of seen message IDs on the store, updated alongside the messages array:

```typescript
// Add to AppState:
seenMessageIds: Set<string>;

// In loadMessageHistory:
const newMessages = historyMessages
  .filter(m => !state.seenMessageIds.has(m.id));

// Then:
return {
  messages: [...newMessages, ...state.messages],
  seenMessageIds: new Set([...state.seenMessageIds, ...newMessages.map(m => m.id)]),
};
```

### M4: `download-manager.ts` `anchorDownload` adds and removes DOM nodes synchronously -- race with download prompt
- **File:line**: `apps/web/src/lib/download-manager.ts:140-149`
- **Description**: The `anchorDownload` function appends an `<a>` element, calls `click()`, then removes it after `setTimeout(..., 100)`. If the browser's "save as" dialog is synchronous (some browsers open it before returning from `click()`), the removal at 100ms works. But if the dialog is asynchronous (e.g., Firefox "always ask" setting), the `<a>` is removed before the save completes, potentially canceling the download.
- **Fix**: Use the `URL.createObjectURL` approach (already used in `saveBlob`) consistently. Alternatively, remove on `requestAnimationFrame` after a longer timeout, or simply don't remove the element (it has `display: none` and costs nothing).

```typescript
function anchorDownload(url: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  // Remove after a generous window to accommodate async save dialogs
  setTimeout(() => a.remove(), 5000);
}
```

### M5: `Message` interface in `shared/api-types.ts` and `local_messages` table share direction field but have different type systems
- **File:line**: `packages/shared/src/api-types.ts:96-104` vs `apps/desktop/src/main/db/schema.ts:39-49`
- **Description**: The REST API `Message` type has `direction: 'host_to_client' | 'client_to_host'`, while the `app-store.ts` `messages` state has the same shape but adds `timestamp: number`. The desktop `local_messages` table has additional `sender_id` and `sender_label` columns not in the shared API type. There is no single `Message` type that all consumers share -- the protocol contract (shared) is partial, and each app layers its own extensions.
- **Fix**: Define a base `MessageCore` in shared with the common fields, then extend it with app-specific fields where needed. At minimum, document in shared which fields are the canonical set.

### M6: `client.ts` (server) hardcodes `DEFAULT_EXPIRES_IN = 300` but `shared/security.ts` defines `PIN_DEFAULT_EXPIRY` at 300 seconds -- the same constant in two places
- **File:line**: `apps/server/src/routes/auth.ts:12` vs `packages/shared/src/security.ts` (implicit)
- **Description**: `auth.ts` defines `PIN_DEFAULT_EXPIRES_IN = 300` while `shared/security.ts` has no exported PIN expiry default (the `DOWNLOAD_TOKEN_CONFIG` is there but `PIN_DEFAULT_EXPIRY` is missing). The PIN default should be in shared since it's a protocol-level constant -- both the desktop PIN-generation IPC and the server auth route need it.
- **Fix**: Export `PIN_DEFAULT_EXPIRES_IN` from `shared/security.ts`:

```typescript
export const PIN_DEFAULT_EXPIRES_IN_SEC = 300;
```

Then import it in auth.ts instead of redeclaring.

### M7: Wrong `direction` in desktop message handler for received MSG_TEXT
- **File:line**: `apps/desktop/src/main/ws-client/handlers.ts:52`
- **Description**: The Host receives `MSG_TEXT` from a Client, but persists it with `direction: 'client_to_host'`. This is a perspective issue: from the Host's point of view, a received message came from the client (client_to_host), which is correct. But when stored in `local_messages` and later displayed, the desktop UI needs to know who authored it. The current code stores `payload.senderId` and `payload.senderLabel`, so the data is available -- but the label `direction` is semantically misleading (it's really `origin` or `from`).
- **Severity adjustment**: This is more of a naming concern than a bug, since the downstream code uses `senderId` for display logic. Low-medium severity.

### M8: `ws/relay.ts:102` extracts `clientId` from message payload with `as any` but `RelayRoutingFields` only has optional `clientId`
- **File:line**: `apps/server/src/ws/relay.ts:102-103`
- **Description**: The Host-to-Client routing reads `const clientId = (message.payload as any)?.clientId` and does not type-check it. If the Host sends a RESP without echoing `clientId` (violating the routing field contract), `clientId` is `undefined`, and `relayToClient(..., undefined, ...)` silently fails. This is the "silently dropped" behavior documented in CLAUDE.md. While intentional, there is no warning/log when this happens -- making debugging Host-side routing-field bugs very difficult.
- **Fix**: At minimum, log a warning when a RESP message arrives from the Host without `clientId`:

```typescript
const clientId = (message.payload as any)?.clientId;
if (!clientId) {
  console.warn(`Host response missing clientId in payload, cannot route: type=${message.type}`);
  return;
}
```

### M9: `routes/proxy.ts` duplicate query + session validation in `download` and `preview` handlers
- **File:line**: `apps/server/src/routes/proxy.ts:186-282` and `286-381`
- **Description**: The two proxy routes (`/proxy/download/:sessionId` and `/proxy/preview/:sessionId`) share ~95% identical code for JWT authentication, filePath validation, session validation, Host-WebSocket lookup, and error handling. The only differences are: (a) the CMD type sent to the Host, (b) the extra headers passed to `tunnelFromHost`, (c) the event type in the security log. This is a textbook case for a parameterized helper.
- **Fix**: Extract a `proxyFileRequest` helper:

```typescript
async function proxyFileRequest(
  request: FastifyRequest<...>,
  reply: FastifyReply,
  cmdType: WSMessageType.CMD_REQUEST_DOWNLOAD | WSMessageType.CMD_REQUEST_PREVIEW,
  logEventType: 'ACCESS_DOWNLOAD' | 'ACCESS_PREVIEW',
  tunnelExtraHeaders: Record<string, string>,
): Promise<void> { /* shared logic */ }
```

### M10: `server/db/client.ts` creates tables on every startup via `CREATE TABLE IF NOT EXISTS` but has no schema migration mechanism
- **File:line**: `apps/server/src/db/client.ts:25-73`
- **Description**: The server uses `CREATE TABLE IF NOT EXISTS` in `initDatabase()`. This works fine for the first deployment, but if a column is added or a constraint is changed, the `IF NOT EXISTS` will not apply the schema delta. The Drizzle schema (`db/schema.ts`) is documented as "reference only" and the running server never reads it. There is no mechanism to detect or apply schema changes.
- **Fix**: At minimum, add a `schema_version` table and assert the expected version at startup. Better: use the Drizzle migration system (already configured in `package.json`) as the startup path, or write a simple version-check migration function.

```typescript
// Add to initDatabase():
const version = sqlite.prepare('PRAGMA user_version').get() as { user_version: number };
const EXPECTED_VERSION = 1;
if (version.user_version < EXPECTED_VERSION) {
  // Run migration logic here
  sqlite.prepare(`PRAGMA user_version = ${EXPECTED_VERSION}`).run();
}
```

---

## Low

### L1: `rooms.ts` `getRoomInfo` has a TODO comment for host name lookup since June 2026
- **File:line**: `apps/server/src/ws/rooms.ts:39`
- **Description**: `hostName: '', // TODO: 从数据库获取` -- the host name is always empty in `getRoomInfo` responses. This field is present in the `RoomInfo` interface but never populated. Since `getRoomInfo` doesn't appear to be called from any production path (searches confirm no callers other than potential tests), this is either dead code or an unfixed feature.
- **Fix**: Either populate the field by querying the `hosts` table, or remove `getRoomInfo` and `RoomInfo` if unused.

### L2: `auth.ts` route has a stale TODO comment at line 272
- **File:line**: `apps/server/src/routes/auth.ts:272`
- **Description**: `// TODO: notifyHost(matchedHost.id, 'CLIENT_JOINED', { clientId, clientLabel })` -- CLIENT_JOINED is already handled by the WS connection flow in `handler.ts:261-267`. This TODO appears to predate that implementation. It should be removed to avoid confusion.

### L3: `formatFileSize` in shared `file-utils.ts` duplicates the desktop `formatSize` helper
- **File:line**: `packages/shared/src/file-utils.ts:33-41` vs `apps/desktop/src/main/ws-client/dir-handlers.ts:458-466`
- **Description**: The shared package exports `formatFileSize`, but the desktop reimplements an almost identical `formatSize` with different unit array (`['B', 'KB', 'MB', 'GB']` vs `['B', 'KB', 'MB', 'GB', 'TB']`) and different formatting (`toFixed(1)` vs `toFixed(2)`). Minor but unnecessary duplication.

### L4: `useWebSocket.ts` WebSocketManager stores a reference to the entire zustand store class rather than subscribing
- **File:line**: `apps/web/src/hooks/useWebSocket.ts:22-23`
- **Description**: The `WebSocketManager` constructor receives `private store: typeof useAppStore` -- the class itself. It then calls `this.store.getState()` to read state. This works but means the manager is tightly coupled to the entire store interface. A more maintainable pattern would inject only the specific state slices and actions the manager needs.

### L5: Server `index.ts` `SIGINT`/`SIGTERM` handlers call `process.exit(0)` after async `app.close()` -- the `0` exit code masks potential close errors
- **File:line**: `apps/server/src/index.ts:102-112`
- **Description**: Both signal handlers do `await app.close(); process.exit(0)`. If `app.close()` throws (e.g., a socket hang during shutdown), the promise rejection is unhandled and `process.exit(0)` still executes, reporting a clean shutdown. The outer `start()` try-catch has `process.exit(1)`, but the signal handlers are separate.
- **Fix**: Wrap `app.close()` in a try-catch:

```typescript
process.on('SIGINT', async () => {
  try {
    await app.close();
  } catch (err) {
    app.log.error(err, 'Error during shutdown');
    process.exit(1);
  }
  process.exit(0);
});
```

### L6: `electron-binding.ts` silencing fallback to original `.node` when Electron binary is missing but not found
- **File:line**: `apps/desktop/src/main/electron-binding.ts:38-40`
- **Description**: The `catch {}` at line 39 silently falls through to the original `dlopen` call when the Electron-rebuilt binary fails to load. If the Electron binary exists but is corrupted or compiled for a different Node version, the fallback loads the pnpm-store copy (Node-built), which will crash with `NODE_MODULE_VERSION mismatch`. The empty catch body prevents diagnostic logging.
- **Fix**: At minimum, log the error before falling through:

```typescript
try {
  return origDlopen.call(this, module, alt, ...args);
} catch (err) {
  console.warn('Failed to load Electron better-sqlite3 binary, falling back to original:', (err as Error).message);
}
```

### L7: `auth.ts:34` `generate-pin` endpoint uses `verifyAccessToken` for the Host -- but this is equivalent to `verifyToken` since `verifyAccessToken` adds the refresh-token check which is irrelevant for host tokens
- **File:line**: `apps/server/src/routes/auth.ts:104`
- **Description**: `verifyAccessToken` calls `verifyToken` then checks `payload.use === 'refresh'`. Since Host tokens never have a `use` field, `verifyAccessToken` adds no extra security over `verifyToken` for this endpoint. It works correctly, but calling `verifyAccessToken` implies a security guarantee it doesn't actually provide.
- **Fix**: Use `verifyToken` directly for Host-only routes, or add a dedicated `verifyHostToken` that checks `payload.type === 'host'`.

### L8: `desktop/db/client.ts` module-level `initDatabase()` call means the DB is created on import, not at app startup
- **File:line**: `apps/desktop/src/main/db/client.ts:28`
- **Description**: `initDatabase()` is called at module scope (line 28), not inside the `app.whenReady()` handler. This means if the module is imported before Electron's `app` module is ready (which it must be since `app.getPath('userData')` is called at line 8), it could fail in edge cases (e.g., testing or bundling). In practice, these imports all happen after `app.whenReady` (from `main/index.ts`), so it works -- but the architecture is fragile.
- **Fix**: Export `initDatabase()` and call it explicitly in `main/index.ts` after `app.whenReady()`.

### L9: `app-store.ts` `connect` action stores `hostInfo` in both Zustand state and localStorage (JSON.stringify`d) with no sync mechanism for competing tabs
- **File:line**: `apps/web/src/store/app-store.ts:298`
- **Description**: The store saves `hostInfo` to localStorage with `JSON.stringify(hostInfo)`. If two browser tabs connect to different Hosts, the localStorage write from one will overwrite the other, but the in-memory Zustand state in each tab is independent. This creates a consistency mismatch -- a tab's localStorage snapshot may not match its in-memory host.
- **Severity adjustment**: This is a documented single-instance limitation (the relay itself is single-instance). In practice, users don't open two tabs to two different Hosts from the same browser. Low severity.

### L10: `download-manager.ts:136` `saveBlob` releases the blob URL after 60 seconds -- if the download dialog is delayed more than 60s, the URL is revoked before saving
- **File:line**: `apps/web/src/lib/download-manager.ts:136-137`
- **Description**: `setTimeout(() => URL.revokeObjectURL(blobUrl), 60000)`. 60 seconds is generous for most cases, but on slow connections with large files and a user who steps away from the "Save As" dialog, this could revoke before the save completes. The `saveBlob` path is only used for fallback (no `response.body` reader), which is extremely rare. Still, the timeout is arbitrary.
- **Fix**: Use `requestIdleCallback` or tie cleanup to the `anchorDownload` element's removal instead of a fixed timeout:

```typescript
function saveBlob(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);
  anchorDownload(blobUrl, fileName);
  // Clean up when the page navigates away or after a generous idle period
  window.addEventListener('beforeunload', () => URL.revokeObjectURL(blobUrl), { once: true });
}
```

---

## Summary

| Severity | Count | Key themes |
|----------|-------|------------|
| Critical | 1 | Non-cryptographic ID generation for deduplication keys |
| High     | 6 | Logging hygiene, listener leak, code duplication, silent failures, auth inconsistency |
| Medium   | 10 | Type safety (`as any`), DRY violations, missing schema migration, readability |
| Low      | 10 | Stale TODOs, minor duplication, edge-case robustness |

The codebase is generally well-structured with clear architecture documentation. The most actionable improvements are: (1) switch all three ID generators to cryptographic random, (2) eliminate the `as any` cast forest around WebSocket metadata with a typed accessor, (3) clean up the duplicated extension/type lists in `dir-handlers.ts`, and (4) establish proper structured logging everywhere.

Wrote 28 findings.
