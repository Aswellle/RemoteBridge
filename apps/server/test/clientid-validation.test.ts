// TST-VALID: /auth/connect 的 clientId 参数校验回归测试。
//
// 连接处理器的校验顺序（routes/auth.ts）：
//   1) PIN 格式（isValidPinFormat）→ 400 INVALID_PIN_FORMAT
//   2) clientId 缺失                 → 400 MISSING_CLIENT_ID
//   3) clientId 长度 > 128           → 400 INVALID_CLIENT_ID
// 本用例覆盖 2) 3) 与合法 UUID 的成功路径。
//
// 注：错误响应不带 Set-Cookie，故用 postRaw（返回 status+body）而非 postWithCookies。
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { API_BASE } from './helpers';

// 构造一个「格式有效但尚未注册主机」的 PIN：校验器只关心格式，不查 DB，
// 因此这里用任意 8 位合法字符即可在「clientId 校验阶段」被拦截，不会走到 PIN 验证。
const VALID_FORMAT_PIN = 'ABCDEFGH';

function postRaw(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

describe('clientId 参数校验 (TST-VALID)', () => {
  it('clientId 为空字符串 → 400 MISSING_CLIENT_ID', async () => {
    const res = await postRaw('/auth/connect', {
      pin: VALID_FORMAT_PIN,
      clientId: '',
      clientLabel: 'empty-id',
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('MISSING_CLIENT_ID');
  });

  it('clientId 为 undefined / 缺失 → 400 MISSING_CLIENT_ID', async () => {
    const res = await postRaw('/auth/connect', {
      pin: VALID_FORMAT_PIN,
      clientLabel: 'missing-id',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('MISSING_CLIENT_ID');
  });

  it('clientId 超过 128 字符 → 400 INVALID_CLIENT_ID', async () => {
    const longId = 'x'.repeat(129);
    const res = await postRaw('/auth/connect', {
      pin: VALID_FORMAT_PIN,
      clientId: longId,
      clientLabel: 'long-id',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_CLIENT_ID');
  });

  it('clientId 恰好 128 字符（边界）→ 不被长度校验拦截，进入 PIN 验证阶段', async () => {
    const borderId = 'y'.repeat(128);
    const res = await postRaw('/auth/connect', {
      pin: VALID_FORMAT_PIN,
      clientId: borderId,
      clientLabel: 'border-id',
    });
    // 长度校验通过，下一步是 PIN 验证；该 PIN 未绑定主机 → 401 INVALID_PIN。
    // 关键断言：绝不是 INVALID_CLIENT_ID（即长度边界 128 是合法的）。
    expect(res.body.error?.code).not.toBe('INVALID_CLIENT_ID');
    expect(res.body.error?.code).not.toBe('MISSING_CLIENT_ID');
  });

  it('合法 UUID 格式的 clientId → 校验通过，进入 PIN 验证', async () => {
    const res = await postRaw('/auth/connect', {
      pin: VALID_FORMAT_PIN,
      clientId: randomUUID(),
      clientLabel: 'uuid-id',
    });
    // 同样应越过 clientId 校验，到达 PIN 验证（未绑定主机 → 401 INVALID_PIN）
    expect(res.body.error?.code).not.toBe('MISSING_CLIENT_ID');
    expect(res.body.error?.code).not.toBe('INVALID_CLIENT_ID');
  });
});
