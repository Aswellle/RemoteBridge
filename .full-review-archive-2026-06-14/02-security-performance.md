# Phase 2: Security & Performance Review

Full detail: `02a-security.md` (15 findings) and `02b-performance.md` (11 findings). This file consolidates the Critical/High findings and summarizes the rest.

## Security Findings (02a)

**Threat model:** the relay is internet-exposed and untrusted-by-clients; anyone with a PIN gets a client session; the web client runs in a browser (XSS-reachable); the desktop Host exposes the user's real filesystem and is the highest-value asset.

### Critical

**S1 — `messages.ts` lets a 30-day refresh token act as a messages-API credential, and never excludes revoked sessions (verifies 01b-C2)**
`apps/server/src/routes/messages.ts:6,32,135` imports and calls `verifyToken` (signature-only) instead of `verifyAccessToken` (which rejects `use:'refresh'`), for both `GET` and `POST /messages/:sessionId`. Independently, the route never checks `session.revokedAt`, unlike `proxy.ts::validateSession`. Net effect: (a) if `JWT_REFRESH_SECRET` ever collapses to the same value as `JWT_SECRET` (see S6 — the default derivation does exactly this), a 30-day refresh token reads/writes message history 30 days past the intended 2h access window; (b) even with correctly separated secrets, a **revoked client's** access token still works against `/messages/:sessionId` until it naturally expires, because revocation is enforced only on WS/refresh/proxy, not here. CVSS ~8.1 (CWE-287/CWE-613).
**Fix:** swap to `verifyAccessToken` in both handlers; after loading the session row, reject if `revokedAt` is set (403 `SESSION_REVOKED`). Add a regression test asserting both a refresh token and a revoked session yield 401/403.

### High

| ID | Title | Location | CVSS |
|----|-------|----------|------|
| S2 | `POST /auth/register-host` is unauthenticated and has **no rate limit** — unbounded host-row creation enables DB-growth DoS and amplifies `/auth/connect`'s per-host bcrypt PIN scan into a CPU DoS | `apps/server/src/routes/auth.ts:49-86` | 7.5 |
| S3 | Host's `audit-logger.ts` POSTs to `${relayApi}/security-logs`, but the server registers **GET only** → every Host-originated `BLOCKED_PATH`/`ACCESS`/`TUNNEL_FETCH` event 404s and is dropped; `GET /access-logs` (filters `BLOCKED_PATH`) is permanently empty (verifies 01b-C1) | `apps/desktop/src/main/security/audit-logger.ts:32,59` ↔ `apps/server/src/routes/security-logs.ts` | 6.5 |
| S4 | Host `path-guard.ts` uses the raw static `SYSTEM_BLOCKED_DIRS[platform]` and never calls `getWindowsBlockedDirs()` — Windows hosts don't blacklist `%APPDATA%`/`%LOCALAPPDATA%`/`.ssh`. A recursive+download share of `C:\Users\<name>` exposes browser credential stores, `electron-store` configs (including RemoteBridge's own `hostToken`/`hostSecret`!), and SSH keys (verifies 01b-M1) | `apps/desktop/src/main/security/path-guard.ts:27` | 7.1 |
| S5 | No CSP anywhere in `apps/web`; PDF preview renders in an unsandboxed `<iframe>` from a blob URL. A file with `.pdf` extension but HTML/JS content (extension trusted, not content-sniffed) executes script same-origin to the dashboard → theft of `localStorage` tokens (interacts with S11) | `apps/desktop/.../dir-handlers.ts` (extension-based categorization), `apps/web/src/components/previews/PdfViewer.tsx`, `apps/web/next.config.mjs` (no `headers()`) | 7.4 |
| S6 | `JWT_SECRET` has a hardcoded fallback (`'remotebridge-dev-secret-change-in-production'`) with no startup guard, and `JWT_REFRESH_SECRET` defaults to `` `${JWT_SECRET}-refresh` `` — not independent. Booting with `.env.example` defaults gives a publicly-known signing key (total auth-forgery) and a refresh secret trivially derivable from the access secret | `apps/server/src/utils/jwt.ts:6-8`, `.env.example:6-7` | 7.3 |
| S7 | Electron 28 is EOL (outdated Chromium with fixed-since RCE CVEs); the Host window has no `setWindowOpenHandler`, no `will-navigate`/`will-redirect` guard, no CSP via `onHeadersReceived`, and no `sandbox`. A renderer compromise (e.g., via S5-equivalent content) can navigate to attacker content that inherits the `electronAPI` preload bridge | `apps/desktop/package.json:30`, `apps/desktop/src/main/window.ts:27-32` | 7.0 |

### Medium

- **S8** (verifies CQ-C1): the three `Math.random()`-based `generateId()` implementations (`relay.ts:168-170`, desktop `client.ts:232-235`, web `useWebSocket.ts:~249`) aren't just collision-prone — `messageId` is the `ON CONFLICT DO NOTHING` dedup primary key for message persistence, so a predictable ID lets an attacker pre-insert a row with a victim's next `messageId`, silently suppressing that message's persistence; `requestId` predictability also weakens request/response correlation (download/preview matching, pending-requests registry). CWE-330/340.
- **S9** (verifies 01b-H3): `AccessLog.action`/`SecurityLog.eventType` shared unions don't include actually-emitted values (`LIST_ALLOWED`, `TUNNEL_FETCH`, `ACCESS`); no DB `CHECK` constraint on `security_logs.event_type`. Currently low-risk (server-internal, parameterized inserts), but if S3 is fixed naively, a Host token (or forged token per S6) could inject arbitrary `eventType`/`detail` values — log forging / filter evasion. CWE-20/117.
- **S10**: download/preview tokens (`token-manager.ts`) are validated without binding to `clientId` at either the HTTP file server or the WS tunnel — the `CLIENT_MISMATCH` check exists but is dead code, so any holder of a leaked token URL can redeem it (30-min/single-use bounds the blast radius). CWE-639.
- **S11**: both the 2h access token and the 30-day refresh token are stored in `localStorage`, readable by any script in the origin — combined with S5/no-CSP, one XSS yields a 30-day account-takeover credential. CWE-922.

### Low / Info

- **S12**: `getWindowsBlockedDirs()` mutates the shared exported `SYSTEM_BLOCKED_DIRS.win32` array via `.push()` on every call — non-deterministic exported constant (memory growth + masks S4's severity depending on call order). CWE-1025.
- **S13**: Host JWT has a 365-day lifetime with no rotation/revocation; `hostToken`/`hostSecret` sit in plaintext `electron-store` JSON — and per S4 that file can itself be under a shared directory. CWE-522/613.
- **S14**: `String(err)` returned verbatim to remote clients in `RESP_*_ERROR` payloads leaks absolute Host paths and Node error codes — a path-existence/blacklist-boundary oracle. CWE-209.
- **S15**: CORS policy itself is sound (explicit allow-list, no wildcard); minor notes — ensure `ALLOWED_ORIGINS` is always set in prod, and that the relay is always deployed behind TLS (PINs/tokens/secrets traverse it, and `register-host` returns the host secret in the response body). CWE-942/200.

### Verification of Phase-1 items
All five Phase-1-flagged items (01b-C1, 01b-C2, 01b-H3, 01b-M1, 01a-C1) are **confirmed real** by independent code tracing, with C2 (→S1) and M1 (→S4) found to be *more* severe than originally scoped (S1 gained a second independent bug — no revoked-session check; S4 is concretely exploitable for credential/profile exfiltration given the default `permission:'download'` on new shares).

### Checked and found OK
SQL injection (all parameterized), path-traversal core algorithm (`resolve` + separator-prefix matching), PIN generation (`crypto.getRandomValues` + rejection sampling), WS handshake refresh-token/revocation checks, `TextViewer`'s safe text-node rendering, no XXE/`eval`/insecure deserialization.

---

## Performance Findings (02b)

**Scope assessment:** the system's core data paths (file tunnel, room routing, message persistence) are adequately efficient for its stated single-instance, "a PC + a handful of clients" target. Findings below are **latent degradation curves** (weeks/months of uptime) rather than load-bearing-today bottlenecks, and are all low-risk, localized fixes.

### Critical

**C1 — `cleanExpiredTokens()` is dead code; `download_tokens` (desktop) grows unbounded forever**
`apps/desktop/src/main/file-server/token-manager.ts:94-97` exports a working cleanup function that is **never imported or called anywhere** — no interval, no startup/shutdown hook. Every download/preview/tunnel-fetch inserts a row that's never deleted post-use or post-expiry. Impact today is modest (~300-400KB/year for a busy host), but it's the same "half-finished maintenance task" class of bug as 01b-C1 (the 404'ing audit POST).
**Fix:** wire it to an hourly `setInterval(...).unref()` in `apps/desktop/src/main/index.ts`, mirroring the `rateLimitCleaner` pattern already in `apps/server/src/routes/auth.ts:18-26`.

**C2 — No indexes or retention on relay `security_logs`/`messages` → `COUNT(*)`/`ORDER BY...LIMIT` degrade linearly with table age, blocking the event loop**
`apps/server/src/db/client.ts` schema has no secondary indexes on `security_logs(host_id, created_at)` or `messages(session_id, created_at)`, and no DELETE/archival path exists for either table. `GET /security-logs` runs two sequential full-table-scan queries (`COUNT(*)` then paginated `SELECT ... ORDER BY created_at DESC LIMIT ? OFFSET ?`); at ~1M rows (plausible after 1-2 years of multi-host operation, especially once S3/01b-C1 is fixed and Host-side `BLOCKED_PATH`/`ACCESS`/`TUNNEL_FETCH` events start landing) this becomes 10-50ms **per query, run twice per page load**, and because `better-sqlite3` is synchronous, **this blocks the single Fastify event loop** — delaying WS heartbeat PINGs and CMD/RESP routing for *all* hosts/clients during the scan (this is the mechanism that makes M3 a real concern).
**Fix:** add `CREATE INDEX idx_security_logs_host_created ON security_logs(host_id, created_at DESC)` and `idx_messages_session_created ON messages(session_id, created_at DESC)`; add a daily 90-day retention `DELETE` job mirroring `rateLimitCleaner`.

### High

| ID | Title | Location | Fix complexity |
|----|-------|----------|-----------------|
| H1 | WS file tunnel's base64 chunking costs ~2.3x allocations per 256KB chunk (2 buffer copies + 1 string alloc + 1 JSON cycle per chunk); for a 500MB transfer, ~2000 chunks × ~0.5ms base64-encode ≈ **~1s of blocking CPU on the Electron main process** (plus symmetric decode cost on the relay) | `apps/desktop/.../ws-client/file-tunnel.ts:90-120`, `apps/server/src/ws/file-tunnel.ts`, `apps/server/src/routes/proxy.ts:91-99` | Medium-High (binary framing) / Low (tune `CHUNK_SIZE`) |
| H2 | `usePreview.ts`'s per-request raw WS listener (01a-H2) confirmed + quantified: rapid preview clicks realistically stack 3-8 concurrent listeners, each `JSON.parse`-ing every inbound frame (incl. ~75KB `RESP_DIR_LIST`) for up to 15s. Performance cost is modest (~0.5-1.5ms per stacked parse); the **correctness** impact — stale `RESP_PREVIEW_ERROR` from an old request can overwrite the current preview's error state with no `currentRequestIdRef` guard — is the more user-visible problem | `apps/web/src/hooks/usePreview.ts:72-183` | Low (cancel-previous-listener pattern) |
| H3 | Desktop `CMD_LIST_DIR` issues an **unbounded `Promise.all`** of `fs.stat` over every directory entry — for a 5,000-entry directory, all 5,000 stats queue behind libuv's 4-thread pool; on network/spinning-disk drives this is **6-12 seconds** before `RESP_DIR_LIST` resolves (the same pattern repeats harmlessly in `CMD_LIST_ALLOWED` since the whitelist is small) | `apps/desktop/.../ws-client/dir-handlers.ts:151-177` (also 39-58) | Low (`p-limit`, ~32 concurrency) |

### Medium

- **M1** (extends 01a-M3): `app-store.ts::loadMessageHistory`'s `Set`-rebuild is confirmed O(n+m) but only reaches ~2-4ms past ~10K messages (3-6 months of heavy use); at that scale, **unvirtualized rendering of the full `messages` array in `Messages.tsx`** (no `react-window`) is the dominant cost, not the Set rebuild. Recommend a persistent `seenMessageIds` Set as cheap insurance, and virtualization/capping (`last 500 + fetch-on-scroll`) as the real fix if long-lived chat sessions are expected.
- **M2** (extends 01b-H1/H2): the `relay.ts`/`rooms.ts` triple-serialization split is confirmed but **negligible** at realistic scale (<1% CPU at 100 sessions × 1msg/s; GC pressure within V8's young-gen capacity). The one genuine scaling edge is `relayToClient`'s `clientSockets.forEach()` O(n) fallback when `clientId` is absent — if 01b-H1's `RoomRegistry` refactor happens for correctness reasons, ensure it always requires `clientId` (per `RelayRoutingFields`), turning this O(n) path into O(1) as a side effect.
- **M3**: synchronous `better-sqlite3` queries block the single Fastify event loop during slow/unindexed scans — this is the *mechanism* behind C2's impact, not a separate issue; fully mitigated by fixing C2 (no async-worker-thread complexity warranted).

### Low

- **L1**: zero `next/dynamic` usage in `apps/web` — all preview viewers (`ImageViewer`/`PdfViewer`/`TextViewer`/`UnsupportedViewer`, ~600 lines) ship in the main dashboard bundle. Impact is single-digit KB today; establish the lazy-loading pattern now in case a heavier viewer (PDF.js, syntax highlighter) is added later.
- **L2**: `FileList.tsx` re-sorts its full entry array with `localeCompare` on **every render** (no `useMemo`/`React.memo`) — during an active download (200ms-throttled progress updates), a 500-entry list re-sorts every ~200ms (~0.5-2ms each). Trivial `useMemo` fix.
- **L3**: Desktop `Messages.tsx` polls `listClients()` every 10s regardless of window visibility (Electron doesn't throttle background-window timers like browser tabs do). Negligible CPU; gate on `document.visibilityState` or push `CLIENT_JOINED`/`CLIENT_LEFT` from `handlers.ts` instead.

### Cross-cutting observations
- The recurring "looks complete but never wired up" pattern (C1 here, 01b-C1's missing `POST /security-logs`) suggests adding `ts-prune`/`knip` to CI to catch exported-but-uncalled functions.
- The file tunnel's 4MB backpressure design correctly bounds memory regardless of file size — H1 is a CPU/allocation-overhead finding, not an unbounded-memory one.
- Frontend re-render discipline is otherwise good (Zustand selective subscriptions, existing `useMemo` in `Messages.tsx`); L2 is the one notable gap.

---

## Critical Issues for Phase 3 Context

**Testing gaps directly created/highlighted by Phase 2:**
- **S1 / 02a**: no regression test exists (or can exist yet) asserting `/messages/:sessionId` rejects refresh tokens and revoked sessions — Phase 3 should flag this as a missing security-critical test path once S1 is fixed.
- **S6**: no test verifies the server refuses to start with default/weak JWT secrets — once a `reqSecret()` guard is added, a startup test is needed.
- **S3 / 01b-C1**: the entire Host→relay audit-log path (`POST /security-logs`) is currently **untestable** because the route doesn't exist — once added, Phase 3 should expect new tests for `BLOCKED_PATH` propagation and `/access-logs` population (currently always `[]`, likely with zero test coverage of that empty-state assumption).
- **S4**: `path-guard.ts`'s Windows blacklist has no test exercising `%APPDATA%`/`%LOCALAPPDATA%` — Phase 3 should check whether `apps/server/test/` (the only test dir) has any desktop-side path-guard coverage at all (architecture note: desktop has zero `*.test.ts` files per CLAUDE.md, so this is likely a total gap, not a partial one).
- **C1 / 02b** (`cleanExpiredTokens`) and **C2** (retention job): once wired up, need interval-based tests (or a manually-invoked-function test) verifying expired/used tokens and aged log rows are actually deleted.
- **H2 / 02b** (`usePreview` cancel-previous): Phase 3 should check for any existing test of rapid sequential preview requests — the stale-error-overwrite bug (no `currentRequestIdRef` guard on the error branch) is a good target for a regression test once fixed.

**Documentation accuracy issues for Phase 3 (3B) to weigh:**
- CLAUDE.md's security-model section calls the audit pipeline "load-bearing — don't weaken" and states it "writes to both local DB and relay security-logs endpoint" — **S3/01b-C1 confirms the relay half of this claim is currently false** for all Host-originated events. Phase 3 should check whether this is also documented elsewhere (e.g., `使用说明书.md`) with the same inaccuracy.
- `.env.example` should document the `reqSecret()`-style requirements from S6 (≥32 chars, no `change-me`/`dev-secret` patterns, independently-generated `JWT_REFRESH_SECRET`) — currently it likely just shows placeholder values that *look* satisfiable by pasting as-is.
- No CSP guidance exists in any doc for either `apps/web` (S5) or `apps/desktop`'s Electron renderer (S7) — Phase 3 (3B) should note this as a missing "security configuration" documentation section.
