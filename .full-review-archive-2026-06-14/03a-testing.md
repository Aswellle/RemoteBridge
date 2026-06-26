# Phase 3A: Testing Strategy & Coverage Review

## Scope

Reviewed: `apps/server/test/` (8 files: 1 vitest suite + 7 manual `.mjs` scripts), `apps/server/vitest.config.ts`, and verified the absence of test infrastructure in `apps/web`, `apps/desktop`, and `packages/shared`. Cross-referenced against Phase 2 findings (S1, S3/01b-C1, S4, S6, C1, C2, H2) in `02-security-performance.md` / `02a-security.md` / `02b-performance.md`.

**Confirmed**: per CLAUDE.md, automated tests exist **only** in `apps/server` (vitest). `apps/web`, `apps/desktop`, and `packages/shared` have **zero** test files, zero test configs, and no test script in their `package.json` (`apps/web/package.json` has no `test` script at all; `apps/desktop/package.json` likewise).

```
apps/server/test/e2e.test.ts                  <- only vitest suite in the monorepo
apps/server/test/manual-relay-roundtrip.mjs
apps/server/test/manual-host-reconnect.mjs
apps/server/test/manual-file-tunnel.mjs
apps/server/test/manual-message-history.mjs
apps/server/test/manual-live-host.mjs
apps/server/test/manual-trust-revoke.mjs       <- CDP-driven, desktop renderer
apps/server/test/manual-settings-hot-reload.mjs <- CDP-driven, desktop renderer
```

---

## 1. Test Coverage — Critical Finding: Three of Four Packages Have Zero Automated Tests

### Severity: Critical

**What's untested:**
- `packages/shared/src/security.ts` — `validateDirectoryRequest`, `isPathAllowed`, `getWindowsBlockedDirs`, `generatePin`, `JWT_CONFIG`/`RATE_LIMIT_CONFIG`/`DOWNLOAD_TOKEN_CONFIG` constants. This is **the protocol contract and the core security-validation logic shared by both server and desktop** — zero unit tests.
- `apps/desktop/src/main/security/path-guard.ts` — `validatePath`, `isSystemDirectory`. This is the **highest-value security boundary in the whole system** (CLAUDE.md: "the desktop Host exposes the user's real filesystem and is the highest-value asset") and has zero coverage. S4 (Windows `%APPDATA%`/`%LOCALAPPDATA%` blacklist gap, CVSS 7.1) is a live bug that a single unit test would have caught and would catch as a regression test once fixed.
- `apps/desktop/src/main/file-server/token-manager.ts` — `createDownloadToken`, `validateDownloadToken`, `markTokenUsed`, `cleanExpiredTokens` (the dead-code function from C1). Zero coverage.
- `apps/desktop/src/main/ws-client/dir-handlers.ts` — `CMD_LIST_DIR`/`CMD_LIST_ALLOWED`/`CMD_REQUEST_DOWNLOAD`/`CMD_REQUEST_PREVIEW`/`CMD_FETCH_FILE` handlers, the `withRouting()` helper, and the H3 unbounded-`Promise.all` pattern (lines ~39-58, ~151-177). Zero coverage.
- `apps/desktop/src/main/ws-client/file-tunnel.ts` — base64 chunking/backpressure (H1). Zero coverage.
- `apps/web/src/hooks/usePreview.ts` and `apps/web/src/hooks/useWebSocket.ts` — including the H2 stale-error-overwrite bug (no `currentRequestIdRef` guard on the `RESP_PREVIEW_ERROR` branch, confirmed at line 130-139 of `usePreview.ts`). Zero coverage, and React hooks of this complexity (manual WS listener lifecycle, ref-based request cancellation) are exactly the class of code that regresses silently without tests.
- `apps/web/src/lib/download-manager.ts`, `apps/web/src/store/app-store.ts` (message-history dedup `Set` rebuild, M1) — zero coverage.
- `apps/desktop` Electron main-process modules: `electron-binding.ts` (the `process.dlopen` hook — extremely fragile, native-module-version-sensitive, and totally untested), `config/store.ts`, `db/client.ts`, `security/audit-logger.ts` (the broken S3 POST path).

**Risk assessment:**
- For `apps/web` and `apps/desktop`, this isn't merely "low coverage" — it's **no safety net for the two packages that contain the riskiest code paths from Phase 2** (S4 path-guard, S5/H2 preview pipeline, S7 Electron hardening gaps, C1 token cleanup). Every fix recommended in Phase 2 for these packages will be unverifiable except by manual CDP scripts or by hand.
- `packages/shared/src/security.ts` is imported by **both** `apps/server` (`packages/shared` → `validateDirectoryRequest`) and `apps/desktop` (`path-guard.ts` re-implements similar logic but imports `SYSTEM_BLOCKED_DIRS`). A bug here has a blast radius across both packages, yet — because `apps/server`'s vitest config only globs `test/**/*.test.ts` inside `apps/server` — `packages/shared` has **no place to even put a test** without adding its own vitest config.

**Test recommendation:**

1. Add a vitest config + `test/` directory to `packages/shared` (it already has `typescript`/`tsx`-friendly tooling via the workspace; copy `apps/server/vitest.config.ts` pattern). Minimum test set for `security.ts`:

```ts
// packages/shared/test/security.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateDirectoryRequest, isPathAllowed, generatePin, PIN_CHARS } from '../src/security';

describe('validateDirectoryRequest — Windows system blacklist', () => {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;
  const originalLocalAppData = process.env.LOCALAPPDATA;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.APPDATA = 'C:\\Users\\testuser\\AppData\\Roaming';
    process.env.LOCALAPPDATA = 'C:\\Users\\testuser\\AppData\\Local';
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env.APPDATA = originalAppData;
    process.env.LOCALAPPDATA = originalLocalAppData;
  });

  it('blocks %APPDATA% even when nominally inside an allowed parent dir', () => {
    const allowed = [{ path: 'C:\\Users\\testuser', is_active: true }];
    const result = validateDirectoryRequest(
      'C:\\Users\\testuser\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles',
      allowed,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('SYSTEM_PROTECTED');
  });

  it('blocks %LOCALAPPDATA% (electron-store hostToken/hostSecret live here)', () => {
    const allowed = [{ path: 'C:\\Users\\testuser', is_active: true }];
    const result = validateDirectoryRequest(
      'C:\\Users\\testuser\\AppData\\Local\\remotebridge-desktop\\config.json',
      allowed,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('SYSTEM_PROTECTED');
  });

  it('does not block sibling dirs that merely share a prefix with %APPDATA%', () => {
    process.env.APPDATA = 'C:\\Users\\testuser\\AppData\\Roaming';
    const allowed = [{ path: 'C:\\Users\\testuser\\AppData2', is_active: true }];
    const result = validateDirectoryRequest('C:\\Users\\testuser\\AppData2\\share', allowed);
    expect(result.allowed).toBe(true);
  });
});

describe('generatePin', () => {
  it('produces only PIN_CHARS, fixed length, no 0/O/I/1/l', () => {
    for (let i = 0; i < 50; i++) {
      const pin = generatePin(8);
      expect(pin).toHaveLength(8);
      expect(pin).toMatch(new RegExp(`^[${PIN_CHARS}]{8}$`));
    }
  });
});
```

2. Add `apps/desktop` test infra (`vitest` + a config globbing `src/**/*.test.ts` or a `test/` dir; the existing `electron-vite`/TS setup is compatible — `vitest` runs against plain `.ts` modules without needing Electron itself for pure-logic modules like `path-guard.ts` and `token-manager.ts`). Minimum:

```ts
// apps/desktop/test/path-guard.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validatePath, isSystemDirectory } from '../src/main/security/path-guard';

describe('path-guard — Windows blacklist (S4 regression)', () => {
  const originalAppData = process.env.APPDATA;
  beforeEach(() => { process.env.APPDATA = 'C:\\Users\\testuser\\AppData\\Roaming'; });
  afterEach(() => { process.env.APPDATA = originalAppData; });

  it('rejects a recursive+download share rooted above %APPDATA%', () => {
    const allowedDirs = [{
      id: 1, path: 'C:\\Users\\testuser', permission: 'download' as const,
      recursive: true, is_active: true,
    }];
    const result = validatePath('C:\\Users\\testuser\\AppData\\Roaming\\some-app\\creds.json', allowedDirs);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('SYSTEM_PROTECTED');
  });
});
```

3. For `apps/web`, add `vitest` + `@testing-library/react` (or `@testing-library/react-hooks`) — see H2 section below for the specific `usePreview` regression test.

---

## 2. Test Quality (apps/server)

### `e2e.test.ts` — behavior-focused, decent assertion quality, Medium severity gaps

**What's good:**
- Tests are organized by user-facing flow (auth → WS → REST → session management), matching the actual protocol sequence described in CLAUDE.md.
- Assertions check actual response shape (`res.data.data.hostId`, `res.data.data.pin` regex `^[A-Z2-9]{8}$`, token length heuristics) rather than just status codes — reasonable black-box behavioral testing.
- Negative-path tests exist: PIN one-time-use (`401` on reuse), invalid PIN (`401`), revoked-session refresh (`401`).
- `waitForMessage` helper correctly checks already-buffered messages before attaching a new listener — avoids a race where a message arrives between `connectWS` resolving and the listener being attached.

**Quality gaps (Medium):**
- `'消息历史 API'` test (line 288-294) only asserts `res.data.success === true` and `Array.isArray(res.data.data) === true` — it does **not** assert that the messages sent in the WS relay test (`'消息中继 Client → Host'` / `'消息中继 Host → Client'`) actually appear in this history with correct `direction`/`content`. This is a missed opportunity given `manual-message-history.mjs` already has the right pattern (asserting `clientRow.direction === 'client_to_host'`, dedup-on-resend) — that manual script's assertions should be ported into the vitest suite.
- `'安全日志 API'` test (line 296-302) asserts `res.data.data.total >= 1` but the response shape returned by `security-logs.ts` is `{ logs, total, page, pageSize, totalPages }` — the test never checks `logs` array content, eventType values, or that a `BLOCKED_PATH` test produces a corresponding row. Given S3 (audit POST 404s), this test would currently pass trivially (whatever in-relay-generated logs exist from earlier tests) without ever exercising the Host→relay audit path — **the test cannot currently distinguish "audit pipeline works" from "audit pipeline is completely broken (S3)"**, because nothing in this suite ever calls `POST /security-logs` (it doesn't exist) or triggers a `BLOCKED_PATH` event via WS.
- No test directly exercises `/messages/:sessionId` with a **refresh token** or a **revoked session's access token** (S1) — this is the most security-relevant gap in the existing suite, explicitly flagged by Phase 2.
- `sendWS()` helper (line 117-125) generates `id: Math.random().toString(36).slice(2)` — this mirrors the S8 finding (predictable `Math.random()`-based IDs) but in test code it's benign; however, it means the test suite can't detect if dedup-by-`messageId` collisions ever start mattering.

### Manual `.mjs` scripts — high assertion quality, but they are NOT regression-safe

The 5 non-CDP manual scripts (`manual-relay-roundtrip.mjs`, `manual-host-reconnect.mjs`, `manual-file-tunnel.mjs`, `manual-message-history.mjs`, `manual-live-host.mjs`) are **better written than the vitest suite** in terms of covering edge cases:

- `manual-relay-roundtrip.mjs` covers: refresh-token-rejected-at-WS-handshake (4001), routing-field injection (`clientId`/`sessionId` echoed correctly), PONG id echo for RTT, **session revocation propagating live** (`SESSION_REVOKED` + 4003 close code) — this is genuinely good security regression coverage that **does not exist in `e2e.test.ts`**.
- `manual-file-tunnel.mjs` covers: full download (200 + Content-Length), **HTTP Range** (206 + Content-Range + byte-exact slice), preview Content-Type passthrough, and **Host-side read failure → 502 TUNNEL_ERROR**. This is exactly the kind of file-tunnel edge-case coverage that should be in the permanent suite.
- `manual-host-reconnect.mjs` covers HOST_OFFLINE/HOST_ONLINE broadcast and **post-reconnect room-rebuild routing** (the scenario CLAUDE.md calls out as "host-reconnect room rebuild" in ADR-005) — this is core to the single-instance resilience story and is the single most important manual script to port.
- `manual-message-history.mjs` covers bidirectional persistence + `messageId` dedup via `ON CONFLICT DO NOTHING` — directly relevant to S8 (predictable message IDs).

**Severity: High** — these five scripts encode **the majority of the system's actual edge-case/security regression coverage**, but:
1. They are not run in CI (no script wires them into `pnpm test`).
2. They `process.exit(1)` on failure with `console.error`, so failures are not reported as named test cases — a regression shows up as "script exited 1" with a custom-formatted message, not a vitest failure with file:line.
3. They duplicate ~40 lines of boilerplate (host registration, PIN, connect, `openWs`) per script that `e2e.test.ts` already factors into helper functions — divergent boilerplate risks drift (e.g., `e2e.test.ts`'s `sendWS` adds `id`/`timestamp` automatically; the manual scripts hand-roll this every time).

**Test recommendation:** Port the 5 non-CDP manual scripts' *assertions* into `e2e.test.ts` (or sibling `.test.ts` files using the same vitest config + helpers) as proper `describe`/`it` blocks. Concretely:

```ts
// apps/server/test/session-revocation.test.ts — ported from manual-relay-roundtrip.mjs
describe('会话吊销即时生效', () => {
  it('吊销后 Client 收到 SESSION_REVOKED 并被关闭 (4003)', async () => {
    // ... setup host/pin/connect/ws as in e2e.test.ts beforeAll ...
    const revokeEvents = new Promise<void>((resolve, reject) => {
      let gotNotify = false;
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      clientConn.ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        if (m.type === 'SESSION_REVOKED') gotNotify = true;
      });
      clientConn.ws.on('close', (code) => {
        clearTimeout(timer);
        expect(gotNotify).toBe(true);
        expect(code).toBe(4003);
        resolve();
      });
    });
    await request('DELETE', `/auth/revoke/${sessionId}`, undefined, {
      Authorization: `Bearer ${hostToken}`,
    });
    await revokeEvents;
  });

  it('已吊销会话的 access token 无法建立新 WS 连接 (4003)', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}?token=${clientToken}&type=client`);
      const t = setTimeout(() => reject(new Error('not closed')), 5000);
      ws.on('close', (code) => {
        clearTimeout(t);
        expect(code).toBe(4003);
        resolve();
      });
    });
  });
});
```

`manual-trust-revoke.mjs` and `manual-settings-hot-reload.mjs` (CDP-driven) are addressed separately in Section 5.

---

## 3. Test Pyramid — Inverted, and the E2E Layer Has a Hard Infra Dependency

### Severity: High

**Current shape:**
- **Unit tests**: 0 (none of `security.ts`, `path-guard.ts`, `jwt.ts`, `pin.ts`, `token-manager.ts`, relay routing functions, React hooks, Zustand stores have isolated unit tests).
- **Integration tests**: 0 in the formal sense (no test spins up a Fastify instance in-process with an in-memory/temp SQLite DB and hits routes directly via `fastify.inject()`).
- **E2E tests**: 1 vitest suite (`e2e.test.ts`) + 5 manual scripts, **all requiring a live relay server already running on `localhost:3099`**.

This is an inverted pyramid: the *only* automated tests are E2E-shaped, and even those require external process orchestration the test runner doesn't manage.

**Concrete maintainability/CI concerns:**
1. `pnpm --filter @remotebridge/server test` (i.e., `vitest run`) will **fail outright** in a fresh CI checkout — there is no `pretest` hook that starts the relay on port 3099, and `vitest.config.ts` has no `globalSetup`. Anyone running `pnpm test` without first manually starting `$env:RELAY_PORT=3099; pnpm --filter @remotebridge/server dev` in another terminal gets connection-refused errors for every test.
2. The e2e suite is **stateful across the whole file** — `hostToken`, `sessionId`, `pin`, etc. are module-level `let` bindings populated by earlier `it()` blocks and consumed by later ones (e.g., `pin` set in "生成 PIN" is used in "PIN 连接"). This means:
   - Tests cannot run in isolation or in parallel (vitest defaults to running test files in parallel, but within a file, `describe`/`it` ordering must be preserved — `vitest` does preserve declaration order by default, but this is fragile to refactors).
   - A failure in an early test (e.g., "注册 Host") cascades into failures for every subsequent test with confusing secondary error messages (e.g., "PIN 连接" failing with `pin` being `''` rather than a clear "host registration failed" message).
3. Because the relay holds **all room/session state in memory** (per CLAUDE.md, "Stateful rooms live in memory → single instance only"), and the DB is **not reset between test runs** (no `beforeAll` that wipes `RB_DATA_DIR`'s sqlite file), repeated test runs accumulate hosts/sessions/messages/security-logs in the same DB file — this is consistent with why the security-logs test only asserts `total >= 1` rather than an exact count (it can't know how many prior runs have polluted the DB). Over time this could also slow down `COUNT(*)`-based queries (directly feeding into C2).

**Test recommendation:**
1. Add a `globalSetup` in `vitest.config.ts` that:
   - Sets `RB_DATA_DIR` to a fresh temp directory (e.g., `os.tmpdir()/remotebridge-test-<random>`) so each CI run starts with an empty DB.
   - Spawns `tsx src/index.ts` (or the built `dist/index.js`) as a child process with `RELAY_PORT=3099`, waits for `/health` to return 200, and tears it down in `globalTeardown`.

```ts
// apps/server/test/global-setup.ts
import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let proc: ChildProcess;
let dataDir: string;

export async function setup() {
  dataDir = mkdtempSync(join(tmpdir(), 'rb-test-'));
  proc = spawn('npx', ['tsx', 'src/index.ts'], {
    env: { ...process.env, RELAY_PORT: '3099', RB_DATA_DIR: dataDir },
    stdio: 'pipe',
  });
  // poll /health until 200
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://localhost:3099/health');
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('relay did not become healthy in time');
}

export async function teardown() {
  proc.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
```

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 10000,
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
  },
});
```

2. Split the monolithic `e2e.test.ts` into independently-runnable suites per flow (`auth.e2e.test.ts`, `ws-relay.e2e.test.ts`, `session-revocation.e2e.test.ts`, `messages.e2e.test.ts`) each with its own `beforeAll` that does its own host-registration/PIN/connect — slightly more boilerplate, but removes cross-test ordering fragility and lets `vitest -t "pattern"` target a single concern.
3. Add a small number of true **unit/integration tests** that don't need a live server — e.g., import `db/client.ts`'s `initDatabase()` against a temp file and directly exercise `cleanExpiredTokens`-equivalent queries, or call route handlers via `fastify.inject()` with a mocked DB.

---

## 4. Edge Cases

### Covered (across vitest + manual scripts)
- PIN one-time-use, invalid PIN, PIN expiry format (regex)
- Refresh token rejected at WS handshake (4001)
- Refresh token rejected at `/auth/refresh` if given an access token
- Session revocation: immediate WS disconnect (4003) + `SESSION_REVOKED` broadcast + revoked token rejected at handshake
- Host reconnect: `HOST_OFFLINE`/`HOST_ONLINE` broadcast + room/routing-map rebuild without client reconnect
- File tunnel: full download, Range (206/byte-exact), Content-Type passthrough for preview, Host-side read error → 502
- Message persistence: bidirectional, `messageId`-based dedup on resend

### NOT covered — Critical/High gaps

**Severity: Critical**

- **WS reconnect — Client side**: No test exercises a **Client** disconnecting/reconnecting (only Host reconnect is covered by `manual-host-reconnect.mjs`). `apps/web/src/hooks/useWebSocket.ts` presumably has its own reconnect/backoff logic (per CLAUDE.md "reconnect with exponential backoff (1s–30s, unlimited)") — entirely untested, and is in `apps/web` which has zero test infra anyway.
- **File tunnel backpressure**: `manual-file-tunnel.mjs` tests a 700KB file (3 chunks) but never tests the **4MB high-water-mark backpressure** path described in CLAUDE.md ("4MB send buffer high-water mark, polling every 50ms"). No test simulates a slow/blocked relay-side consumer to verify the Host actually pauses sending. This is the core mechanism that bounds memory for large transfers (H1's "not unbounded" claim) — currently unverified.
- **Concurrent file tunnel transfers**: No test verifies multiple simultaneous `CMD_FETCH_FILE` transfers (different `transferId`s) are correctly demultiplexed and don't cross-contaminate `RESP_FILE_CHUNK` streams.
- **Token expiry boundary**: No test for a download/preview token that expires *between* issuance and redemption (30-min TTL) — `validateDownloadToken`'s `TOKEN_EXPIRED` branch (token-manager.ts:62-64) has zero test coverage. Similarly, no test for `TOKEN_USED` (single-use enforcement, `download_count >= 1`) or `CLIENT_MISMATCH` (S10 dead-code check).

**Severity: High**

- **Room rebuild race**: `manual-host-reconnect.mjs` tests reconnect with a ~300ms wait between steps — no test covers the race where a Client sends a `CMD_*` **during** the Host's reconnect window (i.e., Host briefly absent from the room map). CLAUDE.md describes `PEER_OFFLINE` as the error path; is it tested that the Client gets a clean `ERROR`/`PEER_OFFLINE` rather than a silently-dropped message in that window?
- **Concurrent PIN generation / connect**: S2 (unauthenticated, unrate-limited `register-host`) and the per-host PIN rate limit (5/min) have no test verifying the rate limit actually triggers a 429/error after the 6th request within a window.
- **Multiple clients per session/host**: All tests use exactly one Host + one Client. `relayToClient`'s `clientSockets.forEach()` O(n) fallback (M2) and `broadcastToHostClients` (`rooms.ts`) have no test with 2+ concurrent clients verifying correct fan-out and isolation (Client A should never receive Client B's `MSG_TEXT`).
- **`since` timestamp filter** on `GET /messages/:sessionId` (messages.ts:45,83-95) — the `since`-filtered query path is dead-untested; a regression here (e.g., off-by-one on `gt` vs `gte`) would silently break incremental message-history fetch in the web client.

---

## 5. Test Maintainability

### Severity: Medium-High

**Isolation:**
- As noted in Section 3, `e2e.test.ts` has strong intra-file coupling via module-level mutable state. This is a classic flaky-test precursor — if vitest's execution model ever changes (e.g., test-level retries, `--shard`, parallel `it()` execution within a `describe`), this suite breaks silently.
- No DB isolation between runs (no per-run `RB_DATA_DIR`). Re-running the suite against a relay that's accumulated state from prior runs/manual scripts could cause `'PIN 一次性使用'`-style tests to behave unexpectedly if PIN/session IDs ever collide (low probability with nanoid, but the *security-logs* `total >= 1` assertion is explicitly written to tolerate pollution — a sign the author was aware of this).

**Mocks:**
- Zero use of mocks/stubs anywhere in `apps/server/test/`. Every test hits a real (if test-port) relay, real SQLite, real bcrypt (PIN hashing — bcrypt is deliberately slow, which the e2e suite pays for on every PIN-related test). This is defensible for an E2E suite but means there is **no fast feedback loop** — `vitest run` against the live-relay suite takes multiple seconds per test due to bcrypt + real WS round trips + 15s `testTimeout`.

**Flaky-test indicators:**
- Several manual scripts use fixed `await wait(300)` / `await wait(500)` sleeps to "let messages propagate" (`manual-host-reconnect.mjs`, `manual-message-history.mjs`). These are inherently flaky under load (CI runners under contention) — a slow CI box could see `clientEvents` not yet containing `HOST_ONLINE` at the 300ms mark, causing a false failure. `e2e.test.ts`'s `waitForMessage` with a timeout+listener pattern is strictly better and should be the only pattern used.
- `manual-trust-revoke.mjs` polls for a CDP target for up to 15 seconds (`for (let i = 0; i < 15 && !page; i++)`) — acceptable for a manual script but would be a CI timeout risk if ever automated as-is.

**Reliance on CDP-driven manual scripts:**
- `manual-trust-revoke.mjs` and `manual-settings-hot-reload.mjs` are the **only** tests of any kind that exercise the Electron renderer UI (trust/revoke buttons, settings page, theme application). They:
  - Require a human (or script) to launch Electron with `--remote-debugging-port=9222` first.
  - Require an *already-connected web client session* (trust-revoke) and **two separate relay instances on ports 3001/3002** (settings-hot-reload) — these are substantial, undocumented-in-CI environmental preconditions.
  - Use raw CDP `Runtime.evaluate` with string-interpolated JS expressions (e.g., `clickByText('☀️ 亮色')` matching on Chinese button text) — these break on any UI copy change, with no compile-time or type-level connection to the actual component source. A renderer refactor that renames "亮色"/"暗色" buttons silently breaks this test with a generic "NOT_FOUND" failure.
  - `manual-trust-revoke.mjs`'s final assertion (`!stillThere` — the revoked session is gone from `listClients()`) is a reasonable behavioral check, but the test provides no isolation: if step 4's revoke fails, *which* of the two web-client sessions get revoked is non-deterministic (`target = list.find(c => c.online) || list[0]`).

**Test recommendation:**
1. Replace `await wait(N)` sleeps in manual scripts (and any ported vitest versions) with the `waitForMessage`-style listener+timeout pattern already established in `e2e.test.ts`.
2. For the CDP-driven scripts, at minimum extract the button-matching strings into named constants colocated with (or generated from) the actual renderer component source, so a grep/refactor-rename catches the test. Longer-term, consider Playwright (which can drive Electron directly via `_electron` API) instead of raw CDP — gets selector-based queries, auto-waiting, and trace/screenshot-on-failure for free.
3. Document the CDP scripts' preconditions (ports 3001+3002, `--remote-debugging-port=9222`, pre-existing web session) in a `apps/server/test/README.md` or at the top of each script in a structured `// PRECONDITIONS:` block — currently this is prose-only at the top of each file.

---

## 6. Security Test Gaps (S1–S15 from 02a-security.md)

| ID | Title | Tested today? | Testable today? | Notes |
|----|-------|---------------|------------------|-------|
| **S1** | `messages.ts` uses `verifyToken` not `verifyAccessToken`; never checks `revokedAt` | **No** | **Yes** | Confirmed still live in current code (`apps/server/src/routes/messages.ts:6,32,135` both import/call `verifyToken`; no `session[0].revokedAt` check anywhere in the file). This is the single highest-priority missing test — see test code below. |
| S2 | `register-host` unauthenticated + no rate limit | No | Yes | No test sends >N `register-host` requests from one IP and asserts a 429/throttle. |
| S3 | `POST /security-logs` doesn't exist; audit POSTs 404 | No (untestable until route exists) | No — route absent | Confirmed: `security-logs.ts` registers only `GET /security-logs`, `GET /security-logs/events`, `GET /access-logs` — no `POST`. Once added, needs: (a) a test that POSTing a `BLOCKED_PATH` event from a Host token populates `/access-logs`; (b) a test verifying `eventType` values are constrained (relates to S9). |
| **S4** | Desktop `path-guard.ts` doesn't call `getWindowsBlockedDirs()` | **No** | **Yes** | Confirmed: `apps/desktop/src/main/security/path-guard.ts:27` reads `SYSTEM_BLOCKED_DIRS[platform]` directly — the `win32` array never gets `%APPDATA%`/`%LOCALAPPDATA%` appended (that only happens inside `getWindowsBlockedDirs()` in `packages/shared/src/security.ts`, which `path-guard.ts` never calls). Zero test coverage, as predicted by Phase 2. Test code in Section 1 above. |
| S5 | No CSP; PDF iframe XSS via content-type mismatch | No | Partially | Would need an `apps/web` integration test (e.g., Playwright) serving a `.pdf`-named file with HTML content through the preview pipeline and asserting it does NOT execute script in the dashboard origin — requires `apps/web` test infra (currently absent) plus a fix to add CSP. |
| S6 | `JWT_SECRET` hardcoded fallback; `JWT_REFRESH_SECRET` derived from it | **No** | **Yes (once `reqSecret()` guard added)** | Confirmed: `apps/server/src/utils/jwt.ts:6,8` — `JWT_SECRET` falls back to `'remotebridge-dev-secret-change-in-production'`, `JWT_REFRESH_SECRET` falls back to `` `${JWT_SECRET}-refresh` ``. No startup check anywhere (`index.ts` has no secret validation before `app.listen`). See test code below. |
| S7 | Electron hardening gaps (no `setWindowOpenHandler`, no CSP via `onHeadersReceived`, no sandbox) | No | Partially | Could be unit-tested by asserting `apps/desktop/src/main/window.ts`'s `BrowserWindow` constructor options include `sandbox: true` / a `webContents.setWindowOpenHandler` call is registered — a "config assertion" test, not a behavioral one, but better than nothing. |
| S8 | `Math.random()`-based `generateId()` (3 places) | No | Yes | A property-based/statistical test could assert `generateId()` output has sufficient entropy/uniqueness over N calls, but the more valuable fix-then-test is switching to `nanoid`/`crypto.randomUUID` and asserting format (e.g., `/^[A-Za-z0-9_-]{21}$/` for nanoid). |
| S9 | `eventType`/`action` unions incomplete; no DB CHECK constraint | No | Yes | A test inserting a `securityLogs` row with an out-of-union `eventType` and asserting it's rejected (once a CHECK constraint or app-level validation is added) — currently would silently succeed. |
| S10 | Download token `CLIENT_MISMATCH` check is dead code | No | **Yes — already testable today** | `validateDownloadToken(token, clientId)` (token-manager.ts:44-86) already implements the `CLIENT_MISMATCH` branch (line 70-72) — it's just never *called* with a `clientId` argument from the WS tunnel handler. A unit test of `validateDownloadToken` itself (passing a mismatched `clientId`) would pass today; the gap is an **integration** test verifying the tunnel handler actually passes `clientId` through — that would currently fail/not-apply. |
| S11 | Tokens in `localStorage` | No | Partially | `apps/web` has zero test infra; an XSS-exposure test isn't meaningful without S5's CSP fix anyway. |
| S12 | `getWindowsBlockedDirs()` mutates shared exported array via `.push()` | No | **Yes — already testable today** | A unit test calling `getWindowsBlockedDirs()` twice and asserting `SYSTEM_BLOCKED_DIRS.win32.length` doesn't grow (or that the returned array is a fresh copy) would catch this today — see test code below. |
| S13 | Host JWT 365-day lifetime, no rotation | No | Yes | A test asserting `signHostToken`'s decoded `exp - iat` equals `365d` in seconds — trivial but currently absent (would also serve as a "did someone silently shorten/lengthen this" regression guard). |
| S14 | `String(err)` leaks paths/error codes to clients | No | Yes | A test sending `CMD_LIST_DIR` for a non-existent path and asserting the `RESP_DIR_ERROR.message` does NOT contain the literal requested path or Node error codes (`ENOENT`, etc.) — requires `apps/desktop` test infra for `dir-handlers.ts`, or an E2E test via `manual-live-host.mjs`'s pattern. |
| S15 | CORS policy / TLS | Partially | Yes | `utils/cors.ts`'s `CORS_OPTIONS` could have a unit test asserting it rejects an origin not in `ALLOWED_ORIGINS` and the proxy's `corsHeadersFor()` produces matching headers — currently untested, low-cost to add. |

### Test code for S1 (Critical — highest priority)

```ts
// apps/server/test/messages-auth.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import WebSocket from 'ws';

const API_BASE = process.env.API_BASE || 'http://localhost:3099/api/v1';

describe('GET/POST /messages/:sessionId — auth boundary (S1)', () => {
  let hostToken: string, accessToken: string, refreshToken: string, sessionId: string, hostId: string;

  beforeAll(async () => {
    // ... register host, generate PIN, connect — reuse e2e.test.ts helpers ...
  });

  it('rejects a refresh token used as a messages-API credential', async () => {
    const res = await request('GET', `/messages/${sessionId}`, undefined, {
      Authorization: `Bearer ${refreshToken}`,
    });
    // Today this likely returns 200 (verifyToken accepts it) — should be 401
    expect(res.status).toBe(401);
    expect(res.data.error?.code).toBe('INVALID_TOKEN');
  });

  it('rejects a revoked session\'s access token', async () => {
    await request('DELETE', `/auth/revoke/${sessionId}`, undefined, {
      Authorization: `Bearer ${hostToken}`,
    });
    const res = await request('GET', `/messages/${sessionId}`, undefined, {
      Authorization: `Bearer ${accessToken}`,
    });
    // Today this likely returns 200 (no revokedAt check) — should be 403
    expect(res.status).toBe(403);
    expect(res.data.error?.code).toBe('SESSION_REVOKED');
  });

  it('POST /messages/:sessionId also rejects a refresh token', async () => {
    const res = await request('POST', `/messages/${sessionId}`, { content: 'hi' }, {
      Authorization: `Bearer ${refreshToken}`,
    });
    expect(res.status).toBe(401);
  });
});
```

### Test code for S6 (startup secret guard, once added)

```ts
// apps/server/test/startup-secrets.test.ts
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';

describe('relay startup — JWT secret validation (S6)', () => {
  it('refuses to start with the default/dev JWT_SECRET', async () => {
    const proc = spawn('npx', ['tsx', 'src/index.ts'], {
      env: { ...process.env, JWT_SECRET: 'remotebridge-dev-secret-change-in-production', RELAY_PORT: '3098' },
    });
    const exitCode = await new Promise<number>((resolve) => proc.on('exit', (code) => resolve(code ?? -1)));
    expect(exitCode).not.toBe(0);
  });

  it('refuses to start when JWT_REFRESH_SECRET is derived from JWT_SECRET', async () => {
    const proc = spawn('npx', ['tsx', 'src/index.ts'], {
      env: {
        ...process.env,
        JWT_SECRET: 'a-sufficiently-long-random-secret-1234567890',
        JWT_REFRESH_SECRET: 'a-sufficiently-long-random-secret-1234567890-refresh',
        RELAY_PORT: '3097',
      },
    });
    const exitCode = await new Promise<number>((resolve) => proc.on('exit', (code) => resolve(code ?? -1)));
    expect(exitCode).not.toBe(0);
  });

  it('starts successfully with two independent, sufficiently-long secrets', async () => {
    const proc = spawn('npx', ['tsx', 'src/index.ts'], {
      env: {
        ...process.env,
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
        RELAY_PORT: '3096',
      },
    });
    // wait for /health or timeout
    let healthy = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch('http://localhost:3096/health');
        if (res.ok) { healthy = true; break; }
      } catch { /* not up */ }
      await new Promise(r => setTimeout(r, 200));
    }
    expect(healthy).toBe(true);
    proc.kill();
  });
});
```

### Test code for S12 (already testable today)

```ts
// packages/shared/test/security-blacklist-mutation.test.ts
import { describe, it, expect } from 'vitest';
import { SYSTEM_BLOCKED_DIRS, validateDirectoryRequest } from '../src/security';

describe('getWindowsBlockedDirs mutation side-effect (S12)', () => {
  it('does not grow SYSTEM_BLOCKED_DIRS.win32 across repeated calls', () => {
    const before = SYSTEM_BLOCKED_DIRS.win32.length;
    process.env.APPDATA = 'C:\\Users\\a\\AppData\\Roaming';
    process.env.LOCALAPPDATA = 'C:\\Users\\a\\AppData\\Local';

    validateDirectoryRequest('C:\\anything', [{ path: 'C:\\anything', is_active: true }]);
    validateDirectoryRequest('C:\\anything', [{ path: 'C:\\anything', is_active: true }]);
    validateDirectoryRequest('C:\\anything', [{ path: 'C:\\anything', is_active: true }]);

    // Today this FAILS: each call .push()'es APPDATA+LOCALAPPDATA again
    expect(SYSTEM_BLOCKED_DIRS.win32.length).toBe(before);
  });
});
```

---

## 7. Performance Test Gaps (C1/C2/H1/H2/H3 from 02b-performance.md)

| ID | Title | Tested today? | Testable today? | Notes |
|----|-------|---------------|------------------|-------|
| **C1** | `cleanExpiredTokens()` dead code — `download_tokens` grows unbounded | No | **Yes — function itself is testable today; wiring needs the fix first** | `apps/desktop/src/main/file-server/token-manager.ts:94-97` exports a working `cleanExpiredTokens()`. A unit test against the desktop SQLite (`db/client.ts`) can insert an expired token row and assert `cleanExpiredTokens()` removes it — testable *now*. The *interval wiring* (C1's actual fix) needs a separate test once `setInterval` is added to `main/index.ts` (e.g., inject a fake clock / call the interval callback directly). |
| **C2** | No indexes on `security_logs`/`messages`; no retention job | No | Partially | Index *existence* can be tested today via `PRAGMA index_list('security_logs')` against the initialized DB — currently would show no relevant index (confirmed: `apps/server/src/db/client.ts` `CREATE TABLE` statements for `messages`/`security_logs` have no accompanying `CREATE INDEX`). Retention-job test needs the job to exist first. |
| H1 | Base64 chunking allocation overhead in file tunnel | No | Yes (benchmark, not correctness) | Could add a `bench` (vitest `bench` API) measuring base64 encode/decode cost per 256KB chunk — informational, not a pass/fail gate. Lower priority than correctness tests. |
| **H2** | `usePreview.ts` stale-error-overwrite (no `currentRequestIdRef` guard on `RESP_PREVIEW_ERROR`) | No | **No (apps/web has zero test infra)** | Confirmed bug still present: `usePreview.ts` lines 130-139 — the `RESP_PREVIEW_ERROR` branch calls `setPreviewState` unconditionally, unlike the `RESP_PREVIEW_READY`/`applyReady` path (line 92) which checks `currentRequestIdRef.current !== requestId` before applying. A rapid double-preview-click where request A's error arrives after request B has started will overwrite B's loading/preview state with A's stale error. See test code below — requires adding `vitest` + `@testing-library/react` to `apps/web`. |
| H3 | Unbounded `Promise.all` over `fs.stat` in `CMD_LIST_DIR` | No | **Yes — apps/desktop test infra needed** | Confirmed: `apps/desktop/src/main/ws-client/dir-handlers.ts` lines 39 and 153 both do `await Promise.all(entries.map(async (entry) => { const stat = await fs.stat(...) ... }))` with no concurrency limit. A test with a mocked `fs.stat` (artificial delay) and 5000 synthetic entries could assert (a) correctness (all entries return) and, post-fix, (b) that concurrency is capped (e.g., via a counter of in-flight `fs.stat` calls never exceeding ~32). |

### Test code for C1 (testable today against desktop SQLite)

```ts
// apps/desktop/test/token-manager.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, db } from '../src/main/db/client'; // adjust to actual export shape
import { createDownloadToken, validateDownloadToken, cleanExpiredTokens } from '../src/main/file-server/token-manager';

describe('cleanExpiredTokens (C1)', () => {
  beforeAll(() => initDatabase(/* temp dir */));

  it('removes expired tokens but leaves valid ones', () => {
    const expired = createDownloadToken('/some/path', 'client-1', -1000); // already expired
    const valid = createDownloadToken('/other/path', 'client-1', 60_000);

    const removed = cleanExpiredTokens();
    expect(removed).toBeGreaterThanOrEqual(1);

    expect(validateDownloadToken(expired.token).reason).toBe('TOKEN_NOT_FOUND');
    expect(validateDownloadToken(valid.token).valid).toBe(true);
  });
});
```

### Test code for H2 (once apps/web gets test infra)

```ts
// apps/web/test/usePreview.test.ts
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { usePreview } from '@/hooks/usePreview';
import { WSMessageType } from '@remotebridge/shared';

describe('usePreview — stale error does not overwrite newer request (H2)', () => {
  it('ignores RESP_PREVIEW_ERROR from a superseded request', () => {
    const listeners: Array<(e: MessageEvent) => void> = [];
    const wsInstance = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      addEventListener: (_: string, cb: any) => listeners.push(cb),
      removeEventListener: vi.fn(),
    };
    // mock useAppStore to return wsInstance, sessionId, accessToken
    // ... vi.mock('@/store/app-store') ...

    const { result } = renderHook(() => usePreview());

    act(() => result.current.requestPreview('/a.txt')); // request A
    act(() => result.current.requestPreview('/b.txt')); // request B supersedes A

    // Simulate A's late error arriving after B started
    const aRequestId = /* capture from first send() call payload.requestId */ '';
    act(() => {
      listeners.forEach(cb => cb({
        data: JSON.stringify({
          type: WSMessageType.RESP_PREVIEW_ERROR,
          payload: { requestId: aRequestId, message: 'stale error from A' },
        }),
      } as MessageEvent));
    });

    // B's loading/preview state must NOT be overwritten by A's error
    expect(result.current.error).not.toBe('stale error from A');
  });
});
```

---

## Summary Table

| # | Finding | Severity | File(s) |
|---|---------|----------|---------|
| 1 | `apps/web`, `apps/desktop`, `packages/shared` have zero automated tests | Critical | (entire packages) |
| 2 | `e2e.test.ts` message-history and security-logs assertions are too shallow to detect S1/S3 regressions | Medium | `apps/server/test/e2e.test.ts:288-302` |
| 3 | Manual `.mjs` scripts hold most edge-case coverage but aren't in CI / not vitest-shaped | High | `apps/server/test/manual-*.mjs` |
| 4 | E2E suite requires externally-managed live relay on :3099, no `globalSetup` | High | `apps/server/vitest.config.ts`, `apps/server/test/e2e.test.ts` |
| 5 | Intra-file test-order coupling via module-level mutable state | Medium | `apps/server/test/e2e.test.ts` |
| 6 | No test for client-side WS reconnect/backoff | Critical | `apps/web/src/hooks/useWebSocket.ts` (no test infra) |
| 7 | No test for file-tunnel 4MB backpressure / concurrent transfers | Critical | `apps/desktop/.../file-tunnel.ts`, `apps/server/src/ws/file-tunnel.ts` |
| 8 | No test for download-token expiry/used/mismatch branches | Critical | `apps/desktop/src/main/file-server/token-manager.ts:62-72` |
| 9 | S1 (messages.ts auth bypass) — confirmed live, zero test | Critical | `apps/server/src/routes/messages.ts:6,32,135` |
| 10 | S4 (path-guard Windows blacklist gap) — confirmed live, zero test | Critical | `apps/desktop/src/main/security/path-guard.ts:27` |
| 11 | S6 (JWT secret fallback, no startup guard) — confirmed live, zero test | Critical | `apps/server/src/utils/jwt.ts:6,8`, `apps/server/src/index.ts` |
| 12 | S12 (`getWindowsBlockedDirs` array-mutation) — testable today, zero test | Low | `packages/shared/src/security.ts:46-55` |
| 13 | C1 (`cleanExpiredTokens` dead code) — function testable today, wiring untested | High | `apps/desktop/src/main/file-server/token-manager.ts:94-97` |
| 14 | C2 (no DB indexes/retention) — index existence testable today | High | `apps/server/src/db/client.ts` |
| 15 | H2 (`usePreview` stale-error overwrite) — confirmed live, zero test infra to test it | High | `apps/web/src/hooks/usePreview.ts:130-139` |
| 16 | H3 (unbounded `Promise.all` over `fs.stat`) — confirmed live, zero test | Medium | `apps/desktop/src/main/ws-client/dir-handlers.ts:39,153` |
| 17 | CDP-driven manual scripts (`manual-trust-revoke.mjs`, `manual-settings-hot-reload.mjs`) are brittle, text-matching, environment-heavy | Medium | `apps/server/test/manual-trust-revoke.mjs`, `apps/server/test/manual-settings-hot-reload.mjs` |

---

## Top 5 Recommendations (Priority Order)

1. **Add the S1 regression test** (`messages-auth.test.ts` above) — it's a one-file, ~30-line addition to the existing suite and directly verifies the highest-CVSS finding from Phase 2. Do this regardless of whether the fix lands first (test should currently FAIL, documenting the bug, then PASS after the `verifyAccessToken`+`revokedAt` fix).
2. **Add a `globalSetup`/`globalTeardown` to `apps/server/vitest.config.ts`** that spawns the relay against a temp `RB_DATA_DIR` — removes the "must have a relay running on :3099" tribal-knowledge requirement and makes `pnpm test` work in a clean CI checkout.
3. **Stand up minimal vitest infra in `packages/shared`** and write the `security.ts` unit tests (S4/S12 test code above) — these are pure functions, fast, and directly cover the two Phase-2 findings most amenable to unit testing today.
4. **Port the 5 non-CDP manual scripts' assertions into the vitest suite** (host-reconnect room rebuild, file-tunnel Range/error/backpressure, message dedup, revocation-propagation) — this is the highest-leverage "convert existing knowledge into CI-enforced regression tests" action, since the test logic already exists and is high quality.
5. **Stand up minimal test infra in `apps/desktop`** (vitest against plain TS modules, no Electron runtime needed for `path-guard.ts`/`token-manager.ts`) and add the S4 + C1 tests — this directly covers "the highest-value asset" (per CLAUDE.md's threat model) which currently has the least test coverage of any module in the system.
