// TST-CORS: @fastify/cors 来源白名单回归测试。
//
// 策略定义在 utils/cors.ts（validateOrigin）：
//   - 白名单（默认 localhost:3000、localhost:9666，或 ALLOWED_ORIGINS 环境变量）→ 反射 Origin + 允许凭据
//   - 任意 localhost:*（含 127.0.0.1）                         → 放行（开发友好）
//   - 其它来源                                              → 拒绝（响应不带 ACAO，浏览器会拦截）
//   - 无 Origin 头（非浏览器客户端）                         → 放行
//

import { describe, it, expect } from 'vitest';
import { API_BASE } from './helpers';

// 把 fetch 的 Headers 转成普通对象，便于断言
function headersToObj(headers: Headers): Record<string, string | null> {
  const obj: Record<string, string | null> = {};
  headers.forEach((v, k) => {
    obj[k] = v;
  });
  return obj;
}

describe('CORS 来源白名单 (TST-CORS)', () => {
  // 用一个无需鉴权的 GET 端点做探测：/health（CORS 插件全局注册，所有路由生效）
  const HEALTH = API_BASE.replace('/api/v1', '') + '/health';

  it('白名单来源（http://localhost:3000）→ 反射 Origin 并允许凭据', async () => {
    const res = await fetch(HEALTH, { headers: { Origin: 'http://localhost:3000' } });
    expect(res.status).toBe(200);
    const h = headersToObj(res.headers);
    expect(h['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(h['access-control-allow-credentials']).toBe('true');
  });

  it('localhost 任意端口（http://localhost:5173）→ 放行并反射', async () => {
    const res = await fetch(HEALTH, { headers: { Origin: 'http://localhost:5173' } });
    expect(res.status).toBe(200);
    const h = headersToObj(res.headers);
    expect(h['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(h['access-control-allow-credentials']).toBe('true');
  });

  it('127.0.0.1 来源 → 同 localhost，放行', async () => {
    const res = await fetch(HEALTH, { headers: { Origin: 'http://127.0.0.1:3000' } });
    expect(res.status).toBe(200);
    const h = headersToObj(res.headers);
    expect(h['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
  });

  it('非白名单来源（https://evil.example.com）→ 拒绝：响应不带 ACAO', async () => {
    const res = await fetch(HEALTH, { headers: { Origin: 'https://evil.example.com' } });
    // @fastify/cors 在回调抛错时返回 500，且不带 Access-Control-Allow-Origin ——
    // 浏览器据此拦截响应。关键断言：ACAO 未反射该恶意来源。
    const h = headersToObj(res.headers);
    // headersToObj 对不存在的头返回 undefined；这里只要确认 ACAO 未反射恶意来源即可
    expect(h['access-control-allow-origin']).not.toBe('https://evil.example.com');
    expect(h['access-control-allow-origin']).toBeFalsy();
  });

  it('无 Origin 头（非浏览器客户端）→ 放行，正常返回 200', async () => {
    const res = await fetch(HEALTH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('API 路由同样遵循白名单（带鉴权头的预检/实际请求）', async () => {
    // 探测一个需要鉴权的 POST 路由：即使后续被 401 拒绝，CORS 头仍应按来源策略生效。
    const res = await fetch(`${API_BASE}/auth/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ pin: '', clientId: '' }),
    });
    // 业务层会因 PIN 格式错误返回 400，但来源是被允许的 → ACAO 应反射
    const h = headersToObj(res.headers);
    expect(h['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(h['access-control-allow-credentials']).toBe('true');
  });
});

export { headersToObj };
