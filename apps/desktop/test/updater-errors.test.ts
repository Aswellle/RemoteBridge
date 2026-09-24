/**
 * 自动更新错误处理与横幅可见性回归测试
 *
 * 用户可见问题：
 *  1. 一次网络抖动（net::ERR_CONNECTION_CLOSED）被广播成全局 error 状态，顶部横幅
 *     长期驻留遮挡正常操作。
 *  2. 该错误文案若直接透传会暴露内部细节（GitHub URL、HTTP 状态行、net::ERR_* 码）。
 *
 * 新契约：
 *  - 检查/下载失败**不进入全局状态**，错误经 IPC 返回值交给调用方（"关于"页内联展示）
 *  - 顶部横幅只承载 available / downloading / downloaded
 *  - 网络类错误映射为固定中文提示，绝不透传原始行
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

var ipcHandlers = new Map<string, (...args: any[]) => any>();
var eventHandlers = new Map<string, (...args: any[]) => void>();
var sentStatuses: any[] = [];
var checkImpl: () => Promise<any> = async () => undefined;
var downloadImpl: () => Promise<any> = async () => undefined;

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
    on: (event: string, fn: (...args: any[]) => void) => eventHandlers.set(event, fn),
    logger: null,
    checkForUpdates: () => checkImpl(),
    downloadUpdate: () => downloadImpl(),
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

/** 手动检查以给定原始错误失败时，返回给"关于"页的提示 */
async function checkFailureMessage(raw: string): Promise<string> {
  checkImpl = async () => {
    throw new Error(raw);
  };
  const res = await ipcHandlers.get('updater:check')!();
  expect(res.success).toBe(false);
  return res.error ?? '';
}

describe('updater error handling', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    eventHandlers.clear();
    sentStatuses = [];
    checkImpl = async () => undefined;
    downloadImpl = async () => undefined;
    setupAutoUpdater(() => fakeWindow());
  });

  // ── 错误脱敏（"关于"页内联提示） ──

  it('maps Chromium network codes to a friendly message', async () => {
    const msg = await checkFailureMessage('net::ERR_CONNECTION_CLOSED');
    expect(msg).toBe('网络连接失败，无法访问更新服务器，请检查网络后重试');
    expect(msg).not.toContain('ERR_');
  });

  it('maps HTTP 404 with an internal URL without leaking the URL', async () => {
    const msg = await checkFailureMessage(
      'HttpError: 404 Not Found - GET https://github.com/Aswellle/RemoteBridge/releases.atom - Not Found',
    );
    expect(msg).not.toContain('github.com');
    expect(msg).not.toContain('HttpError');
    expect(msg).toContain('未找到可用的更新发布');
  });

  it('maps DNS failures without leaking hostnames', async () => {
    const msg = await checkFailureMessage('getaddrinfo ENOTFOUND api.github.com');
    expect(msg).not.toContain('github.com');
    expect(msg).toContain('网络连接失败');
  });

  it('maps server-side failures and auth rejections distinctly', async () => {
    expect(await checkFailureMessage('HttpError: 502 Bad Gateway')).toContain('更新服务器暂时不可用');
    expect(await checkFailureMessage('HttpError: 403 Forbidden')).toContain('拒绝了本次请求');
  });

  it('never echoes an unrecognized internal message verbatim', async () => {
    const msg = await checkFailureMessage('some internal updater failure at /home/user/build/x.js');
    expect(msg).toBe('检查更新失败，请稍后重试');
    expect(msg).not.toContain('/home/user');
  });

  // ── 横幅不被错误占用（核心回归） ──

  it('does not broadcast an error status when a manual check fails', async () => {
    await checkFailureMessage('net::ERR_INTERNET_DISCONNECTED');
    expect(sentStatuses.filter((s) => s.state === 'error')).toEqual([]);
  });

  it('does not broadcast an error status when an automatic check fails', async () => {
    sentStatuses = [];
    eventHandlers.get('error')!(new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(sentStatuses.filter((s) => s.state === 'error')).toEqual([]);
  });

  it('broadcasts only user-actionable states (available / downloading / downloaded)', async () => {
    sentStatuses = [];
    eventHandlers.get('update-available')!({ version: '2.2.0', releaseNotes: '新功能' });
    eventHandlers.get('download-progress')!({ percent: 42, bytesPerSecond: 1024, transferred: 100, total: 200 });
    eventHandlers.get('update-downloaded')!({ version: '2.2.0' });

    expect(sentStatuses.map((s) => s.state)).toEqual(['available', 'downloading', 'downloaded']);
    // 进度事件带上版本号：横幅据此按版本记忆关闭状态
    expect(sentStatuses[1].version).toBe('2.2.0');
  });

  it('reverts a stuck download progress to the downloadable state on failure', async () => {
    sentStatuses = [];
    eventHandlers.get('update-available')!({ version: '2.2.0', releaseNotes: '' });
    eventHandlers.get('download-progress')!({ percent: 10, bytesPerSecond: 1, transferred: 1, total: 10 });
    eventHandlers.get('error')!(new Error('net::ERR_CONNECTION_CLOSED'));

    const last = sentStatuses[sentStatuses.length - 1];
    // 不能停在进度条上：否则横幅无法再操作
    expect(last.state).toBe('available');
    expect(last.version).toBe('2.2.0');
  });

  it('returns a friendly error when the download fails', async () => {
    downloadImpl = async () => {
      throw new Error('net::ERR_CONNECTION_CLOSED');
    };
    const res = await ipcHandlers.get('updater:download')!();
    expect(res.success).toBe(false);
    expect(res.error).toContain('网络连接失败');
  });

  it('reports success for a manual check and exposes the resulting status', async () => {
    checkImpl = async () => {
      eventHandlers.get('update-not-available')!();
      return undefined;
    };
    const res = await ipcHandlers.get('updater:check')!();
    expect(res.success).toBe(true);
    expect(res.status.state).toBe('not-available');
  });
});
