# Comprehensive Code Review Report — RemoteBridge

## Review Target

Whole monorepo: `apps/server` (Fastify relay), `apps/web` (Next.js 14 client), `apps/desktop` (Electron 28 Host agent), `packages/shared` (protocol/security contract), plus `apps/server/test`. ~81 files, ~12,151 LOC. See `00-scope.md` for the full file list.

## Executive Summary

RemoteBridge's core design is sound: the outbound-only relay-room topology, the dual path-validation algorithm in `shared/security.ts`, the WS file-tunnel backpressure design (ADR-004), and the reconnect/auth-recovery state machines on both ends are all solid foundations that should be preserved. However, the review surfaced a recurring **"looks complete but was never wired up"** pattern that appears at least four separate times across the codebase — a non-existent `POST /security-logs` endpoint that silently swallows all Host-side audit events (making CLAUDE.md's "load-bearing" audit claim false), a `cleanExpiredTokens()` function that's never called, a `messages.ts` auth check that was missed during a prior security migration (CVSS 8.1), and an `output: 'standalone'` Next.js config with no Dockerfile to use it. Separately, **test coverage is concentrated entirely in `apps/server`** — `apps/web`, `apps/desktop`, and `packages/shared` (including the security-critical `path-guard.ts` and `security.ts`) have zero automated tests — and **there is no CI/CD, containerization, or process supervision anywhere**, which is a significant gap for a relay meant to run as an internet-exposed, TLS-fronted service. None of the 12 Critical findings below require a large rewrite; most are small, targeted fixes (swap a function call, add an index, wire an existing function to an interval, add one GitHub Actions file).

## Findings by Priority

### Critical Issues (P0 — Must Fix Immediately)

Findings are deduplicated where multiple phases independently confirmed the same root issue — source references show every phase that touched it.

**P0-1 — `messages.ts` REST routes accept refresh tokens and never check session revocation** *(01b-C2 → 02a-S1, CVSS 8.1 → 03a-T2)*
`apps/server/src/routes/messages.ts:6,32,135` uses `verifyToken` (signature-only) instead of `verifyAccessToken`, and never checks `session.revokedAt`. A 30-day refresh token can read/write message history past the 2h access window, and a **revoked client's** token still works against this route until natural expiry. This is a partial regression of a previously-fixed issue (every other authenticated route was migrated to `verifyAccessToken`). **Fix**: swap to `verifyAccessToken` in both handlers; reject if `revokedAt` is set (403 `SESSION_REVOKED`). Add the regression test from 03a (`messages-auth.test.ts`). *Effort: Small.*

**P0-2 — Host audit-log pipeline POSTs to a relay endpoint that doesn't exist** *(01b-C1 → 02a-S3 → 03b-D1, 04b-DC4 context)*
`apps/desktop/src/main/security/audit-logger.ts:32,59` POSTs every access/security event to `${relayApi}/security-logs`, but `apps/server/src/routes/security-logs.ts` registers **GET only**. Every Host-originated `BLOCKED_PATH`/`ACCESS`/`TUNNEL_FETCH` event 404s and is silently dropped by the fire-and-forget catch — `GET /access-logs` is permanently empty, and CLAUDE.md's security-model section (marked "don't weaken") asserts the opposite of reality for this path. **Fix**: add `POST /security-logs` (validate + insert, matching the shape `audit-logger.ts` already sends); also extend the shared `SecurityLog.eventType`/`AccessLog.action` unions to include `LIST_ALLOWED`/`TUNNEL_FETCH`/`ACCESS` (01b-H3/02a-S9) so the new route can validate input properly. Then correct CLAUDE.md:113 and `使用说明书.md:215` per 03b-D1's exact rewrite text. *Effort: Small–Medium.*

**P0-3 — Three independent non-cryptographic `Math.random()` ID generators used as DB dedup/routing keys** *(01a-C1 → 04a-B1, all three locations now confirmed)*
`apps/server/src/ws/relay.ts:168-170`, `apps/desktop/src/main/ws-client/client.ts:232-235`, and `apps/web/src/hooks/useWebSocket.ts:248-251` all implement the same `Math.random().toString(36)` pattern for IDs that double as the `messageId` dedup key for `local_messages`/`messages` persistence — a predictable ID lets an attacker pre-insert a row with a victim's next `messageId`, silently suppressing that message. Note `apps/web`'s own `app-store.ts`/`usePreview.ts` already correctly use `crypto.randomUUID()` — only `useWebSocket.ts` is inconsistent. **Fix**: replace all three with `crypto.randomUUID()` (web) / `nanoid()` (server, desktop — already a dependency in both). No protocol shape change. *Effort: Small.*

**P0-4 — `cleanExpiredTokens()` is dead code; desktop `download_tokens` table grows unbounded forever** *(02b-C1 → 03a-T10 testability)*
`apps/desktop/src/main/file-server/token-manager.ts:94-97` exports a working cleanup function that is never imported or called — no interval, no startup/shutdown hook. **Fix**: wire to an hourly `setInterval(...).unref()` in `apps/desktop/src/main/index.ts`, mirroring the existing `rateLimitCleaner` pattern in `apps/server/src/routes/auth.ts:18-26`. Add the unit test from 03a §7. *Effort: Small.*

**P0-5 — No indexes or retention on relay `security_logs`/`messages` tables; synchronous SQLite blocks the single event loop** *(02b-C2 → 03a-T11 testability)*
`apps/server/src/db/client.ts` has no secondary indexes on `security_logs(host_id, created_at)` or `messages(session_id, created_at)`, and no archival/retention path for either. `GET /security-logs` runs two sequential full-table-scan queries per page load; at scale (especially once P0-2 starts populating `security_logs` from Host events), this **blocks the single Fastify event loop**, delaying WS heartbeats and CMD/RESP routing for every connected host/client. **Fix**: add the two indexes; add a daily 90-day retention `DELETE` job mirroring `rateLimitCleaner`. This also resolves 02b-M3 (sync-SQLite-blocks-loop is a symptom, not a separate issue). *Effort: Small.*

**P0-6 — Weak/default JWT secrets are shippable with zero startup guard or documentation** *(02a-S6 → 03b-D2 → 04b-DC7)*
`apps/server/src/utils/jwt.ts:6-8` hardcodes a fallback `JWT_SECRET` with no startup validation, and derives `JWT_REFRESH_SECRET` from `JWT_SECRET` if unset — defeating the independence the code comment claims. `.env.example` gives zero guidance on secret strength/generation, and (separately, 04b-DC7) is also missing `RB_DATA_DIR` entirely while listing the runtime-unused `DATABASE_URL`. **Fix**: add a `reqSecret()`-style startup guard that refuses to boot in `NODE_ENV=production` with default/weak/missing secrets (this single check also closes most of 04b-DC8's "no NODE_ENV gating" gap); rewrite `.env.example` with `openssl rand -base64 48` guidance, add `RB_DATA_DIR`, and fix the `RELAY_PORT=443`-with-no-TLS-path default (→ `3001`, document TLS as a reverse-proxy concern per P0-11). Add the startup-guard test from 03a (`startup-secrets.test.ts`). *Effort: Small.*

**P0-7 — Four divergent implementations of file-category/extension-list logic** *(01a-H3 → 04a-B2, escalated: now 4 copies confirmed)*
`packages/shared/src/file-utils.ts` (incomplete baseline), `apps/desktop/.../dir-handlers.ts` (~425-447), `apps/web/.../FileList.tsx` (15-38), and `apps/web/.../FilePreview.tsx` (144-158) each independently classify file extensions into image/text/previewable categories with **different extension sets**. The desktop Host can decide a file is previewable using one list, then `FilePreview.tsx`'s local fallback re-classifies it differently when the server's `category` is `'unknown'` — inconsistent UI behavior for the same file type. **Fix**: expand `packages/shared/file-utils.ts::PREVIEWABLE_TYPES` to the union of all four lists (additive, backward-compatible); delete the three local copies and import from `@remotebridge/shared` (both consumers already depend on it); keep `FileList.tsx`'s icon-selection map but key it off `getFileCategory()`'s output. *Effort: Medium.*

**P0-8 — Three of four packages (`apps/web`, `apps/desktop`, `packages/shared`) have zero automated tests** *(03a-T1)*
This includes `packages/shared/src/security.ts` (the protocol contract + core security validation shared by server and desktop) and `apps/desktop/src/main/security/path-guard.ts` — the project's own highest-value security asset. Every finding located in these packages (P0-7, P1-9, P1-11, P1-12, P2 items) currently has **no regression-test path**. **Fix**: add minimal vitest configs to `packages/shared` and `apps/desktop` (both testable without an Electron runtime for `path-guard.ts`/`token-manager.ts`/`security.ts`). *Effort: Medium.*

**P0-9 — Critical untested paths: WS reconnect/backoff, file-tunnel backpressure, download-token edge cases** *(03a-T5, T6, T7)*
No test exists for `apps/web/src/hooks/useWebSocket.ts`'s reconnect/backoff logic (T5, blocked on P0-8); `manual-file-tunnel.mjs` never simulates a slow consumer to verify the Host actually pauses at the 4MB backpressure high-water mark, nor verifies concurrent `transferId`s don't cross-contaminate `RESP_FILE_CHUNK` streams (T6); `token-manager.ts:62-72`'s `TOKEN_EXPIRED`/`TOKEN_USED`/dead-code `CLIENT_MISMATCH` branches have zero coverage (T7). *Effort: Medium (after P0-8).*

**P0-10 — No CI pipeline exists at all** *(04b-DC1)*
No `.github/`, `.gitlab-ci*`, or any CI vendor config anywhere. Every commit — including changes to `packages/shared`, which both `apps/server` and `apps/desktop` import as compiled `dist/` — can merge without a build, lint, or test running. Combined with P1-15 (`vitest.config.ts` has no `globalSetup`), even a naive `pnpm test` CI step would fail today. **Fix**: minimal GitHub Actions workflow: `pnpm install --frozen-lockfile` → `pnpm --filter @remotebridge/shared build` → `pnpm build` → `pnpm --filter @remotebridge/web lint` → typecheck. A build+lint-only workflow with no tests is still a massive improvement over zero. *Effort: Small.*

**P0-11 — No process supervision for the production relay; no containerization/IaC; deploy story is incompatible with the security model's TLS requirement** *(04b-DC2, 04b-DC3)*
`scripts/deploy-server.sh` ends in a bare foreground `node dist/index.js` — no systemd/pm2, no restart-on-crash or restart-on-reboot. ADR-005's "restart self-heals via reconnect" reasoning only holds if restarts are automatic; today a crash is an **indefinite outage**. Separately, no Dockerfile/docker-compose exists anywhere (despite `apps/web`'s `next.config.mjs` setting `output: 'standalone'`, an unused containerization-oriented config — the same "wired but unused" pattern as P0-2/P0-4); `.env.example` documents `RELAY_PORT=443`/`RELAY_HOST=0.0.0.0` with **no reverse-proxy/TLS guidance**, meaning PINs/JWTs/file contents would transit the relay in cleartext if deployed as documented, and browsers would refuse a `wss://`↔`ws://` mismatch from an HTTPS web client. **Fix**: wrap the relay with systemd (`Restart=on-failure`) or pm2; provide a reference multi-stage `Dockerfile` + `docker-compose.yml` including a TLS-terminating reverse proxy (Caddy); either wire `apps/web`'s `standalone` output into the same compose or remove it. *Effort: Medium.*

**P0-12 — `dir-handlers.ts` Windows path-guard doesn't blacklist `%APPDATA%`/`%LOCALAPPDATA%`** *(01b-M1 → 02a-S4, CVSS 7.1 → 03a-T3)*
`apps/desktop/src/main/security/path-guard.ts:27` reads the raw static `SYSTEM_BLOCKED_DIRS[platform]` and never calls shared `getWindowsBlockedDirs()` — Windows hosts don't blacklist `%APPDATA%`/`%LOCALAPPDATA%`/`.ssh` even though the shared validator does. A recursive+download share of `C:\Users\<name>` (the default for new shares per `permission:'download'`) exposes browser credential stores, `electron-store` configs (including RemoteBridge's own `hostToken`/`hostSecret`), and SSH keys. Also fix `getWindowsBlockedDirs()`'s array-mutation bug (S12, `.push()` on the shared exported array on every call). **Fix**: call `getWindowsBlockedDirs()` from `path-guard.ts`; make it pure (return a new array). Add the test from 03a §6 (testable today once P0-8 lands). *Effort: Small.*

> Re-prioritization note: this item is graded Critical here (escalated from its Phase-2 "High/S4" rating) because it's a credential-exfiltration path with a concrete default-configuration trigger, and because P0-8 makes it finally testable — bundling the fix with its test is low-effort and high-value.

---

### High Priority (P1 — Fix Before Next Release)

| ID | Finding | Source(s) |
|----|---------|-----------|
| P1-1 | `console.log/error/warn` scattered across ~40+ production paths (server, desktop, web) instead of structured logging (pino/electron-log); includes a leftover debug `console.log` in `relay.ts::notifyAndDisconnectClient` and an emoji-prefixed pre-`app`-exists log in `db/client.ts`. Feeds directly into P1-23's observability gap. | 01a-H1, 04a-B9, 04b-DC4 |
| P1-2 | `apps/web/src/hooks/usePreview.ts:72-183` attaches a per-request raw `message` listener with no cancellation of prior requests — confirmed listener/timeout leak AND a correctness bug: stale `RESP_PREVIEW_ERROR` from an old request can overwrite the current preview's error state (no `currentRequestIdRef` guard on the error branch, unlike the ready branch). Untestable until P0-8 lands. | 01a-H2, 02b-H2, 03a-T12 |
| P1-3 | `apps/server/src/ws/relay.ts::notifyAndDisconnectClient` returns `void` and only logs — callers (session revocation) can't detect a failed disconnect. | 01a-H4 |
| P1-4 | Desktop `apps/desktop/src/main/ws-client/client.ts::send()` (150-160) silently drops messages when WS not OPEN, no queue/return value — especially dangerous for `RESP_FILE_CHUNK` (truncated downloads, no error surfaced). | 01a-H5 |
| P1-5 | `GET /access-logs` uses an inline ad-hoc host-only auth check while the adjacent `/security-logs/events` uses `resolveScopedHostId()` — inconsistent auth pattern between neighboring endpoints. | 01a-H6 |
| P1-6 | `ws/relay.ts`/`ws/rooms.ts`/per-endpoint `send()` form **three** independent serialization paths; the REST message-send fallback (`messages.ts:201` → `sendToHost`) doesn't inject `sessionId`/`senderType`/`messageId` per `RelayRoutingFields`, reintroducing the dedup-key divergence the routing contract was meant to prevent. | 01b-H1 |
| P1-7 | Room state (`hostSockets`/`clientSockets`/`sessionRooms`) is module-private in `handler.ts`, push-injected into `relay.ts` via `initRelay()`, while `rooms.ts` pull-imports the same Maps directly — circular import, temporal coupling, and ADR-005's single-instance trade-off is now structural rather than a deployment choice. | 01b-H2 |
| P1-8 | Shared `AccessLog.action`/`SecurityLog.eventType` unions don't include actually-emitted values (`LIST_ALLOWED`, `TUNNEL_FETCH`, `ACCESS`) — only compiles because emission sites type `action` as bare `string`. Must be fixed as part of P0-2 (new `POST /security-logs` route needs a correct union to validate against); otherwise a forged Host token could inject arbitrary `eventType` values (log forging/filter evasion). | 01b-H3, 02a-S9 |
| P1-9 | `POST /auth/register-host` is unauthenticated and has **no rate limit** — unbounded host-row creation enables DB-growth DoS and amplifies `/auth/connect`'s per-host bcrypt PIN scan into a CPU DoS. No detection method or mitigation runbook exists (see P1-24). | 02a-S2 |
| P1-10 | No CSP anywhere in `apps/web`; PDF preview renders in an unsandboxed `<iframe>` from a blob URL. A `.pdf`-extension file with HTML/JS content (extension trusted, not content-sniffed) executes script same-origin → theft of `localStorage` tokens (interacts with S11/02a). Zero documentation of this gap either. | 02a-S5, 03b-D3 |
| P1-11 | Electron 28 is EOL (fixed-since RCE CVEs in its Chromium); Host window has no `setWindowOpenHandler`, no navigation guards, no CSP via `onHeadersReceived`, no `sandbox`. A renderer compromise can navigate to attacker content that inherits the `electronAPI` preload bridge. Zero documentation of this gap either. | 02a-S7, 03b-D3 |
| P1-12 | WS file tunnel's base64 chunking costs ~2.3x allocations per 256KB chunk — for a 500MB transfer, ~1s of blocking CPU on the Electron main process (plus symmetric cost on the relay). Memory stays bounded (4MB backpressure design is correct); this is a CPU/allocation finding only. | 02b-H1 |
| P1-13 | Desktop `CMD_LIST_DIR` issues an unbounded `Promise.all` of `fs.stat` over every directory entry — for a 5,000-entry directory on network/spinning-disk drives, 6-12 seconds before `RESP_DIR_LIST` resolves. Confirmed still live, zero test. | 02b-H3, 03a-T16 |
| P1-14 | The 5 non-CDP manual `.mjs` scripts (`manual-relay-roundtrip`, `manual-host-reconnect`, `manual-file-tunnel`, `manual-message-history`, `manual-live-host`) hold the majority of the system's real edge-case/security regression coverage but aren't CI-wired, aren't vitest-shaped (`process.exit(1)`), and duplicate ~40 lines of boilerplate each. Highest-leverage test recommendation: port these into `apps/server/test/*.test.ts`. | 03a-T8 |
| P1-15 | `apps/server/vitest.config.ts` has no `globalSetup` — `pnpm test` fails outright in a clean checkout without a manually-started relay on `:3099`. Blocks P0-10's test-job from working unattended. | 03a-T9 |
| P1-16 | No CHANGELOG/migration notes for breaking internal changes already shipped (refresh-secret separation, persistent `clientId`, revoked-session WS check) despite all 4 packages remaining pinned at `1.0.0`. Compounds 04b-DC10's "can't tell what's deployed" gap. | 03b-D4, 04b-DC10 |
| P1-17 | `apps/web` is 18/20 source files `'use client'` (98%) — likely intentional given the WS-driven SPA architecture (no server-fetchable data exists), but undocumented as a deliberate choice. | 04a-B3 |
| P1-18 | `@fastify/rate-limit ^9.1.0` is declared but never registered; `routes/auth.ts` hand-rolls an in-memory rate limiter with manual `setInterval`/`unref()` cleanup for exactly what this plugin provides (including Redis-backed stores relevant if ADR-005 is revisited). Fixing this is also the natural place to add P1-9's missing rate limit on `register-host`. | 04a-B4 |
| P1-19 | `zustand ^4.5.0` declared in `apps/desktop/package.json` but zero usage (grep-confirmed) — `App.tsx` alone has 13 `useState` calls with prop-drilling and duplicated 10s polling across 3 pages. Either remove the dep or migrate to a store mirroring `apps/web`'s working `app-store.ts`. | 04a-B5 |
| P1-20 | Two independent `EVENT_TYPE_LABELS`/`EVENT_TYPE_COLORS` maps (desktop `SecurityLogs.tsx` vs web `security/page.tsx`) for the same 5 `eventType` values, with **different colors** for `REVOKE`/`PIN_EXPIRED` (copy-paste drift), neither `satisfies`-checked against the shared union — silently incomplete if P0-2/P1-8 add new event types. | 04a-B6 |
| P1-21 | No metrics/tracing/log-aggregation; `/health` and `/api/v1/status` are unconditional liveness pings that don't check DB writability or table sizes — combined with P0-4/P0-5, an operator has no way to detect unbounded growth before it causes an outage. Direct consequence of P1-1's logging gap. | 04b-DC4 |
| P1-22 | No incident-response runbook — `使用说明书.md` §8 covers only client-side/local-dev issues. Nothing documents relay-crash recovery (ties to P0-11), detecting/mitigating P1-9's DoS, or a rollback procedure (no versioning/tagging exists, ties to P1-16). | 04b-DC5 |
| P1-23 | Electron desktop has no auto-update mechanism or code-signing/distribution pipeline — `electron-builder.config.ts` has no `publish` config, no signing/notarization. Every protocol change (cf. P1-16's lack of versioning) requires manual reinstall by every user, with unsigned builds triggering SmartScreen/Gatekeeper. | 04b-DC6 |

---

### Medium Priority (P2 — Plan for Next Sprint)

Grouped thematically; full detail in the per-phase reports.

- **Type safety / contract drift**: `as any` forest around `(ws as any).__meta` connection metadata (01a-M1); `JWT_CONFIG` not `as const`, forcing `as any` in `jwt.ts` (04a-B7); Drizzle `schema.ts` and hand-written `CREATE TABLE` DDL are two unsynced sources of truth, desktop DB reads use `as any` (01b-M2/01a-M10, dependency-hygiene angle in 04a-B18).
- **Token/session hardening**: download/preview tokens not bound to `clientId` — the `CLIENT_MISMATCH` check exists but is dead code (02a-S10, also 03a-T7); access + refresh tokens both in `localStorage`, readable by any XSS (02a-S11, compounds P1-10); 365-day Host JWT with no rotation, `hostToken`/`hostSecret` in plaintext `electron-store` (02a-S13, compounds P0-12's exposure risk).
- **Frontend correctness/perf**: `app-store.ts::loadMessageHistory`'s O(n+m) Set-rebuild is dwarfed by `Messages.tsx`'s unvirtualized rendering at scale — recommend capping/virtualizing before optimizing the Set rebuild (02b-M1); three different "host online" notions disagree across `/auth/connect`, `/hosts/:id/status`, and the proxy (01b-M4); `download-manager.ts` anchor-element removal race with async save dialogs (01a-M4); blob URLs revoked after a fixed 60s timeout (01a-L10); message-type fragmentation across shared/app-store/desktop schema (01a-M5).
- **Module/build hygiene**: CJS `require()` inside otherwise-ESM desktop files — `ipc/messages.ts`'s `require('@remotebridge/shared')` looks like a static import would work (04a-B8); `turbo.json`'s `dev` task lacks `dependsOn: ["^build"]`, so a fresh `pnpm dev` fails to resolve `@remotebridge/shared` until the documented manual build step runs (04a-B10); turbo 1.x `"pipeline"` → 2.x `"tasks"` migration note for the next major bump (04a-B11); dynamic `await import()` in `routes/auth.ts`/`routes/hosts.ts` signals an underlying circular dependency — the `@remotebridge/shared` dynamic import specifically looks unnecessary (04a-B12, relates to P1-7).
- **Test/doc gaps**: `e2e.test.ts`'s message-history/security-logs assertions are too shallow to catch P0-1/P0-2 regressions even once fixed (03a, Medium); intra-file test-order coupling via module-level mutable state (03a, Medium); 2 CDP-driven manual scripts are brittle (raw CDP, Chinese-text matching) (03a, Medium); "ADR-004"/"ADR-005" are inline-only in CLAUDE.md with no `docs/adr/` directory (03b-D5); no sequence diagrams for room-routing or file-tunnel flows, the two most bug-prone areas (03b-D6); `messages/:sessionId`'s REST entry doesn't flag that it's the one route outside the revocation/refresh-token guarantee until P0-1 lands (03b-D7).
- **Environment/ops**: no `NODE_ENV` gating anywhere — CORS falls back to `localhost:3000` in prod if `ALLOWED_ORIGINS` unset, `apps/web`'s `NEXT_PUBLIC_*` build-time vars silently bake in `localhost` if unset at build time (04b-DC8, partially addressed by P0-6's startup guard).

### Low Priority (P3 — Track in Backlog)

- `getWindowsBlockedDirs()`'s array-mutation bug, independent of P0-12's severity issue (02a-S12).
- Verbose `String(err)` returned to remote clients leaks absolute Host paths/Node error codes — path-existence oracle (02a-S14).
- CORS policy itself is sound; ensure `ALLOWED_ORIGINS` always set in prod and relay always behind TLS (02a-S15, ties to P0-11).
- Zero `next/dynamic` usage — all preview viewers (~600 lines) ship in the main bundle (02b-L1).
- `FileList.tsx` re-sorts its full entry array with `localeCompare` on every render, no `useMemo` (02b-L2).
- Desktop `Messages.tsx` polls `listClients()` every 10s regardless of visibility (02b-L3).
- `getRoomInfo()`'s `hostName` permanently `''` behind an unfinished `// TODO: 从数据库获取` (01a-L1/01b-L2, → 04a-B15).
- Stale `CLIENT_JOINED` TODO in `auth.ts:272` (01a-L2).
- Unhandled `app.close()` rejection before `process.exit(0)`; silent `electron-binding.ts` dlopen fallback masks native-module load failures; `initDatabase()` called at module scope on desktop (01a-L5/L6/L8).
- `localStorage` host-info sync across tabs; `verifyAccessToken` used where a host-only check would suffice (01a-L9/L7).
- `RespFileChunkPayload` redundantly resends `contentType`/`fileName`/`totalSize` on every chunk (01b-L5).
- Dead `'use client'` directives copy-pasted into 4 Electron renderer files — zero effect outside Next.js App Router (04a-B13).
- Hand-rolled SVG icons in desktop `App.tsx` despite `lucide-react` already being a dependency (04a-B14).
- `<img>` vs `next/image` in `ImageViewer.tsx` is correct as-is (blob URLs + custom pan/zoom need direct DOM access) — just add a comment for future codemods (04a-B16).
- No `engines` field anywhere despite documented native-module ABI sensitivity (04a-B17).
- `drizzle-kit` + `db:generate`/`db:migrate` are dead weight given raw-SQL is the actual source of truth — keep `drizzle-orm` (used), reconsider `drizzle-kit` (04a-B18).
- No dependency-audit/SAST anywhere — no `pnpm audit`, Dependabot, or Semgrep/CodeQL (04b-DC9).
- No version/release discipline — all 4 packages frozen at `1.0.0`, `/health` reports a hardcoded `'1.0.0'` regardless of what's actually deployed (04b-DC10, compounds P1-16/P1-22).

---

## Findings by Category

| Category | Total | Critical | High | Medium | Low |
|---|---|---|---|---|---|
| Code Quality (01a) | 28 | 1 | 6 | ~10 | ~10 |
| Architecture (01b) | 10 core (+5 cross-cutting) | 2 | 3 | ~4 | ~5 |
| Security (02a) | 15 | 1 | 6 | 4 | 4 |
| Performance (02b) | 11 | 2 | 3 | 3 | 3 |
| Testing (03a) | 17 | 7 | 5 | 4 | 1 |
| Documentation (03b) | 9 | 2 | 2 | 3 | 2 |
| Best Practices (04a) | 18 | 2 | 4 | 6 | 6 |
| CI/CD & DevOps (04b) | 10 | 3 | 3 | 2 | 2 |
| **Raw total** | **~118** | — | — | — | — |
| **Deduplicated (this report)** | **~58** | **12** | **23** | **~17** | **~16** |

The raw per-phase total (~118) double-counts issues independently surfaced by multiple phases (e.g., the messages.ts auth bug appears in 01b, 02a, and 03a; the audit-logging gap appears in 01b, 02a, 03b, and 04b). The deduplicated counts above (P0-P3 sections) reflect distinct underlying issues.

## Recommended Action Plan

Ordered to front-load small, high-impact security/reliability fixes, then unblock testing and CI, then operational hardening.

1. **Security hotfixes** *(Small, do first — independent of each other, can parallelize)*
   - P0-1: swap `verifyToken`→`verifyAccessToken` + `revokedAt` check in `messages.ts`.
   - P0-6: add startup JWT-secret-strength guard (also closes most of P2's `NODE_ENV` gating gap).
   - P0-12: call `getWindowsBlockedDirs()` from `path-guard.ts`; fix its array-mutation bug.
   - P0-3: replace 3 `Math.random()` ID generators with `crypto.randomUUID()`/`nanoid()`.

2. **Close the "wired but not connected" gaps** *(Small–Medium)*
   - P0-2 + P1-8: add `POST /security-logs`, extend `SecurityLog`/`AccessLog` type unions to match emitted values, correct CLAUDE.md:113 + `使用说明书.md:215`.
   - P0-4: wire `cleanExpiredTokens()` to an hourly interval.
   - P0-5: add the two missing indexes + a 90-day retention job for `security_logs`/`messages`.

3. **Consolidate file-category logic** *(Medium)* — P0-7: expand `shared/file-utils.ts`, delete 3 local copies.

4. **Stand up test infrastructure** *(Medium, unblocks a long tail of other fixes)*
   - P0-8: minimal vitest in `packages/shared` and `apps/desktop` (no Electron runtime needed for `path-guard.ts`/`security.ts`/`token-manager.ts`).
   - P1-15: add `globalSetup`/`globalTeardown` to `apps/server/vitest.config.ts` (spawn relay against temp `RB_DATA_DIR`).
   - P0-9 + regression tests for P0-1/P0-12/P0-3-related dedup risk, once P0-8 lands.
   - P1-14: port the 5 non-CDP manual `.mjs` scripts into the vitest suite.

5. **Stand up CI** *(Small, depends on step 4 for the test job)*
   - P0-10: GitHub Actions — build, lint, typecheck on every push/PR; add a test job once P1-15 lands.
   - P3: add `pnpm audit --prod` (report-only) once CI exists.

6. **Production deployment hardening** *(Small–Medium)*
   - P0-11: systemd/pm2 supervision for the relay; reference `Dockerfile` + `docker-compose.yml` with a TLS-terminating reverse proxy.
   - Rewrite `.env.example` (secret-generation commands, `RB_DATA_DIR`, correct port default) as part of P0-6.
   - P1-21: extend `/health` with a real DB check + table-size reporting.

7. **Remaining High-priority items** *(mix of Small/Medium, can be spread across a sprint)*
   - P1-9 + P1-18: register `@fastify/rate-limit`, replace the hand-rolled limiter, and add the missing rate limit to `register-host`.
   - P1-10 + P1-11 + their doc counterparts: add CSP for `apps/web` and Electron renderer hardening (`sandbox`, navigation guards), then document both.
   - P1-2: fix `usePreview.ts`'s stale-error-overwrite + listener leak (testable after step 4).
   - P1-6/P1-7: address the relay.ts/rooms.ts serialization-path split and the circular room-state import (architectural — scope as its own follow-up design pass).
   - P1-16: add `CHANGELOG.md` documenting the refresh-secret-separation and persistent-`clientId` breaking changes.
   - P1-22: write `docs/runbook.md` covering relay-crash recovery, `register-host` abuse detection, and rollback.

8. **Backlog** *(P2/P3)* — track the remaining ~33 Medium/Low items in the project's issue tracker; none are blocking, but P1-19/P1-20 (unused `zustand`, divergent `EVENT_TYPE_*` maps) and P1-23 (desktop auto-update) are worth scheduling once the above lands, given their user-facing impact.

## Review Metadata

- Review date: 2026-06-13
- Phases completed: 0 (scope), 1A (code quality), 1B (architecture), 2A (security), 2B (performance), 3A (testing), 3B (documentation), 4A (framework best practices), 4B (CI/CD & DevOps), 5 (this report)
- Flags applied: security_focus=no, performance_critical=no, strict_mode=no, framework=TypeScript/pnpm+Turborepo monorepo (Fastify relay, Next.js 14 web, Electron 28 desktop)
- Checkpoint history: PHASE CHECKPOINT 1 (after Phase 2) — user selected "Continue"
