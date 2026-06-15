/**
 * RemoteBridge 核心业务逻辑 E2E 测试
 * 测试: 认证 → PIN → 连接 → WebSocket → 消息中继 → 安全日志 → 会话管理
 *
 * 前置条件: 服务器已运行（默认 localhost:3099）
 * 运行: NODE_PATH=./node_modules npx vitest run
 *
 * 顺序依赖说明 (P2，test-and-doc-gaps-plan.md #2):
 * 下方的模块级可变状态（hostToken/hostId/clientToken/refreshToken/sessionId/pin/clientId）
 * 由本文件靠前的 it() 写入，再由跨 describe 块的靠后 it() 读取——这是有意为之的顺序依赖
 * 约定，依赖 vitest 默认按文件内 it() 声明顺序串行执行；不要为了 test.concurrent/.each
 * 重构而打乱执行顺序，否则会出现"token 为空"之类难以定位真实原因的级联失败。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import WebSocket from 'ws';

// ===== 配置 =====
const API_BASE = process.env.API_BASE || 'http://localhost:3099/api/v1';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:3099/ws';

// ===== 共享状态 =====
let hostToken = '';
let hostId = '';
let clientToken = '';
let refreshToken = '';
let sessionId = '';
let pin = '';
let clientId = '';
let clientToHostContent = '';
let hostToClientContent = '';

// ===== HTTP 工具 =====
function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const fullUrl = API_BASE + path;
    const parsed = new URL(fullUrl);
    const options: http.RequestOptions = {
      method,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ===== WebSocket 工具 =====
interface WSConnection {
  ws: WebSocket;
  messages: Array<{ type: string; payload: any; timestamp: number }>;
}

function connectWS(token: string, type: string): Promise<WSConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}?token=${token}&type=${type}`);
    const messages: WSConnection['messages'] = [];

    ws.on('open', () => {
      ws.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
      });
      resolve({ ws, messages });
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

function waitForMessage(
  conn: WSConnection,
  type: string,
  timeout = 5000,
): Promise<WSConnection['messages'][0]> {
  return new Promise((resolve, reject) => {
    // 先检查已收到的消息
    const existing = conn.messages.find((m) => m.type === type);
    if (existing) {
      resolve(existing);
      return;
    }

    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${type}`)),
      timeout,
    );
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        conn.ws.off('message', handler);
        resolve(msg);
      }
    };
    conn.ws.on('message', handler);
  });
}

function sendWS(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(
    JSON.stringify({
      id: Math.random().toString(36).slice(2),
      ...message,
      timestamp: Date.now(),
    }),
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ===== 测试套件 =====
describe('RemoteBridge 核心业务逻辑', () => {
  // --- 健康检查 ---
  describe('健康检查', () => {
    it('GET /health 返回 ok', async () => {
      const res = await request('GET', '/../../health');
      expect(res.status).toBe(200);
      expect(res.data.status).toBe('ok');
    });
  });

  // --- 认证流程 ---
  describe('认证流程', () => {
    it('注册 Host → 获取 hostId + token', async () => {
      const res = await request('POST', '/auth/register-host', {
        name: 'TestHost',
        os: 'linux',
        version: '1.0.0',
      });
      expect(res.status).toBe(201);
      expect(res.data.success).toBe(true);
      expect(res.data.data.hostId).toBeTruthy();
      expect(res.data.data.token).toBeTruthy();
      hostId = res.data.data.hostId;
      hostToken = res.data.data.token;
    });

    it('生成 PIN → 8 位字母数字', async () => {
      const res = await request(
        'POST',
        '/auth/generate-pin',
        { expiresIn: 300 },
        { Authorization: `Bearer ${hostToken}` },
      );
      expect(res.data.success).toBe(true);
      expect(res.data.data.pin).toHaveLength(8);
      expect(res.data.data.pin).toMatch(/^[A-Z2-9]{8}$/);
      pin = res.data.data.pin;
    });

    it('PIN 连接 → 获取 session + tokens', async () => {
      clientId = 'test-client-' + Date.now();
      const res = await request('POST', '/auth/connect', {
        pin,
        clientId,
        clientLabel: 'Test Device',
      });
      expect(res.data.success).toBe(true);
      expect(res.data.data.sessionId).toBeTruthy();
      expect(res.data.data.accessToken).toBeTruthy();
      expect(res.data.data.refreshToken).toBeTruthy();
      expect(res.data.data.hostInfo.hostId).toBe(hostId);
      clientToken = res.data.data.accessToken;
      refreshToken = res.data.data.refreshToken;
      sessionId = res.data.data.sessionId;
    });

    it('PIN 一次性使用 — 再次使用应 401', async () => {
      const res = await request('POST', '/auth/connect', {
        pin,
        clientId: 'another-client',
        clientLabel: 'Another Device',
      });
      expect(res.status).toBe(401);
    });

    it('无效 PIN 拒绝 — 返回 401', async () => {
      const res = await request('POST', '/auth/connect', {
        pin: 'XXXXXXXX',
        clientId: 'bad-client',
        clientLabel: 'Bad Device',
      });
      expect(res.status).toBe(401);
    });

    it('Token 刷新 → 获取新 accessToken', async () => {
      const res = await request('POST', '/auth/refresh', { refreshToken });
      expect(res.data.success).toBe(true);
      expect(res.data.data.accessToken).toBeTruthy();
      expect(res.data.data.accessToken.length).toBeGreaterThan(50);
      clientToken = res.data.data.accessToken;
    });
  });

  // --- WebSocket 连接 ---
  describe('WebSocket 连接', () => {
    let hostConn: WSConnection;
    let clientConn: WSConnection;

    afterAll(() => {
      hostConn?.ws?.close();
      clientConn?.ws?.close();
    });

    it('Host WebSocket 连接 + ACK', async () => {
      hostConn = await connectWS(hostToken, 'host');
      const ack = await waitForMessage(hostConn, 'ACK');
      expect(ack.type).toBe('ACK');
    });

    it('CLIENT_JOINED 通知 — Host 在 Client 连接前已监听', async () => {
      // 先注册 Host 的 message 监听（hostConn 已在上面建立）
      // 然后再连 Client，Host 应该收到 CLIENT_JOINED
      const clientConnLocal = await connectWS(clientToken, 'client');
      const ack = await waitForMessage(clientConnLocal, 'ACK');
      expect(ack.type).toBe('ACK');

      // Host 应收到 CLIENT_JOINED
      const joined = await waitForMessage(hostConn, 'CLIENT_JOINED', 3000);
      expect(joined.type).toBe('CLIENT_JOINED');
      expect(joined.payload?.clientId).toBeTruthy();

      clientConn = clientConnLocal;
    });

    it('消息中继 Client → Host', async () => {
      const testContent = 'Hello from client ' + Date.now();
      clientToHostContent = testContent;
      sendWS(clientConn.ws, {
        type: 'MSG_TEXT',
        payload: { content: testContent },
        sessionId,
      });

      const msg = await waitForMessage(hostConn, 'MSG_TEXT', 3000);
      expect(msg.payload?.content).toBe(testContent);
    });

    it('消息中继 Host → Client', async () => {
      const testContent = 'Hello from host ' + Date.now();
      hostToClientContent = testContent;
      // 从 CLIENT_JOINED 中获取 clientId
      const joinedMsg = hostConn.messages.find(
        (m) => m.type === 'CLIENT_JOINED',
      );
      const targetClientId = joinedMsg?.payload?.clientId;

      sendWS(hostConn.ws, {
        type: 'MSG_TEXT',
        payload: { content: testContent, clientId: targetClientId },
      });

      const msg = await waitForMessage(clientConn, 'MSG_TEXT', 3000);
      expect(msg.payload?.content).toBe(testContent);
    });

    it('心跳 PING/PONG', async () => {
      sendWS(hostConn.ws, { type: 'PING' });
      const pong = await waitForMessage(hostConn, 'PONG', 3000);
      expect(pong.type).toBe('PONG');
    });
  });

  // --- REST API ---
  describe('REST API', () => {
    it('客户端列表 API', async () => {
      const res = await request('GET', `/hosts/${hostId}/clients`, undefined, {
        Authorization: `Bearer ${hostToken}`,
      });
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);
    });

    it('消息历史 API', async () => {
      const res = await request('GET', `/messages/${sessionId}`, undefined, {
        Authorization: `Bearer ${clientToken}`,
      });
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);

      // 验证"消息中继 Client → Host"/"消息中继 Host → Client"（上方 WebSocket 连接块）
      // 写入的两条消息按正确的 content/direction 出现在历史记录中。
      // 消息内容/方向持久化的更通用保证见 session-flows.test.ts「消息持久化双向语义」。
      const clientToHostRow = res.data.data.find(
        (m: any) => m.content === clientToHostContent,
      );
      expect(clientToHostRow).toBeTruthy();
      expect(clientToHostRow.direction).toBe('client_to_host');

      const hostToClientRow = res.data.data.find(
        (m: any) => m.content === hostToClientContent,
      );
      expect(hostToClientRow).toBeTruthy();
      expect(hostToClientRow.direction).toBe('host_to_client');
    });

    it('消息历史 API — since 参数仅返回更新的消息', async () => {
      // 跨越秒级边界，确保新消息的 createdAt 严格大于上面两条已存在消息的 createdAt
      // （/messages 用 gt(createdAt, since) 严格比较，同秒会被误排除）
      await wait(1100);
      const sinceTs = Math.floor(Date.now() / 1000);
      await wait(1100);

      const newClientMsg = 'since-test client ' + Date.now();
      const newHostMsg = 'since-test host ' + Date.now();
      await request('POST', `/messages/${sessionId}`, { content: newClientMsg }, {
        Authorization: `Bearer ${clientToken}`,
      });
      await request('POST', `/messages/${sessionId}`, { content: newHostMsg }, {
        Authorization: `Bearer ${hostToken}`,
      });

      const res = await request(
        'GET',
        `/messages/${sessionId}?since=${sinceTs}&limit=50`,
        undefined,
        { Authorization: `Bearer ${clientToken}` },
      );
      expect(res.data.success).toBe(true);
      const contents = res.data.data.map((m: any) => m.content);
      expect(contents).toContain(newClientMsg);
      expect(contents).toContain(newHostMsg);
      expect(contents).not.toContain(clientToHostContent);
      expect(contents).not.toContain(hostToClientContent);
    });

    it('消息历史 API — limit/page 分页', async () => {
      const page1 = await request(
        'GET',
        `/messages/${sessionId}?limit=1&page=1`,
        undefined,
        { Authorization: `Bearer ${clientToken}` },
      );
      const page2 = await request(
        'GET',
        `/messages/${sessionId}?limit=1&page=2`,
        undefined,
        { Authorization: `Bearer ${clientToken}` },
      );
      expect(page1.data.success).toBe(true);
      expect(page2.data.success).toBe(true);
      expect(page1.data.data).toHaveLength(1);
      expect(page2.data.data).toHaveLength(1);
      expect(page1.data.data[0].id).not.toBe(page2.data.data[0].id);
    });

    it('安全日志 API', async () => {
      const res = await request('GET', '/security-logs', undefined, {
        Authorization: `Bearer ${hostToken}`,
      });
      expect(res.data.success).toBe(true);
      expect(res.data.data.total).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(res.data.data.logs)).toBe(true);

      // PIN 连接流程（"PIN 连接 → 获取 session + tokens"）应已写入一条
      // SESSION_CREATED 事件，eventType 值需与 EVENT_TYPE_LABELS
      // (packages/shared/src/security-log-ui.ts) 中的合法枚举一致。
      const sessionCreatedLog = res.data.data.logs.find(
        (l: any) => l.eventType === 'SESSION_CREATED' && l.clientId === clientId,
      );
      expect(sessionCreatedLog).toBeTruthy();
      expect(sessionCreatedLog.hostId).toBe(hostId);
      expect(typeof sessionCreatedLog.createdAt).toBe('number');
    });

    it('安全日志 API — eventType 筛选', async () => {
      const res = await request(
        'GET',
        '/security-logs?eventType=SESSION_CREATED',
        undefined,
        { Authorization: `Bearer ${hostToken}` },
      );
      expect(res.data.success).toBe(true);
      expect(res.data.data.total).toBeGreaterThanOrEqual(1);
      for (const log of res.data.data.logs) {
        expect(log.eventType).toBe('SESSION_CREATED');
      }
    });

    it('安全日志 API — clientId 筛选', async () => {
      const res = await request(
        'GET',
        `/security-logs?clientId=${clientId}`,
        undefined,
        { Authorization: `Bearer ${hostToken}` },
      );
      expect(res.data.success).toBe(true);
      expect(res.data.data.total).toBeGreaterThanOrEqual(1);
      for (const log of res.data.data.logs) {
        expect(log.clientId).toBe(clientId);
      }
    });

    it('安全日志 API — 日期范围筛选', async () => {
      const now = Math.floor(Date.now() / 1000);

      // 一个包含当前时间的范围 → 应能查到刚写入的 SESSION_CREATED
      const within = await request(
        'GET',
        `/security-logs?startDate=${now - 3600}&endDate=${now + 3600}`,
        undefined,
        { Authorization: `Bearer ${hostToken}` },
      );
      expect(within.data.success).toBe(true);
      expect(within.data.data.total).toBeGreaterThanOrEqual(1);

      // 一个完全位于过去的范围 → 应该排除所有记录
      const before = await request(
        'GET',
        `/security-logs?startDate=${now - 7200}&endDate=${now - 3600}`,
        undefined,
        { Authorization: `Bearer ${hostToken}` },
      );
      expect(before.data.success).toBe(true);
      expect(before.data.data.total).toBe(0);
    });

    it('GET /security-logs/events 返回非空事件类型列表', async () => {
      const res = await request('GET', '/security-logs/events', undefined, {
        Authorization: `Bearer ${hostToken}`,
      });
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);
      expect(res.data.data.length).toBeGreaterThan(0);
      expect(res.data.data).toContain('SESSION_CREATED');
    });
  });

  // --- 会话管理 ---
  describe('会话管理', () => {
    it('会话吊销', async () => {
      const res = await request(
        'DELETE',
        `/auth/revoke/${sessionId}`,
        undefined,
        { Authorization: `Bearer ${hostToken}` },
      );
      expect(res.data.success).toBe(true);
    });

    it('吊销后 Token 刷新失败 → 401', async () => {
      const res = await request('POST', '/auth/refresh', { refreshToken });
      expect(res.status).toBe(401);
    });
  });
});
