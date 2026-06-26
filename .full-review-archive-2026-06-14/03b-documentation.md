# Phase 3B: Documentation Review

**Scope**: CLAUDE.md, 使用说明书.md, docs/code-review-report.md, .env.example, scripts/*.sh, inline comments on complex logic (RelayRoutingFields/withRouting, file-tunnel backpressure, path-guard recursive-permission), ADR references (ADR-004/ADR-005), README completeness, and accuracy of documentation claims against actual implementation.

**Method**: Read all named docs in full; cross-checked specific claims against source (`apps/server/src/routes/security-logs.ts`, `apps/desktop/src/main/security/audit-logger.ts`, `apps/server/src/utils/jwt.ts`, `apps/server/src/routes/messages.ts`, `apps/web/next.config.mjs`, `apps/desktop/src/main/window.ts`, `packages/shared/src/ws-types.ts`, `packages/shared/src/api-types.ts`); searched repo root and subdirectories for README/ADR/CHANGELOG files (none found beyond CLAUDE.md, 使用说明书.md, docs/code-review-report.md).

---

## Critical

### D1 — CLAUDE.md's "load-bearing" audit-pipeline claim is factually false for all Host-originated events (verifies 01b-C1 / S3)

**Location**: `CLAUDE.md:113` (Security model section)

**Claim as written**:
> "All access attempts (allowed and blocked) go through `audit-logger.ts` (writes to both local DB and relay security-logs endpoint — HTTP POST, fire-and-forget)."

**Reality**:
- `apps/desktop/src/main/security/audit-logger.ts:32` and `:59` both `axios.post(`${getRelayApi()}/security-logs`, ...)`.
- `apps/server/src/routes/security-logs.ts` registers only `GET /security-logs`, `GET /security-logs/events`, and `GET /access-logs` (lines 49, 160, 210-212). **There is no `POST /security-logs` handler anywhere in the server.**
- Every Host-originated `logAccess()`/`logSecurity()` call therefore receives a 404, which is swallowed by the `catch` block (`audit-logger.ts:43-46` and `:69-71`, "静默失败 — 不影响主流程" / "silent failure — does not affect main flow").
- Net effect: the *local* half of the claim is true (`db.insertAccessLog(event)` at `audit-logger.ts:23` does write to the desktop's local SQLite `access_logs` table), but the *relay* half is false. `GET /security-logs` and `GET /access-logs` on the relay will return `total: 0` / `[]` forever for any Host-originated `ACCESS`, `BLOCKED_PATH`, or other security events — the relay-side security dashboard (web `/dashboard/security`) is non-functional for these event types.
- This is the exact same finding as Phase 1's 01b-C1 and Phase 2's S3, now confirmed from the documentation-accuracy angle: the doc doesn't just describe a bug, it actively asserts the *opposite* of what the code does, under a section explicitly marked "load-bearing — don't weaken." A reader trusting this line would believe the relay-side audit trail is operational and might build features (or incident response runbooks) on that false assumption.

**Also check**: 使用说明书.md does **not** repeat this specific "writes to both local DB and relay" framing verbatim, but it has two adjacent claims that are misleading in the same direction:
- Line 21: "桌面端(Host)... 管理共享目录、生成连接码、**审计访问**" ("audits access") — true only locally.
- Line 182: "安全审计：查看全部安全事件（连接、吊销、路径拦截等）" ("Security Audit: view all security events including connection/revocation/path interception") — this is the *Host-side desktop UI* description (`SecurityLogs.tsx` reads local DB, so this part is likely accurate for the desktop's own view).
- Line 210: "被拒绝的访问（目录不在白名单、路径穿越等）会明确报错，**并记入主机端安全日志**" ("...and is recorded in the Host-side security log") — this is scoped to "主机端" (Host-side), so it is *not* directly contradicted by C1/S3 (it doesn't claim relay-side recording). This line is technically accurate as written.
- Line 215: "安全审计：查看本会话相关的安全事件" (Web dashboard "Security Audit: view security events related to this session") — this **is** the relay-side `/dashboard/security` page, which calls `GET /security-logs`/`GET /access-logs`. Per C1/S3, for Host-originated `BLOCKED_PATH`/`ACCESS` events, this view will be **permanently empty**, contradicting the implication that "本会话相关的安全事件" (security events related to this session) will actually be visible there. This is a secondary, softer instance of the same inaccuracy.

**Severity**: Critical (documentation actively misrepresents a security-relevant subsystem as functional when it silently 404s; "load-bearing — don't weaken" framing increases the risk that a future maintainer trusts the audit trail for compliance/incident-response purposes).

**Recommendation**: Until S3/01b-C1 is fixed in code, rewrite `CLAUDE.md:113`'s audit sentence to state the actual behavior, e.g.:

> "All access attempts (allowed and blocked) are written to the Host's **local** SQLite `access_logs`/`security_logs` tables via `audit-logger.ts`. The same module also attempts to POST each event to `${relayApi}/security-logs` for relay-side aggregation, but **this endpoint does not currently exist on the relay** (`routes/security-logs.ts` is GET-only) — every such POST 404s and is silently dropped (see `audit-logger.ts`'s fire-and-forget `catch`). As a result, `GET /access-logs` and the web dashboard's Security tab are currently always empty for Host-originated events. KNOWN GAP — tracked as [issue/finding S3 / 01b-C1]; do not rely on the relay-side security log until a `POST /security-logs` route is added."

Once S3/01b-C1 is fixed (a `POST /security-logs` route is added on the relay, with appropriate auth/eventType validation per S9), restore the original "writes to both local DB and relay security-logs endpoint" wording — but at that point also resolve the `AccessLog.action`/`SecurityLog.eventType` enum drift (01b-H3/S9) so the new endpoint's accepted values are documented consistently with `packages/shared/src/api-types.ts`.

Additionally, soften 使用说明书.md line 215 ("安全审计：查看本会话相关的安全事件") with a footnote or remove it until the relay-side pipeline works, since it currently sets an expectation the Web dashboard cannot meet for `BLOCKED_PATH`/`ACCESS` events.

---

### D2 — `.env.example` provides no guidance on JWT secret strength/independence; defaults are insecure and undocumented as such (verifies S6)

**Location**: `.env.example:6-7`, cf. `apps/server/src/utils/jwt.ts:6-8`

**Current `.env.example`**:
```
JWT_SECRET=change-me-to-a-random-string
JWT_REFRESH_SECRET=change-me-to-another-random-string
```

**Reality** (`apps/server/src/utils/jwt.ts:6-8`):
```ts
const JWT_SECRET = process.env.JWT_SECRET || 'remotebridge-dev-secret-change-in-production';
// refresh token 使用独立密钥：即使 access 密钥泄露，30 天长效凭证也不受影响（反之亦然）
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || `${JWT_SECRET}-refresh`;
```

Two distinct documentation gaps:

1. **No strength/format requirements stated anywhere.** `.env.example`'s placeholder values (`change-me-to-a-random-string`, `change-me-to-another-random-string`) look like instructions to the reader, but nothing tells the operator *how* to generate a suitable value (length, entropy source, e.g. `openssl rand -base64 48`), and there is no startup validation (no `reqSecret()`-style guard) rejecting the hardcoded fallback or other weak patterns. A deployer who copies `.env.example` to `.env` without editing it gets `'remotebridge-dev-secret-change-in-production'` — a string baked into the public source tree — as their production signing key. CLAUDE.md's `## Environment` section (lines 119-132) lists `JWT_SECRET`/`JWT_REFRESH_SECRET` as env vars the server reads, but gives no security guidance either.

2. **The "independent secrets" comment exists in code but not in any doc.** The `jwt.ts:8` comment explains *why* refresh and access secrets should be independent (blast-radius isolation), but if `JWT_REFRESH_SECRET` is left unset, the fallback `${JWT_SECRET}-refresh` is *trivially derivable* from `JWT_SECRET` — defeating the independence guarantee the code comment claims to provide. Neither `.env.example` nor CLAUDE.md tells the operator that **both** vars must be set independently for the security property described in the code comment to actually hold; a reader could set `JWT_SECRET` only (satisfying "the server starts") and unknowingly run with a derived, non-independent refresh secret.

**Severity**: Critical (directly enables S6 — "booting with `.env.example` defaults gives a publicly-known signing key, total auth-forgery" — and the documentation provides no signal to prevent this footgun).

**Recommendation**: Update `.env.example` to:

```sh
# Relay Server
RELAY_PORT=3001
RELAY_HOST=0.0.0.0

# REQUIRED in production. Generate independently, e.g.:
#   openssl rand -base64 48
# Must be >= 32 chars, high-entropy, and DIFFERENT for each variable below.
# If unset, the server falls back to a hardcoded dev secret that is
# PUBLICLY KNOWN (present in source) — do not deploy with this unset.
JWT_SECRET=
# Must be independently generated from JWT_SECRET (NOT derived from it).
# If unset, the server derives this as "${JWT_SECRET}-refresh", which is
# trivially guessable from JWT_SECRET and defeats the access/refresh
# secret-separation security property documented in apps/server/src/utils/jwt.ts.
JWT_REFRESH_SECRET=
```

And add a corresponding note to CLAUDE.md's `## Environment` section, e.g. immediately after the env var list:

> **Security note**: `JWT_SECRET` and `JWT_REFRESH_SECRET` MUST both be set to independently-generated, high-entropy values (≥32 chars, e.g. `openssl rand -base64 48`) in any non-local deployment. If `JWT_SECRET` is unset the server falls back to a hardcoded dev secret present in source (`apps/server/src/utils/jwt.ts:6`); if `JWT_REFRESH_SECRET` is unset it's derived from `JWT_SECRET` (`${JWT_SECRET}-refresh`), which is guessable and defeats the access/refresh isolation the codebase relies on (see S6 in the security review).

Longer-term (code fix, flagged here for documentation linkage once implemented): add a `reqSecret()` startup guard that refuses to boot if either secret is empty, equals the hardcoded fallback, or matches common placeholder patterns (`change-me`, `dev-secret`, etc.) — and document that guard's error message here so operators know what to fix.

---

## High

### D3 — No CSP documentation for `apps/web` (verifies S5) or the Electron renderer in `apps/desktop` (verifies S7)

**Location**: no occurrences anywhere in CLAUDE.md, 使用说明书.md, `apps/web/next.config.mjs`, or `apps/desktop/src/main/window.ts`.

**Findings**:
- `apps/web/next.config.mjs` (9 lines total) sets `reactStrictMode`, `transpilePackages`, and `output: 'standalone'` — **no `headers()` function, no CSP, no security headers of any kind**. CLAUDE.md's `apps/web` description (line 86) covers download/preview architecture in detail but says nothing about response headers or CSP, and there is no "Security configuration" section anywhere that a deployer would consult before going to production.
- `apps/desktop/src/main/window.ts` creates the `BrowserWindow` with `contextIsolation: true, nodeIntegration: false` (good baseline) but has **no `onHeadersReceived` CSP injection, no `setWindowOpenHandler`, no `will-navigate`/`will-redirect` guards, and no `sandbox: true`**. CLAUDE.md's `apps/desktop` description (line 85) documents the IPC/preload boundary but not the renderer's navigation/CSP posture.
- This matters because S5 (no CSP in `apps/web`, PDF preview via unsandboxed blob `<iframe>`) and S7 (Electron 28 EOL, no navigation guards, preload bridge inheritable by a compromised renderer) are both concrete, currently-exploitable gaps with **zero corresponding documentation** — not even a "known limitation" note that would let an operator decide to add a reverse-proxy CSP header as a stopgap.

**Severity**: High (both S5 and S7 are rated 7.0+ CVSS in Phase 2; the complete absence of any written security-configuration guidance means even a security-conscious deployer has no starting point, and a future contributor adding new preview types or `<iframe>`/`<img src>` usage has no documented constraint to check against).

**Recommendation**: Add a new `### Security configuration (deployment-time hardening)` subsection to CLAUDE.md, after the existing "Security model" section, covering:

1. **Web (`apps/web`)**: note the current absence of CSP/security headers in `next.config.mjs`, and document the minimum recommended `headers()` config once added (e.g. `Content-Security-Policy: default-src 'self'; frame-src 'self' blob:; img-src 'self' blob: data:; ...`, `X-Frame-Options`, `X-Content-Type-Options: nosniff`). Cross-reference S5's PDF-preview `<iframe>` + extension-trust issue (`PdfViewer.tsx` + desktop `dir-handlers.ts` previewable-type categorization) as the specific risk a CSP `frame-src`/`sandbox` policy needs to cover.
2. **Desktop (`apps/desktop`)**: document that `window.ts` currently has `contextIsolation: true, nodeIntegration: false` but lacks `sandbox: true`, `setWindowOpenHandler`, navigation guards, and a renderer CSP via `onHeadersReceived`. Note the Electron 28 EOL status (S7) and that a renderer compromise can currently inherit the `electronAPI` preload bridge via uncontrolled navigation.
3. Mark both as **known gaps** pending fixes, so the absence is at least a documented, intentional-until-fixed state rather than an undocumented blind spot.

---

### D4 — `.env.example` and CLAUDE.md don't document breaking-change/migration history (refresh-secret separation, persistent clientId, `use:'refresh'` claim)

**Location**: no CHANGELOG file exists anywhere in the repo (verified via repo-wide search); `package.json` files for all 4 packages are pinned at `"version": "1.0.0"` with no history.

**Findings**:
- `docs/code-review-report.md` (§2.1, §五"结构性风险（遗留）" items 3 and 5) documents that the following were **fixed after the June 2026 review was written** (per CLAUDE.md's own caveat at line 7): separate JWT refresh secret + `use:'refresh'` claim, persistent `clientId` (web localStorage UUID), revoked-session WS check, and the `pending-requests.ts` registry.
- None of these fixes are documented as **migration-relevant** for an existing deployment. Specifically:
  - If an operator previously deployed a version where `JWT_REFRESH_SECRET` was unused (per `docs/code-review-report.md` §五 item 6: "`JWT_REFRESH_SECRET` 环境变量已定义但未使用"), and upgrades to the current code, all previously-issued refresh tokens were signed with `JWT_SECRET` and now fail verification against `JWT_REFRESH_SECRET` (or its derived fallback) — existing Web client sessions would silently lose the ability to refresh and need to re-PIN. This is a real upgrade-time UX break with no documentation telling the operator (or end users) to expect it.
  - The persistent `clientId` change (localStorage UUID, replacing per-connection `crypto.randomUUID()`) means **pre-upgrade "trusted device" records** (`connected_clients.is_trusted`, keyed by the old ephemeral `clientId`) become orphaned/unreachable after upgrade — a user who had marked a device "trusted" pre-upgrade will need to re-trust it post-upgrade, but nothing documents this.
- Since all packages are at `1.0.0` with no CHANGELOG, there's no mechanism today to communicate any of this to someone upgrading from an earlier checkout of the same `1.0.0` branch (a realistic scenario given how fast this codebase is evolving per the review history).

**Severity**: High (these are real behavioral discontinuities for anyone who ran an older build and is upgrading in place — sessions silently breaking and trust records silently orphaning are exactly the kind of thing that generates confused bug reports without a migration note).

**Recommendation**: 
1. Add a minimal `CHANGELOG.md` at the repo root (or a `## Migration notes` section in CLAUDE.md) documenting at least:
   - "If upgrading from a build predating the JWT refresh-secret separation: all existing refresh tokens become invalid; users must reconnect via a new PIN. No data loss, but active sessions will need to re-authenticate within ≤2h (access token lifetime) of the upgrade."
   - "If upgrading from a build predating persistent `clientId`: previously-trusted devices (`connected_clients.is_trusted`) will appear as new/untrusted devices after the Web client adopts its new persistent `clientId`; users should re-mark trust."
2. Bump at least `apps/server` and `apps/web` package versions (or add a `CHANGES` field) so "1.0.0" stops being a single undifferentiated bucket for all historical states — even a coarse `1.0.0` → `1.0.1` bump tied to a changelog entry would help.

---

## Medium

### D5 — CLAUDE.md's ADR-004/ADR-005 references point to inline-only descriptions; no actual ADR documents exist

**Location**: `CLAUDE.md:72` (ADR-005), `CLAUDE.md:91` (ADR-004)

**Findings**:
- `CLAUDE.md:72`: "Stateful rooms live in memory → single instance only (accepted trade-off, see ADR-005: restart self-heals via both ends' unlimited reconnect + host-reconnect room rebuild)."
- `CLAUDE.md:91`: "...over a **WS file tunnel** (`CMD_FETCH_FILE` → base64 `RESP_FILE_CHUNK` frames, see ADR-004): proxy obtains a single-use token..."
- A repo-wide search for `adr`/`ADR` (case-insensitive, excluding `node_modules`) finds **zero files** named or containing a dedicated ADR document. "ADR-004" and "ADR-005" exist *only* as these two inline cross-references in CLAUDE.md — there is no `docs/adr/004-file-tunnel.md`, `docs/adr/005-single-instance-rooms.md`, or equivalent.
- `00-scope.md` (the Phase-0 scope doc for this review) lists "`prd.md`, `RemoteBridge-ARCHITECTURE.md` (Chinese design docs, ADRs)" as "Reference docs available to agents" — but **neither file exists** in the repo (verified via repo-wide glob/find). This scope-doc claim is itself stale/inaccurate relative to the actual repo contents at review time.
- This isn't necessarily *wrong* — CLAUDE.md's inline descriptions for both "ADRs" are actually fairly complete (the file-tunnel paragraph in particular is a good architectural summary with rationale). But labeling them "ADR-004"/"ADR-005" implies a numbered decision-record series exists, which could mislead a contributor searching for `docs/adr/` or `decisions/`.

**Severity**: Medium (no functional impact, but it's a documentation-discoverability gap: the "ADR" terminology sets an expectation of a structured decision log that doesn't exist, and the scope doc's reference to non-existent `prd.md`/`RemoteBridge-ARCHITECTURE.md` could send a future reviewer on a wasted file search).

**Recommendation**: Either:
- (Low effort) Drop the "ADR-004"/"ADR-005" numbering from CLAUDE.md and just say "(see the file-tunnel design rationale below)" / "(see the single-instance trade-off note below)", since the content already lives inline; or
- (Better) Create a lightweight `docs/adr/` directory with `004-file-tunnel.md` and `005-single-instance-rooms.md` that promote the existing inline paragraphs to standalone ADR-format documents (Context / Decision / Consequences), and have CLAUDE.md link to them instead of (or in addition to) the inline summary. This also gives a natural home for documenting the "structural risk" trade-offs (D5/01b-H2's room-state coupling) as "Status: accepted, revisit if multi-instance is needed."

Also: update `00-scope.md` (or note for future review phases) that `prd.md` and `RemoteBridge-ARCHITECTURE.md` referenced as "available to agents" do not exist in this repo snapshot.

---

### D6 — No system/architecture diagrams beyond one ASCII box diagram in 使用说明书.md

**Location**: `使用说明书.md:12-18` (the only diagram in the entire doc set)

**Findings**:
- The only visual/diagrammatic representation of the system anywhere in the repo's docs is this ASCII art in 使用说明书.md:
  ```
  ┌──────────────┐   出站 WebSocket   ┌──────────────┐   WebSocket   ┌──────────────┐
  │  桌面端 Host  │ ─────────────────→ │  Relay 中继   │ ←──────────── │  Web 客户端   │
  │ (Electron)   │                    │  服务器       │               │  (浏览器)     │
  │ 你的电脑      │                    │  :3001       │               │  :3000       │
  └──────────────┘                    └──────────────┘               └──────────────┘
  ```
- This is a good, accurate top-level topology diagram (outbound-only Host connection, bidirectional relay, correctly shows default ports). However:
  - It only appears in the Chinese operations manual, not in CLAUDE.md (which is the primary doc for Claude Code / contributors).
  - There is no diagram for the **room/session model** (Host↔Client mapping per `sessionId`, the `hostSockets`/`clientSockets`/`sessionRooms` Maps described in CLAUDE.md's "Room management: relay.ts vs rooms.ts" section) — this is the most architecturally subtle part of the system (01b-H1/H2 flagged it as having fractured into three serialization paths) and would benefit most from a diagram.
  - There is no sequence diagram for the file-tunnel flow (CMD_REQUEST_DOWNLOAD → RESP_DOWNLOAD_READY → proxy rewrite → CMD_FETCH_FILE → RESP_FILE_CHUNK× → HTTP response), despite this being the most protocol-dense flow in the system and the one most recently the subject of an "ADR."
  - There is no diagram for the auth flow (register-host → generate-pin → connect → access/refresh token issuance → WS auth via query params), despite this being security-critical and having had multiple historical bugs (per `docs/code-review-report.md` §2.1, §3.1).

**Severity**: Medium (the prose descriptions in CLAUDE.md are detailed and largely accurate, but the room-routing and file-tunnel flows in particular are exactly the areas where Phase 1/2 found the most bugs (01b-H1/H2, the routing-fields contract violations) — a diagram would make the "three serialization paths" problem and the routing-fields injection points much easier to grasp and to keep correct during future changes).

**Recommendation**: Add to CLAUDE.md (as Mermaid diagrams, which render natively in most Markdown viewers including GitHub):
1. A sequence diagram for the CMD_LIST_DIR / generic CMD→payload-injection→RESP→withRouting flow, annotating exactly where `clientId`/`sessionId`/`senderId`/`senderType`/`messageId` are injected and echoed (directly illustrating the "Routing fields contract" paragraph at CLAUDE.md:81).
2. A sequence diagram for the file-tunnel flow (the ADR-004 content), showing the proxy → pending-requests registration → CMD_FETCH_FILE → chunked RESP_FILE_CHUNK → relay pipe → HTTP response, with the 4MB backpressure loop annotated.
3. (Optional) Port the existing ASCII topology diagram from 使用说明书.md into CLAUDE.md's Project Overview section, since CLAUDE.md is read by Claude Code / contributors who may not open the Chinese ops manual.

---

### D7 — `apps/server/src/routes/messages.ts` still uses `verifyToken` (S1/C2) — CLAUDE.md's REST API table doesn't flag this as a known security gap

**Location**: CLAUDE.md:105 (`messages/:sessionId` REST route entry); actual code `apps/server/src/routes/messages.ts:6,32`

**Findings**:
- Confirmed in current code: `apps/server/src/routes/messages.ts` line 6 imports `verifyToken` (not `verifyAccessToken`), and line 32 calls `payload = verifyToken(token)` for the `GET /messages/:sessionId` handler (the `POST` handler at line ~135 per Phase 2's citation has the same pattern). This matches Phase 1/2's S1/C2 finding exactly — **not yet fixed**.
- CLAUDE.md:105 describes this route purely functionally: "`messages/:sessionId` — GET for message history (paginated, with `since` timestamp filter), POST for REST fallback send" — with no indication that this endpoint currently accepts refresh tokens as access tokens and doesn't check `revokedAt` (unlike `proxy.ts::validateSession`, which CLAUDE.md's security-model paragraph correctly describes as checking revocation).
- This is a case where the *documentation is technically not making a false claim* (it just doesn't mention auth details for this route), but given CLAUDE.md:113's security-model paragraph explicitly says "The relay rejects WebSocket connections using refresh tokens... and validates sessions against `revokedAt`" — a reader could reasonably (but incorrectly) extrapolate that *all* authenticated endpoints have this property. `messages.ts` is the one documented exception that isn't called out as an exception.

**Severity**: Medium (from a pure documentation standpoint — the security bug itself is S1/Critical in Phase 2, but that's a code finding; the doc gap is that the security-model section's blanket revocation/refresh-token claims could mislead a reader about `messages.ts` specifically).

**Recommendation**: Until S1/C2 is fixed in code, add a footnote to CLAUDE.md's REST API list at the `messages/:sessionId` entry:

> `messages/:sessionId` — GET for message history (paginated, with `since` timestamp filter), POST for REST fallback send. **Known gap**: unlike other authenticated routes, this endpoint currently uses `verifyToken` (accepts refresh tokens as access tokens) and does not check `session.revokedAt` — see security finding S1. Do not treat this route as covered by the "Security model" section's refresh-token-rejection / revocation-check guarantees until fixed.

Once S1/C2 is fixed (swap to `verifyAccessToken` + `revokedAt` check), remove this footnote — at that point `messages.ts` becomes consistent with the blanket claim and no footnote is needed.

---

## Low

### D8 — `docs/code-review-report.md`'s "结构性风险（遗留）" list: CLAUDE.md's own staleness caveat is itself accurate, but incomplete — item 2 (pending-requests for proxy) needs re-verification

**Location**: `CLAUDE.md:7` (staleness caveat); `docs/code-review-report.md:144-150` (the "结构性风险（遗留）" list, items 1-6)

**Findings**: CLAUDE.md's caveat says: *"its '结构性风险（遗留）' list is partially stale (revoked-session WS check, pending-requests registry, separate refresh secret, and persistent clientId were fixed after it was written); trust the code over that list."*

Cross-checking each of the 6 items in `docs/code-review-report.md`'s list against the caveat and current code:

1. **Item 1** (room state in-memory, single-instance only) — **not claimed fixed** by the caveat, and CLAUDE.md itself documents this as "ADR-005: accepted trade-off" (line 72). Consistent — still accurate as a known, accepted limitation.
2. **Item 2** (`routes/proxy.ts` per-request temporary listeners on hostWs) — **claimed fixed** by the caveat ("pending-requests registry"). Verified: `apps/server/src/ws/pending-requests.ts` exists and CLAUDE.md:83 describes the relay registering `requestId` before sending CMD_* for proxy routes. **Caveat is accurate** — this item genuinely is superseded.
3. **Item 3** ("WS handshake doesn't check session revocation... revoke route doesn't notify client") — **claimed fixed** by the caveat ("revoked-session WS check"). CLAUDE.md:113 confirms "The relay rejects WebSocket connections... and validates sessions against `revokedAt`... ('session revoked' close code 4003)", and the REST API table (line 102) confirms `auth/revoke/:sessionId` "sends SESSION_REVOKED WS message + force-disconnects client with code 4003". **Caveat is accurate.**
4. **Item 4** (dual message persistence, no dedup/sync semantics, `direction` field divergence) — **not claimed fixed** by the caveat. Phase 1 (01a-M7) independently flagged `direction` field semantics as still an open issue. Consistent — still accurate as an open item.
5. **Item 5** (Web `clientId` regenerated per-connection, breaking "trusted device" persistence) — **claimed fixed** by the caveat ("persistent clientId"). CLAUDE.md:90 confirms "Client posts PIN + persistent `clientId` (localStorage UUID)". **Caveat is accurate.**
6. **Item 6** (`JWT_REFRESH_SECRET` defined but unused) — **claimed fixed** by the caveat ("separate refresh secret"). Verified via `apps/server/src/utils/jwt.ts:8`: `JWT_REFRESH_SECRET` is now read and used (with a derived fallback — see D2 above for the *quality* of that fix). **Caveat is accurate** that it's no longer "unused," though D2 notes the fallback derivation undermines the intended independence property — this is a nuance the caveat doesn't capture but isn't a misstatement either.

**Conclusion**: CLAUDE.md's own staleness caveat about `docs/code-review-report.md`'s legacy-risks list is **itself accurate** — all 4 items it claims are superseded (items 2, 3, 5, 6) are verifiably superseded in current code, and the 2 items it doesn't claim are superseded (1, 4) are verifiably still open. No correction needed here.

**Severity**: Low (this is a "checked and found OK" item — included for completeness per the review instructions, since the task explicitly asked to verify this caveat's accuracy).

**Recommendation**: None required — but consider adding one clause to the CLAUDE.md caveat acknowledging D2's nuance, e.g. append: "...though the refresh-secret separation (item 6) currently has a weak default (derived from `JWT_SECRET` if `JWT_REFRESH_SECRET` is unset) — see the Environment section's security note." This keeps the caveat's accuracy intact while pointing at the more precise current-state description.

---

### D9 — Inline documentation of complex logic is generally good; one notable gap in `ws-types.ts`'s `RelayRoutingFields` for the file-tunnel payloads

**Location**: `packages/shared/src/ws-types.ts:142-174` (file-tunnel payload types)

**Findings** (mostly positive, included for completeness per review instruction #1):
- `RelayRoutingFields` (ws-types.ts:72-78) has a clear two-line Chinese comment explaining the inject/echo contract and *why* (so Relay can route responses back to the correct Client) — good.
- `withRouting()` in `dir-handlers.ts:17-24` has a matching comment on the Host side, consistent with the shared-package comment — good, the WHY is explained at both ends of the contract.
- The file-tunnel backpressure logic (`apps/desktop/src/main/ws-client/file-tunnel.ts:13-17,96-97`) has clear inline comments: `// 背压：等待 WS 缓冲降到水位线下，避免大文件全堆在内存里` ("backpressure: wait for WS buffer to drop below watermark, avoid holding entire large file in memory") with the `4 * 1024 * 1024` constant clearly named and commented — good.
- `path-guard.ts`'s recursive-permission check (lines 48-58) has a step-numbered comment (`// 步骤 4: 检查递归权限`) consistent with the rest of the function's step-by-step structure — good, though it doesn't explain *why* non-recursive entries should fail for non-exact-match paths (a one-line "non-recursive shares only grant access to the exact registered path, not subdirectories" would help a reader unfamiliar with the whitelist model).
- **Gap**: `ws-types.ts:142` labels the file-tunnel payloads section with a good comment ("Relay ↔ Host 专用，永不中继给 Client" / "Relay↔Host only, never relayed to Client") but the *individual* payload interfaces (`CmdFetchFilePayload`, `RespFileChunkPayload`, `RespFileErrorPayload`, lines 143-174) have **no field-level comments** explaining the chunking protocol (e.g., what `chunkIndex`/`isLast`/`totalSize` mean, whether `data` is base64, what happens on error mid-stream). Given that 02b-H1 identified the base64 chunking overhead as a performance hotspot and a candidate for a future binary-framing rewrite, documenting the current wire format precisely here would make that future change safer (a contributor would know exactly what to preserve).

**Severity**: Low (the most load-bearing/non-obvious logic — routing contract, backpressure, recursive-permission — is already well-commented; this is a minor enhancement to the one area that's likely to be refactored next per 02b-H1).

**Recommendation**: Add field-level doc comments to `RespFileChunkPayload`/`RespFileErrorPayload` in `ws-types.ts`, e.g.:

```ts
export interface RespFileChunkPayload {
  requestId: string;
  /** Base64-encoded chunk data (raw bytes, CHUNK_SIZE=256KB before encoding, see file-tunnel.ts) */
  data: string;
  /** 0-based index of this chunk within the stream */
  chunkIndex: number;
  /** true on the final chunk — relay closes the HTTP response after processing this frame */
  isLast: boolean;
  /** Redundantly resent on every chunk (see 01b-L5 cleanup note) */
  contentType: string;
  fileName: string;
  totalSize: number;
}
```

---

## Summary table

| ID | Severity | Area | One-line summary |
|----|----------|------|-------------------|
| D1 | Critical | CLAUDE.md security model | "Writes to ... relay security-logs endpoint" is false — no `POST /security-logs` exists; relay-side audit trail for Host events is permanently empty (verifies 01b-C1/S3) |
| D2 | Critical | .env.example / CLAUDE.md Environment | No guidance on JWT secret strength/independence; default fallback is a publicly-known dev secret, and unset `JWT_REFRESH_SECRET` derives trivially from `JWT_SECRET` (verifies S6) |
| D3 | High | apps/web, apps/desktop | No CSP documentation anywhere for Next.js headers or Electron renderer (verifies S5/S7) |
| D4 | High | Repo-wide | No CHANGELOG/migration notes for refresh-secret separation or persistent-clientId breaking changes; all packages frozen at 1.0.0 |
| D5 | Medium | CLAUDE.md | "ADR-004"/"ADR-005" are inline-only, no actual ADR documents exist; scope doc references non-existent prd.md/RemoteBridge-ARCHITECTURE.md |
| D6 | Medium | Docs generally | Only one ASCII topology diagram (in 使用说明书.md only); no room-routing or file-tunnel sequence diagrams despite these being the most bug-prone areas |
| D7 | Medium | CLAUDE.md REST API table | `messages/:sessionId` entry doesn't flag that it's the one route NOT covered by the security-model section's refresh-token/revocation guarantees (S1/C2 still unfixed) |
| D8 | Low | docs/code-review-report.md vs CLAUDE.md | CLAUDE.md's staleness caveat about the legacy-risks list is itself verified accurate — no correction needed |
| D9 | Low | packages/shared/src/ws-types.ts | Inline docs for routing contract/backpressure/recursive-permission are good; file-tunnel payload fields lack field-level comments ahead of a likely future binary-framing refactor (02b-H1) |

**Overall assessment**: The repo's documentation is unusually thorough for its size (CLAUDE.md's protocol-routing and room-management sections in particular reflect real architectural understanding, and 使用说明书.md is a genuinely useful, accurate operations manual). The main problems are (a) one specific "load-bearing" security claim (D1) that is now actively false due to an unfixed code bug (01b-C1/S3) and needs an honest "known gap" rewrite, (b) a security-configuration documentation vacuum around JWT secrets (D2) and CSP (D3) that mirrors the corresponding code gaps (S6/S5/S7), and (c) the absence of any changelog/migration story (D4) for a codebase that has already undergone several breaking internal changes within its single "1.0.0" version. None of these require new architecture — they require either (1) honest "known gap" language pointing at already-filed findings, or (2) short new sections (security-config, migration notes) that don't yet exist anywhere.
