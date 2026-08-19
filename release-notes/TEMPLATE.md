# 发行版详情撰写规范

> 本文件定义 RemoteBridge 触发 CD 构建新发行版时，撰写发行版详情（Release Notes）的格式规范。  
> 适用于 GitHub Release 描述、`docs/release-notes/vX.Y.Z.md` 文件。

---

## 1. 文件位置

- **GitHub Release**：由 CD 流程（`release.yml`）在 `electron-builder --publish always` 时自动创建 Draft Release，维护者手动编辑描述后发布。
- **仓库内副本**：`docs/release-notes/vX.Y.Z.md`，与 CHANGELOG.md 并存，面向最终用户（CHANGELOG.md 面向开发者，含完整文件路径与代码级细节）。

## 2. 结构模板

```markdown
# RemoteBridge vX.Y.Z 发行版

> 发布日期：YYYY-MM-DD  
> 桌面端：vX.Y.Z | 服务端：vA.B.C | Web：vD.E.F

---

## 章节标题（按用户影响分组）

- **加粗标题**：一句话概括变更点，括号内标注主要文件路径
  - 第一行：用户可见的行为变化
  - 第二行起（可选）：技术细节、修复原因、安全影响
  - 文件路径用反引号包裹，多个路径用顿号分隔

## 下载

| 平台 | 文件 |
|------|------|
| Windows (x64) | RemoteBridge-Setup-X.Y.Z.exe |
| macOS (Apple Silicon) | RemoteBridge-X.Y.Z-arm64.dmg |
| Linux (x64) | RemoteBridge-X.Y.Z.AppImage |
```

## 3. 撰写规则

### 3.1 分组原则

按**用户影响**分组，不按文件类型分组。典型分组（按需选用）：

| 分组 | 适用场景 |
|------|----------|
| 桌面端 UI/UX | 界面、交互、主题、字体、动效变化 |
| 桌面端功能 | 新增功能、设置项、托盘行为 |
| Web 端 | Web 页面、API、连接流程 |
| 服务端 / API | 新增/变更端点、协议、限流 |
| 生产环境 / Docker | Docker、Caddy、部署、运维 |
| 安全修复 | 漏洞修复、加固、审计 |
| 代码质量 | 重构、bug 修复、测试覆盖 |
| CI / DevOps | 工作流、构建、发布流程 |
| 文档 | README、指南、设计文档 |

### 3.2 条目格式

每个条目遵循：

```
- **标题**：一句话用户可见结果（`file/path.ts`、`another.ts`）
  - 可选：技术细节、修复原因、安全影响、兼容性说明
```

- **标题**：加粗，以用户视角描述「做了什么」，而非「改了什么文件」
- **文件路径**：括号内用反引号包裹，多个用顿号分隔；桌面端路径以 `apps/desktop/src/` 开头，服务端以 `apps/server/src/` 开头，shared 以 `packages/shared/src/` 开头
- **子项**：仅在需要解释「为什么」或「怎么用」时添加，避免代码级细节

### 3.3 风格约束

| 规则 | 说明 |
|------|------|
| 用户视角 | 描述用户能感知的变化，而非代码 diff |
| 简洁 | 每条 1-2 行，子项最多 1 行补充 |
| 无代码片段 | 发行版详情不放代码块；技术细节指向 CHANGELOG.md |
| 无 commit hash | 不暴露内部 commit 引用 |
| 文件路径用反引号 | 便于阅读，不强制链接 |
| 下载表必含 | 三平台（Win/Mac/Linux）文件名必须列出 |
| 版本号准确 | 桌面端 / 服务端 / Web 三者的版本号分别标注 |

### 3.4 与 CHANGELOG.md 的分工

| 文件 | 受众 | 详细程度 |
|------|------|----------|
| `docs/release-notes/vX.Y.Z.md` | 最终用户 | 行为变化 + 文件路径，无代码 |
| `CHANGELOG.md` | 开发者 / 贡献者 | 完整文件路径、代码级细节、测试覆盖、commit 范围 |

同一变更在两个文件中均应出现，但详细程度不同。

## 4. 工作流程

1. **CD 触发**：`git tag vX.Y.Z && git push --tags` 触发 `release.yml`。
2. **Draft Release**：CD 创建 Draft Release，描述为空。
3. **撰写描述**：维护者按本规范撰写，粘贴到 GitHub Release 描述。
4. **保存副本**：同内容保存至 `docs/release-notes/vX.Y.Z.md`，提交到 main。
5. **正式发布**：CD 的 `finalize` job 将 Draft 转为 Published（或维护者手动发布）。

## 5. 示例（摘自 v1.3.8）

```markdown
## 生产环境 Docker / 服务端加固（多文件）

- **Relay Server 开启 `trustProxy: true`**：修复部署在 Caddy 反向代理之后时，`@fastify/rate-limit` 按代理 IP 而非真实客户端 IP 计数的问题，限流重新按真实客户端 IP 生效（`apps/server/src/index.ts`）
- **新增 1 MB 请求体大小上限**：`bodyLimit: 1_048_576`，防止恶意大请求耗尽服务端内存（`apps/server/src/index.ts`）
- **两个 Dockerfile 新增非 root 运行用户**：server 镜像创建 uid 1001 `relayuser`，web 镜像创建 uid 1001 `nextjs`，容器被攻破时攻击者权限降至最小（`apps/server/Dockerfile`、`apps/web/Dockerfile`）
- **Web 容器新增 HEALTHCHECK**：`node -e` 内联检查 `/` 路由返回码 <500，30s 间隔、5s 超时、20s 启动宽限期、3 次重试（`apps/web/Dockerfile`）
- **depends_on 改用 `condition: service_healthy`**：Caddy 仅在 server 和 web 的 HEALTHCHECK 通过后接受流量，避免启动期间 502（`docker-compose.yml`）
- **所有容器添加资源上限与日志轮转**：server ≤1 CPU / 512 MB、web ≤0.5 CPU / 256 MB；日志 `max-size: 10m` / `max-file: 3~5`，防止磁盘耗尽（`docker-compose.yml`）
- **所有容器添加 `no-new-privileges` 安全选项**：阻止容器内进程通过 SUID 二进制提权（`docker-compose.yml`）
- **Caddyfile 补全安全响应头**：HSTS（`max-age=31536000; includeSubDomains; preload`）、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy` 关闭摄像头/麦克风/地理位置等、`-Server` 隐藏 Caddy 版本信息（`Caddyfile`）
- **Next.js 响应头同步补全**：`Content-Security-Policy`、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy` 双层防御（`apps/web/next.config.mjs`）
```
