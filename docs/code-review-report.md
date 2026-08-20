# RemoteBridge 核心业务逻辑审查报告

> 审查日期:2026-06-11
> 范围:全仓库(relay 服务端 / Electron 桌面端 / Next.js Web 端 / shared 协议包)
> 方法:全量代码走查 + 端到端数据流追踪 + 集成测试验证(17 个 e2e 用例 + 专项全链路路由验证脚本)

## 总评

项目的架构设计(中继房间模型、双重路径校验、单次下载令牌)是合理的,但**实现层存在两个致命的业务断点**:桌面端不持久化主机身份导致连接码体系名存实亡;中继路由字段在协议各层之间互相丢失导致文件浏览/下载/预览全链路不可用。以下按严重程度列出全部发现,均已修复(除"遗留事项"一节)。

---

## 一、致命问题(P0 —— 核心业务流程不可用)

### 1.1 桌面端不生成/复用自身唯一身份,每次连接都注册新主机 ✅已修复

**用户报告的核心问题。**

- 桌面端启动后处于"未连接"状态,不会自动连接 Relay;必须手动点击"连接到 Relay 服务器"。
- 点击后 `auth:register-host` IPC **无条件调用 `POST /auth/register-host`**,每次都生成全新的 hostId/secret/token——尽管 `config store` 早已实现了 `hostId/hostToken` 的持久化读写,但**保存的身份从未被读取复用**(`apps/desktop/src/main/ipc/auth.ts`)。

**后果链:**
1. 每次启动/重连都在 relay 数据库新增一行主机记录,无限膨胀;
2. 主机身份不稳定 → 旧会话绑定的 hostId 随主机重启永久失效,Web 端已保存的会话/历史记录全部作废;
3. `/auth/connect` 对全表做 bcrypt 比对(见 3.1),主机表膨胀使 PIN 验证越来越慢,形成复合恶化;
4. "生成连接码"按钮藏在手动连接成功之后,与产品预期(桌面端自动就绪、随时出码)不符。

**修复**(`ipc/auth.ts` 重写 + `index.ts`):
- 新增 `ensureHostRegisteredAndConnected()`:优先复用持久化身份(经 `GET /hosts/:id/clients` 校验有效性,401/403 才重新注册),保证主机身份全生命周期唯一;
- 应用启动时(`app.whenReady`)自动注册/连接,UI 不再是必经入口;
- 新增 `auth:disconnect` / `relay:get-status` IPC;渲染端启动时查询真实连接状态。

### 1.2 中继路由字段全链路丢失,文件浏览/下载/预览完全不可用 ✅已修复

**比 PIN 问题更严重的隐藏断点。** 三处实现互相不兼容:

1. Web 端发送 `CMD_LIST_DIR`,路由信息(sessionId)只在**消息顶层**;
2. Relay 转发时把 `senderId` 加在**顶层**(`relay.ts: relayMessage`);
3. 桌面端 `RelayClient.handleMessage` 只把 **`message.payload`** 传给处理器——顶层的 senderId/sessionId 对处理器**不可见**,所以 `dir-handlers.ts` 解构出的 `clientId` 恒为 `undefined`;
4. 桌面端回复 `RESP_DIR_LIST` 时 payload 只含 `requestId`,顶层 sessionId 也为空;
5. 服务端 `handler.ts` 的 RESP 分支依赖 `payload.clientId || message.sessionId` 路由 → 两者皆空 → **响应被静默丢弃,连错误都不回**。

**后果:** Web 端列目录永远转圈直到超时;下载/预览 30s/15s 超时报错。唯一能工作的是 REST 代理路径(`routes/proxy.ts` 自己注入 clientId 并直接在 socket 上监听),但 Web 端必须先收到 WS 的 `RESP_DOWNLOAD_READY` 才会构造代理 URL——死锁。**审计日志和下载令牌的 clientId 也全部记成 undefined。**

**修复:**
- `relay.ts`:转发 CMD_* 时把 `clientId/sessionId/senderId/senderType` **注入 payload**(Host 处理器唯一可见的位置);
- `dir-handlers.ts`:新增 `withRouting()` 辅助,所有 RESP_* 回显 `clientId/sessionId`,顶层同时带 sessionId;
- shared 包新增 `RelayRoutingFields` 接口并在各 payload 类型上声明,**把路由契约固化进协议**;
- 已用专项脚本验证:CMD→注入→回显→RESP 成功路由回 Client。

### 1.3 Web 端文件浏览入口用浏览器自身平台猜 Host 根目录 ✅已修复

`files/page.tsx` 初始加载用 `navigator.platform.includes('Win') ? 'C:\\' : '/'`——这是**浏览器设备**的平台,不是 Host 的;且盘符根目录几乎必然不在白名单内,即使路由修好,首屏也必然是"目录未授权"错误。

**修复:**
- 桌面端新增 `CMD_LIST_ALLOWED` 处理器(此前该消息类型在协议中存在、服务端会转发,但**桌面端无人响应**),返回共享目录白名单(复用 `RESP_DIR_LIST`,`path: null` 表示根列表);
- Web 端新增 `listAllowed()` action 作为文件浏览入口;面包屑首级固定为"共享目录"。

### 1.4 Web 端刷新页面会话即丢失 ✅已修复

会话三件套写入了 localStorage,但 store 初始化从不读取。刷新 dashboard → store 全空 → 显示"未连接",必须重新生成 PIN(而 PIN 是一次性的,等于每次刷新都要去主机端重新出码)。

**修复:** `app-store.ts` 初始 state 从 localStorage 恢复(`loadPersistedSession()`);dashboard layout 挂载时若有 accessToken 自动重建 WS 连接。

---

## 二、安全问题(P1)

### 2.1 Refresh token 可直接冒充 access token ✅已修复

access/refresh 用同一密钥、同一 payload 结构签发,无任何区分字段。30 天有效期的 refresh token 可直接用于 WS 连接和所有 REST API,2 小时的 access 过期形同虚设(`.env.example` 中的 `JWT_REFRESH_SECRET` 从未被代码使用)。

**修复:** refresh token 增加 `use: 'refresh'` 声明;新增 `verifyAccessToken()` 拒绝带该标记的 token,替换 WS 握手、hosts、proxy、generate-pin、revoke 全部校验点;`/auth/refresh` 反向要求必须携带该标记(access token 不可用于刷新)。已验证:refresh token 连 WS 被 4001 拒绝。

### 2.2 下载令牌永不过期、永不清理(秒/毫秒混用)✅已修复

`createDownloadToken` 写入**毫秒**时间戳,而 `validateDownloadToken` 与 `cleanExpiredTokens` 按**秒**比较——毫秒值恒大于秒值,"30 分钟过期"完全失效,令牌表无限增长。(幸有 `download_count >= 1` 单次使用兜底。)

**修复:** 数据库统一存 Unix 秒。

### 2.3 PIN 使用非加密随机源 ✅已修复

`generatePin` 用 `Math.random()` 生成连接凭证,可预测。**修复:** 改用 `crypto.getRandomValues`(Node 18+/浏览器通用)+ rejection sampling 消除取模偏差。

### 2.4 下载权限检查存在前缀匹配漏洞 ✅已修复

`dir-handlers.ts` 判断下载权限用裸 `filePath.startsWith(d.path)`,`C:\Data` 会误匹配 `C:\DataEvil\...`——与 path-guard 精心实现的"前缀+分隔符"匹配不一致。路径本身仍受白名单兜底,但权限级别(只读 vs 可下载)可被绕过。**修复:** 改为 `path.resolve` + 分隔符匹配,与 path-guard 对齐。

---

## 三、通信与性能问题(P2)

### 3.1 `/auth/connect` 对全表做 bcrypt 扫描 ✅已修复

WHERE 条件中两个关键过滤(`pin_hash` 非空、未过期)只写了注释没写代码,导致对**所有未封禁主机**逐行执行 bcrypt 比较(每次约 100ms 级)。与 1.1 的主机表膨胀复合后是潜在 DoS 点。**修复:** SQL 层补上 `ne(pinHash,'') AND (pinExpiresAt IS NULL OR > now)`。

### 3.2 服务端 PONG 不回显 id,RTT 测量恒为 0 ✅已修复

桌面端用带 id 的 PING 测 RTT,服务端回 PONG 时丢弃 id 并生成新 id → `pendingPings` 永不匹配:UI 延迟显示恒 0,Map 只增不减(内存泄漏)。**修复:** PONG 回显请求 id;桌面端另加 30s 未应答清理。已验证。

### 3.3 重连竞态:旧连接关闭事件误删新连接 ✅已修复

Host/Client 快速重连时,新连接覆盖房间 Map 后,旧 socket 的 `close` 事件无条件 `delete` —— 把**新连接**从房间里删掉,主机看似在线实则不可达。**修复:** close 时校验 Map 中登记的是否为当前 socket;心跳超时分支只 `close()` 不再直接删 Map(统一由 close 事件清理,消除双重删除)。

### 3.4 桌面端重连 10 次后永久放弃 ✅已修复

Host 是常驻代理,10 次失败(约几分钟)后停止重连等于永久离线且无人知晓。**修复:** 无限重连(指数退避封顶 30s 不变);连接关闭时同步停止 PING 循环。

### 3.5 Web 端 WS 重连使用构造时的 token 快照 ✅已修复

token 刷新后,重连仍用旧 token → 2 小时后所有重连必然 4001。**修复:** 每次连接时从 store/localStorage 读最新 token。

### 3.6 Web 端 WS manager 组件级实例化 ✅已修复

`useWebSocket` 的 manager 挂在组件 ref 上且卸载即断开:多个页面调用会建多条连接;从文件页切到消息页时共享连接被杀。**修复:** 模块级单例,显式断开才销毁。

### 3.7 服务端速率限制 Map 无清理 ✅已修复

`ipRequestCounts` 只增不减。**修复:** 5 分钟周期清理过期项(`unref` 不阻塞退出)。

---

## 四、表现力 / UX 问题

| 问题 | 状态 |
|---|---|
| Web"最近连接"点击后把 **hostId 填进 PIN 输入框**(hostId 是 21 位 nanoid,根本不是连接码),并把主机名写进"设备名称" | ✅ 改为提示"请在主机端生成新连接码" |
| 桌面端"断开连接"按钮只重置 UI,WS 实际仍连着(显示"未连接"但远端仍可访问文件)| ✅ 新增 `auth:disconnect` IPC 真正断开 |
| 桌面端连接状态丢失 error 态(error 被显示为"未连接")| ✅ 保留 error 状态显示"连接失败" |
| 桌面端启动后 UI 不反映主进程自动连接结果 | ✅ 挂载时查询 `relay:get-status` |
| Web 收到主机离线无任何提示,目录加载永久转圈 | ✅ 处理 `HOST_OFFLINE`:停止加载并插入系统消息 |
| Web 消息方向判断读错字段(`payload.senderId` 实际在顶层),主机发来的消息显示为自己发的 | ✅ 改判 `senderType === 'host'`(双位置兼容) |
| `useWebSocket` 全局 handler 对 `RESP_DOWNLOAD_READY` 直接用 `127.0.0.1` URL 触发下载,与 `useDownload`(带代理改写)重复且必然失败 | ✅ 移除重复处理,统一由 `useDownload` 负责 |

---

## 五、架构评价(未改动,供决策参考)

**合理之处:**
- 中继房间模型清晰,relay 不落盘文件、按 sessionId 转发,职责单一;
- 双重路径校验(共享黑名单 + 白名单 + `resolve` + 分隔符匹配)是教科书式实现;
- 下载走"WS 发令牌 URL + 本地文件服务器 + 可选 relay 代理"的设计支持 Range/断点续传。

**结构性风险(遗留,未在本次修复):**
1. **房间状态纯内存** → 只能单实例部署(CLAUDE.md 已声明);relay 重启所有连接需重建,但 Host/Web 均有重连机制兜底。
2. **`routes/proxy.ts` 给每个代理请求在 hostWs 上挂临时 message 监听器**,高并发下载下监听器数量与请求数成正比,且与 relay 正常路由耦合;建议改为统一的 pending-request 注册表。
3. **WS 握手不校验会话是否已吊销**:吊销只阻断 refresh,已签发的 access token 在 2h 内仍可建 WS 连接。建议握手时查询 `sessions.revokedAt` 并在吊销时主动断开对应 socket(吊销通知的 TODO 也未实现——`notifyClient` 已存在但 `auth.ts` 的 revoke 路由没调用)。
4. **消息持久化双轨**(relay SQLite 存 `messages` 表 + 桌面端本地 `local_messages`)无去重/同步语义,direction 语义两边各自为政。
5. Web 端 `clientId` 每次连接随机生成(`crypto.randomUUID()`),"信任客户端"功能(`connected_clients.is_trusted`)永远无法命中同一设备;建议 clientId 持久化到 localStorage。
6. `JWT_REFRESH_SECRET` 环境变量已定义但未使用;长期建议 access/refresh 分密钥。

---

## 六、验证记录

| 验证项 | 结果 |
|---|---|
| `pnpm --filter @remotebridge/shared build` | ✅ 通过 |
| 服务端 `tsc --noEmit` | ✅ 通过 |
| 服务端 e2e 套件(17 用例:认证/PIN/中继/心跳/吊销/刷新)| ✅ 17/17 通过 |
| 专项全链路脚本(`test/manual-relay-roundtrip.mjs`):CMD_LIST_DIR 路由注入 → Host 回显 → RESP 路由回 Client;refresh token WS 拒绝;PONG id 回显 | ✅ 全部通过 |
| `next build`(web)| ✅ 通过(9/9 页面) |
| `electron-vite build`(desktop)| ✅ 通过(main/preload/renderer) |
