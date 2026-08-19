<div align="center">

![RemoteBridge Logo](https://raw.githubusercontent.com/Aswellle/RemoteBridge/main/apps/desktop/colorfulbridge.png?v=2)

# RemoteBridge

零端口穿透，随处访问你的电脑文件

</div>

 **[English](./README.en.md)**
<div align="center">

[![Stars](https://img.shields.io/github/stars/Aswellle/RemoteBridge?style=flat-square&color=blue)](https://github.com/Aswellle/RemoteBridge/stargazers)
[![Forks](https://img.shields.io/github/forks/Aswellle/RemoteBridge?style=flat-square&color=blue)](https://github.com/Aswellle/RemoteBridge/network/members)
[![Issues](https://img.shields.io/github/issues/Aswellle/RemoteBridge?style=flat-square&color=orange)](https://github.com/Aswellle/RemoteBridge/issues)
[![License](https://img.shields.io/github/license/Aswellle/RemoteBridge?style=flat-square&color=brightgreen)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Aswellle/RemoteBridge?style=flat-square&color=brightgreen)](https://github.com/Aswellle/RemoteBridge/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Aswellle/RemoteBridge/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Aswellle/RemoteBridge/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)](docker-compose.yml)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-607D8B?style=flat-square)](https://github.com/Aswellle/RemoteBridge/releases)
[![Last Commit](https://img.shields.io/github/last-commit/Aswellle/RemoteBridge?style=flat-square&color=green)](https://github.com/Aswellle/RemoteBridge/commits/main)

[简体中文](README.md) | [English](README.en.md)

</div>


**无需开放任何端口，在任意浏览器里访问你的电脑文件。**

> 桌面端主动向外连接中继服务器——无需端口转发、无需 VPN、无需公网 IP。
> 访客输入 8 位 PIN 码即可共享文件，会话随用随吊销。

---

## 目录

- [项目简介](#项目简介)
- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [部署](#部署)
- [技术栈](#技术栈)
- [文档](#文档)
- [开源协议](#开源协议)

---

## 项目简介

RemoteBridge 采用**中继服务器架构**：运行在你电脑上的 Electron 桌面应用（*Host 端*）主动向公网中继服务器建立 WebSocket 出站连接；网页客户端连接到同一中继，中继按会话 ID 将消息在两端之间转发。

```
  Web 浏览器  ──────►  中继服务器  ◄──────  桌面 Host（你的电脑）
  （任意设备）         （云端 VPS）          （Electron 应用）
```

你的电脑始终**不对外监听任何端口**，NAT 和防火墙天然穿透。

### 适用场景

- **远程办公** —— 在家访问公司电脑文件，无需 VPN 客户端
- **大文件传递** —— 共享 PIN 码让对方直接取走文件，不经过第三方云存储
- **家庭服务器远程访问** —— 从任意浏览器访问家中 NAS/服务器，无需路由器端口映射
- **开发协作** —— 测试/设计师直接预览构建产物，无需 SSH 权限
- **小团队协作** —— 无需 Active Directory 或共享驱动器，按需生成 PIN 码，用完吊销
- **教育/实验室** —— 远程获取工作站文件，无需将 RDP/SSH 暴露在公网

---

## 核心特性

| 类别 | 特性 |
|------|------|
| 🔌 **零配置连接** | 桌面端仅发起出站连接，无需端口转发、VPN、动态 DNS |
| 🔑 **PIN 码配对** | 8 位短效 PIN 码（默认 5 分钟，可配置至 24 小时），浏览器输入即连 |
| 📁 **文件浏览与下载** | 白名单目录浏览，HTTP Range 断点续传，256 KB 二进制帧流式传输 |
| 👁️ **浏览器内预览** | 图片、PDF、文本文件预览，PDF 在沙盒 iframe 中打开 |
| 💬 **实时消息** | 持久化消息历史，WebSocket 不可用时自动回退 REST |
| 🔒 **会话管理** | 桌面端即时吊销任意客户端会话，旧 token 即刻失效 |
| 📊 **安全审计** | 所有文件访问（允许/拒绝）记录到审计日志，Web 端可查看 |
| 🖥️ **内置本地 Relay** | 桌面端内置一键启动/停止的 Relay 服务器，无需单独部署 |
| 📤 **文件上传** | 浏览器 → Host 端分块传输，按文件类型自动分类存储 |
| 🔄 **自动更新** | 桌面端启动时检查 GitHub Releases 新版本 |
| 🐳 **完全自托管** | Docker Compose 一条命令部署，Caddy 自动 TLS |
| 🛡️ **生产级安全** | httpOnly Cookie 令牌、CSP、非 root 容器、资源限制、安全响应头 |

---

## 快速开始

### 方式一：Docker Compose（推荐，用于公网部署）

```sh
# 克隆仓库
git clone https://github.com/Aswellle/RemoteBridge.git
cd RemoteBridge

# 生成 JWT 密钥
openssl rand -base64 48   # 第一个 → JWT_SECRET
openssl rand -base64 48   # 第二个 → JWT_REFRESH_SECRET

# 编辑 .env，填入密钥和域名
cp .env.example .env

# 启动全部服务
docker compose up -d
```

启动后访问 `https://<你的域名>`，Caddy 自动申请 Let's Encrypt 证书。

包含三个服务：
- **`server`** —— 中继服务器（SQLite 持久化，非 root 运行，资源受限）
- **`web`** —— Next.js 客户端（独立构建，健康检查）
- **`caddy`** —— TLS 反向代理（自动 HTTPS，完整安全响应头）

### 方式二：本地开发模式

```sh
# 一键初始化
git clone https://github.com/Aswellle/RemoteBridge.git
cd RemoteBridge
bash scripts/setup.sh

# 配置服务端环境变量
cp apps/server/.env.example apps/server/.env
# 编辑 .env，填入 JWT_SECRET、JWT_REFRESH_SECRET、ALLOWED_ORIGINS

# 启动所有服务（热更新）
pnpm dev
# 中继服务器 → http://localhost:3002
# 网页客户端 → http://localhost:3000
# 桌面应用   → Electron 窗口
```

单独启动各服务：

```sh
pnpm --filter @remotebridge/server dev     # 仅中继服务器
pnpm --filter @remotebridge/web dev        # 仅网页客户端
pnpm --filter @remotebridge/desktop dev    # 仅桌面 Host
```

> **桌面端 Native 模块说明**
> `better-sqlite3` 必须针对 Electron ABI 编译。如果桌面应用崩溃并提示 `NODE_MODULE_VERSION` 不匹配：
> ```powershell
> # Windows
> .\scripts\dev-desktop.ps1
> ```
> ```sh
> # macOS / Linux
> cd apps/desktop && npx @electron/rebuild -f -w better-sqlite3 && cd ../..
> ```

### 方式三：桌面端 + 内置本地 Relay

从 [Releases](https://github.com/Aswellle/RemoteBridge/releases) 下载最新安装包。安装后打开「设置 → 本地中继服务器」，点击「启动」即可在本地运行 Relay，无需单独部署云服务。

---

## 部署

### Docker Compose（生产环境）

```sh
# 在 .env 中设置域名和密钥，然后：
docker compose up -d
```

**生产环境加固**：
- 所有容器以非 root 用户（uid 1001）运行
- 资源限制：server ≤1 CPU / 512 MB，web ≤0.5 CPU / 256 MB
- 日志轮转：`max-size: 10m`，`max-file: 3~5`
- `no-new-privileges:true` 阻止容器提权
- `depends_on` 使用 `condition: service_healthy`，服务就绪后才接受流量
- Caddy 补全 HSTS、X-Content-Type-Options、X-Frame-Options、Referrer-Policy、Permissions-Policy 安全头

### 裸机部署

```sh
bash scripts/deploy-server.sh   # tsc 编译 → systemd 运行
```

systemd 单元文件：`deploy/systemd/remotebridge-server.service`

健康检查：`GET /health` 返回中继状态、数据库写入探针结果及各表行数。

### 桌面客户端

从 [Releases](https://github.com/Aswellle/RemoteBridge/releases) 下载，或本地构建：

```sh
pnpm --filter @remotebridge/desktop package:win    # Windows NSIS 安装包
pnpm --filter @remotebridge/desktop package:mac    # macOS DMG (arm64)
pnpm --filter @remotebridge/desktop package:linux  # Linux AppImage
```

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 桌面 Host | Electron 28 · Fastify（本地文件服务器）· better-sqlite3 |
| 中继服务器 | Fastify · `@fastify/websocket` · better-sqlite3 · Drizzle ORM |
| 网页客户端 | Next.js 14 App Router · Zustand · Tailwind CSS |
| 共享协议层 | TypeScript 协议类型定义 · 路径安全校验 |
| 工程化 | pnpm workspaces · Turborepo · Vitest · electron-vite |

---

## 文档

| 文档 | 说明 |
|------|------|
| [生产环境部署与使用指南](生产环境部署与使用指南.md) | Docker 部署、Caddy 配置、运维速查、故障排查 |
| [使用说明书](使用说明书.md) | 用户操作手册 |
| [CHANGELOG](CHANGELOG.md) | 版本变更记录 |
| [AGENTS.md](AGENTS.md) | 项目开发指南（AI 辅助开发） |
| [ADR](docs/adr/) | 架构决策记录 |

---

## 安全机制

- **路径校验**：每次文件操作前，路径经过用户配置的白名单和系统敏感目录黑名单双重校验；符号链接解析后校验，防止目录穿越
- **下载令牌**：一次性 UUID，绑定请求方 `clientId`，30 分钟过期
- **JWT 分离**：访问令牌（2 h）与刷新令牌（30 d）使用独立签名密钥；刷新令牌携带 `use: 'refresh'` 声明，WebSocket 连接时拒绝
- **httpOnly Cookie**：网页客户端令牌存储在 `HttpOnly; SameSite=Strict` Cookie 中，JavaScript 不可读，防御 XSS 凭据窃取
- **Electron 沙盒**：渲染进程 `sandbox: true` + 严格 CSP；PDF 预览使用无 `allow-same-origin` 的沙盒 iframe
- **生产加固**：`trustProxy: true`（反向代理后限流按真实 IP 计数）、1 MB 请求体上限、非 root 容器、资源限制、安全响应头

---

## 测试

四个包均有 Vitest 测试套件。服务端套件自动在 `:3099` 启动中继，无需手动准备：

```sh
pnpm --filter @remotebridge/shared test
pnpm --filter @remotebridge/server test    # 自动启动中继于 :3099
pnpm --filter @remotebridge/desktop test
pnpm --filter @remotebridge/web test
```

---

## CI / CD

每次推送和 Pull Request 触发完整 CI（构建 → 类型检查 → Lint → 测试），由 `.github/workflows/ci.yml` 定义。

推送版本 tag 触发发布流水线：

```sh
git tag v1.3.8
git push origin v1.3.8
```

GitHub Actions 并行构建 Windows / macOS / Linux 安装包，发布到 GitHub Releases。桌面端启动时自动检查更新。

---

## 贡献指南

1. Fork 并克隆仓库
2. 执行 `bash scripts/setup.sh` 安装依赖
3. 修改代码 —— 编辑 shared 包后需重新构建（`pnpm --filter @remotebridge/shared build`）
4. 确保测试通过：`pnpm --filter @remotebridge/server test && pnpm --filter @remotebridge/web test`
5. 向 `main` 分支提交 Pull Request

---

## 开源协议

[MIT](LICENSE)

---

## ⭐ 支持这个项目

如果 RemoteBridge 对你有帮助，欢迎给我们一个 ⭐️ Star！

你的每一次支持，都是我们持续改进的动力。

[![Star History Chart](https://api.star-history.com/svg?repos=Aswellle/RemoteBridge&type=Date)](https://star-history.com/#Aswellle/RemoteBridge&Date)
