/**
 * 文件处理设置相关 IPC 回归测试
 *
 * 用户可见问题：
 *  1. 设置 → 文件处理 的路径框始终只显示"（使用默认路径）"占位符，看不到
 *     实际落盘路径（根因是 preload 调用的通道名 settings:get-upload-paths
 *     与主进程注册的 upload:get-paths 不一致，调用必然失败）。
 *  2. 缺少一键打开保存目录的入口。
 *
 * 这里固定两点契约：upload:get-paths 必须返回"实际生效路径 + 平台默认路径"，
 * shell:open-path 必须能打开目录并在目录不存在时先创建。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

var ipcHandlers = new Map<string, (...args: any[]) => any>();
var storedPaths: any = null;
var dirExists = true;
var openPathResult = '';
var openPathCalls: string[] = [];
var mkdirCalls: string[] = [];
var createFromPathCalls: string[] = [];

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => 'D:/tmp/userdata',
    getAppPath: () => 'D:/AI/remotebridge/apps/desktop',
    getVersion: () => '2.1.0',
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => ipcHandlers.set(channel, fn),
  },
  shell: {
    openPath: async (target: string) => {
      openPathCalls.push(target);
      return openPathResult;
    },
    openExternal: vi.fn(),
  },
  nativeImage: {
    createFromPath: (p: string) => {
      createFromPathCalls.push(p);
      return {
        isEmpty: () => false,
        resize: () => ({ toPNG: () => Buffer.from('fake-png') }),
      };
    },
  },
}));

vi.mock('fs', () => {
  const mock = {
    promises: {
      mkdir: async (target: string) => {
        mkdirCalls.push(target);
      },
    },
    existsSync: () => dirExists,
  };
  return { ...mock, default: mock };
});

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/config/store', () => ({
  config: {
    getUploadPaths: () => storedPaths,
    setUploadPaths: (v: any) => { storedPaths = v; },
    getFirstLaunchDone: () => true,
    setFirstLaunchDone: vi.fn(),
  },
  getDefaultUploadPaths: async () => ({
    images: 'D:/RemoteBridge-Files/images',
    videos: 'D:/RemoteBridge-Files/videos',
    documents: 'D:/RemoteBridge-Files/documents',
    archives: 'D:/RemoteBridge-Files/archives',
    markdown: 'D:/RemoteBridge-Files/markdown',
  }),
  default: { getUploadPaths: () => storedPaths },
}));

vi.mock('../src/main/db/client', () => ({
  default: { getAccessLogs: vi.fn(() => []), insertMessage: vi.fn() },
}));

vi.mock('../src/main/ws-client/client', () => ({
  getRelayClient: () => null,
}));

import { registerMessagesHandlers } from '../src/main/ipc/messages';
import { registerSystemHandlers } from '../src/main/ipc/system';

describe('upload path display + open folder IPC', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    storedPaths = null;
    dirExists = true;
    openPathResult = '';
    openPathCalls = [];
    mkdirCalls = [];
    createFromPathCalls = [];
    registerMessagesHandlers();
    registerSystemHandlers();
  });

  it('returns the effective platform-default paths and the defaults for comparison', async () => {
    const res = await ipcHandlers.get('upload:get-paths')!();

    expect(res.success).toBe(true);
    // 未自定义时仍要给出真实完整路径，供设置页回显
    expect(res.data.paths.images).toBe('D:/RemoteBridge-Files/images');
    expect(res.data.defaults.images).toBe('D:/RemoteBridge-Files/images');
  });

  it('returns stored custom paths as effective, keeping defaults separate', async () => {
    storedPaths = {
      images: 'E:/My Pictures',
      videos: 'E:/My Videos',
      documents: 'E:/Docs',
      archives: 'E:/Zips',
      markdown: 'E:/Notes',
    };

    const res = await ipcHandlers.get('upload:get-paths')!();

    expect(res.data.paths.images).toBe('E:/My Pictures');
    expect(res.data.defaults.images).toBe('D:/RemoteBridge-Files/images');
  });

  it('opens a category folder in the system file manager', async () => {
    const res = await ipcHandlers.get('shell:open-path')!(null, 'D:/RemoteBridge-Files/images');

    expect(res.success).toBe(true);
    expect(openPathCalls).toEqual(['D:/RemoteBridge-Files/images']);
  });

  it('creates the directory before opening so a never-used category still opens', async () => {
    await ipcHandlers.get('shell:open-path')!(null, 'D:/RemoteBridge-Files/videos');

    expect(mkdirCalls).toEqual(['D:/RemoteBridge-Files/videos']);
  });

  it('surfaces a friendly error when the folder cannot be opened', async () => {
    openPathResult = 'No application is associated with the specified file';

    const res = await ipcHandlers.get('shell:open-path')!(null, 'D:/RemoteBridge-Files/images');

    expect(res.success).toBe(false);
    expect(res.error).toContain('无法打开该目录');
  });

  it('rejects an empty target without touching the filesystem', async () => {
    const res = await ipcHandlers.get('shell:open-path')!(null, '   ');

    expect(res.success).toBe(false);
    expect(openPathCalls).toEqual([]);
  });

  // ── system:icon：进入"关于"页时图标闪烁（先旧标识后品牌图标）的根因是
  //    原图 1254×1254（base64 逾 1MB）每次挂载都要重新经 IPC 传输且无缓存。
  it('returns a small cached app icon data URL', async () => {
    const first = await ipcHandlers.get('system:icon')!();
    const second = await ipcHandlers.get('system:icon')!();

    expect(first).toBe('data:image/png;base64,' + Buffer.from('fake-png').toString('base64'));
    // 第二次直接命中缓存（读取+缩放只发生一次）
    expect(second).toBe(first);
    expect(createFromPathCalls).toHaveLength(1);
  });
});
