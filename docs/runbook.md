# RemoteBridge Relay 运维手册（Runbook）

> 适用范围：仅覆盖 **Relay Server**（`apps/server`）的生产环境运维。桌面端/Web 端本地开发问题排查见
> `使用说明书.md` 第八节「常见问题排查」。本手册对应 `.full-review/05-final-report.md` 中的
> P1-22（事故响应文档缺失），并依赖 P0-11（部署基础设施）、P1-9/P1-18（限流）、P1-16（CHANGELOG）的成果。

## 一、Relay 崩溃恢复

### 1.1 自动重启机制

Relay 是**单实例、内存态房间**架构（ADR-005）：进程重启会丢失内存中的房间映射
（`hostSockets`/`clientSockets`/`sessionRooms`），但**不会丢失数据**——会话、消息、安全日志均持久化在
SQLite（`RB_DATA_DIR/remotebridge.db`）。重启后：

- 桌面端 Host 与 Web Client 都会以指数退避（1s–30s，无限重试）自动重连；
- Host 重连后会重新注册房间（host-reconnect room rebuild），Client 重连后凡持有未吊销的有效
  access token 即可继续使用；
- 唯一的风险窗口是重启瞬间**正在传输的 WS 消息/文件隧道分片**会丢失，需要客户端侧的超时重试逻辑兜底
  （文件下载走 HTTP Range，可断点续传；聊天消息走 `messageId` 去重，REST 兜底发送会重新入队）。

因此「自动重启」本身基本能让系统自愈，前提是**进程崩溃后真的会被重启**：

- **Docker Compose 部署**：`docker-compose.yml` 中 `server`/`web`/`caddy` 均设置了
  `restart: unless-stopped`，Docker daemon 重启或容器异常退出都会自动拉起。
  ```sh
  docker compose ps                 # 查看容器状态（Restarts 列异常增长 = 频繁崩溃）
  docker compose logs -f server     # 查看 relay 日志
  docker compose restart server     # 手动重启
  ```
- **裸机 systemd 部署**：`deploy/systemd/remotebridge-server.service` 设置了
  `Restart=on-failure` + `RestartSec=5`，进程非正常退出 5 秒后自动重启。
  ```sh
  systemctl status remotebridge-server     # 查看运行状态/最近重启次数
  journalctl -u remotebridge-server -f     # 实时日志
  sudo systemctl restart remotebridge-server
  ```
- **`scripts/deploy-server.sh` 直接前台运行**：**没有**进程监管，崩溃即永久离线，仅用于一次性验证，
  生产环境务必使用上述两种方式之一。

### 1.2 健康检查与监控

`GET /health` 现在会做一次真实写入探测，并返回 `hosts`/`sessions`/`messages`/`security_logs`
四张表的行数与数据库文件大小（P0-4/P0-5/P1-21 的成果）：

```jsonc
{
  "status": "ok",            // 写探测失败时为 "error"，HTTP 503
  "timestamp": 1234567890000,
  "version": "1.0.0",
  "db": {
    "ok": true,
    "sizeBytes": 1048576,
    "tables": { "hosts": 12, "sessions": 340, "messages": 58210, "securityLogs": 9120 }
  }
}
```

`docker-compose.yml` 已为 `server` 配置了基于此端点的 `healthcheck`（30s 间隔）。建议额外接入外部
监控（如 Uptime Kuma / Healthchecks.io）轮询此端点，并对以下情况告警：

- `status: "error"` 或 HTTP 503 → 磁盘满/只读，立即处理（见 1.3）；
- `db.sizeBytes` 或 `tables.messages`/`tables.securityLogs` **持续单调上升且远超 90 天保留窗口**
  应有的量级 → 检查 `startRetentionJob()` 是否在运行（每天一次，日志关键字
  `🧹 数据保留清理`）；
- `tables.hosts` **短时间内激增** → 见第二节（`register-host` 滥用）。

> 已知局限（P1-1）：目前仅有 `console.log`/`console.error`，没有结构化日志或指标导出，上述检查
> 只能靠轮询 `/health` 和 `grep` 日志关键字，无法做趋势图/告警分级。

### 1.3 排障步骤（Checklist）

1. **确认进程是否在跑**：`docker compose ps` 或 `systemctl status remotebridge-server`。
2. **看最近日志找崩溃原因**：`docker compose logs --tail=200 server` 或
   `journalctl -u remotebridge-server -n 200`。常见原因：
   - `EADDRINUSE`：`RELAY_PORT`（默认 3002）被占用 —— 检查是否有遗留进程或重复部署；
   - `NODE_ENV=production 拒绝启动，JWT 密钥配置不安全`：`.env`/`docker-compose.yml` 里
     `JWT_SECRET`/`JWT_REFRESH_SECRET` 缺失或太弱（P0-6 的启动校验），按报错提示用
     `openssl rand -base64 48` 重新生成；
   - 数据库文件所在磁盘写满/只读：`GET /health` 返回 `db.ok: false`，`err.message` 会带出具体
     文件系统错误。
3. **磁盘空间**：`df -h $(dirname <RB_DATA_DIR>/remotebridge.db)`。SQLite 在 WAL 模式下会产生
   `remotebridge.db-wal`/`-shm` 文件，正常情况下由 90 天保留任务（P0-5）控制增长；若磁盘已满，
   先清理无关文件腾出空间，重启 relay 后保留任务会在启动时立即执行一次。
4. **确认两端能重连**：relay 恢复后，桌面端系统托盘图标应在 ≤30s 内变绿；Web 端会自动重连
   WebSocket（无需用户操作）。若桌面端长时间未恢复，检查其本机日志中的 reconnect 退避计时器
   是否被卡住（极端情况下重启桌面端 App）。
5. **若是反向代理（Caddy）层问题**：`docker compose logs caddy`，常见为证书申请失败（出网受限/
   DNS 未生效）——本地测试可将 `DOMAIN=localhost`，Caddy 会使用内置 CA 签发自签名证书。

---

## 二、`register-host` 滥用检测与处置（P1-9）

`POST /auth/register-host` 是**未认证**端点——任何人都能调用它创建一条新的 `hosts` 行。
P1-9/P1-18 已为其加上 **5 次/分钟/IP** 的限流（`@fastify/rate-limit`），但限流只能减缓单 IP
攻击，无法防止分布式滥用，因此仍需运维侧检测与兜底处置。

### 2.1 检测信号

- **`/health` 的 `tables.hosts` 短时间内异常增长**（正常增长应与真实用户数量级一致，通常很慢）。
- relay 日志/反向代理日志中大量针对 `/api/v1/auth/register-host` 的 `429`（被限流命中）或
  短时间内同一 IP 段的大量 `201` 响应。
- 间接症状：`/auth/connect` 变慢——该端点会对所有「PIN 未过期」的 host 行做逐行 bcrypt 比较
  （`apps/server/src/routes/auth.ts` 中 `potentialHosts` 循环），host 表越大、`pin_hash`
  非空的滥用行越多，越慢。**但正常情况下滥用产生的行 `pin_hash` 恒为 `''`（从未调用过
  `/auth/generate-pin`），不会进入这个循环**——因此该症状一般只在已修复/缓解后仍有大量
  「半成品」滥用行时才需要关注。

### 2.2 临时缓解

- **收紧限流**：将 `.env`/`docker-compose.yml` 中的 `RATE_LIMIT_MAX` 调小（影响所有限流路由，
  非仅 `register-host`），或在 `apps/server/src/routes/auth.ts` 中临时把
  `RATE_LIMIT_CONFIG.REGISTER_HOST_MAX`（`packages/shared/src/security.ts`）改小后重新构建
  `@remotebridge/shared` 并重启 relay。
- **反向代理层封禁**：若能定位到具体攻击源 IP/IP 段，优先在 Caddy（`Caddyfile`）或上游防火墙
  按 IP 拦截 `/api/v1/auth/register-host`，比应用层限流更省资源。
- **数据层手动封禁**：`hosts` 表已有 `is_banned` 列，且 `/auth/connect` 的候选主机查询会过滤
  `is_banned = 0`（`apps/server/src/routes/auth.ts:189`）。目前**没有对应的管理 API**，需直接
  操作数据库（务必先停止 relay 写入或在低峰期操作，避免与 WAL checkpoint 冲突）：
  ```sql
  -- 找出疑似滥用的行：pin_hash 为空（从未生成过 PIN）且短时间内大量创建
  SELECT id, name, created_at FROM hosts
    WHERE pin_hash = '' AND created_at > unixepoch() - 3600
    ORDER BY created_at DESC;

  -- 标记为封禁（之后 /auth/connect 的候选查询会自动排除这些行）
  UPDATE hosts SET is_banned = 1 WHERE id IN ('<host-id-1>', '<host-id-2>');
  ```
- **数据清理**：确认是滥用行且无关联 `sessions`/`security_logs` 后，可直接删除以释放表空间：
  ```sql
  DELETE FROM hosts WHERE is_banned = 1
    AND id NOT IN (SELECT DISTINCT host_id FROM sessions);
  ```

> 长期方案（未实现，列入 P2/P3 backlog）：为 `register-host` 增加按 IP 的持久化计数/黑名单，
> 或要求注册时携带某种轻量凭证（如邀请码）。

---

## 三、回滚流程（P1-16）

### 3.1 前提：版本标记

截至目前（见 `CHANGELOG.md`），4 个 workspace 包仍统一锁定在 `1.0.0`，**没有 git tag/release
流程**。回滚的最小前提是**能明确指出"回滚到哪个提交"**——建议从下一次发布开始，在合并到
主分支的发布性提交上打 `git tag`（如 `v1.0.1`），并在 `CHANGELOG.md` 中记录对应的 commit/tag，
否则"回滚"只能凭 `git log` 时间线人工判断。

### 3.2 代码回滚步骤

1. **确定目标提交**：`git log --oneline` 找到回滚目标的 commit hash（或 tag）。
2. **Docker Compose 部署**：
   ```sh
   git checkout <target-commit-or-tag>
   docker compose build server web      # 重新构建镜像（多阶段构建，shared 会一并重新编译）
   docker compose up -d server web
   docker compose ps                    # 确认健康检查通过
   ```
   `caddy` 容器通常无需重建/重启。
3. **裸机 systemd 部署**（对应 `scripts/deploy-server.sh` 的产物）：
   ```sh
   git checkout <target-commit-or-tag>
   pnpm install --frozen-lockfile
   pnpm --filter @remotebridge/shared build
   pnpm --filter @remotebridge/server build
   sudo systemctl restart remotebridge-server
   ```
   建议保留上一个版本的 `apps/server/dist` 与 `packages/shared/dist` 目录的备份
   （例如 `dist.bak-<date>`），故障时可直接切换符号链接，比重新 `pnpm build` 更快。

### 3.3 数据库兼容性注意事项

- `initDatabase()` 全部使用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，是
  **仅新增（additive）**的 schema 演进方式——回滚到"本次审查之前"的代码时，旧代码会忽略
  新增的 `idx_messages_session_created`/`idx_security_logs_host_created` 索引和 `is_banned`
  之外的新列（如果未来新增列，需额外确认旧代码不会因多出的列报错；当前 better-sqlite3 + 手写
  SQL 不存在此问题）。**一般不需要手动改库即可回滚。**
- **`JWT_SECRET`/`JWT_REFRESH_SECRET` 必须保持不变**：回滚不应更换密钥，否则所有现存
  access/refresh token 立即失效，等同于强制所有用户重新用 PIN 连接。
- 若回滚目标早于 P0-1（`messages.ts` 鉴权修复）等安全修复点，**回滚本身会重新引入对应的安全
  问题**——回滚前应在 `CHANGELOG.md`「Known issues / not yet fixed」与「Unreleased」两节之间
  核对，明确这次回滚会临时放弃哪些修复，必要时缩短回滚窗口或同步采取临时缓解（如临时下线
  `/api/v1/messages/:sessionId`）。

---

## 四、已知局限

本手册覆盖 P1-22 的核心场景（崩溃恢复、`register-host` 滥用、回滚），但依赖以下尚未解决的
问题（详见 `CHANGELOG.md`「Known issues」与 `.full-review/05-final-report.md`），运维时需
额外人工判断：

- **P0-10**：无 CI，回滚/前进所用的提交未必跑过 build/lint/test。
- **P1-1**：无结构化日志/指标，本手册中的"检测"步骤大多依赖手动轮询 `/health` 与 `grep` 日志。
- **P1-14/P1-15**：`apps/server/test` 需要手动起一个 `:3099` 的 relay 才能跑，CI 接入前无法
  把"回滚前先跑测试"自动化。
- **P1-23**：桌面端无自动更新/签名分发，协议变更后的回滚/前进需要用户手动重装桌面端。
