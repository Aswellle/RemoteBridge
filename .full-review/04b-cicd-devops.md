# Step 4B — CI/CD, Deployment, Infrastructure & Operations Review

**Scope**: RemoteBridge monorepo — CI/CD pipelines, deployment strategy, infrastructure-as-code,
monitoring/observability, incident response, and environment management.

**Headline**: There is **no CI/CD pipeline of any kind** in this repository (no `.github/`,
no other CI config of any vendor), **no containerization** (no Dockerfile/docker-compose),
and **no process supervision** for the production relay. The entire operational story is
"run a bash script in a terminal." Given the project's own stated posture — a relay server
meant to be internet-exposed, fronted by TLS, handling auth secrets/PINs/JWTs for potentially
many hosts/clients — this is the single biggest gap of this review phase.

---

## Critical

### DC1 — No CI pipeline exists at all (build/lint/test never run automatically)

**Evidence**: Exhaustive search of the repo root and all subdirectories (excluding
`node_modules`) for `.github/`, `.gitlab-ci*`, `.travis*`, `circleci`, `azure-pipelines*`,
`Jenkinsfile`, `.drone*`, `netlify.toml`, `vercel.json` — **zero matches**. The only
"automation" present is three shell/PowerShell scripts under `scripts/` (`setup.sh`,
`deploy-server.sh`, `dev-desktop.ps1`), all meant for **manual, interactive** execution.

**Operational risk**: Every commit to every branch — including changes to
`packages/shared` (the protocol contract consumed by both server and desktop) — can be
pushed/merged without a single build, lint, or test running. Combined with prior findings:

- T9 (Phase 3): the one vitest suite that exists requires a manually-started relay on
  `:3099` — even if CI were added today, a naive `pnpm test` step would fail in a clean
  runner with no further work (no `globalSetup`/test-relay bootstrap).
- A change that breaks `packages/shared`'s compiled `dist/` (which `apps/server` and
  `apps/desktop` import directly per CLAUDE.md) would not be caught until someone runs
  `pnpm build` locally — or, worse, until `scripts/deploy-server.sh` is run against
  production and `tsc` fails or runtime errors appear post-deploy.
- TypeScript compile errors, ESLint violations (`apps/web` has `next lint`), and the
  existing e2e suite's 17 cases provide **zero** protection against regressions reaching
  `main`/release branches.

**Who notices, how long**: Nobody, until either (a) a developer happens to run the build
locally before deploying, or (b) the production deploy itself fails / breaks at runtime
after `scripts/deploy-server.sh` is executed on the server — i.e., **detection happens in
production**, not before.

**Recommendation**:
- Add a minimal GitHub Actions workflow (or equivalent for whatever git host is used) that
  on every push/PR runs: `pnpm install --frozen-lockfile` → `pnpm --filter @remotebridge/shared build`
  → `pnpm build` (turbo, all packages) → `pnpm --filter @remotebridge/web lint` →
  `pnpm --filter @remotebridge/server typecheck` (add a `tsc --noEmit` script if missing).
- For the vitest e2e suite, add a CI job that starts the relay on `:3099` as a background
  step (`pnpm --filter @remotebridge/server dev &` with a wait-for-port loop, or convert
  `globalSetup` in `vitest.config.ts` to spin up the server in-process) before running
  `pnpm --filter @remotebridge/server test`. This directly closes T9's gap.
- Even a single-job "build + typecheck + lint" workflow with no test execution would be a
  massive improvement over the current zero baseline and should be the first increment.

---

### DC2 — No process supervision for the production relay (`scripts/deploy-server.sh` is a bare foreground `node` process)

**Evidence** (`scripts/deploy-server.sh`, full contents):
```sh
#!/bin/bash
set -e
echo "🚀 部署 RemoteBridge Relay Server..."
echo "🔨 构建服务器..."
pnpm --filter @remotebridge/server build
mkdir -p data
echo "▶️ 启动服务..."
cd apps/server
node dist/index.js
```

This is a **synchronous foreground command**. There is:
- No systemd unit, no pm2 `ecosystem.config.js`, no supervisord config, no `nohup`/`&`
  backgrounding, no `forever`/`nodemon --prod` wrapper — nothing anywhere in the repo
  (`find` for `pm2|systemd|ecosystem.config|.service` returns nothing).
- No restart-on-crash policy. If the Node process throws an unhandled exception/rejection
  that isn't caught by the `process.on('SIGINT'/'SIGTERM')` handlers, or if it's OOM-killed,
  the relay simply **stays down** until a human notices and re-runs the script.
- No restart-on-reboot. If the host VM reboots (kernel update, cloud provider maintenance),
  the relay does not come back up automatically — there's no init system entry.
- The script runs in the foreground of whatever shell invoked it — if that's an SSH
  session and the session drops (network blip, terminal closed), the process dies (unless
  the operator manually wrapped it in `nohup`/`tmux`/`screen`, none of which is documented).

**Cross-reference**: ADR-005 (cited in CLAUDE.md) explicitly accepts single-instance
in-memory room state as a trade-off, reasoning that "restart self-heals via both ends'
unlimited reconnect + host-reconnect room rebuild." That reasoning is sound **only if
restarts are fast and automatic**. With a bare `node` invocation and no supervisor, a crash
is not a "self-healing restart" — it's an **indefinite outage** until manual intervention.

**Operational risk**: A single unhandled promise rejection, an uncaught exception in any
WS handler, a `better-sqlite3` lock error, or an OOM from the unbounded
`security_logs`/`messages` tables (C2 from Phase 2) takes down the entire relay for every
connected Host and Client simultaneously, with **no automatic recovery**. Given that the
Host and Web client both have unlimited-reconnect logic, they will hammer the dead relay
with reconnect attempts indefinitely but never succeed until a human restarts it.

**Who notices, how long**: Only when a user (Host operator or Web client user) notices
their connection is permanently down and reports it, or if the operator happens to be
actively monitoring a terminal. Could be minutes to days depending on usage patterns —
there is no alerting (see DC4/DC5).

**Recommendation**:
- At minimum, wrap the production start command with a process supervisor: a systemd unit
  (`Restart=on-failure`, `RestartSec=2`, `StartLimitBurst`) is the standard choice for a
  bare-metal/VM Linux deployment; pm2 (`pm2 start dist/index.js --name remotebridge-relay
  -i 1`) is a lighter-weight alternative that also gives `pm2 logs`/`pm2 monit` for free.
- Add `pm2 startup`/systemd `enable` so the service restarts on VM reboot.
- Update `scripts/deploy-server.sh` (or add a sibling script) to register/restart the
  supervised service rather than running `node dist/index.js` in the foreground — this is
  a small change with a large reliability payoff.
- Document the supervisor choice and basic operational commands (`systemctl status/restart
  remotebridge-relay` or `pm2 restart remotebridge-relay`) in `使用说明书.md` or a new
  `docs/operations.md`.

---

### DC3 — No containerization / IaC; bare-metal-or-VM deploy story is mismatched with the security model's TLS/internet-exposure assumptions

**Evidence**:
- No `Dockerfile`, `docker-compose.yml`, `.dockerignore`, Terraform/Pulumi/Ansible/Helm
  configs anywhere in the repo.
- `apps/web/next.config.mjs` sets `output: 'standalone'` (a Next.js feature specifically
  designed for containerized/minimal-footprint deployment) — this output mode is configured
  but there's no Dockerfile that actually consumes the `standalone` build artifact. It's an
  unused capability (same "configured but not wired up" pattern flagged in C1/S3 from
  earlier phases).
- `RELAY_HOST` defaults to `0.0.0.0` and `.env.example` sets `RELAY_PORT=443` — i.e., the
  documented production config has the relay listening directly on the internet-facing
  port 443 with **no mention of a reverse proxy, TLS termination, or certificate
  management** anywhere (not in `.env.example`, not in `使用说明书.md`, not in
  `scripts/deploy-server.sh`).
- Fastify's `app.listen()` is called with plain HTTP — there is no `https`/TLS option
  configured in `apps/server/src/index.ts`. For the relay to actually serve `wss://` /
  `https://` (required for `RELAY_PORT=443` to make sense, and required by browsers for a
  Web client served over HTTPS to open a WebSocket to it — mixed-content blocking), either
  Node needs to be handed TLS certs directly, or (far more standard) a reverse proxy
  (nginx/Caddy/Traefik) needs to sit in front — **none of which is documented or scripted**.

**Operational risk**: An operator following `.env.example` + `scripts/deploy-server.sh`
literally would end up running a plain-HTTP/WS Fastify process bound to `0.0.0.0:443`
(which on Linux also requires root/CAP_NET_BIND_SERVICE — another undocumented gotcha) with
**no TLS**, meaning:
- PINs, JWTs (access + refresh), and all file contents transiting the relay (per ADR-004's
  file-tunnel architecture) would be sent **in cleartext** over the internet.
- Browsers would refuse to connect a `wss://` from an `https://`-served Web client to a
  plain `ws://` relay (mixed content), so the deployment likely wouldn't even function
  end-to-end without an operator improvising a reverse-proxy/TLS setup on their own — at
  which point the *documented* deploy story is incomplete/misleading.

This ties directly to Phase 2's security review (referenced as "S15" in the task: "PINs/
tokens/secrets traverse the relay and need TLS") — the deployment tooling provides **no**
path to satisfying that requirement.

**Recommendation**:
- Provide a reference `Dockerfile` for `apps/server` (multi-stage: build with
  `pnpm --filter @remotebridge/shared build && pnpm --filter @remotebridge/server build`,
  runtime stage `node:22-slim` running `node dist/index.js` as non-root).
- Provide a reference `docker-compose.yml` that includes the relay **plus** a TLS-terminating
  reverse proxy (Caddy is a good fit — automatic Let's Encrypt with minimal config) so
  "internet-exposed with TLS" is the documented default, not an exercise left to the operator.
- Either wire up `apps/web`'s `output: 'standalone'` into a Dockerfile too (for a consistent
  containerized 3-service compose: relay + web + reverse proxy), or remove the
  `standalone` setting if it's not actually part of the deploy story, to avoid configuration
  drift / dead config (same class of issue as C1/S3).
- Update `.env.example` and `使用说明书.md` to either (a) document the required reverse-proxy
  TLS setup explicitly if bare-metal/VM remains the deploy target, or (b) point at the new
  Docker Compose setup as the recommended production path.

---

## High

### DC4 — No metrics, tracing, or log-aggregation; only a single `/health` endpoint exists with no checks for downstream health

**Evidence** (`apps/server/src/index.ts`):
```ts
app.get('/health', async () => {
  return { status: 'ok', timestamp: Date.now(), version: '1.0.0' };
});
app.get('/api/v1/status', async () => {
  return { success: true, data: { uptime: process.uptime(), timestamp: Date.now() } };
});
```
Both endpoints are **unconditional liveness pings** — they return `ok`/success regardless
of whether:
- the SQLite DB file is writable/openable,
- the in-memory room map is in a sane state,
- `security_logs`/`messages` table sizes are within any sane bound (C2),
- the `download_tokens` table is growing unbounded (C1 — `cleanExpiredTokens()` dead code).

Fastify's default logger (`logger: { level: 'info' }`) writes structured JSON (pino) to
**stdout only** — there's no file-based log rotation, no shipping to a log aggregator
(ELK/Loki/Datadog/CloudWatch), and no retention policy. Combined with H1 from Phase 1
(40+ `console.log/error/warn` call sites across the desktop and web apps that bypass any
logger entirely), there is effectively **no usable production log trail** beyond whatever
stdout capture the (non-existent) process supervisor would provide.

There is no `/metrics` endpoint (Prometheus-style or otherwise), no APM integration
(OpenTelemetry, Sentry, etc.) in any of the four packages.

**Operational risk**: Combined with C1 (unbounded `download_tokens` growth), C2 (unbounded
`security_logs`/`messages` growth, no indexes — query latency degrades linearly), and S3
(host audit-log POSTs 404 silently against the relay), an operator has:
- **No dashboard** showing DB file size, table row counts, query latency, WS connection
  counts, or memory/CPU usage over time.
- **No alert** that would fire when `security_logs` grows large enough to make
  `COUNT(*)`/paginated queries slow (which, on a single-threaded event loop with synchronous
  better-sqlite3, would manifest as *all* relay operations slowing down — a creeping,
  whole-system degradation, not an isolated failure).
- **No way to detect** that Host-originated audit events are 404ing (S3) other than reading
  raw server access logs (which, again, only exist as unrotated stdout).

**Who notices, how long**: These are all "boil the frog" failure modes — gradual
degradation with no instrumentation to surface them. Realistically, the first signal an
operator gets is "the relay feels slow" or "it crashed (OOM)" reported by end users, at
which point the DB may already be gigabytes in size with no straightforward fix
(needs manual `DELETE`/`VACUUM` + retroactive index creation, ideally with the service
stopped).

**Recommendation**:
- Extend `/health` to do a real check: `db.prepare('SELECT 1').get()` against SQLite (catch
  and return 503 on failure), and optionally report `security_logs`/`messages`/
  `download_tokens` row counts so a monitoring scrape can alert on unbounded growth before
  it becomes a crisis.
- Add a lightweight `/metrics` endpoint (even a hand-rolled JSON with WS connection counts,
  room counts, table sizes, uptime, memory usage via `process.memoryUsage()`) that an
  external Prometheus/Grafana or even a cron-based curl+alert script can poll.
- Replace ad-hoc `console.*` (H1) with `pino` (server already has it as a Fastify
  dependency) configured to write to a rotated file (`pino/file` + `logrotate`, or
  `pino-roll`) in addition to stdout, so logs survive process restarts and can be
  retroactively searched.
- Wire C1's `cleanExpiredTokens()` into a `setInterval` (as recommended in Phase 2) and
  similarly add a retention-sweep job for `security_logs`/`messages` (C2) — and expose the
  sweep's last-run timestamp/row-count-deleted via the new `/metrics` endpoint so its
  operation is observable.

---

### DC5 — No documented incident-response/runbook procedures; "restart the relay" is the de-facto (undocumented) plan

**Evidence**: `使用说明书.md` section 8 ("常见问题排查" / Common Troubleshooting) covers
six developer-facing issues (native module mismatch, `localhost`/`::1` resolution, port
conflicts, expired PINs, CORS misconfiguration, Electron white-screen) — all **client-side
or local-dev** issues. There is **no section** covering:
- What to do when the relay process is unresponsive or has crashed (no restart procedure,
  no supervisor commands because none exists — see DC2).
- What to do if `register-host` is being hammered (S2 — unauthenticated, unrate-limited
  endpoint enabling unbounded DB-row creation / DoS). Confirmed in code
  (`apps/server/src/routes/auth.ts`): `generate-pin` calls
  `checkRateLimit('pin:${hostId}', ...)` and `connect` calls `checkRateLimit('auth:${ip}', ...)`,
  but `register-host` has **no `checkRateLimit` call at all** — any client can POST
  unlimited `{name, os, version}` bodies and each creates a new row in `hosts`. There is no
  documented detection method (e.g., "if `hosts` table row count is growing rapidly,
  suspect abuse") nor a mitigation runbook (e.g., "add a reverse-proxy rate limit on this
  path", "rotate JWT_SECRET to invalidate tokens", "temporarily block via firewall").
- Rollback procedure for a bad deploy: `scripts/deploy-server.sh` has no versioning,
  tagging, or rollback mechanism — redeploying a previous version means manually
  `git checkout <old-sha>` + rerun the script, which isn't documented anywhere.
- What "self-healing restart" (ADR-005) actually requires operationally — the doc says
  reconnect logic handles relay restarts gracefully from the client/host side, but doesn't
  tell an *operator* how to safely trigger that restart (drain connections first? just
  kill -9? any data-loss risk to in-flight WS file-tunnel transfers?).

`docs/code-review-report.md` (June 2026) is a code-quality review, not an ops runbook —
it doesn't fill this gap (and CLAUDE.md itself notes parts of it are stale).

**Operational risk**: When something goes wrong in production (relay crash, DoS via
register-host spam, DB growth causing slowdowns), the on-call person — who in a
single-maintainer project is likely the same person who wrote the code — has to
reverse-engineer the fix in real time with no prepared playbook. For a multi-maintainer
team or any handoff scenario, this is a hard blocker to safe operations.

**Recommendation**:
- Add a `docs/runbook.md` (or a new section in `使用说明书.md`) covering at minimum:
  1. **Relay down**: how to check status (once DC2 adds a supervisor, `systemctl status` /
     `pm2 status`), how to restart, what state is lost (in-memory rooms — both ends
     reconnect automatically per ADR-005) vs. persisted (SQLite DB).
  2. **Suspected register-host abuse (S2)**: how to spot it (`SELECT COUNT(*) FROM hosts`
     growth rate, or the new `/metrics` from DC4), immediate mitigation (reverse-proxy
     rate-limit on `/api/v1/auth/register-host`, or temporarily firewall the path), and a
     cleanup query for spam rows.
  3. **DB growth / slow queries (C2)**: how to check table sizes, how to safely run
     retention cleanup + `VACUUM` (ideally with the service paused), and the long-term fix
     (add indexes, per Phase 2's C2 recommendation).
  4. **Rollback**: tag releases (even simple git tags per `apps/server` deploy), and
     document `git checkout <tag> && bash scripts/deploy-server.sh` (post-DC2: plus
     supervisor restart) as the rollback path.
- Once DC1 (CI) exists, link CI run history into the runbook so "what changed since the
  last good deploy" is answerable quickly.

---

### DC6 — Electron desktop app has no auto-update mechanism or code-signing/distribution pipeline

**Evidence** (`apps/desktop/electron-builder.config.ts`): defines `win`/`mac`/`linux`
targets (nsis/dmg/AppImage) but:
- No `publish` configuration (electron-builder's `publish` field, which would enable
  `electron-updater` auto-update via GitHub Releases, S3, generic HTTP, etc.) — confirmed
  absent from the config.
- No code-signing config: no `win.certificateFile`/`certificateSubjectName`, no
  `mac.identity`/notarization (`afterSign` hook, `CSC_LINK`/`CSC_KEY_PASSWORD` env usage)
  anywhere in the repo.
- `apps/desktop/package.json` has no `electron-updater` dependency.
- Packaging is invoked manually (`pnpm --filter @remotebridge/desktop package:win`) with
  output to `release/` (gitignored) — there's no CI job (per DC1, none exists) that builds
  and publishes these artifacts, and no documented distribution channel (download page,
  release repo, etc.).

**Operational risk**: Every Host-side bug fix or protocol change (recall CLAUDE.md's
"Protocol changes" section — adding a WS message type touches `packages/shared` and the
desktop handlers) requires **every end user to manually download and reinstall** the
desktop app, with no in-app notification that an update exists. For a tool whose core value
proposition is a long-running background "Host" agent, this is a significant adoption/
maintenance friction point — users on old protocol versions could silently
fail to interoperate with a newer relay/web client if the protocol ever has a breaking
change (D4 from Phase 3 already flags the lack of versioning/changelog discipline, which
compounds this).

Unsigned Windows/macOS builds also mean every install triggers SmartScreen/Gatekeeper
warnings, which is both a UX problem and a security-hygiene concern (users trained to
click through "unknown publisher" warnings).

**Recommendation**:
- Add `electron-updater` + a `publish` target (GitHub Releases is the lowest-friction
  option for a project without existing infra) to `electron-builder.config.ts`, and add an
  update-check call in the main process (`autoUpdater.checkForUpdatesAndNotify()`).
- At minimum, document a manual release process (build artifacts → attach to a tagged
  GitHub release → users check a "releases" page) even before full auto-update is wired up.
- Code signing is a larger investment (cert acquisition cost) but should be tracked as a
  follow-up — at minimum note it as a known gap in `docs/` so it's not forgotten before a
  wider rollout.

---

## Medium

### DC7 — `.env.example` lacks JWT-secret-strength guidance and ships a `RELAY_PORT=443` default that implies privileged-port binding with no TLS path (compounds DC3/D2)

**Evidence** (`.env.example`, full contents reproduced):
```
RELAY_PORT=443
RELAY_HOST=0.0.0.0
JWT_SECRET=change-me-to-a-random-string
JWT_REFRESH_SECRET=change-me-to-another-random-string
DATABASE_URL=file:./data/remotebridge.db
ALLOWED_ORIGINS=http://localhost:3000,https://your-domain.com
RATE_LIMIT_MAX=10
RATE_LIMIT_WINDOW=60000
```
Issues, several already flagged in Phase 2/3 (D2, S6) but with DevOps-specific angles:
1. `JWT_SECRET`/`JWT_REFRESH_SECRET` placeholders give no guidance on generation method
   (e.g., `openssl rand -hex 32`) or minimum length/entropy — and per S6
   (`apps/server/src/utils/jwt.ts`), if unset, the code falls back to
   `'remotebridge-dev-secret-change-in-production'` (and derives the refresh secret from
   it) **silently** — no startup warning/error. A devops engineer copying `.env.example`
   to `.env` without filling these in gets a fully-functional-looking relay signing tokens
   with a publicly-known-from-source-code secret.
2. `RB_DATA_DIR` (mentioned in CLAUDE.md and `使用说明书.md` as the actual DB location env
   var) is **absent from `.env.example`** — only the unused-by-runtime `DATABASE_URL` (read
   only by drizzle-kit) is present. An operator following `.env.example` literally would
   set the wrong variable for DB location.
3. `RELAY_PORT=443` with `RELAY_HOST=0.0.0.0` implies binding to a privileged port as root
   (Linux) with no documented TLS termination (DC3) — a devops engineer following this
   file alone would hit `EACCES` on `listen(443)` unless running as root or with
   `setcap`/`authbind`, none of which is mentioned.
4. `ALLOWED_ORIGINS` includes `https://your-domain.com` as a *placeholder that looks like a
   real value* — if not edited, CORS would allow a non-existent origin (harmless) but also
   signals the file wasn't meaningfully customized, with no automated check to catch that.

**Operational risk**: Each of these is a "footgun on first deploy" — a devops engineer
setting this up for the first time, working purely from `.env.example` +
`scripts/deploy-server.sh`, would plausibly end up with: wrong DB location (item 2),
wrong/missing JWT secrets (item 1 — silently insecure, not even an error), and a port-bind
failure or TLS-less internet exposure (items 3 + DC3).

**Recommendation**:
- Add `RB_DATA_DIR` to `.env.example` with its actual default documented; consider removing
  or clearly annotating `DATABASE_URL` as "drizzle-kit only, not read by the running server"
  (this directly closes part of D2/D4's documentation gaps from the devops angle).
- Add inline comments with secret-generation commands, e.g.
  `# generate with: openssl rand -hex 32`.
- Add a **startup guard** in `apps/server/src/index.ts` (or `utils/jwt.ts`): if
  `JWT_SECRET`/`JWT_REFRESH_SECRET` are unset or equal to the known dev-default string,
  log a loud warning (or, gated by `NODE_ENV==='production'`, refuse to start). This single
  check would have prevented S6 from being shippable in a real production deploy and is a
  natural pairing with DC1 (could even be a CI assertion against `.env.example` defaults
  never matching runtime fallbacks).
- Change `.env.example`'s `RELAY_PORT` default to `3001` (matching the code's actual
  default and the dev/test instructions throughout `使用说明书.md`/CLAUDE.md) and document
  443/TLS as a *reverse-proxy* concern (see DC3), not a direct Node `listen()` target.

---

### DC8 — No `NODE_ENV` gating anywhere; dev and prod run identical code paths with no environment-aware behavior

**Evidence**: Repo-wide search for `NODE_ENV` across all `*.ts`/`*.tsx`/`*.js` source in
`apps/`/`packages/` (excluding `node_modules`/`dist`/`.next` build output) returns **no
matches** in source code. Specific consequences:
- `apps/server/src/index.ts` always constructs Fastify with `logger: { level: 'info' }` —
  same verbosity in dev and prod; no `'debug'` in dev / `'warn'` in prod split, and no
  pretty-printing toggle for local dev vs. JSON-only for prod log aggregation.
- CORS (`apps/server/src/utils/cors.ts`) falls back to `['http://localhost:3000']` when
  `ALLOWED_ORIGINS` is unset — a **dev-friendly default that is also the production
  fallback**. If an operator forgets to set `ALLOWED_ORIGINS` in production, the relay
  silently only accepts CORS from `localhost:3000`, which would manifest as "the deployed
  web app can't talk to the relay" — a confusing failure mode whose root cause (missing
  env var) is not surfaced anywhere (no startup log line stating "ALLOWED_ORIGINS not set,
  using default: ...").
- `apps/web`'s `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` default to
  `http://localhost:3001/api/v1` / `ws://localhost:3001/ws` (per CLAUDE.md) — these are
  **build-time** env vars for Next.js, meaning a production build that doesn't set them at
  build time silently bakes in `localhost` URLs. There's no build-time assertion/warning for
  this either.
- The desktop app's `RELAY_URL`/`RELAY_API` env fallbacks point at `127.0.0.1:3001` —
  appropriate for "this PC is the host," but again no environment-driven switch; relies
  entirely on the user manually changing settings via the renderer UI (per CLAUDE.md).

**Operational risk**: There is no single toggle/checklist item ("set `NODE_ENV=production`")
that changes behavior — every environment-specific setting (CORS origins, JWT secrets, API
URLs, log verbosity) is an independent env var that must be *individually* remembered, with
no aggregate "production mode" sanity check. This is the root enabler for S2, S6, and this
section's DC7 all being shippable simultaneously: there's no single gate that would have
forced a developer to consciously flip from "dev defaults" to "prod-hardened config."

**Recommendation**:
- Introduce a lightweight startup "production readiness check" gated on
  `process.env.NODE_ENV === 'production'` in `apps/server/src/index.ts`, which validates:
  `JWT_SECRET`/`JWT_REFRESH_SECRET` are set and not equal to known dev defaults,
  `ALLOWED_ORIGINS` is set and doesn't contain `localhost`, `RELAY_HOST`/`RELAY_PORT` are
  sane. Fail fast (non-zero exit) with a clear error message listing every missing/unsafe
  setting — this is cheap to implement and would have caught S2/S6/DC7 collectively at
  deploy time rather than silently running insecure.
- For `apps/web`, add a `next.config.mjs` build-time check (or a small prebuild script)
  that warns/fails if `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` are unset when
  `NODE_ENV=production`, since Next.js bakes these in at build time and a missing value is
  otherwise a silent `localhost` fallback shipped to every user's browser.
- Set `logger: { level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' }` (or
  similar) in `apps/server/src/index.ts` as a first step toward environment-aware logging,
  paired with DC4's broader logging recommendations.

---

## Low

### DC9 — No dependency-audit / SAST scanning in any form

**Evidence**: Beyond the absence of CI (DC1) itself, there's no `npm audit`/`pnpm audit`
invocation anywhere (scripts, docs), no Dependabot/Renovate config (`.github/dependabot.yml`
absent, consistent with no `.github/` at all), no SAST tooling config (Semgrep, CodeQL,
`eslint-plugin-security`, etc.). `pnpm-lock.yaml` is committed (good — reproducible
installs), but nothing periodically checks it for known-vulnerable transitive deps.

**Operational risk**: A relay server handling auth tokens and file transfers, built on a
dependency tree including `jsonwebtoken`, `bcryptjs`, `better-sqlite3`, `ws`, `fastify`, and
many transitive packages, has no automated signal when a CVE is published against any of
these. Given the project's single-instance, internet-facing posture, an unpatched
known-vulnerable dependency could sit for the project's entire lifetime without detection.

**Recommendation**: Once DC1's basic CI exists, add a `pnpm audit --prod` step (non-blocking
initially, e.g., report-only, since `pnpm audit` can have false positives on dev-only
deps) and/or enable Dependabot/Renovate for automated dependency-update PRs. This is a
low-effort, high-value addition once any CI exists at all.

---

### DC10 — No version/release discipline tied to deployment (compounds D4 from Phase 3)

**Evidence**: All four packages (`packages/shared`, `apps/server`, `apps/desktop`,
`apps/web`) remain pinned at `"version": "1.0.0"` with no `engines` field anywhere
specifying a required Node.js version (despite `使用说明书.md` stating "项目实测于
v22.14.0" as a *documentation-only* note, not enforced by `package.json`/`.nvmrc`/CI).
There are no git tags referenced by any script, and `scripts/deploy-server.sh` deploys
"whatever is currently checked out" with no version stamping in the running process beyond
the hardcoded `version: '1.0.0'` string in the `/health` response.

**Operational risk**: When `/health` reports `"version": "1.0.0"` for every deploy ever
made, an operator cannot distinguish "relay running today's deploy" from "relay running a
deploy from 3 months ago" via the health endpoint — useful during incident triage (DC5) to
confirm a fix actually deployed. Combined with no CI (DC1) and no rollback tooling (DC5),
there's no reliable way to answer "what code is currently running in production?"

**Recommendation**:
- Add a `.nvmrc` (or `engines.node` in root `package.json`) pinning Node 22, enforced in CI
  once it exists (DC1).
- Have `/health` report a git commit SHA or build timestamp (injectable at build time via
  an env var set in `scripts/deploy-server.sh`, e.g. `RB_BUILD_SHA=$(git rev-parse HEAD)`)
  instead of (or in addition to) the static `'1.0.0'` string — trivial change, meaningfully
  improves incident triage (DC5) and deploy verification.
