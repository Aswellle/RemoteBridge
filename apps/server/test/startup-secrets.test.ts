/**
 * Relay 启动 — JWT 密钥强度校验 (P0-6)
 * 验证: NODE_ENV=production 时，使用默认/派生/过短的 JWT 密钥会导致启动失败（非零退出码）；
 *       使用两个独立的高强度密钥时可以正常启动并响应 /health。
 *
 * 本测试 spawn 独立的 relay 进程（不依赖共享的 :3099 测试 relay），
 * 使用专用端口 3096-3098 避免与其它测试冲突。
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';

const SERVER_DIR = path.resolve(__dirname, '..');

function spawnRelay(env: Record<string, string | undefined>) {
  return spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    shell: true,
  });
}

describe('relay startup — JWT secret validation (P0-6)', () => {
  it('refuses to start with the default/dev JWT_SECRET', async () => {
    const proc = spawnRelay({
      NODE_ENV: 'production',
      JWT_SECRET: 'remotebridge-dev-secret-change-in-production',
      JWT_REFRESH_SECRET: 'a'.repeat(32),
      RELAY_PORT: '3098',
    });
    const exitCode = await new Promise<number>((resolve) => proc.on('exit', (code) => resolve(code ?? -1)));
    expect(exitCode).not.toBe(0);
  }, 45000);

  it('refuses to start when JWT_REFRESH_SECRET is derived from JWT_SECRET', async () => {
    const proc = spawnRelay({
      NODE_ENV: 'production',
      JWT_SECRET: 'a-sufficiently-long-random-secret-1234567890',
      JWT_REFRESH_SECRET: 'a-sufficiently-long-random-secret-1234567890-refresh',
      RELAY_PORT: '3097',
    });
    const exitCode = await new Promise<number>((resolve) => proc.on('exit', (code) => resolve(code ?? -1)));
    expect(exitCode).not.toBe(0);
  }, 45000);

  it('starts successfully with two independent, sufficiently-long secrets', async () => {
    // 用 14096 而非 3096：Windows Hyper-V 把 3043-3142 纳入排除区间，导致 EACCES
    const proc = spawnRelay({
      NODE_ENV: 'production',
      JWT_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
      RELAY_PORT: '14096',
    });

    let healthy = false;
    try {
      for (let i = 0; i < 100; i++) {
        try {
          const res = await fetch('http://localhost:14096/health');
          if (res.ok) { healthy = true; break; }
        } catch { /* 尚未就绪 */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(healthy).toBe(true);
    } finally {
      proc.kill();
    }
  }, 45000);
});
