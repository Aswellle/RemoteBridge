// TST-LIFE: 会话绝对生命周期（30 天）回归测试。
//
// 刷新端点（routes/auth.ts）在签发新令牌前会检查会话的 createdAt：
//   if (now - createdAt) > 30 天  →  401 SESSION_EXPIRED
// 这是 refresh token（30 天长效）的兜底：即便 refresh token 本身仍有效，
// 只要底层会话已创建超过 30 天就必须重新走 PIN 连接。
//
// 测试策略：在独立 relay 上建立合法会话后，直接打开其 SQLite 数据文件
// 把 createdAt 回拨到 31 天前，再调用 /auth/refresh，断言返回 401 SESSION_EXPIRED。
// 使用独立 relay 是为了固定 RB_DATA_DIR 路径，便于从测试进程直接操作数据文件。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_SESSION_AGE_SECONDS = 30 * 24 * 60 * 60;

// ===== Relay 生命周期 =====

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
  throw new Error(`session-lifetime relay :${port} 启动超时:\n${logs.join('')}`);
}

let apiBase = '';
let relayProcess: ChildProcess | null = null;
let tempDataDir: string | null = null;

beforeAll(async () => {
  const port = await getFreePort();
  apiBase = `http://127.0.0.1:${port}/api/v1`;
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-lifetime-'));

  const serverRoot = path.resolve(__dirname, '..');
  const tsxCli = path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const logs: string[] = [];

  relayProcess = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RB_DATA_DIR: tempDataDir,
      JWT_SECRET: 'lifetime-test-access-secret-must-be-32!',
      JWT_REFRESH_SECRET: 'lifetime-test-refresh-secret-must-be-32',
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

// ===== 业务辅助 =====

function post(urlPath: string, body: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
  return fetch(apiBase + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<ApiResult>);
}

// 返回原始 HTTP 状态 + 解析后的 body，用于需要断言状态码的错误路径。
function postRaw(urlPath: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(apiBase + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as ApiResult }));
}

// 服务端统一响应结构（routes/* 的 ApiResponse<T>）；测试只关心这几个字段。
interface ApiResult {
  success?: boolean;
  statusCode?: number;
  data?: {
    success?: boolean;
    sessionId?: string;
    accessToken?: string;
    pin?: string;
    hostId?: string;
    token?: string;
    ticket?: string;
    error?: { code?: string; message?: string } | null;
  };
  error?: { code?: string; message?: string } | null;
}

function extractCookie(setCookie: string[] | string | undefined, name: string): string {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const hit = arr.find((c) => c.startsWith(`${name}=`));
  if (!hit) throw new Error(`Set-Cookie 中未找到 ${name}`);
  return decodeURIComponent(hit.split(';')[0].slice(name.length + 1));
}

async function postWithCookies(
  urlPath: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ data: ApiResult; accessToken: string; refreshToken: string }> {
  const res = await fetch(apiBase + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const setCookies = res.headers.getSetCookie();
  const data = (await res.json()) as ApiResult;
  return {
    data,
    accessToken: extractCookie(setCookies, 'rb_access'),
    refreshToken: extractCookie(setCookies, 'rb_refresh'),
  };
}

// 直接打开 relay 的数据文件，把指定会话的 createdAt 回拨到指定unix时间。
// WAL 模式 + busy_timeout 保证跨进程写入不会因 relay 持有的锁而立刻失败。
function backdateSessionCreatedAt(sessionId: string, toUnixSeconds: number): void {
  const dbPath = path.join(tempDataDir!, 'remotebridge.db');
  const db = new Database(dbPath, { timeout: 5000 });
  try {
    db.pragma('busy_timeout = 5000');
    const info = db
      .prepare('UPDATE sessions SET created_at = ? WHERE id = ?')
      .run(toUnixSeconds, sessionId);
    if (info.changes !== 1) {
      throw new Error(`未找到会话 ${sessionId} 或更新失败 (changes=${info.changes})`);
    }
  } finally {
    db.close();
  }
}

describe('会话绝对生命周期 30 天 (TST-LIFE)', () => {
  it('createdAt 超过 30 天的会话，refresh 返回 401 SESSION_EXPIRED', async () => {
    // 1) 建立合法会话
    const reg = await post('/auth/register-host', {
      name: 'lifetime-host',
      os: 'win32',
      version: '1.0.0',
    });
    const hostToken = reg.data.token;

    const pinResp = await post(
      '/auth/generate-pin',
      { expiresIn: 300 },
      { Authorization: `Bearer ${hostToken}` },
    );
    const { pin } = pinResp.data;

    const conn = await postWithCookies('/auth/connect', {
      pin,
      clientId: `lifetime-client-${Date.now()}`,
      clientLabel: 'lifetime',
    });
    expect(conn.data.success).toBe(true);
    const { sessionId } = conn.data.data;
    const { refreshToken } = conn;

    // 2) 回拨 createdAt 到 31 天前（超过 30 天阈值）
    const agedCreatedAt = Math.floor(Date.now() / 1000) - (MAX_SESSION_AGE_SECONDS + 24 * 60 * 60);
    backdateSessionCreatedAt(sessionId, agedCreatedAt);

    // 3) 用仍有效的 refresh token 尝试刷新 —— 应被会话寿命检查拦下
    const refresh = await postRaw('/auth/refresh', { refreshToken });
    expect(refresh.status).toBe(401);
    expect(refresh.body.error?.code).toBe('SESSION_EXPIRED');
  });

  it('对照组：未超龄的会话刷新仍正常通过', async () => {
    const reg = await post('/auth/register-host', {
      name: 'lifetime-host-fresh',
      os: 'win32',
      version: '1.0.0',
    });
    const pinResp = await post(
      '/auth/generate-pin',
      { expiresIn: 300 },
      { Authorization: `Bearer ${reg.data.token}` },
    );
    const conn = await postWithCookies('/auth/connect', {
      pin: pinResp.data.pin,
      clientId: `lifetime-fresh-client-${Date.now()}`,
      clientLabel: 'lifetime-fresh',
    });
    expect(conn.data.success).toBe(true);

    const refresh = await post('/auth/refresh', { refreshToken: conn.refreshToken });
    expect(refresh.success).toBe(true);
    expect(refresh.data.accessToken).toBeTruthy();
  });
});
