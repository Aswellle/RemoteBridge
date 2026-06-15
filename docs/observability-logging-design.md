# Structured Logging Design (P1-1 planning pass)

> Status: **planning** — no code changed yet. Scopes the P1-1 finding from
> `.full-review/05-final-report.md` ("`console.log/error/warn` scattered across ~40+
> production paths instead of structured logging (pino/electron-log); includes a leftover
> debug `console.log` in `relay.ts::notifyAndDisconnectClient` and an emoji-prefixed
> pre-`app`-exists log in `db/client.ts`"). Companion to
> `docs/file-tunnel-binary-framing-design.md` (P1-12) and `docs/test-and-doc-gaps-plan.md`
> (#19) — the three Phase-C items from the 2026-06-15 remediation review tracked in
> `CHANGELOG.md`'s "Known issues / not yet fixed".

## Goals / non-goals

Goals:
- Replace all 61 `console.*` call sites across `apps/server` (15), `apps/desktop` (35),
  `apps/web` (11) with leveled, structured calls.
- Establish one logger per app with a consistent debug/info/warn/error convention.
- Fix the two correctness issues the report calls out by name: the leftover debug
  `console.log`s in `ws/relay.ts::notifyAndDisconnectClient`, and the emoji-prefixed
  pre-`app`-exists logs in `db/client.ts`.

Non-goals (separate efforts):
- Metrics/tracing/log shipping/alerting. `docs/runbook.md` §1.2 already flags this as the
  downstream gap once P1-1 lands ("目前仅有 console.log/console.error，没有结构化日志或指标导出"),
  but it's its own project requiring a metrics-backend decision.
- `apps/web` beyond a thin wrapper — browser console output is normal for a client SPA;
  the 11 sites here are almost all `catch` blocks and are the lowest priority.

## apps/server (15 sites)

Fastify already creates a pino instance (`Fastify({ logger: { level: 'info' } })` in
`index.ts:25-29`), exposed as `app.log` inside route/plugin/`setupWebSocket(app)`
closures, and as `request.log` inside route handlers. The 15 stray `console.*` calls are
all in modules/contexts that don't have either: `ws/relay.ts`, `db/client.ts` (runs before
`app` exists), `routes/proxy.ts` (has `request.log` available but doesn't use it),
`ws/handler.ts` (one call inside a helper that only receives `app` separately),
`routes/auth.ts`.

**Plan**: add `apps/server/src/utils/logger.ts` exporting a standalone `pino()` instance,
level from `process.env.LOG_LEVEL ?? 'info'`. Update `index.ts` to read the same env var
for its Fastify `logger.level` so both stay in sync without needing to thread a single
instance through Fastify's logger-injection API (an optional future refinement once the
basic migration lands).

| File:Line | Current | Proposed | Note |
|---|---|---|---|
| `db/client.ts:26` | `console.log('📦 初始化数据库...')` | `logger.info('初始化数据库...')` | drop emoji |
| `db/client.ts:78` | `console.log('✅ 数据库初始化完成')` | `logger.info('数据库初始化完成')` | drop emoji |
| `db/client.ts:99` | `console.log('🧹 数据保留清理: security_logs N 条, messages M 条')` | `logger.info({securityLogs, messages}, '数据保留清理完成')` | structured fields |
| `db/client.ts:102` | `console.error('数据保留清理失败:', err)` | `logger.error({err}, '数据保留清理失败')` | |
| `db/client.ts:147` | `console.error('数据库健康检查失败:', err)` | `logger.error({err}, '数据库健康检查失败')` | |
| `ws/handler.ts:307` | `console.error('持久化消息失败:', err)` | `logger.error({err}, '持久化消息失败')` | inside `handleMessage`, no `app`/`request` in scope |
| `ws/relay.ts:143` | `console.error('notifyAndDisconnectClient: client X not in rooms')` | `logger.error({clientId}, 'notifyAndDisconnectClient: client not in rooms')` | |
| `ws/relay.ts:144` | `console.error('...client X not OPEN (state=...)')` | `logger.error({clientId, readyState}, '...')` | |
| `ws/relay.ts:147` | `console.log('...sent ${type} to ${clientId}, scheduling close')` | `logger.debug({clientId, type}, '...')` | **the leftover debug log the report names** |
| `ws/relay.ts:152` | `console.log('...close(${code}) sent to ${clientId}')` | `logger.debug({clientId, code}, '...')` | same |
| `ws/relay.ts:154` | `console.error('...close failed:', err)` | `logger.error({err, clientId}, '...')` | |
| `routes/proxy.ts:109` | `console.error('文件隧道传输失败: ${err.message}')` | `request.log.error({err}, '文件隧道传输失败')` | request-scoped logger already in handler |
| `routes/proxy.ts:280` | `console.error('代理下载失败: ${err.message}')` | `request.log.error({err}, '代理下载失败')` | |
| `routes/proxy.ts:378` | `console.error('代理预览失败: ${err.message}')` | `request.log.error({err}, '代理预览失败')` | |
| `routes/auth.ts:421` | `console.warn('revoke: client ... not connected, WS notify/disconnect skipped...')` | `request.log.warn({clientId, sessionId}, '...')` | verify a request/app logger is in scope at this call site |

## apps/desktop (35 sites)

No logging library currently. Recommend **`electron-log`** (v5): near drop-in for
`console.*` (`log.info/warn/error/debug`), writes to a rotating file under the OS user-data
dir *and* echoes to console by default, with a `main`-process entry point — all 35 sites
are in `src/main/`. Add as a dependency; create `apps/desktop/src/main/logger.ts`
re-exporting a configured instance (`log.transports.file.level` from a setting, default
`'info'`).

| File | Lines | Proposed level | Note |
|---|---|---|---|
| `index.ts` | 43, 63 | `info` | startup / auto-connect success |
| `index.ts` | 49 | `info` | expired-token cleanup count |
| `index.ts` | 51, 68, 128, 155 | `error` | |
| `index.ts` | 65 | `warn` | auto-connect failed (non-fatal) |
| `electron-binding.ts:39` | | `warn` | better-sqlite3 binding fallback |
| `file-server/server.ts:204` | | `info` | local file server startup |
| `ipc/messages.ts:45, 58` | | `error` | |
| `ipc/auth.ts:33` | | `info` | recovery-delay notice |
| `ipc/auth.ts:41` | | `error` | |
| `ws-client/client.ts:53, 73` | | `info` | connect / close |
| `ws-client/client.ts:68, 92` | | `error` | parse error / WS error |
| `ws-client/client.ts:143` | | `debug` | reconnect backoff trace |
| `ws-client/client.ts:164` | | `warn` | send-while-not-ready |
| `ws-client/dir-handlers.ts:82, 206, 313, 416` | | `error` | |
| `ws-client/file-tunnel.ts:127` | | `error` | |
| `ws-client/handlers.ts:13, 38, 44, 68, 77` | | `debug` | per-message trace (CLIENT_JOINED/LEFT, MSG_TEXT, system, revoked) |
| `ws-client/handlers.ts:21, 59` | | `error` | |
| `security/audit-logger.ts:25` | | `error` | local DB write failure |
| `security/audit-logger.ts:45, 70` | | `warn` | relay POST failure (fire-and-forget, non-fatal) |

## apps/web (11 sites — lower priority)

Recommend a thin `src/lib/logger.ts`: `debug`/`info` are no-ops when
`process.env.NODE_ENV === 'production'`, `warn`/`error` always pass through to `console`.
Mechanical replacement of all 11 sites: `store/app-store.ts:315,472` (error),
`hooks/useWebSocket.ts:63,95,116` (error), `useWebSocket.ts:51,68` (info — connect/close),
`useWebSocket.ts:217` (debug — reconnect backoff), `components/previews/FilePreview.tsx:56`
(error), `app/dashboard/messages/page.tsx:36` (error),
`app/dashboard/security/page.tsx:72` (error).

## Sequencing

1. **Server** (15 sites, zero new deps) — smallest, infra (`app.log`/pino) already present.
2. **Desktop** (35 sites, +`electron-log` dep) — largest count but mechanical; the API
   mirrors `console.*` closely.
3. **Web** (11 sites, optional) — can be deferred indefinitely without affecting P1-1's
   main thrust (server/desktop production observability).

## Open questions for whoever picks this up

- Should desktop's log level be wired into `electron-store` settings (renderer-configurable
  via the existing settings-hot-reload mechanism, see `manual-settings-hot-reload.mjs`), or
  env-var only like the server?
- Confirm `electron-log`'s file output is understood as *operational* logging, distinct in
  purpose from the `access_logs`/`local_messages`/security-log SQLite tables (user-facing
  audit data) — no overlap intended, just flagging so nobody tries to unify them.
