/**
 * 自动更新错误提示回归测试
 *
 * 用户可见问题：点击"检查更新"时网络类错误会把内部细节直接显示在界面上，
 * 例如 `net::ERR_INTERNET_DISCONNECTED`、`HttpError: 404 Not Found - GET
 * https://github.com/...releases.atom`。这些既无助于排查，也泄露内部地址。
 *
 * 测试走真实路径：捕获 updater:check IPC handler（点击"检查更新"的入口），
 * 让 electron-updater 以各类原始错误失败，验证广播到界面的提示已脱敏。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

var ipcHandlers = new Map<string, (...args: any[]) => any>();
var sentStatuses: any[] = [];
var checkImpl: () => Promise<any> = async () => undefined;

vi.mock('electron', () => ({
  app: { getVersion: () => '2.1.0' },
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => ipcHandlers.set(channel, fn),
  },
  BrowserWindow: class {},
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: vi.fn(),
    logger: null,
    checkForUpdates: () => checkImpl(),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    autoDownload: false,
    autoInstallOnAppQuit: true,
    forceDevUpdateConfig: false,
  },
}));

import { setupAutoUpdater } from '../src/main/updater';

const fakeWindow = () =>
  ({
    webContents: { send: (_ch: string, payload: any) => sentStatuses.push(payload) },
  }) as any;

/** 让一次手动检查以给定原始错误失败，返回界面上展示的提示 */
async function messageForCheckFailure(raw: string): Promise<string> {
  checkImpl = async () => {
    throw new Error(raw);
  };
  await ipcHandlers.get('updater:check')!();
  const err = [...sentStatuses].reverse().find((s) => s.state === 'error');
  return err?.message ?? '';
}

describe('updater error sanitization', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    sentStatuses = [];
    setupAutoUpdater(() => fakeWindow());
  });

  it('maps Chromium network codes to a friendly message', async () => {
    const msg = await messageForCheckFailure('net::ERR_INTERNET_DISCONNECTED');
    expect(msg).toBe('网络连接失败，无法访问更新服务器，请检查网络后重试');
    expect(msg).not.toContain('ERR_');
  });

  it('maps HTTP 404 with an internal URL without leaking the URL', async () => {
    const msg = await messageForCheckFailure(
      'HttpError: 404 Not Found - GET https://github.com/Aswellle/RemoteBridge/releases.atom - Not Found',
    );
    expect(msg).not.toContain('github.com');
    expect(msg).not.toContain('HttpError');
    expect(msg).toContain('未找到可用的更新发布');
  });

  it('maps DNS failures without leaking hostnames', async () => {
    const msg = await messageForCheckFailure('getaddrinfo ENOTFOUND api.github.com');
    expect(msg).not.toContain('github.com');
    expect(msg).toContain('网络连接失败');
  });

  it('maps server-side failures and auth rejections distinctly', async () => {
    expect(await messageForCheckFailure('HttpError: 502 Bad Gateway')).toContain('更新服务器暂时不可用');
    expect(await messageForCheckFailure('HttpError: 403 Forbidden')).toContain('拒绝了本次请求');
  });

  it('never echoes an unrecognized internal message verbatim', async () => {
    const msg = await messageForCheckFailure('some internal updater failure at /home/user/build/x.js');
    expect(msg).toBe('检查更新失败，请稍后重试');
    expect(msg).not.toContain('/home/user');
  });
});
