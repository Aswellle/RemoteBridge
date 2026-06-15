# Test & Documentation Gaps Plan (#19)

> Status: **Implemented**. All 6 items below are done: e2e.test.ts assertions deepened
> (#1 — message content/direction, `since`, `limit`/`page` pagination, security-log
> `eventType` filter, `GET /security-logs/events`), test-order coupling documented with a
> top-of-file comment (#2 — the "stretch goal" `beforeAll`-chain refactor was not done,
> per its own framing as optional), `manual-trust-revoke.mjs`/
> `manual-settings-hot-reload.mjs` classified as CDP-only with precondition comments (#3),
> `docs/adr/` created with ADR-004/ADR-005 + a template (#4 — the optional ADR-006
> renumbering of `relay-room-state-design.md` was not done), three Mermaid sequence
> diagrams added — Auth (CLAUDE.md), file tunnel (ADR-004), host reconnect/room rebuild
> (ADR-005) (#5), and the `/messages/:sessionId` revocation guarantee documented in
> CLAUDE.md (#6). Covers the "Test/doc gaps" theme of the P2 backlog in
> `.full-review/05-final-report.md`. One of three Phase-C items from the 2026-06-15
> remediation review; see `docs/observability-logging-design.md` (P1-1) and
> `docs/file-tunnel-binary-framing-design.md` (P1-12) for the other two, both also now
> implemented.

## 1. Shallow assertions in `apps/server/test/e2e.test.ts`

Two specific tests currently only check the response envelope shape:

- **"消息历史 API"** (lines 288-294): asserts `success === true` and `Array.isArray(data)`
  only — never checks that the messages sent earlier in the WS-connection block
  (lines 242-269, "消息中继 Client → Host" / "消息中继 Host → Client") actually appear, in
  order, with correct `direction`/`content`.
- **"安全日志 API"** (lines 296-302): asserts `total >= 1` only — never checks
  `eventType`/`clientId`/date query filters, or the shape of individual entries.

**Before deepening either**: check whether `apps/server/test/relay-roundtrip.test.ts` /
`session-flows.test.ts` (the P1-14 vitest additions referenced in CLAUDE.md) already cover
message-content/security-log-filter assertions — if so, `e2e.test.ts` may be intentionally
a thin end-to-end smoke test and the deepening belongs in those files instead. This
file-existence/coverage check is itself unread as of this plan — first action item for
whoever picks this up.

**If deepening `e2e.test.ts` directly**, candidates:
- Message history: assert the two `MSG_TEXT` messages from the "消息中继" tests appear in
  the response with matching `content`/`direction` (`host_to_client` vs `client_to_host`);
  test the `since` query param returns only messages newer than a captured timestamp; test
  `limit`/`page` pagination.
- Security logs: the PIN-connect flow should have produced at least one identifiable
  `eventType` (check `packages/shared/src/security-log-ui.ts`'s `EVENT_TYPE_LABELS` for the
  actual enum values) — assert it's present; test `eventType`/`clientId`/date filters narrow
  the result set; hit `GET /security-logs/events` and assert the returned type list is
  non-empty.

## 2. Test-order coupling in `e2e.test.ts`

Module-level mutable state (`hostToken`, `hostId`, `clientToken`, `refreshToken`,
`sessionId`, `pin`, `clientId`) is set by early `it()`s and read by later ones, across
`describe` blocks. Vitest runs `it()`s within a file sequentially by default, so this works
today, but:
- a failure in an early test (e.g. "注册 Host") cascades into every dependent later test
  failing with a confusing "token is empty"-style error, obscuring the real root cause;
- it silently forbids future `test.concurrent`/`.each` refactors in this file.

**Recommendation** (pragmatic, low-effort): add a top-of-file comment documenting the
sequential-dependency convention explicitly, so it's a deliberate choice rather than
something a future editor "fixes" by parallelizing and breaks. **Stretch goal**: refactor
to a `beforeAll` chain producing a shared context object consumed read-only by each `it`,
making dependencies explicit — bigger effort, only worth it if this file grows
significantly further.

## 3. Brittle CDP manual scripts

`apps/server/test/manual-trust-revoke.mjs` and `manual-settings-hot-reload.mjs` require
Electron launched with `--remote-debugging-port=9222` and an active web client session,
driving the real renderer UI via CDP. Brittle because: can't run in CI, depend on UI
selector/timing stability, and silently stop catching regressions if the UI is refactored
without anyone re-running them manually.

**Research task** (not yet done — neither script has been read in this planning pass):
read both scripts and classify each assertion as:
- **UI-only** (genuinely needs the rendered DOM — e.g., a toast/notification appearing) —
  keep as CDP scripts, but add a header comment with exact preconditions/run command if
  one is missing.
- **IPC/store-testable** (really testing a main-process IPC handler or Zustand store
  transition that the UI merely triggers) — candidate to move into `apps/desktop`'s vitest
  suite (call the IPC handler directly, assert store/DB state) or `apps/web`'s (assert
  store state after a simulated WS message), removing the CDP dependency for that
  assertion entirely.

## 4. Missing `docs/adr/`

CLAUDE.md references "ADR-004" (WS file tunnel) and "ADR-005" (in-memory single-instance
room state) only as inline parenthetical mentions — no formal ADR documents exist.
`docs/relay-room-state-design.md` (the P1-7 design pass) is already effectively ADR-quality
content for the room-state decision.

**Plan**:
- Create `docs/adr/` with a lightweight template (Context / Decision / Consequences /
  Status).
- **ADR-004** (file tunnel): document the base64-JSON-framing-as-built design, with a
  "Superseded by / see `file-tunnel-binary-framing-design.md`" status note once that lands.
- **ADR-005** (in-memory rooms, single instance): consolidate from CLAUDE.md's architecture
  section + `docs/runbook.md` §1.1 + `docs/relay-room-state-design.md`'s framing
  ("ADR-005 accepted in-memory room state on the basis that relay restarts self-heal via
  reconnect + host-reconnect room rebuild").
- Optional: retroactively renumber `relay-room-state-design.md` as an ADR (e.g. ADR-006,
  "room state consolidation") and move it into `docs/adr/` for consistency — or leave it in
  place and cross-reference from ADR-005.

## 5. No sequence diagrams

Three flows are worth a Mermaid sequence diagram, embedded in the doc that already
discusses them rather than a separate diagrams file:
- **Auth**: register-host → generate-pin → connect → JWT issuance (CLAUDE.md "Core flows"
  or a new ADR).
- **Proxy file tunnel**: Client → Relay (`CMD_REQUEST_DOWNLOAD`) → Host
  (`RESP_DOWNLOAD_READY`) → Client rewrites to proxy URL → Relay (`CMD_FETCH_FILE`) → Host
  (`RESP_FILE_CHUNK` ×N) → Relay HTTP response (ADR-004).
- **Host reconnect / room rebuild** (ADR-005 / `docs/runbook.md` §1.1).

## 6. `/messages/:sessionId` revocation-guarantee doc gap

`apps/server/src/routes/messages.ts` already returns `403 SESSION_REVOKED` for both `GET`
and `POST` when `sessions.revokedAt` is set (lines 63-70, 184-191) — implemented but
undocumented. **Trivial fix**: add a sentence to CLAUDE.md's REST API routes section noting
this behavior.

## Suggested sequencing

Quick wins first: **#6** (one CLAUDE.md sentence) and **#4/#5** (ADR docs — mostly
consolidating prose that already exists in CLAUDE.md/`runbook.md`, plus 2-3 Mermaid
diagrams). **#1/#2** require iterating against a running test relay
(`pnpm --filter @remotebridge/server test`). **#3** needs the most original research
(reading two unread scripts and the desktop/web stores to judge IPC-testability) — do this
last or hand off separately.
