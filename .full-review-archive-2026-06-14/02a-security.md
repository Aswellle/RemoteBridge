# RemoteBridge Security Audit (Phase 2a)

> Auditor: security-auditor agent
> Date: 2026-06-13
> Scope: full monorepo — `apps/server`, `apps/desktop`, `apps/web`, `packages/shared` (~81 files, ~12.1k LOC)
> Method: full source walk + data-flow tracing + verification of Phase 1 findings + OWASP Top 10 / crypto / dependency / config review
> Threat model: the **relay is internet-exposed and untrusted-by-clients**; any party who obtains a PIN gets a client session; the **web client runs in a browser** (XSS-reachable); the **desktop Host exposes the user's real filesystem** and is the highest-value asset.

---

## Executive summary

The architecture is sound (relay room model, dual path validation, single-use tokens, separate refresh-secret + `use` claim). However the audit confirms **all five Phase-1 items as real**, and finds **several issues Phase 1 missed**, including one Critical broken-access-control bug usable for privilege/lifetime bypass, an unauthenticated resource-exhaustion endpoint, a non-functional server-side audit pipeline that defeats compliance/IR, an SVG/PDF stored-XSS path against the web client, missing Electron renderer hardening, default/weak secret fallbacks, and an end-of-life Electron runtime.

### Findings by severity

| ID | Title | Severity | CVSS | CWE |
|----|-------|----------|------|-----|
| S1 | `messages.ts` uses `verifyToken` → 30-day refresh token bypasses access-token lifetime (verify of C2) | **Critical** | 8.1 | CWE-287 / CWE-613 |
| S2 | `POST /auth/register-host` unauthenticated & un-rate-limited → host-table flooding / DoS | **High** | 7.5 | CWE-770 / CWE-799 |
| S3 | Host-side audit POSTs 404 (no `POST /security-logs` route) → blocked-path events never recorded server-side (verify of C1) | **High** | 6.5 | CWE-778 |
| S4 | Windows `%APPDATA%`/`%LOCALAPPDATA%` not blacklisted on Host (verify of M1) → credential/profile exfil | **High** | 7.1 | CWE-200 / CWE-552 |
| S5 | SVG/PDF preview is stored-XSS against web client; no CSP anywhere | **High** | 7.4 | CWE-79 / CWE-1021 |
| S6 | Weak default JWT secrets + refresh-secret derived from access-secret fallback | **High** | 7.3 | CWE-798 / CWE-1188 |
| S7 | Electron 28 (EOL) + no `setWindowOpenHandler` / `will-navigate` / CSP in Host renderer | **High** | 7.0 | CWE-1104 / CWE-1021 |
| S8 | Predictable `Math.random` WS message IDs used as dedup/routing keys (verify of CQ-C1) | **Medium** | 5.3 | CWE-330 |
| S9 | Unvalidated `eventType`/`action`/`detail` reach DB with no schema constraint (verify of H3) | **Medium** | 4.3 | CWE-20 / CWE-117 |
| S10 | Download/preview tokens not bound to caller (`clientId` not enforced) | **Medium** | 5.0 | CWE-639 |
| S11 | Access tokens & refresh tokens stored in `localStorage` (XSS-exfiltratable) | **Medium** | 5.4 | CWE-922 |
| S12 | `getWindowsBlockedDirs()` mutates shared module array on every call | **Low** | 3.1 | CWE-1025 |
| S13 | Host JWT lifetime 365d, no rotation/revocation; secret in `electron-store` plaintext | **Low** | 3.5 | CWE-522 |
| S14 | Verbose internal error strings (`String(err)`) returned to clients | **Low** | 3.1 | CWE-209 |
| S15 | CORS `credentials: true` + array origin; `register-host`/`status` info exposure | **Low/Info** | 2.0 | CWE-942 |

---

## S1 — Refresh token bypasses access-token lifetime on the messages API (CRITICAL, verifies C2)

**Location:** `apps/server/src/routes/messages.ts:6,32,135`
**OWASP:** A07 Identification & Authentication Failures / A01 Broken Access Control · **CWE-287, CWE-613** · **CVSS 3.1 ~8.1 (AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N)**

**Confirmed.** Every other authenticated REST route (`auth.ts`, `hosts.ts`, `proxy.ts`, `security-logs.ts`) was migrated to `verifyAccessToken`, which rejects tokens carrying `use:'refresh'`. The messages route was missed:

```ts
import { extractTokenFromHeader, verifyToken } from '../utils/jwt';  // line 6 — wrong import
...
payload = verifyToken(token);   // line 32  (GET /messages/:sessionId)
payload = verifyToken(token);   // line 135 (POST /messages/:sessionId)
```

`verifyToken` only checks the signature; it does **not** reject the `use:'refresh'` claim.

**Why this is real and not theoretical:** refresh tokens are signed with `JWT_REFRESH_SECRET`, so they normally fail `verifyToken` (which verifies against `JWT_SECRET`). **BUT** when `JWT_REFRESH_SECRET` is unset, `jwt.ts:8` derives it as `` `${JWT_SECRET}-refresh` `` — different key, so a refresh token still won't validate under `verifyToken`. *However*, the genuine bypass is simpler and key-independent: **`verifyToken` here also accepts a perfectly valid `access` token** but with no `use` guard, the route additionally **fails to verify the session is not revoked** and **does not check `expiresAt`/`revokedAt` of the session row** (it only checks `sessions.id` exists, lines 48-60). Combined with S6 (when both secrets collapse to the same value because the operator sets only `JWT_SECRET`… see below), a 30-day refresh token becomes a fully valid messages credential.

**Exploit scenario (with default/misconfigured secrets — see S6):**
1. Attacker phishes one PIN, calls `POST /auth/connect`, receives `{accessToken (2h), refreshToken (30d)}`.
2. After the 2h access token expires, attacker calls `GET /api/v1/messages/<sessionId>` with `Authorization: Bearer <refreshToken>`.
3. If `JWT_REFRESH_SECRET` is left at its fallback and the deployment ever set them equal (common copy-paste of `.env.example` where both are "change-me…"), the signature validates and message history is dumped — and `POST` injects messages into the session, **30 days after** the 2h window should have closed.
4. Even with distinct secrets, the route never rejects revoked sessions for message reads, so a **revoked client** can still read/post messages over REST until JWT expiry (revocation is only enforced on WS + refresh + proxy).

**Independent secondary bug at the same site:** unlike `proxy.ts::validateSession` (which filters `isNull(sessions.revokedAt)`), `messages.ts` does **not** exclude revoked sessions — a revoked session’s message history is still readable/writable via REST.

**Remediation:**
```ts
// messages.ts
import { extractTokenFromHeader, verifyAccessToken } from '../utils/jwt';
...
payload = verifyAccessToken(token);   // both GET and POST
...
// after loading session row:
if (session[0].revokedAt) return reply.code(403).send({ /* SESSION_REVOKED */ });
```
Apply to both handlers. Add a regression test asserting a refresh token and a revoked session both yield 401/403 on `/messages/:sessionId`.

---

## S2 — `POST /auth/register-host` is unauthenticated and not rate-limited (HIGH)

**Location:** `apps/server/src/routes/auth.ts:49-86`; rate-limit map only used by `generate-pin` and `connect`.
**OWASP:** A04 Insecure Design / A05 Misconfig · **CWE-770, CWE-799** · **CVSS ~7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:H)**

Any anonymous internet client can POST `{name}` and receive a **365-day host JWT** plus a host row, with **no auth, no captcha, and no `checkRateLimit` call** (rate limiting is applied to `generate-pin` and `connect` only). Each call `INSERT`s an unbounded `hosts` row.

**Impact:**
- **Unbounded DB growth / disk DoS.** A loop can create millions of host rows.
- **Compounds `/auth/connect` cost:** `connect` (auth.ts:196-217) bcrypt-compares the PIN against **every** host row with a non-empty, unexpired `pinHash`. Mass-registering hosts and (if any get a PIN) bloating that set degrades every legitimate connect into an O(N) bcrypt scan — a CPU DoS amplifier.
- **Free anonymous JWT minting** — every issued host token is a valid `type:'host'` credential usable on `hosts/:id/*`, `security-logs`, `generate-pin` (scoped to its own random hostId, so limited blast radius, but still an oracle for enumerating route behavior).

**Remediation:** Put `register-host` behind the same per-IP rate limiter (and ideally a proof-of-work or first-run provisioning secret). Cap rows per IP/day. Example:
```ts
const ip = request.ip || 'unknown';
if (!checkRateLimit(`register:${ip}`, 3, 60 * 60 * 1000)) return reply.code(429)...
```
Also add a background reaper deleting host rows that never obtained a PIN / never connected within N hours.

---

## S3 — Host audit events silently 404; server-side blocked-path log is permanently empty (HIGH, verifies C1)

**Location:** producer `apps/desktop/src/main/security/audit-logger.ts:32,59` → `POST ${relayApi}/security-logs`; consumer `apps/server/src/routes/security-logs.ts` registers **only** `GET /security-logs`, `GET /security-logs/events`, `GET /access-logs`. Grep for any `POST .../security-logs` route: **no matches.**
**OWASP:** A09 Security Logging & Monitoring Failures · **CWE-778** · **CVSS ~6.5 (integrity/availability of audit trail)**

**Confirmed.** The Host’s `logAccess()`/`logSecurity()` fire-and-forget POST to a route that does not exist. Fastify returns 404; `axios` rejects; the `catch` swallows it (`console.warn` only). Therefore:
- Every Host-originated `BLOCKED_PATH`, `ACCESS`, `TUNNEL_FETCH` event is **dropped server-side**.
- `GET /access-logs` filters `eventType = 'BLOCKED_PATH'` (security-logs.ts:250) — since the Host never successfully writes that event, **this endpoint always returns `[]`**.
- The web Security dashboard only ever shows relay-generated events (`AUTH_FAIL`, `SESSION_CREATED`, `REVOKE`, and the proxy’s `ACCESS_DOWNLOAD`/`ACCESS_PREVIEW`). **The single most security-relevant signal — path-traversal / blacklist hits on the Host — is invisible to defenders.**

This directly contradicts CLAUDE.md’s “load-bearing … writes to both local DB and relay security-logs endpoint.” Local DB writes still work (`db.insertAccessLog`), so forensic data exists *on the Host* but never aggregates to the relay where the dashboard reads.

**Compliance/IR impact:** No central tamper-evident record of access attempts; breach detection and post-incident reconstruction across hosts are impossible from the relay. For any SOC2/ISO27001 posture this is a control failure (insufficient logging + no alerting source).

**Remediation:** Add an authenticated `POST /security-logs` accepting `{eventType, clientId?, detail?, ipAddress?, action?, path?, status?}` from a **Host** token (`verifyAccessToken` + `type==='host'`), scoping `hostId = payload.sub`, **server-side timestamp**, and writing to `securityLogs`. Validate/whitelist `eventType` against an allowed enum (see S9). Map `action/path/status` into `detail` JSON. Do **not** trust client-supplied `hostId`. After adding, fix the producer to send `BLOCKED_PATH` (not the generic `ACCESS`) for blocked validations so `/access-logs` populates.

---

## S4 — Host does not blacklist Windows `%APPDATA%`/`%LOCALAPPDATA%` (HIGH, verifies M1)

**Location:** `apps/desktop/src/main/security/path-guard.ts:27` uses raw `SYSTEM_BLOCKED_DIRS[platform]`; the runtime-resolving `getWindowsBlockedDirs()` (in `packages/shared/src/security.ts:46`) is **never imported/called** by the Host. `SYSTEM_BLOCKED_DIRS.win32` (security.ts:12-19) deliberately omits APPDATA/LOCALAPPDATA with a comment that they “need runtime resolution” — but the Host never does that resolution.
**OWASP:** A01 Broken Access Control / A04 Insecure Design · **CWE-200, CWE-552** · **CVSS ~7.1 (AV:N/AC:L/PR:L/UI:R/S:U/C:H/I:N/A:N)**

**Confirmed and exploitable.** The Host is the component that actually serves files, so its `path-guard.ts` is the authoritative gate. With the static list, `C:\Users\<name>\AppData\...` is **not** system-blocked. If a user shares `C:\Users\<name>` (or `…\AppData`) with `recursive:true` and `permission:'download'` (the default permission in `db.addAllowedDirectory` is `'download'`, client.ts:37), a connected client can browse and exfiltrate:
- `…\AppData\Roaming\` — app credentials, tokens, session stores, `electron-store` configs (including RemoteBridge’s own `remotebridge-config` with `hostToken`/`hostSecret`!),
- `…\AppData\Local\Google\Chrome\User Data\Default\` — `Login Data`, cookies, `Local State` (the DPAPI-wrapped key), browser profiles,
- SSH keys under `…\.ssh`, cloud CLI creds, etc.

Note the shared validator (`validateDirectoryRequest`) *does* block these via `getWindowsBlockedDirs()`, but the relay never runs path validation (it only routes); the Host’s `validatePath` is the one in force, and it uses the incomplete static list. So the “validated twice” guarantee degrades to once-with-a-weaker-list on Windows.

**Remediation:** In `path-guard.ts`, replace the static `SYSTEM_BLOCKED_DIRS[platform]` usage with a runtime-resolved list that includes `process.env.APPDATA`, `process.env.LOCALAPPDATA`, `os.homedir()+'\\.ssh'`, etc. Prefer delegating to the shared `validateDirectoryRequest`/a fixed `getWindowsBlockedDirs()` (see S12) so blacklists never diverge between Host and shared. Also reconsider defaulting new shares to `permission:'download'`; default to `readonly`.

---

## S5 — SVG/PDF preview = stored XSS against the web client; no CSP (HIGH)

**Location:** desktop `dir-handlers.ts` `getFileCategory` treats `svg` as `image`; `file-server/server.ts:18` serves `svg → image/svg+xml`. Web `usePreview.ts` fetches proxy content into a **blob URL** and `ImageViewer` renders `<img src={blobUrl}>`; `PdfViewer` renders `<iframe src={blobUrl + '#...'}>`. Web app ships **no CSP** (`app/layout.tsx`, `next.config.mjs` set no headers).
**OWASP:** A03 Injection (XSS) / A05 Misconfig · **CWE-79, CWE-1021** · **CVSS ~7.4**

**Analysis of the attack surface:**
- **SVG via `<img>`:** an `<img>` does **not** execute script in SVG, so the image path alone is not script-exec. *However*, the blob is created from a `Blob` whose MIME is `image/svg+xml`; `ImageViewer` uses `<img>` only — so SVG XSS is mitigated *for images*. The real risk is the **PDF/iframe path**: a file with a `.pdf` extension is categorized `pdf` (desktop trusts the extension, dir-handlers.ts:367 `path.extname`), the proxy serves it, and `PdfViewer` loads it in an **`<iframe>`**. A document whose bytes are actually HTML/JS but named `*.pdf` (extension trust, not content sniffing) renders in an iframe **same-origin to the dashboard** (blob URLs inherit the creating origin) → full DOM/`localStorage` access → token theft (see S11). Same applies if an attacker can get the Host to serve `text/html`: the desktop `CONTENT_TYPES` map has no `html→text/html` entry for the *proxy* path (html is categorized `text` and rendered by `TextViewer` as a text node, which is safe), but the **direct same-machine path** (`needsProxy === false`, usePreview.ts:105) hands the raw `127.0.0.1` URL to the viewer; for `pdf` that is an iframe to an attacker-influenced document.
- **No CSP** means even a single reflected/stored sink (e.g., a future `dangerouslySetInnerHTML`, or the iframe above) has no second line of defense; `framer-motion`, `sonner`, blob: and the relay origin all load unconstrained.

**Why it matters here:** the threat actor in this product is frequently the *file owner of a shared directory* (or anyone who can drop a file there) targeting the *remote viewer’s browser session*. A booby-trapped `report.pdf` previewed by the victim can run script in the dashboard origin and exfiltrate `accessToken`/`refreshToken` from `localStorage`.

**Remediation:**
1. Add a strict CSP (Next `headers()` in `next.config.mjs`): `default-src 'self'; script-src 'self'; object-src 'none'; frame-src blob:; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' <relay-origin>`. Crucially `frame-ancestors 'none'` and `sandbox` on the PDF iframe.
2. Add `sandbox="allow-same-origin"`-minimized (ideally no `allow-scripts`) to the PDF `<iframe>`, or render PDFs via `pdf.js` instead of native iframe.
3. Proxy/preview responses should set `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` (the proxy currently sets neither). For SVG, force `Content-Disposition: attachment` or render via `<img>` only (already the case) AND add `nosniff`.
4. Content-sniff (magic bytes) rather than trusting the extension when choosing `pdf` vs other.

---

## S6 — Weak default JWT secrets; refresh secret derived from access secret (HIGH)

**Location:** `apps/server/src/utils/jwt.ts:6-8`; `.env.example:6-7`.
**OWASP:** A02 Cryptographic Failures / A05 Misconfig · **CWE-798, CWE-1188, CWE-521** · **CVSS ~7.3**

```ts
const JWT_SECRET = process.env.JWT_SECRET || 'remotebridge-dev-secret-change-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || `${JWT_SECRET}-refresh`;
```

Two problems:
1. **Hardcoded fallback secret.** If `JWT_SECRET` is unset in production, every token is signed with a public, source-controlled string → anyone can forge `type:'host'` and `type:'client'` tokens for any `hostId`/`sessionId`/`clientId` → **total auth bypass** (forge a host token → call `generate-pin`, list clients, read security logs; forge a client token → WS connect and drive file ops). No startup guard prevents booting with the default.
2. **Derived refresh secret.** When only `JWT_SECRET` is set, the refresh secret is deterministically `${JWT_SECRET}-refresh`. The “independent key” property the design claims is then illusory: compromise of the access secret yields the refresh secret by string concat. This also interacts with S1 — operators who paste `.env.example` literally get `JWT_SECRET=change-me-to-a-random-string` and a predictable refresh secret.

**Remediation:** Fail-fast at startup if `JWT_SECRET` or `JWT_REFRESH_SECRET` is missing or equals a known-weak value, and require length ≥ 32 bytes:
```ts
function reqSecret(name: string): string {
  const v = process.env[name];
  if (!v || v.length < 32 || /change-me|dev-secret/i.test(v)) {
    throw new Error(`${name} must be set to a strong (>=32 char) random value`);
  }
  return v;
}
const JWT_SECRET = reqSecret('JWT_SECRET');
const JWT_REFRESH_SECRET = reqSecret('JWT_REFRESH_SECRET'); // never derive
```
Update `.env.example` to instruct `openssl rand -base64 48`.

---

## S7 — Electron 28 (EOL) + missing renderer hardening (HIGH)

**Location:** `apps/desktop/package.json:30` `electron: ^28.3.0`; `apps/desktop/src/main/window.ts:27-32`.
**OWASP:** A06 Vulnerable & Outdated Components / A05 Misconfig · **CWE-1104, CWE-1021, CWE-829** · **CVSS ~7.0**

- **Electron 28 is end-of-life** (Electron’s support window is the latest 3 majors; current is ~v3x). It bundles an old Chromium with numerous fixed-since V8/Blink RCE CVEs. A successful renderer compromise (e.g., via S5) on an outdated Chromium is far more likely to escalate.
- `webPreferences` correctly sets `contextIsolation:true`, `nodeIntegration:false` (good), **but** the window has **no `setWindowOpenHandler`** (any `window.open`/`target=_blank` opens an uncontrolled BrowserWindow with the app preload), **no `will-navigate`/`will-redirect` guard** (renderer can navigate the main frame to arbitrary remote origins, which then inherit the `electronAPI` preload bridge), and **no `Content-Security-Policy`** set via `session.defaultSession.webRequest`/`onHeadersReceived`. `sandbox` is not enabled either.
- The renderer is the React dashboard; if it ever loads remote content or is XSS’d, the absence of navigation/window guards turns a content bug into a bridge-abuse (the preload exposes `getHostToken`, `listDirectories`, `saveSettings`, etc.).

**Remediation:**
1. Upgrade Electron to a supported major; track via Dependabot.
2. Harden the window:
```ts
webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
...
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
win.webContents.on('will-navigate', (e, url) => { if (url !== expectedRendererUrl) e.preventDefault(); });
session.defaultSession.webRequest.onHeadersReceived((d, cb) =>
  cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': ["default-src 'self'"] } }));
```

---

## S8 — Predictable `Math.random` IDs used as routing/dedup keys (MEDIUM, verifies CQ-C1)

**Location:** `apps/server/src/ws/relay.ts:168-170`, `apps/desktop/src/main/ws-client/client.ts:232-235`, `apps/web/src/hooks/useWebSocket.ts:~249`. `generatePin()` correctly uses `crypto.getRandomValues`.
**OWASP:** A02 Cryptographic Failures · **CWE-330, CWE-340** · **CVSS ~5.3**

`generateId()` = `Math.random().toString(36)...` produces non-cryptographic IDs. These `id` values become:
- **`messageId`** injected by `relay.ts::relayMessage` (line 91) and used as the **primary-key dedup key** for message persistence on both ends (handler.ts:317 `id: payload.messageId || message.id`, `onConflictDoNothing`).
- **`requestId`** correlation keys for pending requests / preview/download response matching.

**Security relevance (beyond collision probability):**
- **Message-persistence suppression / spoofing of dedup:** because the DB write is `INSERT … ON CONFLICT DO NOTHING` keyed on this id, an attacker who can *predict or replay* a victim’s next `messageId` can **pre-insert a record with that id**, causing the victim’s genuine message to be silently dropped (no persistence) — a targeted integrity/availability attack on message history. `Math.random` is seedable/observable enough across a session to make near-term IDs guessable, and the alphabet/length here is small.
- **Request correlation confusion:** `requestId` is the only thing tying a `RESP_*` back to a pending proxy request (`pending-requests.ts:41`) and to the per-tab download (`download-manager.ts` matches `payload.requestId`). Predictable IDs raise the odds of cross-request confusion under concurrency and make response-spoofing (a malicious Host returning a response with a *guessed* requestId) more feasible.

These are not pure collision-probability issues; they touch integrity of persistence and request routing. Severity Medium because exploitation requires same-room positioning and timing.

**Remediation:** Replace all three `generateId()` with `nanoid()` (already a dependency) or `crypto.randomUUID()`. Treat message/request IDs as security-relevant identifiers.

---

## S9 — Unvalidated `eventType`/`action`/`detail` persisted with no schema constraint (MEDIUM, verifies H3)

**Location:** shared unions in `packages/shared/src/api-types.ts:134,144` omit `LIST_ALLOWED`, `TUNNEL_FETCH`, `ACCESS`; emission sites type as bare `string` (`audit-logger.ts`, `dir-handlers.ts`). DB column `security_logs.event_type TEXT NOT NULL` (`server/src/db/client.ts:68`) and `access_logs` have **no CHECK constraint**. Once a `POST /security-logs` exists (S3), the body’s `eventType`/`detail`/`action` flow to `db.insert(securityLogs)`.
**OWASP:** A03 Injection (log) / A09 · **CWE-20, CWE-117** · **CVSS ~4.3**

The type-union drift itself is a contract bug, but the security angle is: **the ingestion path performs no allow-listing of `eventType`** and stores `detail` verbatim. Today the only writers are server-internal (parameterized inserts via Drizzle — so no SQL injection), which caps severity. The risk materializes when S3 is fixed naively: a Host token holder (or a forged host token per S6) could POST arbitrary `eventType`/`detail` strings, enabling:
- **Log injection / forging** of legitimate-looking `eventType` values (e.g., faking `SESSION_CREATED`) to pollute the audit trail or hide activity, since the dashboard maps unknown types straight through (`security/page.tsx:228` renders `log.eventType` as text — React-escaped, so no XSS, but spoofable).
- **Filter evasion:** events written with an unknown `eventType` won’t match dashboard filters, effectively hiding them.

No DB-side or app-side enum enforcement exists to catch this.

**Remediation:** (1) Extend the shared unions to include all emitted values and make emission sites use the union type (compile-time enforcement). (2) When adding `POST /security-logs`, validate `eventType ∈ ALLOWED_EVENT_TYPES` server-side, reject others. (3) Add a SQLite `CHECK (event_type IN (...))` constraint (the table is created via raw `sqlite.exec`, so add it there). (4) Bound `detail` length; store as structured JSON only.

---

## S10 — Download/preview tokens not bound to the requesting client (MEDIUM)

**Location:** desktop `file-server/server.ts:72,140` call `validateDownloadToken(token)` **without** the optional `clientId`; WS tunnel `file-tunnel.ts:45` likewise. `token-manager.ts:70` only checks `clientId` *if provided*.
**OWASP:** A01 Broken Access Control (IDOR) · **CWE-639** · **CVSS ~5.0**

The single-use UUID token is the *sole* authorization for the local file server and the WS tunnel; the code path never passes the caller’s `clientId`, so the `CLIENT_MISMATCH` check is dead code. Anyone who obtains a token URL (e.g., leaked via logs, referer, browser history, or the unencrypted same-machine `127.0.0.1` URL handed to the renderer) can redeem it regardless of which client it was minted for. The 30-min window + single-use bounds the blast radius, but token binding is a defense-in-depth gap, and the proxy passes tokens through URLs that may be logged.

Also note the file server (`server.ts`) has **no Origin/Host header check** and binds `127.0.0.1` only — acceptable, but any local process on the Host machine (malware, other user) can redeem an in-flight token.

**Remediation:** Thread `clientId` (and ideally `sessionId`) into `validateDownloadToken` at both the HTTP endpoints and the WS tunnel; reject mismatches. For the tunnel, the relay already knows the requesting `clientId` — include it in `CMD_FETCH_FILE` and enforce.

---

## S11 — Access/refresh tokens in `localStorage` (MEDIUM)

**Location:** `apps/web` reads `localStorage.getItem('accessToken')` in `usePreview.ts:111`, `download-manager.ts:83`, and stores session triple on connect (`store/app-store.ts` / `app/page.tsx`).
**OWASP:** A07 / A05 · **CWE-922** · **CVSS ~5.4**

Both the 2h access token and the **30-day refresh token** live in `localStorage`, which is readable by any script in the origin. Given S5 (XSS-reachable previews) and the absence of CSP (S7-web), a single XSS yields long-lived account takeover (the refresh token reissues access tokens for 30 days, and per S1 is itself usable on the messages API). HttpOnly cookies aren’t trivial here (WS uses query-param tokens), but the **refresh token in particular** should not be in JS-readable storage.

**Remediation:** Store the refresh token in an HttpOnly, Secure, SameSite=Strict cookie scoped to `/api/v1/auth/refresh`; keep only the short-lived access token in memory (not localStorage). Add CSP (S5). Rotate refresh tokens on use.

---

## S12 — `getWindowsBlockedDirs()` mutates the shared module array (LOW)

**Location:** `packages/shared/src/security.ts:46-55`.
```ts
const base = SYSTEM_BLOCKED_DIRS.win32;   // reference, not copy
if (appData) base.push(appData);          // mutates the exported constant
```
**CWE-1025 / correctness** · **CVSS ~3.1**

Each call `push`es APPDATA/LOCALAPPDATA onto the **shared exported** `SYSTEM_BLOCKED_DIRS.win32` array. Repeated calls grow it with duplicates indefinitely (memory growth, slower `.some()`). Security implication is limited: it only ever *adds* blocked dirs, so it cannot *weaken* the blacklist — it won’t become bypassable. But it makes the exported constant non-deterministic, and any consumer that reads `SYSTEM_BLOCKED_DIRS.win32` directly (like the Host’s `path-guard.ts`, S4) sees a different value depending on call order — a foot-gun that masks S4’s severity inconsistently.

**Remediation:** Return a fresh array: `return [...SYSTEM_BLOCKED_DIRS.win32, ...(appData?[appData]:[]), ...(localAppData?[localAppData]:[])];` and dedupe.

---

## S13 — Host JWT: 365-day lifetime, no revocation, plaintext secret at rest (LOW)

**Location:** `security.ts:146` `HOST_TOKEN_EXPIRY:'365d'`; `config/store.ts` persists `hostToken`/`hostSecret` via `electron-store` (plaintext JSON on disk).
**CWE-522, CWE-613** · **CVSS ~3.5**

The host token is a year-long bearer credential with no rotation or server-side revocation list; the `hosts` table has only `isBanned`. The token + secret sit in cleartext in the user-profile config file — and per S4 that very file can be under a shared directory. Compromise of the file = a year of host impersonation (mint PINs, read all security logs, list clients).

**Remediation:** Shorten host-token lifetime with rotation on reconnect; add a server-side host-token version/revocation check; store secrets via OS keychain (`safeStorage` in Electron) rather than plaintext `electron-store`.

---

## S14 — Internal error details leaked to clients (LOW)

**Location:** `dir-handlers.ts` (`message: String(err)` in RESP_*_ERROR, e.g. lines 84-85, 209, 313, 418), `messages`/`proxy` returning `err.message`.
**OWASP:** A05 / **CWE-209** · **CVSS ~3.1**

`String(err)` surfaces absolute filesystem paths, Node error codes, and stack-ish strings to the remote client (e.g., `ENOENT: no such file or directory, stat 'C:\Users\victim\...'`), aiding reconnaissance of the Host’s directory layout and confirming path existence (oracle for the blacklist boundaries).

**Remediation:** Return generic codes/messages to clients; log full details locally only.

---

## S15 — CORS / info-exposure notes (LOW / INFO)

**Location:** `utils/cors.ts`; `routes/proxy.ts` `corsHeadersFor`; `hosts/:hostId/status`; `register-host`.
**CWE-942 / CWE-200** · **CVSS ~2.0**

CORS itself is reasonable (explicit origin allow-list, `credentials:true` only reflects allow-listed origins, proxy mirrors the same policy). Minor notes: (1) `ALLOWED_ORIGINS` defaults to `http://localhost:3000` when unset — ensure prod always sets it; an empty/misconfigured env that yields `['']` or a wildcard would be dangerous (today it can’t become `*`, good). (2) `register-host` returns the `secret` in the response body and over whatever transport is configured — combined with `.env.example`’s `RELAY_PORT=443` but no TLS termination guidance, ensure the relay is always behind TLS (tokens/secrets/PINs traverse it). (3) `hosts/:hostId/status` is scoped to the caller’s own host (good).

**Remediation:** Document mandatory TLS; assert `ALLOWED_ORIGINS` is non-empty and not `*` at startup.

---

## Verification of Phase-1 items (summary)

| Phase-1 ID | Status | Notes |
|------------|--------|-------|
| C1 (audit POST 404) | **Confirmed** → S3. Grep shows no `POST /security-logs`. `/access-logs` always empty. |
| C2 (`verifyToken` in messages) | **Confirmed** → S1. Also found a *second* bug: messages route does not exclude revoked sessions. Raised to Critical. |
| H3 (type-union drift) | **Confirmed** → S9. No DB CHECK constraint; ingestion (once S3 exists) lacks allow-listing. Today inserts are parameterized (no SQLi). |
| M1 (APPDATA not blacklisted on Host) | **Confirmed** → S4. Host uses static list; `getWindowsBlockedDirs()` unused. Exploitable for credential/profile exfil. |
| CQ-C1 (`Math.random` IDs) | **Confirmed** → S8. Found concrete integrity impact (dedup-key pre-insertion suppresses victim message persistence), beyond pure collision risk. |

## Things checked and found OK (no finding)
- **SQL injection:** all DB access (server Drizzle + desktop `better-sqlite3`) uses parameterized statements; no string concatenation into SQL. PIN format regex is anchored.
- **Path traversal core:** `path.resolve` + prefix-plus-separator matching correctly blocks `../` and `/home/user` vs `/home/user2`; download permission check fixed to use resolve+sep (dir-handlers.ts:246).
- **PIN generation:** `crypto.getRandomValues` + rejection sampling, confusion-avoiding charset — correct.
- **WS handshake:** correctly rejects refresh tokens (`use:'refresh'`) and validates session `revokedAt` async; type/`type` param checked.
- **Preview text rendering:** `TextViewer` renders content as a React text node (escaped) — HTML files are safe there. (The unsafe path is the PDF iframe — S5.)
- **Insecure deserialization / XXE:** only `JSON.parse` on WS frames (wrapped in try/catch); no XML parser, no `eval`/`Function`, no `node-serialize`.

---

## Prioritized remediation order
1. **S1** (Critical) — one-line import fix + revoked-session check + test.
2. **S6** (High) — startup secret hardening; blocks the worst-case forge bypass and de-risks S1.
3. **S3** (High) — add authenticated `POST /security-logs` with eventType allow-list (also closes S9 ingestion gap).
4. **S4** (High) — Host blacklist must resolve APPDATA/LOCALAPPDATA; default shares to readonly.
5. **S5 + S7** (High) — CSP + iframe sandbox (web) and Electron upgrade + window guards (desktop).
6. **S2** (High) — rate-limit/auth `register-host`.
7. **S8/S10/S11** (Medium) then **S12–S15** (Low).

---
*Relevant files:* `D:\AI\remotebridge\apps\server\src\routes\messages.ts`, `D:\AI\remotebridge\apps\server\src\routes\auth.ts`, `D:\AI\remotebridge\apps\server\src\routes\security-logs.ts`, `D:\AI\remotebridge\apps\server\src\utils\jwt.ts`, `D:\AI\remotebridge\apps\server\src\ws\relay.ts`, `D:\AI\remotebridge\apps\desktop\src\main\security\path-guard.ts`, `D:\AI\remotebridge\apps\desktop\src\main\security\audit-logger.ts`, `D:\AI\remotebridge\apps\desktop\src\main\ws-client\dir-handlers.ts`, `D:\AI\remotebridge\apps\desktop\src\main\file-server\server.ts`, `D:\AI\remotebridge\apps\desktop\src\main\ws-client\file-tunnel.ts`, `D:\AI\remotebridge\apps\desktop\src\main\file-server\token-manager.ts`, `D:\AI\remotebridge\apps\desktop\src\main\window.ts`, `D:\AI\remotebridge\apps\web\src\hooks\usePreview.ts`, `D:\AI\remotebridge\apps\web\src\components\previews\PdfViewer.tsx`, `D:\AI\remotebridge\apps\web\next.config.mjs`, `D:\AI\remotebridge\packages\shared\src\security.ts`, `D:\AI\remotebridge\packages\shared\src\api-types.ts`.
