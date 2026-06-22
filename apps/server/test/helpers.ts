// 共享测试工具 (P1-14)：HTTP/WS 辅助函数 + 会话建立，供移植自 manual-*.mjs 的测试文件复用
import WebSocket from 'ws';

export const API_BASE = process.env.API_BASE || 'http://localhost:3099/api/v1';
export const WS_BASE = process.env.WS_BASE || 'ws://localhost:3099/ws';

export function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<any> {
  return fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

// 从 Set-Cookie 中取指定 cookie 的值；用于 02a-S11 之后 /auth/connect 不再在 body 回显 token 的场景
function extractCookie(setCookies: string[], name: string): string {
  const header = setCookies.find((c) => c.startsWith(`${name}=`));
  if (!header) throw new Error(`Set-Cookie 中未找到 ${name}`);
  return decodeURIComponent(header.split(';')[0].slice(name.length + 1));
}

// 同 post()，但同时返回 Set-Cookie 中的 rb_access/rb_refresh —— /auth/connect、/auth/refresh
// 的 cookie 路径用这个而不是 post()，因为 token 不再出现在 body 里
export async function postWithCookies(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ data: any; accessToken: string; refreshToken: string }> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const setCookies = res.headers.getSetCookie();
  const data = await res.json();
  return {
    data,
    accessToken: extractCookie(setCookies, 'rb_access'),
    refreshToken: extractCookie(setCookies, 'rb_refresh'),
  };
}

export function openWs(token: string, type: 'host' | 'client'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}?token=${token}&type=${type}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

export function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface TestSession {
  hostId: string;
  hostToken: string;
  clientId: string;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}

// 注册 Host + 生成 PIN + Client 连接，返回一组可用于 WS 鉴权的凭据。
// 受 REGISTER_HOST_MAX (5/分钟/IP) 限制，调用方应尽量复用同一会话。
export async function createSession(namePrefix: string): Promise<TestSession> {
  const reg = await post('/auth/register-host', {
    name: `${namePrefix}-host`,
    os: 'win32',
    version: '1.0.0',
  });
  const { hostId, token: hostToken } = reg.data;

  const pinResp = await post(
    '/auth/generate-pin',
    { expiresIn: 300 },
    { Authorization: `Bearer ${hostToken}` },
  );
  const clientId = `${namePrefix}-client-${Date.now()}`;
  const { data: conn, accessToken, refreshToken } = await postWithCookies(
    '/auth/connect',
    { pin: pinResp.data.pin, clientId, clientLabel: namePrefix },
  );
  const { sessionId } = conn.data;

  return { hostId, hostToken, clientId, sessionId, accessToken, refreshToken };
}

// 等待 ws 收到第一条满足 predicate 的消息（JSON 解析后）
export function waitForMessage(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  timeoutMs = 5000,
  timeoutMsg = '等待消息超时',
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(timeoutMsg));
    }, timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// 等待 ws 关闭，返回关闭码；同时吞掉握手期可能先触发的 error 事件
export function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待连接关闭超时')), timeoutMs);
    ws.on('error', () => {});
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
