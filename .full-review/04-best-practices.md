# Phase 4: Best Practices & Standards

Full detail: `04a-best-practices.md` (18 findings, B1-B18) and `04b-cicd-devops.md` (10 findings, DC1-DC10). This file consolidates the Critical/High findings and summarizes the rest.

## Framework & Language Findings (04a)

**Headline**: The codebase is functionally solid (Phases 1-3 already covered correctness and security in depth), but exhibits an **"every layer reinvents its own helpers"** pattern: three non-cryptographic `Math.random()` ID generators, four divergent copies of file-category/extension-list logic, two divergent `EVENT_TYPE_LABELS`/`COLORS` maps, an unused `@fastify/rate-limit` dependency shadowed by hand-rolled rate limiting, an unused `zustand` dependency in `apps/desktop`, and `apps/web` being 98% Client Components despite using the App Router.

### Critical

**B1 — Third confirmed `Math.random()` ID generator completes the Phase-1 C1 trio**
`apps/web/src/hooks/useWebSocket.ts:248-251`'s `WebSocketManager.generateId()` is a third independent copy of the non-cryptographic `Math.random().toString(36)` pattern (alongside `apps/server/src/ws/relay.ts:168-170` and `apps/desktop/src/main/ws-client/client.ts:232-235`), used for WS message IDs that feed the server's message-persistence dedup key. Notably, **`apps/web`'s own `app-store.ts` and `usePreview.ts` already use `crypto.randomUUID()`** elsewhere — `useWebSocket.ts` is the one inconsistent file.
**Fix**: replace all three with `crypto.randomUUID()` (web) / `nanoid()` (server, desktop — already a dependency in both via `ws/rooms.ts` and `token-manager.ts`). Trivial migration — IDs are opaque strings in `WSMessage.id`/`messageId`, no protocol shape change.

**B2 — Four divergent copies of file-category/extension-list logic**
Beyond the desktop `dir-handlers.ts` copy flagged in Phase 1, this phase found **two more independent copies** in `apps/web`: `components/FileList.tsx:15-38` (`getFileLucideIcon` + inline ext lists, includes `tiff`/`bmp`/`ico` not in shared) and `components/previews/FilePreview.tsx:144-158` (a "本地兜底"/local-fallback `getFileCategory` with yet another ext list including `ps1`/`bat`/`dockerfile`/`makefile`). Total: `packages/shared/file-utils.ts` (incomplete baseline) + 3 divergent copies. A file extension can be classified as previewable by the desktop Host using one list, then re-classified differently by `FilePreview.tsx`'s fallback when the server's `category` comes back `'unknown'` — inconsistent UI behavior for the same file type.
**Fix**: expand `packages/shared/file-utils.ts::PREVIEWABLE_TYPES` to the union of all four lists; delete the 3 local copies and import from `@remotebridge/shared` (both consumers already depend on it). Keep `FileList.tsx`'s icon-selection map but key it off `getFileCategory()`'s output rather than re-deriving classification.

### High

| ID | Title | Location |
|----|-------|----------|
| B3 | `apps/web` is 18/20 source files `'use client'` (98%) — likely intentional given the WS-driven SPA architecture (no server-fetchable data), but undocumented as a deliberate choice rather than oversight. Two minor concrete opportunities exist in `dashboard/layout.tsx`'s static nav chrome, but full RSC adoption isn't a fit here. | `apps/web/src/app/**`, `components/**` |
| B4 | `@fastify/rate-limit ^9.1.0` is a declared but **never-registered** dependency; `routes/auth.ts` hand-rolls an in-memory `Map`-based rate limiter (with manual `setInterval`/`unref()` cleanup) for `/auth/generate-pin` and `/auth/connect` — exactly what the unused plugin provides out of the box, including Redis-backed stores relevant if ADR-005's single-instance trade-off is ever revisited. | `apps/server/src/routes/auth.ts`, `package.json` |
| B5 | `zustand ^4.5.0` is declared in `apps/desktop/package.json` but **zero usage** confirmed via grep — every renderer page uses plain `useState`/`useEffect`. `App.tsx` alone has 13 separate `useState` calls with prop-drilling and duplicated 10s polling across `App.tsx`/`Clients.tsx`/`Messages.tsx`. Either remove the dependency, or (better, given `apps/web`'s working `app-store.ts` precedent) migrate shared desktop renderer state into a Zustand store. | `apps/desktop/src/renderer/**`, `package.json` |
| B6 | Two independent `EVENT_TYPE_LABELS`/`EVENT_TYPE_COLORS` maps (`apps/desktop/.../SecurityLogs.tsx:26-41` vs `apps/web/.../security/page.tsx:29-44`) for the same 5 `SecurityLog['eventType']` values, with **different color values** for `REVOKE`/`PIN_EXPIRED` (likely copy-paste drift) and neither constrained by `satisfies Record<SecurityLog['eventType'], string>` — a new eventType added to the shared union wouldn't trigger a compile error in either map. | `apps/desktop/.../SecurityLogs.tsx`, `apps/web/.../security/page.tsx`, `packages/shared/src/api-types.ts` |

### Medium / Low — summary

- **Medium**: `JWT_CONFIG` not `as const` forces an `as any` cast in `jwt.ts` (B7, extends Phase-1 M1); CJS `require()` calls inside otherwise-ESM desktop files — `handlers.ts`'s nanoid require is explainable by the v3 CJS pin, but `ipc/messages.ts`'s `require('@remotebridge/shared')` looks like it could be a static import (B8); `console.*` vs `fastify.log.*` inconsistency including a leftover debug `console.log` in `notifyAndDisconnectClient` (B9, extends Phase-1 H1); `turbo.json`'s `dev` task lacks `dependsOn: ["^build"]` so a fresh `pnpm dev` fails to resolve `@remotebridge/shared` until the documented manual build step runs (B10); turbo 1.x `"pipeline"` key will need migration to 2.x `"tasks"` on next major bump — use `@turbo/codemod migrate` (B11); dynamic `await import()` in `routes/auth.ts`/`routes/hosts.ts` signals an underlying circular-dependency that should be resolved at the architecture level — the `@remotebridge/shared` dynamic import specifically looks unnecessary and could be static today (B12).
- **Low**: dead `'use client'` directives (a Next.js RSC concept with zero effect) copy-pasted into 4 Electron renderer files (B13); hand-rolled SVG icons in desktop `App.tsx` despite `lucide-react` already being a dependency and used for the equivalent icon set in `apps/web` (B14); `getRoomInfo()`'s `hostName` permanently `''` behind an unfinished TODO (B15, cross-refs Phase-1 L1); `<img>` vs `next/image` in `ImageViewer.tsx` is **correct as-is** (blob URLs + custom pan/zoom need direct DOM access) — just needs a comment explaining why, for future codemods (B16); no `engines` field anywhere despite the project's documented native-module ABI sensitivity (better-sqlite3/Electron) — low-cost addition (B17); `drizzle-kit` + `db:generate`/`db:migrate` scripts are dead weight given raw-SQL is the actual source of truth (B18, extends Phase-1 M2/M10) — keep `drizzle-orm` (used), reconsider `drizzle-kit`.

**Total**: 18 findings (2 Critical, 4 High, 6 Medium, 6 Low).

---

## CI/CD & DevOps Findings (04b)

**Headline**: There is **no CI/CD pipeline of any kind** (no `.github/` or any other CI config), **no containerization** (no Dockerfile/docker-compose despite `apps/web`'s `next.config.mjs` setting `output: 'standalone'` — a containerization-oriented setting that's configured but unused, the same "wired-but-unused" pattern as C1/S3), and **no process supervision** for the production relay. The entire operational story is "run a bash script in a terminal." Given the relay is meant to be internet-exposed and TLS-fronted while handling auth secrets for many hosts/clients, this is **the single biggest gap surfaced across all four review phases**.

### Critical

**DC1 — No CI pipeline exists at all**
Exhaustive search for any CI vendor config (`.github/`, `.gitlab-ci*`, `Jenkinsfile`, etc.) returns zero matches. Every commit — including changes to `packages/shared`, the protocol contract consumed by both server and desktop — can merge without a build, lint, or test running. Combined with T9 (Phase 3, vitest needs a manually-started relay on `:3099`), even a naive `pnpm test` CI step would fail today without a `globalSetup`/test-relay bootstrap. Detection of breakage currently happens **in production**, when `scripts/deploy-server.sh` is run.
**Fix**: minimal GitHub Actions workflow running `pnpm install --frozen-lockfile` → `pnpm --filter @remotebridge/shared build` → `pnpm build` → `pnpm --filter @remotebridge/web lint` → typecheck. Even a build+lint-only workflow (no tests) is a massive improvement over zero.

**DC2 — No process supervision for the production relay**
`scripts/deploy-server.sh` ends with a bare foreground `node dist/index.js` — no systemd unit, no pm2, no restart-on-crash, no restart-on-reboot. ADR-005's "restart self-heals via reconnect" reasoning only holds if restarts are automatic; with a bare `node` invocation, a single unhandled rejection, `better-sqlite3` lock error, or OOM (cf. C2's unbounded table growth) means an **indefinite outage** until a human notices and manually re-runs the script.
**Fix**: wrap with systemd (`Restart=on-failure`) or pm2 (`pm2 start dist/index.js --name remotebridge-relay`), enable restart-on-reboot, and document basic operational commands.

**DC3 — No containerization/IaC; deploy story is mismatched with the security model's TLS assumptions**
No Dockerfile/docker-compose/Terraform anywhere. `.env.example` sets `RELAY_PORT=443` with `RELAY_HOST=0.0.0.0` and **no mention of a reverse proxy, TLS termination, or certs** — Fastify's `app.listen()` is plain HTTP. An operator following the documented config literally would bind to port 443 (requiring root/CAP_NET_BIND_SERVICE, also undocumented) with **cleartext PINs/JWTs/file contents** traversing the relay, and browsers would refuse a `wss://`→`ws://` connection from an HTTPS-served web client (mixed content) — the documented deploy story doesn't actually function end-to-end without an operator improvising TLS. Directly mirrors Phase 2's S15 ("PINs/tokens/secrets traverse the relay and need TLS") with no tooling path to satisfy it.
**Fix**: provide a reference `Dockerfile` (multi-stage, non-root) for the relay plus a `docker-compose.yml` including a TLS-terminating reverse proxy (Caddy — automatic Let's Encrypt); either wire up `apps/web`'s `output: 'standalone'` into the same compose or remove the unused setting.

### High

| ID | Title | Operational risk |
|----|-------|-------------------|
| DC4 | No metrics/tracing/log-aggregation. `/health` and `/api/v1/status` are unconditional liveness pings — don't check DB writability, room-map sanity, or table sizes (C1/C2's unbounded growth would go undetected). Pino logs to stdout only, no rotation/shipping. No `/metrics` endpoint, no APM. | "Boil the frog" degradation — first signal is "the relay feels slow" or an OOM crash reported by users, by which point the DB may be gigabytes and need manual `DELETE`+`VACUUM` with the service stopped. |
| DC5 | No incident-response runbook. `使用说明书.md` §8 covers only client-side/local-dev issues. Nothing documents: relay-crash recovery (ties to DC2's missing supervisor), detecting/mitigating S2's unauthenticated `register-host` DoS, rollback procedure (no versioning/tagging), or what "self-healing restart" (ADR-005) requires operationally (drain first? data-loss risk to in-flight file-tunnel transfers?). | On-call person reverse-engineers fixes in real time with no playbook — a hard blocker for any multi-maintainer handoff. |
| DC6 | Electron desktop has no auto-update mechanism or code-signing/distribution pipeline. `electron-builder.config.ts` defines win/mac/linux targets but no `publish` config (no `electron-updater`), no signing/notarization. Every bug fix or protocol change (cf. D4's versioning gaps) requires manual reinstall by every end user, with unsigned builds triggering SmartScreen/Gatekeeper warnings. | Users on stale protocol versions could silently fail to interoperate after a breaking protocol change; unsigned-binary warnings train users to click through security prompts. |

### Medium / Low — summary

- **Medium**: `.env.example` lacks JWT-secret-strength guidance (compounds D2) **and** is missing `RB_DATA_DIR` entirely (only lists the runtime-unused `DATABASE_URL`) **and** ships `RELAY_PORT=443` with no TLS path (compounds DC3) **and** includes a placeholder-that-looks-real `ALLOWED_ORIGINS=...,https://your-domain.com` (DC7); no `NODE_ENV` gating anywhere — CORS falls back to `localhost:3000` in prod if `ALLOWED_ORIGINS` unset, `apps/web`'s `NEXT_PUBLIC_*` build-time vars silently bake in `localhost` if unset at build time, and there's no single "production readiness" check that would have caught S2/S6/DC7 together at deploy time (DC8).
- **Low**: no dependency-audit/SAST anywhere (no `pnpm audit`, no Dependabot/Renovate, no Semgrep/CodeQL) — a relay handling auth tokens via `jsonwebtoken`/`bcryptjs`/`better-sqlite3`/`ws`/`fastify` has no automated CVE signal (DC9); no version/release discipline — all 4 packages frozen at `1.0.0` (compounds D4), no `engines`/`.nvmrc` despite `使用说明书.md`'s informal "tested on v22.14.0" note, `/health` reports a hardcoded `'1.0.0'` so an operator can't distinguish today's deploy from one 3 months ago during incident triage (DC10).

**Total**: 10 findings (3 Critical, 3 High, 2 Medium, 2 Low).
