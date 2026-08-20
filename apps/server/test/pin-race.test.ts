// TST-RACE: PIN 一次性消费的原子性回归测试。
//
// 业务约束：连接 PIN 是「一次性入口凭证」。当 5 个 Client 拿着同一 PIN 并发发起
// /auth/connect 时，只有 1 个应成功建立会话（200），其余 4 个必须收到 409 PIN_ALREADY_USED，
// 绝不能出现多个会话共用一个 PIN 的情况（否则一次性 PIN 形同虚设）。
//
// 并发可行性：@node-rs/bcrypt 的 compare 在 libuv 线程池执行（不阻塞事件循环），
// 因此 5 个请求的 PIN 验证会真正交错进行，全部验证通过后再竞争原子 UPDATE，
// 从而触发「同一 PIN 被并发消费」的真实竞争条件。
import { describe, it, expect } from 'vitest';
import { API_BASE, post } from './helpers';

// 原始 POST：返回 { status, body }，不抽 cookie。
// 错误路径（400/409/401）响应不带 Set-Cookie，postWithCookies 会抛错，故此用 raw。
function postRaw(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

describe('PIN 一次性消费 — 并发竞争 (TST-RACE)', () => {
  it('5 个并发 connect 中恰好 1 个成功，4 个收到 409 PIN_ALREADY_USED', async () => {
    // 1) 注册一台主机并签发一个有效 PIN，作为并发连接的目标
    const reg = await post('/auth/register-host', {
      name: 'race-host',
      os: 'win32',
      version: '1.0.0',
    });
    expect(reg.data.hostId).toBeTruthy();
    const hostToken = reg.data.token;

    const pinResp = await post(
      '/auth/generate-pin',
      { expiresIn: 300 },
      { Authorization: `Bearer ${hostToken}` },
    );
    expect(pinResp.data.pin).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const { pin } = pinResp.data;

    // 2) 同一 PIN、不同 clientId，5 个并发连接
    const attempts = Array.from({ length: 5 }, (_, i) =>
      postRaw('/auth/connect', {
        pin,
        clientId: `race-client-${i}-${Date.now()}`,
        clientLabel: `race-${i}`,
      }),
    );
    const results = await Promise.all(attempts);

    // 3) 断言：恰好 1 个成功建立会话（200 + success）
    const successes = results.filter((r) => r.status === 200 && r.body?.success === true);
    expect(successes).toHaveLength(1);
    expect(successes[0].body.data.sessionId).toBeTruthy();

    // 4) 断言：其余 4 个都被原子消费守卫拦下，返回 409 PIN_ALREADY_USED
    const alreadyUsed = results.filter((r) => r.body?.error?.code === 'PIN_ALREADY_USED');
    expect(alreadyUsed).toHaveLength(4);
    for (const r of alreadyUsed) {
      expect(r.status).toBe(409);
    }

    // 5) 没有其它类型的错误（如 401 INVALID_PIN）泄露进来
    const others = results.filter(
      (r) => !(r.status === 200 && r.body?.success === true) && r.body?.error?.code !== 'PIN_ALREADY_USED',
    );
    expect(others, '不应出现除 PIN_ALREADY_USED 之外的错误').toHaveLength(0);
  });

  it('串行重放同一 PIN 同样只成功一次（非并发兜底）', async () => {
    const reg = await post('/auth/register-host', {
      name: 'race-host-serial',
      os: 'win32',
      version: '1.0.0',
    });
    const pinResp = await post(
      '/auth/generate-pin',
      { expiresIn: 300 },
      { Authorization: `Bearer ${reg.data.token}` },
    );
    const { pin } = pinResp.data;

    const first = await postRaw('/auth/connect', {
      pin,
      clientId: `serial-client-1-${Date.now()}`,
      clientLabel: 'serial-1',
    });
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);

    // PIN 已被消费，第二次（即便串行）必须失败，不能再用同一 PIN 建立会话。
    // 串行场景下主机查询 SELECT 过滤 pin_hash!=''，PIN 清空后主机不可见 → 401 INVALID_PIN；
    // 并发场景下多条请求同时通过主机查询后再竞争消费 → 409 PIN_ALREADY_USED。
    // 两种状态都代表「PIN 不可复用」，此处断言失败即可，不强求具体状态码。
    const second = await postRaw('/auth/connect', {
      pin,
      clientId: `serial-client-2-${Date.now()}`,
      clientLabel: 'serial-2',
    });
    expect([401, 409]).toContain(second.status);
    expect(second.body.success).toBe(false);
    expect(second.body.data).toBeNull();
  });
});
