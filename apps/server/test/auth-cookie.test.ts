/**
 * TST-C1: POST /auth/refresh cookie vs. Bearer 路径行为验证 (SEC-C1)
 *
 * 安全要点: 02a-S11 之后 Web 端 token 仅存于 httpOnly cookie，
 * cookie-path 刷新的响应体不得包含明文 accessToken（防 XSS 读取）。
 * Bearer-path（桌面端）继续在 body 中返回新 token（向后兼容）。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { API_BASE, createSession } from './helpers';

describe('POST /auth/refresh — cookie vs. Bearer 路径 (TST-C1 / SEC-C1)', () => {
  let refreshToken: string;

  beforeAll(async () => {
    const session = await createSession('tst-c1');
    refreshToken = session.refreshToken;
  });

  it('cookie-path: body.data.accessToken 为空串，新 token 仅通过 Set-Cookie 下发', async () => {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 手动设置 Cookie 头模拟浏览器的 httpOnly cookie 刷新路径
        Cookie: `rb_refresh=${encodeURIComponent(refreshToken)}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // SEC-C1 核心断言: cookie-path 不能在响应体中泄露真实 JWT
    const tokenInBody: string = body.data?.accessToken ?? '';
    expect(tokenInBody).toBe('');           // 应为空串
    expect(tokenInBody).not.toMatch(/^ey/); // 不得是真实 JWT（base64 编码的 header 以 "ey" 开头）

    // 新的 rb_access 仍必须通过 Set-Cookie 正确下发
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c: string) => c.startsWith('rb_access='))).toBe(true);
  });

  it('body-path: body.data.accessToken 包含真实 JWT（桌面端/旧客户端兼容路径不受影响）', async () => {
    // 非 cookie 路径：刷新令牌放在请求体里（Host 端 / Legacy 客户端的向后兼容路径）
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Bearer-path 应在 body 中返回真实 JWT（供桌面端存入 electron-store）
    const tokenInBody: string = body.data?.accessToken ?? '';
    expect(tokenInBody).toMatch(/^ey/);
    expect(tokenInBody.length).toBeGreaterThan(50);
  });
});
