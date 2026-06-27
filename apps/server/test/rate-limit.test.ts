// TST-M2: Rate-limit enforcement tests.
//
// Uses a dedicated relay spawned on a free port so the rate-limit counters are
// completely isolated from the global-setup relay on :3099.  This avoids
// consuming quota that other test files depend on while still testing real
// @fastify/rate-limit behavior end-to-end.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { RATE_LIMIT_CONFIG } from '@remotebridge/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== Relay lifecycle helpers =====

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: 1000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(port: number, logs: string[], timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkHealth(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`rate-limit relay :${port} 启动超时:\n${logs.join('')}`);
}

let apiBase = '';
let relayProcess: ChildProcess | null = null;
let tempDataDir: string | null = null;

beforeAll(async () => {
  const port = await getFreePort();
  apiBase = `http://127.0.0.1:${port}/api/v1`;
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-ratelimit-'));

  const serverRoot = path.resolve(__dirname, '..');
  const tsxCli = path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const logs: string[] = [];

  relayProcess = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RB_DATA_DIR: tempDataDir,
      // Provide valid secrets so validateJwtSecrets() passes in any NODE_ENV
      JWT_SECRET: 'rl-test-access-secret-must-be-32-chars!',
      JWT_REFRESH_SECRET: 'rl-test-refresh-secret-must-be-32-chars',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relayProcess.stdout?.on('data', (c) => logs.push(c.toString()));
  relayProcess.stderr?.on('data', (c) => logs.push(c.toString()));

  await waitForHealth(port, logs);
}, 30000);

afterAll(async () => {
  if (relayProcess) {
    const proc = relayProcess;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill();
    });
    relayProcess = null;
  }
  if (tempDataDir) {
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tempDataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    tempDataDir = null;
  }
}, 15000);

// ===== Helpers =====

function apiPost(urlPath: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(apiBase + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ===== /auth/register-host — REGISTER_HOST_MAX (5/min) =====

describe('/auth/register-host — rate limit (TST-M2)', () => {
  it('allows exactly REGISTER_HOST_MAX requests before returning 429', async () => {
    const { REGISTER_HOST_MAX } = RATE_LIMIT_CONFIG;

    // Exhaust the quota: all REGISTER_HOST_MAX requests must NOT be 429
    for (let i = 0; i < REGISTER_HOST_MAX; i++) {
      const res = await apiPost('/auth/register-host', {
        name: `rl-host-${i}`,
        os: 'linux',
        version: '1.0.0',
      });
      expect(res.status, `request ${i + 1}/${REGISTER_HOST_MAX} should not be 429`).not.toBe(429);
    }

    // Next request must be rate-limited
    const res = await apiPost('/auth/register-host', {
      name: 'rl-host-overflow',
      os: 'linux',
      version: '1.0.0',
    });
    expect(res.status).toBe(429);

    // @fastify/rate-limit adds Retry-After and a structured body
    expect(res.headers.get('retry-after')).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({ statusCode: 429 });
  });
});

// ===== /auth/connect — AUTH_MAX (10/min) =====

describe('/auth/connect — rate limit (TST-M2)', () => {
  it('allows exactly AUTH_MAX requests before returning 429', async () => {
    const { AUTH_MAX } = RATE_LIMIT_CONFIG;

    // Send AUTH_MAX requests with a bad PIN — they count toward the rate limit
    // even though they return 4xx (rate limiter is a preHandler, runs first).
    for (let i = 0; i < AUTH_MAX; i++) {
      const res = await apiPost('/auth/connect', {
        pin: 'BADPIN00',
        clientId: `rl-client-${i}`,
        clientLabel: 'rl-test',
      });
      expect(res.status, `request ${i + 1}/${AUTH_MAX} should not be 429`).not.toBe(429);
    }

    // AUTH_MAX + 1 must be rate-limited
    const res = await apiPost('/auth/connect', {
      pin: 'BADPIN00',
      clientId: 'rl-client-overflow',
      clientLabel: 'rl-test',
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({ statusCode: 429 });
  });
});

// ===== /auth/ws-ticket — 20/min =====

describe('/auth/ws-ticket — rate limit (TST-M2)', () => {
  it('returns 429 after 20 rapid ticket requests', async () => {
    // 20 requests with a bogus bearer token — all return 401 (invalid token),
    // but the rate-limit preHandler still counts them.
    for (let i = 0; i < 20; i++) {
      const res = await fetch(apiBase + '/auth/ws-ticket', {
        headers: { Authorization: 'Bearer bogus-token' },
      });
      expect(res.status, `request ${i + 1}/20 should not be 429`).not.toBe(429);
    }

    const res = await fetch(apiBase + '/auth/ws-ticket', {
      headers: { Authorization: 'Bearer bogus-token' },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});
