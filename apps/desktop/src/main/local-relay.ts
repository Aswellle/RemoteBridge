import { utilityProcess, app, ipcMain, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import log from './logger';
import { config } from './config/store';

export type LocalRelayStatus = 'stopped' | 'starting' | 'running' | 'error';

// Electron UtilityProcess type (available in Electron 20+, we're on 28)
type EUtilityProcess = ReturnType<typeof utilityProcess.fork>;

let relayProc: EUtilityProcess | ChildProcess | null = null;
let currentStatus: LocalRelayStatus = 'stopped';
let currentPort = 3002;
let lastError = '';
// 端口探测是异步的：探测期间的重复调用必须被拒绝，否则会并发拉起两个子进程
let starting = false;
const logLines: string[] = [];
const MAX_LOGS = 200;
let healthPollTimer: ReturnType<typeof setInterval> | null = null;
const relayReadyCallbacks: Array<() => void> = [];

// ===== internal helpers =====

function getEntryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'relay', 'wrapper.js');
  }
  // Dev: run from monorepo relay dist
  return path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'server', 'dist', 'index.js');
}

function ensureJwtSecrets(): { secret: string; refreshSecret: string } {
  let s = config.getLocalRelayJwtSecret();
  let r = config.getLocalRelayJwtRefreshSecret();
  if (!s || s.length < 32) {
    s = crypto.randomBytes(48).toString('base64');
    config.setLocalRelayJwtSecret(s);
  }
  if (!r || r.length < 32 || r === s) {
    r = crypto.randomBytes(48).toString('base64');
    config.setLocalRelayJwtRefreshSecret(r);
  }
  return { secret: s, refreshSecret: r };
}

function pushLog(line: string): void {
  if (!line.trim()) return;
  logLines.push(line);
  if (logLines.length > MAX_LOGS) logLines.shift();
  broadcastLog(line);
}

function setStatus(s: LocalRelayStatus, err = ''): void {
  currentStatus = s;
  lastError = err;
  broadcastStatus(s, err);
  if (s === 'running') {
    relayReadyCallbacks.forEach(cb => { try { cb(); } catch {} });
  }
}

function stopHealthPoll(): void {
  if (healthPollTimer) { clearInterval(healthPollTimer); healthPollTimer = null; }
}

// ===== 端口占用探测 =====
type PortProbe = 'free' | 'relay' | 'occupied';

/**
 * 探测 127.0.0.1:<port> 是否已被占用。
 *
 * 必要性（Windows 双重绑定陷阱）：已有 Relay 监听 0.0.0.0:3002 时，再以
 * RELAY_HOST=127.0.0.1 启动一个本地 Relay 仍能成功绑定——Windows 允许具体地址
 * 与通配地址并存，并且**回环流量优先走具体地址**。结果：桌面端 HTTP/WS 请求全部
 * 落到这个"影子"Relay 上，而它与开发/外部 Relay 使用不同的 JWT 密钥与数据库，
 * 于是所有需要 Host token 的请求（如安全审计日志）稳定 401，且数据来自另一个库。
 *
 * 因此启动前必须先探测：端口已被 Relay 占用则直接复用（不启动第二个实例），
 * 被其他程序占用则明确报错提示更换端口，避免静默产生影子实例。
 */
function probePort(port: number, timeoutMs = 1000): Promise<PortProbe> {
  const { promise, resolve } = Promise.withResolvers<PortProbe>();
  // 单次 settle：error/timeout/end 可能先后触发，只认第一个结果
  let settled = false;
  const settle = (r: PortProbe) => {
    if (settled) return;
    settled = true;
    resolve(r);
  };

  const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: timeoutMs }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      // 仅当响应形如 Relay 的 /health（含 status 字段）才认定为 Relay，
      // 否则视为被其他程序占用，避免误把任意 HTTP 服务当作可复用中继
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        settle(parsed && typeof parsed === 'object' && 'status' in parsed ? 'relay' : 'occupied');
      } catch {
        settle('occupied');
      }
    });
  });
  req.on('error', (err: NodeJS.ErrnoException) => {
    req.destroy();
    settle(err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' ? 'free' : 'occupied');
  });
  req.on('timeout', () => {
    req.destroy();
    settle('occupied');
  });

  return promise;
}

/** 复用已存在的 Relay：接管状态但不持有子进程，停止时不影响外部实例 */
function adoptExternalRelay(port: number): { success: boolean; error?: string } {
  currentPort = port;
  pushLog(`[本地 Relay] 检测到 127.0.0.1:${port} 已有 Relay 在运行，复用现有实例（不启动第二个进程）`);
  setStatus('running');
  return { success: true };
}

function startHealthPoll(port: number): void {
  stopHealthPoll();
  let attempts = 0;
  healthPollTimer = setInterval(() => {
    attempts++;
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 800 }, (res) => {
      if (res.statusCode === 200 && currentStatus === 'starting') {
        stopHealthPoll();
        setStatus('running');
        pushLog(`[本地 Relay] 已就绪 (:${port})`);
      }
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    if (attempts >= 24) { // 12s timeout
      stopHealthPoll();
      if (currentStatus === 'starting') {
        setStatus('error', '启动超时，健康检查失败');
        pushLog('[本地 Relay] 启动超时，请检查端口是否被占用');
      }
    }
  }, 500);
}

// ===== broadcast to renderer =====

function broadcastLog(line: string): void {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('event:local-relay-log', line);
  });
}

function broadcastStatus(status: LocalRelayStatus, error: string): void {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('event:local-relay-status', { status, error });
  });
}

// ===== public API =====

/** 本地 Relay 就绪时（status → 'running'）触发回调，用于在 Relay 启动后自动重连 */
export function onRelayReady(cb: () => void): void {
  relayReadyCallbacks.push(cb);
}

/**
 * 探测端口，dev 模式下额外复核一次。
 *
 * `pnpm dev` 会并发启动 dev Relay 与 Electron；Electron 主进程到达自动启动分支时
 * dev Relay 通常已监听，但存在竞态。首次探测到空闲时短暂等待后复核，避免在
 * dev Relay 尚未绑定成功时抢先拉起内部实例（一旦内部实例先绑定 127.0.0.1，
 * 后续所有回环请求都会落到它上面）。
 * 打包运行时不存在并发启动的外部 Relay，无需复核。
 */
async function probePortWithGrace(port: number): Promise<PortProbe> {
  const first = await probePort(port);
  if (first !== 'free' || app.isPackaged) return first;
  await new Promise((r) => setTimeout(r, 1500));
  return probePort(port);
}

export function startLocalRelay(port = 3002): Promise<{ success: boolean; error?: string }> {
  if (starting) return Promise.resolve({ success: false, error: '本地 Relay 正在启动中' });
  if (relayProc !== null) return Promise.resolve({ success: false, error: '本地 Relay 已在运行' });
  starting = true;
  return probePortWithGrace(port).then((probe) => {
    starting = false;
    if (probe === 'relay') return adoptExternalRelay(port);
    if (probe === 'occupied') {
      const msg = `端口 ${port} 已被其他程序占用，请在"本地中继"中更换端口`;
      pushLog(`[本地 Relay] ${msg}`);
      setStatus('error', msg);
      return { success: false, error: msg };
    }
    return spawnLocalRelay(port);
  });
}

/** 端口空闲时才真正拉起子进程 */
function spawnLocalRelay(port: number): { success: boolean; error?: string } {
  const entry = getEntryPath();
  if (!fs.existsSync(entry)) {
    const msg = app.isPackaged
      ? 'Relay 包文件丢失，请重新安装桌面端'
      : `找不到 Relay 入口: ${entry}（请先运行 pnpm --filter @remotebridge/server build）`;
    log.error(msg);
    return { success: false, error: msg };
  }

  const { secret, refreshSecret } = ensureJwtSecrets();
  currentPort = port;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAY_PORT: String(port),
    RELAY_HOST: '127.0.0.1',
    NODE_ENV: 'production',
    JWT_SECRET: secret,
    JWT_REFRESH_SECRET: refreshSecret,
    ALLOWED_ORIGINS: config.getLocalRelayAllowedOrigins() || 'http://localhost:3000,http://127.0.0.1:3000',
    RB_DATA_DIR: path.join(app.getPath('userData'), 'local-relay-data'),
  };

  setStatus('starting');
  pushLog('[本地 Relay] 正在启动...');

  try {
    if (app.isPackaged) {
      const proc = utilityProcess.fork(entry, [], { env, stdio: 'pipe' });

      proc.stdout?.on('data', (data: Buffer) => {
        data.toString().split('\n').forEach(pushLog);
      });
      proc.stderr?.on('data', (data: Buffer) => {
        data.toString().split('\n').forEach((l) => {
          if (!l.trim()) return;
          pushLog(`[ERR] ${l}`);
          if (l.includes('拒绝启动') || l.includes('EADDRINUSE')) {
            stopHealthPoll();
            setStatus('error', l.trim());
          }
        });
      });
      proc.on('spawn', () => pushLog(`[本地 Relay] 进程已启动`));
      proc.on('exit', (code: number) => {
        stopHealthPoll();
        pushLog(`[本地 Relay] 进程退出 (code: ${code})`);
        relayProc = null;
        if (currentStatus !== 'error') setStatus('stopped');
      });

      relayProc = proc;
      startHealthPoll(port);
    } else {
      // Dev: spawn system node
      const proc = spawn('node', [entry], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', (data: Buffer) =>
        data.toString().split('\n').forEach(pushLog));
      proc.stderr?.on('data', (data: Buffer) =>
        data.toString().split('\n').forEach((l) => {
          if (!l.trim()) return;
          pushLog(`[ERR] ${l}`);
          if (l.includes('拒绝启动') || l.includes('EADDRINUSE')) {
            stopHealthPoll();
            setStatus('error', l.trim());
          }
        }));
      proc.on('error', (err) => {
        stopHealthPoll();
        const msg = err.message.includes('ENOENT')
          ? '未找到 node 命令，请确认已安装 Node.js'
          : err.message;
        pushLog(`[本地 Relay] 启动失败: ${msg}`);
        relayProc = null;
        setStatus('error', msg);
      });
      proc.on('exit', (code) => {
        stopHealthPoll();
        pushLog(`[本地 Relay] 进程退出 (code: ${code})`);
        relayProc = null;
        if (currentStatus !== 'error') setStatus('stopped');
      });

      relayProc = proc;
      startHealthPoll(port);
    }
    return { success: true };
  } catch (err: any) {
    relayProc = null;
    setStatus('error', err.message);
    return { success: false, error: err.message };
  }
}

export function stopLocalRelay(): void {
  if (!relayProc) return;
  stopHealthPoll();
  pushLog('[本地 Relay] 正在停止...');
  try {
    if ('kill' in relayProc && typeof (relayProc as ChildProcess).kill === 'function') {
      (relayProc as ChildProcess).kill('SIGTERM');
    } else {
      (relayProc as EUtilityProcess).kill();
    }
  } catch {}
  relayProc = null;
  setStatus('stopped');
}

export function getLocalRelayState() {
  return {
    status: currentStatus,
    port: currentPort,
    pid: relayProc?.pid ?? null,
    error: lastError,
    logs: [...logLines],
  };
}

// ===== IPC registration =====

export function registerLocalRelayHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('relay-local:start', (_, port?: number) => {
    const p = typeof port === 'number' ? port : config.getLocalRelayPort();
    return startLocalRelay(p);
  });

  ipcMain.handle('relay-local:stop', () => {
    stopLocalRelay();
  });

  ipcMain.handle('relay-local:get-state', () => getLocalRelayState());

  ipcMain.handle('relay-local:get-config', () => ({
    port: config.getLocalRelayPort(),
    autoStart: config.getLocalRelayAutoStart(),
  }));

  ipcMain.handle('relay-local:set-config', (_, cfg: { port?: number; autoStart?: boolean }) => {
    const portChanged = typeof cfg.port === 'number' && cfg.port !== config.getLocalRelayPort();
    if (typeof cfg.port === 'number') config.setLocalRelayPort(cfg.port);
    if (typeof cfg.autoStart === 'boolean') config.setLocalRelayAutoStart(cfg.autoStart);

    // 端口变更且 relay 正在运行 → 重启以绑定新端口，避免 UI 显示新端口但实际仍监听旧端口
    if (portChanged && currentStatus === 'running') {
      log.info(`本地 Relay 端口变更，重启中 (${currentPort} → ${cfg.port})`);
      stopLocalRelay();
      startLocalRelay(cfg.port as number);
    }
  });
  // Auto-start if configured
  if (config.getLocalRelayAutoStart()) {
    startLocalRelay(config.getLocalRelayPort());
  }
}
