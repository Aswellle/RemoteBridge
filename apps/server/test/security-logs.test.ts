/**
 * POST/GET /security-logs, GET /access-logs (P0-2)
 * 验证: Host 可上报访问/安全事件；非法 eventType 被拒绝；非 Host token 被拒绝；
 *       ACCESS 事件能正确出现在 /access-logs 中并解析出 action/path/status
 *
 * 前置条件: 服务器已运行（默认 localhost:3099）
 * 运行: pnpm --filter @remotebridge/server test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import http from 'http';

const API_BASE = process.env.API_BASE || 'http://localhost:3099/api/v1';

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any; headers: http.IncomingHttpHeaders }> {
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
          resolve({ status: res.statusCode!, data: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode!, data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 从 Set-Cookie 中取指定 cookie 的值（02a-S11 之后 /auth/connect 不再在 body 回显 token）
function extractCookie(setCookie: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const header = headers.find((c) => c.startsWith(`${name}=`));
  if (!header) throw new Error(`Set-Cookie 中未找到 ${name}`);
  return decodeURIComponent(header.split(';')[0].slice(name.length + 1));
}

describe('POST/GET /security-logs, GET /access-logs (P0-2)', () => {
  let hostToken = '';
  let accessToken = '';
  const testClientId = 'security-logs-test-client-' + Date.now();

  beforeAll(async () => {
    const reg = await request('POST', '/auth/register-host', {
      name: 'SecurityLogsTestHost',
      os: 'linux',
      version: '1.0.0',
    });
    hostToken = reg.data.data.token;

    const pinRes = await request(
      'POST',
      '/auth/generate-pin',
      { expiresIn: 300 },
      { Authorization: `Bearer ${hostToken}` },
    );
    const pin = pinRes.data.data.pin;

    const connectRes = await request('POST', '/auth/connect', {
      pin,
      clientId: testClientId,
      clientLabel: 'Security Logs Test',
    });
    accessToken = extractCookie(connectRes.headers['set-cookie'], 'rb_access');
  });

  it('Host 可上报 ACCESS 事件（正常访问）', async () => {
    const res = await request(
      'POST',
      '/security-logs',
      { eventType: 'ACCESS', clientId: testClientId, action: 'LIST_DIR', path: '/home/test', status: 'OK' },
      { Authorization: `Bearer ${hostToken}` },
    );
    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
  });

  it('Host 可上报 ACCESS 事件（被拒绝的隧道访问）', async () => {
    const res = await request(
      'POST',
      '/security-logs',
      { eventType: 'ACCESS', clientId: testClientId, action: 'TUNNEL_FETCH', path: '/etc/passwd', status: 'BLOCKED' },
      { Authorization: `Bearer ${hostToken}` },
    );
    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
  });

  it('拒绝非法 eventType', async () => {
    const res = await request(
      'POST',
      '/security-logs',
      { eventType: 'FORGED_EVENT', clientId: testClientId },
      { Authorization: `Bearer ${hostToken}` },
    );
    expect(res.status).toBe(400);
    expect(res.data.error?.code).toBe('INVALID_EVENT_TYPE');
  });

  it('拒绝缺少认证令牌的请求', async () => {
    const res = await request('POST', '/security-logs', { eventType: 'ACCESS', clientId: testClientId });
    expect(res.status).toBe(401);
    expect(res.data.error?.code).toBe('UNAUTHORIZED');
  });

  it('拒绝使用 Client token 上报（仅限 Host）', async () => {
    const res = await request(
      'POST',
      '/security-logs',
      { eventType: 'ACCESS', clientId: testClientId, action: 'LIST_DIR', status: 'OK' },
      { Authorization: `Bearer ${accessToken}` },
    );
    expect(res.status).toBe(401);
    expect(res.data.error?.code).toBe('INVALID_TOKEN');
  });

  it('GET /security-logs：rb_access cookie 鉴权同样可用，无需 Authorization 头（02a-S11 后 Web 端安全审计页的实际调用方式）', async () => {
    const res = await request(
      'GET',
      `/security-logs?eventType=ACCESS&clientId=${testClientId}`,
      undefined,
      { Cookie: `rb_access=${accessToken}` },
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.logs.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /security-logs 可查询到上报的 ACCESS 事件', async () => {
    const res = await request(
      'GET',
      `/security-logs?eventType=ACCESS&clientId=${testClientId}`,
      undefined,
      { Authorization: `Bearer ${hostToken}` },
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.logs.length).toBeGreaterThanOrEqual(2);
    expect(res.data.data.logs.every((l: any) => l.eventType === 'ACCESS')).toBe(true);
  });

  it('GET /access-logs 正确解析 ACCESS 事件的 action/path/status', async () => {
    const res = await request('GET', '/access-logs?limit=50', undefined, {
      Authorization: `Bearer ${hostToken}`,
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    const logs = res.data.data as Array<{ clientId: string; action: string; path?: string; status: string }>;
    const blocked = logs.find((l) => l.clientId === testClientId && l.action === 'TUNNEL_FETCH');
    const ok = logs.find((l) => l.clientId === testClientId && l.action === 'LIST_DIR');

    expect(blocked).toBeDefined();
    expect(blocked?.status).toBe('BLOCKED');
    expect(blocked?.path).toBe('/etc/passwd');

    expect(ok).toBeDefined();
    expect(ok?.status).toBe('OK');
    expect(ok?.path).toBe('/home/test');
  });
});
