# Phase 3: Testing & Documentation Review

Full detail: `03a-testing.md` (17 findings) and `03b-documentation.md` (9 findings). This file consolidates the Critical/High findings and summarizes the rest.

## Test Coverage Findings (03a)

**Confirmed scope:** per CLAUDE.md, automated tests exist **only** in `apps/server` (1 vitest suite `e2e.test.ts` + 7 manual `.mjs` scripts, 5 of which are live-relay scripts and 2 CDP-driven). `apps/web`, `apps/desktop`, and `packages/shared` have **zero** test files, zero test configs, and no `test` script in `package.json`.

### Critical

**T1 — Three of four packages (`apps/web`, `apps/desktop`, `packages/shared`) have zero automated tests**
This includes `packages/shared/src/security.ts` (the protocol contract + core security validation shared by server and desktop) and `apps/desktop/src/main/security/path-guard.ts` — CLAUDE.md's own "highest-value asset." Every Phase 2 finding located in these packages (S4, S5, S7, S10, S12, H1-H3, M1) currently has **no regression-test path** without first standing up test infra. **Fix:** add a vitest config to `packages/shared` (pure-function tests, no Electron needed) and to `apps/desktop` (vitest against plain TS modules works for `path-guard.ts`/`token-manager.ts` without an Electron runtime).

**T2 — `messages.ts` auth bypass (S1) is confirmed still live in current code, with zero test**
`apps/server/src/routes/messages.ts:6,32,135` still imports/calls `verifyToken`, never checks `revokedAt`. A ~30-line addition to the existing suite (`messages-auth.test.ts`, full code in 03a §6) would document the bug now (failing test) and verify the fix later.

**T3 — Desktop `path-guard.ts` Windows blacklist gap (S4) confirmed still live, zero test**
`path-guard.ts:27` still reads `SYSTEM_BLOCKED_DIRS[platform]` directly, never calling `getWindowsBlockedDirs()`. Testable today once `packages/shared`/`apps/desktop` get vitest infra (T1) — test code provided in 03a §6.

**T4 — JWT weak-secret fallback (S6) confirmed still live, zero startup guard or test**
`apps/server/src/utils/jwt.ts:6,8` — no `index.ts` validation before `app.listen`. Test code (spawn-and-check-exit-code pattern) provided in 03a §6, testable once a `reqSecret()` guard is added.

**T5 — No test for client-side WS reconnect/backoff** (`apps/web/src/hooks/useWebSocket.ts`) — entirely untested, blocked on T1's `apps/web` infra gap.

**T6 — No test for file-tunnel 4MB backpressure / concurrent transfers** — `manual-file-tunnel.mjs` covers a 3-chunk download and Range requests but never simulates a slow consumer to verify the Host actually pauses at the high-water mark, nor verifies multiple concurrent `transferId`s don't cross-contaminate `RESP_FILE_CHUNK` streams.

**T7 — No test for download-token expiry/used/`CLIENT_MISMATCH` branches** (`token-manager.ts:62-72`) — `TOKEN_EXPIRED`, `TOKEN_USED`, and the S10 dead-code `CLIENT_MISMATCH` check all have zero coverage.

### High

- **T8**: The 5 non-CDP manual `.mjs` scripts (`manual-relay-roundtrip`, `manual-host-reconnect`, `manual-file-tunnel`, `manual-message-history`, `manual-live-host`) hold **the majority of the system's real edge-case/security regression coverage** (revocation propagation, host-reconnect room rebuild, Range/error handling, messageId dedup) but aren't run in CI, aren't vitest-shaped (`process.exit(1)` on failure), and duplicate ~40 lines of boilerplate per script. **Highest-leverage recommendation**: port these assertions into `apps/server/test/*.test.ts` using the existing `e2e.test.ts` helpers.
- **T9**: `apps/server/vitest.config.ts` has no `globalSetup` — `pnpm test` fails outright in a clean checkout without a manually-started relay on `:3099`. Recommend a `globalSetup`/`globalTeardown` that spawns the relay against a temp `RB_DATA_DIR` (code provided in 03a §3).
- **T10** (= 02b-C1 testability): `cleanExpiredTokens()` itself is unit-testable today against desktop SQLite even before the interval-wiring fix lands (code provided in 03a §7).
- **T11** (= 02b-C2 testability): index *existence* on `security_logs`/`messages` is testable today via `PRAGMA index_list(...)` — currently shows none, confirming C2.
- **T12** (= 02b-H2): `usePreview.ts`'s stale-`RESP_PREVIEW_ERROR`-overwrite bug (lines 130-139, no `currentRequestIdRef` guard on the error branch, unlike the ready-branch) is confirmed still live; untestable until `apps/web` gets test infra (T1).

### Medium / Low — summary

- **Medium**: `e2e.test.ts`'s message-history and security-logs assertions (`total >= 1`, no content checks) are too shallow to detect S1/S3 regressions even once those routes exist; the suite has intra-file test-order coupling via module-level mutable state (fragile to vitest execution-model changes, no per-run DB isolation); H3's unbounded `Promise.all` over `fs.stat` (dir-handlers.ts:39,153) is confirmed live with zero coverage; the 2 CDP-driven scripts (`manual-trust-revoke.mjs`, `manual-settings-hot-reload.mjs`) are brittle (raw CDP, Chinese-text button matching, undocumented multi-port/multi-process preconditions).
- **Low**: S12's `getWindowsBlockedDirs()` array-mutation bug is unit-testable *today* with zero new infra (code provided in 03a §6) — quick win.

### Top 5 recommendations (from 03a, priority order)
1. Add the S1 regression test (`messages-auth.test.ts`) — should fail now, pass after the fix.
2. Add `globalSetup`/`globalTeardown` to `apps/server/vitest.config.ts` (spawn relay against temp `RB_DATA_DIR`).
3. Stand up minimal vitest infra in `packages/shared` + write `security.ts` unit tests (covers S4, S12).
4. Port the 5 non-CDP manual scripts' assertions into the vitest suite.
5. Stand up minimal test infra in `apps/desktop` (no Electron runtime needed for `path-guard.ts`/`token-manager.ts`) and add the S4 + C1 tests.

---

## Documentation Findings (03b)

**Method:** read CLAUDE.md, 使用说明书.md, `docs/code-review-report.md`, `.env.example`, `scripts/*.sh` in full; cross-checked specific claims against current source.

### Critical

**D1 — CLAUDE.md's "load-bearing" audit-pipeline claim is factually false for all Host-originated events (verifies 01b-C1/S3)**
CLAUDE.md:113 states the audit logger "writes to both local DB and relay security-logs endpoint." Confirmed: `audit-logger.ts:32,59` POST to `${relayApi}/security-logs`, but `security-logs.ts` registers **GET only** — every such POST 404s and is silently swallowed. The local-DB half is true; the relay half is false, so `GET /access-logs` and the web Security dashboard are permanently empty for Host-originated events. The doc doesn't just describe a bug — it asserts the opposite of reality under a section marked "don't weaken." 使民说明书.md line 215 ("查看本会话相关的安全事件") makes the same false promise for the web dashboard.
**Fix:** rewrite CLAUDE.md:113 to state the actual behavior + "KNOWN GAP — see S3/01b-C1" until the route is added; soften/footnote 使用说明书.md:215. Exact replacement text provided in 03b.

**D2 — `.env.example` gives no guidance on JWT secret strength/independence; defaults are insecure and undocumented (verifies S6)**
`.env.example:6-7`'s placeholders (`change-me-to-...`) imply action but specify no length/entropy requirement, no generation command, and don't warn that an unset `JWT_REFRESH_SECRET` derives trivially from `JWT_SECRET` (`jwt.ts:8`, `` `${JWT_SECRET}-refresh` ``) — defeating the independence property the code comment claims. A deployer copying `.env.example` verbatim runs with a publicly-known signing key.
**Fix:** rewrite `.env.example` with explicit `openssl rand -base64 48` guidance and an explicit warning about the derived-fallback footgun; add a "Security note" paragraph to CLAUDE.md's `## Environment` section. Exact text provided in 03b.

### High

**D3 — No CSP documentation anywhere for `apps/web` (S5) or the Electron renderer (S7)**
`apps/web/next.config.mjs` has no `headers()`/CSP; `apps/desktop/src/main/window.ts` has `contextIsolation: true, nodeIntegration: false` but no `sandbox`, `setWindowOpenHandler`, navigation guards, or CSP via `onHeadersReceived` — and **none of this is documented** as a known gap or deployment-time hardening item anywhere.
**Fix:** add a "Security configuration (deployment-time hardening)" subsection to CLAUDE.md covering both gaps as documented known-limitations pending S5/S7 fixes.

**D4 — No CHANGELOG/migration notes for breaking changes already shipped within "1.0.0"**
The refresh-secret separation, persistent `clientId`, and revoked-session WS check (all noted as "fixed after `docs/code-review-report.md` was written" per CLAUDE.md's own caveat) are real upgrade-time behavioral breaks (old refresh tokens invalidate; pre-upgrade "trusted device" records orphan against the new persistent `clientId`) with **zero migration documentation**, and all 4 packages remain pinned at `1.0.0`.
**Fix:** add a minimal `CHANGELOG.md` / "Migration notes" section in CLAUDE.md documenting these two specific upgrade-time breaks.

### Medium / Low — summary

- **D5** (Medium): "ADR-004"/"ADR-005" in CLAUDE.md are inline-only — no `docs/adr/` directory exists. Not wrong, but sets a false expectation of a numbered decision-record series; `00-scope.md` also references non-existent `prd.md`/`RemoteBridge-ARCHITECTURE.md`.
- **D6** (Medium): only one ASCII topology diagram exists (使用说明书.md only) — no diagram for the room/session routing model or the file-tunnel sequence, despite these being the most bug-prone areas (01b-H1/H2, the routing-fields contract). Recommend Mermaid sequence diagrams in CLAUDE.md for both.
- **D7** (Medium): CLAUDE.md's REST API table entry for `messages/:sessionId` doesn't flag that it's the **one** route not covered by the security-model section's blanket refresh-token/revocation guarantees (S1/C2 unfixed) — add a "Known gap" footnote until fixed.
- **D8** (Low, no action needed): CLAUDE.md's own staleness caveat about `docs/code-review-report.md`'s legacy-risks list was independently re-verified item-by-item and found **accurate** — all 4 claimed-superseded items are genuinely superseded, the 2 not claimed are genuinely still open.
- **D9** (Low): inline documentation of the routing-fields contract, file-tunnel backpressure, and path-guard recursive-permission check is **already good** (WHY is explained at both ends); the one gap is missing field-level comments on `RespFileChunkPayload`/`RespFileErrorPayload` in `ws-types.ts`, worth adding ahead of the 02b-H1 binary-framing refactor.

**Overall assessment (from 03b):** documentation is unusually thorough for the repo's size; the issues are concentrated in (a) one security claim (D1) now actively false due to an unfixed bug, (b) a security-config documentation vacuum mirroring S5/S6/S7, and (c) no changelog for a codebase that has already shipped several breaking internal changes under one version number.

---

## Critical Issues for Phase 4 Context

- **Zero test infrastructure in `apps/web`/`apps/desktop`/`packages/shared` (T1)** is itself a best-practices/CI-CD finding — Phase 4B should assess whether any CI pipeline exists at all and, if so, what it actually gates (likely nothing beyond `apps/server`).
- **D1/D2/D3 documentation gaps mirror unfixed Phase-2 code findings (S3/S6/S5/S7)** — Phase 4 should note that "fix the doc" and "fix the code" are two halves of the same remediation item, not independent backlog entries.
- **No CHANGELOG (D4) + all packages at 1.0.0** — Phase 4B (CI/CD & DevOps) should check whether any release/versioning automation exists, since manual version bumps seem to not be happening at all.
- **T9 (no `globalSetup`, `pnpm test` fails in a clean checkout)** is directly relevant to Phase 4B's CI pipeline assessment — if CI runs `pnpm test` today, it is either skipping `apps/server` or failing/has a manual pre-step undocumented anywhere.
