/**
 * GET/POST /messages/:sessionId 鉴权边界测试 (P0-1)
 * 验证: refresh token 不能当作 messages API 凭据；会话被吊销后旧 access token 立即失效
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

describe('GET/POST /messages/:sessionId — 鉴权边界 (P0-1)', () => {
  let hostToken = '';
  let accessToken = '';
  let refreshToken = '';
  let sessionId = '';

  beforeAll(async () => {
    const reg = await request('POST', '/auth/register-host', {
      name: 'MessagesAuthTestHost',
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
      clientId: 'messages-auth-test-client-' + Date.now(),
      clientLabel: 'Messages Auth Test',
    });
    accessToken = connectRes.data.data.accessToken;
    refreshToken = connectRes.data.data.refreshToken;
    sessionId = connectRes.data.data.sessionId;
  });

  it('合法 access token 可正常读取消息历史', async () => {
    const res = await request('GET', `/messages/${sessionId}`, undefined, {
      Authorization: `Bearer ${accessToken}`,
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it('拒绝将 refresh token 当作 messages API 凭据 (GET)', async () => {
    const res = await request('GET', `/messages/${sessionId}`, undefined, {
      Authorization: `Bearer ${refreshToken}`,
    });
    expect(res.status).toBe(401);
    expect(res.data.error?.code).toBe('INVALID_TOKEN');
  });

  it('拒绝将 refresh token 当作 messages API 凭据 (POST)', async () => {
    const res = await request('POST', `/messages/${sessionId}`, { content: 'hi' }, {
      Authorization: `Bearer ${refreshToken}`,
    });
    expect(res.status).toBe(401);
    expect(res.data.error?.code).toBe('INVALID_TOKEN');
  });

  it('会话吊销后，旧 access token 读取消息历史返回 403 SESSION_REVOKED', async () => {
    const revoke = await request(
      'DELETE',
      `/auth/revoke/${sessionId}`,
      undefined,
      { Authorization: `Bearer ${hostToken}` },
    );
    expect(revoke.data.success).toBe(true);

    const res = await request('GET', `/messages/${sessionId}`, undefined, {
      Authorization: `Bearer ${accessToken}`,
    });
    expect(res.status).toBe(403);
    expect(res.data.error?.code).toBe('SESSION_REVOKED');
  });

  it('会话吊销后，旧 access token 通过 POST 发送消息也返回 403 SESSION_REVOKED', async () => {
    const res = await request('POST', `/messages/${sessionId}`, { content: 'hi' }, {
      Authorization: `Bearer ${accessToken}`,
    });
    expect(res.status).toBe(403);
    expect(res.data.error?.code).toBe('SESSION_REVOKED');
  });
});
