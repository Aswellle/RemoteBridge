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

export function startLocalRelay(port = 3002): { success: boolean; error?: string } {
  if (relayProc !== null) return { success: false, error: '本地 Relay 已在运行' };

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

  ipcMain.handle('relay-local:state', () => getLocalRelayState());

  ipcMain.handle('relay-local:get-config', () => ({
    port: config.getLocalRelayPort(),
    autoStart: config.getLocalRelayAutoStart(),
  }));

  ipcMain.handle('relay-local:set-config', (_, cfg: { port?: number; autoStart?: boolean }) => {
    if (typeof cfg.port === 'number') config.setLocalRelayPort(cfg.port);
    if (typeof cfg.autoStart === 'boolean') config.setLocalRelayAutoStart(cfg.autoStart);
  });

  // Auto-start if configured
  if (config.getLocalRelayAutoStart()) {
    startLocalRelay(config.getLocalRelayPort());
  }
}
