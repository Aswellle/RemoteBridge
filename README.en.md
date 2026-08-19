<div align="center">

![RemoteBridge Logo](https://raw.githubusercontent.com/Aswellle/RemoteBridge/main/apps/desktop/colorfulbridge.png)

# RemoteBridge

Zero open ports. Your files, anywhere.

</div>

 **[中文文档](./README.md)**
<div align="center">

[![License](https://img.shields.io/github/license/Aswellle/RemoteBridge?style=flat-square&color=brightgreen)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Aswellle/RemoteBridge?style=flat-square&color=brightgreen)](https://github.com/Aswellle/RemoteBridge/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Aswellle/RemoteBridge/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Aswellle/RemoteBridge/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)](docker-compose.yml)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-607D8B?style=flat-square)](https://github.com/Aswellle/RemoteBridge/releases)

[简体中文](README.md) | [English](README.en.md)

</div>


**Access your PC files from any browser — without opening a single port.**

> The desktop app connects outbound to a relay — no port forwarding, no VPN, no public IP.
> Share an 8-digit PIN with guests, revoke anytime.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Quick Start](#quick-start)
- [Deployment](#deployment)
- [Tech Stack](#tech-stack)
- [Documentation](#documentation)
- [License](#license)

---

## Overview

RemoteBridge uses a **relay server architecture**: an Electron desktop app (the *Host*) on your PC connects outbound to a public relay over WebSocket; a Next.js web client connects to the same relay and the relay forwards messages between them via session-keyed rooms.

```
Web Browser  ──────►  Relay Server  ◄──────  Desktop Host (your PC)
  (any device)           (cloud VPS)           (Electron app)
```

Your PC never listens on a public port — NAT and firewall traversal is inherent.

### Use Cases

- **Remote work** — Access office PC files from home, no VPN client needed
- **Large file transfer** — Share a PIN, let others grab files directly, no third-party cloud
- **Home server remote access** — Access your NAS/server from any browser, no router port mapping
- **Developer collaboration** — QA/designers preview build outputs without SSH access
- **Small-team collaboration** — No Active Directory or shared drives, generate PINs on demand, revoke when done
- **Education / lab access** — Remotely retrieve workstation files without exposing RDP/SSH to the internet

---

## Key Features

| Category | Feature |
|----------|---------|
| 🔌 **Zero-config connection** | Desktop app initiates outbound connections only — no port forwarding, VPN, or dynamic DNS |
| 🔑 **PIN-based pairing** | Short-lived 8-character PIN (default 5 min, configurable up to 24 hours), enter in browser to connect |
| 📁 **File browsing & download** | Whitelisted directory browsing, HTTP Range resume, 256 KB binary frame streaming |
| 👁️ **In-browser preview** | Image, PDF, text preview; PDF opens in sandboxed iframe |
| 💬 **Real-time messaging** | Persistent message history, automatic REST fallback when WebSocket unavailable |
| 🔒 **Session management** | Revoke any client session instantly from desktop; old tokens invalidated immediately |
| 📊 **Security audit** | All file access attempts (allowed/denied) logged; viewable in web client |
| 🖥️ **Built-in local Relay** | One-click start/stop Relay server inside the desktop app — no separate deployment needed |
| 📤 **File upload** | Browser → Host chunked transfer, auto-sorted by file type |
| 🔄 **Auto-update** | Desktop app checks GitHub Releases for new versions on startup |
| 🐳 **Fully self-hosted** | One-command Docker Compose deploy, Caddy automatic TLS |
| 🛡️ **Production-grade security** | httpOnly Cookie tokens, CSP, non-root containers, resource limits, security headers |

---

## Quick Start

### Option 1: Docker Compose (Recommended for public deployment)

```sh
# Clone the repo
git clone https://github.com/Aswellle/RemoteBridge.git
cd RemoteBridge

# Generate JWT keys
openssl rand -base64 48   # first → JWT_SECRET
openssl rand -base64 48   # second → JWT_REFRESH_SECRET

# Edit .env with your keys and domain
cp .env.example .env

# Start all services
docker compose up -d
```

Visit `https://<your-domain>` — Caddy automatically obtains a Let's Encrypt certificate.

Three services:
- **`server`** — Relay server (SQLite persistence, non-root, resource-limited)
- **`web`** — Next.js client (standalone build, health-checked)
- **`caddy`** — TLS reverse proxy (automatic HTTPS, full security headers)

### Option 2: Local Development

```sh
# One-time setup
git clone https://github.com/Aswellle/RemoteBridge.git
cd RemoteBridge
bash scripts/setup.sh

# Configure server env vars
cp apps/server/.env.example apps/server/.env
# Edit .env with JWT_SECRET, JWT_REFRESH_SECRET, ALLOWED_ORIGINS

# Start all services with hot reload
pnpm dev
# Relay server  → http://localhost:3002
# Web client    → http://localhost:3000
# Desktop app   → Electron window
```

Start individual services:

```sh
pnpm --filter @remotebridge/server dev     # relay only
pnpm --filter @remotebridge/web dev        # web only
pnpm --filter @remotebridge/desktop dev    # desktop only
```

> **Desktop native module note**
> `better-sqlite3` must be compiled against the Electron ABI. If the desktop app crashes with `NODE_MODULE_VERSION` mismatch:
> ```powershell
> # Windows
> .\scripts\dev-desktop.ps1
> ```
> ```sh
> # macOS / Linux
> cd apps/desktop && npx @electron/rebuild -f -w better-sqlite3 && cd ../..
> ```

### Option 3: Desktop + Built-in Local Relay

Download the latest installer from [Releases](https://github.com/Aswellle/RemoteBridge/releases). After installation, open Settings → Local Relay Server and click Start — no separate cloud deployment needed.

---

## Deployment

### Docker Compose (Production)

```sh
# Set domain and secrets in .env, then:
docker compose up -d
```

**Production hardening**:
- All containers run as non-root (uid 1001)
- Resource limits: server ≤1 CPU / 512 MB, web ≤0.5 CPU / 256 MB
- Log rotation: `max-size: 10m`, `max-file: 3~5`
- `no-new-privileges:true` prevents container privilege escalation
- `depends_on` uses `condition: service_healthy` — traffic only after services are ready
- Caddy completes HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy headers

### Bare Metal

```sh
bash scripts/deploy-server.sh   # tsc build → run via systemd
```

systemd unit: `deploy/systemd/remotebridge-server.service`

Health check: `GET /health` returns relay status, DB write probe, and per-table row counts.

### Desktop Client

Download from [Releases](https://github.com/Aswellle/RemoteBridge/releases), or build locally:

```sh
pnpm --filter @remotebridge/desktop package:win    # Windows NSIS installer
pnpm --filter @remotebridge/desktop package:mac    # macOS DMG (arm64)
pnpm --filter @remotebridge/desktop package:linux  # Linux AppImage
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Desktop Host | Electron 28 · Fastify (local file server) · better-sqlite3 |
| Relay Server | Fastify · `@fastify/websocket` · better-sqlite3 · Drizzle ORM |
| Web Client | Next.js 14 App Router · Zustand · Tailwind CSS |
| Shared Protocol | TypeScript protocol types · path security validation |
| Tooling | pnpm workspaces · Turborepo · Vitest · electron-vite |

---

## Documentation

| Document | Description |
|----------|-------------|
| [Production Deployment Guide](生产环境部署与使用指南.md) | Docker deploy, Caddy config, ops runbook, troubleshooting |
| [User Manual](使用说明书.md) | End-user operation manual |
| [CHANGELOG](CHANGELOG.md) | Version history |
| [AGENTS.md](AGENTS.md) | Project development guide (AI-assisted development) |
| [ADR](docs/adr/) | Architecture Decision Records |

---

## Security Model

- **Path validation**: Every file operation is checked against user-configured allowlist and system-sensitive blocklist; symlinks resolved before checking to prevent directory traversal
- **Download tokens**: One-time UUIDs bound to requester `clientId`, expire in 30 minutes
- **JWT separation**: Access tokens (2 h) and refresh tokens (30 d) signed with independent keys; refresh tokens carry `use: 'refresh'` claim and are rejected on WebSocket handshake
- **httpOnly Cookies**: Web client tokens stored in `HttpOnly; SameSite=Strict` cookies — invisible to JavaScript, defending against XSS credential theft
- **Electron sandbox**: Renderer runs with `sandbox: true` + strict CSP; PDF preview uses iframe without `allow-same-origin`
- **Production hardening**: `trustProxy: true` (rate limiting counts by real client IP behind reverse proxy), 1 MB body limit, non-root containers, resource limits, security headers |

---

## Testing

All four packages have Vitest suites. The server suite auto-spawns a relay on `:3099` — no manual setup:

```sh
pnpm --filter @remotebridge/shared test
pnpm --filter @remotebridge/server test    # auto-spawns relay on :3099
pnpm --filter @remotebridge/desktop test
pnpm --filter @remotebridge/web test
```

---

## CI / CD

Every push and PR triggers the full CI pipeline (build → typecheck → lint → test) via `.github/workflows/ci.yml`.

Pushing a version tag triggers the release pipeline:

```sh
git tag v1.3.8
git push origin v1.3.8
```

GitHub Actions builds Windows / macOS / Linux installers in parallel and publishes to GitHub Releases. The desktop app checks this feed for updates on startup.

---

## Contributing

1. Fork and clone the repo
2. Run `bash scripts/setup.sh` to install dependencies
3. Make changes — after editing the shared package, rebuild with `pnpm --filter @remotebridge/shared build`
4. Ensure tests pass: `pnpm --filter @remotebridge/server test && pnpm --filter @remotebridge/web test`
5. Open a Pull Request against `main`

---

## License

[MIT](LICENSE)
