// TST-PRL: /proxy/download/:sessionId 路由级限流回归测试。
//
// 路由声明了 max: 10 / timeWindow: '1 minute'（routes/proxy.ts）。
// 本用例在独立 relay 上发起 15 次 GET /proxy/download/:sessionId，
// 断言前 10 次不被限流（它们会因未携带鉴权被业务层 401，但不等于 429），
// 第 11 次起应被 @fastify/rate-limit 拦截返回 429 RATE_LIMITED。
//
// 使用独立 relay（而非全局 :3099）—— 避免其它测试文件在同窗口内消耗同一 IP 的配额，
// 也避免本用例把共享 relay 的代理配额打满导致并发文件失败。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== Relay 生命周期（镜像 rate-limit.test.ts 的隔离模式）=====

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
  throw new Error(`proxy-rate-limit relay :${port} 启动超时:\n${logs.join('')}`);
}

let apiBase = '';
let relayProcess: ChildProcess | null = null;
let tempDataDir: string | null = null;

beforeAll(async () => {
  const port = await getFreePort();
  apiBase = `http://127.0.0.1:${port}/api/v1`;
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-proxyrl-'));

  const serverRoot = path.resolve(__dirname, '..');
  const tsxCli = path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const logs: string[] = [];

  relayProcess = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RB_DATA_DIR: tempDataDir,
      JWT_SECRET: 'proxy-rl-test-access-secret-must-be-32!',
      JWT_REFRESH_SECRET: 'proxy-rl-test-refresh-secret-must-be-32',
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

// ===== 探测助手 =====

// 发起一次无鉴权的下载请求，返回 HTTP 状态码。
// 不携带 Authorization → 业务层 401 UNAUTHORIZED；若被限流则 429。
function probeDownload(sessionId: string): Promise<{ status: number; code: string | null }> {
  return fetch(`${apiBase}/proxy/download/${sessionId}?filePath=/tmp/x.txt`, {
    method: 'GET',
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    return { status: res.status, code: body?.error?.code ?? null };
  });
}

describe('/proxy/download 路由级限流 (TST-PRL)', () => {
  it('1 分钟内前 10 次不被限流，第 11 次起返回 429 RATE_LIMITED', async () => {
    const sessionId = '00000000-0000-0000-0000-000000000000';
    const TOTAL = 15;
    const results: { status: number; code: string | null }[] = [];

    // 顺序触发，便于精确观察 10→429 的拐点（并发触发会让计数分配不确定）
    for (let i = 0; i < TOTAL; i++) {
      results.push(await probeDownload(sessionId));
    }

    const notLimited = results.filter((r) => r.status !== 429);
    const limited = results.filter((r) => r.status === 429);

    // 前 10 次：通过限流，被业务层 401 拦截（未鉴权），但不是 429
    expect(notLimited).toHaveLength(10);
    for (const r of notLimited) {
      expect(r.code).toBe('UNAUTHORIZED');
    }

    // 第 11-15 次：触发限流，返回 429 RATE_LIMITED
    expect(limited).toHaveLength(5);
    for (const r of limited) {
      expect(r.status).toBe(429);
      expect(r.code).toBe('RATE_LIMITED');
    }
  });
});
