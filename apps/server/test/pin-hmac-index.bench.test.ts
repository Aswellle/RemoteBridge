import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { post, createSession } from './helpers';

/**
 * P1-06: PIN HMAC 索引化基准测试
 *
 * 验证在大量 Host 注册场景下，PIN 连接仍然保持 O(1) 性能
 * （通过 idx_hosts_pin_hmac 索引精确匹配，而非全表 bcrypt）。
 */

describe('P1-06: PIN HMAC indexed lookup benchmark', () => {
  const HOST_COUNT = 50; // CI-friendly count; locally can raise to 1000
  const hostIds: string[] = [];
  const tokens: string[] = [];

  beforeAll(async () => {
    // Register multiple hosts
    for (let i = 0; i < HOST_COUNT; i++) {
      const res = await post('/auth/register-host', {
        name: `bench-host-${i}`,
        os: 'test',
        version: '1.0',
      });
      expect(res.data).toBeDefined();
      hostIds.push(res.data.hostId);
      tokens.push(res.data.token);
    }
  }, 60000);

  it('connects with PIN in O(1) regardless of host count', async () => {
    // Generate PIN for the last host
    const targetIdx = HOST_COUNT - 1;
    const pinRes = await post('/auth/generate-pin', {}, {
      authorization: `Bearer ${tokens[targetIdx]}`,
    });
    expect(pinRes.data.pin).toBeDefined();
    const pin = pinRes.data.pin;

    // Measure connect time
    const start = Date.now();
    const connectRes = await post('/auth/connect', {
      pin,
      clientId: 'bench-client',
      label: 'Benchmark Client',
    });
    const elapsed = Date.now() - start;

    expect(connectRes.data).toBeDefined();
    expect(connectRes.data.accessToken).toBeDefined();

    // With HMAC index, connect should be fast (< 500ms even with 50 hosts)
    // Without index, this would be O(n) bcrypt comparisons
    expect(elapsed).toBeLessThan(2000); // generous CI threshold
  }, 30000);

  it('rejects invalid PIN quickly (HMAC pre-filter)', async () => {
    const start = Date.now();
    const res = await post('/auth/connect', {
      pin: 'INVALID1', // wrong format
      clientId: 'bench-client',
    });
    const elapsed = Date.now() - start;

    expect(res.error).toBeDefined();
    expect(elapsed).toBeLessThan(100); // format check is instant
  });

  it('rejects valid-format but wrong PIN (no HMAC match)', async () => {
    const start = Date.now();
    const res = await post('/auth/connect', {
      pin: 'ABCDEFGH', // valid format but not generated
      clientId: 'bench-client',
    });
    const elapsed = Date.now() - start;

    expect(res.error).toBeDefined();
    expect(res.error.code).toBe('INVALID_PIN');
    // HMAC lookup should be fast (indexed)
    expect(elapsed).toBeLessThan(500);
  });
});
