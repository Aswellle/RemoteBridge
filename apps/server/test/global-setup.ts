// vitest globalSetup (P1-15)：自动拉起 relay（指向临时 RB_DATA_DIR），
// 使 `pnpm test` 在干净的 checkout 中也能直接运行，不再要求先手动启动 :3099 实例。
// 如果检测到 :3099 已有健康的 relay 在跑（例如按 CLAUDE.md 手动起的开发实例），
// 则复用它，不再额外拉起一份，避免端口冲突。
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.RELAY_PORT || '3099';
const STARTUP_TIMEOUT_MS = 30000;

let serverProcess: ChildProcess | null = null;
let tempDataDir: string | null = null;

function checkHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/health', timeout: 1000 },
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

async function waitForHealth(logs: string[]): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    if (await checkHealth()) return;
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`relay 进程提前退出（code ${serverProcess.exitCode}）:\n${logs.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待 relay :${PORT}/health 超时:\n${logs.join('')}`);
}

export async function setup(): Promise<void> {
  if (await checkHealth()) {
    return;
  }

  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotebridge-test-'));
  const serverRoot = path.resolve(__dirname, '..');
  const tsxCli = path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  const logs: string[] = [];
  serverProcess = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      RELAY_PORT: PORT,
      RB_DATA_DIR: tempDataDir,
      // 测试环境提高注册/认证速率上限，避免并发测试文件集体超过 REGISTER_HOST_MAX=5 触发 429。
      // rate-limit.test.ts 使用独立 relay（不传这些变量），仍以真实默认值测试限流行为。
      RL_REGISTER_MAX: '100',
      RL_AUTH_MAX: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout?.on('data', (chunk) => logs.push(chunk.toString()));
  serverProcess.stderr?.on('data', (chunk) => logs.push(chunk.toString()));

  await waitForHealth(logs);
}

export async function teardown(): Promise<void> {
  if (serverProcess) {
    const proc = serverProcess;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill();
    });
    serverProcess = null;
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
}
