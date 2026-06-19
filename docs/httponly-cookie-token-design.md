# httpOnly Cookie Token Design (02a-S11)

**Status: Design — pending implementation**
**Tracks:** 02a-S11 (access/refresh tokens in localStorage vulnerable to XSS)

---

## Problem

Web client currently stores `accessToken` and `refreshToken` in `localStorage`
(`apps/web/src/store/app-store.ts::loadPersistedSession`).  Any XSS payload
executing in the page can exfiltrate both tokens, hijack the session, and
download arbitrary files via the proxy tunnel — persisting past tab close.

`clientId` is also in `localStorage`, but it is a non-secret device identifier
(intentionally persistent and client-generated); it does not need to move.

---

## Goal

Move `accessToken` and `refreshToken` out of JS-accessible storage into
`httpOnly; SameSite=Strict` cookies so they are invisible to XSS payloads and
cannot be exfiltrated via `document.cookie`.

---

## Core challenge: WebSocket authentication

The Electron desktop and the relay server are on different ports in development
(`ws://127.0.0.1:3002` vs `http://localhost:3000`).  In production both are
served behind the same Caddy domain, so cookies are same-site.

The WS upgrade request is issued by the browser's networking layer — it **does**
include cookies when connecting to the same site, but in cross-origin dev mode
the WS upgrade does not carry cookies.

The current auth scheme uses `?token=<accessToken>` in the WS URL.  Moving to
cookies requires an alternative WS authentication mechanism.

---

## Proposed Architecture: Short-lived WS Ticket

```
Client                     Relay                          Host
  │                           │                             │
  │  POST /auth/connect        │                             │
  │  (PIN + clientId)          │                             │
  │ ─────────────────────────► │                             │
  │  Set-Cookie: access=...    │                             │
  │  Set-Cookie: refresh=...   │                             │
  │  body: { sessionId,        │                             │
  │          hostInfo }        │                             │
  │ ◄───────────────────────── │                             │
  │                            │                             │
  │  GET /auth/ws-ticket       │                             │
  │  (Cookie: access=...)      │                             │
  │ ─────────────────────────► │                             │
  │  body: { ticket: "abc123" }│  ticket stored in mem 30s  │
  │ ◄───────────────────────── │                             │
  │                            │                             │
  │  WS connect ?ticket=abc123 │                             │
  │ ─────────────────────────► │                             │
  │  validates ticket → delete │                             │
  │  upgrade accepted          │                             │
  │ ◄───────────────────────── │                             │
```

### Why tickets instead of cookies-on-WS

| Approach | Pro | Con |
|----------|-----|-----|
| Cookie on WS (same-site only) | Zero JS access | Breaks cross-origin dev; WS server must parse Cookie header |
| Short WS ticket via REST | Works cross-origin; JS never sees token; ticket is 30s one-time | One extra round-trip per WS connect |
| Keep `?token=` in URL | Simple | Token logged in server access logs and browser history |

Tickets are the right trade-off: one cheap REST call, the `accessToken` never
appears in a URL, and the scheme works in both dev and production.

---

## Server-side changes

### `apps/server/src/routes/auth.ts`

**`POST /auth/connect`** — return tokens as `httpOnly` cookies instead of body:
```
Set-Cookie: rb_access=<jwt>; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200
Set-Cookie: rb_refresh=<jwt>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000
```
Body still returns `{ sessionId, hostInfo }` (non-secret, needed by the client).

**`POST /auth/refresh`** — read `rb_refresh` from cookie (not body); set new
`rb_access` cookie; rotate `rb_refresh` cookie.

**`DELETE /auth/revoke/:sessionId`** — also clears `rb_access`/`rb_refresh`
cookies on the response.

**`GET /auth/ws-ticket`** (new endpoint) — authenticated via `rb_access` cookie
(falls back to `Authorization: Bearer` for desktop WS and server-side test
compat).  Issues a 30-second, single-use ticket (`nanoid(32)`) stored in an
in-memory `Map<ticket, { clientId, sessionId, expiresAt }>`.  Rate-limited
(20/min/IP).

### `apps/server/src/ws/handler.ts`

WS handshake now accepts **either**:
1. `?ticket=<ticket>` — lookup + delete from ticket map; reject if expired/unknown
2. `?token=<accessToken>` — legacy path kept for desktop Host (Host uses JWT
   directly; it has no browser cookie store)

Client-type (`host` vs `client`) is still inferred from the `type` query param.

### `apps/server/src/ws/tickets.ts` (new)

```typescript
interface WsTicket { clientId: string; sessionId: string; hostId: string; expiresAt: number; }
const tickets = new Map<string, WsTicket>();

export function issueTicket(clientId, sessionId, hostId): string { ... }
export function redeemTicket(ticket): WsTicket | null { ... }  // deletes on hit
export function startTicketCleaner(): void { ... }              // 60s interval
```

### `apps/server/src/utils/cors.ts`

Add `credentials: true` to the cors plugin options.  `ALLOWED_ORIGINS` **must
not** be `*` when credentials are enabled (the `validateJwtSecrets()` startup
warning already enforces this in production).

---

## Client-side changes

### `apps/web/src/store/app-store.ts`

- Remove `localStorage.setItem('accessToken', ...)` / `getItem('accessToken')`
  and the same for `refreshToken`.
- `sessionId` and `hostInfo` remain in `sessionStorage` (non-secret,
  session-scoped, cleared on tab close).
- Token presence is inferred from a `isAuthenticated` flag (set by
  `/auth/connect` response; cleared on revoke/logout).

### `apps/web/src/lib/api.ts`

Add `withCredentials: true` to the Axios instance so cookies are sent
automatically on every REST request.

### `apps/web/src/hooks/useWebSocket.ts`

Before connecting:
1. Call `GET /api/v1/auth/ws-ticket` (cookie auth, `withCredentials: true`)
2. Open `WS_URL + '?ticket=' + ticket + '&type=client'`

On 401 from `/auth/ws-ticket`:
- Try `POST /auth/refresh` (cookie → cookie rotation)
- If refresh fails → call `terminateSession()`

### `apps/web/src/lib/api.ts` (refresh interceptor)

The existing Axios 401 interceptor already calls `refreshAccessToken()`.
Change `refreshAccessToken()` to call `POST /auth/refresh` with
`withCredentials: true` instead of sending the refresh token in the body.

---

## Token lifecycle

```
connect   → rb_access (2h httpOnly) + rb_refresh (30d httpOnly) set by server
ws-ticket → short 30s one-time ticket issued from rb_access
on 401    → POST /auth/refresh (rb_refresh cookie) → new rb_access cookie
revoke    → server clears both cookies + closes WS
tab close → sessionStorage (sessionId, hostInfo) cleared; cookies survive
browser close → cookies survive; re-open picks up rb_access and goes directly
                to ws-ticket without re-entering PIN
```

---

## Migration path (backward compat)

1. Deploy new server (cookies + tickets supported).
2. Old clients (sending `?token=` for `client` type) continue to work for one
   release cycle — `handler.ts` still accepts `?token=` for both host and
   client types.
3. Next release: remove `?token=` client path; require ticket.

---

## Security properties gained

| Threat | Before | After |
|--------|--------|-------|
| XSS token exfil | Tokens in localStorage, readable | httpOnly cookie, invisible to JS |
| Token in server logs/browser history | `?token=...` in WS URL logged | 30s ticket in URL (low-value, one-time) |
| CSRF | N/A (no cookies) | Mitigated by `SameSite=Strict` |
| Tab-close session survival | localStorage persists | sessionId in sessionStorage cleared; cookie survives (controlled by server) |

---

## Remaining limitation (02a-S11 scope boundary)

`clientId` stays in `localStorage` — it is a non-secret device identifier whose
whole purpose is cross-session persistence.  Moving it to a cookie would break
the "trust this device" model where the user explicitly grants access per device.

---

## Files changed (implementation checklist)

- [ ] `apps/server/src/ws/tickets.ts` — new ticket store + cleaner
- [ ] `apps/server/src/routes/auth.ts` — Set-Cookie on connect/refresh, clear on revoke, new `GET /auth/ws-ticket`
- [ ] `apps/server/src/ws/handler.ts` — accept `?ticket=` for client type
- [ ] `apps/server/src/utils/cors.ts` — add `credentials: true`
- [ ] `apps/web/src/store/app-store.ts` — remove token localStorage
- [ ] `apps/web/src/lib/api.ts` — `withCredentials: true`, refresh uses cookie
- [ ] `apps/web/src/hooks/useWebSocket.ts` — fetch ticket before WS connect
- [ ] `apps/server/test/cookie-auth.test.ts` — new test: connect → ticket → WS
- [ ] `docs/httponly-cookie-token-design.md` — update status to Implemented
