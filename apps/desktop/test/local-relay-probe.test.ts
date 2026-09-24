/**
 * 本地中继启动探测回归测试
 *
 * 背景（真实事故）：已有中继监听 0.0.0.0:3002 时，桌面端再以 RELAY_HOST=127.0.0.1
 * 启动一个内部中继仍能绑定成功（Windows 允许具体地址与通配地址并存，且回环流量
 * 优先走具体地址）。结果是桌面端所有 HTTP/WS 请求落到这个"影子"中继上，而它与
 * 原中继使用不同的 JWT 密钥与数据库，导致安全审计等需要 Host token 的接口稳定 401。
 *
 * 因此必须：端口已有中继 → 复用；被其他程序占用 → 明确报错；空闲 → 才启动子进程。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

var spawned: string[] = [];
var healthResponse: { kind: 'relay' | 'other' | 'refuse' | 'timeout' } = { kind: 'refuse' };
var ipcHandlers = new Map<string, (...args: any[]) => any>();
var sentStatuses: any[] = [];

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => 'D:/tmp/userdata',
    getAppPath: () => 'D:/AI/remotebridge/apps/desktop',
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => ipcHandlers.set(channel, fn),
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_c: string, p: any) => sentStatuses.push(p) } }],
  },
  utilityProcess: { fork: () => { throw new Error('unexpected utilityProcess.fork'); } },
}));

vi.mock('child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    spawned.push(args[0]);
    return {
      pid: 4242,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    };
  },
}));

vi.mock('fs', () => ({
  default: { existsSync: () => true },
  existsSync: () => true,
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/config/store', () => ({
  config: {
    getLocalRelayJwtSecret: () => 'x'.repeat(60),
    getLocalRelayJwtRefreshSecret: () => 'y'.repeat(60),
    getLocalRelayAllowedOrigins: () => '',
    getLocalRelayPort: () => 3002,
    getLocalRelayAutoStart: () => false,
    setLocalRelayJwtSecret: vi.fn(),
    setLocalRelayJwtRefreshSecret: vi.fn(),
    setLocalRelayPort: vi.fn(),
    setLocalRelayAutoStart: vi.fn(),
  },
}));

var httpHandlers = new Map<string, (...args: any[]) => any>();
vi.mock('http', () => {
  const get = (url: string, opts: any, cb: (res: any) => void) => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const req = {
      on: (event: string, fn: (...args: any[]) => void) => { handlers.set(event, fn); },
      destroy: vi.fn(),
    };
    // 在下一个微任务里按场景触发回调，模拟真实异步探测
    queueMicrotask(() => {
      if (healthResponse.kind === 'refuse') {
        handlers.get('error')?.(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        return;
      }
      if (healthResponse.kind === 'timeout') {
        handlers.get('timeout')?.();
        return;
      }
      const body = healthResponse.kind === 'relay'
        ? JSON.stringify({ status: 'ok', instance_id: 'abc' })
        : '<html>some other service</html>';
      const resHandlers = new Map<string, (...args: any[]) => void>();
      const res = {
        on: (event: string, fn: (...args: any[]) => void) => { resHandlers.set(event, fn); },
      };
      cb(res);
      queueMicrotask(() => {
        resHandlers.get('data')?.(Buffer.from(body));
        resHandlers.get('end')?.();
      });
    });
    return req;
  };
  return { default: { get }, get };
});

import { startLocalRelay, getLocalRelayState, stopLocalRelay } from '../src/main/local-relay';

describe('startLocalRelay port probe', () => {
  beforeEach(() => {
    spawned = [];
    sentStatuses = [];
    stopLocalRelay();
  });

  it('adopts an existing relay instead of starting a shadow instance', async () => {
    healthResponse = { kind: 'relay' };

    const res = await startLocalRelay(3002);

    expect(res.success).toBe(true);
    expect(spawned).toEqual([]); // 关键：绝不启动第二个实例
    const state = getLocalRelayState();
    expect(state.status).toBe('running');
    expect(state.pid).toBeNull(); // 不持有外部进程
    expect(state.logs.some((l) => l.includes('复用现有实例'))).toBe(true);
  });

  it('reports an error when the port is taken by a non-relay service', async () => {
    healthResponse = { kind: 'other' };

    const res = await startLocalRelay(3002);

    expect(res.success).toBe(false);
    expect(res.error).toContain('已被其他程序占用');
    expect(spawned).toEqual([]);
    expect(getLocalRelayState().status).toBe('error');
  });

  it('starts the child process when the port is free', async () => {
    healthResponse = { kind: 'refuse' };

    const res = await startLocalRelay(3002);

    expect(res.success).toBe(true);
    // dev 模式下会复核一次端口，但只应产生一个子进程
    expect(spawned.length).toBe(1);
    expect(spawned[0]).toContain('apps');
  });

  it('rejects concurrent start requests while probing', async () => {
    healthResponse = { kind: 'refuse' };

    const first = startLocalRelay(3002);
    const second = await startLocalRelay(3002);

    expect(second.success).toBe(false);
    expect(second.error).toContain('正在启动中');
    await first;
    expect(spawned.length).toBe(1);
  });
});
