/**
 * POST /auth/host-token-refresh — Host JWT 轮换端点测试 (02a-S13)
 * 验证：有效 token 换取新 token；无效/缺失 token 被拒绝。
 *
 * 注意：该端点只校验 JWT 签名，不查询 DB，
 * 所以测试直接用 DEFAULT_JWT_SECRET 签发合成 token，无需调用 register-host
 * （register-host 每分钟限 5 次，与其它测试文件共享，避免触发 429）。
 */

import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { API_BASE, post } from './helpers.js';

// 测试环境 relay 使用的默认签名密钥（globalSetup 不覆盖 JWT_SECRET）
const TEST_JWT_SECRET = process.env.JWT_SECRET || 'remotebridge-dev-secret-change-in-production';

function makeHostToken(hostId: string, expiresIn = '90d'): string {
  return jwt.sign({ sub: hostId, type: 'host' }, TEST_JWT_SECRET, { expiresIn });
}

async function refresh(token?: string): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API_BASE + '/auth/host-token-refresh', {
    method: 'POST',
    headers,
    body: '{}',
  });
  return { status: res.status, data: await res.json() };
}

describe('POST /auth/host-token-refresh (02a-S13)', () => {
  const fakeHostId = 'test-host-rotation-01';

  it('有效 host token → 返回新 token 及 expiresAt', async () => {
    const token = makeHostToken(fakeHostId);
    const res = await refresh(token);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(typeof res.data.data.token).toBe('string');
    expect(typeof res.data.data.expiresAt).toBe('number');

    // 新 token 应当可被验证，且 exp 在未来（约 90d）
    const payload = jwt.decode(res.data.data.token) as { exp: number; type: string };
    expect(payload.type).toBe('host');
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 85 * 86400);
  });

  it('新 token 的 hostId 与旧 token 相同（不改变主机身份）', async () => {
    const token = makeHostToken(fakeHostId);
    const res = await refresh(token);
    const newPayload = jwt.decode(res.data.data.token) as { sub: string };
    expect(newPayload.sub).toBe(fakeHostId);
  });

  it('无 token → 401 MISSING_TOKEN', async () => {
    const res = await refresh();
    expect(res.status).toBe(401);
    expect(res.data.error.code).toBe('MISSING_TOKEN');
  });

  it('伪造/损坏 token → 401 INVALID_TOKEN', async () => {
    const res = await refresh('invalid.token.here');
    expect(res.status).toBe(401);
    expect(res.data.error.code).toBe('INVALID_TOKEN');
  });
});
