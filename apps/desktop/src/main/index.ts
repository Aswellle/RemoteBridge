// 必须最先加载 — 为 Electron 拦截 better-sqlite3 的 native 模块路径
import './electron-binding';

import { app, BrowserWindow, ipcMain, Notification, Menu } from 'electron';
import * as nodeOs from 'os';
import { createWindow, getMainWindow, setAppQuitting } from './window';
import { initTray, updateTrayStatus } from './tray';
import { getRelayClient } from './ws-client/client';
import { startFileServer, stopFileServer } from './file-server/server';
import { cleanExpiredTokens } from './file-server/token-manager';
import { config } from './config/store';
import db, { initDatabase } from './db/client';
import axios from 'axios';
import log from './logger';

// IPC 模块
import { setupAutoUpdater } from './updater';
import { setupTokenRotator, stopTokenRotator } from './token-rotator';
import { registerAuthHandlers, ensureHostRegisteredAndConnected } from './ipc/auth';
import { registerDirsHandlers } from './ipc/dirs';
import { registerClientsHandlers } from './ipc/clients';
import { registerMessagesHandlers } from './ipc/messages';
import { registerSettingsHandlers } from './ipc/settings';
import { registerLocalRelayHandlers, stopLocalRelay, startLocalRelay } from './local-relay';

// ===== Relay 配置（从 config store 加载） =====
function getRelayUrl(): string {
  return config.getRelayUrl() || process.env.RELAY_URL || 'ws://127.0.0.1:3002/ws';
}

function getRelayApi(): string {
  return config.getRelayApiUrl() || process.env.RELAY_API || 'http://127.0.0.1:3002/api/v1';
}

// ===== 应用生命周期 =====
app.whenReady().then(async () => {
  // 移除 Electron 默认菜单栏（File/Edit/View/Window/Help），由应用内设置页替代
  Menu.setApplicationMenu(null);

  // 初始化本地数据库表结构（显式调用，而非随 db/client 模块加载自动执行）
  initDatabase();

  createWindow();

  // 初始化系统托盘
  initTray();

  // 启动本地文件服务器
  const filePort = await startFileServer();
  log.info(`文件服务器端口: ${filePort}`);

  // 定期清理过期下载令牌，防止 download_tokens 表无限增长
  const tokenCleaner = setInterval(() => {
    try {
      const removed = cleanExpiredTokens();
      if (removed > 0) log.info(`已清理过期下载令牌: ${removed} 条`);
    } catch (err) {
      log.error('清理过期下载令牌失败:', err);
    }
  }, 60 * 60 * 1000);
  tokenCleaner.unref?.();

  // 初始化自动更新（注册 updater IPC + 延迟静默检查）
  setupAutoUpdater(getMainWindow);

  // 初始化 Host JWT 定期轮换（注册 IPC + 启动后 30s 首次检查 + 每日检查）
  setupTokenRotator(getRelayApi);

  // 注册所有 IPC 处理器
  registerIpcHandlers();

  // 首次启动：自动运行本地中继服务器（即使 autoStart 未配置）
  if (!config.getFirstLaunchDone()) {
    startLocalRelay(config.getLocalRelayPort());
  }

  // 启动时自动注册/连接 Relay（复用持久化身份；失败不阻塞启动，UI 可手动重试）
  ensureHostRegisteredAndConnected(getMainWindow, getRelayApi, getRelayUrl)
    .then((result) => {
      if (result.success) {
        log.info(`已自动连接 Relay (hostId: ${result.data?.hostId})`);
      } else {
        log.warn(`自动连接 Relay 失败: ${result.error}`);
      }
    })
    .catch((err) => log.error('自动连接 Relay 异常:', err));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  setAppQuitting(true);
});

app.on('window-all-closed', async () => {
  stopTokenRotator();
  stopLocalRelay();
  await stopFileServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ===== IPC 处理器注册 =====
function registerIpcHandlers(): void {
  // --- 系统信息 ---
  ipcMain.handle('system:info', () => ({
    hostname: nodeOs.hostname(),
    platform: nodeOs.platform(),
    arch: nodeOs.arch(),
    release: nodeOs.release(),
    // os.version() 给出友好的系统名（如 "Windows 11 Home"），release 是内核版本号
    osVersion: nodeOs.version(),
    uptime: nodeOs.uptime(),
    userInfo: nodeOs.userInfo().username,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
  }));

  // --- Host Token ---
  ipcMain.handle('host:get-token', () => {
    return config.getHostToken();
  });

  // --- Relay URL ---
  ipcMain.handle('host:get-relay-url', () => {
    return getRelayUrl();
  });

  // --- 发送通知 ---
  ipcMain.handle('notification:send', (_, title: string, body: string) => {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  });

  // --- 获取本地访问日志 ---
  ipcMain.handle('logs:access', (_, limit?: number) => {
    try {
      return db.getAccessLogs(limit || 100);
    } catch (error: any) {
      log.error('获取访问日志失败:', error);
      return [];
    }
  });

  // --- 获取安全日志（从 Relay 服务器拉取，支持分页与筛选） ---
  // 渲染端必须经此 IPC 访问 Relay：file:// 页面里相对路径 fetch 会解析成
  // file:///api/... 直接 Failed to fetch，绝对地址又会被 CORS 拦截。
  ipcMain.handle(
    'logs:security',
    async (_, query?: { page?: number; pageSize?: number; eventType?: string; clientId?: string }) => {
      try {
        const params: Record<string, string | number> = {
          page: query?.page || 1,
          pageSize: query?.pageSize || 20,
        };
        if (query?.eventType) params.eventType = query.eventType;
        if (query?.clientId) params.clientId = query.clientId;

        const response = await axios.get(`${getRelayApi()}/security-logs`, {
          params,
          headers: { Authorization: `Bearer ${config.getHostToken()}` },
          timeout: 8000,
        });
        return { success: true, data: response.data.data };
      } catch (error: any) {
        const code: string = error?.code ?? '';
        const httpStatus: number = error?.response?.status ?? 0;
        let msg: string;
        if (code === 'ECONNREFUSED') {
          msg = `无法连接到中继服务器（${getRelayApi()}），请确认服务器是否正在运行`;
        } else if (code === 'ENOTFOUND') {
          msg = `无法解析中继服务器地址（${getRelayApi()}），请检查域名或 IP 配置`;
        } else if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
          msg = '连接中继服务器超时，请稍后重试';
        } else if (httpStatus === 401) {
          msg = '身份验证失败，请在设置中重新注册主机';
        } else {
          msg = error?.response?.data?.error?.message ?? error.message;
        }
        log.error('获取安全日志失败:', msg);
        return { success: false, error: msg };
      }
    },
  );

  // --- 获取延迟 ---
  ipcMain.handle('relay:get-latency', () => {
    const client = getRelayClient();
    return client ? client.getAverageRtt() : 0;
  });

  // --- 注册来自各模块的 IPC 处理器 ---
  registerAuthHandlers(getMainWindow, getRelayApi, getRelayUrl);
  registerDirsHandlers(getMainWindow);
  registerClientsHandlers(getRelayApi);
  registerMessagesHandlers();
  registerSettingsHandlers(getMainWindow, getRelayApi, getRelayUrl);
  registerLocalRelayHandlers(getMainWindow);

  // --- 首次启动检测 ---
  ipcMain.handle('system:is-first-launch', () => !config.getFirstLaunchDone());
  ipcMain.handle('system:mark-first-launch-done', () => {
    config.setFirstLaunchDone(true);
  });
}
